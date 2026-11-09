# TASK 65 — First Controlled Sponsored Transaction on Concordium Testnet

## PREFLIGHT

### P01. HEAD and working tree
- HEAD: `4c8994db391d77796e06e49c843c42be1eae615b`
- Working tree: DIRTY (expected development state — 177 modified/untracked paths from TASK01–TASK64).
- No source files were modified by this task. No commits or pushes.
- Result: PASS (dirty state is expected and documented).

### P02. Facilitator real-mode build
- Compiled output present: `services/facilitator/dist/server.js` (built with `tsc`, 0 errors).
- Real-mode startup probe (`scripts/task63-runtime-readiness.sh`) succeeded:
  - `facilitator listening on http://127.0.0.1:38225 (mode=real)`
  - `/healthz` → `{ok:true, mode:real, network:ccd:4221332d34e1694168c2a0c0b3fd0f27, canSign:true}`
  - `/supported` advertises sponsor `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK` as `feePayer`.
- Result: PASS.

### P03. Sponsor address
- Configured sponsor: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`
- Wallet export address matches the configured sponsor (read-only comparison; contents not printed).
- Result: PASS.

### P04. Testnet genesis and CAIP-2
- Node: `grpc.testnet.concordium.com:20000` (TLS).
- Genesis: `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`
- CAIP-2: `ccd:4221332d34e1694168c2a0c0b3fd0f27`
- Genesis match: YES (testnet). Mainnet not contacted.
- Result: PASS.

### P05. Sponsor account (read-only)
- Address: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`
- Status: EXISTS
- Balance: 20000.000000 CCD (20000000000 microCCD)
- Nonce: 1
- Account index: 19395
- Account threshold: 1
- Credentials: 1 (credential 0, threshold 1, 1 Ed25519 key)
- `ready for TASK57 loader`: YES
- Result: PASS.

### P06. Wallet export path and permissions
- Path: `/home/ubuntu/.agenttrust/sponsor.export`
- Mode: 0600 (owner read/write only)
- Owner: ubuntu (matches service user)
- Contents were NOT read, printed, copied, or transmitted. Only `stat` metadata was inspected.
- Result: PASS.

### P07. Fee and energy caps
- `FACILITATOR_MAX_FEE_MICROCCD` default: 10 000 000 microCCD = 10 CCD.
- `FACILITATOR_MAX_ENERGY` default: 1 000 NRG.
- Fee cap binds first in practice (energy above ~1250 NRG is rejected by the fee cap).
- A simple transfer is expected to require ~664 NRG, well within both caps.
- Result: PASS.

### P08. DENY_ALL_FACILITATOR and settlement
- `src/payments/x402.ts:411` — `DENY_ALL_FACILITATOR` unchanged: `verify` and `settle` throw;
  `kinds` returns empty. No facilitator is wired by default.
- Settlement remains disabled at the gateway layer.
- Result: PASS.

### P09. Transaction construction, signing, submission, and finalization path
Inspected against source (no execution):

```
POST /settle (x402 payload)
  → FacilitatorCore.settle
     → sender signature verification (SdkSenderVerifier, read-only account info)
     → authorization boundary (local client by default; IPC owner if configured)
     → wire conversion (convertV2ToSdkV1, policy-derived energy)
     → fee/energy context validation (validateContext)
     → addSponsorSignature (IpcSponsorSigner → SdkSponsorSigner → IpcAccountSigner → signing service, IPC digest only)
     → computeFinalizedTransactionHash
     → store.prepare (durable hash, created → prepared)
     → store.claimSubmit (prepared → submitting)
     → submitTransaction (IpcSponsorSigner → ConcordiumTransactionSubmitter.submit)
        → GrpcConcordiumTransport.submit
           → Transaction.signableFromJSON → Transaction.finalize
           → ConcordiumGRPCNodeClient.sendTransaction(Transaction.Finalized)
     → store.markBroadcast (submitting → outcome_unknown)
     → hash equality check (returned hash == persisted hash)
     → waitForFinalization (bounded poll of getBlockItemStatus)
     → reconcile (outcome_unknown → finalized / rejected)
```

Invariants verified:
- The facilitator holds no key material; signing is delegated over IPC (32-byte digest only).
- The submitter is injected and wraps the V1 gRPC transport; no broadcast occurs without a durable persisted hash and a broadcast claim.
- Recovery (`recoverPending`) polls by hash only and never resubmits.
- Result: PASS.

### P10. Proposed transaction parameters and expected effects

Proposed (subject to maintainer approval — see AWAITING APPROVAL):

| Parameter | Value |
|---|---|
| Transaction type | V1 sponsored simple transfer (`transfer`) |
| Network | Concordium Testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`) |
| Sponsor (fee payer) | `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK` |
| Sender | Operator account `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (key held by sender client, never by the facilitator) |
| Recipient | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (operator account; minimal self-transfer to avoid funding a third party) |
| Amount | 1 microCCD (0.000001 CCD) |
| Maximum fee | 10 CCD (`FACILITATOR_MAX_FEE_MICROCCD` = 10 000 000 microCCD) |
| Maximum energy | 1 000 NRG (`FACILITATOR_MAX_ENERGY`) |
| Expected energy | ~664 NRG (2 signatures × 100 + 94-byte sponsored header + ~70-byte payload + 300 base cost) |
| Expected fee | ~5.27 CCD at the measured Testnet rate (7939.534 microCCD/NRG); ≤ 10 CCD in all cases |
| Expected nonce (sponsor) | 1 → 2 |
| Expected nonce (sender) | 4 → 5 |
| Recipient effect | +1 microCCD |
| Sponsor effect | −1 microCCD − fee (~5.27 CCD); balance 20000.000000 CCD → ~19994.73 CCD |

