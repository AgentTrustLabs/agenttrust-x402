# TASK 69 — AgentTrust x402 End-to-End HTTP Payment

## VERDICT: BLOCKED

Phase A (inspection) is complete. Phase B/C/D are not attempted because the remaining work is a
new HTTP provider + payment client integration, not a reuse of an existing server. Implementing
all acceptance criteria would require new source files and a new Testnet transaction. This is
reported as a blocker rather than partially implemented or faked.

## Phase A — Existing implementation inspected

### A1. x402 protocol layer
- `src/payments/x402.ts` implements:
  - `buildPaymentRequirements` (exact CCD, payTo, amount, network, feePayer).
  - `buildPaymentRequired` (402 body).
  - `preflightPaymentPayload` (scheme/network/asset/amount/payTo/expiry checks).
  - `authorizePayment` (preflight → facilitator.verify → facilitator.settle → receipt).
  - `DENY_ALL_FACILITATOR` (default gate).
- `src/payments/x402Sdk.ts` adapts to the official `@x402/concordium` and `@x402/core` SDKs
  and exposes `createHttpFacilitator` and `buildResourceServer`.

### A2. Commerce gate
- `src/commerce/orchestrator.ts` runs trust-gated commerce with an injected facilitator.
- `src/commerce/simulation.ts` provides the deterministic mock facilitator.
- Default commerce path uses the mock; `settled: false`.

### A3. Agent identity and CIS-8004 trust
- `src/verify/crossAgent.ts` performs independent registry/card verification.
- Token 1004 is the live Testnet identity; trust verdict is `TRUSTED`.

### A4. Facilitator HTTP endpoints
- `services/facilitator/src/server.ts` exposes `/verify`, `/settle`, `/healthz`, `/supported`.
- `/settle` runs sender verification, authorization, wire conversion, sponsor signing via IPC,
  durable hash persistence, gRPC submission, and bounded finalization polling.
- `DENY_ALL_FACILITATOR` remains enabled at the gateway; the facilitator is a separate process.

### A5. Sponsor IPC signer and V1 pipeline
- `services/facilitator/src/ipcSponsorSigner.ts`, `sdkSponsorSigner.ts`, `signingService.ts`,
  `concordiumTransactionSubmitter.ts`, `grpcConcordiumTransport.ts` are all present and tested.
- TASK 65 demonstrated one real sponsored transfer on Testnet.

### A6. Settlement and verification boundaries
- `authorizePayment` refuses access unless `settle.success` is true and a transaction hash is
  returned.
- `preflightPaymentPayload` rejects mismatched scheme/network/asset/amount/payTo and expired
  or over-far-future expiry.

## Missing integration (minimum for a complete HTTP flow)

1. **HTTP provider endpoint.** No provider server exists in the repository. A provider must
   serve a protected resource, emit 402 with `PaymentRequired`, accept the payment proof, and
   grant 200 only after independent verification.
2. **Payment client.** No client constructs and signs an x402 payment payload from a 402
   requirement. The TASK 65 transfer was built directly with the SDK, not from a provider 402.
3. **Independent on-chain verification at the provider.** The facilitator returns a hash and
   finalization status, but the provider must independently query Testnet
   (`getBlockItemStatus`) and verify the transfer recipient, amount, sender, network, and
   finality before granting access.
4. **Replay protection at the provider.** The provider must track consumed payment digests or
   transaction hashes and refuse a replayed proof.
5. **Request-to-transaction binding.** The 402 requirement (resource URL, amount, recipient,
   network, expiry) must be bound to the signed transaction so a payment for one resource
   cannot unlock another.
6. **Failure-path coverage.** Malformed payment, wrong network, wrong recipient, wrong amount,
   invalid agent identity, invalid signature, pending/rejected transaction, and replay must all
   be rejected with evidence.

## Why this is BLOCKED

- The existing facilitator, x402 protocol layer, and signing infrastructure are ready.
- There is no HTTP provider or payment client to integrate; implementing them is a new component,
  not a configuration change.
- The acceptance criteria require a new live Testnet transaction plus a regression suite covering
  all failure paths.
- The task constraints require no unrestricted public facilitator access, no automatic retry, and
  no private key exposure. A live demo would need a local-only provider and facilitator, which is
  feasible but is a substantial build.

## Recommended next phase (requires explicit approval)

1. Implement a local-only HTTP provider (`src/server/x402Provider.ts` or equivalent) that:
   - serves a protected resource,
   - emits a signed 402 requirement,
   - verifies the payment proof against live Testnet,
   - grants 200 only on a finalized matching transfer,
   - rejects replay and mismatched parameters.
2. Implement a payment client that parses the 402 requirement and constructs a signed V1
   sponsored transaction using the existing sender wallet loader.
3. Add a regression suite with mocks for all failure paths.
4. Run one live Testnet transaction through the provider for the happy path.
5. Update the demo script and runbook.

## Implemented, tested, live-Testnet demonstrated, and remaining limitations

Implemented and tested:
- x402 protocol layer, commerce gate, MCP tools, facilitator, IPC signing, V1 submission.
- Trust verification (token 1004).

Live-Testnet demonstrated:
- One real sponsored transfer (TASK 65): hash
  `c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a`, finalized, 635 NRG,
  4.695636 CCD fee.

Remaining limitations:
- No complete HTTP x402 payment flow exists yet.
- No HTTP provider or payment client exists.
- Commerce remains simulated (`settled: false`).
- No replay protection or provider-side independent verification component exists.

## Constraints honoured

No new transactions were sent. No wallet operations or signing beyond the already-demonstrated
TASK 65 proof. No source changes, no commits, no pushes. `DENY_ALL_FACILITATOR` remains enabled.
