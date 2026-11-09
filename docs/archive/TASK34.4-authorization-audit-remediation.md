# TASK 34.4 — Authorization Audit Boundary Remediation

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`
**Read-only study of M1/M2; implementation limited to the audit boundary only.**

## 1. Updated verdict for M1 and M2

| Finding | TASK34.3 verdict | TASK34.4 verdict |
|---|---|---|
| M1 — `recordSignEvent()` approval bypass | Medium, latent | **CLOSED** — no public path can insert `approved`; DB-level trigger enforces it for every writer, including raw SQL |
| M2 — state-based rejections unaudited | Medium, forensic gap | **CLOSED** — every durable-state rejection is recorded as a `rejected` event in the same transaction; missing payments are audited in a separate table without inventing a payment row |

Neither finding was silently fixed. Both were reproduced by an executed probe before remediation and re-verified after.

---

## 2. Original findings and root causes

### M1 — root cause

`recordSignEvent()` was a public method on `SettlementRepository` (`repository.ts:156` interface,
`609-629` implementation) that performed a bare `INSERT INTO sign_events` with whatever
`decision` the caller supplied — including `'approved'`. The atomic gate (`authorizeSignEvent`)
was a *separate* method; nothing prevented a caller from skipping it. TypeScript visibility was
the only protection, and at runtime `(repo as any).recordSignEvent(...)` worked.

### M2 — root cause

`authorizeSignEvent()` returned early on `unknown_payment`, `payment_digest_mismatch`,
`transaction_hash_already_prepared`, `payment_not_authorizable`, and
`authorization_already_recorded` *without* inserting any row. The code comment at
`repository.ts:653` claimed rejections were audited, but that was only true for policy
rejections (the `insert` ran after the gate passed, with `input.decision`).

---

## 3. Exact source changes

### Changed

- `services/facilitator/src/repository.ts`
  - Removed `recordSignEvent` from the `SettlementRepository` interface.
  - Removed the public `recordSignEvent` implementation.
  - Added `SignAttemptRow` interface + `signAttempts(paymentDigest)` read method.
  - Added `sign_attempts` table to `SCHEMA` (no foreign key — see §5).
  - Added `trg_sign_events_approved_requires_created` trigger to `SCHEMA`.
  - Rewrote `authorizeSignEvent`: every early return now inserts a `rejected` event
    (into `sign_events` for known payments, into `sign_attempts` for missing ones).
  - Added three private helpers: `insertSignEvent`, `insertRejectedSignEvent`,
    `insertSignAttempt` (all called only from inside `authorizeSignEvent`'s transaction).

### Added

- `test/task344-authorization-audit-remediation.test.mts` — 23 adversarial tests (§7).
- `docs/archive/TASK34.4-authorization-audit-remediation.md` — this report.

### Modified (test assertion alignment, not weakening)

- `test/task34-narrow-sponsor-auth.test.mts` (test 24) — the concurrent-authorization test now
  asserts 1 approved + 1 rejected event (2 total) instead of 1 total. This is a *consequence*
  of M2 being fixed: the losing attempt is now audited. The assertion is stricter (exact
  decision counts and reason), not looser.

### Not modified

- `FacilitatorCore.settle()` — untouched, per the non-negotiable constraint.
- No new authorization behaviour wired into settlement.
- No key material, no signer, no account, no network, no settlement.

---

## 4. Public repository API — before / after

**Before (TASK34.2):**

```
SettlementRepository:
  recordSignEvent(input: SignEventInput): void;            ← raw INSERT, any decision
  authorizeSignEvent(input): AuthorizeSignResult;          ← atomic gate, returns ok/reason
  signEvents(digest): SignEventRow[];                      ← read
```

**After (TASK34.4):**

```
SettlementRepository:
  signAttempts(digest): SignAttemptRow[];                  ← read (missing-payment attempts)
  authorizeSignEvent(input): AuthorizeSignResult;          ← ONLY approval-producing boundary
  signEvents(digest): SignEventRow[];                      ← read
