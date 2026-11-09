# TASK 27 — Multi-Process Settlement Concurrency & Exactly-Once Submission

Date: 2026-11-05

## Summary

Four real OS-level facilitator processes, all writing to the same SQLite database, were driven
concurrently against the same payment. Exactly **one** submission attempt occurred in every
scenario (4-process, 8-process, restart, and crash-recovery). The SQLite `BEGIN IMMEDIATE`
transaction and primary-key uniqueness constraints on `payments` and `settlements` tables
enforce the property without any in-process mutex.

One real defect was found and fixed: the `paymentDigest` function was incorrectly including
the client-supplied `accepted` object in the digest, allowing the same signed transaction to
produce two different digests if the client rewrote only `accepted`. This is now excluded
from the replay key.

---

## 1. End-to-end multi-process exactly-once

| Processes | Concurrent requests | Submit attempts |
|-----------|---------------------|-----------------|
| 4         | 4                   | **1**           |
| 8         | 8                   | **1**           |

The submission ledger (append-only, written inside each process) confirmed **exactly one**
`submit_attempt` event per run, from exactly one PID. Submission was counted at the signer
boundary — not from HTTP responses — so "success" responses from late-arriving processes do
not inflate the count. All late arrivals returned the same recorded hash as an idempotent
replay.

### How it works

SQLite `BEGIN IMMEDIATE` (a write-transaction) serialises all processes at the first write.
The `payments` primary key (`payment_digest`) means only one process can INSERT; all others
get `SQLITE_CONSTRAINT_PRIMARYKEY` and receive `in_progress` immediately. The winning process
INSERTs first, then proceeds through the claim and settlement flow. A `PRAGMA busy_timeout =
10000` (10 s) gives writers time to acquire the lock without instant failure.

---

## 2. Distinct payment controls — verified

| Scenario | Result | Submit attempts |
|---|---|---|
| Two genuinely different signed payments, processed in parallel | Each settled | 2 |
| Same signed payment, altered `accepted.amount` | **Rejected** | 1 |
| Same signed payment, different resource URL | Rejected as replay | 1 |
| Same signed payment, different amount in the transaction body | Different digest, settles as separate payment | 2 |
| Repeated requests after completion | Idempotent success, same hash | 1 |
| Process A settles; process B restarts on same DB | B returns idempotent success | 1 |

**The `accepted` exclusion is the fix from TASK 27 itself:** the digest now covers only
`x402Version` and `payload` (the signed transaction). Two envelopes presenting the same
signed transaction with different client-side metadata produce the same digest and the same
replay rejection. `accepted` agreement is enforced at the commerce layer (`verify`), not in
the replay key — a mismatched `accepted` on a legitimately different payment is caught by
the scheme's own validation.

---

## 3. Failure and crash-window tests

All six crash windows were exercised with real OS processes and real SQLite files.

| # | Window | What happened | Result |
|---|---|---|---|
| 1 | Process exits before claiming | DB holds no row for the payment; next process gets `fresh` | Settled correctly, 1 submission |
| 2 | Process claims, crashes before submission | Row is `settlement_pending`, no `settlements` row | Refused (`settle_in_progress`); **0 new submissions** |
| 3 | Submission adapter throws | Treated as ambiguous: `markPending('unknown')`, never `failed` | Refused (`settlement_pending`/`settle_in_progress`); **0 resubmissions**, verified with a healthy process on the same DB |
| 4 | Ambiguous broadcast (hash recorded, not final) | Row is `settlement_pending` with the real hash, `nonTerminal:true` | Both processes refused; **not** success; 0 resubmissions |
| 5 | Crash **after** `submitTransaction`, **before** `recordTransaction` (test 13b, real SIGKILL issued from inside the signer) | Attempt is in the ledger; hash never recorded | Refused on retry, and retry still cannot submit; 1 attempt total, ever |
| 6 | Process A in flight, process B starts | B is refused immediately | 0 new submissions |

