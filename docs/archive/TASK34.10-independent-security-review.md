# TASK 34.10 — Independent Security Review: IPC, Idempotency & Crash Recovery

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Review only.** No implementation fixes. No production source, test, or schema changes.

---

## 1. Executive verdict

**PASS WITH CONDITIONS.**

The IPC contract, durable idempotency, process authentication, and SQLite crash-recovery guarantees are
substantially supported by both the documented specification and the executable harness evidence.
The core security boundary — a separate-UID Authorization Owner that is the sole writer of
`sign_events`, with peer-credential authentication and a narrow, non-approvable IPC contract —
is demonstrated with real OS processes and real SQLite.

Two conditions must be resolved before production use:

1. **The production code has no request-id idempotency store.** The harness's `idem.db` is
   test-only. In production, idempotency is the durable gate itself (`state='created'`,
   `tx_hash IS NULL`, no prior `approved`). A client that crashes after authorization but before
   receiving the response cannot recover the original response metadata — only the fact that
   authorization occurred (`authorization_already_recorded`). This is fail-safe but loses
   correlation data.

2. **The TASK34.4 DB trigger does not enforce provenance.** A raw SQL writer can still forge
   an `approved` event for a valid `created` payment with `tx_hash IS NULL` (TASK34.5 finding,
   confirmed by executed probe). The trigger is a defense-in-depth guard for invalid states, not
   a provenance enforcement mechanism. This is documented as a known limitation but remains
   unresolved.

---

## 2. Scope and exact baseline

- HEAD: `4c8994db391d77796e06e49c843c42be1eae615b` (unchanged throughout).
- Working tree: 74+ untracked files (all TASK17–TASK34.9 deliverables). No tracked modifications.
- Full suite: 1735/1735 across 38 suites (last verified 2026-11-05).
- Facilitator and gateway typecheck: clean.
- TASK34.7, TASK34.8, TASK34.9 reports inspected; TASK34.6 PoC source inspected.

---

## 3. Source files inspected

| File | Lines | Inspection depth |
|---|---|---|
| `docs/archive/TASK34.7-production-ipc-contract-threat-model.md` | 500+ | full |
| `docs/archive/TASK34.8-ipc-protocol-executable-verification.md` | 200+ | full |
| `docs/archive/TASK34.9-real-sqlite-transaction-crash-verification.md` | 200+ | full |
| `scripts/task348-owner.mts` | 349 | full (lines 1–349) |
| `scripts/task348-client.mts` | 40 | full |
| `scripts/task348-peercred.c` | 45 | full |
| `scripts/task348-seed.mts` | 25 | full |
| `scripts/task348-migrate.mts` | 30 | full |
| `test/task348-ipc-protocol.test.mts` | 420+ | full |
| `scripts/task349-owner.mts` | 290 | full |
| `test/task349-transaction-crash.test.mts` | 200+ | full |
| `services/facilitator/src/repository.ts` | 954 | full (all methods) |
| `services/facilitator/src/narrowSponsor.ts` | 200+ | full |
| `services/facilitator/src/narrowSponsorMock.ts` | 77 | full |
| `services/facilitator/src/core.ts` | 330+ | full |
| `services/facilitator/src/state.ts` | 60+ | full |

---

## 4. TASK34.7 contract assessment

### 4.1 Verified claims

| Contract claim | Verified? | Evidence |
|---|---|---|
| JSONL framing, 64 KiB limit | ✅ | `task348-owner.mts:225` (`bytes > MAX_MSG`) |
| Protocol version validation | ✅ | `validate()`: `protocolVersion !== 1` → `unsupported_protocol` |
| Operation allow-list | ✅ | `validate()`: `operation !== 'authorize'` → `unknown_operation` |
| Forbidden `decision` field | ✅ | `FORBIDDEN` set + allow-list; test 5 passes |
| Strict decimal energy parsing | ✅ | `/^[0-9]+$/` regex; tests 8–9 pass |
| Unknown fields rejected | ✅ | `REQ_ALLOWED` / `CTX_ALLOWED` allow-lists (tests 12b, 12c) |
| SO_PEERCRED authentication | ✅ | C helper `getsockopt(SO_PEERCRED)`; test 3 passes |
| Root rejection | ✅ | `peerUid === 0` → `unauthorized_peer`; test 30 passes |
| Socket symlink refusal | ✅ | `lstatSync` + `isSymbolicLink()` check; test 35 passes |
| Separation from `settlement_pending` | ✅ | protocol uses `approved`/`rejected`/`unknown`/`owner_unavailable`/`protocol_error` |
| Owner-side policy re-derivation | ✅ | `decideAuthorization(request, POLICY, nowSec)` called by owner, not caller |
| Peer UID checked before authorization | ✅ | `peerCredOf(conn)` at line 209, before `validate()` |