Rollback limitations:
- Concordium transactions are final once finalized; there is no automatic rollback.
- If submission succeeds but finalization is ambiguous, the process must NOT retry; recovery reconciles by the persisted hash only.
- Fees are consumed even if the transaction is ultimately rejected.
- A crash between `submitTransaction` and `markBroadcast` leaves the row `outcome_unknown`; recovery resolves it by polling the recorded hash.
- A returned hash mismatching the persisted hash is a hard failure; the payment stays pending for manual reconciliation.
- The recipient receives the amount only on a `finalized` success outcome.

Result: PASS (parameters calculated; no transaction constructed or signed).

## AWAITING APPROVAL

Preflight complete. No transaction has been constructed, signed, submitted, or broadcast.

Maintainer must explicitly approve the EXACT parameters above before Phase 3:
- Transaction type: V1 sponsored simple transfer
- Recipient: `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`
- Amount: 1 microCCD
- Maximum fee: 10 CCD
- Sponsor account: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`

Approval of TASK65 itself is NOT approval to broadcast. Explicit approval of the exact
parameters above is required.

## EXECUTION

Executed: one transaction (single submission; no retry).

Pre-submission revalidation:
- Testnet genesis and CAIP-2 revalidated against `grpc.testnet.concordium.com:20000` — match.
- Sender account: EXISTS, 19943.619923 CCD, nonce 4, 1 Ed25519 credential, thresholds 1/1.
- Sponsor account: EXISTS, 20000.000000 CCD, nonce 1, 1 Ed25519 credential, thresholds 1/1.
- Recipient account: EXISTS, 20000.000000 CCD, nonce 1, 1 credential, threshold 1.
- Wallet files: sender.export and sponsor.export both 0600, owner ubuntu; contents never printed.
- `DENY_ALL_FACILITATOR` remains enabled; settlement remains disabled.

Construction and signing:
- V1 sponsored simple transfer built with the official Concordium SDK.
- Sender signature produced from the locally provisioned sender wallet export (TASK66-verified).
- Sponsor signature produced by the dedicated IPC signing service holding the sponsor wallet export.
- Both signatures verified with `Transaction.verifySignature` against live Testnet account info:
  - sender_signature_valid: true
  - sponsor_signature_valid: true
  - negative control: sender signature verified against the sponsor account = false (verifier is not vacuously true)
- Derived energy: 635 NRG (within the approved 1000 NRG cap).
- Estimated fee at the conservative 8000 microCCD/NRG rate: 5 080 000 microCCD (5.08 CCD), within the approved 10 CCD cap.

Submission:
- Submitted exactly once via `Transaction.finalize()` → `ConcordiumGRPCNodeClient.sendTransaction()`.
- Returned transaction hash: `c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a`
- No second submission. No retry.

Hash note (public, no secrets):
- The locally computed pre-submission hash differed from the node-returned hash because the SDK's
  `Transaction.getAccountTransactionHash` hashes the serialized transaction without the block-item
  kind prefix, while the node's transaction hash includes it. The node-returned hash is authoritative.
  The transaction itself was accepted and finalized.

## ON-CHAIN EVIDENCE

- Network: Concordium Testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`)
- Genesis: `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796` (match)
- Transaction hash: `c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a`
- Finalization status: `finalized`
- Block hash: `f7dcec686e29bfd6acca13f7b8f3d2e88d054058776c4a4df5db68d6b4320bd7`
- Outcome: `transfer` (successful; no reject reason)
- Energy cost: 635 NRG
- Sponsor fee: 4 695 636 microCCD = 4.695636 CCD
- Transfer amount: 1 microCCD
- Transfer recipient: `3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB`
- Sender: `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`
- Sponsor: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`

Account changes (read-only, before → after):
- Sender: 19943.619923 CCD / nonce 4 → 19943.619922 CCD / nonce 5 (−1 microCCD)
- Sponsor: 20000.000000 CCD / nonce 1 → 19995.304364 CCD / nonce 1 (−4.695636 CCD fee; nonce unchanged)
- Recipient: 20000.000000 CCD / nonce 1 → 20000.000001 CCD / nonce 1 (+1 microCCD)

## FINAL VERDICT

PASS

The single approved V1 sponsored transfer is independently confirmed finalized successfully on
Concordium Testnet. Exactly one transaction was submitted. No retry, no second transaction.

No faucet or funding operation was performed. Token 1004 and its Agent Card were not modified.
`DENY_ALL_FACILITATOR` remains enabled; settlement remains disabled. No commits or pushes.
No wallet contents or private key material were exposed.


