# TASK 51 — V1 Sponsored Transaction Submission Path & Signer-Boundary Integration

## VERDICT

**PASS.** The V1 sponsored submission path (`Transaction.finalize` → `GRPCClient.sendTransaction`) is
implemented in `GrpcConcordiumTransport`, integrated through the existing `IpcSponsorSigner` boundary by
delegating to the TASK49 `ConcordiumTransactionSubmitter`, and verified with fake clients only. No live
RPC, no broadcast, no keys, and no settlement activation occurred.

## SDK CONTRACT EVIDENCE

Verified against `@concordium/web-sdk` 12.0.2:

| SDK symbol | Source | Notes |
|---|---|---|
| `Transaction.finalize(transaction: Signable): Transaction.Finalized` | `transactions/Transaction/finalized.d.ts` | Finalizes a pre-finalized/signable transaction. Throws if too many signatures. |
| `Transaction.signableFromJSON(json)` | `transactions/Transaction/signable.d.ts` | Parses V0/V1 signed JSON into a `Signable`. |
| `GRPCClient.sendTransaction(transaction: Transaction.Finalized): Promise<TransactionHash.Type>` | `grpc/GRPCClient.d.ts:174` | Handles V0 via `sendRawAccountTransaction` and V1 via `sendRawTransaction` (`GRPCClient.js:246-256`). |
| `GRPCClient.sendRawTransaction(transaction)` | `GRPCClient.js:257-266` | Serializes the finalized V1 block item and returns `TransactionHash.fromProto`. |
| `TransactionHash.Type` | `types/TransactionHash.d.ts` | Class instance; `.toString()` / `.toHexString()` produce 64-hex. |
| `TransactionHash.fromHexString(hex)` | `types/TransactionHash.d.ts` | Required because `getBlockItemStatus` expects `TransactionHash.Type`. |
| `GRPCClient.getBlockItemStatus(hash)` | `grpc/GRPCClient.d.ts:94` | Returns `BlockItemStatus`. |
| `Transaction.toLegacyAccountTransaction` | `transactions/Transaction/builder.d.ts` | V0-only compatibility seam; not used for V1. |
| `isRejectTransaction` / `getTransactionRejectReason` | `types/blockItemSummary.d.ts` | Rejection detection and reason extraction. |

`sendTransaction` is the only submission method in the installed SDK that accepts a V1
finalized transaction. `sendAccountTransaction` is documented as deprecated and V0-only.

## ARCHITECTURE AND INTEGRATION DECISION

**Decision: delegate, do not replace.**

`IpcSponsorSigner.submitTransaction` and `waitForFinalization` delegate to the existing
`ConcordiumTransactionSubmitter` when one is injected via `opts.submitter`. They remain
fail-closed (throw "not available") when no submitter is supplied.

Rationale:
- `FacilitatorCore.settle()` already calls `submitTransaction()` at step 6, after the durable
  hash is persisted and the broadcast claim is taken (TASK 29 ordering). Reusing that seam
  preserves that ordering and the authorization boundary.
- A second, signer-owned submission path would duplicate hash and claim bookkeeping outside
  `FacilitatorCore`, reintroducing the crash windows TASK 29 closed.
- The signer never constructs a gRPC client or transport; the caller injects the submitter.
- With no submitter injected, behaviour is byte-for-byte identical to TASK 46.

## IMPLEMENTATION

Files changed:
- `services/facilitator/src/grpcConcordiumTransport.ts` — `submit` now finalizes with
  `Transaction.finalize(signable)` and calls `client.sendTransaction(finalized)` when the
  client exposes it. The deprecated `sendAccountTransaction` path is retained only as a
  compatibility seam for legacy V0 fakes. Constructor accepts a client exposing either
  submission method plus `getBlockItemStatus`.
- `services/facilitator/src/ipcSponsorSigner.ts` — optional `submitter?: ConcordiumTransactionSubmitter`
  added to `IpcSponsorSignerOptions`. `submitTransaction` delegates to `submitter.submit`
  and returns the hash. `waitForFinalization` delegates to `submitter.awaitFinalization` and
  maps outcomes.
- `scripts/task51-crash-child.mts` — new real-process crash harness child (mock transport only).
- `test/task51-v1-sponsored-submission.test.mts` — 27 tests.

## SUBMISSION/FINALIZATION LIFECYCLE

1. `FacilitatorCore.settle` validates, claims, authorizes, verifies the sender, converts wire
   format, obtains the sponsor signature, computes the durable hash, persists it, and takes the
   broadcast claim (TASK 29).
2. `signer.submitTransaction(sponsored)` is called.
3. `ConcordiumTransactionSubmitter.submit` validates the V1 shape and calls the transport.
4. `GrpcConcordiumTransport.submit` parses with `Transaction.signableFromJSON`, finalizes with
   `Transaction.finalize`, and submits via `GRPCClient.sendTransaction`.
5. The returned hash is normalized to 64-hex and compared to the persisted hash; a mismatch is
   a hard failure (no finalization, no success).
6. `signer.waitForFinalization` delegates to `ConcordiumTransactionSubmitter.awaitFinalization`,
   which polls `getBlockItemStatus` until `finalized`, `rejected`, timeout, transport error,
   or cancellation.
7. `finalized` → reconcile as finalized → success. `rejected` → reconcile as failed → failure.
   Timeout / pending / committed → pending (non-terminal, no retry).

## STATUS MAPPING

