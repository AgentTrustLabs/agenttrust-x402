# TASK 55 — Concordium SDK 12.0.2 Production Wiring Corrections

## VERDICT

**READY WITH CONDITIONS.**

B3 and B4 are fixed against the actual SDK 12.0.2 contracts. The production dependency graph
now constructs a real `ConcordiumGRPCNodeClient`, injects a V1 submitter into the IPC sponsor
signer, and uses `ConcordiumGRPCNodeClient` in the grpc evidence verifier. Fee and energy caps
are internally consistent (1000 NRG under a 10 CCD cap). B1 (sponsor provisioning) and B2 (key
custody) remain separate, documented blockers.

## 1. SDK EVIDENCE

Installed: `@concordium/web-sdk@12.0.2` (deduped with `@x402/concordium@2.29.0`).

Relevant declarations (verified, not inferred):

- `node_modules/@concordium/web-sdk/lib/esm/nodejs/grpc.d.ts:17`
  ```
  export declare class ConcordiumGRPCNodeClient extends ConcordiumGRPCClient {
    constructor(address: string, port: number, credentials: ChannelCredentials,
                options?: Partial<GrpcOptions>);
  }
  export { credentials, ChannelCredentials, CallCredentials } from '@grpc/grpc-js';
  ```
  There is **no** `GRPCClient` export. TASK54's `buildVerifier` was using
  `new (nodejs as any).GRPCClient(...)` → `TypeError: nodejs2.GRPCClient is not a constructor`.

- `node_modules/@concordium/web-sdk/lib/esm/grpc/GRPCClient.d.ts:94,174,302`
  ```
  getBlockItemStatus(transactionHash: TransactionHash.Type): Promise<BlockItemStatus>;
  sendTransaction(transaction: Transaction.Finalized): Promise<TransactionHash.Type>;
  waitForTransactionFinalization(transactionHash: TransactionHash.Type, timeoutTime?): Promise<…>;
  ```

- `Transaction` (from `@concordium/web-sdk`, not the subpath) exposes
  `signableFromJSON`, `toJSON`, `finalize`, `sponsor`, `getAccountTransactionHash` — all
  present and used by `GrpcConcordiumTransport` and `SdkSponsorSigner`.

- Energy model (from `energyCost.js` + `AccountTransactionV1.js`):
  - `constantA = 100`, `constantB = 1`, `ACCOUNT_TRANSACTION_HEADER_SIZE = 60` (v0) + 32 (sponsor)
    = 94 bytes for a sponsored V1.
  - `calculateEnergyCost(sigCount, payload, baseCost, {energy:true})` =
    `100 * sigCount + 1 * (94 + payloadSize) + baseCost`.
  - `getExchangeRate({euroPerEnergy, microGTUPerEuro})` and `convertEnergyToMicroCcd(cost, chainParameters)`.

## 2. B3 — SUBMITTER INJECTION

Before: `server.ts` constructed `createIpcSponsorSigner(...)` without a `submitter`. Both
`submitTransaction` and `waitForFinalization` threw `ConfigurationError("… not available in IPC
signing mode…")`. A real `/settle` could never reach the node.

After (`server.ts`):
```
const submitter =
  config.mode === 'real' && config.nodeHost !== null && config.nodePort !== null
    ? new ConcordiumTransactionSubmitter(
        new GrpcConcordiumTransport(
          new ConcordiumGRPCNodeClient(
            config.nodeHost, config.nodePort,
            config.nodeUseTls ? credentials.createSsl() : credentials.createInsecure(),
          ) as never,
        ),
      )
    : undefined;

const signer = config.mode === 'real'
  ? createIpcSponsorSigner({ ..., ...(submitter ? { submitter } : {}) })
  : … mock …
```

- The signer still never builds a transport itself (invariant preserved).
- With no submitter, both methods stay fail-closed (unchanged).
- Mock mode is unaffected (no submitter constructed).

Verified by `test/task55-production-testnet-wiring.test.mts`:
- A01–A09: injection contract at the `createIpcSponsorSigner` boundary (delegation, error
  propagation, fail-closed without a submitter).
- A10–A13: real-mode `startFacilitator` with a fake node client constructs the signer and
  delegates `submitTransaction` / `waitForFinalization` to the injected submitter; the fake
  node client's counters prove the transport was used, without any real broadcast.

## 3. B4 — SDK CLIENT CONSTRUCTION

Before: `buildVerifier` grpc case used `new (nodejs as any).GRPCClient(...)` →
`TypeError: nodejs2.GRPCClient is not a constructor` at startup.

After: `new ConcordiumGRPCNodeClient(host, port, credentials.createSsl() | createInsecure())`,
matching the constructor `GrpcAccountInfoProvider` already uses. The `nodeClient` test seam
passes a fake client through to both the account provider and the submitter, so the wiring is
exercisable without a node.

Verified (B01–B10): the export exists, `GRPCClient` does not, credentials are available, all
five methods (`sendTransaction`, `getBlockItemStatus`, `waitForTransactionFinalization`,
`getAccountInfo`, `getConsensusStatus`) exist, and grpc evidence mode starts + answers a reconcile
with `evidence unavailable (node query failed …)` without mutating state.

## 4. FEE AND ENERGY CONFIGURATION

Live Testnet (protocol 10) evidence (`getBlockChainParameters`):

- `euroPerEnergy = 1/50000`, `microGTUPerEuro = 1316758697067716096/3671577513`
- Exchange rate = **7172.71359466307 microCCD/NRG**.
- Sponsored simple transfer (2 signatures, 94-byte sponsored header, 41-byte payload, 300 base
  cost) = **603 NRG → 4.325 CCD**.
