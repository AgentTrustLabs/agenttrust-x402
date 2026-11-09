# TASK 50 — Concordium gRPC Transaction Transport

## VERDICT

**PASS.** `GrpcConcordiumTransport` implements the TASK49 `ConcordiumTransactionTransport`
contract over an injected SDK-compatible client. It submits through
`GRPCClient.sendAccountTransaction(transaction, signature)` and reads finalization through
`GRPCClient.getBlockItemStatus(hash)`. Status mapping, rejection-reason preservation, and
fail-closed behaviour are verified against a fake client. No live RPC, no broadcast, no
keys, and no settlement activation occurred.

## SDK CONTRACT EVIDENCE

Verified against the installed `@concordium/web-sdk` **12.0.2** (`node_modules/@concordium/web-sdk`):

| SDK symbol | Source | Notes |
|---|---|---|
| `GRPCClient.sendAccountTransaction(transaction, signature): Promise<TransactionHash.Type>` | `lib/esm/grpc/GRPCClient.d.ts:191` | Deprecated V0 account-transaction submission path. Re-serializes payload and recomputes energy internally (`GRPCClient.js:283-288`). |
| `GRPCClient.sendRawAccountTransaction(header, energyAmount, payload, signature)` | `GRPCClient.d.ts:208` | Low-level variant; not used by the transport. |
| `GRPCClient.getBlockItemStatus(transactionHash: TransactionHash.Type): Promise<BlockItemStatus>` | `GRPCClient.d.ts:94` | The real client converts the hash with `TransactionHash.toBuffer` before RPC (`GRPCClient.js:113-119`), so a raw hex string is not accepted. |
| `GRPCClient.waitForTransactionFinalization(transactionHash, timeoutTime?): Promise<BlockItemSummaryInBlock>` | `GRPCClient.d.ts:302` | Blocking convenience; throws on timeout (`GRPCClient.js:505-535`). Not used. |
| `TransactionHash.Type` | `types/TransactionHash.d.ts` | Class instance; `toString()` / `TransactionHash.toHexString` produce 64-hex; `TransactionHash.instanceOf` distinguishes it from a string. |
| `BlockItemStatus` | `types/blockItemSummary.d.ts` | `PendingBlockItem {status:'received'}` / `CommittedBlockItem {status:'committed',outcomes}` / `FinalizedBlockItem {status:'finalized',outcome}`. |
| `BlockItemSummaryInBlock` | `types/blockItemSummary.d.ts` | `{blockHash, summary}`; summary may be `FailedTransactionSummary`. |
| `FailedTransactionSummary` | `types/blockItemSummary.d.ts` | `transactionType: 'failed'`; `rejectReason: Upward<RejectReason>` (may be `null`). |
| `isRejectTransaction(summary)` | `types/blockItemSummary.d.ts` / `blockItemSummary.js` | True when `type === 'accountTransaction'` and `transactionType === 'failed'`. |
| `getTransactionRejectReason(summary)` | `types/blockItemSummary.d.ts` / `blockItemSummary.js` | Returns `Upward<RejectReason>` for a rejection, otherwise `undefined`. |
| `TransactionStatusEnum` | `types.d.ts:162-166` | `Received = 'received'`, `Finalized = 'finalized'`, `Committed = 'committed'`. |
| `AccountTransactionHeader` | `types.d.ts:1218-1228` | `{sender, nonce, expiry}`. |
| `AccountTransactionSignature` | `types.d.ts:1389` | `Record<number, CredentialSignature>`. |
| `Transaction.signableFromJSON(json)` | `transactions/Transaction/signable.d.ts` | Parses V0/V1 signed JSON into a `Signable`. |
| `Transaction.toLegacyAccountTransaction(transaction)` | `transactions/Transaction/builder.d.ts` | Converts a signable/builder into the legacy `AccountTransaction` expected by `sendAccountTransaction`. |
| `Transaction.serializeBlockItem` / `sendRawTransaction` | `GRPCClient.js:257-267` | V1 raw-block-item path; not used by this transport. |

