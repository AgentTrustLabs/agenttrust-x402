# TASK 53 — Transaction Lifecycle Idempotency & Recovery Concurrency

## VERDICT

**PASS WITH CONDITIONS.**

Duplicate requests cannot produce a second submission for the same logical request, and
concurrent recovery cannot produce duplicate submissions or a renamed hash. Three
repository-layer gaps were confirmed by direct probing and fixed. One further concurrency
limitation (evidence divergence between workers, GAP E) was confirmed by an independent probe
written for this task and is **documented, not fixed** — closing it would change the established
transaction lifecycle (terminal states becoming reopenable), which TASK 53 forbids.

Additionally, running the full suite surfaced a pre-existing defect unrelated to idempotency:
three TASK 29 fixtures used a sponsor address that the wire converter rejects
(`wrong_sponsor`), which made two suites fail and two others hang forever waiting for a
SIGKILL that never came. Fixed as fixture-only changes (no production code touched); see
"Collateral fixture repair".

## EXISTING IDEMPOTENCY ARCHITECTURE

Request identity is the durable payment digest, not a caller-supplied key:

- `paymentDigest(payload)` (`services/facilitator/src/store.ts`) = `sha256({ x402Version, payload })`.
  It deliberately excludes `resource` and `accepted`, so the same signed transaction presented
  against a different resource/amount cannot produce a second settlement.
- `requirementsKey(requirements, resourceUrl)` binds what the payment authorises
  (`network|payTo|amount|asset|resource`). `claim()` refuses a second authorisation for a
  different key (`different_authorisation`).
- `verify()` writes `noteVerified()` durably before `/settle` is reachable.
- `/settle` takes an atomic `claim()` (`BEGIN IMMEDIATE`): one caller gets `fresh`, a duplicate
  gets `idempotent` / `pending` / `in_progress` / `terminal`. The uniqueness constraints, not an
  application-level `if`, make concurrent duplicates impossible.
- The hash is durable before broadcast: `prepare()` (`created → prepared`, `synchronous=FULL`,
  `INSERT OR IGNORE` on `settlements`), then `claimSubmit()` (`prepared → submitting`), then
  `submitTransaction()`. `claimSubmit()` refuses unless the row is `prepared` AND the hash
  matches exactly — this is the single gate for "at most one submission".
- Recovery (`recoverPending()` in `core.ts`) never calls `submitTransaction`. It selects rows in
  `submitting | outcome_unknown | observed | recovery_unavailable` with a non-null `tx_hash`
  (`listRecoverable()`), polls the **recorded** hash, and only `reconcile()` can set a terminal
  state.
