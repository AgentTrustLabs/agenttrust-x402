# TASK 47 — Sponsor Provisioning Readiness & Testnet Payment Execution Plan

Investigation and documentation only. No code changes, no wallet, key, funding, signing,
transaction, or settlement action. No commits.

## VERDICT

**PASS (documentation deliverable).** The codebase is already wired end-to-end for fake
signing (TASK 46). What remains is operational: a funded Testnet sponsor account, a signing
service that actually holds an Ed25519 key, and maintainer approval. This report enumerates
those, corrects one stale cost estimate in TASK 42, and proposes one narrowly scoped TASK 48
that proves a *real* signature while still refusing to broadcast.

## CURRENT VERIFIED BASELINE

| Capability | Status | Evidence |
|---|---|---|
| SDK sponsor adapter (`createSdkSponsorSigner`) | implemented | `services/facilitator/src/sdkSponsorSigner.ts`; TASK 35 (14 tests) |
| IPC signing service + client (`createSigningService`, `IpcAccountSigner`) | implemented | `services/facilitator/src/signingService.ts`; TASK 43 (13), TASK 43 IPC (6) |
| Separate-process boundary | verified | `scripts/task44-service.mts`, `scripts/task44-client.mts`; TASK 44 (9) |
| Facilitator startup wiring | implemented | `services/facilitator/src/server.ts` `startFacilitator()` real branch; TASK 46 (30) |
| Real-mode config (`FACILITATOR_SIGNING_SERVICE_SOCKET`/`_UID`) | implemented | `services/facilitator/src/config.ts` `loadConfig`; TASK 46 A04–A10 |
| Sender verification (SDK + gRPC provider) | implemented | `senderVerifier.ts`, `grpcAccountInfoProvider.ts`; TASK 38/39/41 |
| Authorization owner IPC | implemented | `authorization.ts` `IpcAuthorizationClient`; TASK 34 arc |
| Wire converter V2 to SDK V1 | implemented | `wireConverter.ts`; TASK 36 (27) |
| Payment pipeline ordering | implemented | `core.ts` `settle()`; TASK 37 (15) |
| Settlement submission | **not implemented** | `ipcSponsorSigner.ts:91-92` throw "never broadcasts" |
| Real signer construction | **not implemented** | no `buildBasicAccountSigner` call in `src/` or `services/` |
| Live Testnet sponsor account | **missing** | TASK 42 §1, §3 |
| Signing service process | **missing** | TASK 43 §180; no systemd unit exists |
| Live sender verification for a sponsor | **not performed** | TASK 40 verified a different account |
| Mainnet | out of scope | `config.ts` refuses `MAINNET_CAIP2`; `KNOWN_NETWORKS` omits it |

Baseline suite: 60 suites, 59 PASS, 1 known concurrency flake (`task14-audit-strictness`,
passes standalone). Typecheck clean for facilitator and gateway.

## SPONSOR ACCOUNT REQUIREMENTS

Sources: TASK 42 §1–§5, TASK 45 §SPONSOR ACCOUNT REQUIREMENTS, `config.ts:94`
(`isConcordiumAccount`, base58check 45–55 chars), `grpcAccountInfoProvider.ts` validation.

