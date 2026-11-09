# TASK 52 — FacilitatorCore V1 Submission Integration & Recovery

## VERDICT

**PASS.** `FacilitatorCore` reaches the V1 submission path (`Transaction.finalize` →
`GRPCClient.sendTransaction`) through the existing signer boundary, persists the *finalized*
transaction hash before any submission, and exposes a restart recovery pass
(`recoverPending()`) that polls the recorded hash and never resubmits.

The hash source was corrected from pre-finalized to finalized (see §HASH CORRECTION). That
correction initially made `task48` B06 fail (23/24) because the mock signer returned the
transaction with an empty sponsor signature slot, which makes `computeFinalizedTransactionHash`
throw "No signatures were provided". **TASK 52.1 fixes this at the correct abstraction boundary:**
the mock signer's `addSponsorSignature` now leaves a deterministic sponsor signature in place,
mirroring the production sponsor signer. `task48` is back to 24/24; `task52` stays 18/18. All 45
suites pass (`npm test`).

The remaining blockers below are unchanged scope deferrals, not regressions.

## EXISTING ARCHITECTURE AND PERSISTENCE MECHANISM

Persistence is already in place; nothing new was introduced.

- **Store**: `SqliteSettlementRepository` (`services/facilitator/src/repository.ts`), SQLite
  with `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = FULL`.
- **Payment row**: `payments(payment_digest PK, requirements_key, state, tx_hash, created_at,
  updated_at, attempted)`.
- **Settlement row**: `settlements(payment_digest PK, tx_hash, created_at)`.
- **Audit**: `transitions(...)` append-only log of every state change, plus `evidence`.
- **State machine**: `services/facilitator/src/state.ts` — `created → prepared → submitting →
  outcome_unknown → observed → finalized | rejected`, with `recovery_unavailable` off the
  ambiguous branch. `prepared`, `submitting`, `outcome_unknown`, `observed` and
  `recovery_unavailable` are non-terminal.
- **Durability rule (TASK 29)**: `prepare(digest, hash)` is the only method that makes a hash
  durable, and it transitions `created → prepared` inside `BEGIN IMMEDIATE` with
  `synchronous = FULL`. `claimSubmit(digest, hash)` refuses unless the row is `prepared` and
  the hash matches exactly.

## EXACT LIFECYCLE AND ORDERING

`FacilitatorCore.settle()` ordering is unchanged from TASK 29/37/38/46 and is now proven for
the V1 path:

1. envelope validation
2. requirement agreement (scheme/network/asset/amount/payTo)
3. expiry check
4. replay/duplicate claim (`store.claim`) — atomic
5. **sender verification** (`senderVerifier`)
6. **authorization** (`authorization.authorize`) and recovery
7. **fee/energy validation** (`signer.validateContext`, when the signer exposes it)
8. **wire conversion** (`convertV2ToSdkV1` with policy-derived energy)
9. **sponsor signing** (`signer.addSponsorSignature`)
10. **hash computation** — `computeFinalizedTransactionHash(sponsored)`
11. **durable persistence** — `store.prepare(digest, hash)` (`created → prepared`)
12. **broadcast claim** — `store.claimSubmit(digest, hash)` (`prepared → submitting`)
13. **submission** — `signer.submitTransaction(sponsored)`
14. **broadcast recorded** — `store.markBroadcast` (`submitting → outcome_unknown`)
15. **hash match check** — returned hash must equal the persisted hash
16. **finalization** — `signer.waitForFinalization(hash, timeoutMs)`
17. `finalized` → `store.reconcile(... observed: 'finalized')` → **the only success return**
    `failed` → `store.reconcile(... observed: 'failed')` → `transaction_failed`
    pending/committed → `store.markPending` → `settlement_pending`

## SDK / SUBMITTER INTEGRATION EVIDENCE

| Element | Evidence |
|---|---|
| V1 submission | `GrpcConcordiumTransport.submit` → `Transaction.finalize(signable)` → `client.sendTransaction(finalized)` (`services/facilitator/src/grpcConcordiumTransport.ts`) |
| SDK contract | `GRPCClient.sendTransaction(transaction: Transaction.Finalized): Promise<TransactionHash.Type>` (`node_modules/@concordium/web-sdk/lib/esm/grpc/GRPCClient.d.ts:174`), impl `GRPCClient.js:246-256` |
| Finalization | `Transaction.finalize` → `preFinalized` recomputes `energyAmount` via `Transaction.getEnergyCost` (`transactions/Transaction/finalized.js:3-32`) |
| Status polling | `GRPCClient.getBlockItemStatus` (`GRPCClient.d.ts:94`) via `ConcordiumTransactionSubmitter.awaitFinalization` |
| Signer boundary | `IpcSponsorSigner` delegates `submitTransaction`/`waitForFinalization` to the injected `ConcordiumTransactionSubmitter` (TASK 51) |

### HASH CORRECTION

