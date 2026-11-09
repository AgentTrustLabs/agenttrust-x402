# TASK 34.2 — Atomic Durable Authorization Remediation

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

## Verdict

**PASS.** TASK34.1 FAIL findings are remediated. Only `created` + `tx_hash IS NULL` payments
can be authorized. The state check and audit write are atomic. Exactly-once authorization
enforced at the DB level. Cross-process and restart protection verified.

## 1. Original findings (TASK 34.1)

| ID | Severity | Finding |
|---|---|---|
| C1 | Critical | `prepared`, `submitting`, `outcome_unknown` could receive new authorization |
| H1 | High | `repo.get()` → decide → `recordSignEvent()` not atomic (TOCTOU) |
| M1 | Medium | Missing payment rejected via FK failure, not state check |
| L1 | Low | `paymentState` accepted but ignored |

## 2. Root cause

`MockNarrowSponsorSigner.authorize()` read the durable row, checked only `finalized`/`rejected`,
and allowed everything else through to `decideAuthorization()`. The audit write happened in a
separate transaction. No state check inside the audit transaction. `paymentState` was a
caller-supplied field that was never read.

## 3. Implementation changes

### `services/facilitator/src/repository.ts`

- **New table**: `sign_events` already existed (TASK34). Added
  `CREATE UNIQUE INDEX ux_sign_events_approved ON sign_events(payment_digest) WHERE decision='approved'`
  — database-level exactly-once guard for approved authorizations.
- **New method**: `authorizeSignEvent(input)` — runs inside `BEGIN IMMEDIATE`:
  1. Read durable payment row.
  2. If no row → `unknown_payment`.
  3. If `payment_digest` mismatch → `payment_digest_mismatch`.
  4. If `tx_hash !== null` → `transaction_hash_already_prepared`.
  5. If `state !== 'created'` → `payment_not_authorizable`.
  6. If prior approved sign event exists → `authorization_already_recorded`.
  7. Append the audit event (INSERT).
  8. COMMIT.
  On throw → ROLLBACK → rethrow → caller returns `audit_write_failed`.
- **New types**: `AuthorizeSignResult`, `SignEventInput`, `SignEventRow` (already existed).

### `services/facilitator/src/narrowSponsorMock.ts`

- Rewrote `authorize()`: runs `decideAuthorization()` first (pure), then calls
  `repo.authorizeSignEvent()` atomically. State-based rejection → returns the reason
  without a policy decision. Policy rejection → audit event already recorded, returns the
  policy reason.
- Removed `record()` method (replaced by the atomic path).
- Removed `repo.get()` call (no stale read).

### `services/facilitator/src/narrowSponsor.ts`

- Removed `paymentState` from `SponsorAuthorizationRequest` (L1 fix).
- Added reason codes: `unknown_payment`, `payment_not_authorizable`,
  `transaction_hash_already_prepared`, `authorization_already_recorded`,
  `payment_digest_mismatch`.

## 4. Database transaction boundaries

```
authorize(request)
  ├── decideAuthorization(request, policy, now)   [pure, no DB, no I/O]
  │
  └── repo.authorizeSignEvent(input)  [BEGIN IMMEDIATE]
        ├── SELECT payment row
        ├── check: row exists? (unknown_payment)
        ├── check: digest matches? (payment_digest_mismatch)
        ├── check: tx_hash IS NULL? (transaction_hash_already_prepared)
        ├── check: state == 'created'? (payment_not_authorizable)
        ├── check: no prior approved? (authorization_already_recorded)
        ├── INSERT sign_event
        └── COMMIT (or ROLLBACK on any throw)
```

A concurrent `prepare()` from another process must wait for the `BEGIN IMMEDIATE` lock.
It cannot slip between the state check and the commit. The unique partial index
`ux_sign_events_approved` provides a database-level backstop even if the application
check is bypassed.

## 5. Uniqueness enforcement

- **Application level**: `authorizeSignEvent` checks `COUNT(*) ... WHERE decision='approved'`
  inside the transaction.