| TASK49 status | `SponsorSigner` status | Notes |
|---|---|---|
| `finalized` | `finalized` | Only success path. |
| `rejected` | `failed` | Terminal rejection. |
| `pending` / `timeout` / `cancelled` | `pending` | Non-terminal. |
| `transport_error` | throws | Ambiguous outcome kept distinguishable; caller marks pending, never success. |

## CRASH-WINDOW BEHAVIOR AND RECOVERY LIMITATIONS

- Submission rejected before a hash is returned: the transport throws `submission rejected`;
  no hash is returned; the durable persisted hash remains for reconciliation, never success.
- Process termination immediately after successful submission: exactly one submission attempt
  is recorded; the hash is durable; recovery never resubmits; the row becomes
  `outcome_unknown` and is reconciled by hash.
- Process termination after submission but before finalization observed: the hash is durable;
  finalization is never observed; no success is reported; recovery polls by hash.
- Finalization timeout: non-terminal pending; no retry.
- Finalized rejection: terminal failure, not success.
- Finalized success: the only success path.
- Malformed/unknown status: fail closed (throw or `transport_error`), never success.
- Duplicate submission: the adapter does not dedupe; each call submits once. Deduplication is
  the caller's responsibility via the durable claim.

Limitations: the transport itself holds no durable state. Recovery depends entirely on the
caller's durable store and the TASK 29 claim/reconcile machinery. The V1 transport is not
wired into `FacilitatorCore` or `DENY_ALL_FACILITATOR`; settlement remains disabled by
default.

## TEST RESULTS

```
dedicated suite:
  npx tsx test/task51-v1-sponsored-submission.test.mts
  task51: 27/27 passed, 0 failed

TASK50 (unchanged, still green):
  task50: 27/27 passed, 0 failed

full repository suite (npm test):
  all suites passed
```

## TYPECHECK RESULTS

```
npm run build                                              rc=0
npx tsc --noEmit                                           rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)   rc=0
```

## REMAINING BLOCKERS

1. Settlement activation remains disabled by default and requires maintainer approval.
2. `DENY_ALL_FACILITATOR` remains intact; the V1 path is not wired into it.
3. A real `GRPCClient` and funded sponsor account are required for any live path.
4. The `sendAccountTransaction` compatibility seam should be removed once all callers use
   `sendTransaction`.
5. The signer-boundary status mapping is lossy (four values); a future task may extend the
   `SponsorSigner` contract if transport-error distinction is needed upstream.

## STOP CONDITION

Implementation, verification, and documentation complete. TASK 52 not started. No real
broadcast or settlement occurred.
MD
echo "written"
## TESTS ADDED

`test/task51-v1-sponsored-submission.test.mts` (27):

1. `V1-01. V1 submission uses sendTransaction, not sendAccountTransaction`
2. `V1-02. a TransactionHash instance return value is normalized to hex`
3. `V1-03. pending / committed / finalized / rejected / unknown / malformed`
4. `V1-04. submission gRPC error propagates as rejection`
5. `V1-05. malformed signed transaction never reaches the client`
6. `V1-06. constructor refuses a client without any submission method`
7. `V1-07. TASK49 adapter works end-to-end with the V1 transport`
8. `V1-08. TASK49 adapter surfaces a finalized rejection`
9. `V1-09. TASK49 adapter times out on a committed (never finalized) transaction`
10. `V1-10. duplicate submissions are not deduplicated by the adapter`
11. `IPC-01. without a submitter, submission stays fail-closed`
12. `IPC-02. with a submitter, submission delegates and returns the hash`
13. `IPC-03. waitForFinalization delegates and maps finalized to finalized`
14. `IPC-04. waitForFinalization maps a finalized rejection to failed`
15. `IPC-05. waitForFinalization maps a timeout to pending`
16. `IPC-06. waitForFinalization throws on a transport error`
17. `CW-01. submission rejected before a hash is returned is never success`
18. `CW-02. after a returned hash, a transport error during finalization is not success`
19. `CW-03. finalization timeout is not success`
20. `CW-04. finalized rejection is not success`
21. `CW-05. finalized success is the only success path`
22. `CW-06. malformed and unknown statuses fail closed`
23. `S01. transport holds no key material or signing logic`
24. `S02. DENY_ALL_FACILITATOR remains intact`
25. `S03. settlement stays disabled by default`
26. `CW-07. real process: die immediately after submission -> one attempt, hash durable, recovery does not resubmit`
27. `CW-08. real process: die while finalization is unobserved -> hash durable, no success`

CW-07/CW-08 spawn a real child process (`scripts/task51-crash-child.mts`), inject a fake
gRPC client, and kill it with SIGKILL at the boundary. The parent inspects an append-only
ledger to prove the exact attempt count, hash durability, and recovery behaviour.

## CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| Mock/fake transport only | OK — no `ConcordiumGRPCNodeClient` is constructed anywhere. |
| No real transaction broadcast | OK. |
| Settlement not activated | OK — `DENY_ALL_FACILITATOR` and default-off unchanged (S02/S03). |
| No private key access/generation/import/export/use | OK — the IPC signer was never dialled in the crash harness; `S01` asserts no key material on the transport. |
| No real transactions created/submitted | OK. |
| Token 1004 / Agent Card untouched | OK. |
| No unrelated pipeline or authorization changes | OK — `FacilitatorCore`, `authorization`, `senderVerifier` untouched. |
| No commits or pushes | OK — HEAD unchanged. |
