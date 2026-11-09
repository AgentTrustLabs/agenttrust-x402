# TASK 34.7 — Production IPC Contract & Operational Threat Model

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Design and specification only.** No production implementation. No connection to
`FacilitatorCore.settle()`. No signer. No key material.

---

## 1. Architecture and trust-boundary diagram

```
┌─────────────────┐  HTTP  ┌──────────────────┐  IPC (Unix socket)  ┌─────────────────────────────┐
│     Gateway     │───────►│   Facilitator    │────────────────────►│  Authorization Owner        │
│  DENY_ALL by    │        │  IPC client only │  narrow request     │  exclusive DB writer        │
│  default        │        │  no DB access    │  (no decision field)│  owns auth.db (0700)        │
└─────────────────┘        └──────────────────┘◄────────────────────└─────────────────────────────┘
        │                          │  {approved,reason}                       │
        │                          │                                          │
        │  gateway UID             │  facilitator UID (authclients)           │  authowner UID
        │  no DB, no socket       │  socket connect only                     │  DB read/write, bind
        ▼                          ▼                                          ▼
   /var/lib/agenttrust/       /var/run/agenttrust/authz.sock            /var/lib/agenttrust/
   (no access)                0660 owner:authclients                   auth.db 0600 owner:authowner
```

**Trust boundaries:**

1. **Gateway ↔ Facilitator:** HTTP over loopback or TLS. Gateway never sees the DB or the socket.
2. **Facilitator ↔ Authorization Owner:** Unix socket, peer-credential authenticated, narrow IPC.
3. **Authorization Owner ↔ SQLite:** direct, same process, exclusive writer.

The facilitator is the **only** IPC client. The gateway is **not** an IPC client. The owner is the
**sole** writer of `sign_events`, `sign_attempts`, and `transitions`.

---

## 2. Versioned IPC request/response examples

### 2.1 Request (v1)

```json
{
  "protocolVersion": 1,
  "requestId": "b5f0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "operation": "authorize",
  "paymentDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "context": {
    "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    "version": 1,
    "sender": "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d",
    "sponsor": "3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8",
    "recipient": "4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5",
    "asset": "CCD",
    "amount": "250000",
    "expiry": 1900000200,
    "energy": "3000"
  }
}
```

### 2.2 Response (v1)

```json
{
  "protocolVersion": 1,
  "requestId": "b5f0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "outcome": "approved",
  "reason": null,
  "detail": null,
  "decidedAt": 1757000000000,
  "policyVersion": "v1"
}
```

Rejected example:

```json
{
  "protocolVersion": 1,
  "requestId": "b5f0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "outcome": "rejected",
  "reason": "authorization_already_recorded",
  "detail": "durable-state gate: authorization_already_recorded",
  "decidedAt": 1757000000000,
  "policyVersion": "v1"
}
```

---

## 3. Protocol validation rules

### 3.1 Framing

- UTF-8 JSON, one object per line, `\n` terminated.
- Max message size: 65,536 bytes (64 KiB).
- No BOM, no trailing whitespace required.

### 3.2 Required fields

`protocolVersion`, `requestId`, `operation`, `paymentDigest`, `context` (with all sub-fields).

### 3.3 Forbidden fields

A `decision` field anywhere in the request → `forbidden_field`, connection closed. The caller
cannot request an approval.

### 3.4 Strict field validation

| Field | Rule |
|---|---|
| `protocolVersion` | must equal `1` |
| `requestId` | 1–128 chars, no control characters |
| `operation` | exactly `"authorize"` |
| `paymentDigest` | 64 lowercase hex chars |
| `context.network` | must equal the owner's configured CAIP-2 |
| `context.version` | must equal `1` |
| `context.sender` | base58check, 45–55 chars (`ACCOUNT_RE`) |
| `context.sponsor` | base58check, must equal the owner's configured sponsor |
| `context.recipient` | base58check, ≠ sponsor |
| `context.asset` | in the owner's `allowedAssets` |
| `context.amount` | decimal string, no leading `+`, no whitespace, ≥ 0 |
| `context.expiry` | integer epoch seconds, `now < expiry ≤ now + maxExpiryOffset` |
| `context.energy` | decimal string, strict `/^[0-9]+$/`, parses to bigint ≤ `maxEnergy` |

