# TASK 64 — Pre-Demo Runtime Completion

## VERDICT: PASS

All three runtime-readiness items from TASK63 are implemented, tested, and documented.
Mock mode is unchanged; real mode has no mock fallback; startup recovery is fail-closed and
never submits; sponsor wallet material is never read, logged, or exposed by the facilitator.

## 1. WORKSTREAM A — CORRECT REAL-MODE LOGGING — PASS

**Defect closed:** the unconditional stale line `this is a MOCK: it cannot sign and cannot
submit. No chain is contacted.` was removed from `services/facilitator/src/server.ts`.

**Replacement:** the CLI startup block is now keyed on `process.env['FACILITATOR_MODE']`
(the same value `loadConfig` validated) and logs mode-accurate, non-secret operational facts:

```
facilitator listening on <url> (mode=<env FACILITATOR_MODE>)
real mode: signing via the dedicated IPC signing service; submission via Concordium gRPC.
real mode: this process holds no private keys and does not contact a node for its own account.
```

and in mock mode:

```
mock mode: it cannot sign and cannot submit. No chain is contacted.
```

No key material, wallet path, mnemonic, or credential identifier appears in any log string.
Regression tests: `test/task64-pre-demo-runtime-completion.test.mts` A01–A05.

## 2. WORKSTREAM B — STARTUP RECOVERY INTEGRATION — PASS

**Configuration (fail-closed defaults):**

| Variable | Default | Validation |
|---|---|---|
| `FACILITATOR_RECOVER_ON_STARTUP` | `false` (unset) | Only `1` enables it; rejected in mock mode |
| `FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS` | `30000` | Must be a positive finite number |

**Lifecycle point:** after the repository is initialized and the IPC signer / gRPC submitter
are constructed, but **before** `server.listen()`. The facilitator cannot advertise readiness
until the recovery pass returns or fails.

**Behaviour:**
- Real mode only (`config.recoverOnStartup && config.mode === 'real'`).
- `core.recoverPending()` is awaited under `withTimeout(...)`; a timeout or thrown error is
  converted to `ConfigurationError('startup recovery failed: …')` and aborts startup.
- The recovery summary is logged as JSON (`scanned/finalized/failed/pending/transportErrors/skipped`).
- Recovery only polls finalization state by hash. It never constructs, signs, submits, or
  broadcasts a transaction.
- TASK59's two-observation rejection confirmation is preserved: a `failed` observation counts
  as terminal only when the confirmation gate actually advanced state (`r.ok && r.changed`).
- `submitting` rows are advanced to broadcast-attempted before polling; a concurrent recovery
  already advancing a row is ignored.
- `outcome_unknown` transport errors are recorded as pending (`recovery transport error`), never
  converted into success.
- Recovery off by default: persisted pending rows stay `outcome_unknown` until an operator acts.

**Tests:** B01–B14 cover default/override/refusal, empty repository, pending-to-finalized before
readiness, terminal rows untouched, recovery failure aborting startup, zero submit calls,
and opt-in behaviour. All use temporary SQLite databases and an injected fake node — no
production data, no chain calls.

## 3. WORKSTREAM C — PRODUCTION SECRET INJECTION — PASS

**Mechanism:** an explicit environment variable carries the sponsor wallet export path to the
signing-service launcher. No external secret manager was introduced; the deployment contract
is a filesystem path plus strict ownership/permission checks.

```
FACILITATOR_SPONSOR_WALLET_FILE=/etc/agenttrust/sponsor-wallet.json
```

**Validation at configuration time (`loadConfig`):**
- Must be an absolute path.
- Must not contain path traversal (`..` component).
- Unset/empty is allowed (`null`) so the signing service can be started independently.

**Validation at startup (`inspectWalletFile`, real mode):**
- Absolute, traversal-free path.
- File exists and is a regular file.
- Not world-readable (`mode & 0o004`).
- Not group-writable (`mode & 0o020`).
- Owned by the current process user, or by root in a root-started deployment.
- Only `stat` is used; **contents are never opened or read**.

A failed inspection raises
`ConfigurationError('sponsor wallet file is not deployment-ready: <reason> (mode=<mode>)')`
and aborts real-mode startup. The message contains only the path's metadata — never its contents.

The launcher (`scripts/task57-wallet-service.mts`) applies the same checks before binding its
socket, loads the export before binding, and prints only `signer=loaded` plus non-secret facts.
No mock fallback exists in real mode; a missing export or failed load exits non-zero.

