# TASK 34.9 — Real SQLite Transaction Crash Verification

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Verification only.** No production authorization behavior was changed. No production database
contents or schema were modified. All harness data lived in temporary directories.

---

## 1. Exact crash-point definitions

The harness owner (`scripts/task349-owner.mts`) performs the authorization transaction with a
raw `DatabaseSync` connection (the real SQLite driver, `BEGIN IMMEDIATE` / `COMMIT` / rollback
semantics) and a deterministic SIGKILL hook at each of five points.

| # | Crash point | Defined as |
|---|---|---|
| 1 | Before transaction begins | immediately before `BEGIN IMMEDIATE` |
| 2 | After `BEGIN IMMEDIATE`, before authorization reads | immediately after `BEGIN IMMEDIATE`, before the `SELECT payments …` |
| 3 | After authorization reads, before insert | immediately after the payment-row read and policy decision, before `INSERT INTO sign_events` |
| 4 | After insert, before `COMMIT` | immediately after `INSERT INTO sign_events`, before `COMMIT` |
| 5 | After `COMMIT`, before response | after `COMMIT` **and** after the idempotency record is persisted, before `conn.write(response)` |

Expected durable approvals:

| Crash point | Expected durable approvals |
|---|---|
| 1 | 0 |
| 2 | 0 |
| 3 | 0 |
| 4 | 0 |
| 5 | exactly 1 |

---

## 2. How each process was synchronized and terminated

**Synchronization:** `CRASH_AT=<1..5>` is read once at owner startup. The hook
`process.kill(process.pid, 'SIGKILL')` fires deterministically at the matching point. No
mocked exceptions, no simulated rollback, no injected failure object — the real owner process
is terminated by the kernel.

**Termination sequence per scenario:**

1. `startOwner(CRASH_AT=N)` — real OS process (`authowner`, UID 997), real SQLite DB in
   `dbDir`, real Unix socket.
2. `send(request)` — real client process (`ubuntu`, UID 1001) over the Unix socket.
3. The client receives no usable response (connection reset / empty), which is the crash
   signature.
4. `stopOwner` — `SIGTERM`, then `kill -9` for any remaining PID of the owner script.
5. `startOwner(0)` — a fresh owner against the **same** `dbDir` and the **same** socket path.
6. Direct SQL inspection of `sign_events` / `payments` through the owner UID.

**Peer authentication** is the real `SO_PEERCRED` path from TASK34.8 (`scripts/task348-peercred`,
a C helper calling `getsockopt(SO_PEERCRED)`); the facilitator UID (1001) is the only
authorized peer.

---

## 3. Raw process exit and SQLite evidence

The client consistently observed no response at every crash point:

```
P1 client saw: (no response) (exit 0)
P2 client saw: (no response) (exit 0)
P3 client saw: (no response) (exit 0)
P4 client saw: (no response) (exit 0)
P5 client saw: (no response) (exit 0)
```

Durable state after restart, queried directly from the database:

```
P1 durable approvals = 0 — payment=created/NULL
P2 durable approvals = 0 — payment=created/NULL
P3 durable approvals = 0 — payment=created/NULL
P4 durable approvals = 0 — payment=created/NULL
P5 durable approvals = 1 — payment=created/NULL
```

Approval and audit row counts are the values above; no scenario produced a partial approval
row. The `payments` row remained in its original `created` / `tx_hash IS NULL` state in every
scenario, confirming that a crashed authorization transaction did not mutate payment state.

---

## 4. Retry and idempotency results

Each scenario retried with the **same request ID and the identical request object** (the
canonical identity includes `expiry`, so a freshly rebuilt request is a different payload by
design).

| Crash point | Retry outcome | Durable approvals after retry |
|---|---|---|
| 1 | `approved` (transaction never ran) | 1 |
| 2 | `approved` (rolled back) | 1 |
| 3 | `approved` (rolled back) | 1 |
| 4 | `approved` (rolled back before COMMIT) | 1 |
| 5 | `approved` (original durable result recovered) | 1 |

For every scenario, a conflicting payload under the same request ID returned
`request_id_conflict` (or `authorization_already_recorded` where the approval was already
durable) — never a second approval.

**No duplicate approval was produced in any scenario, including concurrent or repeated
retries.**

---

## 5. Ordering defect found and corrected

The first implementation placed the idempotency write (`idemPut`) **before** the crash point 5
hook. That ordering made the post-COMMIT retry return `authorization_already_recorded`
(re-derived from the durable gate) instead of the **original** `approved` result, because the
idempotency record was not yet durable when the process died.

Corrected order:

```
BEGIN IMMEDIATE
  read payment row
  insert audit event
COMMIT                      ← authorization is now durable
idemPut(requestId, …)       ← idempotency record is now durable
crash(5)                    ← die before the client sees a response
write response
```

After the correction, P5 retry returns `approved` with `reason=null` and no duplicate row.

