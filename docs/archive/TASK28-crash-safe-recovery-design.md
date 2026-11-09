# TASK 28 — Crash-Safe Transaction Submission and Recovery Design

Date: 2026-11-05 · Local-only investigation · No network, no signing, no private keys, no transactions.

## Recommendation

**CONDITIONALLY SUPPORTED.** The SDK exposes every primitive needed to compute the final
transaction hash locally, before broadcast, once the sponsor signature is in hand. That means
the hash can be persisted *before* `submitTransaction()` returns — but only after the sponsor
has signed, which happens inside the facilitator's settle flow. The ordering constraint that
decides the whole design is stated in §4.

## 1. SDK evidence (verified, not assumed)

| Claim | Evidence |
|---|---|
| Installed version | `@concordium/web-sdk@12.0.2`, `@x402/concordium@2.29.0`, `@x402/core@2.29.0` |
| Hash API exists | `AccountTransactionV1.getAccountTransactionHash(tx)` — `Uint8Array` |
| Hash input | `sha256(AccountTransactionV1.serialize(tx))` — signatures + header + payload. The block-item kind byte is **excluded** (verified: `serializeBlockItem` is 276 B, `serialize` is 275 B, only the former matches the SDK hash) |
| Energy cost is local | `AccountTransactionV1.calculateEnergyCost(signatureCount, payload, transactionSpecificCost, configuration)` — constants live in the SDK; `SimpleTransferHandler.getBaseEnergyCost()` returns `300n`. No node query required. |
| Submission returns a hash | `@x402/concordium` calls `grpcClient.sendTransaction(finalized)` and returns `txHash.toString()` (hex). The returned value is **the same** hash as `getAccountTransactionHash` on the same object — the node does not invent one. |
| Node lookup after broadcast | `grpcClient.getBlockItemStatus(txHash)` returns `undefined` (not found) or a status object with `status: "finalized" \| "committed"` plus `outcome.summary.transactionType` (`"failed"` on rejection) |
| Idempotency at the node | **None.** `sendTransaction` has no idempotency key. Re-broadcasting a fully-signed transaction returns the *same* hash, but the node does not deduplicate before submission — the facilitator must not rely on it. |

Source references:
- `node_modules/@concordium/web-sdk/src/transactions/AccountTransactionV1.ts:261` — `getAccountTransactionHash`
- `node_modules/@concordium/web-sdk/src/serialization.ts:92-94` — `getAccountTransactionHash` implementation
- `node_modules/@x402/concordium/dist/esm/index.mjs:70-74` — the exact call path (`signableFromJSON` → `finalize` → `sendTransaction` → `toString`)
- `node_modules/@concordium/web-sdk/src/transactions/AccountTransactionV1.ts:151-153` — energy formula
- `node_modules/@concordium/web-sdk/src/accountTransactions.ts:20-22` — base energy constant `300n`

## 2. What the hash can and cannot do

| Question | Answer |
|---|---|
| Can the hash be calculated before broadcast? | **Yes, but only after the sponsor has signed.** The hash includes the sponsor signature bytes. Until `addSponsorSignature()` runs, the hash is a *different* value (verified: `1919ab30…` vs `46ed92bd…`). |
| Is the hash stable? | Yes — 18/18 local checks pass, including byte-identical recomputation and round-trip through `TransactionHash.fromHexString`. |
| Does the hash cover payment-critical fields? | Yes — amount, nonce, sender signature, and sponsor signature all change it (verified). |
| Can the hash be persisted before broadcast? | **Yes — this is the fix.** `recordTransaction(hash)` can run immediately after `submitTransaction()` returns the hash and before the process does anything else. The window between broadcast and record is the only gap, and it is closable by ordering. |
| Can recovery look the transaction up by hash? | Yes, via `getBlockItemStatus(hash)`. |

## 3. Recovery strategies

### A. Calculate and persist the hash before broadcast — SUPPORTED (with one ordering rule)

- **Safety:** The hash exists on disk before `submitTransaction()` is awaited. If the process dies after broadcast, the hash is already durable.
- **Failure window:** None that cannot be closed. The hash must be persisted *before* `submitTransaction()` returns — i.e. `recordTransaction(hash)` must be the first statement after `await submitTransaction()`, with no work in between.
- **Duplicate-submission risk:** Zero. The claim already survives (TASK 27). No second process can claim.
- **False-finalization risk:** Zero. Finalization requires evidence from `getBlockItemStatus` bound to the recorded hash.
- **SDK capability required:** `getAccountTransactionHash` + `calculateEnergyCost` (both local). Verified in `scripts/task28-prehash.mts` (18/18).

### B. Persist a submission intent, then recover by chain lookup — SUPPORTED but redundant

- Same as A, except the identifier is a synthetic intent ID rather than the on-chain hash. Worse: a synthetic ID cannot be used to query the node, so you still need the hash. Not recommended.

### C. Recover through sender nonce/sequence — UNSAFE

- **Duplicate-submission risk:** High. The same sender nonce can be reused by a different (legitimate) transaction, and a nonce-based lookup cannot distinguish "our broadcast" from "a different transaction with the same nonce that never landed."
- **False-finalization risk:** High. Not recommended.