**Safest finalization API:** `getBlockItemStatus`. It returns an explicit status union and
does not throw for a pending/committed transaction, so a non-final outcome is distinguishable
from an RPC failure. `waitForTransactionFinalization` collapses a timeout into a thrown error
(`GRPCClient.js:505-535`), which would force a timeout/RPC-error split inside the transport.
Polling `getBlockItemStatus` keeps that distinction explicit.

**SDK limitation observed:** `sendAccountTransaction` is the deprecated **V0-only** path
(`GRPCClient.d.ts:177-191`; `sendRawAccountTransaction` serializes a V0 header). It cannot
represent a V1 sponsored header or carry a sponsor signature. The transport converts the
signable to the legacy `AccountTransaction` and passes the sender signature map. Production
V1 sponsored submission must use `sendTransaction(Transaction.finalize(...))` / the raw
block-item path. This transport is not wired into active settlement, so no V1 submission
path is activated here.

## IMPLEMENTATION

New file: `services/facilitator/src/grpcConcordiumTransport.ts`.

```ts
export interface ConcordiumGrpcClientLike {
  sendAccountTransaction(transaction: unknown, signature: unknown): Promise<unknown>;
  getBlockItemStatus(hash: unknown): Promise<BlockItemStatus>;
  waitForTransactionFinalization?(hash: unknown, timeoutMs?: number): Promise<unknown>;
}

export class GrpcConcordiumTransport implements ConcordiumTransactionTransport {
  constructor(client: ConcordiumGrpcClientLike);
  async submit(signedTx: unknown): Promise<string>;
  async getStatus(hash: string): Promise<TransportStatus>;
}
```

- The constructor validates the injected client has `sendAccountTransaction` and
  `getBlockItemStatus`. It never constructs a `GRPCClient` itself (no zero-argument path).
- `submit` parses the signed pipeline JSON with `Transaction.signableFromJSON`, rejects an
  unsupported version, converts to the legacy `AccountTransaction` with
  `Transaction.toLegacyAccountTransaction`, selects the sender signature map, and calls
  `client.sendAccountTransaction(accountTransaction, signature)`.
- The returned hash may be a `TransactionHash.Type` instance or a hex string; `toHex`
  normalizes both. A non-64-hex result throws.
- `getStatus` converts the hex hash to `TransactionHash.Type` via `TransactionHash.fromHexString`
  (the real SDK requires this type), calls `getBlockItemStatus`, and maps the union.
- No signing, no key material, no settlement activation, no `IpcSponsorSigner` change.

## STATUS MAPPING

| SDK `BlockItemStatus` | Transport `TransportStatus` | Rationale |
|---|---|---|
| `PendingBlockItem` (`status: 'received'`) | `{status:'pending'}` | Not final. |
| `CommittedBlockItem` (`status: 'committed'`) | `{status:'pending'}` | Committed is NOT finalized; keep polling. |
| `FinalizedBlockItem`, `isRejectTransaction(summary)` true | `{status:'rejected', reason: <tag/contents>}` | Reason preserved verbatim. |
| `FinalizedBlockItem`, summary not a rejection | `{status:'finalized', blockHash?}` | Success; block hash preserved when present. |
| Non-object / missing or non-string `status` | throws `malformed BlockItemStatus ...` | Fail closed. |
| String `status` outside the union | throws `unrecognized BlockItemStatus` | Fail closed. |
| `finalized` without `outcome`/`summary` | throws `malformed BlockItemStatus ...` | Fail closed; a missing outcome is never success. |

`getTransactionRejectReason` is used only after `isRejectTransaction` narrows the summary.
A `null`/absent reason becomes `rejected (no reason supplied)`, still a rejection, never
success.

## SUBMISSION BEHAVIOR

1. `Transaction.signableFromJSON(signedTx)` — malformed input throws
   `malformed signed transaction: <message>` before the client is touched.