`Transaction.finalize` recomputes `energyAmount` from the payload, signatures and header
(`preFinalized`), so the hash the node reports is the hash of the **finalized** transaction,
not of the pre-finalized signed JSON that TASK 29 hashed. Persisting the pre-finalized hash
made step 15 fail with `hashMismatch` for every V1 transaction — a defect that TASK 49–51 never
surfaced because their tests never compared the transport's hash to a core-persisted hash.

Added `computeFinalizedTransactionHash(txJson)` in `services/facilitator/src/signer.ts`
(`signableFromJSON` → `finalize` → `getAccountTransactionHash`). `FacilitatorCore` step 10 and
the mock/ledger signers now use it. `computeTransactionHash` is retained unchanged for callers
that explicitly want the pre-finalized hash (e.g. `test/task29-prebroadcast.test.mts`).

### HASH CORRECTION REGRESSION (TASK 52.1)

The finalized hash covers the sponsor signature. `AccountTransactionV1.serializeSignatures`
calls `serializeAccountTransactionSignature(signatures.sponsor)`, and that function throws
`No signatures were provided` for an empty map. The mock signer returned the transaction with
`signatures.sponsor = {}` (it "signs nothing"), so:

| Step | Before 52.1 | After 52.1 |
|---|---|---|
| `addSponsorSignature` | returns input + `__simulated`/`__mocked`, sponsor slot empty | also fills the empty sponsor slot with `MOCK_SPONSOR_SIGNATURE` (`'bb'.repeat(64)`) |
| `computeFinalizedTransactionHash` | throws `No signatures were provided` | returns the 64-hex finalized hash |
| core step 10 | `hash_computation_failed` | persists the finalized hash |
| mock `submitTransaction` | (unreachable) | returns the same finalized hash → step 15 comparison passes |

The fix is confined to the mock signer. Production hash validation, the `txHash !== persistedHash`
comparison in `FacilitatorCore` step 15, and `computeFinalizedTransactionHash` itself are
unchanged; nothing was weakened to satisfy the test.

`MOCK_SPONSOR_SIGNATURE` is exported so tests can assert the fixture, and `fillMockSponsorSlot`
only touches V1-transaction-shaped input with an *empty* sponsor map — an already-signed slot is
preserved, and non-transaction input is returned untouched (test 02/03).

Regression suite: `test/task52.1-finalized-hash-agreement.test.mts` (7 tests), which pins that
the mock path, `computeFinalizedTransactionHash`, `Transaction.finalize` +
`Transaction.getAccountTransactionHash`, and the real `GrpcConcordiumTransport.submit` boundary
all produce the same hash, plus the exact B06 scenario.

## RECOVERY

New: `FacilitatorCore.recoverPending(): Promise<RecoverySummary>` (aliases `recover()`,
`recoverSettlements()`), backed by `SettlementRepository.listRecoverable()`, which selects rows
in `submitting | outcome_unknown | observed | recovery_unavailable` **with a non-null
`tx_hash`**.

Recovery rules, in order:

1. **Never calls `submitTransaction`.** It only calls `signer.waitForFinalization(hash)`.
2. A `submitting` row is first advanced to `outcome_unknown` (`markBroadcast`) — a crash
   between the broadcast claim and `markBroadcast` leaves the state ambiguous, and ambiguous
   is the correct interpretation.
3. The **recorded** hash is polled. No caller-supplied hash exists on this API.
4. `finalized` is applied only through `store.reconcile()`, which independently re-checks the
   recorded hash from `settlements` — a second gate.
5. A transport error, malformed status, or throw is non-terminal: `markPending` + counted in
   `transportErrors`. Never success.
6. Repeated passes are idempotent: terminal rows are not selected; non-terminal rows are
   re-polled and never create rows. `payments` and `settlements` are keyed by
   `payment_digest`, so a duplicate row cannot exist.

`RecoverySummary = { scanned, finalized, failed, pending, transportErrors, skipped }`.

## CRASH AND RESTART BEHAVIOR

| Boundary | Durable after crash | Recovery outcome |
|---|---|---|
| Before `prepare` | no hash | not recoverable; not submission-eligible |
| After `prepare`, before `claimSubmit` | hash, state `prepared` | normal settle resumes (`resumable` claim); recovery does not select it |
| After `claimSubmit`, before `submitTransaction` | hash, state `submitting` | recovery advances to `outcome_unknown`, polls by hash, never resubmits |
| After `submitTransaction` returned, before `markBroadcast` | hash, state `submitting` | same as above (`outcome_unknown`) |
| After `markBroadcast`, before finalization observed | hash, state `outcome_unknown` | recovery polls by hash |
| After finalization, before reconcile | hash, state `outcome_unknown` | recovery reconciles to `finalized`/`rejected` |
| After reconcile | hash, state `finalized`/`rejected` | terminal; not selected |

Verified with a real SIGKILL child process (`scripts/task52-crash-child.mts`).

## RECOVERY GUARANTEES AND LIMITATIONS

Guarantees:
- No automatic resubmission, ever. Recovery has no submission code path.
- A terminal rejection is never reopened (`transition rejected → finalized` does not exist).
- A transport failure cannot produce success.
- Repeated recovery is safe (idempotent by `payment_digest`).

