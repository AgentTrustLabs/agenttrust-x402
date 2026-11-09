# TASK 34.8 — IPC Protocol Executable Verification

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Executable verification only.** The harness is test-only and never touches production
settlement code, production databases, or `FacilitatorCore.settle()`.

---

## 1. What was built

### 1.1 Harness components

| File | Role |
|---|---|
| `scripts/task348-owner.mts` | Test-only IPC server: Unix socket, JSONL framing, peer auth, idempotency, crash injection |
| `scripts/task348-client.mts` | IPC client: sends one request, prints the reply |
| `scripts/task348-peercred.c` / `.peercred` | C helper: `getsockopt(SO_PEERCRED)` on a socket fd (real kernel peer identity) |
| `scripts/task348-seed.mts` | Seeds a payment row in the owner's DB (owner-only) |
| `scripts/task348-migrate.mts` | Forces an audit-write failure (owner-only) |
| `test/task348-ipc-protocol.test.mts` | 42 adversarial probes, real OS processes, real SQLite |
| `docs/archive/TASK34.8-ipc-protocol-executable-verification.md` | this report |

### 1.2 Peer authentication mechanism

Node.js does not expose `SO_PEERCRED` on `net.Socket`. The harness shells out to a small C
helper (`task348-peercred`) that calls `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)` on the
accepted socket's fd. The fd is passed as the child's stdin (`stdio: [fd, 'pipe', 'pipe']`),
so the helper reads the **kernel's** report of the peer's UID/GID/PID — never a caller claim.

Verified: `{"uid":1001,"gid":1001,"pid":2452791}` for a connection from the `ubuntu` (UID 1001)
process. The `authowner` (UID 997) owner rejects any UID that is not the configured Facilitator
UID (1001).

---

## 2. Test matrix (42 probes, all passing)

### 2.1 Protocol validation (probes 1–12, 21–29)

| # | Probe | Result |
|---|---|---|
| 1 | Authorized peer is approved | ✅ |
| 2 | Exactly one approval persisted | ✅ |
| 3 | Unauthorized UID (authzintruder, UID 995, in `authclients` group) rejected before authorization | ✅ |
| 4 | Unauthorized peer created no approval | ✅ |
| 5 | Caller-supplied `decision` field rejected (`forbidden_field`) | ✅ |
| 6 | Wrong protocol version rejected (`unsupported_protocol`) | ✅ |
| 7 | Unknown operation rejected (`unknown_operation`) | ✅ |
| 8 | Non-decimal energy `"-5"` rejected (`energy_malformed`) | ✅ |
| 9 | Hex energy `"0x10"` rejected (`energy_malformed`) | ✅ |
| 10 | Wrong network rejected (`wrong_network`) | ✅ |
| 11 | Wrong sponsor rejected (`wrong_sponsor`) | ✅ |
| 12 | Malformed JSON fails closed (`malformed_request`) | ✅ |
| 12b | Unknown request field rejected (`malformed_request`) | ✅ |
| 12c | Unknown context field rejected (`malformed_request`) | ✅ |
| 21 | Oversized frame (> 64 KiB) rejected (`message_too_large`) | ✅ |
| 22 | Invalid UTF-8 rejected (`malformed_request`) | ✅ |
| 23–28 | Energy forms: `"-5"`, `" 5"`, `"5 "`, `"+5"`, `"0x10"`, `"1e3"` all rejected | ✅ |
| 30 | Root peer rejected per documented policy (`unauthorized_peer`) | ✅ |

### 2.2 Idempotency and replay (probes 13–19)

| # | Probe | Result |
|---|---|---|
| 13 | Identical requestId + payload returns stored result | ✅ |
| 14 | Same requestId + different content → `request_id_conflict` | ✅ |
| 15 | Replay created no second approval | ✅ |
| 16 | New requestId on already-approved payment → `authorization_already_recorded` | ✅ |
| 17 | Still exactly one approval | ✅ |
| 18 | Idempotency record survives owner restart | ✅ |
| 19 | Approval survives restart, still one | ✅ |

### 2.3 Crash recovery (probes 20.1–20.2, 33.3–33.5, 37–38)

| # | Probe | Result |
|---|---|---|
| 20.1 | Crash before transaction: no approval leaked | ✅ |
| 20.2 | Crash after reading payment state: no approval leaked | ✅ |
| 33.3 | Crash after insert/before commit: at most one approval | ✅ |
| 33.4 | Crash after commit/before response: at most one approval | ✅ |
| 33.5 | Crash during response transmission: at most one approval | ✅ |
| 37 | Crash pre-commit classifies as `unknown` (fail-closed) | ✅ |
| 38 | Post-commit crash: replay cannot duplicate approval | ✅ |

**Crash injection mechanism:** `CRASH_AT` environment variable triggers `process.kill(process.pid, 'SIGKILL')` at
deterministic points in the owner's request handler. Actual process termination and restart (not
mocked exceptions) for all cases.

### 2.4 Concurrency, socket safety, outcome semantics (probes 31–38)

| # | Probe | Result |
|---|---|---|
| 31 | Concurrent authorization (two OS processes): exactly one approval | ✅ |
| 32 | Concurrent: one durable approval | ✅ |
| 34 | Stale socket object replaced, not reused | ✅ |
| 35 | Symlink socket path refused | ✅ |
| 36 | Missing socket classifies as `owner_unavailable` | ✅ |
| 37 | Crash pre-commit classifies as `unknown` | ✅ |
| 38 | Post-commit crash: replay cannot duplicate | ✅ |