2. Version check — only `0` and `1` are accepted; anything else throws
   `unsupported transaction version: <value>`.
3. `Transaction.toLegacyAccountTransaction(signable)` — conversion failure throws
   `cannot convert transaction: <message>`.
4. Signature selection — V0 uses `signature`; V1 uses `signatures.sender`. A missing
   signature throws `cannot submit transaction: missing signature`.
5. `client.sendAccountTransaction(tx, sig)` — a thrown gRPC error is re-thrown as
   `submission rejected: <message>`; the SDK message is preserved verbatim.
6. Hash normalization — `TransactionHash.Type` instances and hex strings both produce the
   64-hex form; anything else throws `submission returned an invalid transaction hash`.

## FINALIZATION BEHAVIOR

- The hex hash is converted with `TransactionHash.fromHexString` before
  `getBlockItemStatus`; an unparseable hash throws `invalid transaction hash` and the
  client is never called.
- A thrown RPC error becomes `status lookup failed: <message>`.
- The `BlockItemStatus` union is mapped as above. A `committed` outcome stays `pending`, so
  the TASK49 adapter keeps polling until `finalized` or the deadline.
- A finalized rejection is detected with `isRejectTransaction` and its reason extracted with
  `getTransactionRejectReason`; the reason tag is preserved as a string.
- The `blockHash` is preserved only on a finalized success.
- Malformed responses (null, missing/non-string status, missing outcome/summary) throw
  rather than returning success.

## TASK49 INTEGRATION

`GrpcConcordiumTransport` satisfies `ConcordiumTransactionTransport`, so it is injected
directly into `ConcordiumTransactionSubmitter` (`test/task50` tests `12`, `12b`, `12c`).
The integration is **independent of settlement**:

- `IpcSponsorSigner.submitTransaction` still throws "never broadcasts".
- `FacilitatorCore` is unchanged.
- `DENY_ALL_FACILITATOR` and the settlement default are unchanged (S02/S03).

A future task may replace the throw with `ConcordiumTransactionSubmitter.submit(...)`, still
behind `allowSettlement` and maintainer approval, and should choose the V1-capable
`sendTransaction` path for sponsored transactions.

## VERIFIED

`test/task50-grpc-concordium-transport.test.mts` (27 tests):

1. `01. successful submission returns the SDK hash`
2. `01b. a TransactionHash instance return value is normalized to hex`
3. `01c. a V0 signed transaction uses its single signature map`
4. `02. the submitted hash propagates into getStatus`
5. `03. pending status maps to pending`
6. `04. committed status maps to pending (committed is not final)`
7. `05. finalized success maps to finalized with the block hash`
8. `06. finalized rejection preserves the reject reason`
9. `06b. a rejection without a reason still fails closed as rejected`
10. `07. unknown status throws (fail closed)`
11. `08. malformed status responses throw`
12. `08b. a malformed transaction hash is never sent to the client`
13. `09. submission gRPC error propagates as rejection`
14. `09b. a malformed signed transaction never reaches the client`
15. `09c. an invalid hash returned by the node is rejected`
16. `10. status lookup gRPC error propagates`
17. `11. constructor refuses a client missing sendAccountTransaction`
18. `11b. constructor refuses a client missing getBlockItemStatus`
19. `11c. constructor refuses a null client`
20. `12. TASK49 submitter works end-to-end with the gRPC transport`
21. `12b. TASK49 submitter surfaces a transport rejection reason`
22. `12c. TASK49 submitter times out while the transport stays committed`
23. `13. pending and committed never report finalized`
24. `S01. the transport holds no key material or signing logic`
25. `S02. DENY_ALL_FACILITATOR remains intact`
26. `S03. settlement stays disabled by default (guardSettlement)`
27. `S04. the transport is independently constructible and does not self-construct a client`

## NOT TESTED