### 4.2 Design-only claims (not executable)

| Claim | Status | Note |
|---|---|---|
| Rate limiting | Design only | Not implemented in the harness |
| Idempotency store durability | Design only | Harness `idem.db` is test-only; production has no idempotency store |
| systemd hardening (`ProtectSystem`, `NoNewPrivileges`) | Design only | Not implemented |
| Backup/restore procedures | Design only | Not implemented |
| `SO_PEERCRED` under non-Linux | Not applicable | Linux-only; documented |

### 4.3 Contract assessment verdict

The documented contract is **grounded in the actual harness implementation**. Every executable
claim is verified by a passing test. Design-only claims are clearly marked. No contradiction
between the spec and the harness was found.

---

## 5. TASK34.8 IPC assessment

### 5.1 SO_PEERCRED — real kernel identity

**Verified.** The C helper (`scripts/task348-peercred.c`) calls `getsockopt(fd, SOL_SOCKET,
SO_PEERCRED, ...)` on the accepted socket's fd. The fd is passed as the child's stdin
(`stdio: [fd, 'pipe', 'pipe']`), so the helper reads the **kernel's** report of the peer's
identity — not a caller claim.

Raw output: `{"uid":1001,"gid":1001,"pid":2452791}` for a connection from the `ubuntu`
(UID 1001) process.

### 5.2 UID checked before authorization processing

**Verified.** The owner checks `peerCredOf(conn)` at line 209, before `validate()` (line 219).
An unauthorized UID receives `unauthorized_peer` and the connection continues to the next
message (no crash, no hang).

### 5.3 Unauthorized UID that can connect is still rejected

**Verified.** `authzintruder` (UID 995, member of `authclients` group) can connect to the
socket (group permission) but is rejected with `unauthorized_peer`. This proves peer
authentication, not merely socket permissions.

### 5.4 Malformed and oversized frames fail closed

**Verified.** Tests 12, 12b, 12c, 21, 22 all pass. Invalid UTF-8 is caught by
`TextDecoder('utf-8', { fatal: true })`. Oversized frames are caught by the `bytes > MAX_MSG`
check before parsing.

### 5.5 Idempotency tests prove durable behavior across restart

**Verified for clean restart.** Tests 13–19 pass, including test 18 (idempotency survives
restart). The `idem.db` uses WAL + `synchronous=FULL` and is on disk.

**Caveat:** the idempotency store is a **separate database** (`idem.db`) from the
authorization DB (`auth.db`). They are committed in separate transactions. A crash between
the authorization commit and the idempotency write loses the idempotency record (but the
approval is durable). See §7 for the full analysis.

### 5.6 SIGKILL tests terminate real processes

**Verified.** The test uses `process.kill(pid, 'SIGKILL')` via the `CRASH_AT` environment
variable. The owner process is a real OS process (`authowner`, UID 997). No mocked
exceptions.

### 5.7 Concurrency tests use separate OS processes

**Verified.** Tests 31–32 use `spawn('sudo', ['-u', 'ubuntu', 'npx', 'tsx', clientScript, ...])`
— two real OS processes sharing one DB and one socket.

### 5.8 Test cleanup can leave privileged processes or sockets behind