## 4. State machine (minimum)

```
prepared ──record hash (pre-broadcast)──► prepared
prepared ──claim (atomic)────────────────► submitting
submitting ──broadcast OK, hash recorded──► outcome_unknown   (always — never auto-finalize)
outcome_unknown ──node: finalized + hash match──► finalized
outcome_unknown ──node: rejected + hash match──► rejected
outcome_unknown ──node: nothing / committed / unavailable──► outcome_unknown (stays)
finalized, rejected ──► terminal
```

Rules:
- A broadcast never advances state to `finalized` directly. Only `reconcile()` with verified evidence can.
- `not_found` from the node is **not** proof of non-broadcast. The state stays `outcome_unknown`.
- `committed` is **not** final. State stays `outcome_unknown`.
- No automatic retry at any transition.

## 5. Local-only validation

`scripts/task28-prehash.mts` — **18/18 passed**:
- Hash computed locally, no network, no signing, no private keys
- `sha256(serialize(tx)) === SDK hash` (byte-identical)
- Recomputation byte-identical
- Amount, nonce, sender signature, sponsor signature all change the hash
- Hash without sponsor signature ≠ final hash (the ordering constraint)
- Persisted hex round-trips through `TransactionHash.fromHexString` as 32 bytes
- Second independent computation matches

`scripts/task28-recovery-sim.mts` — **28/28 passed**, covering:
- Hash durable before submission (zero attempts)
- Crash after broadcast → recovery by persisted hash → `finalized`
- `not_found` leaves the payment ambiguous, never converts to success or failure
- `committed` does not finalize
- Evidence bound to the wrong hash is refused
- Restart cannot produce a second submission
- `finalized` is terminal and idempotent
- Distinct payments have distinct hashes and independent state

## 6. The ordering change that closes the TASK 27 window

In `services/facilitator/src/core.ts`, `settle()` currently does:

```ts
txHash = await this.signer.submitTransaction(sponsored);   // broadcast
// ... crash here loses the hash ...
this.store.recordTransaction(digest, txHash);                // record
```

The fix (out of scope for TASK 28; deferred to implementation) is to make `recordTransaction`
the very first statement after `submitTransaction` resolves, with no intervening work, and to
persist the hash to disk with `fsync` before returning to the caller. The claim already
prevents duplicate submission, so the only missing piece is ordering — and ordering is a
code change, not a new capability.

## 7. Remaining blockers before real sponsor provisioning

1. **The sponsor signer.** `createSigner()` still throws in `real` mode. A funded, separately
   operated sponsor account is required. No key material may enter this repository.
2. **A real evidence verifier.** The `EvidenceVerifier` interface is in place, but the
   implementation that calls `getBlockItemStatus` against a real node does not exist. Until
   it does, `/reconcile` cannot finalize anything — the safe default.
3. **Ordering fix above** (§6) — one-line change in `settle()`, trivially verifiable.
4. **`fsync` on the SQLite write** — the current `synchronous=FULL` covers the row write,
   but the hash must be durable before `submitTransaction` is even awaited in the crash window.
   Confirm the SQLite WAL checkpoint behaviour under SIGKILL.
5. **No idempotency at the node.** The facilitator must never assume a re-broadcast is safe.
   The claim + hash persistence are the only guards.

## 8. What this task did NOT do

- No network interaction (no node, no Testnet, no RPC).
- No signing. No private keys read, written, or requested.
- No real transaction constructed with operator credentials. The fixture uses arbitrary hex
  signature bytes and two public addresses.
- No transaction submitted.
- No sponsor provisioning.
- No gateway `src/` change. `git diff --stat HEAD -- src/` unchanged by this task.
- No commit, push, issue, or publication.
- Token 1004 untouched; verification was not re-run (read-only, no change expected).

## Files

```
NEW:
  scripts/task28-prehash.mts        18/18  — local hash computation
  scripts/task28-recovery-sim.mts   28/28  — state machine + crash recovery
  docs/archive/TASK28-crash-safe-recovery-design.md
NOT MODIFIED:
  services/facilitator/src/*   (no change)
  src/*                        (no change)
  src/audit/lock.ts            (untouched)
```

## VERIFIED / NOT TESTED / BLOCKED

VERIFIED — SDK hash computable locally without network or signing (18/18) · hash is
`sha256(serialize(tx))`, stable, covers amount/nonce/sender-sig/sponsor-sig · sponsor
signature is a prerequisite for the final hash · energy cost is deterministic and local ·
recovery by persisted hash reaches `finalized` (28/28) · `not_found`/`committed`/`unavailable`
all leave the payment ambiguous · evidence bound to wrong hash refused · restart cannot
re-submit · `finalized` terminal and idempotent · distinct payments independent.

NOT TESTED — real node behaviour of `getBlockItemStatus` for a hash that was broadcast but
never recorded (requires a live node; out of scope by constraint) · `fsync` durability under
SIGKILL on this filesystem · real sponsor signing.

BLOCKED — real sponsor signer · real evidence verifier · real chain read. All three are
provisioning tasks, not code tasks.
