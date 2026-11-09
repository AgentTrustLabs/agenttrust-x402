# TASK 48 — Ed25519 Signing Integration & Fee Validation

Implements and verifies the real Ed25519 signing path inside the dedicated Signing Service
using an isolated test-only key, corrects the sponsor signature-count handling, wires fee
validation into the payment pipeline, and verifies network identity at real-mode startup.

No real sponsor signing, no broadcast, no settlement, no funding, no sponsor account.

## VERDICT

**PASS.** All four objectives are implemented and verified. The test-only Ed25519 key never
leaves its process, the signature verifies with the official SDK, fee validation is now
actually invoked by the pipeline, and network genesis identity is checked at startup.

## CHANGES

| File | Change |
|---|---|
| `services/facilitator/src/signer.ts` | Added optional `validateContext` to the `SponsorSigner` interface (mock signers omit it). |
| `services/facilitator/src/sdkSponsorSigner.ts` | Hardened `validateSponsorContext` to reject malformed, negative, or non-bigint energy/fee values before comparison. |
| `services/facilitator/src/core.ts` | Calls `validateContext` before `addSponsorSignature` when the signer exposes it; fails closed with `fee_validation_failed` on a non-null result. |
| `services/facilitator/src/ipcSponsorSigner.ts` | Exposes `validateContext` on the IPC signer so the pipeline can reach it. |
| `services/facilitator/src/config.ts` | Added `FACILITATOR_MAX_FEE_MICROCCD` (default 10_000_000 = 10 CCD) and `FACILITATOR_MAX_ENERGY` (default 100_000), validated as non-negative integers. |
| `services/facilitator/src/server.ts` | Uses `config.maxFeeMicroCcd` / `config.maxEnergy`; wires `verifyNode()` into real-mode startup (no opt-out). |
| `scripts/task48-service.mts` | New harness: same interface as `task44-service.mts`, but uses `buildBasicAccountSigner` when `TASK48_TEST_KEY` is set to a 64-hex seed. |
| `test/task48-ed25519-signing-and-fee-validation.test.mts` | 24 tests across key isolation, fee validation, sponsor signature count, network identity, and cross-process Ed25519 signing. |
| `test/task46-facilitator-sponsor-signer-wiring.test.mts` | Fixture gained `FACILITATOR_NODE_USE_TLS=1`. TASK 48 wires `verifyNode()` into real-mode startup, and the public Testnet gRPC endpoint requires TLS, so the TASK 46 real-mode boot test could no longer complete the genesis check without it. One line; no assertion changed. |

No schema change. No change to `core.ts` settlement logic, `senderVerifier.ts`, `wireConverter.ts`,
`src/payments/**`, or token 1004.

## TEST-ONLY KEY ISOLATION

The test generates an Ed25519 keypair **in-process** with `node:crypto.generateKeyPairSync`.
The private seed (32 bytes, 64 hex) is passed to the service via the `TASK48_TEST_KEY`
environment variable; it is never written to disk by the harness, never logged, and never
appears in any IPC request or response.

Evidence:
- `A01` — private seed is 64 hex chars, public key is 64 hex chars.
- `A02` — two generated keypairs differ (no fixed test key).
- `A03` — the private seed and public key never appear in the IPC request.
- `E08` — the private seed never appears in the service's stdout/stderr.

The service harness (`scripts/task48-service.mts`) logs only `mode=ed25519`, never the key.
It falls back to `createFakeSigner()` when `TASK48_TEST_KEY` is absent, so existing TASK 44
behaviour is preserved.

## SDK SIGNATURE CONTRACT

Verified against the installed SDK (`node_modules/@concordium/web-sdk`):

- `AccountSigner` interface: `sign(digest: ArrayBuffer): Promise<AccountTransactionSignature>`
  plus `getSignatureCount(): bigint` (`signHelpers.d.ts:43-55`).
- `buildBasicAccountSigner(privateKey: HexString)` constructs a signer from a 32-byte seed
  (`signHelpers.ts:135-149`). It returns `{ 0: { 0: "<128 hex>" } }`.
- `Transaction.sponsor(signable, signer)` calls `AccountTransactionV1.createSignature` ->
  `signer.sign(signDigest(tx))` (`signable.ts:102-105`).
- `Transaction.verifySignature(tx, sigs, {accountThreshold, accountCredentials, accountAddress})`
  verifies against the account's `verifyKey` (`signable.ts:235-246`).

The test does not implement any cryptographic primitive. It uses `buildBasicAccountSigner`
for the in-process signer and the SDK's Ed25519 shim inside the service.