**Partially verified.** The test's `stopOwner` kills by PID (via `pgrep`), but the `pgrep -f
'scripts/task348-owner.mts'` pattern can match the test process itself if its command line
contains that string. In practice, the test process is `npx tsx test/task348-ipc-protocol.test.mts`,
which does not contain `task348-owner.mts`, so this is safe. However, if a previous test run
left orphan processes, they could interfere. The test does not clean up stale processes at
startup.

**Finding (Low):** The test harness does not kill stale owner processes at startup. A previous
crashed run could leave an owner listening on a stale socket, causing the next run to fail
with "socket already in use" or to connect to a stale owner.

---

## 6. TASK34.9 crash and SQLite assessment

### 6.1 Harness uses real SQLite operations and real process termination

**Verified.** The harness uses `new DatabaseSync(path)` (the real driver), `BEGIN IMMEDIATE`,
`INSERT`, `COMMIT`, and `process.kill(process.pid, 'SIGKILL')`. No mocked transactions.

### 6.2 Crash points are synchronized deterministically

**Verified.** `CRASH_AT=<1..5>` is read at startup. The `crash()` function fires
`process.kill(process.pid, 'SIGKILL')` at the matching point. No exception-based simulation.

### 6.3 P1–P4 leave zero durable approval rows

**Verified.** All four crash points produce 0 durable approvals (direct SQL inspection after
restart). The `payments` row remains `created`/`tx_hash IS NULL` in all cases.

### 6.4 P5 leaves exactly one durable approval row

**Verified.** Crash point 5 produces exactly 1 durable approval. The idempotency record is
also durable (committed before crash(5)).

### 6.5 Retry after P5 returns the original durable result

**Verified.** The retry returns `{outcome: 'approved', reason: null}` (the original result),
not `authorization_already_recorded`. This was corrected by moving `idemPut` before `crash(5)`.

### 6.6 Same request ID with changed payload returns `request_id_conflict`

**Verified.** All 15 probes pass, including the conflicting-payload check.

### 6.7 Payment state and transaction hash remain unchanged

**Verified.** The `payments` row remains `state='created'`, `tx_hash IS NULL` in all scenarios
(including P5, where the approval is durable but the payment state is not advanced — this is
correct, because `authorizeSignEvent` does not modify the payment row).

### 6.8 SQLite restart/recovery behavior is correctly interpreted

**Verified.** The harness correctly interprets SQLite's WAL recovery: after SIGKILL, the next
`new DatabaseSync(path)` opens the DB and sees the committed state. No partial transaction
survives.

### 6.9 Critical distinction: harness replicates, does not directly test production method

**Confirmed and honestly documented.** The task34.9 report explicitly states that the harness
replicates the transaction shape rather than calling `authorizeSignEvent()` directly, because
the atomic method does not expose a synchronization hook. This is a methodological limitation,
not a defect in the harness.

---

## 7. Durable idempotency ordering analysis (critical)

### 7.1 Production code (repository.ts)

The production `authorizeSignEvent()` is **fully atomic**:

```
BEGIN IMMEDIATE
  SELECT payment row
  check state === 'created'
  check tx_hash IS NULL
  check digest match
  check no prior 'approved'
  INSERT INTO sign_events (approval or rejection)
