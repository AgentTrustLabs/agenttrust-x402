# TASK 34.1 — Durable Payment State Authorization Gate Review

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b` · Read-only review.

## Verdict

**FAIL.** The authorization boundary does not enforce that a payment is in the initial `created`
state with no durable transaction hash. `MockNarrowSponsorSigner.authorize()` approves
`prepared`, `submitting`, `outcome_unknown`, and `observed` payments, and ignores the
caller-supplied `paymentState` field entirely. Only `finalized` and `rejected` are refused.
A payment that has already entered a durable transaction state can obtain a new sponsor
authorization.

## 1. Source files and functions inspected

| File | Function |
|---|---|
| `services/facilitator/src/narrowSponsorMock.ts` | `MockNarrowSponsorSigner.authorize()` (lines 34–46), `.record()` (48–79) |
| `services/facilitator/src/narrowSponsor.ts` | `decideAuthorization()` (pure, no DB access), `validatePolicy()` |
| `services/facilitator/src/repository.ts` | `get()`, `recordSignEvent()`, `claim()`, `prepare()`, `claimSubmit()`, `markBroadcast()`, `reconcile()`, `markObserved()`, `markRecoveryUnavailable()` |
| `services/facilitator/src/core.ts` | `settle()` (lines 132–270) |
| `services/facilitator/src/state.ts` | `SettlementState`, `canTransition()`, `isTerminal()` |
| `services/facilitator/src/store.ts` | `paymentDigest()`, `requirementsKey()` |

## 2. Data path traced

```
authorize(request)
  → repo.get(request.paymentDigest)          [durable SQLite read, source of truth]
  → if row.state ∈ {finalized, rejected} → reject duplicate_payment
  → if row.state ∉ {created, prepared, submitting, outcome_unknown} → reject duplicate_payment
  → decideAuthorization(request, policy, now) [pure; never reads paymentState or row.state]
  → repo.recordSignEvent(...)               [durable audit write; FK to payments]