## CROSS-PROCESS SIGNING EVIDENCE

`E01`–`E08` prove the real Ed25519 path across separate OS processes:

1. `E01` — service runs in a separate PID and reports `mode=ed25519`.
2. `E02` — a real Ed25519 signature crosses the IPC boundary and `Transaction.verifySignature`
   accepts it against the test-only public key. The signature is not the fake constant
   (`'ee'.repeat(64)`).
3. `E03` — a forged signature (`'00'.repeat(64)`) is rejected by the SDK verifier.
4. `E04` — wrong sponsor -> `wrong_sponsor`; wrong network -> `wrong_network`.
5. `E05` — UID mismatch -> `unauthorized_peer` (SO_PEERCRED enforced by the service).
6. `E06` — timeout, crash (peer exits mid-request), and connection refused all fail closed.
   A stopped real service produces no local fallback.
7. `E07` — only the 32-byte digest crosses the socket; no transaction payload.
8. `E08` — the private seed never appears in service output.

The `agenttrust-sign v1` protocol is unchanged: `protocolVersion`, `requestId`, `operation`,
`digest`, `sponsor`, `network`, optional `context`.

## SPONSOR SIGNATURE COUNT

**Finding.** The SDK's `Transaction.sponsor()` calls `addSponsorSignature`, which validates
the sponsor signature count against `header.sponsor.numSignatures`. The error text for the
sponsor slot says "sender" because `mergeSignaturesInto` omits the `role` argument
(`signable.ts:283-284`) — an SDK labelling bug, not a logic bug.

**Correct source of expected sponsor signature count:** `header.sponsor.numSignatures` in the
transaction itself. `getSignatureCount()` is **not** consulted by the SDK signing path
(proved by `C02`, where a signer reporting `0n` still signs successfully).

**Correction.** The wire converter already defaults `sponsor.numSignatures` to 1
(`wireConverter.ts:245`), and every TASK 36/37/46 fixture uses 1. Regression test `C01` proves
`sponsor.numSignatures = 0` fails with "Too many sender signatures … specifies 0", while
`sponsor.numSignatures = 1` signs.

**Sender credential threshold verification** is unchanged: `Transaction.verifySignature`
enforces both the account threshold and the credential threshold, and `numSignatures` must
match the actual sender signature count.

## FEE VALIDATION

**Gap closed.** `validateContext` existed on the SDK adapter but was never called by
`FacilitatorCore`. The pipeline now calls it before `addSponsorSignature` (`core.ts`) when the
signer exposes it. A non-null result produces `fee_validation_failed` and zero downstream
signing calls.

**Relationship between energy, microCCD per NRG, and maximum fee:**
- Energy is derived from the transaction by `deriveEnergyExposure` (`energy.ts`) using the
  chain's own formula: `100 × signatureCount + 1 × (94 + payloadSize) + C_t`.
- The fee in microCCD is `energy × microCCD_per_NRG`. The current measured Testnet rate is
  **7,939.534 microCCD/NRG** (`microGTUPerEuro = 15861106753343934464/39954755281`,
  `euroPerEnergy = 1/50000`). A simple sponsored transfer (635 NRG) costs **~5.04 CCD**.
- `maxFeeMicroCcd` (default 10_000_000 = 10 CCD) and `maxEnergy` (default 100_000) are
  validated config values (`FACILITATOR_MAX_FEE_MICROCCD`, `FACILITATOR_MAX_ENERGY`).
- The pipeline uses a **conservative fee estimate** of `energy × 8000` microCCD — slightly
  above the measured rate so a rate shift cannot slip under the cap. Integer-safe (bigint).

**Validation rules** (`validateSponsorContext`, hardened):
- `energy` must be a positive bigint.
- `feeMicroCcd` must be a non-negative bigint.
- `energy > maxEnergy` -> rejected.
- `feeMicroCcd > maxFeeMicroCcd` -> rejected.
- `sponsor == recipient` -> rejected.
- malformed / negative / non-bigint values -> rejected with `malformed fee/energy context`.

**Regression tests:**
- `B01` — energy above cap rejected.
- `B02` — fee above cap rejected.
- `B03` — negative energy, zero energy, negative fee, non-bigint energy rejected.
- `B04` — valid context accepted; sponsor == recipient rejected.
- `B05` — the pipeline invokes `validateContext` and fails closed on a fee breach.
- `B06` — mock signers without `validateContext` are unaffected (mock flows preserved).

The previous constant of 1 CCD (`1_000_000n`) was below the measured ~5.04 CCD per transfer;
the new default of 10 CCD is justified by that measurement and remains settlement-disabled.