### 3.5 Unknown fields

Unknown fields in the request or in `context` are **rejected** with `malformed_request`. This
prevents a future caller from smuggling a `decision` field or other authorization-affecting data.

### 3.6 Reason codes (stable, additive only)

`forbidden_field`, `unknown_operation`, `unsupported_protocol`, `malformed_request`,
`missing_field`, `invalid_field`, `unknown_payment`, `payment_not_authorizable`,
`transaction_hash_already_prepared`, `authorization_already_recorded`,
`payment_digest_mismatch`, `wrong_network`, `wrong_version`, `wrong_sponsor`,
`invalid_sender`, `invalid_sponsor`, `invalid_recipient`, `missing_sender`,
`missing_sponsor`, `missing_recipient`, `unsupported_asset`, `expired`,
`expiry_excessive`, `energy_malformed`, `energy_exceeds_cap`, `energy_negative`,
`energy_overflow`, `missing_energy_limit`, `sponsor_is_sender`, `sponsor_is_recipient`,
`audit_write_failed`, `owner_unavailable`, `internal_error`, `unauthorized_peer`,
`request_id_reused`.

### 3.7 Timeouts

| Timeout | Value | Behavior |
|---|---|---|
| Connection idle | 30 s | close connection |
| Request read | 10 s | close connection |
| Authorization (owner-side) | 5 s | return `owner_unavailable` or `internal_error`; do not retry |
| Response write | 10 s | close connection |

---

## 4. UID/GID and peer-authentication policy

### 4.1 Identities

| Identity | UID | Role | Access |
|---|---|---|---|
| `gateway` | dedicated | runs the gateway | no DB, no socket |
| `facilitator` | dedicated, group `authclients` | IPC client | socket connect only |
| `authowner` | dedicated | DB owner + authorization | DB read/write, socket bind |

All three run as **separate, non-root** users.

### 4.2 Filesystem layout

```
/var/lib/agenttrust/        authowner:authowner  0700
  auth.db                   authowner:authowner  0600
  auth.db-wal               authowner:authowner  0600
  auth.db-shm               authowner:authowner  0600
/var/run/agenttrust/        authowner:authclients 0750
  authz.sock                authowner:authclients 0660
/var/log/agenttrust/        authowner:authclients 0750
  authz.log                 authowner:authclients 0640
```

### 4.3 Peer credential verification (`SO_PEERCRED`)

Filesystem permissions alone are **not** sufficient. The owner must verify the peer's UID:

1. Read the socket's peer credentials (`SO_PEERCRED` on Linux).
2. Allow only UIDs in the explicit allow-list: `{facilitator}`.
3. Reject any other UID with `reason: "unauthorized_peer"` and close the connection.
4. Log the peer UID with every decision.

Group membership alone is **not** sufficient — a process in `authclients` that is not the
`facilitator` UID is rejected.

### 4.4 Unauthorized UID behavior

| Peer UID | Behavior |
|---|---|
| `facilitator` (allowed) | proceed |
| `authowner` (owner itself) | proceed (self-test only; production may reject) |
| Any other UID | `unauthorized_peer`, close, audit-log |
| Root (`0`) | `unauthorized_peer` (recommended: reject root) |

### 4.5 Socket replacement and stale socket protection

| Risk | Mitigation |
|---|---|
| Stale socket from a crashed owner | Owner unlinks the socket path before `listen()`. On exit, unlink again. |
| Attacker replaces the socket with a symlink | Owner creates the socket with `O_NOFOLLOW` semantics; verifies `lstat` is a socket. |
| Attacker creates the socket directory | Directory is `0750 owner:authclients`; only `authowner` can create the socket. |
| Path traversal | Socket path is a fixed absolute path, not derived from caller input. |

### 4.6 Service management

