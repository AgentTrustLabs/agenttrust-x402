# Authorization Owner — deployment and operations

The Authorization Owner is the separate service that decides whether the
sponsor may sign a payment. The facilitator never decides on its own in real
mode: it asks the owner over the `agenttrust-authz v1` IPC protocol, and the
owner applies its own policy plus a durable state gate read from the shared
database. The owner does **not** re-derive the decision from an independent
copy of the payment — it has no copy. What it verifies and what it takes on
trust is spelled out in [Trust boundary](#trust-boundary) below; the short
version: the owner verifies the payment's existence and state and the
policy limits, and it trusts the facilitator's asserted payment context
(sender, recipient, amount, expiry, energy) because the v1 protocol carries
only the payment digest, not the transaction itself.

## Architecture

```
client payment ──► facilitator (uid 1001)
                      │ 1. validate → claim (shared DB, state `created`)
                      │ 2. sender verification (SDK, before authorization)
                      │ 3. authorize ──► Authorization Owner (uid 997, distinct from the facilitator)
                      │      │  SO_PEERCRED peer check (facilitator UID, never root)
                      │      │  strict v1 validation (no caller-supplied decision fields)
                      │      │  durable idempotency (requestId → outcome)
                      │      │  durable gate + full policy (shared DB)
                      │      │  audit event written in the same transaction
                      │ 4. recover (only after `authorization_already_recorded`)
                      │ 5. wire conversion (after authorization, before signing)
                      │ 6. signing service (IPC) → submit → finalize
```

Settle order is enforced in `FacilitatorCore.settle()`: validate → claim →
sender verify → authorize → recover → convert → signer. Any authorization
outcome other than `approved` never reaches the signer. A `rejected` outcome
marks the payment terminally `rejected`; an `unknown` or `owner_unavailable`
outcome returns `settlement_pending` (non-terminal) so an operator can
reconcile — never auto-retried.

### Resumable path (crash recovery)

When `claim()` returns `resumable` — the payment is already in state
`prepared` with a durable transaction hash from a previous, crashed attempt
— `settle()` skips sender verification, authorization, and wire conversion,
and re-signs the original payload. This is sound, not a bypass:

- `prepared` is only reachable through `prepare()`, which is only called
  after `addSponsorSignature()` in the same `settle()` flow, and only after
  the owner approved that exact payment (the claim binds digest +
  requirementsKey, so the resumed attempt is the identical payment);
- signing is deterministic (Ed25519), so re-signing the same payload yields
  the same signature and the same hash;
- `claimSubmit()` still enforces the exact persisted hash, so a resumed
  attempt cannot submit a different transaction;
- the resumed attempt creates no second sign event: the approval it relies
  on is the original durable one.

A resumed attempt therefore never re-authorizes and never re-verifies the
sender, because both were already proven for this exact payment before the
crash — and it cannot proceed for any other payment.

## Trust boundary

What the owner **verifies** (from the shared database and its own policy):

- the payment exists, is in state `created`, has `tx_hash` NULL, and has no
  prior `approved` event (the durable gate, enforced atomically);
- the asserted network, version, asset, sponsor identity, expiry window,
  and energy cap against its own policy.

What the owner **takes on trust** (asserted by the facilitator in the
request, not independently verifiable by the owner):

- that the sender, recipient, amount, expiry, and energy in the request
  match the actual signed transaction. The owner receives only the payment
  digest — a hash. It has no preimage and no copy of the transaction, so it
  cannot open the digest and check the fields against it.

What makes this sound in practice:

- the sender's signature is verified by the facilitator's SDK sender
  verifier **before** authorization, so the sender signed the actual
  transaction the facilitator is presenting;
- the sponsor's exposure is the fee only (energy × rate), bounded by the
  owner's energy cap and by the signing service's `validateContext`;
- the amount recorded in the sign event is bound to the signed transaction
  by the facilitator (`checkAgreement` compares the signed transfer amount
  with the accepted amount for transfer-family payloads; see [Amount
  binding](#amount-binding));
- the digest + requirementsKey bind the exact payment the facilitator
  claimed, so the owner cannot be asked to authorize a different payment
  under the same digest.

Stated plainly: the owner protects against an honest-but-buggy facilitator
(it enforces the policy and the durable gate, and it cannot be told to
approve by a caller — no decision field is accepted) and against a
compromised owner process. It does **not** protect against a fully
compromised facilitator: a facilitator that can lie about the context could
equally skip the authorize call entirely, since it holds the database and
the signing-service access by design. The owner is a separation of
*duty*, not a sandbox around the facilitator.

### Amount binding

`checkAgreement` (facilitator) binds the amount recorded in the sign event
to the signed transaction for transfer-family payloads (`transfer`,
`transferWithMemo`, kind `3`): the signed transfer amount must equal the
accepted amount numerically (BigInt comparison, so leading zeros do not
matter). A mismatch is refused before any claim, authorization, or signer
call. The accepted/requirements values alone are client-supplied and prove
nothing; the signed transaction is the source of truth.

Limit: non-transfer transaction kinds carry no transfer amount, so the
check is skipped for them and the recorded amount is the asserted amount.
The sponsor's fee exposure is unaffected (it depends on energy, not on the
transfer amount).

## The protocol (agenttrust-authz v1)

Unix domain socket, UTF-8 JSONL framing, 64 KiB max message, one JSON object
per line. Three operations: `authorize`, `recover`, and `db_identity`
(read-only readiness probe, see below).

Request:

```json
{
  "protocolVersion": 1,
  "requestId": "uuid (client-generated, 1–128 chars)",
  "operation": "authorize",
  "paymentDigest": "64 lowercase hex chars",
  "context": {
    "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    "version": 1,
    "sender": "<base58check>",
    "sponsor": "<base58check>",
    "recipient": "<base58check>",
    "asset": "CCD",
    "amount": "250000",
    "expiry": 1792000000,
    "energy": "300"
  }
}
```

The owner rejects, in order: unauthorized peer (`protocol_error` /
`unauthorized_peer`), malformed/oversized frames, forbidden fields
(`decision`, `approved`, `outcome`, `reason`, `result`, `authorization` —
the caller may never assert a decision), unsupported protocol, unknown
operation, invalid fields, then the policy and durable-gate reasons
(`wrong_network`, `wrong_sponsor`, `sponsor_is_sender`,
`sponsor_is_recipient`, `expired`, `expiry_excessive`,
`energy_exceeds_cap`, `unsupported_asset`, `unknown_payment`,
`payment_not_authorizable`, `authorization_already_recorded`, …).

Response outcomes: `approved`, `rejected`, `unknown`, `owner_unavailable`,
`protocol_error`. Each carries `reason` and `detail`.

Idempotency: the owner stores `requestId → canonical request + outcome` in
its own `idem.db` (WAL, synchronous FULL). Replaying the same `requestId`
with the same canonical request returns the stored outcome without a second
decision; replaying it with a different canonical request is rejected with
`request_id_conflict`.

Recovery: `recover` is read-only — it never creates, modifies, or deletes a
record. It reports `approved` only when exactly one durable approval exists
and its full context (network, sender, sponsor, recipient, energy, asset,
amount, expiry, policy version) matches the request; otherwise `rejected`
(a durable rejection exists), `unknown` (`no_durable_decision`,
`context_mismatch`, `conflicting_evidence`, `legacy_context_missing` for
rows recorded before full context binding).

`db_identity` is the read-only readiness probe the facilitator uses at
startup and in `/healthz`. It carries no payment digest and no context —
only `protocolVersion`, `requestId`, and `operation` — and creates no state
(no idempotency record, no sign event). The owner answers with the identity
of the database file it actually opened:

```json
{
  "protocolVersion": 1,
  "requestId": "uuid",
  "outcome": "ok",
  "dbPath": "/home/agenttrust/.agenttrust/facilitator.db",
  "dbDev": 85,
  "dbIno": 1609
}
```

The facilitator compares `dbDev`/`dbIno` (after resolving symlinks) with its
own database file. A mismatch means the owner is authorizing against a
different file, and real-mode startup fails closed. An unreachable owner
does not fail startup — it makes `/healthz` report unhealthy until the
owner appears.

## Durable state and the shared database

The owner and the facilitator **share one SQLite database file**. This is not
optional: the v1 protocol has no "register payment" operation, so an owner
with a separate database would see every real payment as `unknown_payment`.

- The facilitator claims payments into the file (`payments` table, state
  `created`, `tx_hash` NULL).
- The owner reads the same rows and writes authorization audit events into
  `sign_events` in the same file.
- The durable gate (`authorizeSignEvent`, atomic): the payment must exist,
  be in state `created`, have `tx_hash` NULL, and have no prior `approved`
  event. A partial unique index (`ux_sign_events_approved`) guarantees at
  most one approval per payment at the storage layer, even under races.
- The owner's idempotency store (`idem.db`) stays owner-private in its own
  directory.
- Both processes open the file in WAL mode (`journal_mode=WAL`,
  `synchronous=FULL`); SQLite serializes writers.
- **Shared-database identity is enforced, not assumed.** At startup (and on
  every `/healthz` call) the facilitator asks the owner for the file identity
  (`db_identity`) and compares device + inode with its own database file
  after resolving symlinks. A mismatch fails real-mode startup; an
  unreachable owner makes readiness unhealthy. Only the file identity is
  compared and logged (device, inode, resolved path) — no payment data ever
  leaves either process for this check.
- **File permissions.** The repository tightens the database files
  (`db`, `-wal`, `-shm`) to `0600` on every open (the `-shm` file is
  recreated on each open, so a one-time chmod is not enough). The owner's
  private `idem.db` is `0600` as well. A deployment that shares the database
  across two UIDs must use `0644` (pass
  `fileMode: 0o644` to the repository, or `FACILITATOR_DB_FILE_MODE=0644`
  on the facilitator); the default `0600` is for the
  single-UID deployment. `0660` with a shared group does NOT work: the
  Owner launcher refuses a settlement file writable by its UID, and
  group-write plus Owner-in-group trips that guard.

Payment lifecycle as the owner sees it: `created` → `approved` (sign event
recorded) or `rejected` (sign event recorded, payment terminally rejected by
the facilitator) → terminal states (`finalized`, `rejected`,
`recovery_unavailable`) are reached only through settlement/reconciliation,
never by authorization alone. `outcome_unknown` / `submitting` mean a
broadcast may be in flight; only verified evidence may terminalize them.

## Policy boundary

The owner enforces the full policy (`decideAuthorization`, pure — no I/O —
plus the durable gate):

- network must equal the configured CAIP-2 network (Testnet only);
- version must be 1 (sponsored V1);
- asset must be in the allowed list (`CCD`);
- sender, sponsor, recipient must be valid base58check accounts;
- sponsor must equal the configured sponsor, and must be neither the sender
  nor the recipient (canonical comparison, not string comparison);
- expiry must be in the future and within `maxExpiryOffsetSeconds`;
- energy must be a non-negative integer within int64 range and at most
  `maxEnergy`.

Every limit is mandatory — a missing or non-positive limit fails closed at
owner startup. The owner validates its sponsor address at startup and
refuses to listen when the policy is unusable.

## Configuration

### Owner (`scripts/authz-owner.mts`)

```
npx tsx scripts/authz-owner.mts <db-dir> <socket-path> <facilitator-uid>
```

| Variable | Meaning | Production value |
| --- | --- | --- |
| `AUTHZ_SPONSOR_ADDRESS` | sponsor account the owner authorizes for | `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK` |
| `AUTHZ_NETWORK` | CAIP-2 network | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |
| `AUTHZ_MAX_ENERGY` | max execution energy (NRG) | `1000` (matches `FACILITATOR_MAX_ENERGY`) |
| `AUTHZ_MAX_EXPIRY_OFFSET_SECONDS` | max expiry offset from now | `600` |
| `AUTHZ_ALLOWED_ASSETS` | comma-separated assets | `CCD` |
| `AUTHZ_POLICY_VERSION` | version recorded in sign events | `authz-prod-v1` |
| `AUTHZ_DB_FILE` | authorization database file — **must be the facilitator's database file** | `/home/agenttrust/.agenttrust/facilitator.db` |
| `AUTHZ_SEED_FIXTURES` | `1` seeds harness digests `a`..`e`; default is `0` (no seeding) — a production database must never receive fake payments; tests opt in explicitly | `0` |
| `AUTHZ_OWNER_LOG` | owner log path | e.g. `/home/agenttrust/.agenttrust/authz.log` |
| `CRASH_AT` | `1`..`5` — crash-injection point (verification only, never in production) | unset |

Defaults (no variables set) preserve the original protocol-test harness
except for fixtures: placeholder sponsor, `maxEnergy` 10000, policy version
`v348`, database `<db-dir>/auth.db`, fixtures **not** seeded (tests and the
harness opt in with `AUTHZ_SEED_FIXTURES=1`). The socket is created mode
`0660`; the database directory is created mode `0700`. The owner refuses a
symlink socket path and a non-socket file at the socket path. An unusable
`AUTHZ_MAX_ENERGY` (e.g. `abc`, ``, `10.5`) refuses to start with a clean
exit-3 message instead of an uncaught error.

### Facilitator (real mode)

`FACILITATOR_AUTHZ_SOCKET` is **required** in real mode. `loadConfig`
throws `ConfigurationError` when it is missing or not an absolute path, so
the facilitator cannot start and cannot silently fall back to the local
client. In mock mode the socket is optional; the local client is only ever
reachable in mock/test mode.

At startup (real mode only, after the core opens the database) the
facilitator probes the owner (`db_identity`, read-only): a reachable owner
on a **different** database file fails startup with a `ConfigurationError`;
an unreachable owner does not fail startup but makes readiness unhealthy.
`/healthz` live-probes the owner on every call and reports
`ownerReachable` (plus `ownerReason` when false); in real mode it returns
503 with `ok: false` while the owner is unreachable or on the wrong
database. In mock mode `ownerReachable` is `true` (the in-process local
client is always reachable).

```sh
FACILITATOR_MODE=real
FACILITATOR_AUTHZ_SOCKET=/home/agenttrust/.agenttrust/authz.sock
FACILITATOR_DB_PATH=/home/agenttrust/.agenttrust/facilitator.db  # same file as AUTHZ_DB_FILE
```

## UID boundaries

- The owner verifies every peer with `SO_PEERCRED` (via the
  `scripts/authz-peercred` helper): the peer UID must equal the configured
  facilitator UID, and UID 0 (root) is rejected even when it matches.
- The socket is mode `0660`, owned by the service user; the database
  directory is `0700`.
- The Owner and the facilitator MUST run as distinct UIDs. This is
  enforced on both sides, by default, with no opt-out in production:
  the Owner launcher refuses to start when the facilitator UID equals
  its own UID (or the signing-service UID equals the facilitator UID),
  and the facilitator's real-mode startup probe (and `/healthz`) refuses
  an Owner whose `db_identity` reports the facilitator's or the
  signing-service's UID. A compromised facilitator that shares the
  Owner's UID could read the Owner key and database no matter what the
  file modes say, so same-UID deployment is a startup failure, not a
  warning. Deploy three distinct UIDs: the Owner as a dedicated user
  (e.g. `authowner`, uid 997, as the protocol tests use), the facilitator
  as its own user, and the signing service as a third user (the isolation
  suite uses `authsigner` for this role). The only exception is the
  explicit test-harness opt-out `AUTHZ_ALLOW_SAME_UID_HARNESS=1`, for
  suites that deliberately share one UID between the Owner and the
  facilitator; it is never set in production.

## Operations

Start (owner first, then signing service, then facilitator — the facilitator
probes the signing service and the owner at startup, and `/healthz`
reports `ownerReachable` live):

```sh
# as agenttrust (uid 1001)
cd /opt/agenttrust/agenttrust-gateway
AUTHZ_SPONSOR_ADDRESS=3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK \
AUTHZ_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27 \
AUTHZ_MAX_ENERGY=1000 AUTHZ_MAX_EXPIRY_OFFSET_SECONDS=600 \
AUTHZ_ALLOWED_ASSETS=CCD AUTHZ_POLICY_VERSION=authz-prod-v1 \
AUTHZ_DB_FILE=/home/agenttrust/.agenttrust/facilitator.db \
AUTHZ_SEED_FIXTURES=0 AUTHZ_OWNER_LOG=/home/agenttrust/.agenttrust/authz.log \
npx tsx scripts/authz-owner.mts /home/agenttrust/.agenttrust/authz-dir \
  /home/agenttrust/.agenttrust/authz.sock 1001
```

Stop: SIGTERM (the owner closes the server and both databases, then exits
0). SIGKILL leaves a stale socket file; the next start removes it (it
refuses only a symlink or a non-socket file at that path).

Restart: state is durable — `sign_events` and `idem.db` survive. After a
crash between the authorization commit and the idempotency record, a
re-authorize returns `authorization_already_recorded` and `recover` with the
matching context proves the approval; the facilitator resumes from there
instead of signing twice.

Failure modes (all fail closed, none settle):

- owner dead / socket missing → client resolves `owner_unavailable`; the
  facilitator returns `settlement_pending` (non-terminal) and never calls
  the signer; `/healthz` reports `ownerReachable: false` (503);
- owner on a different database → real-mode startup fails closed
  (`ConfigurationError: authorization owner database mismatch`); the
  mismatch is also visible in `/healthz` while it persists;
- unauthorized peer → `protocol_error` / `unauthorized_peer`;
- malformed frame or caller-supplied decision field → `protocol_error` /
  `rejected` with a specific reason;
- duplicate approval → `authorization_already_recorded`, exactly one
  approval ever recorded per payment.

## Verification

`scripts/verify-authz-owner.mts` (run as uid 1001 from the repo root)
exercises the whole matrix against the env-configured owner with the real
sponsor policy and a shared database, using dummy payment digests and a
recording mock signer whose submit path refuses to broadcast:

- valid → approved; wrong sponsor / expired / energy over cap / wrong
  network / unsupported asset → rejected with the specific reason;
- duplicate authorize → `authorization_already_recorded`, exactly one
  approval recorded;
- same `requestId` replay → stored outcome, no second approval; same
  `requestId` with different canonical content → `request_id_conflict`;
- recover with matching context → approved; mismatched context →
  `unknown` / `context_mismatch`;
- owner dead / socket missing → `owner_unavailable`;
- unauthorized peer (root client) → `protocol_error` / `unauthorized_peer`;
- crash after commit (`CRASH_AT=3`) + restart → re-authorize reports
  `authorization_already_recorded`, recover proves the approval;
- core level: owner rejection → `authorization_rejected`, signer never
  called; owner approval → signer called exactly once, outcome
  `settlement_pending` (mock submitter refuses to broadcast), sponsored
  hash recorded; owner dead at settle time → `settlement_pending` with
  `authorizationOutcome: owner_unavailable`, signer never called.
- review fixes (checks 28–37): amount mismatch → `requirements_mismatch`,
  signer never called; `db_identity` reports the shared database (dev+ino
  match) and a different identity for an owner on another database;
  concurrent duplicate `requestId`s all resolve with exactly one approval
  and the owner stays alive; default owner (no seed env) does not know the
  harness digest while an opt-in owner (`AUTHZ_SEED_FIXTURES=1`) does;
  shared database files are `0600`.

No real transaction is signed or submitted by any of these checks.

Regression tests in the suite: `test/amount-binding.test.mts` (F5, core
level), `test/authz-owner-config.test.mts` (F1 default/opt-in, F7, F8 —
spawns the real owner, no IPC), `test/facilitator-sponsor-signer-wiring.test.mts`
section F (F2 startup identity check, F6 `/healthz` owner reachability,
F9 close-without-response, F7 file modes — stub owner, no privileges),
`test/narrow-sponsor-auth.test.mts` test 17b (F10, energy 0 rejected).

## Known limits

- The owner cannot verify the facilitator's asserted payment context
  (sender, recipient, amount, expiry, energy) against the actual signed
  transaction — it only receives the digest. See [Trust boundary](#trust-boundary).
- Amount binding covers transfer-family payloads only. A non-transfer
  payment records the asserted amount.
- Concurrent duplicate `requestId`s: conflict detection is best-effort
  under true concurrency (both calls can miss the idempotency read). The
  durable gate — not the idempotency store — is what prevents a second
  approval, and a duplicate insert is dropped instead of crashing the
  owner.
- The owner and the facilitator share one database file by design; do not
  point `AUTHZ_DB_FILE` at a separate copy — the owner would reject every
  payment as `unknown_payment`. The startup identity check catches this
  misconfiguration before any settlement.
- `LocalAuthorizationClient` still exists for mock/test flows. It is
  unreachable in real mode (config-enforced); do not re-enable a fallback
  without a separate review.