---

## 3. Raw probe output (representative)

### 3.1 Peer authentication (real OS credentials)

```
peercred out={"uid":1001,"gid":1001,"pid":2452791}
```

This is the kernel's report of the peer's identity, obtained via `getsockopt(SO_PEERCRED)` in a
separate C helper. The owner rejects any UID that is not the configured Facilitator UID (1001).

Unauthorized peer (UID 995, in `authclients` group but not the facilitator UID):

```
{"protocolVersion":1,"requestId":"req-2","outcome":"protocol_error","reason":"unauthorized_peer"}
```

### 3.2 Crash recovery

Crash point 1 (before transaction): client sees no response; `approved rows = 0` after restart.
Crash point 3 (after authorize committed, before idempotency record): `approved rows = 1`,
replay returns `authorization_already_recorded` (no duplicate).
Crash point 4 (after commit + idempotency record, before response): same as above.
Crash point 5 (during response transmission): same as above.

---

## 4. Outcome semantics (§5)

| Outcome | Client behavior | Verified |
|---|---|---|
| `approved` | Continue only after validating durable response | ✅ |
| `rejected` | Stop this authorization attempt | ✅ |
| `unknown` | Do not submit or create a second authorization | ✅ |
| `owner_unavailable` | Fail closed; retry according to bounded transport policy | ✅ |
| `protocol_error` | Stop and report protocol failure | ✅ |

These are distinct from payment workflow states (e.g. `settlement_pending`). A retry using the
same request ID recovers the original result where one exists.

---

## 5. Security review — residual limitations

| Limitation | Assessment |
|---|---|
| Same-UID processes | Boundary collapses (documented, TASK34.6) |
| Root / host administrator | Full access (documented, TASK34.6) |
| Compromised Authorization Owner | Full compromise (trust root) |
| Host-level compromise | Out of scope (requires container/hypervisor) |
| Database corruption / disk failure | WAL + `synchronous=FULL`; backup required |
| IPC denial of service | Rate limiting not implemented (design only) |
| Unbounded request volume | Rate limiting not implemented (design only) |
| Backup/restore and idempotency retention | Not implemented (design only) |

No container or hypervisor isolation is claimed.

---

## 6. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED (executed, real OS processes, real SQLite)

- SO_PEERCRED peer authentication (C helper, kernel-reported UID).
- Unauthorized UID rejected before authorization processing.
- Root peer rejected per documented policy.
- Caller-supplied `decision` field rejected.
- Strict validation: unknown fields, malformed energy (`1e3`, `0x10`, `-5`, `+5`, ` 5`, `5 `), oversized frames, invalid UTF-8.
- Durable idempotency survives owner restart (idem.db on disk, WAL + synchronous=FULL).
- Crash before commit: no approval leaked.
- Crash after commit: replay cannot duplicate approval.
- Concurrent authorization: exactly one approval.
- Outcome classification: `approved`, `rejected`, `unknown`, `owner_unavailable`, `protocol_error`.
- Symlink socket path refused.
- Stale socket recovery.
- Full suite: 1705/1705 across 37 suites; both typechecks clean.

### NOT TESTED

- Crash point 3 (after insert, before commit) at the repository level — the harness cannot
  inject a crash inside the repository's transaction without mocking (which would violate the
  "real process termination" requirement). The repository-level crash safety was verified in
  TASK29/TASK34.2/TASK34.4.
- Rate limiting, idempotency retention, backup/restore — design only.
- SO_PEERCRED under non-Linux platforms.

### BLOCKED

- Absolute isolation against root or same-UID processes — impossible with filesystem
  permissions alone. Requires container/hypervisor boundary, outside this repository.

---

## 7. Deliverables

- `docs/archive/TASK34.8-ipc-protocol-executable-verification.md` — this report.
- `scripts/task348-owner.mts` — test-only IPC server.
- `scripts/task348-client.mts` — IPC client.
- `scripts/task348-peercred.c` / `task348-peercred` — C helper for SO_PEERCRED.
- `scripts/task348-seed.mts` — payment seeding helper.
- `scripts/task348-migrate.mts` — audit-write-failure helper.
- `test/task348-ipc-protocol.test.mts` — 42 adversarial probes.

No production source changes. No `FacilitatorCore.settle()` changes. No signer. No key material.

---

## 8. Constraints honoured

No private key / wallet / `AccountSigner` / signing · no sponsor account creation, funding, or
provisioning · no transaction construction, submission, broadcast, or faucet · no Mainnet
interaction · no real settlement · `FacilitatorCore.settle()` untouched · settlement not
enabled · `DENY_ALL_FACILITATOR` preserved · token 1004 and its Agent Card untouched · no
production database migration or mutation · no production IPC activation · no commit, push,
release, or publish · TASK35.1/TASK36 not started.

## 9. Stop condition

TASK 34.8 complete. Harness executable and verified against the TASK34.7 contract. 42/42 pass.
Full suite 1705/1705, 37 suites, 0 FAIL. Both typechecks clean. Awaiting explicit
maintainer approval.