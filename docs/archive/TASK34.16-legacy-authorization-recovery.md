# TASK 34.16 — Safe Legacy Authorization Recovery

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Evaluation result: legacy records are UNRECOVERABLE. No backfill implemented.**

---

## VERDICT

**PASS.** No safe backfill is possible. Legacy authorization records with NULL context remain
fail-closed. No field is invented, no caller data is trusted, and no approval is created.
The only change is a distinct reason code (`legacy_context_missing`) so operators can
identify unrecoverable records.

Per the task's own escape clause — *"Jika tidak ada bukti durable yang cukup, jangan
memaksakan implementasi. PASS dengan kesimpulan bahwa legacy records harus tetap fail closed
dapat diterima."* — that condition is met.

---

## ROOT CAUSE

TASK34.14 added `asset`, `amount`, `expiry` to `sign_events`, but records written before that
change have NULL in all three. Recovery compares all three; NULL → `unknown`. That is correct
fail-closed behaviour, but operators could not distinguish "legacy record with no context"
from "record whose context genuinely differs".

There is no defect to repair. The question this task answers is whether the missing context
can be reconstructed from durable evidence. It cannot — see LEGACY EVIDENCE INVENTORY.

---

## LEGACY EVIDENCE INVENTORY

### Durable tables and what they hold

| Table | Context fields stored |
|---|---|
| `payments` | `payment_digest`, `requirements_key`, `state`, `tx_hash`, timestamps, `attempted` |
| `sign_events` | `network`, `sender`, `sponsor`, `recipient`, `energy`, `policy_version`, `asset`, `amount`, `expiry` (nullable since TASK34.14) |
| `payment_claims` | `payment_digest`, `requirements_key`, `claimed_at` |
| `settlements` | `payment_digest`, `tx_hash`, `created_at` |
| `transitions` | `payment_digest`, `from_state`, `to_state`, `reason`, `tx_hash`, `evidence`, `at` |
| `sign_attempts` | `payment_digest`, `decided_at`, `decision`, `reason`, `network`, `sender`, `sponsor`, `recipient`, `energy`, `policy_version` |

### Field-by-field availability for a legacy record

| Field | Durable source | Verdict |
|---|---|---|
| `network` | `sign_events.network` | ✅ available |
| `sender` | `sign_events.sender` | ✅ available |
| `sponsor` | `sign_events.sponsor` | ✅ available |
| `recipient` | `sign_events.recipient` | ✅ available |
| `energy` | `sign_events.energy` | ✅ available |
| `policy_version` | `sign_events.policy_version` | ✅ available |
| `asset` | `payments.requirements_key` (lossy join) | ⚠ ambiguous if any field contains `\|` |
| `amount` | `payments.requirements_key` (lossy join) | ⚠ same ambiguity |
| `expiry` | **none** | ❌ not stored in any table |
| `paymentDigest` recomputation | requires the **payload** (x402Version, scheme, maxTimeoutSeconds, nonce, expiry, signatures, …) | ❌ payload is not stored durably |

### Why `requirements_key` is not valid evidence

```ts
[network, payTo, amount, asset, resourceUrl].join('|')
```

- Ambiguous when any field contains `|`.
- Contains no `expiry`.
- Is a derived replay key, not a canonical identity; it cannot be used to recompute
  `paymentDigest`.

### Backfill feasibility against the spec's own conditions

| # | Condition | Met? |
|---|---|---|
| 1 | Payment identity matches | ✅ `payment_digest` is the PK |
| 2 | Digest recomputable with the same canonicalization | ❌ payload not stored |
| 3 | Recomputed digest equals stored `payment_digest` | ❌ depends on 2 |
| 4 | `asset`, `amount`, `expiry` available from trusted durable source | ❌ `expiry` absent; `asset`/`amount` lossy |
| 5 | No conflict between payment row and authorization record | ⚠ cannot be established for missing fields |
| 6 | Atomic and idempotent | n/a — no backfill |
| 7 | Does not create a new approval | n/a — no backfill |

Conditions 2 and 4 are **unsatisfiable**. The spec is explicit: do not guess, do not use
caller data, do not treat the record as approved.

---

## RECOVERABLE RECORD CRITERIA

A legacy record is **recoverable** only if ALL of the following hold:

1. Payment identity matches (`payment_digest` exists in `payments`).
2. `asset` is non-NULL and matches the request.
3. `amount` is non-NULL and matches the request.
4. `expiry` is non-NULL and matches the request.
5. `network`, `sender`, `sponsor`, `recipient`, `energy`, `policy_version` all match.
6. `paymentDigest` can be recomputed from durable evidence and equals the stored digest.

**Criterion 6 is impossible.** The digest hashes `{ x402Version, payload }`, and the payload
(including the signed transaction, scheme, `maxTimeoutSeconds`, nonce, expiry, signatures) is
never persisted. Therefore **no legacy record can satisfy the criteria.**

### Recoverable vs unrecoverable count

| Category | Count | Basis |
|---|---|---|
| Recoverable legacy records | **0** | criterion 6 unsatisfiable for every legacy row |
| Unrecoverable legacy records | **all rows with NULL `asset`/`amount`/`expiry`** | same |
| Records written after TASK34.14 | recoverable | full context bound at authorization time |

This repository contains no production database, so there is no production row count to
report. The determination is categorical rather than empirical: the criteria cannot be met
for any legacy row, independently of how many exist.

---

## IMPLEMENTATION

### What was changed