**Tests:** C01–C19 cover optional/unset path, absolute-path acceptance, relative-path and
traversal rejection, `0600` acceptance, world-readable/group-writable/missing/relative
rejection, real-mode startup refusal with a bad file, clean failure text without file contents,
a good file passing startup, and launcher refusal on missing configuration / missing file with
no key material in output.

## 4. CONFIGURATION AND DEPLOYMENT

### 4.1 Full runtime environment (Testnet, real mode)

```
FACILITATOR_MODE=real
FACILITATOR_HOST=127.0.0.1
FACILITATOR_PORT=0
FACILITATOR_SPONSOR_ADDRESS=<base58check sponsor address>
FACILITATOR_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27
FACILITATOR_DB_PATH=/var/lib/agenttrust/facilitator.db
FACILITATOR_NODE_HOST=grpc.testnet.concordium.com
FACILITATOR_NODE_PORT=20000
FACILITATOR_NODE_USE_TLS=1
FACILITATOR_SENDER_VERIFICATION=sdk
FACILITATOR_SIGNING_SERVICE_SOCKET=/run/agenttrust/signing.sock
FACILITATOR_SIGNING_SERVICE_UID=<service-user-uid>
FACILITATOR_SIGNING_TIMEOUT_MS=3000
FACILITATOR_SENDER_VERIFY_TIMEOUT_MS=3000
FACILITATOR_MAX_FEE_MICROCCD=10000000
FACILITATOR_MAX_ENERGY=1000
FACILITATOR_EVIDENCE_MODE=none
FACILITATOR_RECONCILE_ENABLED=0
FACILITATOR_RECOVER_ON_STARTUP=1
FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS=30000
FACILITATOR_SPONSOR_WALLET_FILE=/etc/agenttrust/sponsor-wallet.json
```

The facilitator process itself does **not** read the wallet file; only the signing service
does. The facilitator's `FACILITATOR_SPONSOR_WALLET_FILE` is a deployment read-check on the
signing-service host (same filesystem), not an injection of secret material into the
facilitator.

### 4.2 systemd-style deployment outline

```ini
[Service]
User=agenttrust
Group=agenttrust
EnvironmentFile=/etc/agenttrust/facilitator.env
ExecStart=/usr/bin/npx tsx /opt/agenttrust/services/facilitator/src/server.ts
Restart=on-failure
```

```ini
[Service]
User=agenttrust
Group=agenttrust
EnvironmentFile=/etc/agenttrust/signing.env
ExecStart=/usr/bin/npx tsx /opt/agenttrust/scripts/task57-wallet-service.mts
RuntimeDirectory=agenttrust
```

`/etc/agenttrust/*.env` is mode `0600`, owned by root. The wallet export is mode `0600`,
owned by `agenttrust`, and is never present in the facilitator process environment.

### 4.3 Safe rotation procedure

1. Export the replacement single-account key file with the wallet client (TASK58 procedure).
2. Install it alongside the old file with safe permissions:
   `install -o agenttrust -g agenttrust -m 0600 <new-export> /etc/agenttrust/sponsor-wallet.json.new`
3. Stop the signing service (the in-memory signer is discarded).
4. Atomically replace the active file:
   `mv /etc/agenttrust/sponsor-wallet.json.new /etc/agenttrust/sponsor-wallet.json`
5. Start the signing service with the same `FACILITATOR_SPONSOR_WALLET_FILE`.
6. Verify non-secret readiness: the service prints `signer=loaded`, the socket is `0660` and
   owned by the service user, and `GET /supported` advertises the new sponsor address as
   `feePayer`. If the printed sponsor differs, stop and roll back to the old export.
7. Keep the old export only in an encrypted offline backup if the old account must remain
   recoverable; otherwise destroy it securely. Do not keep copies in logs, CI artifacts, or
   shell history.

Rotation of the sponsor **account** also requires re-checking the sponsor balance on the
read-only verification script; no funding or faucet operation is part of this procedure.

## 5. ACCEPTANCE CRITERIA

| Criterion | Status |
|---|---|
| Real-mode logs are accurate | PASS |
| Startup recovery integrated and fail-closed | PASS |
| Secret injection works without exposing wallet material | PASS |
| Mock mode remains functional | PASS |
| Real mode never silently falls back to mock | PASS |
| Existing sponsor identity, fee caps, signature verification intact | PASS |
| Build, typechecks, full test suite pass | PASS |