- **Database level**: partial unique index `ux_sign_events_approved ON sign_events(payment_digest) WHERE decision='approved'`.
- **Cross-process**: `BEGIN IMMEDIATE` serializes writers. Tested with two separate
  processes (`task342` test 13): exactly one approval.
- **Restart**: the `sign_events` table persists. A second `authorize()` after restart
  sees the approved event and returns `authorization_already_recorded`.

## 6. State transition and hash rules

| Condition | Result |
|---|---|
| `state = 'created'` + `tx_hash IS NULL` | approved (if policy passes) |
| `state = 'created'` + `tx_hash IS NOT NULL` | `transaction_hash_already_prepared` |
| `state = 'prepared'` | `payment_not_authorizable` |
| `state = 'submitting'` | `payment_not_authorizable` |
| `state = 'outcome_unknown'` | `payment_not_authorizable` |
| `state = 'observed'` | `payment_not_authorizable` |
| `state = 'finalized'` | `payment_not_authorizable` |
| `state = 'rejected'` | `payment_not_authorizable` |
| `state = 'recovery_unavailable'` | `payment_not_authorizable` |
| no row | `unknown_payment` |
| prior approved event | `authorization_already_recorded` |

## 7. Test results

### `test/task342-atomic-authorization.test.mts` — 22/22

| # | Test | Result |
|---|---|---|
| 1 | `created` + NULL hash → approved | ✅ |
| 2–7 | `prepared`/`submitting`/`outcome_unknown`/`observed`/`finalized`/`rejected` → rejected | ✅ |
| 8 | `created` + non-NULL hash → rejected | ✅ |
| 9 | missing payment → `unknown_payment` | ✅ |
| 10 | digest mismatch → `unknown_payment` (PK = different row) | ✅ |
| 11 | previously approved → `authorization_already_recorded` | ✅ |
| 12 | concurrent authorize + prepare() → no stale approval | ✅ |
| 13 | two concurrent authorizations → exactly one approved | ✅ |
| 14 | restart → no second approval | ✅ |
| 15 | audit write failure → no approval | ✅ |
| 16 | DB rollback → no partial event | ✅ |
| 17 | rolled-back attempt doesn't block later valid one | ✅ |
| 18 | rejected policy attempt doesn't block later valid one | ✅ |
| 19 | TASK27 replay protection intact | ✅ |
| 20 | TASK29.1 crash recovery intact | ✅ |
| 21 | `paymentState` removed from contract | ✅ |

### Regression

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
| **full suite** | **1542/1542, 33 suites** |
| typecheck (gateway + facilitator) | OK |

## 8. Verdict for original findings

| ID | Severity | Status |
|---|---|---|
| C1 | Critical | **FIXED** — only `created` + NULL hash authorizable |
| H1 | High | **FIXED** — state check + audit write in one `BEGIN IMMEDIATE` |
| M1 | Medium | **FIXED** — explicit `unknown_payment` check before audit |
| L1 | Low | **FIXED** — `paymentState` removed from request contract |

## 9. Remaining limitations

1. Fee exposure is still not precisely calculable (energy cap is the proxy).
2. No real signing. `NarrowSponsorSigner` has no `sign()` method.
3. The partial unique index `ux_sign_events_approved` is created with `IF NOT EXISTS`,
   so it applies to existing databases without migration.
4. Cross-process concurrency (test 13) uses separate processes with a shared SQLite file,
   proving the protection works across independent processes.

## 10. Constraints honoured

- No private-key access, generation, or wallet access.
- No sponsor provisioning, no real signer, no `AccountSigner`, no signing.
- No transaction construction, submission, or broadcast.
- No faucet, no Mainnet, no real settlement.
- Token 1004 untouched.
- Settlement not enabled. `DENY_ALL_FACILITATOR` preserved.
- Replay protection and crash recovery not weakened.
- No unrelated refactoring.
- No commit, push, publish, or GitHub issue.
- HEAD remains `4c8994d`.

## Stop condition

TASK 34.2 complete. 22/22, 1542/1542 full suite. Awaiting explicit maintainer approval
before TASK 35 or any sponsor provisioning.
