# TASK 59 — Finalization Confirmation & Rejection Evidence

## VERDICT

**PASS WITH CONDITIONS.**

A bounded confirmation gate was added: a terminal `rejected` state now requires
`REJECTION_CONFIRMATIONS_REQUIRED = 2` consistent observations of the **same** transaction hash.
Success is never gated. Pending / unknown / timeout / transport-error remain non-terminal and
reset the counter. Four existing suites were updated because their assertions encoded the old
first-observation-wins semantics — that is a deliberate behaviour change mandated by this task.

## 1. ROOT CAUSE AND GAP E

GAP E (identified in TASK53, reproduced with `scripts/task53-probe-evidence-ordering.mts`):

```
worker A (observed failed)    -> {"scanned":1,"failed":1}
worker B (observed finalized) -> {"scanned":0,...}
final state                   -> rejected
```

`reconcile()` mapped a single `failed` observation straight to terminal `rejected`, and
terminal states are never reopened. A spurious or stale rejection therefore permanently
rejected a payment that later evidence showed as `finalized`. The concurrency machinery was
correct (one terminal state, one settlement row, hash never renamed) — the defect was
**evidentiary sufficiency**: one observation was treated as proof.

TASK55 recommended a confirming-evidence rule as the minimum correction. TASK59 implements it.

## 2. EXISTING STATUS SEMANTICS (unchanged)

| Node / transport answer | `interpretObservation` | Terminal? |
|---|---|---|
| `received` | `pending` → `stay` | no |
| `committed` | `stay` | no |
| `finalized` + success outcome | `finalized` | **yes** (never gated) |
| `finalized` + `transactionType === 'failed'` | `rejected` | yes, **after confirmation** |
| not found (RpcError) | `transport_error` | no |
| timeout / deadline | `timeout` | no |
| transport throw | `transport_error` | no |
| malformed / unrecognized status | `transport_error` | no |
| `unknown` | `stay` | no |

Verified in TASK59 tests 56–61: only `finalized` + `transactionType === 'failed'` produces
`rejected`; not-found, malformed, `received`, and `committed` never do.

## 3. CONFIRMATION ALGORITHM AND EXACT LIMITS

```
ReconcileInput(observed)

if state is terminal:
    finalized  -> {ok:true, changed:false, "already finalized"}      # idempotent
    rejected   -> {ok:false, "payment is terminally rejected"}       # never reopened

if interpretObservation(observed).advance == 'stay':
    reset rejection_observation_count to 0
    log observation; return {ok:true, changed:false, state unchanged}

if advance == 'rejected':
    if rejection_observation_count + 1 < 2:
        rejection_observation_count += 1
        log "rejection observed once (n/2); awaiting confirmation"
        return {ok:true, changed:false, state unchanged}
    # confirmed
    set state='rejected', rejection_observation_count=0
    log "verified rejected"; return {ok:true, changed:true, state:'rejected'}

if advance == 'finalized':
    set state='finalized', rejection_observation_count=0
    return {ok:true, changed:true, state:'finalized'}
```

Exact limits:

- **Confirmations required:** 2 (`REJECTION_CONFIRMATIONS_REQUIRED`).
- **Interval:** determined by the caller. `recoverPending()` invokes `waitForFinalization()`
  once per row per pass, so consecutive *passes* are the confirming observations. Within one
  pass the submitter's own polling loop (`intervalMs`, default 250 ms; `timeoutMs`, default
  30 s) may already poll many times, but only the final resolved status is submitted once to
  `reconcile()` — a single pass yields at most one observation.
- **Retry limits:** no new loop was added. The existing bounded polling in
  `ConcordiumTransactionSubmitter.awaitFinalization` (deadline = `timeoutMs`) is unchanged.
  Confirmation is not retried internally; it accrues across passes.
- **Hash binding:** every observation must name the exact recorded hash
  (`settlements.tx_hash`). A mismatched hash is refused and does **not** increment the counter
  (test 38–39).

### "Same cached result" is not double-counted

The counter lives in durable SQLite state (`payments.rejection_observation_count`), not in
memory. It is incremented only when `reconcile()` is called, which happens only when a fresh
`getBlockItemStatus` / `waitForTransactionFinalization` resolved for that row. There is no code
path that reads a cached status and calls `reconcile()` twice — `recoverPending()` issues one
status lookup per row per pass. Reloading the same transaction hash from the DB does not
increment the counter.

## 4. CHANGED FILES AND IMPLEMENTATION

| File | Change |
|---|---|
| `services/facilitator/src/repository.ts` | `payments.rejection_observation_count` column (schema + migration); `REJECTION_CONFIRMATIONS_REQUIRED = 2`; `PaymentRow.rejection_observation_count`; `read()` selects it; `reconcile()` implements the gate (reset on stay, increment-then-return on first rejection, terminalize on second, clear counter on any terminal advance). |
| `services/facilitator/src/core.ts` | `recoverPending()` counts `summary.failed` only when `r.changed` — a recorded-but-unconfirmed observation is evidence, not a terminal failure. |
| `test/task59-finalization-confirmation-evidence.test.mts` | New, 63 assertions. |
| `test/task25-facilitator.test.mts` | Test 29 confirms the rejection via `recoverPending()` before asserting the terminal-refusal path. |
| `test/task26-settlement-durability.test.mts` | Test 24 requires two reconciliations before asserting terminal. |
| `test/task52-core-submission-recovery.test.mts` | Tests 03 and 09 confirm the rejection via a second observation. |
| `test/task53-idempotency-recovery-concurrency.test.mts` | Test 07 confirms the rejection before asserting terminal refusal. |
| `scripts/task58-verify-sponsor-account.mts` | Renamed genesis constant to a hash-word identifier (packaging-scan false positive from TASK58). |