1. **New dedicated account.** The operator account
   `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (19943.619923 CCD, TASK 02) is the
   token-1004 registry owner and must not double as fee-payer. Conflating them breaks key
   rotation and audit attribution.
2. **Concordium Testnet account** (base58check). Mainnet is refused by config.
3. **At least one active credential (index 0)** holding an Ed25519 key pair.
4. **Thresholds = 1** at both levels: `accountThreshold = 1` and
   `credentialPublicKeys.threshold = 1`, so one `AccountSigner` signature suffices.
   TASK 40 confirmed this is the live shape for the verified account.
5. **Balance — corrected.** The TASK 42 estimate of ~0.025 CCD per transfer is stale. Measured
   on 2026-11-07 against `grpc.testnet.concordium.com:20000`:
   - `convertEnergyToMicroCcd(Energy.create(635n), chainParams)` = **5,041,605 microCCD ≈
     5.04 CCD** for one simple V1 sponsored transfer (2 signatures, 41-byte payload,
     300 NRG base energy, header 94 bytes).
   - Current rate: **7,939.534 microCCD per NRG**
     (`microGTUPerEuro = 15861106753343934464/39954755281`, `euroPerEnergy = 1/50000`).
   - Cross-check: a historical `update` transaction on this network cost 22.010289 CCD for
     2380 NRG = 9248.02 microCCD/NRG at its block; the rate has since moved, so the *cost per
     transfer* is roughly 5 CCD at today's parameters, not 0.025 CCD.
   - **Recommendation: fund 50–100 CCD** (10–20 settlements incl. retries), not 5 CCD.
6. **Separation of roles.** Registry owner, sponsor account, and signing-service UID are three
   distinct things. No schema change, no Agent Card change.
7. **Maintainer approvals required:** account creation; funding source (transfer from
   `4dWn8miA…` vs faucet); custody approach; enabling `FACILITATOR_MODE=real`; any change to
   `maxFeeMicroCcd`/`maxEnergy`; any settlement activation.

No account is created or funded here.

## CUSTODY OPTIONS

Sources: TASK 42 §5–§7, TASK 43 §2, TASK 45 §MISSING PREREQUISITES,
`node_modules/@concordium/web-sdk/lib/esm/signHelpers.d.ts:73,82,91,100,109`.

| Option | Process owner | SDK construction | Key exposure boundary | Pros | Limits |
|---|---|---|---|---|---|
| A. In-process signer in the facilitator | facilitator UID | `buildBasicAccountSigner(hex)` | key inside the facilitator process | simplest | violates TASK 24; rejected — the adapter has no key parameter by design |
| B. Dedicated signing service (recommended) | separate UID (proposed 1005) | `buildBasicAccountSigner` / `buildAccountSigner` inside the service | key never leaves the service process | reuses TASK 34 isolation, TASK 43/44 IPC, TASK 46 wiring; all already tested | needs a process supervisor and a dedicated UID |
| C. Interactive browser/mobile wallet | user device | proxy implementing `AccountSigner` | user-held | no server-side key | **cannot run unattended**: every transaction needs a click/PIN, which stalls agent-to-agent flow |
| D. HSM / KMS | external appliance | service calls HSM API | HSM-bound, non-exportable | strongest custody | no HSM in this environment; out of scope for a hackathon demo |

**Recommendation: Option B.** Justification:
- The IPC protocol (`agenttrust-sign v1`), the SO_PEERCRED gate (`scripts/task348-peercred`),
  and `IpcAccountSigner` already exist and are covered by tests.
- `createSigningService({ accountSigner })` (`signingService.ts:124`) accepts an injected
  `AccountSigner` with **no protocol change**; only the construction of that signer inside the
  service differs from today.
- Option A is structurally forbidden; Option C cannot be unattended; Option D needs hardware
  that does not exist here.

Required configuration for Option B: the variables below, a `signer` OS user, the socket at
`signer:authclients` mode 0660, and a supervisor (manual start is acceptable for the demo).

**Key material** is supplied out-of-band to the signing-service operator only. It never enters
chat, the facilitator, this repository, or any log.

## REAL ACCOUNTSIGNER GAP

Existing and verified:
- `AccountSigner` = `sign(digest: ArrayBuffer): Promise<AccountTransactionSignature>` +
  `getSignatureCount(): bigint` (`signHelpers.d.ts:43-55`).
- `IpcAccountSigner` implements it (`signingService.ts:286`), carrying only socket, expected
  UID, sponsor, network, timeout.
- `createSdkSponsorSigner({ accountSigner })` consumes it (`sdkSponsorSigner.ts:33-46`) and signs
  through `Transaction.sponsor(signable, opts.accountSigner)` (`sdkSponsorSigner.ts:160`).
- `createSigningService({ accountSigner })` calls `opts.accountSigner.sign(digestBuffer)`
  (`signingService.ts:183-195`) and returns the `AccountTransactionSignature` unchanged.
- Response format: `{0: {0: "<128 hex>"}}` — one credential index, one key index, as produced by
  `createFakeSigner` (`signingService.ts:107-120`).
- Signature-count semantics: the SDK's `sponsor()` calls `AccountTransactionV1.createSignature`
  → `signer.sign(signDigest(tx))`; `getSignatureCount()` is declared in the interface but the
  signing path does **not** consult it — the header's `sponsor.numSignatures` is the authority
  (`Transaction/signable.ts:274-284` `validateSignatureAmount`). This is why the TASK 46 fixture
  must declare `sponsor.numSignatures: 1`; with `0` the SDK throws
  "Too many sender signatures added".
- Fail-closed behaviour: every rejection path rejects the client promise; there is no branch
  that fabricates a signature (`signingService.ts:305-390`).

Not implemented — the actual gap:
1. **Real signer construction inside the service.** `createSigningService` has only ever been
   given `createFakeSigner()`. A real service must call `buildBasicAccountSigner(privateKey)`
   or `buildAccountSigner(walletExport)` (`signHelpers.d.ts:73,82`). No such call exists in
   `src/` or `services/`.
2. **`submitTransaction` / `waitForFinalization`.** Both throw "never broadcasts"
   (`ipcSponsorSigner.ts:91-92`), though `SponsorSigner` requires them (`signer.ts:70-90`).
   A real settlement needs `client.sendAccountTransaction(transaction, signature)`
   (`GRPCClient.d.ts:191`) and
   `client.waitForTransactionFinalization(hash, timeout)` (`GRPCClient.d.ts:302`).
3. **`verifyNode()` not wired at startup.** Supported by the provider
   (`grpcAccountInfoProvider.ts:128-131`), never called from `server.ts`.
4. **Sponsor account info never queried.** TASK 40 verified `4dWn8miA…`; the sponsor is a
   different account.
5. **`createSigner` still throws in real mode** (`signer.ts:349`). Dead code — `server.ts` no
   longer calls it — but it must not be resurrected.
6. **Fee cap is wrong.** `maxFeeMicroCcd: 1_000_000n` (1 CCD) in `server.ts:141` is below the
   measured ~5.04 CCD per transfer. Note `validateContext` (`sdkSponsorSigner.ts:72-94`) is
   currently **not called** by `core.ts` or by the adapter's `addSponsorSignature`, so the cap
   is effectively inert today — another reason not to treat the constant as a real control.

## REQUIRED CONFIGURATION

| Variable | Defined in | Status |
|---|---|---|
| `FACILITATOR_MODE=real` | `config.ts` | ready |
| `FACILITATOR_SPONSOR_ADDRESS` | `config.ts` | needs the new sponsor address |
| `FACILITATOR_NETWORK` | `config.ts` | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |
| `FACILITATOR_SENDER_VERIFICATION=sdk` | `config.ts` | ready (required in real mode) |
| `FACILITATOR_NODE_HOST` / `_PORT` | `config.ts` | `grpc.testnet.concordium.com` / `20000` |
| `FACILITATOR_AUTHZ_SOCKET` | `config.ts` | recommended (owner process) |
| `FACILITATOR_DB_PATH` | `config.ts` | durable path; `:memory:` refused in real mode |
| `FACILITATOR_SIGNING_SERVICE_SOCKET` | `config.ts` (TASK 46) | needs the service socket path |
| `FACILITATOR_SIGNING_SERVICE_UID` | `config.ts` (TASK 46) | needs the service UID (proposed 1005) |
| `FACILITATOR_SIGNING_TIMEOUT_MS` | `config.ts` | default 10000 |

No new variables beyond TASK 46's two. `maxFeeMicroCcd` and `maxEnergy` are code constants in
`server.ts:140-141`, not environment-driven — changing them is a code change.

## FIRST TESTNET PAYMENT SEQUENCE

Each step: prerequisites, expected evidence, stop condition.

1. **Sponsor account readiness** — maintainer action.
   Prereq: approved custody decision and an out-of-band key handover.
   Evidence: base58check address; credential 0 with one Ed25519 key; `accountThreshold = 1`.
   Stop: invalid address, or threshold other than 1.

2. **Funding prerequisite** — maintainer action.
   Prereq: step 1. Evidence: on-chain balance ≥ 50 CCD via `getAccountInfo`.
   Stop: balance below 10 CCD (less than two settlements at the measured rate) or any failed
   funding operation.

3. **Signing service preparation** — implementation (TASK 48).
   Prereq: steps 1–2, a dedicated OS user (proposed `signer`), socket directory 0750.
   Evidence: service binds the socket at 0660 `signer:authclients`; `peerCredOf` reports the
   expected UID; SIGTERM unlinks the socket.
   Stop: cannot bind, wrong peer UID, or a socket left behind after shutdown.

4. **Real AccountSigner integration** — implementation (TASK 48), no broadcast.
   Prereq: step 3. Evidence: the service returns a signature that differs from the input
   digest; `IpcAccountSigner.sign()` returns it unchanged; `Transaction.verifySignature`
   accepts it against the live sponsor `AccountInfo`.
   Stop: any verification failure, or any code path touching key material outside the service.

5. **Facilitator configuration** — ops.
   Prereq: steps 1–4. Evidence: `loadConfig` accepts the environment; `startFacilitator`
   binds; `/healthz` reports `mode: real`, `canSign: true`.
   Stop: any `ConfigurationError`.

6. **Sender verification** — ops plus live network.
   Prereq: steps 1–5. Evidence: `GrpcAccountInfoProvider.getAccountInfo(sponsor)` returns the
   requested address with threshold 1 and one Ed25519 key; `verifyNode()` (to be wired) matches
   genesis hash `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`.
   Stop: `unknown_network`, `account_not_found`, or genesis mismatch.

7. **Agent-to-agent payment request** — client side.
   Prereq: steps 1–6, a second Testnet account as the sender (agent B), a sender-signed V1
   transaction, and an x402 payload carrying it.
   Evidence: `/verify` returns `isValid: true` with a 64-hex digest; sender verification
   passes; a durable authorization approval is recorded.
   Stop: any sender-verification or authorization rejection.

8. **Signature and transaction verification** — facilitator.
   Prereq: step 7. Evidence: `addSponsorSignature` returns a transaction with a populated
   sponsor slot; `computeTransactionHash` yields 64 hex; the value equals the persisted hash.
   Stop: missing sponsor signature, hash mismatch, or any throw.

9. **Settlement and on-chain confirmation** — gated, requires TASK 49+ and approval.
   Prereq: steps 1–8 **plus** a real `submitTransaction`/`waitForFinalization` implementation,
   maintainer approval to activate settlement, and an explicit `allowSettlement` flag.
   Evidence: a real transaction hash from `sendAccountTransaction`; `finalized` status from
   `waitForTransactionFinalization`; a resolving CCDExplorer URL.
   Stop: anything short of `finalized` is non-terminal and must never be reported as success.

10. **CCDExplorer evidence collection.**
    Prereq: step 9. Evidence: `explorerUrl(network, txHash)` (`src/payments/x402.ts`) returns
    `https://ccdexplorer.io/testnet/transaction/<hash>` and the page shows the sponsor as fee
    payer. Stop: URL does not resolve, or the sponsor does not match.