```

No method on the interface can insert `decision = 'approved'`. `authorizeSignEvent` is the
single approval-producing boundary, and it only inserts `approved` after passing the
durable-state gate (state `created`, `tx_hash IS NULL`, no prior approval, digest match).

---

## 5. Audit schema and migration design

### Schema additions

```sql
-- TASK 34.4: attempts whose payment row does not exist.
-- No foreign key: a missing payment is auditable without inventing a payments row.
CREATE TABLE IF NOT EXISTS sign_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_digest   TEXT NOT NULL,
  decided_at       INTEGER NOT NULL,
  decision         TEXT NOT NULL CHECK (decision = 'rejected'),
  reason           TEXT NOT NULL,
  network          TEXT NOT NULL,
  sender           TEXT NOT NULL,
  sponsor          TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  energy           TEXT NOT NULL,
  policy_version   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sign_attempts_payment ON sign_attempts(payment_digest, id);

-- TASK 34.4 (M1): runtime enforcement, not TypeScript visibility.
CREATE TRIGGER IF NOT EXISTS trg_sign_events_approved_requires_created
BEFORE INSERT ON sign_events
WHEN NEW.decision = 'approved'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM payments p
      WHERE p.payment_digest = NEW.payment_digest
        AND p.state = 'created'
        AND p.tx_hash IS NULL
    )
    THEN RAISE(ABORT, 'approved sign event requires a created payment with NULL tx_hash')
  END;
