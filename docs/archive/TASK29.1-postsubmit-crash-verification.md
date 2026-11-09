# TASK 29.1 — Post-Submission / Pre-markBroadcast Crash Verification

Date: 2026-11-05 · Bounded verification task · No new payment implementation.

## Recommendation

**SUPPORTED.** The exact crash window — `submitTransaction()` returned successfully but the
process died before `markBroadcast()` committed — is now explicitly exercised by a real
SIGKILL and verified across 5 consecutive runs. Recovery never resubmits, uses the persisted
hash, and finalizes only on verified matching evidence.

## 1. The window under test

Sequence in `services/facilitator/src/core.ts::settle()`:

```
await submitTransaction(sponsored)   // ← broadcast reaches the node here
--- SIGKILL here ---
markBroadcast(digest, persistedHash) // ← never committed
```

Before this task, a payment left in this window sat in state `submitting` with a durable hash,
and reconciliation refused it (not reconcilable). Two changes close that gap:

1. `claim()` now transitions a `submitting` row to `outcome_unknown` on the first read that
   finds a hash (via `markBroadcast`), so reconciliation can proceed.
2. `markBroadcast()` is idempotent for `outcome_unknown` (concurrent recovery cannot throw).

## 2. SDK / persistence evidence (unchanged from TASK 29)

- Hash = `sha256(serialize(tx))`, computed locally after the sponsor signature.
- `prepare()` persists it with `synchronous=FULL` inside `BEGIN IMMEDIATE`.
- `claimSubmit()` is atomic: `prepared → submitting`, refused on hash mismatch.
- `markBroadcast()` is atomic: `submitting → outcome_unknown`.
- `busy_timeout = 5000ms` so writers wait instead of failing.

## 3. Test results

### New suite: `test/task29.1-postsubmit-crash.test.mts` — 49/49, 5 consecutive runs

| Check | Result |
|---|---|
| Exactly one submission attempt across original + recovery | ✅ |
| Hash survives the SIGKILL | ✅ |
| Recovery reports `settlement_pending` with the persisted hash | ✅ |
| State transitions `submitting → outcome_unknown` | ✅ |
| Recovery never calls `submitTransaction()` again | ✅ |
| Inconclusive evidence (committed/pending/unknown/unavailable) stays pending | ✅ |
| Verified matching evidence finalizes (idempotent on repeat) | ✅ |
| Wrong-hash evidence cannot finalize | ✅ |
| A different payment cannot reuse the persisted hash | ✅ |
| Recovery-process crash does not cause a new submission | ✅ |
| Concurrent recovery does not duplicate submission | ✅ |
| Replay protection intact (different resource refused) | ✅ |

### Regression

| Suite | Result |
|---|---|
| task25-facilitator | 36/36 |
| task26-settlement-durability | 32/32 |
| task27-multiprocess-settlement | 16/16 |
| task29-prebroadcast | 65/65 |
| task29-crashboundaries | 21/21 |
| task29.1-postsubmit-crash | 49/49 |
| full suite | 1398/1398, 30 suites |

### Submission ledger evidence (one representative run)

```
{"event":"submit_attempt","at":...,"pid":<dies>,"label":"dies","paymentHint":"..."}
```

Exactly one `submit_attempt` event per payment, from exactly one PID. Recovery processes never
append to the ledger.

### Database state before / after recovery

| Field | Before recovery | After recovery |
|---|---|---|
| `state` | `submitting` | `outcome_unknown` |
| `tx_hash` | `<64-hex>` (durable) | `<same 64-hex>` (unchanged) |
| `attempted` | 1 | 1 |
| `transitions` row for the recovery | — | `submitting → outcome_unknown`, reason "broadcast attempted; outcome not yet established" |

## 4. Exactly-once analysis

- **Submission:** `BEGIN IMMEDIATE` on `payment_claims` (PK on `(payment_digest, requirements_key)`)
  means the second claim fails with `SQLITE_CONSTRAINT_PRIMARYKEY`. The broadcast claim
  (`claimSubmit`: `prepared → submitting`) is equally atomic. No two processes can both
  reach `submitTransaction()`.
- **Recovery:** a `submitting` row is never resubmitted. The first recovery to read it
  transitions it to `outcome_unknown`; concurrent readers see either `submitting` (and
  transition) or `outcome_unknown` (and no-op). Either way, zero new submissions.
- **Finalization:** requires `EvidenceVerifier.verify()` to return a status bound to the
  exact recorded hash. `not_found`, `committed`, `pending`, `unknown`, and unavailable
  evidence all leave the payment in `outcome_unknown`. Only verified `finalized` advances
  it, and only once (terminal idempotency).
- **Crash after submit:** the hash is already durable (prepare ran first), so recovery can
  always query the node by it. No information is lost.

## 5. Changed files

```
MODIFIED:
  services/facilitator/src/core.ts       +claim() pending branch transitions submitting→outcome_unknown
  services/facilitator/src/repository.ts +markBroadcast idempotent for outcome_unknown
NEW:
  test/task29.1-postsubmit-crash.test.mts   49 tests, 5 consecutive clean runs
  docs/archive/TASK29.1-postsubmit-crash-verification.md
NOT MODIFIED:
  src/* (gateway) · src/audit/lock.ts · token 1004 registration · any real signer
```

`git diff --stat HEAD -- services/facilitator/src/` shows nothing because the whole
`services/facilitator/` directory is untracked (created after the initial commit `4c8994d`).
The two modified files appear under `git status --short`:

```
?? services/facilitator/src/core.ts
?? services/facilitator/src/repository.ts
```

The gateway `src/` diff shown in §5's context is pre-existing TASK 20–23 work, not TASK 29.1.

No gateway source change was required by TASK 29.1.

## 6. Constraints honoured

- No Concordium Testnet or Mainnet interaction.
- No signing, no private-key access, no sponsor provisioning.
- No real transaction submission.
- No automatic retry.
- Replay protection and at-most-once safeguards unchanged.
- Token 1004 untouched.
- No commit, push, issue, or npm publication.
- HEAD remains `4c8994d`.

## Stop condition

TASK 29.1 complete. 49/49, 5 consecutive clean runs, 1398/1398 full suite. Awaiting
explicit maintainer approval before any sponsor provisioning or real settlement work.
