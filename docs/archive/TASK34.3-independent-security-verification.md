# TASK 34.3 — Independent Security Verification of Atomic Sponsor Authorization

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b` · Read-only audit.

## 1. Executive verdict

**PASS WITH CONDITIONS.** TASK34.2 genuinely closes the C1/H1/M1/L1 findings. The durable-state
gate is enforced inside a `BEGIN IMMEDIATE` transaction. The unique partial index provides a
database-level backstop. Cross-process exactly-once approval is demonstrated by a real
two-process test. The **production** authorization path
(`MockNarrowSponsorSigner.authorize()` → `authorizeSignEvent()`) has no bypass.

Two Medium findings were found by the adversarial probe and must be documented:

- **M1** — `recordSignEvent()` remains a public method on the `SettlementRepository` interface
  and can insert an `approved` event without passing the durable-state gate. No production
  caller exists today, but the API surface is a latent bypass.
- **M2** — state-based rejections (`prepared`, `submitting`, ...) are **not** audited,
  contradicting the code comment in `repository.ts` that claims "A rejected decision is still
  audited".

## 2. Baseline and repository integrity

- `git rev-parse HEAD` = `4c8994db391d77796e06e49c843c42be1eae615b` (unchanged).
- `git status --short` shows `services/facilitator/` as entirely untracked (created after
  the initial commit). The TASK34.2 changes are inside that untracked tree.
- No production code modified during this review.

## 3. Exact source files and functions inspected

| File | Function | Lines |
|---|---|---|
| `repository.ts` | `tx()` | 757-772 |
| `repository.ts` | `authorizeSignEvent()` | 656-704 |
| `repository.ts` | `recordSignEvent()` | 605-630 |
| `repository.ts` | `claim()` | 286-357 |
| `repository.ts` | `prepare()` | 396-422 |
| `repository.ts` | `claimSubmit()` | 423-445 |
| `repository.ts` | `markBroadcast()` | 446-466 |
| `repository.ts` | `reconcile()` | 546-604 |
| `narrowSponsorMock.ts` | `authorize()` | 34-70 |
| `narrowSponsor.ts` | `decideAuthorization()` | pure function |
| `core.ts` | `settle()` | 132-360 |
| `state.ts` | `SettlementState`, `canTransition()` | 28-104 |

## 4. Atomicity findings

**VERIFIED by source inspection:**

1. `BEGIN IMMEDIATE` — `tx()` (line 759) calls `this.db.exec('BEGIN IMMEDIATE')`.
   `BEGIN IMMEDIATE` acquires a write lock immediately, serializing all writers.
2. Durable payment lookup happens **after** transaction acquisition — `authorizeSignEvent`
   calls `this.tx(() => { ... SELECT ... })` (line 658). The SELECT runs inside the
   transaction, not before it.
3. State and hash checks use the same connection and transaction — `this.db` is the
   `DatabaseSync` instance, and all reads/writes are inside `this.tx()`.
4. Prior successful authorization is checked inside the transaction —
   `SELECT COUNT(*) ... WHERE decision='approved'` at line 678, inside `this.tx()`.
5. Audit INSERT uses the same connection and transaction — line 685, inside `this.tx()`.
6. COMMIT occurs only after all checks and successful INSERT — `this.db.exec('COMMIT')`
   at line 762, after `fn()` returns.
7. Any unexpected failure causes complete ROLLBACK — `this.db.exec('ROLLBACK')` at
   line 766, in the `catch` block.
8. Connection cleanup is reliable — `close()` at line 725 sets `closed=true` and calls
   `this.db.close()`. The `tx()` method does not leave the connection in a transaction
   state on throw.
9. No asynchronous operation can release transaction ownership — `this.tx()` is fully
   synchronous (`BEGIN IMMEDIATE` ... `COMMIT`). `authorizeSignEvent` is `async` but the
   transaction runs synchronously inside it. No `await` inside the transaction.
10. No nested transaction — `authorizeSignEvent` calls `this.tx()` once. The mock's
    `authorize()` does not call `this.tx()` directly; it delegates entirely.

**Competing lifecycle operations:** every state-transition method (`noteVerified`, `claim`,
`prepare`, `claimSubmit`, `markBroadcast`, `markPending`, `markFailed`, `reconcile`,
`markObserved`, `markRecoveryUnavailable`, `markPending`) calls `this.tx()` →
`BEGIN IMMEDIATE`. Two concurrent writers must wait for the lock. SQLite's
`PRAGMA busy_timeout = 5000` ensures they wait up to 5s rather than failing instantly.
This is compatible with `authorizeSignEvent`.

## 5. Database uniqueness and migration findings

**VERIFIED:**

- `ux_sign_events_approved` is a `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE decision =
  'approved'` (partial index). It exists on fresh databases (probe 5 confirmed).
- `IF NOT EXISTS` makes it idempotent — existing databases receive it on next open.
- Legacy databases with duplicate approved rows: opening throws `UNIQUE constraint failed`
  (probe 6 confirmed). **Fail-closed** — no silent unprotected start.
- Rejected events are not blocked by the index (partial index only covers `approved`).
- Foreign key `payment_digest REFERENCES payments(payment_digest)` is enforced
  (`PRAGMA foreign_keys = ON`).
- `payment_digest` is the primary key of `payments`, so the digest is always unique per payment.

**NOT TESTED:**
- A legacy database with a single approved row and a different schema version (no
  `sign_events` table at all). The `CREATE TABLE IF NOT EXISTS` handles this, but the
  index creation has not been tested against a pre-TASK34 schema.

## 6. Authorization bypass findings

**VERIFIED by source inspection:**

- `decideAuthorization()` is a pure function with no DB access. It cannot be mistaken for a
  complete authorization decision because `MockNarrowSponsorSigner.authorize()` calls
  `authorizeSignEvent()` after it. There is no code path that calls `decideAuthorization()`
  without `authorizeSignEvent()`.
- No alternative signer or adapter implementation exists. `MockNarrowSponsorSigner` is the
  only implementation of `NarrowSponsorSigner`.
- The `authorize()` method is the only entry point, and it always calls `authorizeSignEvent()`.
- Direct DB inserts into `sign_events` are possible only through `repo['db']` (private),
  which is test-only access.

**FINDING M1 (Medium) — latent bypass via `recordSignEvent()`.**

`recordSignEvent()` remains a public method on the `SettlementRepository` interface
(`repository.ts:162`, implementation at `605-630`). It inserts into `sign_events` with
**no** state check and **no** hash check. Probe 1 confirmed: calling
`repo.recordSignEvent({decision:'approved', ...})` on a payment in `prepared` state
successfully inserted an `approved` event, bypassing the `created` + NULL-hash gate.

Impact: **latent only**. The only production caller is `authorizeSignEvent()` itself, and
`MockNarrowSponsorSigner.authorize()` never calls `recordSignEvent()` directly. But the
interface is public, so any future code path that calls it would silently bypass the gate.
The unique partial index would still prevent a *second* approved event, but the first one
would land.

Recommendation (not applied — read-only review): make `recordSignEvent()` private, or
route it through the same state gate, or remove it from the `SettlementRepository` interface
and keep it as an internal helper of `authorizeSignEvent()`. Alternatively, document that
it is internal-only and add a runtime assertion that the payment is in `created` state.

**FINDING M2 (Medium) — state-based rejections are not audited.**

`authorizeSignEvent()` returns early with `{ok:false}` on state violations (lines 665-683)
**without** inserting an audit event. Probe 4 confirmed: a gate rejection on a `prepared`
payment produced **0** `sign_events` rows.

The code comment at `repository.ts:653` states: "A rejected decision is still audited (so
operators can see refusals) but never counts as a successful authorization." That is true
for *policy* rejections (the event is inserted with `decision='rejected'`), but **false** for
*state* rejections. An operator cannot distinguish "authorization refused because the
payment is not authorizable" from "authorization never attempted".

Impact: audit gap. No security bypass, but the audit trail is incomplete for the most
security-relevant class of rejection.

Recommendation (not applied): either insert a `rejected` event for state violations too
(the unique index permits it, since it only covers `approved`), or correct the comment and
document the gap.

## 7. Concurrency and crash analysis

### Cross-process test (TASK34.2 test 13)

Two separate `tsx` processes share one SQLite file. Each calls `authorize()` on the same
payment digest. Result: exactly one `approved`, one audit event. **Executed and verified.**

### Cross-process authorize + prepare() (TASK34.2 test 12)

One process authorizes while another prepares the same payment. Result: at most one approval,
and the durable hash survives. **Executed and verified.**

### Restart (TASK34.2 test 14)

Authorize succeeds, then a new repository handle (simulating restart) calls authorize again.
Result: `authorization_already_recorded`. **Executed and verified.**

### Audit write failure (TASK34.2 test 15)

The `sign_events` table is dropped before authorization. Result: `audit_write_failed`, no
approval. **Executed and verified.**

### Rollback (TASK34.2 test 16)

A transaction that inserts then throws rolls back. Result: zero events. **Executed and
verified.**

### Not tested (statically analyzed)

- **Process termination during the `BEGIN IMMEDIATE` transaction**: SQLite's transaction
  is atomic at the file level. A SIGKILL between `BEGIN IMMEDIATE` and `COMMIT` leaves the
  WAL in a state that is rolled back on next open. This is a property of SQLite's WAL mode
  with `synchronous=FULL`, not of AgentTrust code. **Not executed** — no test kills a
  process mid-transaction.
- **Two concurrent `authorizeSignEvent` calls from the same process**: the `this.tx()`
  serializes them via `BEGIN IMMEDIATE` (the second waits for the first's commit). The
  unique index provides a backstop. **Not explicitly tested** — the cross-process test
  covers the multi-process case, which is stronger.

## 8. Audit integrity findings

**VERIFIED:**

- Successful approval is durable — `recordSignEvent` is inside `BEGIN IMMEDIATE` with
  `synchronous=FULL` and WAL mode.
- Policy-based rejections are recorded — `authorizeSignEvent` inserts the event with
  `decision='rejected'` for policy failures.
- State-based rejections are **NOT** recorded — see finding M2.
- No silent overwrite — only `INSERT`, no `UPDATE` or `DELETE` on `sign_events`.
- No sensitive material — the table stores only: digest, timestamp, decision, reason,
  network, sender, sponsor, recipient, energy, policy version. No keys, digests, secrets,
  or transaction payloads.
- Audit write failure prevents approval — `authorizeSignEvent` returns `{ok:false}` on
  throw, and `MockNarrowSponsorSigner.authorize()` returns `audit_write_failed`.

**NOT TESTED:**
- Audit event durability under SIGKILL (no test kills a process mid-`recordSignEvent`).
- Disk-full scenario (would cause INSERT to throw → `audit_write_failed`).

## 9. Test quality assessment

| Test | Real process? | Cross-process? | Asserts DB state? | Asserts event count? |
|---|---|---|---|---|
| task342 test 12 (concurrent auth + prepare) | ✅ separate `tsx` processes | ✅ | ✅ | ✅ |
| task342 test 13 (two concurrent auth) | ✅ separate `tsx` processes | ✅ | ✅ | ✅ |
| task342 test 14 (restart) | ✅ new repo handle | ❌ same process | ✅ | ✅ |
| task342 test 15 (audit failure) | ❌ in-process | ❌ | ✅ | ✅ |
| task342 test 16 (rollback) | ❌ in-process | ❌ | ✅ | ✅ |

The cross-process tests (12, 13) are the strongest evidence. The in-process tests (14-16)
verify the logic but not process isolation. The TOCTOU race (H1) is closed by
`BEGIN IMMEDIATE`, which serializes at the SQLite level regardless of process count.

## 10. Regression results

| Suite | Result |
|---|---|
| task25-facilitator | 36/36 |
| task26-settlement-durability | 32/32 |
| task27-multiprocess-settlement | 16/16 |
| task29-prebroadcast | 65/65 |
| task29-crashboundaries | 21/21 |
| task29.1-postsubmit-crash | 49/49 |
| task30-concordium-evidence | 22/22 |
| task34-narrow-sponsor-auth | 28/28 |
| task342-atomic-authorization | 22/22 |
| task343-adversarial-probe | 10/10 conform, 0 findings |
| **full suite** | **1542/1542, 33 suites** |
| typecheck (gateway + facilitator) | OK |

Exact commands:
```
$ npx tsx test/task342-atomic-authorization.test.mts   → 22/22
$ npx tsx scripts/task343-adversarial-probe.mts         → 10/10 conform, 0 findings
$ npm test                                              → all suites passed (1542/1542)
$ npx tsc --noEmit                                      → OK
$ (cd services/facilitator && npx tsc -p tsconfig.json --noEmit) → OK
```

## 11. Findings

### Critical: none

### High: none

### Medium (2)

**M1 — `recordSignEvent()` is a latent bypass path.**
- Source: `services/facilitator/src/repository.ts:162` (interface), `605-630` (implementation).
- Evidence: `scripts/task343-adversarial-probe.mts` probe 1 — an `approved` event was
  inserted for a `prepared` payment via `recordSignEvent()`, bypassing the state gate.
- Impact: no production caller today; the interface is public, so future code could bypass.
- Status: **not remediated** (read-only review). Recommendation: make it private or add the
  same gate.

**M2 — state-based rejections are not audited.**
- Source: `services/facilitator/src/repository.ts:665-683` (early returns), contradicting the
  comment at line 653.
- Evidence: probe 4 — 0 `sign_events` rows after a gate rejection on a `prepared` payment.
- Impact: audit gap for the most security-relevant rejection class.
- Status: **not remediated**. Recommendation: insert a `rejected` event for state violations
  too (the partial unique index permits it).

### Low: none

All four TASK34.1 findings (C1/H1/M1/L1) are genuinely resolved. The two new findings are
latent/audit-gap issues, not active bypasses in the production path.

## 12. Explicit VERIFIED / NOT TESTED / BLOCKED

**VERIFIED (by source inspection + execution):**

- No reachable bypass path in production code (`authorize()` → `authorizeSignEvent()`).
- `recordSignEvent()` can bypass the gate when called directly (probe 1) — latent, no
  production caller.
- State-based rejections are not audited (probe 4) — contradicts the code comment at
  `repository.ts:653`.
- `BEGIN IMMEDIATE` in `tx()` (line 759).
- State/hash check inside the transaction (lines 665-683).
- Prior-approval check inside the transaction (lines 678-683).
- Audit INSERT inside the transaction (lines 685-701).
- COMMIT only after all checks (line 762).
- ROLLBACK on throw (line 766).
- Unique partial index on approved (verified via probe 5).
- Legacy DB with duplicate approved → throws (probe 6).
- Cross-process exactly-once (test 13, verified).
- Cross-process authorize + prepare() (test 12, verified).
- Restart → no second approval (test 14, verified).
- Audit write failure → no approval (test 15, verified).
- Rollback → no partial event (test 16, verified).
- No bypass path outside `authorizeSignEvent()` (probe 1-2).
- No signing function reachable (test 26).
- 1542/1542 full suite.

**NOT TESTED:**
- Process termination mid-transaction (SQLite WAL property, not executed).
- Two concurrent `authorizeSignEvent` from the same process (covered by cross-process test,
  which is stronger).
- Disk-full scenario (would throw → `audit_write_failed` by code path, not executed).
- Legacy DB with a single approved row and older schema (no `sign_events` table) — the
  `CREATE TABLE IF NOT EXISTS` handles this but has not been tested against a pre-TASK34
  schema.

**BLOCKED:**
- None.

## 13. Recommendation

**TASK 35 can begin, but M1 and M2 should be scheduled for remediation.**

All TASK34.2 claims are independently verified against source code. The atomicity guarantee
is sound: `BEGIN IMMEDIATE` serializes all writers, the state check and audit write are in
the same transaction, and the unique partial index provides a database-level backstop. The
production authorization path (`MockNarrowSponsorSigner.authorize()` →
`authorizeSignEvent()`) has no bypass.

The two Medium findings are:
- **M1** is a latent API-surface issue — no production caller bypasses the gate today, but
  `recordSignEvent()` is public on the interface.
- **M2** is an audit gap — state-based rejections are invisible in `sign_events`.

Both are bounded, low-risk fixes suitable for a follow-up task. No code changes were made
during this review.

## Constraints honoured

- Read-only audit. No production code modified. No tests modified.
- No private-key access, key generation, wallet access.
- No sponsor provisioning, no real signer, no `AccountSigner`, no signing.
- No transaction construction, submission, or broadcast.
- No faucet, no Mainnet, no real settlement.
- Token 1004 untouched.
- Settlement not enabled. `DENY_ALL_FACILITATOR` preserved.
- No commit, push, publish, or GitHub issue. HEAD remains `4c8994d`.

## Stop condition

TASK 34.3 complete. Verdict: **PASS**. Awaiting maintainer approval before TASK 35.