- `reconcile()` is atomic and refuses any observation that does not name the exact recorded hash
  (it reads `settlements.tx_hash`, not the caller's claim). Terminal `finalized` is idempotent
  (`changed:false`); terminal `rejected` is never reopened.

Verified directly in source, not inferred from prior reports:
`repository.ts:39` (`BROADCAST_CAPABLE`), `:399` (`claim`), `:522` (`prepare`), `:547`
(`claimSubmit`), `:577` (`markBroadcast`), `:660` (`markFailed` guard), `:681` (`reconcile`),
`:838` (`listRecoverable`), `:972` (`tx` = `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`).

## CONFIRMED RACE CONDITIONS

Each gap was reproduced against `SqliteSettlementRepository` before the fix.

### GAP A — `markPending()` overwrote the persisted hash (FIXED)

`markPending()` had no hash guard, unlike `prepare`, `markBroadcast`, `markObserved`, and
`recordTransaction`. Probe result:

```
prepare(A) -> prepared, tx_hash=A
markPending(B) -> threw="" ; payments.tx_hash=B, state=outcome_unknown
reconcile(A) -> {ok:true, changed:true, state:'finalized'}   <-- stale settlements row (A)
claimSubmit(A) -> {ok:false, reason:'hash mismatch: recorded=B requested=A'}
claim() -> {ok:true, claim:'idempotent', transaction:A}      <-- payments says B
```

`payments.tx_hash` and `settlements.tx_hash` diverged; recovery could poll a hash that
`reconcile()` then rejected, while `claim()` still returned the stale hash.

**Fix:** `markPending()` throws `markPending: hash mismatch recorded=… given=…` when
`payments.tx_hash` is non-null and differs from the supplied transaction. A matching hash is
still recorded idempotently.

### GAP B — `markPending()` advanced `prepared` → `outcome_unknown` (FIXED)

A `prepared` row has a durable hash but the broadcast claim was never taken, so nothing can be
in flight. The old branch `row.state === 'submitting' || row.state === 'prepared'` marked it
`outcome_unknown`, which is semantically wrong (it claims a broadcast happened) and hides the
row from the resumable path.

**Fix:** only `submitting` transitions to `outcome_unknown`. `prepared` keeps its state and its
hash; a normal duplicate `/settle` still resumes it via `claimSubmit()`.

### GAP C — `markFailed()` could reject a broadcast-capable payment (FIXED)

`markFailed()` allowed `prepared → rejected`, `submitting → rejected`,
`outcome_unknown → rejected`, and `observed → rejected`. Probe result:

```
markFailed from outcome_unknown -> rejected
reconcile(finalized) -> {ok:false, reason:'payment is terminally rejected; evidence cannot reopen it'}
```

A late failure from a stale path (e.g. a duplicate request re-running the pre-broadcast checks
while recovery was polling) could permanently reject a payment the chain had actually finalized,
and `listRecoverable()` would never select it again.

**Fix:** `markFailed()` is a no-op when `payments.tx_hash` is non-null **and** the state is
broadcast-capable (`submitting`, `outcome_unknown`, `observed`, `recovery_unavailable`). Only
`reconcile()` may set a terminal state once a broadcast may have happened. `prepared` is exempt:
the claim was never taken, so nothing is in flight and the legacy reject still applies. A
divergent `transaction` argument is also refused so a failure record can never rename the hash.

### GAP D — resumable path skips wire conversion (DOCUMENTED, NOT FIXED)

On a `resumable` claim the core passes `payload.payload` (the x402 V2 `{ signedTransaction }`
wrapper) straight to the signer. The production `SdkSponsorSigner.addSponsorSignature()` unwraps
it and calls `Transaction.signableFromJSON`, which requires `header.executionEnergyAmount` and
`header.sponsor.account`. The V2 client shape has neither (it uses `sponsor.address` and omits
energy). Confirmed with a real Ed25519 test key:

```
sdk sponsor signer: invalid transaction: Failed to find executionEnergyAmount in object
submits = 0 ; state = prepared ; hash preserved = true
```

The failure is fail-closed: no submission, no state corruption, the durable hash is intact and
the row remains resumable. But the resumable path cannot complete for a V2 `address` payload.
Fixing it requires running `convertV2ToSdkV1` with the policy-derived energy on the resumable
path, which changes the established lifecycle; deferred.

### GAP E — evidence divergence between concurrent recovery workers (DOCUMENTED, NOT FIXED)

Probed for TASK 53 with `scripts/task53-probe-evidence-ordering.mts`. Two sequential recovery
passes against one persisted hash, where the transport answers `failed` and then `finalized`:

```
worker A (observed failed)    -> {"scanned":1,"finalized":0,"failed":1,...}
worker B (observed finalized) -> {"scanned":0,"finalized":0,"failed":0,...}
final state                   -> rejected tx_hash=dede…dede
RESULT single terminal state: true
RESULT first observation wins (rejected is sticky): true
RESULT duplicate settlement rows: false
RESULT hash renamed: false
```

Concurrency safety holds: one terminal state, one settlement row, hash never renamed. But the
**first observation wins even when a later observation contradicts it**, because `rejected` is
terminal and `reconcile()` refuses to reopen it (correctly — a rejection must never be silently
upgraded). The consequence: if a transport returns a spurious `failed` for a transaction the
chain actually finalized, the payment stays `rejected` permanently and only an operator
intervention can correct it.

This is a property of the terminal-state design, not a duplicate-submission hazard, and TASK 53
explicitly forbids changing the lifecycle. Fixing it would require either (a) making `rejected`
reopenable (weakens "finalized success and finalized rejection stay distinguishable" and the
terminal-state invariant), or (b) requiring quorum/confirming evidence before applying a
rejection (a lifecycle change, not an idempotency fix). Deferred to a follow-up.

### Non-gaps verified

- **Concurrent duplicate `/settle`**: `claim()` is atomic; the second caller is refused. No
  second `submitTransaction` call.
- **Two recovery workers on one hash**: both poll the same hash; `reconcile()` is atomic, so
  exactly one wins and the terminal state is unique. The second worker gets
  `{ok:true, changed:false, reason:'already finalized'}`.
- **Recovery racing a duplicate request**: the duplicate either gets `settlement_pending`
  (in-flight) or an idempotent replay of the persisted hash. Neither submits.
- **Recovery racing `claimSubmit()`**: `markBroadcast()` is idempotent; the second
  `claimSubmit()` is refused with `not prepared (state=submitting)`.
- **Duplicate `prepare()`**: same hash → `illegal transition`; different hash → `refusing to
  overwrite recorded transaction`.
- **Duplicate-key writes**: `payments` and `settlements` are keyed by `payment_digest`; the
  latter uses `INSERT OR IGNORE`, so duplicate rows cannot be created.
- **Settlement stays disabled**: `DENY_ALL_FACILITATOR` (`src/payments/x402.ts:411`) unchanged;
  `/reconcile` is 404 when no operator credential is configured (`server.ts`), so no
  unauthenticated path can mutate state.

## CHANGES AND DESIGN DECISIONS

Production changes are confined to `services/facilitator/src/repository.ts`. No lifecycle
ordering change, no new database, no distributed locking framework.

| Change | Rationale |
|---|---|
| `markPending()`: terminal no-op + hash-mismatch guard | The persisted hash is the recovery authority; no write may rename it. Matches the guards already present on `prepare`/`markBroadcast`/`markObserved`/`recordTransaction`. |
| `markPending()`: `prepared` no longer → `outcome_unknown` | `outcome_unknown` means "a broadcast may have happened". `prepared` has no broadcast claim, so it must stay resumable. |
| `markFailed()`: no-op on broadcast-capable rows with a hash | Once a broadcast may have happened, only verified evidence (`reconcile`) may set the terminal state. |
| `markFailed()`: refuse a divergent `transaction` argument | A failure record must never rename the recorded hash. |
| `BROADCAST_CAPABLE` constant | Single source of truth for the states in which a broadcast may be in flight. |

**Why no lock:** SQLite `BEGIN IMMEDIATE` plus the unique keys already serialise every write, and
`busy_timeout` (5000 ms, `repository.ts:341`) makes a contending writer wait rather than fail.
Adding a cross-process lock would duplicate what the durable state machine guarantees and
introduce a new failure mode. Concurrent recovery workers doing redundant polls is wasted work,
not a correctness defect.

**Why `prepared` is exempt from the `markFailed` guard:** the broadcast claim was never taken,
so no submission can be in flight; the legacy `prepared → rejected` transition is preserved for
compatibility.

## COLLATERAL FIXTURE REPAIR (pre-existing, not a lifecycle change)

Running `npm test` end to end exposed a defect that has nothing to do with idempotency: three
TASK 29 fixture files declared the sponsor as `PAY_TO`
(`3whdieGHx43…`) while the mock signer's policy sponsor is
`3mockSponsorPlaceholderNotARealAccountAddress0000`. The wire converter correctly refuses with
`wrong_sponsor`, so the settle path never reached the injected `dieAt` boundary:

- `task29-prebroadcast` — 2 assertions failed (`still settleable`, `exactly one submission`).
- `task29-crashboundaries` — hung indefinitely at the `after-sponsor-sign` boundary (it awaits
  `proc.exited` after a SIGKILL that never happens).
- `task29.1-postsubmit-crash` — same latent hang.

Fixture-only changes: the sponsor field in the three fixtures now matches the mock policy
sponsor. No assertion was weakened, no production file touched. Note this means those suites
were **not actually exercising their boundaries** before; they now do.

## CONCURRENCY GUARANTEES AND LIMITATIONS

Guarantees:

- **At most one submission per logical request.** `claim()` is atomic; `claimSubmit()` is the
  single broadcast gate; a duplicate `/settle` is refused or replayed idempotently.
- **No automatic resubmission.** Recovery calls only `waitForFinalization`; `submitTransaction`
  is never reachable from `recoverPending()` (asserted structurally by test 13 and dynamically by
  the child-process submission ledger).
- **Persisted hash is the recovery authority.** Every hash-bearing write is guarded; recovery
  polls only `payments.tx_hash` / `settlements.tx_hash`, and `reconcile()` refuses any other
  hash.
- **No conflicting terminal states.** `reconcile()` is atomic; terminal states are never
  reopened; `markFailed()` cannot override a broadcast-capable row.
- **Finalized success and rejection stay distinguishable.** `interpretObservation` maps
  `finalized` → `finalized`, `failed`/`rejected` → `rejected`; pending/committed/transport error
  maps to `stay` and is never success.

Limitations:

- **Evidence divergence is first-wins (GAP E).** A spurious `failed` before a `finalized`
  permanently rejects the payment. Safe against duplication, but not self-correcting.
- **Recovery workers are not mutually exclusive.** Two workers may poll the same hash; the state
  machine makes this safe but the work is redundant. No lock added deliberately.
- **`prepared` rows are not recovered.** They are resumed by a normal `/settle` (the `resumable`
  claim). Recovery intentionally does not select them.
- **Resumable re-signing fails closed for V2 `address` payloads** (GAP D).
- **Row-by-row recovery.** A large backlog is scanned serially; each poll is bounded by
  `finalizationTimeoutMs`, so worst case is `rows × timeout`.
- **Evidence source is the signer.** Recovery trusts the submitter's status; there is no
  independent verifier in this path (unchanged from TASK 52).
- **No scheduler.** `recoverPending()` is a method; nothing invokes it on boot.

## TEST RESULTS

Focused suite (TASK 53), run as part of the full suite and standalone:

```
npx tsx test/task53-idempotency-recovery-concurrency.test.mts
task53: 13/13 passed, 0 failed
```

Full suite (`npm test`, 67 suites):

```
¶ all suites passed      EXIT=0
PASS count = 67 ; FAIL count = 0
```

Notable suites re-verified after the fixture repair:

```
task27-multiprocess-settlement: 16/16 passed        (8 processes, submit_attempts=1)
task29-prebroadcast:            65/65 passed
task29-crashboundaries:         21/21 passed
task29.1-postsubmit-crash:      49/49 passed
task34.13 IPC:                   7/7 passed
task3413-ipc-recovery:           7/7 passed  (requires uid 1001 + group 1002; skips cleanly otherwise)
task52:                         18/18 passed
task52.1:                        7/7 passed
task53:                         13/13 passed
```

TASK 53 tests map to the required scenarios:

1. `01. two identical sequential requests produce exactly one submission`
2. `02. two identical concurrent requests produce exactly one submission`
3. `03. two concurrent recovery processes never resubmit and cannot conflict` — **real OS processes**
4. `04. recovery racing a duplicate request never submits twice`
5. `05. process restart followed by repeated recovery is idempotent` — **real OS processes**, 3 restarts
6. `06. a duplicate request after finalized success returns the same hash only`
7. `07. a duplicate request after finalized rejection is refused and never reopened`
8. `08. a transport failure during concurrent recovery is never success`
9. `09. duplicate-key and conflicting-hash writes are refused, never duplicated`
10. `10. no automatic resubmission after a transaction hash has been persisted`
11. `11. a late failure cannot reject a payment whose broadcast is in flight`
12. `12. settlement stays disabled and DENY_ALL_FACILITATOR is intact`
13. `13. recovery exposes no submission path`

## TYPECHECK RESULTS

```
npm run build                                                    rc=0
npx tsc --noEmit                                                 rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)    rc=0
```

## REMAINING BLOCKERS

1. **Evidence divergence is first-wins (GAP E).** A stale `failed` observation permanently
   rejects a payment that later evidence shows as `finalized`. Requires a confirming-evidence
   rule or an operator override path — a lifecycle change, out of TASK 53 scope.
2. **Resumable re-signing for V2 `address` payloads (GAP D).** The resumable path skips
   `convertV2ToSdkV1`; such a payload fails closed at the signer. No submission occurs and the
   row stays `prepared`, but the payment cannot complete until a follow-up runs the converter
   with the policy-derived energy on the resumable path.
3. **`recoverPending()` is not scheduled.** No startup hook or cron invokes it (unchanged from
   TASK 52).
4. **Settlement stays disabled by default.** `DENY_ALL_FACILITATOR` and the absence of an
   operator credential for `/reconcile` are unchanged.
5. **A real `GRPCClient` + funded sponsor account** are still required for any live path.
6. **No independent evidence verifier in the recovery path** — it trusts the submitter's status
   (unchanged from TASK 52).

## FILES CHANGED

- `services/facilitator/src/repository.ts` — `BROADCAST_CAPABLE`; `markPending()` terminal
  guard, hash-mismatch guard, and `prepared` no longer → `outcome_unknown`; `markFailed()`
  no-op on broadcast-capable rows and refusal of a divergent hash argument.
- `test/task53-idempotency-recovery-concurrency.test.mts` — 13 tests.
- `scripts/task53-recovery-child.mts` — real-OS-process recovery worker (fake transport only;
  records any attempted submission as evidence).
- `scripts/task53-probe-evidence-ordering.mts` — GAP E probe (read-only evidence collection).
- Fixture repair (pre-existing defect, no production change):
  `test/task29-prebroadcast.test.mts`, `test/task29-crashboundaries.test.mts`,
  `test/task29.1-postsubmit-crash.test.mts` — sponsor address aligned with the mock policy
  sponsor so the wire converter no longer refuses before the boundary under test.

No commits, no pushes. No real transaction broadcast, no settlement, no private-key access or
operations. Token 1004 and its Agent Card are untouched. `DENY_ALL_FACILITATOR` and the
settlement default remain disabled.