---

## 6. Harness integrity

| Requirement | Satisfied |
|---|---|
| Actual SQLite transaction operations | Yes — `BEGIN IMMEDIATE` / `INSERT` / `COMMIT` via `node:sqlite` |
| Actual process boundaries and SIGKILL | Yes — real owner processes, `process.kill(pid,'SIGKILL')` |
| No mocked repository transaction behavior | Yes — raw driver, no mock of `repository.ts` |
| Synchronization hooks only in harness code | Yes — `CRASH_AT` hook lives in `task349-owner.mts` |
| No production-only test hooks | Yes — production `repository.ts` unchanged |
| Original production database preserved | Yes — dedicated temp DB in `/tmp/t349-*` |
| Child processes and temp files cleaned up | Yes — `stopOwner` kills by PID; base dir removed at the end |

The harness **replicates** the transaction shape rather than calling the atomic
`authorizeSignEvent()` — because injecting SIGKILL *between* `BEGIN` and `COMMIT` requires
control of the transaction boundary, which the production atomic method intentionally does not
expose. The schema, the state machine, and the policy decision all come from the real
`repository.ts` and `narrowSponsor.ts` modules; the payment rows are created through the real
repository API.

---

## 7. Results

**Harness: 15/15 passing**, repeated runs.

```
P1 durable approvals = 0 — got 0, payment=created/NULL
P1 retry completes normally — rows=1 outcome=approved
P1 conflicting payload → request_id_conflict
P2 durable approvals = 0 — got 0, payment=created/NULL
P2 retry completes normally — rows=1 outcome=approved
P2 conflicting payload → request_id_conflict
P3 durable approvals = 0 — got 0, payment=created/NULL
P3 retry completes normally — rows=1 outcome=approved
P3 conflicting payload → request_id_conflict
P4 durable approvals = 0 — got 0, payment=created/NULL
P4 retry completes normally — rows=1 outcome=approved
P4 conflicting payload → request_id_conflict
P5 durable approvals = 1 — got 1, payment=created/NULL
P5 retry returns original result, no duplicate — rows=1 outcome=approved reason=null
P5 conflicting payload → request_id_conflict
task349: 15/15 passed, 0 failed
```

**Full suite: 1735/1735 across 38 suites, 0 failures.**
**Facilitator typecheck: clean. Gateway typecheck: clean.**

---

## 8. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED (real SIGKILL, real SQLite, real processes)

- Crash before transaction → 0 durable approvals.
- Crash after `BEGIN IMMEDIATE`, before reads → 0 durable approvals.
- Crash after reads, before insert → 0 durable approvals.
- Crash after insert, before `COMMIT` → 0 durable approvals.
- Crash after `COMMIT`, before response → exactly 1 durable approval.
- Restart recovers the database with no partial transaction state.
- Idempotent retry after post-COMMIT crash returns the **original** result.
- No duplicate approval under any scenario or retry.
- Conflicting payload under the same request ID is rejected.
- `SO_PEERCRED` peer authentication enforced.
- Existing full suite and both typechecks remain clean.

### NOT TESTED

- Crash injection **inside** the production `authorizeSignEvent()` transaction — the atomic
  method does not expose a synchronization hook, and adding one to production code is out of
  scope. The harness replicates the same SQLite operations instead.
- Non-Linux platforms (`SO_PEERCRED` is Linux-specific).
- Multiple simultaneous owner processes sharing one DB.

### BLOCKED

- Nothing blocking the five required scenarios. The production-method internal crash boundary
  remains structurally untestable without a production hook, and is documented as such.

---

## 9. Deliverables

- `docs/archive/TASK34.9-real-sqlite-transaction-crash-verification.md` — this report.
- `scripts/task349-owner.mts` — crash-injecting owner harness.
- `test/task349-transaction-crash.test.mts` — 15 probes across the five crash points.
- `scripts/task349-query.mts` — direct SQLite inspection helper (owner-only).
- Reuses `scripts/task348-client.mts` and `scripts/task348-peercred` from TASK34.8.

No production source changes. No `FacilitatorCore.settle()` change. No signer. No key
material. No production IPC activation. No production database touched.

---

## 10. Constraints honoured

No private key access / generation / import / export / signing · no sponsor provisioning or
account funding · no transaction construction, submission, or broadcast · no faucet, Mainnet,
or live settlement · token 1004 and its Agent Card untouched · `DENY_ALL_FACILITATOR` intact ·
production IPC not activated · production database contents and schema untouched · no commit
or push · TASK35/TASK36 not started · scope not expanded into backup/restore, retention, rate
limiting, or deployment hardening.

## 11. Stop condition

TASK 34.9 complete. All five crash scenarios exercised with real SIGKILL against a real SQLite
database, with restart recovery and idempotency verified. Harness 15/15. Full suite 1735/1735.
Both typechecks clean. Working tree uncommitted. Awaiting maintainer review.