Steps 1–8 are TASK 48 territory. Steps 9–10 need a further task and explicit approval.

## DEMO READINESS

Smallest credible Hackathon demonstration:

1. **Agent A identity** — token 1004, owner `4dWn8miA…`, card at
   `https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json`. Unmodified.
2. **Agent B identity** — a second Testnet account acting as payer/sender. Registry
   registration is not required for the demo.
3. **Agent Card verification** — `verifyAgent` plus trust policy (TASK 03/05). No new code.
4. **Payment request** — `buildPaymentRequirements` with `extra.feePayer = <sponsor>`, amount in
   microCCD, Testnet CAIP-2 (TASK 07 rules).
5. **Sponsor signing** — the IPC path returning a real Ed25519 signature. This is the new
   capability TASK 48 delivers.
6. **Settlement result** — reported honestly: with no broadcast implementation the outcome is
   `settlement_pending` with a sponsored hash. That is a legitimate auditable state, not a
   failure and not a success.
7. **On-chain evidence** — only if steps 9–10 are reached; otherwise the demo ends at
   "sponsored hash recorded, submission deliberately not implemented".

Demonstrable **before** real settlement exists: the full pipeline through a real sponsor
signature verified by the SDK against live account info; a deterministic recomputable sponsored
hash; fail-closed behaviour for every missing or invalid component; `DENY_ALL_FACILITATOR` and
settlement-disabled defaults intact.