END;
```

### Why a separate table

`sign_events` has `FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)`. Inserting
an event for a missing payment would either violate referential integrity or require
inventing a fake `payments` row. The task explicitly forbids both. A separate table with no FK
preserves `sign_events`'s integrity while still recording the attempt verbatim (the absence of
a matching row is itself the recorded fact).

### Migration

- `CREATE TABLE IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` are idempotent. Existing
  databases receive the new table and trigger on next open — **no data migration**.
- The trigger only constrains future `INSERT`s. Existing approved rows are untouched.
- Legacy databases that contain **two** approved rows for one payment fail closed at
  construction time (`UNIQUE constraint failed`), exactly as in TASK34.2 — no silent start
  without the guard.

### Audit integrity preserved

- Append-only: INSERT only, no UPDATE/DELETE path.
- Approved-event uniqueness: partial unique index (unchanged) + new trigger.
- Rejected events do not block a valid retry: unique index applies only to `approved`.
- No secrets: the same column set as before (no key, no digest, no full payload).
- Audit persistence failure → transaction rollback → no approval returned.

---

## 6. Missing-payment audit strategy

1. `authorizeSignEvent` reads the `payments` row inside the `BEGIN IMMEDIATE` transaction.
2. If no row exists, it calls `insertSignAttempt(input, t, 'unknown_payment')` — writing to
   `sign_attempts`, which has no FK.
3. The insert is inside the same transaction. If it throws, the transaction rolls back and
   the method throws (audit-write-failed semantics).
4. The caller (`MockNarrowSponsorSigner`) catches the throw and returns
   `{approved: false, reason: 'audit_write_failed'}`.
5. No `payments` row is ever created for a missing digest.

---

## 7. Atomic transaction behaviour

Every authorization attempt, success or failure:

1. `BEGIN IMMEDIATE` (acquires the write lock; concurrent `prepare()` waits).
2. Read the durable payment row.
3. Evaluate: state, hash, digest (PK), prior approval.
4. Evaluate policy (already decided by the pure function before the call).
5. Insert exactly one audit event (`sign_events` or `sign_attempts`).
6. `COMMIT`.
7. On any throw → `ROLLBACK` → rethrow.

No `await` inside the transaction. No nested transaction. No in-memory mutex. Cross-process
locking is provided by SQLite's `BEGIN IMMEDIATE`, exactly as in TASK34.2.

---

## 8. Adversarial test matrix (23 tests)

| # | Scenario | Assertion |
|---|---|---|
| M1.1 | `recordSignEvent` absent from public interface | `typeof === 'undefined'` |
| M1.2 | Raw SQL approved INSERT on a prepared payment | trigger fires, 0 approved |
| M1.3 | Raw SQL approved INSERT for a missing payment | trigger fires |
| M1.4 | Gate's legitimate approval still works | 1 approved |
| M2 (×7) | prepared/submitting/outcome_unknown/observed/finalized/rejected/recovery_unavailable | rejected + audited with the correct reason |
| M2 | created with non-NULL hash | rejected/transaction_hash_already_prepared, audited |
| M2 | missing payment | unknown_payment, audited in sign_attempts, no payment row |
| M2 | prior approval | authorization_already_recorded, audited, still 1 approval |
| M2 | policy rejection (missing sponsor) | rejected/missing_sponsor, audited |
| retry | policy rejection then valid retry | succeeds; 1 approved + 1 rejected |
| fail-closed | audit write failure | audit_write_failed, 0 approved |
| rollback | failed transaction | 0 rows left; later attempt succeeds |
| cross-process | two OS processes, one DB | 1 approved + 1 rejected |
| restart | close + reopen | 1 approved + 2 rejected preserved |

Plus the 8 TASK34.3 probe assertions (probe 1 rewritten to assert the method is gone and the
trigger fires on raw SQL).

---

## 9. Cross-process test evidence

Two real `npx tsx` child processes share one SQLite file via `BEGIN IMMEDIATE`. Result:
exactly one `approved` event, exactly one `rejected` (reason
`authorization_already_recorded`), and the loser's process received
`{approved: false, reason: 'authorization_already_recorded'}`. [EXEC — 23/23 pass]

---

## 10. Regression results

| Suite | Result |
|---|---|
| `task25-facilitator` | 36/36 |
| `task26-settlement-durability` | 32/32 |
| `task27-multiprocess-settlement` | 16/16 |
| `task29-prebroadcast` | 65/65 |
| `task29-crashboundaries` | 21/21 |
| `task29.1-postsubmit-crash` | 49/49 |
| `task30-concordium-evidence` | 22/22 |
| `task34-narrow-sponsor-auth` | 28/28 |
| `task342-atomic-authorization` | 22/22 |
| `task344-authorization-audit-remediation` | 23/23 |
| Full suite | 1588/1588 across 34 suites |
| Facilitator typecheck | clean |
| Gateway typecheck | clean |
| TASK34.3 adversarial probe | 0 findings (all 8 probes pass) |

No test was weakened, skipped, or deleted. The single assertion change in
`task34-narrow-sponsor-auth.test.mts` (test 24) is a tightening that reflects the new
audited-rejection behaviour.

---

## 11. Remaining limitations

- The trigger and the partial unique index are schema-level and fire only on `sign_events`.
  `sign_attempts` has no approval path by construction (its `decision` column is constrained to
  `'rejected'` and no code inserts into it with any other value).
- TypeScript visibility is **not** the enforcement; the database is. This was the explicit
  requirement and is satisfied.
- The legacy migration path (duplicate approved rows) still fails closed at construction time.
  No data is silently discarded.
- `FacilitatorCore.settle()` is untouched; wiring the authorization boundary into it is
  TASK34.5/36, not this task.

---

## 12. Changed and added files

**Changed**
- `services/facilitator/src/repository.ts` — interface, schema, trigger, `authorizeSignEvent`,
  three private helpers, `signAttempts` reader.
- `test/task34-narrow-sponsor-auth.test.mts` — test 24 assertion tightened.

**Added**
- `test/task344-authorization-audit-remediation.test.mts` — 23 adversarial tests.
- `docs/archive/TASK34.4-authorization-audit-remediation.md` — this report.
- `scripts/task343-adversarial-probe.mts` — rewritten probe 1 and probe 4 to assert the
  remediated invariants (probe 1 now verifies the method is gone and the trigger fires on raw SQL).

---

## 13. Stop condition

TASK 34.4 complete. M1 and M2 closed. Audit boundary remediated. No key material, no signer,
no settlement, no source outside the audit boundary touched.

Awaiting explicit maintainer approval before TASK34.5, TASK36, or any signer work.