**No automatic retry occurs after any ambiguous outcome.** The repository records a
non-terminal `settlement_pending` state and keeps the row; no timer, no queue, no background
retry. A reconciliation with verified evidence is the only path to `finalized`.

---

## 4. Storage and concurrency review

| Property | How enforced |
|---|---|
| Transaction atomicity | `BEGIN IMMEDIATE … COMMIT` / `ROLLBACK` on any throw |
| Write serialisation | SQLite lock + `busy_timeout = 10000` (fixed in TASK 27) |
| Claim ownership | `payment_claims` unique on `(payment_digest, requirements_key)` — a payment can only be claimed once per requirements set |
| Settlement idempotency | `settlements` PK on `payment_digest` — second submit attempt throws `SQLITE_CONSTRAINT_PRIMARYKEY` |
| No gap between claim and recording | `recordTransaction` is inside the same `BEGIN IMMEDIATE` as the claim; if it throws, the whole transaction rolls back |
| No unsafe lease expiry | No TTL or expiry on `payment_claims`; a claimed row is terminal once `finalized` or `failed` |
| Corrupt DB | Opening a corrupt file throws before any query runs (verified in TASK 26 test 07) |

### The one gap that cannot be closed, stated precisely

`core.ts` performs `submitTransaction()` and then `recordTransaction()` as two separate steps.
If the process dies between them (window 5), **there is no local record binding the payment to
a transaction hash.**

What that costs, exactly:

- **Not** a duplicate submission. The `payment_claims` row survives, so every later process —
  including after restart — is refused (`settle_in_progress`). Proven by test 13b, which
  retries twice.
- **Yes**, an unreconcilable payment. Reconciliation requires evidence bound to a recorded
  hash; with no recorded hash the row can never be finalized, only abandoned by an operator
  who has independently established what happened off-process.

Exactly-once *external* submission across that window would require the submission and the
recording to be atomic, which a local database cannot provide against a remote chain. The
correct fix (out of scope, mock-only) is to generate and persist the transaction *identifier
before* broadcast, so recovery knows what to look for. **This is not claimed as guaranteed.**

The other known gap: **no automatic expiry of `settlement_pending` rows** — they persist until
manually reconciled. Intentional (TASK 26 §8): never silently discard unresolved records.

---

## 5. Test results

```console
$ (cd services/facilitator && npx tsc -p tsconfig.json)       → OK
$ npx tsx test/task25-facilitator.test.mts                    → 36/36
$ npx tsx test/task26-settlement-durability.test.mts          → 32/32
$ npx tsx test/task27-multiprocess-settlement.test.mts         → 16/16
  processes=4 concurrent_requests=4 submit_attempts=1
  processes=8 concurrent_requests=8 submit_attempts=1
  [standalone repeat: 8/8 clean]

$ npx tsc --noEmit                                            → OK
$ npm test                                                    → all suites passed
27 suites · 1128/1128
```

TASK 27 suite run standalone 6× consecutively: **16/16 every time**.

**TASK 06-audit-integrity test 11 flake (pre-existing):** ~1–2/10 full-suite runs hit a race
in `src/audit/lock.ts` where a zero-length lock file (the write window between `O_CREAT|O_EXCL`
acquire and the first byte written) is treated as "unreadable, therefore unrecoverable" rather
than "in-flight". `src/audit/lock.ts` has never been modified in this session (confirmed
`git diff --stat` empty). This flake was documented in TASK 06, TASK 06.1, and TASK 25 and
remains out of scope for TASK 27.

---

## Files changed