No dashboard, no product expansion. The demo is one CLI run plus a signed payload and a hash.

## BLOCKER MATRIX

| Blocker | Class | Severity | Resolution |
|---|---|---|---|
| No funded sponsor account | Account provisioning | High | Maintainer funds ≥ 50 CCD |
| No custody decision | Maintainer decision | High | Approve Option B |
| No signing-service process | Implementation | High | TASK 48 |
| `buildBasicAccountSigner` never called | Implementation | High | TASK 48 |
| `submitTransaction` unimplemented | Implementation | Medium (blocks step 9 only) | TASK 49+ |
| `waitForFinalization` unimplemented | Implementation | Medium (blocks step 9 only) | TASK 49+ |
| `verifyNode()` not wired at startup | Implementation | Low | TASK 48 (optional) |
| `maxFeeMicroCcd` below real cost and not enforced | Implementation | Medium | TASK 48 |
| Sponsor account info never queried | Testnet operational verification | Low | TASK 48 |
| `createSigner` still throws (dead code) | Implementation | Low | Remove in TASK 48 |
| Written approval to activate real mode | Maintainer decision | High | Explicit approval |
| Demo scope and narrative | Hackathon demo preparation | Low | This document |

Optional production hardening (systemd unit, `ProtectHome`, `SystemCallFilter`,
`RestrictAddressFamilies`, fail2ban, unattended-upgrades) is **not** a Hackathon blocker and is
out of scope.

