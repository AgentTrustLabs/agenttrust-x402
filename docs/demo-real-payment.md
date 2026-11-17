# AgentTrust x402 — Real Testnet Payment Demo

**Status: VERIFIED LIVE.** On 2026-11-11, the self-hosted AgentTrust facilitator settled one
real sponsored payment on Concordium Testnet: 1 microCCD from sender to recipient, fee paid
by the sponsor, transaction finalized on chain. This document explains what was proven, how
it works, and how to verify it without trusting this repository.

- Transaction: `b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb`
- Explorer: https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb
- Evidence file: [`docs/evidence/real-payment-2026-11-11.json`](evidence/real-payment-2026-11-11.json)
- Evidence check (read-only, no broadcast): `npx tsx scripts/demo-real-payment.mts`
- Runbook: [`docs/demo-runbook.md`](demo-runbook.md)

This is **not** the MCP `commerce.simulate` demo. That path still uses a mock facilitator and
reports `settled: false` (see [Simulated settlement](../README.md#simulated-settlement--read-this-before-the-demo)).
This document covers the real facilitator service in `services/facilitator/`.

## The problem

An AI agent that wants to pay another agent on chain faces three bad options: hand its
private key to a facilitator, trust a facilitator to decide what it may spend, or do
without on-chain payment at all. AgentTrust x402 splits the job so no single component
can spend on its own:

- the **sender** pays the amount and signs the transfer with its own key;
- the **sponsor** pays only the transaction fee, never the amount;
- the **Authorization Owner** decides whether a payment may proceed, but never signs;
- the **Signing Service** holds the sponsor key and signs only what the Owner approved,
  but never decides;
- the **Facilitator** orchestrates the flow and talks to the chain, but holds no key at all.

A payment settles only when all of them agree, in order, and every step is recorded in a
shared database before the transaction is broadcast.

## Architecture

```
Client (sender, holds its own key)
  │  POST /verify, POST /settle  (x402 v2 envelope, signed V1 transfer)
  ▼
Facilitator  (127.0.0.1:8787, real mode, UID 1001)
  │  validates · claims · verifies sender signature (SDK) · asks Owner
  │  converts wire format · asks Signing Service · submits · awaits finality
  ├───────────────────────────┬───────────────────────────┐
  ▼                           ▼                           ▼
Authorization Owner      Signing Service            Concordium Testnet
(authz.sock, UID 1001)   (sign.sock, UID 1001)      (grpc.testnet.concordium.com:20000)
  │ decides approve /       │ holds sponsor key,          │ getBlockItemStatus
  │ reject, durable gate    │ signs 32-byte digests only  │ submit + finalization
  └───────────┬─────────────┘
              ▼
        Shared SQLite DB (facilitator.db, 0600)
        payments · sign_events · settlements · transitions
```

- **Facilitator** (`services/facilitator/src/server.ts`, `core.ts`): HTTP service, `GET /healthz`,
  `GET /supported`, `POST /verify`, `POST /settle`. Real mode requires `FACILITATOR_MODE=real`,
  SDK sender verification, the Owner socket, and the signing-service socket — all fail-closed
  at startup. It never reads the sponsor wallet file (it only validates its path) and never
  holds a private key.
- **Authorization Owner** (`scripts/authz-owner.mts`): separate process, protocol
  `agenttrust-authz v1` over a Unix socket, peer UID checked with `SO_PEERCRED`. It enforces
  the policy (network, version, asset, sponsor, recipient, amount, expiry, energy cap) and
  records exactly one approval per payment digest in the shared DB. See
  [`docs/authorization-owner.md`](authorization-owner.md).
- **Signing Service** (`scripts/sponsor-wallet-service.mts`): separate process, loads the
  sponsor wallet export once at startup, listens on a Unix socket, signs only 32-byte
  digests for the configured sponsor and network, refuses any other peer UID (root included)
  and any other sponsor.
- **Shared DB**: Owner and Facilitator open the same `facilitator.db`. The Owner proves it is
  on the right file with the `db_identity` operation (device + inode); the Facilitator
  refuses to start if the Owner is on a different database.

## Payment flow, request to finality

The Facilitator's `settle` path (`services/facilitator/src/core.ts`) runs in this exact order.
No step is skipped, and no later step runs if an earlier one fails:

1. **Requirements.** The client builds x402 requirements with
   `buildPaymentRequirements` (`src/payments/x402.ts`): scheme `exact`, network
   `ccd:4221332d34e1694168c2a0c0b3fd0f27`, asset `CCD`, amount in microCCD, `payTo`,
   `maxTimeoutSeconds`, `extra.feePayer` = sponsor address.
2. **Sender signs.** The sender builds a Concordium V1 sponsored transfer (sender, live
   nonce, expiry ≤ now + 600 s, `executionEnergyAmount` 300 = simple-transfer base cost,
   sponsor account, payload `transfer` to the recipient, empty sponsor signatures) and
   signs it with its own key via `Transaction.sign`. The sponsor signature is **not**
   present yet — only the Facilitator may add it.
3. **Verify.** `POST /verify` checks agreement between accepted requirements and the
   signed transaction (scheme, network, asset, amount, payTo — the signed amount is the
   source of truth), expiry, and replay. Response: `isValid: true`, payer, payment digest.
4. **Settle — claim.** `POST /settle` atomically claims the payment digest. A concurrent
   duplicate gets `in_progress` or `settlement_pending`; a replay of a finished payment
   returns the same transaction hash with `idempotentReplay: true`.
5. **Sender verification.** The Facilitator verifies the sender signature with the official
   SDK primitive `Transaction.verifySignature`, using account keys fetched from the live
   Testnet node — never from the caller. Failure stops the flow before authorization.
6. **Authorization.** The Facilitator asks the Owner to authorize the payment (network,
   version, sender, sponsor, recipient, asset, amount, expiry, policy-derived energy).
   The Owner approves or rejects and records the decision durably. A rejection never
   reaches the signer.
7. **Wire conversion.** The signed transaction is converted to the canonical SDK V1 wire
   shape. The energy used is the policy-derived base cost, never a client-supplied value.
8. **Sponsor signing.** The Facilitator sends only the 32-byte digest to the Signing
   Service over IPC. The service signs it as the sponsor and returns the signature.
9. **Hash persisted before broadcast.** The final transaction hash is computed from the
   fully signed transaction and durably stored (`prepared`) **before** any broadcast.
   If the process dies after this point, recovery reconciles by hash — it never resubmits.
10. **Submit and finalize.** The Facilitator submits via gRPC and awaits finalization.
    The response carries `success: true`, the transaction hash, and `finality: "finalized"`.

## Separation of duties

| Component | Can do | Cannot do |
|---|---|---|
| Facilitator | validate, claim, verify sender signature, submit, record | sign anything, read the sponsor key, authorize alone |
| Authorization Owner | approve / reject a payment, record the decision durably | sign, submit, spend |
| Signing Service | sign a 32-byte digest as the sponsor | decide whether a payment is allowed, read other files, broadcast |
| Sender | pay the amount, sign its own transfer | pay the fee, change the sponsor |
| Sponsor | pay the transaction fee | receive the amount, change the recipient or amount |

The sponsor key lives only in the Signing Service process. The Facilitator's log line on
startup says it plainly: *"this process holds no private keys."*

## Sponsor-paid transaction

In the verified payment, the money moves in two separate directions:

- **Amount: 1 microCCD (0.000001 CCD)** — paid by the sender to the recipient. The
  sender's balance fell by exactly 1 microCCD; the recipient's rose by exactly 1 microCCD.
- **Fee: 4,620,843 microCCD (4.620843 CCD)** — paid by the sponsor. The sponsor's balance
  fell by exactly that amount; its nonce did not change (a sponsored transaction consumes
  the sender's nonce, not the sponsor's).

Energy was 635 NRG, under the 1,000 NRG policy cap. The fee cap is 10 CCD; the
Facilitator estimates the fee as derived energy × 8,000 microCCD/NRG before signing and
refuses the payment if the estimate exceeds the cap.

## Idempotency and recovery state

The shared DB records the whole lifecycle as a state machine (`transitions` table):

```
created (verified) → claimed for settlement → prepared (hash persisted pre-broadcast)
  → submitting (broadcast claim taken) → outcome_unknown (broadcast attempted)
  → finalized (verified finalized)
```

- **One payment, one approval.** `sign_events` holds exactly one `approved` row for the
  payment digest; a unique index enforces at most one approval.
- **One payment, one settlement.** `settlements` holds exactly one row with the transaction hash.
- **Replay is safe.** Re-submitting the same envelope returns `success: true` with the same
  hash and `idempotentReplay: true` — no second broadcast, no second transaction. Verified
  live: sender nonce stayed 14 after the replay.
- **Ambiguous submission never auto-retries.** If a previous attempt is `submitting` with a
  persisted hash, the Facilitator returns `settlement_pending` and the operator reconciles
  by hash. There is no automatic re-broadcast.

## Real transaction evidence

Verified 2026-11-11 ~09:17 WIB. All values below are public on-chain data.

| Field | Value |
|---|---|
| Transaction hash | `b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb` |
| Block hash | `387ae4ffed5ae328566efb30e379539cf3632714ed55564a60237420a49310a4` |
| Block height | 50,652,456 |
| Network | Concordium Testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`) |
| Status | `finalized` |
| Type | `transfer` (account transaction) |
| Sender | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (nonce 13 → 14) |
| Sponsor (fee payer) | `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK` (nonce 1, unchanged) |
| Recipient | `3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB` |
| Amount | 1 microCCD (0.000001 CCD) |
| Energy | 635 NRG (policy cap 1,000) |
| Sponsor fee | 4,620,843 microCCD (4.620843 CCD, cap 10 CCD) |
| Payment digest | `023049af728d4f03af835ebabe667fb3ffbb7eb9eec32a65ebbf539e606c4ffa` |
| DB records | 1 payment (`finalized`), 1 settlement, 1 approved sign event |
| Idempotent replay | `true`, same hash, no second transaction |

### How to verify it yourself

1. **Explorer (no code).** Open the transaction on CCDScan Testnet:
   https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb
   Check: status `SUCCESS` (included in block 50,652,456, i.e. finalized), sender,
   sponsor, recipient, amount `0.000001 CCD`, cost `4.620843 CCD`. The panel does not
   show the energy figure; 635 NRG comes from the gRPC summary, which the demo
   script checks live.
2. **Demo script (read-only).** From a checkout, no wallet or key needed:
   ```bash
   npx tsx scripts/demo-real-payment.mts
   ```
   It re-checks every field above against the live Testnet node, plus the local
   facilitator `/healthz` and the DB counts when they are available. Exit 0 means all
   applicable checks passed. It performs no signing, no POST, no broadcast.
   Expected: `demo-real-payment: 15 passed, 0 failed, 0 skipped` on the deployment
   machine (counts may show `skipped` for the DB/facilitator checks on another machine).
3. **gRPC (read-only).** `getBlockItemStatus` for the hash on
   `grpc.testnet.concordium.com:20000` (see `scripts/testnet-readonly.mts` for the
   read-only pattern). The summary carries `transfer: {tag: "Transferred", amount: "1",
   to: <recipient>}`, `energyCost: 635`, and `sponsor: {cost: "4620843",
   sponsor: <sponsor>}`.

## Test results summary

| Check | Result |
|---|---|
| Static config audit (facilitator + Owner + signing) | 34/34 PASS |
| Owner end-to-end harness (`verify-authz-owner.mts`) | 37/37 PASS |
| Sponsor loader integration (real export) | 14/14 PASS |
| Production IPC signing + SDK Ed25519 verification | VALID |
| Facilitator `/healthz` (real mode) | 200 `{ok:true, mode:real, canSign:true, ownerReachable:true}` |
| Facilitator `/supported` | exact, feePayer + signer = sponsor |
| Testnet read-only checks (`testnet-readonly.mts`) | 8/8 PASS |
| `POST /verify` | `isValid: true` |
| `POST /settle` | `success: true`, `finality: "finalized"` |
| On-chain verification | `finalized`, all fields match |
| DB consistency | 1 payment / 1 settlement / 1 approved sign event |
| Idempotent replay | same hash, `idempotentReplay: true` |

Earlier controlled transactions (the sender-wallet verification and testnet demo work) are documented in
[`docs/testnet-demo.md`](testnet-demo.md); this payment is the first one settled through
the production three-service deployment.

## Limitations

1. **Testnet only, self-hosted.** The facilitator runs on one deployment, binds loopback
   (`127.0.0.1:8787`), and settles only on Concordium Testnet. There is still no public
   CCD x402 facilitator, and no Mainnet settlement.
2. **One payment proven.** Exactly one live payment has been settled through this
   deployment. Concurrency, expiry races, and crash-during-submit recovery are covered by
   tests and the state machine, not by live traffic.
3. **Shared UID.** Owner, Facilitator, and Signing Service currently run as the same OS
   user (`agenttrust`, UID 1001). File permissions (0600/0700) isolate the sponsor key
   from other UIDs, not between these three processes; inter-process isolation rests on
   code discipline. A dedicated Owner user is documented hardening, not yet adopted.
4. **Amount binding is facilitator-side.** The Owner cannot verify the amount against
   the signed transaction by itself; the Facilitator binds the signed amount to the
   authorization request. Documented as separation of duty, not a sandbox.
5. **Sponsor balance is finite.** Every settlement spends the sponsor's Testnet CCD on
   fees (~4.6 CCD per simple transfer at current rates). The sponsor held ~19,953 CCD
   after this payment.
6. **No systemd service yet.** The three services run under `setsid`/`nohup` in this
   deployment and do not survive a VM replacement on their own; the deployment must be
   re-provisioned after one (only `/home/hatch` persists).

## Links

- Runbook: [`docs/demo-runbook.md`](demo-runbook.md)
- Testnet demo (mock commerce + sender-wallet/testnet-demo evidence): [`docs/testnet-demo.md`](testnet-demo.md)
- Authorization Owner: [`docs/authorization-owner.md`](authorization-owner.md)
- Configuration: [`docs/configuration.md`](configuration.md)
- Architecture: [`docs/architecture.md`](architecture.md)
- Integration (MCP, wallet, x402): [`docs/integration.md`](integration.md)
- Evidence JSON: [`docs/evidence/real-payment-2026-11-11.json`](evidence/real-payment-2026-11-11.json)
