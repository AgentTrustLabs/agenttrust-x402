# TASK 54 — Real Concordium Testnet Readiness & Live Integration Preparation

## VERDICT

**BLOCKED.**

Real Testnet connectivity is empirically verified and the V1 transaction path is structurally
sound, but the first sponsored transaction cannot be executed yet: the sponsor account does not
exist on Testnet, the production server does not inject the V1 submitter (so real mode fails
closed on the first settle), and the grpc evidence-mode client constructor is wrong. These are
concrete, fixable blockers — not hypothetical gaps.

## 1. REAL TESTNET CONNECTIVITY

Endpoint: `grpc.testnet.concordium.com:20000` (TLS). Empirically verified by two independent
read-only probes (`scripts/task40-live-account-verify.mts`, `scripts/task54-testnet-readiness.mts`):

- `verifyNode()` → genesis hash `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`
  matches configured `TESTNET_CAIP2` (`ccd:4221332d34e1694168c2a0c0b3fd0f27`). **Network identity
  verified.**
- `lastFinalizedBlock` returned (live chain head). `protocolVersion = 10`.
- `getAccountInfo()` round-trips and the SDK validates the returned structure.
- `getBlockItemStatus()` returns a typed `BlockItemStatus` for known hashes and throws `RpcError:
  transaction not found.` for unknown hashes (fail-closed, never "success").

SDK: `@concordium/web-sdk@12.0.2` (deduped with `@x402/concordium@2.29.0`). The real client
class is `ConcordiumGRPCNodeClient` (exported from `@concordium/web-sdk/nodejs`). The V1
submission methods `sendTransaction`, `getBlockItemStatus`, and
`waitForTransactionFinalization` are all present on it.

No Mainnet was contacted. No write RPC was used.

## 2. SPONSOR ACCOUNT READINESS

Two accounts were queried read-only.