- A real `GRPCClient` (fake only).
- A real V1 sponsored submission through `sendAccountTransaction`; the installed SDK
  documents that method as the deprecated V0 path, and it cannot carry a sponsor signature.
- `waitForTransactionFinalization` (the transport polls `getBlockItemStatus`).
- Live gRPC error codes beyond the two mocked cases.
- Energy re-computation against a real node.
- The `sendTransaction` raw-block-item path used for production V1 sponsored transactions.

## BLOCKED

None for the transport itself. Settlement activation and the V1 production submission
decision remain gated by maintainer approval.

## TEST RESULTS

```
dedicated suite:
  npx tsx test/task50-grpc-concordium-transport.test.mts
  task50: 27/27 passed, 0 failed

full repository suite (npm test):
  all suites passed
```

## TYPECHECK RESULTS

```
npm run build                                                    rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)    rc=0
npx tsc --noEmit                                                  rc=0
```

## HEAD BEFORE/AFTER

```
before: 4c8994db391d77796e06e49c843c42be1eae615b
after : 4c8994db391d77796e06e49c843c42be1eae615b   (no commits, no push)
```

Working tree only. Changed files:
`services/facilitator/src/grpcConcordiumTransport.ts`,
`test/task50-grpc-concordium-transport.test.mts`,
this document.

## CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| Fake GRPCClient only | OK — no `GRPCClient` is constructed anywhere in the suite. |
| No live Concordium RPC | OK. |
| No transaction broadcast or submission | OK. |
| No real settlement | OK — settlement stays disabled by default. |
| No real facilitator activation | OK. |
| No wallet creation or import | OK. |
| No private-key access, generation, export, or signing | OK — `S01` asserts no such method/property. |
| No sponsor funding or faucet | OK. |
| Token 1004 / Agent Card untouched | OK. |
| `DENY_ALL_FACILITATOR` intact | OK — S02. |
| Settlement disabled by default | OK — S03. |
| No schema changes | OK — none. |
| No unrelated infrastructure hardening | OK. |
| No commits or pushes | OK — HEAD unchanged. |

## REMAINING PREREQUISITES

1. A real `GRPCClient` instance, injected by the caller (never constructed here).
2. A decision on the production V1 submission path: `sendAccountTransaction` is V0-only and
   cannot carry a sponsor signature; sponsored transactions need `sendTransaction` /
   `serializeBlockItem`.
3. A decision on whether `IpcSponsorSigner.submitTransaction` delegates to
   `ConcordiumTransactionSubmitter.submit` or is replaced.
4. Maintainer approval to activate settlement behind `allowSettlement`.
5. A funded Testnet sponsor account and a real signer (TASK 47/48 prerequisites).

## RECOMMENDED TASK51

**TASK 51 — V1 Sponsored Submission Path plus Crash-Safe Finalization (Mock-Only)**

Scope:

1. Add a V1-capable transport method (or a second transport) that uses
   `Transaction.finalize` plus `GRPCClient.sendTransaction` for sponsored transactions, and
   decide the adapter boundary between `sendAccountTransaction` and `sendTransaction`.
2. Add a `submitTransaction`/`waitForFinalization` implementation at the sponsor signer
   boundary that delegates to `ConcordiumTransactionSubmitter` with the injected
   `GrpcConcordiumTransport`, keeping the existing "never broadcasts" default until
   `allowSettlement` is enabled.
3. Add a mock-transport integration test proving the durable pipeline ordering: authorize →
   sender verify → fee validate → convert → sponsor sign → hash → persist → submit →
   finalization. Reuse the TASK 29 crash-boundary harness.
4. Document the exact call sequence and the crash windows (submit-then-die, finalize-then-die)
   with the same rigour as TASK 29.1.
5. Keep `DENY_ALL_FACILITATOR` and the settlement default unchanged.

Explicitly out of TASK 51: broadcast, settlement activation, account creation, funding.

Stop condition: implementation, tests, typechecks, and documentation complete; then wait.