| Component | Unit | Notes |
|---|---|---|
| `agenttrust-authz.service` | systemd, `User=authowner` | owner process; `Restart=on-failure`; `RuntimeDirectory=agenttrust` |
| `agenttrust-facilitator.service` | systemd, `User=facilitator` | IPC client; no DB |
| `agenttrust-gateway.service` | systemd, `User=gateway` | unchanged |

`ProtectSystem=strict`, `ReadWritePaths=/var/lib/agenttrust /var/run/agenttrust`,
`NoNewPrivileges=true`, `PrivateTmp=true` for the owner.

### 4.7 Permission verification at startup

The owner verifies at startup:
- DB directory is `0700` and owned by `authowner`.
- DB file (if exists) is `0600` and owned by `authowner`.
- Socket directory is `0750` and owned by `authowner:authclients`.
- If any check fails, the owner refuses to start.

### 4.8 Shutdown behavior

On `SIGTERM`: drain in-flight requests (up to 30 s), `server.close()`, unlink socket, close
DB, exit. On crash: stale socket left; next start unlinks it.

### 4.9 Restart policy

`Restart=on-failure` with `RestartSec=5`. The facilitator treats a missing socket as
`owner_unavailable` and backs off.

### 4.10 Log ownership and sensitive-data handling

Logs are append-only, mode `0640`, owned by `authowner:authclients`. Every IPC decision is
logged with: timestamp, peer UID, `requestId`, `operation`, `paymentDigest`, `outcome`,
`reason`, `policyVersion`. No secrets, no full transaction payloads, no full context.

### 4.11 Database backup and restore

- Backups owned by `authowner`, mode `0600`, stored outside the DB directory.
- Restores must preserve the `sign_events` append-only history and the partial unique index.
- A restore must be verified against the trigger: a DB with duplicate approved rows fails
  closed at construction (existing TASK34.4 behavior).

### 4.12 Migration ownership