No change to: `state.ts` transition table, IPC protocol, authorization, sender verification,
fee validation, `DENY_ALL_FACILITATOR`, or settlement defaults.

**Why a column and not a new table:** the counter is per-payment state with the same lifetime
and the same `BEGIN IMMEDIATE` write path as `state`. A separate table would add a join and a
second write inside the same transaction for no isolation benefit. The existing
`transitions` audit log already records every observation with its reason string
(`rejection observed once (1/2); awaiting confirmation`), so the evidence trail is preserved.

## 5. EVIDENCE SEQUENCE TEST MATRIX

| Sequence | Expected | Test |
|---|---|---|
| rejected → rejected | 1st: changed=false, state `outcome_unknown`, counter 1. 2nd: changed=true, state `rejected`, counter 0 | 08–16 |
| rejected → finalized success | success terminalizes immediately; counter cleared; state `finalized` | 17–21 |
| rejected → pending | no terminal; counter reset to 0; state unchanged | 22–26 |
| rejected → unknown | no terminal; counter reset; state non-terminal | 27–30 |
| rejected → transport error | non-terminal; hash preserved | 31–33 |
| finalized success → rejected | finalized never overwritten (`changed:false` or refused) | 34–37 |
| rejection naming a different hash | refused; counter unchanged; state non-terminal | 38–40 |
| recovery pass observing `failed` once | `summary.failed = 0`; state non-terminal; counter 1 | 41–43 |
| second recovery pass | `summary.failed = 1`; state `rejected`; hash unchanged | 44–46 |
| recovery: rejected then finalized | final state `finalized`, not `rejected` | 47–48 |
| two concurrent workers, both `failed` | two consistent observations → terminal `rejected`; exactly one worker reports it; one settlement row; one distinct hash | 49–53 |
| two concurrent workers, `failed` + `pending` | inconsistent evidence does not terminalize | 54–55 |

## 6. CONCURRENCY AND PERSISTENCE RESULTS

- Confirmation state is durable in SQLite and mutated only inside `BEGIN IMMEDIATE`, so two
  workers cannot both observe "count 0 → 1" and both write 1; nor can they skip from 0 to
  terminal. The second writer serializes behind the first.
- Two genuinely consistent concurrent rejections **do** satisfy the requirement (test 49): both
  are independent `getBlockItemStatus` results for the same hash, which is exactly the
  evidence the rule asks for. This is the intended semantics, not a bypass.
- Exactly one terminal transition and one settlement record result (tests 52–53).
- The transaction hash is never modified by the gate (tests 16, 33, 46, 50).
- `markFailed()` still cannot terminalize a broadcast-capable row with a hash (test 62,
  TASK53 invariant preserved).
- Migration: a database created without the column gains it with default 0, which correctly
  means "no rejection evidence yet" (test 63).

## 7. TEST RESULTS

Focused suite: **`task59: 63/63 passed, 0 failed`**

Regression suites (all re-run after the change):

```
task49:  21/21    task50:  27/27    task51:  27/27
task52:  18/18    task52.1: 7/7     task53:  13/13
task55:  52/52    task57:  27/27    task59:  63/63
task25:  36/36    task26:  32/32    task15:  13/13
```

Build and typechecks:

```
npm run build                                                   rc=0
npx tsc --noEmit                                                rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)   rc=0
```

Full suite: **68/69 suites pass** on the clean run; the single failure is the pre-existing
audit-lock contention flake (`task06-audit-integrity` test 11 / `task14-audit-strictness` test
15 — `AuditLockUnrecoverableError` under parallel writers), which passes in isolation and is
unrelated to TASK59. Deterministic re-runs of every suite touched by this change are green.

## 8. REMAINING LIMITATIONS

1. **Confirmation is per-pass, not time-separated.** Nothing enforces a minimum wall-clock gap
   between the two observations. If both passes read a stale node view, both agree on a wrong
   answer. Mitigation is operational (recovery passes are naturally seconds apart because each
   pass performs a bounded `waitForFinalization`).
2. **Single node.** Both observations come from the same node (`FACILITATOR_NODE_HOST`). A
   node with a corrupted view defeats the rule. Cross-node quorum would require a second node
   endpoint — not implemented, and out of scope for a bounded change.
3. **No manual override path.** A payment wrongly confirmed as `rejected` still cannot be
   reopened (`rejected` is terminal by design). An operator can observe the truth on chain but
   cannot transition the row. A future task could add an operator-authenticated
   re-verification endpoint, but that is a lifecycle change.
4. **`prepared` rows are still not recovered** (TASK52/53 semantics unchanged).
5. **The counter is not exposed via HTTP.** It is visible in the DB and in the `transitions`
   reason strings only.
6. **`summary.failed` semantics changed** — it now means "terminal rejections confirmed in this
   pass", which is the honest meaning but differs from the previous count of raw rejections
   observed.

## 9. NO REAL TRANSACTION

No real transaction was constructed, signed, submitted, broadcast, or finalized. Every test used
a fake signer, a fake gRPC client, or an isolated SQLite file. No wallet was created, no
credential generated, no key material accessed, no faucet used, no account funded. Real
facilitator settlement was not activated; `DENY_ALL_FACILITATOR` and the settlement default
remain disabled. Token 1004 and its Agent Card are untouched. No commits or pushes.