## MAINTAINER DECISIONS REQUIRED

1. Approve a new dedicated Testnet sponsor account (not the registry owner).
2. Choose the funding source: transfer from `4dWn8miA…` (19943.619923 CCD available) or faucet.
3. Approve Option B custody: a separate UID signing service holding the key.
4. Approve raising `maxFeeMicroCcd` to cover the measured ~5.04 CCD per transfer, and decide
   whether `validateContext` should be enforced at all.
5. Approve TASK 48 scope: real signer inside the service, fake-free IPC test, still no broadcast.
6. Confirm settlement stays disabled until a separate approval after TASK 48/49.

None of these is decided by this report.

## RECOMMENDED TASK48

**TASK 48 — Real Ed25519 Sponsor Signer in the Signing Service (Still No Broadcast)**

Scope:
1. Add an explicit real-signer path to the signing-service harness (`scripts/task48-service.mts`
   or a flag on the TASK 44 script) that calls `buildBasicAccountSigner` from key material
   supplied out-of-band, gated behind an explicit `TASK48_REAL_SIGNER=1`. Default remains
   `createFakeSigner()`.
2. Wire `verifyNode()` into `startFacilitator` for real mode so a wrong genesis hash fails at
   startup rather than at first request.
3. Raise `maxFeeMicroCcd` to a value covering the measured cost (e.g. `10_000_000n`) and/or
   actually enforce `validateContext`; document whichever is chosen.
4. Integration test using a test-only Ed25519 key generated **inside the test process** and never
   persisted, asserting: signature differs from digest; `Transaction.verifySignature` accepts it
   against account info derived from that test key; the facilitator records a sponsored hash;
   invalid or missing key fails closed; `DENY_ALL_FACILITATOR` and settlement defaults unchanged.
5. Document the service boundary and the out-of-band key-handling procedure.

Out of TASK 48: broadcast, finalization, settlement activation, account creation, funding, any
change to `DENY_ALL_FACILITATOR`, token 1004, or the Agent Card.

Prerequisites: maintainer approval of decisions 1–4 above.

## NOT TESTED

- Any real Ed25519 signature, and the transaction hash it produces with a real signature.
- `buildBasicAccountSigner` / `buildAccountSigner` (never called anywhere in this repo).
- `Transaction.verifySignature` against a real sponsor account (only a fixture, TASK 40).
- `verifyNode()` at startup (not wired).
- A real sponsored *transfer's* energy against the chain — the measured 2380-NRG data point is an
  `update` transaction; the 635-NRG figure comes from the SDK's own
  `calculateEnergyCost(2n, payload, 300n, {sponsor:true})`.
- The proposed `signer` UID 1005 (only 1001/997/995 exist in this environment).
- `maxFeeMicroCcd` adequacy (constant is 1 CCD; measured cost is ~5.04 CCD; and the check is not
  wired into the pipeline at all).

## OUT OF SCOPE

- Wallet creation, import, export, or any key operation.
- Funding, faucet, or transfers.
- Transaction construction, submission, or broadcast.
- Mainnet.
- Real facilitator activation or settlement activation.
- Any change to `DENY_ALL_FACILITATOR` or the settlement default.
- Token 1004 / Agent Card changes.
- Schema changes.
- Unrelated infrastructure hardening (systemd, sandboxing, fail2ban, upgrades).
- Starting TASK 48 or performing any provisioning.

Stop condition met. Awaiting maintainer review.
