# TASK 49 — Concordium Transaction Submission & Finalization Adapter

## VERDICT

**PASS.** A dependency-injected submission/finalization adapter is implemented and verified
against a deterministic mock transport. No real transaction was broadcast; no network was
contacted by any test.

## SDK API CONTRACT

Verified against the installed SDK (`node_modules/@concordium/web-sdk`):

| SDK symbol | Source | Purpose |
|---|---|---|
| `GRPCClient.sendAccountTransaction(transaction, signature)` | `lib/esm/grpc/GRPCClient.d.ts:191` | Submit a signed account transaction; returns `TransactionHash.Type` (hex string). Re-serializes the payload and re-computes energy internally. |
| `GRPCClient.sendRawAccountTransaction(header, energyAmount, payload, signature)` | `GRPCClient.d.ts:208` | Low-level variant; the adapter does not use it. |
| `GRPCClient.getBlockItemStatus(hash)` | `GRPCClient.d.ts:94` | Returns `BlockItemStatus`: `PendingBlockItem` (received), `CommittedBlockItem`, or `FinalizedBlockItem`. |
| `GRPCClient.waitForTransactionFinalization(hash, timeoutMs?)` | `GRPCClient.d.ts:302` | Blocks until finalized or the timeout; returns `BlockItemSummaryInBlock`. |
| `TransactionHash.Type` | `types/TransactionHash.js` | Hex string. |
| `BlockItemStatus` | `types/blockItemSummary.d.ts` | `PendingBlockItem { status: 'received' }` / `CommittedBlockItem { status: 'committed', outcomes }` / `FinalizedBlockItem { status: 'finalized', outcome }`. |
| `BlockItemSummaryInBlock` | `types/blockItemSummary.d.ts` | `{ blockHash, summary }`; the summary may be a `FailedTransactionSummary` with `rejectReason`. |
| `isRejectTransaction` / `getTransactionRejectReason` | `types/blockItemSummary.d.ts` | Helpers for extracting a reject reason. |

Submission rejections arrive as thrown gRPC errors (`RpcError` with code `FAILED_PRECONDITION` /
`INVALID_ARGUMENT` / `NOT_FOUND`). The adapter preserves their messages verbatim.

## IMPLEMENTATION

New file: `services/facilitator/src/concordiumTransactionSubmitter.ts`.

- Class `ConcordiumTransactionSubmitter` taking an injected `ConcordiumTransactionTransport`.
- `transport.submit(signedTx): Promise<string>` — returns a 64-hex hash; throws on rejection
  or transport failure.
- `transport.getStatus(hash): Promise<TransportStatus>` — returns `{ status: 'pending' | 'finalized' | 'rejected', reason?, blockHash? }`.
- `submit(signedTx, opts?)` — validates structure, calls transport, normalizes the hash to
  lowercase. Never reports success before the transport returns a hash.
- `awaitFinalization(hash, opts?)` — bounded polling loop with timeout, interval, and
  `AbortSignal` cancellation. Returns `pending`? No — it never returns `pending` as a terminal
  state; a pending answer keeps polling until the deadline, then `timeout`.

## SUBMISSION FLOW

1. `submit()` validates the input shape (V1, header, payload, signatures with a non-empty
   sponsor signature). Malformed input throws before the transport is touched.
2. The transport's `submit()` is called. A thrown error is re-thrown as
   `submission rejected: <message>`.
3. The returned hash must be a 64-hex string; anything else throws
   `submission returned an invalid transaction hash`.
4. Only then is `{ hash, status: 'accepted' }` returned.

## FINALIZATION FLOW

1. Validate the hash shape (64 hex).
2. Loop until: aborted signal → `timeout`/`cancelled`; deadline exceeded → `timeout`;
   transport throw → `transport_error`; `finalized` → return with block hash;
   `rejected` → return with reason; anything else (including `pending`, `committed`, or an
   unrecognized status) → keep polling, then time out or fail closed.
3. Poll interval is clamped to the remaining budget so the loop cannot spin past the deadline.
4. No path returns `finalized` unless the transport said `finalized`.

## PIPELINE INTEGRATION CONTRACT

The adapter is implemented **independently**. Direct wiring into `FacilitatorCore.settle()`
would require activating submission, which is out of scope (settlement stays disabled by
default and `DENY_ALL_FACILITATOR` stays intact).

The future integration point is `FacilitatorCore.settle()` step 6
(`txHash = await this.signer.submitTransaction(sponsored)`), which currently throws
"never broadcasts". A future task (TASK 50+) may:

1. Construct a `ConcordiumTransactionSubmitter` with a real `GRPCClient`-backed transport.
2. Replace `IpcSponsorSigner.submitTransaction` (and `waitForFinalization`) with calls to
   `submitter.submit(sponsored)` and `submitter.awaitFinalization(hash, { timeoutMs })`.
3. Keep the ordering: authorization → sender verification → fee validation → convert →
   sponsor signing → hash → persist → submit → finalization. Submission and finalization stay
   outside the Signing Service.