1. **Reason code** (`services/facilitator/src/authorization.ts`, `scripts/task348-owner.mts`):
   legacy rows (NULL context) now return `unknown` with reason `legacy_context_missing`
   instead of the generic `context_mismatch`. This distinguishes "unrecoverable legacy
   record" from a genuine context mismatch. Behaviour is otherwise unchanged — still
   fail-closed.

2. **No backfill.** No schema change beyond TASK34.14. No migration that invents data.
   No approval created. No signer invoked.

3. **Recovery logic unchanged.** The TASK34.14 fail-closed rule (NULL → non-approved) is
   preserved exactly.

### Files changed

| File | Change |
|---|---|
| `services/facilitator/src/authorization.ts` | distinct reason `legacy_context_missing` for NULL-context rows |
| `scripts/task348-owner.mts` | same reason in the owner recovery branch |

### Files NOT changed (by design)

- `repository.ts` — no backfill function, no schema change
- `narrowSponsorMock.ts` — no new write path
- `core.ts` — no new recovery branch
- `state.ts` — no state machine change

---

## VERIFIED

- Legacy record (NULL context) → `unknown` / `legacy_context_missing` (fail closed)
- Every mismatched field (amount, asset, expiry, energy, sponsor, recipient, sender,
  network) → non-approved
- Missing payment row → `unknown` / `no_durable_decision`
- Duplicate approved insert blocked by the partial unique index
- NULL `requirements_key` rejected by the NOT NULL constraint
- 5 repeated recoveries on a legacy record → no approvals, no writes
- 10 process restarts against a legacy record → fail closed every time
- 8 concurrent recoveries on a legacy record → 0/8 approved
- Recovery never creates an approval and never invokes the signer
- Real IPC owner returns `legacy_context_missing` for legacy context

### Adversarial tests — `test/task3416-legacy-recovery.test.mts` — **19/19**

| # | Scenario | Result |
|---|---|---|
| 13 | legacy NULL context → `legacy_context_missing` | fail closed |
| 01 | digest recomputation impossible (documented invariant) | ✓ |
| 02 | amount differs | not approved |
| 03 | asset differs | not approved |
| 04 | expiry differs | not approved |
| 07a | energy differs | not approved |
| 07b | sponsor differs | not approved |
| 07c | recipient differs | not approved |
| 07d | sender differs | not approved |
| 07e | network differs | not approved |
| 05 | missing payment row | `unknown` |
| 06 | NULL requirements_key rejected by schema | NOT NULL |
| 07 | digest mismatch | `unknown` |
| 08 | payment identity differs | not approved |
| 09 | duplicate blocked by index | storage-level guard |
| 10 | 5 repeated recoveries → idempotent, no writes | ✓ |
| 11 | 10 restarts → fail closed every time | ✓ |
| 12 | 8 concurrent → 0/8 approved | ✓ |
| 14 | recovery writes nothing, signer never invoked | ✓ |

---

## NOT TESTED

- Backfill idempotency (not implemented — no backfill exists)
- Crash before/after commit of a backfill (not implemented)
- Concurrent backfill across two processes (not implemented)
- Migration against a production-sized `sign_events` table (out of scope; the ALTER path is
  exercised on fresh databases)

---

## BLOCKED

- **Safe backfill** — impossible: `expiry` is not durably stored anywhere, and the payload is
  not stored, so the digest cannot be recomputed. No evidence, no backfill.
- **Real-signer end-to-end recovery** (mock signer only)
- **Real facilitator settlement** (`DENY_ALL_FACILITATOR`)

---

## UNRECOVERABLE LEGACY RECORDS

A legacy record is unrecoverable when any of `asset`, `amount`, `expiry` is NULL. Recovery
returns:

```json
{ "outcome": "unknown",
  "reason": "legacy_context_missing",
  "detail": "does not match: asset (missing durable evidence), amount (missing durable evidence), expiry (missing durable evidence)" }
```

Operator handling:

1. Treat as **unrecoverable** — never as approved.
2. The legacy record is preserved unchanged: never deleted, never rewritten, never backfilled.
3. If the settlement is still needed, re-authorize with a **new payload**, which produces a
   new `payment_digest` and a fresh record with full context bound.

---

## TEST RESULTS

```
Full suite:               1903/1903 passed · 48 suites · 0 FAIL
task3416-legacy-recovery: 19/19 passed
Facilitator typecheck:    PASS
Gateway typecheck:        PASS
```

Git state:

```
HEAD:    4c8994db391d77796e06e49c843c42be1eae615b (unchanged)
Commits: 0
Pushes:  0
```

- `DENY_ALL_FACILITATOR` intact
- Token 1004 / Agent Card untouched
- UID/GID intact (authowner 997, authclients 1002, authzintruder 995)
- No production database modified
- No private key generated, imported, or used

---

## REMAINING LIMITATIONS

1. **Legacy records are permanently unrecoverable.** Operators must treat them as
   `legacy_context_missing` and re-authorize with a new payload if needed.
2. **`requirements_key` is a lossy join.** `network|payTo|amount|asset|resourceUrl` is
   ambiguous when any field contains `|`, and carries no `expiry`. It cannot be used as
   evidence.
3. **The payload is never persisted.** This is what makes digest recomputation impossible —
   by design, since persisting the payload would widen the attack surface.
4. **Owner is the trust root.** Unchanged from TASK34.15.
5. **Same-UID and root limitations.** Unchanged from TASK34.12.

---

## Final Maintainer Recommendation

**Do not implement a backfill.** The durable evidence is insufficient to prove context
integrity for legacy records. The safe action is to keep them fail-closed, mark them with the
`legacy_context_missing` reason, and require re-authorization with a new payload.

**Stop condition met.** No further tasks started. Awaiting maintainer decision.