```

The `paymentState` field in `SponsorAuthorizationRequest` is accepted by the type but is
**never read** by `decideAuthorization`. The durable row's state is read but only used to
refuse `finalized`/`rejected` and states outside the allow-list. `prepared`, `submitting`,
`outcome_unknown`, and `observed` are in the allow-list and pass through to `decideAuthorization`,
which always approves if the policy checks pass.

## 3. Payment state transition table

| State | `authorize()` result | Should be | Verdict |
|---|---|---|---|
| `created` (no hash) | ✅ approved | approved | **correct** |
| `prepared` (hash durable) | ❌ approved | rejected | **VIOLATION** |
| `submitting` | ❌ approved | rejected | **VIOLATION** |
| `outcome_unknown` | ❌ approved | rejected | **VIOLATION** |
| `observed` | rejected (duplicate_payment) | rejected | correct reason, wrong gate |
| `finalized` | rejected (duplicate_payment) | rejected | correct reason, wrong gate |
| `rejected` | rejected (duplicate_payment) | rejected | correct reason, wrong gate |
| `recovery_unavailable` | rejected (duplicate_payment) | rejected | correct reason, wrong gate |
| no row | rejected (audit_write_failed) | rejected | **wrong reason** — FK failure, not a state check |

## 4. Prepared-hash behaviour

A payment in `prepared` has a durable `tx_hash` (persisted by `prepare()`). `authorize()`
does not inspect `row.tx_hash` at all. A payment with `tx_hash = 'tx-abc'` can be
re-authorized with no binding to that hash.

## 5. Atomicity / race analysis

**Finding: TOCTOU race between `repo.get()` and `repo.recordSignEvent()`.**

`authorize()` reads the payment state, then calls `decideAuthorization()`, then writes the
audit event — three separate operations with no transaction wrapping them. A state transition
(`claim()`, `prepare()`, `markBroadcast()`) can occur between the read and the audit write.

Concretely:

1. Process A: `repo.get(d)` → `created`.
2. Process B: `repo.claim(d, k)` → `created` with `attempted=1`.
3. Process B: `repo.prepare(d, 'tx-x')` → `prepared` with hash.
4. Process A: `decideAuthorization()` → approved (reads nothing from DB).
5. Process A: `repo.recordSignEvent(...)` → audit event written for an approval that was
   decided against stale state.

Additionally, `recordSignEvent` has a foreign-key constraint to `payments`. If the payment
row does not exist, the INSERT throws and `authorize()` returns `audit_write_failed` instead
of a clean state-based rejection. The FK is doing gatekeeping that the authorization logic
should do explicitly.

**Audit write failure is fail-closed** (confirmed: dropping `sign_events` yields
`audit_write_failed`). However, the reason is wrong for a missing payment — it should be a
state-based rejection, not an audit failure.

## 6. Probe results (executed, not inferred)

`scripts/task341-state-gate-probe.mts` — 9/10 violations:

| State | Expected | Actual |
|---|---|---|
| `created`, no hash | approved | ✅ approved |
| `prepared` | rejected | ❌ **approved** |
| `submitting` | rejected | ❌ **approved** |
| `outcome_unknown` | rejected | ❌ **approved** |
| `observed` | rejected | ✅ rejected (duplicate_payment) |
| `finalized` | rejected | ✅ rejected (duplicate_payment) |
| `rejected` | rejected | ✅ rejected (duplicate_payment) |
| `recovery_unavailable` | rejected | ✅ rejected (duplicate_payment) |
| payment missing | rejected | ⚠️ rejected (audit_write_failed — wrong reason) |
| claims `created`, durable `prepared` | rejected | ❌ **approved** |

## 7. VERIFIED / NOT TESTED / BLOCKED

**VERIFIED (by execution):**
- `created` with no hash → approved.
- `prepared` → currently approved (should be rejected).
- `submitting` → currently approved (should be rejected).
- `outcome_unknown` → currently approved (should be rejected).
- `finalized`/`rejected` → rejected (duplicate_payment).
- Missing payment → rejected (audit_write_failed).
- Caller-supplied `paymentState` is ignored — the durable row is read, but only for the
  `finalized`/`rejected` check.
- Audit write failure is fail-closed.

**NOT TESTED:**
- Concurrent authorization race (two processes, same digest) — the probe is single-process.
  The TOCTOU is identified by code inspection, not executed.
- Restart between authorization and state transition — not executed.

**BLOCKED:**
- Nothing. The flaw is in the implementation, not in the environment.

## 8. Findings

### Critical (1)

**C1 — Authorization approves payments in durable transaction states.**

- File: `services/facilitator/src/narrowSponsorMock.ts`, lines 36–46.
- Impact: a payment that has already been prepared, submitted, or has an ambiguous outcome
  can obtain a new sponsor authorization. This breaks the "one authorization per payment"
  invariant and could allow a second signing attempt after a crash.
- Root cause: the allow-list on line 40 includes `prepared`, `submitting`, and
  `outcome_unknown`. Only `created` (with no durable hash) should be authorizable.
- Fix (smallest possible): change the condition to reject any state other than `created`,
  and additionally reject if `row.tx_hash !== null`.

### High (1)

**H1 — TOCTOU race between state read and audit write.**

- File: `services/facilitator/src/narrowSponsorMock.ts`, lines 36–66.
- Impact: a state transition can occur between `repo.get()` and `repo.recordSignEvent()`,
  allowing an approval to be recorded against stale state.
- Fix: wrap the read + decision + audit write in a single `BEGIN IMMEDIATE` transaction,
  or re-read and re-validate the state inside the audit transaction.

### Medium (1)

**M1 — Missing payment record is rejected via FK failure, not a state check.**

- File: `services/facilitator/src/narrowSponsorMock.ts`, line 36; `repository.ts::recordSignEvent`.
- Impact: the rejection reason is `audit_write_failed` instead of a clean `unknown_payment`
  or `not_authorizable`. The FK constraint is doing gatekeeping that the authorization
  logic should do explicitly.
- Fix: check `if (!row)` and return `{approved:false, reason:'unknown_payment'}` before
  any decision or audit write.

### Low (1)

**L1 — `paymentState` field is accepted but never read.**

- File: `services/facilitator/src/narrowSponsor.ts` (type) and `narrowSponsorMock.ts`.
- Impact: a caller can pass `paymentState: 'created'` for a payment that is `prepared`,
  and the durable row's state is the only check — but the check is incomplete (see C1).
  The field is misleading.
- Fix: either remove `paymentState` from the request type, or document that it is
  informational only and the durable row is authoritative.

## Recommended remediation

A separate implementation task (TASK 34.2) should:

1. Change the allow-list to only `created` with `tx_hash === null`.
2. Re-read the durable row inside the audit transaction to close the TOCTOU gap.
3. Add an explicit `!row` check returning `unknown_payment`.
4. Add a `paymentState` consistency assertion (informational, not authoritative).
5. Add tests for all 12 conditions listed in the task scope.

## Constraints honoured

- No production implementation modified in this task.
- No commit, push, publish, or GitHub issue.
- HEAD remains `4c8994d`.
- No signing, no key access, no sponsor provisioning.

## Stop condition

TASK 34.1 complete. **FAIL** verdict. Three findings: 1 Critical, 1 High, 1 Medium, 1 Low.
Awaiting maintainer approval before remediation (TASK 34.2) or TASK 35.