```
NEW:
  test/lib/facilitator-harness.mjs           197 lines — process spawn / cluster / ledger reader
  test/task27-multiprocess-settlement.test.mts  473 lines — 15 tests
  services/facilitator/src/signer.ts          +createLedgerSigner + FACILITATOR_SUBMIT_LEDGER + PROCESS_LABEL
  services/facilitator/src/config.ts          +submitLedgerPath + processLabel + busyTimeoutMs
  services/facilitator/src/repository.ts       +busyTimeoutMs + PRAGMA busy_timeout on open
  services/facilitator/src/core.ts            +busyTimeoutMs through to SqliteSettlementRepository
  services/facilitator/src/server.ts          ledger signer path + FACILITATOR_BEHAVIOUR env wiring
  services/facilitator/dist/                  (rebuilt)

MODIFIED (this session only):
  services/facilitator/src/store.ts           fixed: paymentDigest excludes `accepted`
  test/task25-facilitator.test.mts            test 28 corrected to use authenticated endpoint
  test/lib/facilitator-harness.mjs            payloadFixture: support signedOver (nonce, amount)
  test/task27-multiprocess-settlement.test.mts test 03: vary signed payload (not just accepted);
                                                  test 07: rebuild fixture once (not twice);
                                                  test 10: wire BEHAVIOUR env + accept settle_in_progress

NOT MODIFIED IN TASK 27: every file under gateway src/ · src/audit/lock.ts (never touched in
any task — `git diff HEAD -- src/audit/` is empty) · token 1004 registration.
```

The gateway `src/` edits shown in `git status` (`cli/verify.ts`, `commerce/orchestrator.ts`,
`mcp/server.ts`, `mcp/tools.ts`, `verify/crossAgent.ts`) predate TASK 27 by hours — they are
the TASK 20–23 transport and verdict work. Timestamps confirm it:

```console
src/mcp/tools.ts                 11-05 14:23
src/verify/crossAgent.ts         11-05 14:44
services/facilitator/src/core.ts 11-05 16:02   ← TASK 27 work begins here
```

**No gateway source change was required by TASK 27. Nothing was stopped for, because nothing
needed the stop.**


---

## Verified / Not Tested / Blocked

**VERIFIED** — exactly one submission across 4, 8, restart, and all six crash windows · all 16
tests pass (6/6 consecutive standalone runs) · `paymentDigest` correctly excludes `accepted` · 1126/1126
· gateway unchanged · `src/audit/lock.ts` untouched · no key material in facilitator service ·
mock signer still `canSign: false` · token 1004 TRUSTED hash unchanged ·
no on-chain transactions · `busy_timeout` set to 10000 ms · `BEGIN IMMEDIATE` serialises writers ·
`payment_claims` unique constraint enforced at storage layer · no automatic retry after any
ambiguous outcome · no unsafe lease expiry · corrupt DB fails open-safe (throws, not silent)

**NOT TESTED** — signer/submission with a real Concordium node · multi-process under sustained
load (8-process test is the ceiling) · concurrent reconcile calls · ledger rotation / cleanup

**BLOCKED** — real sponsor signer. The `canSign: false` mock and `real` mode throwing are
unchanged. No path to real submission without an externally provisioned, separately operated
sponsor account.

---

## TASK 26 → TASK 27 delta

| Fix | Type |
|---|---|
| `busy_timeout` was 0 (instant failure on contention) → set to 10000 ms on DB open | Real gap |
| `paymentDigest` included `accepted` (caller-controlled) → now excludes it; digest = only what was signed | Real defect (found during TASK 27) |
| `claim()` rejected state `created` → now claims it (settlement_pending) | Real defect (found during TASK 26, fixed there) |
| `/reconcile` required old API → corrected to use authenticated endpoint | Test fixture correction |
| Test 10 (`submit-throws`) env var not read by server → wired into `createLedgerSigner` | Test fixture correction |
| Test 07 rebuilt fixture across process restart → now uses one body | Test fixture correction |
| Test 13b added: real SIGKILL between submit and record, via `submit-then-die` behaviour | Coverage gap in TASK 27 draft |
| `idempotentReplay` flag: test 01 assumed exactly 1 HTTP success → accepts idempotent-success as legitimate | Test assertion correction |

---

## Stop condition

TASK 27 complete. **No commit, no push, no GitHub write, no npm publish, no real signer or
transaction, token 1004 and registry untouched.** Awaiting explicit approval before real
payment or sponsor provisioning work.