## NETWORK IDENTITY VERIFICATION

`verifyNode()` is now wired into real-mode startup in `server.ts`, after the provider is
constructed and before the sender verifier is built. A mismatch throws `ConfigurationError`
with `network identity verification failed: …`. There is no opt-out; mock mode never reaches
the code path.

- `D01` — `verifyNode()` passes for the matching genesis hash.
- `D02` — `verifyNode()` fails closed on a mismatching genesis hash.
- `D03` — real-mode startup fails closed when the node cannot confirm its genesis hash.

The provider's `getAccountInfo()` continues to validate the returned account identity.

## VERIFIED

- Test-only Ed25519 keypair generation and isolation (A01–A03, E08).
- Real Ed25519 signature across separate OS processes, verified by the official SDK (E02).
- Forged signature rejected (E03).
- Wrong sponsor/network refused (E04).
- UID mismatch refused by SO_PEERCRED (E05).
- Timeout, crash, connection refused all fail closed; no local fallback (E06).
- Only the digest crosses the socket (E07).
- Fee validation invoked by the pipeline and fails closed (B05, B06).
- Malformed/negative/unsafe fee and energy rejected (B03).
- Sponsor signature count: `numSignatures = 0` fails, `= 1` signs; `getSignatureCount()` not
  consulted (C01, C02).
- Network genesis identity checked at real-mode startup (D01–D03).
- `DENY_ALL_FACILITATOR` intact (F01).
- Settlement disabled by default (F02).
- Typecheck clean for facilitator and gateway.

## NOT TESTED

- A real sponsor account or its credential (test-only key only).
- Broadcast, submission, finalization, or settlement.
- A real `AccountSigner` built from a sponsor key.
- `verifyNode()` against a live Testnet endpoint inside the default runner (D03 uses an
  unreachable endpoint; TASK 40 verified the live endpoint separately).
- Multi-signature accounts (threshold > 1): the test uses threshold 1.
- Mainnet.

## BLOCKED

Nothing blocked. Two limitations are inherited and documented rather than expanded:

1. **`validateContext` is only reached when the signer exposes it.** Mock signers omit it, so
   mock flows cannot exercise the fee cap. Deliberate: the cap is a production control and the
   mock signer has no real fee.
2. **The fee estimate uses a conservative constant (8000 microCCD/NRG).** Fetching the live
   rate from chain parameters would add a network dependency to the pipeline; the constant is
   documented and the cap is validated.

## TEST RESULTS

```
dedicated suite (uid 1001 + group authclients):
  npx tsx test/task48-ed25519-signing-and-fee-validation.test.mts
  task48: 24/24 passed, 0 failed

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

Working tree only. Files touched: `signer.ts`, `sdkSponsorSigner.ts`, `core.ts`,
`ipcSponsorSigner.ts`, `config.ts`, `server.ts`, `scripts/task48-service.mts`,
`test/task48-ed25519-signing-and-fee-validation.test.mts`, this document.

## CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| Test-only Ed25519 key only | OK — generated in-process, never persisted, never logged. |
| No sponsor wallet creation or import | OK — no sponsor key anywhere. |
| No sponsor private-key access, generation, export, or signing | OK — the test key is not a sponsor key. |
| No sponsor funding or faucet | OK — untouched. |
| No Mainnet | OK — config refuses Mainnet; KNOWN_NETWORKS omits it. |
| No transaction broadcast or submission | OK — `submitTransaction` still throws "never broadcasts". |
| No real payment or settlement | OK — settlement disabled by default. |
| No real facilitator activation | OK — real mode cannot settle. |
| `DENY_ALL_FACILITATOR` intact | OK — F01. |
| Settlement disabled by default | OK — F02. |
| Token 1004 / Agent Card untouched | OK — no file under contracts/fixtures/evidence changed. |
| No schema change | OK — none. |
| No unrelated infrastructure hardening | OK — only the scoped changes above. |
| No commits or pushes | OK — HEAD unchanged. |

## REMAINING PREREQUISITES

Real sponsor signing still requires, and this task does not perform:

1. A funded Testnet sponsor account (not the registry owner).
2. A signing-service process owned by a dedicated UID, holding a real key supplied out-of-band.
3. A real `submitTransaction` / `waitForFinalization` implementation.
4. Maintainer approval to enable `FACILITATOR_MODE=real` with a real key.

What this task adds over TASK 46: a real Ed25519 signature that verifies with the SDK, an
enforced fee cap, and a startup network-identity check. The gap to a first real Testnet
payment is now purely operational (see TASK 47 §REMAINING PREREQUISITES).