Only the owner process runs migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`,
trigger creation). The facilitator never migrates the DB.

---

## 5. Replay, concurrency, and crash semantics

### 5.1 Owner-side authorization sequence (mandatory order)

```
1. Verify peer UID (SO_PEERCRED) → reject unauthorized
2. Parse + validate request (strict fields, no decision field)
3. Resolve the durable payment row (BEGIN IMMEDIATE)
4. Validate state === 'created' AND tx_hash IS NULL
5. Check no prior 'approved' sign event
6. Evaluate narrow sponsor policy (decideAuthorization)
7. Insert exactly one audit event (sign_events or sign_attempts)
8. COMMIT
9. Return the durable result
```

Steps 3–8 are one SQLite transaction (existing TASK34.2/34.4 semantics). The caller's
`context` is never authoritative: the owner re-derives the policy decision from its own
configuration and the durable row.

### 5.2 Duplicate request IDs

| Case | Behavior |
|---|---|
| Same `requestId`, same payload, within idempotency window | Return the **stored** result (no second transaction) |
| Same `requestId`, different payload | `reason: "request_id_reused"`, reject |
| Same `requestId`, owner restarted, idempotency store lost | Treat as new request; the durable gate (§5.3) prevents a second approval |

The idempotency store is a table keyed by `requestId`, storing the response and a TTL.

### 5.3 Duplicate authorization requests

The durable gate (state `created`, `tx_hash IS NULL`, no prior `approved`) makes a second
approval **impossible** regardless of how many requests arrive. The second request returns
`reason: "authorization_already_recorded"`.

**Never** retry an uncertain authorization by silently creating a second approval.

### 5.4 Concurrent clients

SQLite `BEGIN IMMEDIATE` serializes writers. Two concurrent `authorize` requests for the same
payment: exactly one approval, one `authorization_already_recorded`. Verified in TASK34.6
(probe 9).

### 5.5 Client disconnect during authorization

- The owner completes the transaction if it started (no cancellation).
- The result is durable; a reconnecting client can query by `requestId` (idempotency store)
  or re-request and receive `authorization_already_recorded`.

### 5.6 Crash semantics

| Crash point | Outcome |
|---|---|
| Before `BEGIN` | no state change; client sees `owner_unavailable` |
| During transaction | SQLite rollback; no partial audit event (TASK34.4 guarantee) |
| After `COMMIT`, before response | approval is durable; client may time out; a re-request returns `authorization_already_recorded` |
| After response | client has the result |
| Owner restart | DB durable; idempotency store may be lost; durable gate still prevents double approval |

### 5.7 Outcome classification (caller-visible)

| Outcome | Meaning | Caller action |
|---|---|---|
| `approved` | durable approval recorded | proceed |
| `rejected` | definitive refusal (policy/state/duplicate) | stop, do not retry |
| `unknown` | owner crashed or timed out before commit | **do not retry**; query status or wait |
| `owner_unavailable` | socket missing, connection refused, timeout | back off; do not retry |
| `protocol_error` | malformed request, auth failure | fix client; do not retry |

### 5.8 Stale socket cleanup

On startup: `unlink(socketPath)` then `listen()`. On `SIGTERM`: drain in-flight requests,
`server.close()`, `unlink()`, exit. A crash leaves a stale socket; the next start unlinks it.
The facilitator treats a missing socket as `owner_unavailable`.

### 5.9 Database lock contention

`BEGIN IMMEDIATE` + `busy_timeout = 5000` (existing repository setting, `repository.ts:313`).
Under contention, a request waits up to 5 s; if it exceeds the authorization timeout, the owner
returns `owner_unavailable` and the caller must not retry.

---

## 6. Threat model

### 6.1 Adversary 1: Compromised Gateway process

- **Capability:** controls HTTP request handling; no DB access, no socket access.
- **Assets at risk:** payment context fields (network, amount, etc.) — all re-validated by the owner.
- **Attack path:** forge a payment context to trick the facilitator into authorizing an
  attacker-chosen payment.
- **Mitigation:** the owner independently resolves the durable payment row and evaluates
  policy; caller context is never authoritative.
- **Residual risk:** none — the gateway cannot bypass the owner.
- **Scope:** in scope.

### 6.2 Adversary 2: Compromised Facilitator process

- **Capability:** can send arbitrary IPC requests (it is an allowed client).
- **Assets at risk:** authorization decisions for payments that exist in the DB.
- **Attack path:** request authorization for a valid `created` payment with attacker-chosen
  context (e.g. wrong sponsor).
- **Mitigation:** the owner validates every field against its own configuration and the durable
  row; the sponsor must match the owner's configured sponsor; energy must be ≤ `maxEnergy`;
  recipient ≠ sponsor.
- **Residual risk:** the facilitator can request authorization for any `created` payment, but
  cannot bypass policy checks or forge an approval for an invalid state.
- **Scope:** in scope.

### 6.3 Adversary 3: Unauthorized local UID

- **Capability:** any process on the host that is not `facilitator` or `authowner`.
- **Assets at risk:** the authorization DB and the socket.
- **Attack path:** attempt to open the DB or connect to the socket.
- **Mitigation:** DB is `0600 owner:authowner` (EACCES); socket is `0660 owner:authclients`
  and peer UID is verified via `SO_PEERCRED`.
- **Residual risk:** none — OS denies access.
- **Scope:** in scope.

### 6.4 Adversary 4: Same-UID malicious process

- **Capability:** a process running as `authowner` (same UID as the owner).
- **Assets at risk:** the full authorization DB.
- **Attack path:** open the DB directly, insert an `approved` event.
- **Mitigation:** **none at the filesystem level.** Same-UID processes have identical access.
- **Residual risk:** **full compromise.** The boundary collapses.
- **Scope:** out of scope for filesystem isolation; requires container/hypervisor boundary.

### 6.5 Adversary 5: Compromised Authorization Owner

- **Capability:** the owner process itself is compromised (e.g. via a bug in the owner code).
- **Assets at risk:** the full authorization DB, all sponsor keys (future), all payments.
- **Attack path:** arbitrary DB writes, arbitrary signing (future).
- **Mitigation:** code review, minimal attack surface, no network exposure (Unix socket only).
- **Residual risk:** **full compromise.** The owner is the trust root.
- **Scope:** out of scope for this boundary; mitigated by code quality and deployment hardening.

### 6.6 Adversary 6: Root or host administrator

- **Capability:** root access to the host.
- **Assets at risk:** everything.
- **Attack path:** read/write any file, impersonate any UID, bypass all permissions.
- **Mitigation:** none at the OS level.
- **Residual risk:** **full compromise.**
- **Scope:** out of scope. Requires host-level security (HSM, hardware attestation).

### 6.7 Adversary 7: Malformed or replayed IPC client

- **Capability:** send arbitrary bytes over the socket.
- **Assets at risk:** authorization decisions, audit integrity.
- **Attack path:** oversized messages, unknown fields, smuggled `decision` field, replayed
  `requestId`.
- **Mitigation:** strict validation (§3.4, §3.5), 64 KiB size limit, unknown-field rejection,
  `requestId` idempotency, durable gate prevents double approval.
- **Residual risk:** none — all paths fail closed.
- **Scope:** in scope.

### 6.8 Adversary 8: Database corruption or storage failure

- **Capability:** disk failure, bit rot, partial write.
- **Assets at risk:** audit history, authorization state.
- **Attack path:** corrupt the DB file; the owner fails to open it.
- **Mitigation:** WAL + `synchronous=FULL` (`repository.ts:197-198`); busy timeout; backup
  procedure (§4.11).
- **Residual risk:** data loss if backup is stale; mitigated by monitoring and backup.
- **Scope:** in scope (operational).

### 6.9 Process isolation vs. host isolation

| | Process isolation (this design) | Host isolation (out of scope) |
|---|---|---|
| Protects against | different-UID processes, unauthorized socket clients | root, same-UID, kernel compromise |
| Does NOT protect against | same-UID, root | hypervisor escape |
| Mechanism | filesystem permissions + peer credentials | VM/container boundary |
| Cost | low | high |

---

## 7. Future integration boundary (FacilitatorCore.settle() ↔ Authorization Owner)

**Not implemented.** This section defines the contract for a future task.

### 7.1 Where authorization must occur

Authorization must occur **inside** `FacilitatorCore.settle()`, between:

1. `checkAgreement` + `checkExpiry` (existing),
2. `store.claim()` (existing replay protection),
3. **← authorization here**, via the IPC client,
4. `signer.addSponsorSignature()` (future, inside the owner),
5. `computeTransactionHash` → `prepare` → `claimSubmit` → `submitTransaction` (existing).

The authorization call replaces the direct `addSponsorSignature` + policy check. The owner
evaluates policy and, if approved, the sponsor signing happens inside the owner process.

### 7.2 Validations before any future signing operation

The owner must verify (in order):

1. Peer UID is `facilitator`.
2. Request is valid per §3.4.
3. `paymentDigest` exists in the durable store.
4. State is `created`, `tx_hash IS NULL`.
5. No prior `approved` sign event.
6. `decideAuthorization` passes (network, version, asset, addresses, sponsor match,
   sponsor ≠ sender, sponsor ≠ recipient, expiry, energy).
7. Audit event persisted (fail-closed).

Only after all 7 steps may the owner proceed to any signing operation (future task).

### 7.3 Energy limits and sponsor/recipient separation

- `maxEnergy` is enforced by the owner's policy, not the caller.
- `sponsor ≠ sender` and `sponsor ≠ recipient` are enforced by the owner's policy.
- The caller's `context.energy` is **advisory**; the owner uses its own `maxEnergy` from
  configuration. If the caller's energy exceeds the owner's cap, the request is rejected.
- Energy cap and sponsor≠recipient must be enforced **on the settle path**, not only in the
  mock authorization layer (TASK34.5 finding).

### 7.4 Binding durable authorization to the payment

- The authorization decision is recorded in `sign_events` with the `paymentDigest` as the key.
- The `tx_hash` is computed **after** sponsor signing (TASK28) and persisted via `prepare()`.
- The approval and the hash are linked by `paymentDigest`, not by the hash itself (the hash
  does not exist at authorization time).
- A payment can have at most one `approved` sign event (partial unique index).

### 7.5 Authorization failures prevent progression

- If `authorize()` returns `rejected` or `unknown`, `settle()` must not proceed to signing,
  `prepare()`, or submission.
- If `authorize()` returns `owner_unavailable`, `settle()` must return a non-terminal
  `settlement_pending` result (not an error, not success).
- If `authorize()` returns `approved`, `settle()` proceeds to sponsor signing (future).

### 7.6 Uncertain IPC outcomes remain fail-closed

- `unknown` / `owner_unavailable` → `settle()` returns `settlement_pending` with
  `extra.nonTerminal: true`. No signing, no submission.
- The client must not retry an `unknown` authorization. The durable gate prevents a second
  approval even if a retry occurs.
- A crash between authorization and `prepare()` leaves the payment in `created` state with no
  hash — fully retryable (no durable side effect).

---

## 8. Design decisions and unresolved questions

### Design decisions

1. **Unix socket over TCP** — same-host, peer credentials replace transport auth.
2. **No TLS/mTLS** — unnecessary for same-host; mandatory if ever TCP.
3. **`SO_PEERCRED` over socket permissions** — filesystem permissions are necessary but not
   sufficient.
4. **Reject root** — root can bypass everything; rejecting it is defense-in-depth.
5. **No caller-supplied `decision` field** — the owner is the sole decision maker.
6. **Caller `context` is advisory** — the owner re-derives all policy decisions.
7. **`unknown` outcome is non-retryable** — prevents double approval.
8. **Separate UIDs are mandatory** — same-UID deployment collapses the boundary.

### Unresolved questions

1. **Idempotency store durability** — should it be in the same DB or a separate one? If the
   owner crashes, the store is lost; the durable gate prevents double approval, but the
   caller cannot distinguish `unknown` from `rejected`. Recommendation: same DB, same
   transaction, but mark it as best-effort.
2. **Rate limiting granularity** — per-UID, per-payment, or per-IP? Recommendation: per-UID
   + per-payment-digest.
3. **Owner health check** — should the facilitator poll the socket or use a readiness probe?
   Recommendation: readiness probe via a `ping` operation (not `authorize`).
4. **Backup frequency** — how often should the DB be backed up? Recommendation: after every
   N approvals or every hour, whichever comes first.
5. **Multi-owner (HA)** — can there be a standby owner? Recommendation: no — single writer
   is simpler and avoids split-brain. HA requires a distributed consensus layer, which is
   out of scope.

---

## 9. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED (from TASK34.6 execution)

- Different-UID filesystem isolation: non-owner cannot open the DB (`EACCES`).
- Same-UID raw writer succeeds (documented limitation).
- IPC caller-supplied `decision` field rejected.
- Duplicate authorization refused; concurrent → exactly one approval.
- Owner crash/restart → durable DB, no double approval.
- Audit-write failure → fail-closed.

### NOT TESTED

- `SO_PEERCRED` peer-credential verification (design only).
- Request ID idempotency store (design only).
- Rate limiting (design only).
- systemd hardening (design only).
- Backup/restore procedures (design only).
- Future integration with `FacilitatorCore.settle()` (design only).

### BLOCKED

- Absolute isolation against root or same-UID processes — impossible with filesystem
  permissions alone. Requires a container/hypervisor boundary, outside this repository.

---

## 10. Constraints honoured

No signer / `AccountSigner` / key material / wallet · no sponsor account creation, funding,
or provisioning · no transaction construction, submission, broadcast, or faucet · no Mainnet
interaction · no real settlement · `FacilitatorCore.settle()` untouched · settlement not
enabled · `DENY_ALL_FACILITATOR` preserved · token 1004 and its Agent Card untouched · no
production data migrated · no commit, push, release, or publish · TASK36 not started.

## 11. Stop condition

TASK 34.7 complete. Production IPC contract and operational threat model specified. No
implementation. Awaiting explicit maintainer approval.