Limitations:
- **No automatic scheduler.** `recoverPending()` is a method; nothing calls it on boot. A
  caller (server startup, or a cron) must invoke it. This is deliberate — auto-recovery from a
  disabled settlement path would be a behaviour change beyond TASK 52's scope.
- **`prepared` rows are not recovered.** They are resumed by a normal `/settle` for the same
  payload (the `resumable` claim). Recovery intentionally does not submit.
- **Row-by-row, not bounded.** A large backlog is scanned serially; each `waitForFinalization`
  is bounded by `finalizationTimeoutMs`, so worst case is `rows × timeout`.
- **Evidence source is the signer.** `evidenceSource = <sponsor>/recovery`; there is no
  independent verifier in this path (unlike `ReconciliationService`).
- **No cross-process lock.** Two cores recovering the same DB concurrently are safe (both
  transitions are idempotent and guarded), but both may poll; only one reconcile wins.

## TEST RESULTS

```
dedicated suite:
  npx tsx test/task52-core-submission-recovery.test.mts
  task52: 18/18 passed, 0 failed

B06 regression suite (TASK 52.1):
  npx tsx test/task52.1-finalized-hash-agreement.test.mts
  task52.1: 7/7 passed, 0 failed

focused suites:
  task48: 24/24 passed, 0 failed   (was 23/24 before the B06 fix)
  task49: 21/21 passed, 0 failed
  task50: 27/27 passed, 0 failed
  task51: 27/27 passed, 0 failed

repository suite (npm test):
  all 45 suites passed
```

Tests:

1. `01. complete V1 lifecycle: success requires confirmed finalization`
2. `02. a committed (non-final) node status never yields success`
3. `03. a finalized rejection is terminal failure, not success`
4. `04. the transaction hash is persisted before submission`
5. `05. a persistence failure aborts before any submission`
6. `06. restart with a persisted hash recovers finalization without resubmitting`
7. `07. restart while still pending keeps the payment non-terminal`
8. `08. restart after finalized success is a no-op (idempotent) and never resubmits`
9. `09. restart after finalized rejection stays terminal and is never reopened`
10. `10. repeated recovery is safe and creates no duplicate records`
11. `11. recovery with an unknown/malformed status stays non-terminal`
12. `12. a transport failure during recovery is not success and not a resubmission`
13. `13. a signer without a configured submitter stays fail-closed`
14. `14. recovery without a configured submitter never reports success`
15. `15. real process: SIGKILL after submit, restart recovers from the persisted hash`
16. `S01. DENY_ALL_FACILITATOR remains intact`
17. `S02. settlement stays disabled by default`
18. `S03. recovery exposes no submission method of its own`

## TYPECHECK RESULTS

```
npm run build                                                    rc=0
npx tsc --noEmit                                                 rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)    rc=0
```

## REMAINING BLOCKERS

1. **`recoverPending()` is not scheduled.** No startup hook or cron invokes it; the server must
   call it explicitly. Adding that wiring changes runtime behaviour and is left to a follow-up.
2. **Settlement stays disabled by default.** `DENY_ALL_FACILITATOR` and `allowSettlement: false`
   are unchanged; the V1 path is reachable only through an explicitly injected submitter.
3. **A real `GRPCClient` + funded sponsor account** are still required for any live path.
4. **`sendAccountTransaction` compatibility seam** in `GrpcConcordiumTransport` should be
   removed once no legacy V0 fakes remain.
5. **No independent evidence verifier in the recovery path** — it trusts the submitter's
   status. A stricter design would route recovery through `ReconciliationService`.
6. **Hash function change is observable.** Any caller that persisted a pre-finalized hash
   (TASK 29-era rows) would now mismatch. No such persisted rows exist in this repository
   (DB paths are test-temporary), but a production migration would need to re-derive.

## FILES CHANGED

- `services/facilitator/src/core.ts` — `computeFinalizedTransactionHash` at step 10;
  `RecoverySummary`; `recoverPending()` / `recover()` / `recoverSettlements()`.
- `services/facilitator/src/repository.ts` — `listRecoverable()` (+ `listOutcomeUnknown()`,
  `recoverablePayments()` aliases) on the interface and the SQLite implementation.
- `services/facilitator/src/signer.ts` — `computeFinalizedTransactionHash`; mock and ledger
  signers use it; **TASK 52.1**: mock `addSponsorSignature` fills an empty sponsor slot with
  `MOCK_SPONSOR_SIGNATURE` (exported) via `fillMockSponsorSlot`; ledger signer delegates to it.
- `test/task52-core-submission-recovery.test.mts` — 18 tests.
- `test/task52.1-finalized-hash-agreement.test.mts` — 7 tests (B06 regression + agreement proof).
- `scripts/task52-crash-child.mts` — real SIGKILL crash child.

No commits, no pushes. HEAD unchanged:
`4c8994db391d77796e06e49c843c42be1eae615b`.