COMMIT
```

There is **no separate idempotency store** in production. The `sign_events` table IS the
idempotency record. The durable gate (state + hash + prior approval) is the idempotency
mechanism.

**This means:** in production, there is no "crash between approval commit and idempotency
write" — they are the same commit. A crash after `authorizeSignEvent()` commits leaves both
the approval and the audit event durable. A retry hits the durable gate and returns
`authorization_already_recorded`.

### 7.2 TASK34.8 harness

The TASK34.8 harness uses a **separate** idempotency store (`idem.db`) with **separate**
transactions. The ordering was:

```
signer.authorize()  → commits approval + audit event in auth.db
crash(3, 'after inserting authorization event, before commit')  ← already committed
...
crash(4, 'after commit, before response')  ← idemPut has NOT run yet
idemPut(requestId, canonical, r)  ← after crash(4)
conn.write(response)
crash(5, 'during response transmission')
```

**Finding (Medium):** In the TASK34.8 harness, `idemPut` is called **after** `crash(4)`.
A crash at point 4 loses the idempotency record while the approval is durable. On restart,
`idemGet` returns `none`, and the retry re-derives → `authorization_already_recorded` (not
the original `approved` result). This is fail-safe but loses response correlation data.

This is a **harness-level** limitation, not a production one. The production code has no
separate idempotency store, so this crash window does not exist in production.

### 7.3 TASK34.9 harness

The TASK34.9 harness corrected the ordering:

```
db.exec('COMMIT')          ← authorization committed
idemPut(requestId, ...)    ← idempotency record persisted
crash(5, 'after COMMIT and idempotency record, before response')
conn.write(response)
```

Now both the approval and the idempotency record are durable before crash(5). The retry
recovers the original `approved` result.

But note: crash(4) in TASK34.9 is "after insert, before COMMIT" — which means crash(4) loses
BOTH the approval and the idempotency record (rollback). There is no crash point that loses
only the idempotency record.

### 7.4 Production implication

In production, the client cannot recover the original response metadata after a crash — only
the fact that authorization occurred (`authorization_already_recorded`). The client must treat
`authorization_already_recorded` as "approved" (the authorization happened, it just wasn't
reported). This is a client-side semantic that must be documented.

**Recommendation:** The production client should treat `authorization_already_recorded` as a
successful authorization (not a failure), because the durable gate already recorded an
`approved` event. The client cannot recover `decidedAt` or other metadata, but the
authorization itself is durable.

---

## 8. Cross-task consistency findings

### 8.1 Contradictory guarantees

| Claim | TASK34.8 report | TASK34.9 report | Actual | Verdict |
|---|---|---|---|---|
| "Crash after commit recovers the original approval" | Yes | Yes | Yes (if idemPut ran) | ✅ Consistent |
| "Crash before commit creates no durable approval" | Yes | Yes | Yes (rollback) | ✅ Consistent |
| Idempotency record survives crash(4) | Not stated | N/A (crash(4) is pre-commit) | No (idemPut after crash(4)) | ⚠️ TASK34.8 gap |
| Production idempotency is atomic | N/A | N/A | Yes (same transaction) | ✅ |

### 8.2 Test-only behavior mistaken for production behavior

**Finding (Informational):** The TASK34.8 and TASK34.9 reports describe idempotency behavior
that is specific to the harness's separate `idem.db` store. This behavior does not exist in
production, where the `sign_events` table is the sole idempotency record. The reports should
clearly distinguish harness-level idempotency from production-level idempotency.

The TASK34.9 report does state this distinction ("The production code's atomicity is actually
STRONGER than what the harness tests"), which is correct.

### 8.3 Authorization paths that bypass the owner process

**Finding (Medium):** The production `FacilitatorCore.settle()` does NOT call
`authorizeSignEvent()` (TASK34.5 finding, still open). The authorization boundary
(`narrowSponsor.ts` + `repository.authorizeSignEvent()`) is implemented but not wired into
the settle path. A real signer attached to `settle()` would bypass the durable-state gate.

This is documented in TASK34.3 (M1/M2) and TASK35 (prerequisite #2), but remains unfixed.

### 8.4 Public repository methods that permit raw approval insertion

**Fixed in TASK34.4.** `recordSignEvent()` was removed from the interface. The DB trigger
(`trg_sign_events_approved_requires_created`) prevents invalid-state inserts but does NOT
prevent valid-state inserts (TASK34.5 finding).

### 8.5 Database triggers that do not enforce claimed provenance

**Confirmed (TASK34.5).** The trigger checks `state='created' AND tx_hash IS NULL` but not
the authorization gate. A raw SQL writer can forge an approval for a valid created payment.
This is documented in TASK34.5 and TASK34.6.

### 8.6 Replay or request-ID bypasses

**No bypass found.** The durable gate (state + hash + prior approval) prevents duplicate
approvals regardless of request ID. The harness's idempotency store adds response correlation
but is not the security boundary.

### 8.7 Fail-open behavior during owner unavailability

**No fail-open found.** The harness returns `owner_unavailable` and the client must fail
closed. The production facilitator's `classifyCompatibility` reports `canSign` but does not
gate on it. The gateway's `DENY_ALL_FACILITATOR` default prevents settlement.

### 8.8 Discrepancy between documented deployment model and tested harness

**Finding (Low):** The TASK34.7 deployment model specifies separate systemd units with
`ProtectSystem=strict`, `NoNewPrivileges=true`, etc. The TASK34.8/34.9 harness runs as
`sudo -u authowner npx tsx` with no systemd hardening. The OS-level isolation is tested, but
the deployment hardening is not.

---

## 9. Severity-ranked findings

### Critical

None.

### High

None.

### Medium

1. **M1 — `FacilitatorCore.settle()` does not call the authorization boundary.**
   - Severity: Medium (latent — no production signer exists yet).
   - Location: `services/facilitator/src/core.ts` (settle method).
   - Impact: A real signer attached to `settle()` would bypass the durable-state gate.
   - Status: Documented (TASK34.3, TASK35). Not fixed.

2. **M2 — TASK34.4 DB trigger does not enforce provenance.**
   - Severity: Medium (latent — requires DB file access).
   - Location: `services/facilitator/src/repository.ts` (trigger `trg_sign_events_approved_requires_created`).
   - Impact: Raw SQL can forge an approval for a valid `created` payment.
   - Status: Documented (TASK34.5, TASK34.6). Requires architectural fix (separate signer process).

3. **M3 — Harness idempotency store is less atomic than production.**
   - Severity: Medium (harness-only; production is more atomic).
   - Location: `scripts/task348-owner.mts` (separate `idem.db`).
   - Impact: A crash at the right point can lose the idempotency record. In production, this
     window does not exist because the approval and audit event are in the same transaction.
   - Status: Documented in this review. The TASK34.8 report should clarify this.

### Low

4. **L1 — Test cleanup can leave orphan processes.**
   - Severity: Low.
   - Location: `test/task348-ipc-protocol.test.mts` (`stopOwner` uses `pgrep`).
   - Impact: A previous crashed run could leave an owner listening on a stale socket.
   - Status: Mitigated by socket unlink on startup, but not fully (a stale owner on a
     different socket path could interfere).

5. **L2 — TASK34.8 crash(3) is mislabeled.**
   - Severity: Low.
   - Location: `scripts/task348-owner.mts` (crash point 3 comment).
   - Impact: The label "after inserting authorization event, before commit" is inaccurate
     because `signer.authorize()` already commits. TASK34.9 corrected this.
   - Status: Fixed in TASK34.9.

6. **L3 — Production client idempotency semantics undocumented.**
   - Severity: Low (documentation gap).
   - Location: No production client code exists yet.
   - Impact: When a production client is implemented, it must treat
     `authorization_already_recorded` as "approved" (not a failure).
   - Status: Documented in this review (§7.4).

### Informational

7. **I1 — Harness uses a separate idempotency store that does not exist in production.**
   - The harness's `idem.db` is test-only. Production idempotency is the durable gate.

8. **I2 — TASK34.9 replicates rather than directly tests the production method.**
   - Documented honestly in the TASK34.9 report. Not a defect.

9. **I3 — The `task348-peercred` C helper is a test-only artifact.**
   - It is not production code. Production would use `SO_PEERCRED` via a native binding or
     a dedicated signer process.

---

## 10. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED

- `SO_PEERCRED` peer authentication is real (C helper, kernel-reported UID).
- Unauthorized UID (995, in `authclients` group) is rejected before authorization.
- Root (UID 0) is rejected per documented policy.
- Caller-supplied `decision` field is rejected.
- Strict validation: unknown fields, malformed energy, oversized frames, invalid UTF-8.
- Durable idempotency survives clean restart (idem.db on disk, WAL + synchronous=FULL).
- Crash before commit: no durable approval (TASK34.9, 5 points).
- Crash after commit: exactly one durable approval (TASK34.9, point 5).
- Concurrent authorization: exactly one approval (TASK34.6 and TASK34.9).
- Outcome classification: 5 distinct outcomes, distinct from `settlement_pending`.
- Symlink socket path refused.
- Stale socket recovery.
- Full suite: 1735/1735 across 38 suites; both typechecks clean.
- Production `authorizeSignEvent` is fully atomic (BEGIN...COMMIT, no separate idempotency store).

### NOT TESTED

- `SO_PEERCRED` under non-Linux platforms.
- Rate limiting (design only).
- Idempotency retention / TTL (design only).
- Backup/restore procedures (design only).
- systemd hardening (design only).
- Multiple simultaneous owner processes sharing one DB.
- The production `authorizeSignEvent` method under actual SIGKILL (requires a production hook).
- The production client's treatment of `authorization_already_recorded` as "approved"
  (no production client exists yet).

### BLOCKED

- Absolute isolation against root or same-UID processes — impossible with filesystem
  permissions alone. Requires container/hypervisor boundary.
- Full provenance enforcement at the SQLite layer — SQLite cannot distinguish writers.
  Requires architectural change (separate signer process).

---

## 11. Merge/acceptance recommendation

**PASS WITH CONDITIONS.**

The IPC contract, durable idempotency, process authentication, and crash-recovery guarantees are
substantially supported by both the documented specification and the executable evidence. The
core security boundary is sound for a different-UID deployment.

**Conditions for acceptance:**

1. **Wire the authorization boundary into `settle()`** (TASK34.5 prerequisite #2). The
   boundary exists but is not on the production settle path.
2. **Document the production client's treatment of `authorization_already_recorded`** as
   "approved" (not a failure). This is a client-side semantic that must be specified before
   a production client is implemented.
3. **Clarify the TASK34.8 report** to distinguish harness-level idempotency (separate `idem.db`)
   from production-level idempotency (the durable gate). The TASK34.9 report already does this.
4. **Address the TASK34.4 DB trigger provenance gap** (TASK34.5 finding) via the
   architectural alternative (separate signer process or filesystem access control) before
   production use.

No production code changes are required for this review. The working tree remains uncommitted.

---

## 12. Constraints honoured

Review only · no implementation fixes · no production source, test, or schema changes · no
production database contents modified · no real signer or facilitator settlement · no private
key access, generation, import, export, or signing · no transaction construction, submission,
or broadcast · no faucet or Mainnet · token 1004 and its Agent Card untouched ·
`DENY_ALL_FACILITATOR` intact · no production IPC activation · no commit or push ·
TASK35/TASK36 not started · host UID and group configuration preserved · no existing test
users or groups deleted.