## 6. REGRESSION RESULTS

Full suite: `npm test` (pretest `tsc`, then `node test/run.mjs`) — **all suites passed**,
exit code 0. Task64 suite: `task64: 41/41 passed, 0 failed`. Relevant TASK57–63 suites:

- `task57-local-sponsor-wallet-secret-loading.test.mts`: task57: 27/27 passed
- `task59-finalization-confirmation-evidence.test.mts`: task59: 63/63 passed
- `task55-production-testnet-wiring.test.mts`: task55: 52/52 passed
- `task53-idempotency-recovery-concurrency.test.mts`: task53: 13/13 passed
- `task52-core-submission-recovery.test.mts`: task52: 18/18 passed
- `task51-v1-sponsored-submission.test.mts`: task51: 27/27 passed
- `task46-facilitator-sponsor-signer-wiring.test.mts`: task46: 30/30 passed
- `task25-facilitator.test.mts`: task25-facilitator: 36/36 passed
- `task29-prebroadcast.test.mts`: task29-prebroadcast: 65/65 passed
- `task29.1-postsubmit-crash.test.mts`: task29.1-postsubmit-crash: 49/49 passed

Typecheck: `tsc --noEmit` — 0 errors.
Build: `tsc` — 0 errors.
Real-mode startup probe (`scripts/task63-runtime-readiness.sh`): facilitator bound
`http://127.0.0.1:38225`, `/healthz` reports `mode=real`, `canSign=true`, `/supported` advertises
the sponsor as `feePayer`, `/reconcile` returns 404 unauthenticated. No payment requests
were made and no transactions were constructed or broadcast.

## 7. VERIFIED

- A: no unconditional MOCK line; mode-keyed real/mock startup messages; no secret identifiers
  in log strings; both modes covered by regression tests.
- B: recovery config defaults and validation; real-mode-only enforcement; bounded recovery
  before readiness; pending row finalized before readiness; terminal row untouched; recovery
  failure aborts startup; zero submit calls; opt-in default; TASK59 confirmation gate intact.
- C: env-driven wallet path; absolute/traversal validation; `stat`-only inspection;
  world-readable/group-writable/missing/relative/ownership rejection; real-mode startup
  refusal without leaking contents; good file passes; launcher refuses missing config/file;
  no key material in launcher output.
- Mock mode starts, cannot sign, and real mode still refuses passthrough verification.
- `DENY_ALL_FACILITATOR` remains enabled; settlement remains disabled.

## 8. NOT VERIFIED / KNOWN LIMITATIONS

- No live sponsored transaction, signing, submission, or broadcast was performed (explicitly
  out of scope and prohibited by the task constraints).
- No production secret store (Vault/KMS) was introduced; the deployment contract is a
  filesystem path with `0600` ownership. A secret manager is unnecessary for a single
  signing-service host and would add an operational dependency.
- `inspectWalletFile` follows symlinks (uses `stat`). On a host where an untrusted user can
  create a symlink inside the configured directory, use `lstat` or a directory-owned path.
- Recovery is bounded by timeout; a slow node can make startup fail rather than hang
  indefinitely. That is the intended fail-closed behaviour.
- `/reconcile` remains disabled unless an operator credential is configured.

## 9. STATE TRANSITIONS

Recovery only observes and reconciles existing persisted hashes:

```
submitting ──(markBroadcast)──> broadcast-attempted ──(poll finalized)──> finalized
outcome_unknown ──(poll failed, confirmed)──> rejected
outcome_unknown ──(transport error)──> outcome_unknown (marked recovery transport error)
pending/committed observation ──> outcome_unknown (observation recorded, no terminal change)
```

No transition creates a new transaction hash, and no transition constructs, signs, submits, or
broadcasts anything.

## 10. NEXT PHASE

Implementation and regression are complete. The next phase — a first live sponsored transaction
— requires separate maintainer approval and is **not** part of TASK64.

## CONSTRAINTS HONOURED

No transaction constructed for broadcast, signing, submission, or broadcasting. No real payment
requests. No funding or faucet operations. Token 1004 and its Agent Card untouched. No private
key material printed, copied, or transmitted. `DENY_ALL_FACILITATOR` enabled; settlement
disabled. No commits or pushes.