4. Gate the whole path behind `allowSettlement` and maintainer approval.

Until then, `submitTransaction` keeps throwing, and settlement remains disabled by default.

## VERIFIED

Tests in `test/task49-transaction-submission-finalization.test.mts` (21 tests):

1. `01. successful submission returns the transport hash`
2. `02. the hash returned by submit propagates into awaitFinalization`
3. `03. duplicate submission: the adapter does not dedupe`
4. `03b. a transport that rejects a duplicate surfaces the rejection`
5. `04. submission rejection propagates the transport reason`
6. `05. malformed transactions are rejected before the transport is touched`
7. `06. pending status is reported as pending, never as success`
8. `07. finalized status is reported with the block hash`
9. `08. rejected status preserves the SDK reject reason`
10. `09. timeout is bounded and never becomes success`
11. `10. a transport error during monitoring is a transport_error, not success`
12. `11. an unrecognized status is a transport_error, not success`
13. `11b. a malformed status object fails closed`
14. `12. an aborted signal resolves as timeout/cancelled`
15. `12b. the abort signal can stop a wait mid-flight`
16. `12c. bounded polling: pending then finalized resolves on the second poll`
17. `13. no failure path reports finalized`
18. `S01. the adapter holds no key material or signing logic`
19. `S02. DENY_ALL_FACILITATOR remains intact`
20. `S03. settlement stays disabled by default (guardSettlement)`
21. `S04. constructing the adapter without a transport fails closed`

Additional safety properties asserted: no `sign`/`signTransaction`/`addSponsorSignature` method
on the adapter; no property whose name contains "privatekey"/"mnemonic"/"sign"/"key"/"seed".

## NOT TESTED

- A real `GRPCClient`-backed transport (mock only).
- `sendAccountTransaction` re-serializing a real signed transaction (the adapter accepts the
  already-signed shape but does not invoke the SDK serializer).
- `waitForTransactionFinalization` (the adapter polls `getStatus` instead, which is the
  equivalent of `getBlockItemStatus`).
- Duplicate detection at the node level (the transport decides; the adapter does not dedupe).
- Real network latency, RPC error codes, or finalization timeouts beyond the mock.

## BLOCKED

Nothing blocked. The adapter is independent of the payment pipeline; integration is deferred
to a future task that also activates settlement behind `allowSettlement` and maintainer
approval.

## TEST RESULTS

```
dedicated suite:
  npx tsx test/task49-transaction-submission-finalization.test.mts
  task49: 21/21 passed, 0 failed

full repository suite (npm run build && npm test):
  all suites passed
```

## TYPECHECK RESULTS

```
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)   rc=0
npx tsc --noEmit                                                rc=0
```

## HEAD BEFORE/AFTER

```
before: 4c8994db391d77796e06e49c843c42be1eae615b
after : 4c8994db391d77796e06e49c843c42be1eae615b   (no commits, no push)
```

Working tree only. New files: `services/facilitator/src/concordiumTransactionSubmitter.ts`,
`test/task49-transaction-submission-finalization.test.mts`, this document.

## CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| Mock transport only | OK — no `GRPCClient` is constructed anywhere in the suite. |
| No Testnet or Mainnet broadcast | OK. |
| No real transaction submission | OK. |
| No real settlement activation | OK — settlement stays disabled by default. |
| No wallet creation or import | OK. |
| No private-key access, generation, export, or signing | OK — `S01` asserts the adapter has no such method. |
| No sponsor funding or faucet | OK. |
| Token 1004 / Agent Card untouched | OK. |
| `DENY_ALL_FACILITATOR` intact | OK — S02. |
| Settlement disabled by default | OK — S03. |
| No schema changes | OK — none. |
| No unrelated infrastructure hardening | OK — only the adapter and its tests. |
| No commits or pushes | OK — HEAD unchanged. |

## REMAINING PREREQUISITES

1. A real `GRPCClient`-backed transport (injected, not implemented here).
2. A decision on whether `submitTransaction`/`waitForFinalization` on `IpcSponsorSigner` should
   delegate to this adapter or be replaced entirely.
3. Maintainer approval to activate settlement.
4. A funded Testnet sponsor account and a real signer (TASK 47/48 prerequisites).

## RECOMMENDED TASK50

**TASK 50 — Real GRPCClient Transport for the Submission Adapter (Mock-Free, No Broadcast)**

Scope:
1. Implement a `GrpcConcordiumTransport` that wraps `GRPCClient.sendAccountTransaction` and
   `getBlockItemStatus`, with a bounded timeout and error normalization.
2. Add a deterministic test using a fake `GRPCClient` (the same pattern as TASK 39) that
   proves the transport maps `PendingBlockItem`/`CommittedBlockItem`/`FinalizedBlockItem`/
   `FailedTransactionSummary` correctly, including reject reasons.
3. Document the transport boundary and the (still disabled) integration point.

Explicitly out of TASK 50: broadcast, settlement activation, account creation, funding,
`DENY_ALL_FACILITATOR` changes.

Stop condition: implementation, tests, typechecks, and documentation complete; then wait.