| Address | On Testnet | Balance | Threshold | Credentials | Notes |
|---|---|---|---|---|---|
| `4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5` (TASK51 fixture / docs candidate) | **NO** | n/a | n/a | n/a | Not provisioned. Cannot be a sponsor. |
| `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (operator / token 1004 owner) | YES | 19943.619923 CCD | 1 | 1 × Ed25519 | Must NOT be reused as sponsor (TASK42). |

**Blocker B1 — no provisioned, funded sponsor account.** The candidate address from the TASK51
fixtures and the TASK42/TASK47 docs does not exist on Testnet. A dedicated sponsor account must be
created (outside this repository, by the key-custody owner), funded with ~5 CCD, and its
base58check address + account index recorded in `FACILITATOR_SPONSOR_ADDRESS`. No faucet request
was made by this task.

Credential shape of the operator account (for reference only): `accountThreshold=1`,
`credential 0 threshold=1, keys=1, schemeId=Ed25519, verifyKey=32 bytes`. A sponsor account is
expected to match this shape (threshold 1, one Ed25519 key) for unattended signing.

## 3. REAL SIGNER READINESS

Architecture: `FacilitatorCore` → `IpcSponsorSigner` → `SdkSponsorSigner` → `IpcAccountSigner`
(IPC) → separate signing-service process → injected `AccountSigner`. The facilitator never holds
key material.

Verified (read-only, no key material accessed, no signing invoked):

- `createSigningService()` accepts an **injected** `AccountSigner` and never constructs one from
  key material. The only construction paths in the repo are `createFakeSigner` (tests) and
  `buildBasicAccountSigner(seed)` in `scripts/task48-service.mts` (test harness, seed from env).
  **There is no production provisioning path.** Key custody is an external decision (blocker).
- UID authorization: SO_PEERCRED via `scripts/task348-peercred`, enforced as
  `peer.uid === allowedUid && peer.uid !== 0`. Root is rejected explicitly.
- Socket permissions: `0o660` (group `authclients`), owner `authowner`.
- Sponsor/network binding: `doSign` rejects `wrong_sponsor` / `wrong_network` before signing.
- Replay protection: in-memory `requestId` map; replayed request returns the original result.
- `validateSigningRequest` is strict (allow-listed fields, 64-hex digest, no forbidden fields).
- `probeSigningService()` (startup) only checks that the socket accepts a connection — it does
  **not** sign, and does not authenticate the peer. Authentication is the service's job.

Real-mode fail-closed guarantees (confirmed):

- `loadConfig` requires `FACILITATOR_SIGNING_SERVICE_SOCKET` and `FACILITATOR_SIGNING_SERVICE_UID`
  in real mode; both must be absent in mock mode.
- `startFacilitator` calls `probeSigningService` at boot and throws `ConfigurationError` if
  unreachable.
- `createSigner()` (signer.ts) **throws in real mode** — there is no code path that silently
  substitutes a mock signer in real mode.
- No local signing fallback: `IpcSponsorSigner` holds no key material.

**Blocker B2 — no production key-custody path.** The real `AccountSigner` must be provisioned by
an external custodian (HSM, dedicated signing host, or a service wrapper around
`buildBasicAccountSigner` fed from a secret store). The test harness (`task48-service.mts`) is
not a production deployment. This is a custody decision, not a code gap.

## 4. V1 TRANSACTION PATH READINESS

Trace (verified against source):

`FacilitatorCore.settle` → `IpcSponsorSigner.submitTransaction` → `ConcordiumTransactionSubmitter.submit`
→ `Transaction.signableFromJSON` → `Transaction.finalize` → `client.sendTransaction` (V1)
→ `ConcordiumGRPCNodeClient.sendTransaction(Transaction.Finalized)` → `TransactionHash.Type`.

- `Transaction.finalize`, `Transaction.sponsor`, `Transaction.signableFromJSON`, and
  `Transaction.toJSON` all exist on `@concordium/web-sdk@12.0.2`.
- `GrpcConcordiumTransport.submit` converts the signed JSON via `signableFromJSON`, calls
  `Transaction.finalize`, then `sendTransaction`; returns a validated 64-hex hash.
- `getStatus` maps `received`/`committed` → `pending`, `finalized` + reject outcome → `rejected`,
  `finalized` + success → `finalized`. Unknown hash throws `status lookup failed: transaction not found.`
- `ConcordiumTransactionSubmitter` + `GrpcConcordiumTransport` are constructible with a real
  `ConcordiumGRPCNodeClient` (verified structurally; not exercised against the chain).

**Blocker B3 — production server does not inject the submitter.** `server.ts` constructs
`createIpcSponsorSigner(...)` **without** a `submitter` option. Consequently `submitTransaction`
and `waitForFinalization` throw `ConfigurationError("submitTransaction is not available in IPC
signing mode…")` in real mode. `FacilitatorCore.settle` catches the throw, marks the payment
`pending`, and never broadcasts — so the HTTP server cannot currently complete a real
transaction even with a live signer. The wiring must be added in `server.ts`:

```
const submitter = new ConcordiumTransactionSubmitter(
  new GrpcConcordiumTransport(
    new ConcordiumGRPCNodeClient(config.nodeHost!, config.nodePort!, tlsCreds),
  ),
);
// pass submitter into createIpcSponsorSigner({ ..., submitter })
```

This is a code change, not a provisioning gap, and is the single most important readiness fix.

**Blocker B4 — grpc evidence mode uses a non-existent client class.** `buildVerifier` (server.ts)
does `new (nodejs as any).GRPCClient(...)`. `@concordium/web-sdk/nodejs` exports
`ConcordiumGRPCNodeClient`, not `GRPCClient`. So `FACILITATOR_EVIDENCE_MODE=grpc` throws
`TypeError: nodejs2.GRPCClient is not a constructor` at startup. Must be changed to
`ConcordiumGRPCNodeClient` (same constructor signature as `GrpcAccountInfoProvider`).

## 5. GAP E — FINALIZATION EVIDENCE ASSESSMENT

Empirical findings (read-only, against the live node):

- Unknown hash → `getBlockItemStatus` throws `RpcError: transaction not found.` → transport
  returns `transport_error` → `recoverPending` calls `markPending` → payment stays
  `outcome_unknown` / `recovery_unavailable`. **A not-found hash never becomes success and never
  becomes a rejection.** This is the correct fail-closed behaviour.
- `received` / `committed` → `pending` (non-terminal).
- `finalized` + matching hash + success outcome → `finalized`.
- `finalized` + matching hash + `transactionType === 'failed'` → `rejected`.
- `finalized` + mismatched hash → `available:false` (inconclusive) → retained pending.
- Malformed/unrecognized status → `transport_error` (fail-closed).
- Transport throw (node offline) → `transport_error` (fail-closed).

First-observation-wins (GAP E) — practical risk assessment:

The transport only returns `rejected` for a `finalized` outcome with a genuine `failed`
transaction type. The node does not return `rejected` for a missing or pending transaction. So a
spurious `rejected` requires either (a) the node itself reporting a finalised reject for a
transaction that actually succeeded (impossible after finality on a single node), or (b)
inconsistent answers between two different nodes queried by different recovery workers.

**Conclusion:** GAP E is a real theoretical limitation but is **not a live-use blocker** for a
single-node deployment. The transport distinguishes all four required states correctly.

Minimum correction required before live use (not a redesign):

- Require a **confirming second observation** before applying a terminal rejection: i.e. call
  `getBlockItemStatus` twice (with a short gap) and only apply `rejected` if both agree. This is
  a small change inside `ConcordiumEvidenceVerifier.verify` / `GrpcConcordiumTransport.getStatus`,
  not a lifecycle change, and keeps `finalized`/`rejected` distinguishable.
- Additionally, expose an operator-authenticated re-verification endpoint (the existing
  `/reconcile` already binds to the recorded hash) so a wrongly-rejected payment can be
  re-checked against a second node.

## 6. FIRST SPONSORED TESTNET TRANSACTION — EXECUTION CHECKLIST

Do NOT execute until the maintainer approves. Prerequisites and maximum exposure:

**Prerequisites (all must hold)**

1. Sponsor account provisioned and funded (≥ 5 CCD), with `accountThreshold=1`,
   `credential 0 threshold=1`, one Ed25519 key, base58check address recorded.
   Set `FACILITATOR_SPONSOR_ADDRESS=<address>`.
2. Signing service process started (as a dedicated OS user) holding the sponsor's
   `AccountSigner` supplied out-of-band (e.g. `TASK48_TEST_KEY`-style env, or a real
   secret store). Socket at `FACILITATOR_SIGNING_SERVICE_SOCKET`, UID in
   `FACILITATOR_SIGNING_SERVICE_UID`, mode `0o660`.
3. `FACILITATOR_MODE=real`, `FACILITATOR_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27`.
4. `FACILITATOR_DB_PATH` = durable file (not `:memory:`).
5. `FACILITATOR_NODE_HOST=grpc.testnet.concordium.com`, `FACILITATOR_NODE_PORT=20000`,
   `FACILITATOR_NODE_USE_TLS=1`.
6. `FACILITATOR_SENDER_VERIFICATION=sdk`.
7. `FACILITATOR_AUTHZ_SOCKET` → a live authorization owner (or accept the local mock client
   only in a controlled test).
8. `FACILITATOR_MAX_FEE_MICROCCD` and `FACILITATOR_MAX_ENERGY` reviewed against the energy
   model (see below).
9. Code fixes applied: submitter injection in `server.ts` (B3), `GRPCClient` →
   `ConcordiumGRPCNodeClient` in `buildVerifier` (B4), confirming-evidence rule (GAP E).
10. `DENY_ALL_FACILITATOR` and settlement default remain disabled until the operator
    explicitly enables the V1 path.

**Sender account**

- A real, funded Testnet account whose signing key is held by the *sender* (never by the
  facilitator). The operator account (`4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`,
  balance 19943.62 CCD, nonce 4) is suitable for a first test only if its key is available to
  the sender client. The facilitator verifies the sender signature via `SdkSenderVerifier` and
  never holds the sender key.

**Transaction type and intended effect**

- V1 sponsored simple transfer: sender → recipient, amount small (e.g. 1 microCCD or 0.001 CCD),
  sender-signed, sponsor-signed via IPC, submitted once through `sendTransaction`.

**Energy and fee estimate**

- Simple transfer: ~300 NRG → ~2.4 CCD worst-case at the conservative 8000 microCCD/NRG rate
  (measured rate 7939.534 microCCD/NRG).
- Maximum fee exposure: **10 CCD** (`FACILITATOR_MAX_FEE_MICROCCD` default 10 000 000
  microCCD). Any transaction whose estimated fee exceeds 10 CCD is rejected by
  `validateContext` before signing.
- Note: `FACILITATOR_MAX_ENERGY` default 100 000 NRG implies a worst-case 800 CCD, which is
  inconsistent with the 10 CCD fee cap. The fee cap binds first in practice (energy > ~1250
  NRG is rejected). Recommend setting `FACILITATOR_MAX_ENERGY=1250` for a simple-transfer-only
  first transaction, or raising the fee cap if larger energy is intended.

**Expected submission and finalization evidence**

1. `FacilitatorCore.settle` → `prepare()` durably persists the hash (`created → prepared`).
2. `claimSubmit()` → `submitting`.
3. `submitTransaction` → `ConcordiumGRPCNodeClient.sendTransaction` returns a 64-hex hash.
4. `markBroadcast` → `outcome_unknown`.
5. `waitForFinalization` polls `getBlockItemStatus` → `finalized` with a success outcome.
6. `reconcile` → `finalized`. Response `{success:true, transaction:<hash>, finality:'finalized'}`.

**Recovery procedure (if the process dies mid-flight)**

1. Restart the facilitator (durable DB + persisted hash survive).
2. Call `recoverPending()` (or the `/reconcile` operator endpoint with a grpc verifier).
3. Recovery polls the recorded hash only — **never resubmits**.
4. On `finalized` → payment finalized. On `rejected` → terminal, no reopen. On `pending`/
   `transport_error` → retry recovery later.

**Explicit broadcast approval checkpoint**

The maintainer must explicitly approve before any real transaction is signed or broadcast.
This document is the readiness gate; it does not authorize execution. The code fixes (B3, B4)
and the confirming-evidence rule must be applied and reviewed first.

## 7. GAP E IMPLICATIONS FOR LIVE USE

- First-observation-wins means a genuinely finalised rejection cannot be reopened by a later
  observation. For a single-node deployment this is safe because the node only returns
  `rejected` for a finalised reject outcome.
- The risk is inconsistency between two nodes queried by two recovery workers, or a stale
  cached answer. Mitigation: the confirming-evidence (double-poll) rule in section 5.
- The `/reconcile` endpoint is operator-authenticated and binds to the recorded hash, so an
  operator can re-check a rejected payment against a second node manually.

## 8. READINESS SUMMARY

| Area | Status |
|---|---|
| Testnet connectivity (genesis verified) | READY |
| Account info retrieval (real RPC) | READY |
| Transaction status lookup (real hash type) | READY |
| Sender verification (sdk mode) | READY (requires node endpoint) |
| Sponsor account (provisioned + funded) | **BLOCKED** — does not exist on Testnet |
| Real signer (key custody path) | **BLOCKED** — no production provisioning path |
| V1 submitter wiring in server.ts | **BLOCKED** — not injected (B3) |
| grpc evidence-mode client class | **BLOCKED** — `GRPCClient` → `ConcordiumGRPCNodeClient` (B4) |
| GAP E distinguishing | READY (with confirming-evidence condition) |
| Fee/energy cap consistency | CONDITION — maxEnergy vs maxFee inconsistent |
| DENY_ALL_FACILITATOR / settlement default | INTACT (unchanged) |

## BLOCKERS (must clear before first transaction)

1. **B1** — Provision and fund a dedicated Testnet sponsor account; record its address.
2. **B2** — Establish a production key-custody path for the signing service (external decision).
3. **B3** — Inject a `ConcordiumTransactionSubmitter` into `createIpcSponsorSigner` in
   `server.ts`.
4. **B4** — Fix `buildVerifier` grpc mode: `GRPCClient` → `ConcordiumGRPCNodeClient`.

## CONDITIONS (acceptable with operator awareness)

5. Confirming-evidence (double-poll) rule for terminal rejections (GAP E).
6. Align `FACILITATOR_MAX_ENERGY` with `FACILITATOR_MAX_FEE_MICROCCD` for the intended
   transaction class.
7. Authorization owner socket configured (or accept local mock client in a controlled test).
8. Explicit maintainer approval before any signing or broadcast.

## FILES

- `docs/archive/TASK54-testnet-readiness.md` (this file)
- `scripts/task54-testnet-readiness.mts` — read-only empirical probe (genesis, accounts,
  fee model). No signing, no submission, no faucet.

No commits, no pushes. No transaction constructed, signed, submitted, or broadcast. No private
key accessed, generated, imported, exported, or logged. Token 1004 and its Agent Card untouched.
`DENY_ALL_FACILITATOR` and settlement default remain disabled. No lifecycle code modified.