- The in-code conservative estimate uses 8000 microCCD/NRG (see `core.ts` `validateContext`).

Changes:

- `FACILITATOR_MAX_FEE_MICROCCD` default kept at **10 000 000 (10 CCD)**. Covers up to
  ~1394 NRG at the live rate; ~1250 NRG at the conservative rate.
- `FACILITATOR_MAX_ENERGY` default changed from the placeholder **100 000** to **1 000 NRG**.
  Rationale: 100 000 NRG implied a worst-case fee of 717 CCD (live) / 800 CCD (conservative),
  which contradicts the 10 CCD fee cap — the two caps were not internally consistent.
  1 000 NRG leaves ~1.66× margin over the measured 603 NRG transfer, costs 7.17 CCD (live) /
  8 CCD (conservative), 20% under the fee cap, and is round and easy to reason about.
  Values above 1 250 NRG exceed the fee cap under the conservative rate.
- `core.ts` `maxAuthorizationEnergy` and `maxWireEnergy` defaults changed from 100 000 to 1 000,
  so all three caps agree.

Compatibility: operators relying on the old 100 000 default must set `FACILITATOR_MAX_ENERGY`
explicitly. Tests that construct the signer/core directly pass their own values and are
unaffected (verified by the full suite). The `validateContext` boundary was re-verified:
- D09: measured transfer (603 NRG, 4.824 CCD) accepted.
- D10: 1001 NRG refused.
- D11: 10 000 001 microCCD refused.
- D12–D14: wrong sponsor / wrong network / zero energy refused.

## 5. INTEGRATION VERIFICATION

Dependency graph after the fix:

```
server.ts
  ├─ ConcordiumGRPCNodeClient (nodeHost, nodePort, tlsCreds) ──┐
  ├─ GrpcConcordiumTransport (client)                          │
  ├─ ConcordiumTransactionSubmitter (transport)  ◄───────────────┘  (injected into signer)
  ├─ GrpcAccountInfoProvider (nodeClient seam or real client)
  ├─ SdkSenderVerifier (provider)
  ├─ createIpcSponsorSigner({ ..., submitter })  → IpcAccountSigner → signing service
  ├─ FacilitatorCore (signer, store, senderVerifier, authorization)
  ├─ buildVerifier(config) → ConcordiumEvidenceVerifier (ConcordiumGRPCNodeClient)  [grpc mode]
  └─ ReconciliationService (store, verifier)
```

Real mode fails at startup when:
- signing service unreachable (`probeSigningService`);
- sender verification is not `sdk` (loadConfig);
- node host/port absent when sdk verification is configured;
- `verifyNode()` genesis mismatch.

No signing or submission was invoked. The full dependency graph is verified by construction
and by the focused tests.

## 6. GAP E ASSESSMENT

No lifecycle redesign in this task. Empirical findings (live node, read-only):

- Unknown hash → `RpcError: transaction not found.` → transport `transport_error` →
  `markPending` → stays `outcome_unknown`/`recovery_unavailable`. Never success, never rejection.
- `received` / `committed` → `pending` (non-terminal).
- `finalized` + matching hash + success → `finalized`.
- `finalized` + matching hash + `transactionType === 'failed'` → `rejected`.
- `finalized` + mismatched hash → inconclusive (retained pending).
- Malformed / unrecognized status / transport throw → fail-closed (`transport_error`).

The single-node behaviour is sufficient for the first controlled transaction. First-observation-wins
remains a theoretical multi-node / stale-cache risk. Minimum correction before live use: require
a confirming second observation before applying a terminal rejection (inside
`ConcordiumEvidenceVerifier.verify` / `GrpcConcordiumTransport.getStatus`), plus operator
re-verification via the existing `/reconcile` endpoint.

## 7. TEST EVIDENCE

Focused suite `test/task55-production-testnet-wiring.test.mts`: **52/52 passed, 0 failed**.

Coverage:
- A01–A13: submitter injection (delegation, mapping, error propagation, fail-closed,
  real-mode startup with a fake node client).
- B01–B10: SDK 12.0.2 client construction and grpc evidence mode.
- C01–C05: genesis mismatch rejection + unreachable node.
- D01–D14: fee/energy defaults, consistency, boundary enforcement.
- E01–E04: mock-mode compatibility.

Full suite: **67 suites, 0 failed** (third consecutive clean run, `EXIT=0`).

Build and typechecks:
```
npm run build                                                    rc=0
npx tsc --noEmit                                                 rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)    rc=0
```

## 8. REMAINING BLOCKERS (SEPARATE, DOCUMENTED)

- **B1** — sponsor account not provisioned/funded (does not exist on Testnet).
- **B2** — no production key-custody path for the signing service (external decision).

## 9. FIRST-TRANSACTION READINESS STATUS

The code-level blockers (B3, B4) and the fee/energy inconsistency are resolved. The remaining
items (B1, B2, the confirming-evidence rule, and the maintainer approval checkpoint) are
unchanged from TASK54. No transaction was signed, constructed for broadcast, submitted, or
broadcast. No account was provisioned or funded. No faucet request was made. No private key was
accessed, generated, imported, exported, or logged. Token 1004 and its Agent Card are untouched.
`DENY_ALL_FACILITATOR` and the settlement default remain disabled. No unrelated refactoring.

Stop condition honoured: no TASK56 started, no account provisioned, no key material accessed, no
broadcast. Awaiting explicit maintainer approval before any real transaction signing or broadcast.
