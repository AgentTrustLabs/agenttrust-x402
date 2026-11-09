# TASK 35 — Concordium SDK Sponsor Signer Adapter

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Adapter only.** No real signing, no key material, no submission, no settlement.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ FacilitatorCore.settle()                                       │
│                                                                │
│  1. validate payment context                                   │
│  2. claim replay protection                                   │
│  3. authorization.authorize()  ──► owner (durable gate)        │
│  4. authorization.recover()   (only if already_recorded)       │
│  5. signer.addSponsorSignature(payload.payload)                │
│       └─► createSdkSponsorSigner                               │
│            ├─ validateSponsorContext()  (pure, no I/O)         │
│            ├─ Transaction.signableFromJSON()                   │
│            ├─ Transaction.sponsor(signable, accountSigner)     │
│            └─ Transaction.toJSON(sponsored)                    │
│  6. computeTransactionHash(sponsored)  ← AFTER signature      │
│  7. durable prepare → claimSubmit → submitTransaction          │
│                                                                │
│  The AccountSigner is INJECTED. It is never constructed here.  │
└────────────────────────────────────────────────────────────────┘
```

**Key invariant:** the adapter never touches key material. The only signing input is an
injected `AccountSigner`. `createSdkSponsorSigner` has no `privateKey`, `mnemonic`,
`keystore`, or `wallet` parameter — structurally impossible to pass one.

---

## SDK Integration Details

### Installed SDK (observed)

| Package | Version | Path |
|---|---|---|
| `@concordium/web-sdk` | 12.0.2 | `node_modules/@concordium/web-sdk` |
| `@x402/concordium` | 2.29.0 | `node_modules/@x402/concordium` |

### Official interfaces used

```ts
import { AccountAddress, Transaction } from '@concordium/web-sdk';
import type { AccountSigner } from '@concordium/web-sdk';
```

- `Transaction.signableFromJSON(json)` — parse the client's partially-signed V1 transaction.
- `Transaction.sponsor(signable, accountSigner)` — add the sponsor signature via the injected
  `AccountSigner`. This is the **exact same call** the official
  `toConcordiumFacilitatorSigner(...).addSponsorSignature()` makes
  (`@x402/concordium/dist/cjs/index.js:321-327`).
- `Transaction.toJSON(sponsored)` — convert back to the JSON shape the facilitator pipeline
  consumes.

### Why not `toConcordiumFacilitatorSigner`?

That factory takes a **private key string** as its first overload
(`toConcordiumFacilitatorSigner(sponsorAddress, privateKey, grpcConfig)`). Using it would
require the facilitator to hold key material — exactly what TASK 24 ruled out. The adapter
therefore calls the same SDK primitives directly, with an **injected** `AccountSigner`, and
omits submission entirely.

### Input shape handling

`FacilitatorCore` passes `payload.payload`, which is the x402 wrapper
`{ signedTransaction: <SignableV1Transaction> }`. The adapter unwraps it before calling
`signableFromJSON`, and accepts the bare shape too.

### Output shape

`Transaction.toJSON(sponsored)` returns
`{ version, header, payload, signatures: { sender, sponsor } }`. The sponsor signature map
is populated; the sender signature is preserved from the client.

---

## Authorization Ordering

`FacilitatorCore.settle()` enforces (unchanged from TASK34.11):

```
validate → expiry → replay claim → AUTHORIZE → [recover if already_recorded] → signer
```

The adapter is only reachable after an `approved` authorization. Proven by
`test/task35-adapter-integration.test.mts`:

| Authorization outcome | `addSponsorSignature` calls | `submitTransaction` calls |
|---|---|---|
| `rejected` | **0** | **0** |
| `unknown` | **0** | **0** |
| `owner_unavailable` | **0** | **0** |
| `protocol_error` | **0** | **0** |
| `approved` | 1 | 1 |

The SDK adapter's `sign()` is likewise never called on a rejected authorization (test 02).

---

## VERIFIED

### Unit — `test/task35-sdk-sponsor-signer.test.mts` — **14/14**

| # | Scenario | Result |
|---|---|---|
| 01 | `addSponsorSignature` produces sponsor sigs | ✓ |
| 02 | hash computed after signature (64-hex) | ✓ |
| 03 | signer error propagates (`signing failed`) | ✓ |
| 04 | non-V1 transaction rejected | ✓ |
| 05 | invalid transaction rejected | ✓ |
| 06 | wrong network rejected | ✓ |
| 07 | sponsor == recipient rejected | ✓ |
| 08 | energy over cap rejected | ✓ |
| 09 | fee over cap rejected | ✓ |
| 10 | valid context accepted | ✓ |
| 11 | `info()` reports `canSign:true`, `sdk:true` | ✓ |
| 12 | invalid sponsor address throws at construction | ✓ |
| 13 | `validateSponsorAddress` accepts/rejects | ✓ |
| 14 | constructor takes only an injected `AccountSigner` | ✓ |

### Integration — `test/task35-adapter-integration.test.mts` — **6/6**

```
ok rejected: settle refused — authorization_rejected        (0 signer calls)
ok unknown: settle refused — settlement_pending              (0 signer calls)
ok owner_unavailable: settle refused — settlement_pending    (0 signer calls)
ok protocol_error: settle refused — authorization_protocol_error (0 signer calls)
ok settle refused — authorization_rejected                  (SDK sign() never called)
ok 03. submitted tx carries sponsor signature — sponsor sig present
ok 03. settle succeeded
```

### Regression

- Full suite: **1943/1943 · 50 suites · 0 FAIL**
- Facilitator typecheck: PASS
- Gateway typecheck: PASS
- Mock mode (`createMockSigner`) unchanged and still functional

---

## NOT TESTED

- Real `AccountSigner` backed by an HSM or signing service (no such signer exists in this
  repository; the fake is deterministic and holds no key material).
- Real Testnet signing — the adapter is never wired to a chain.
- `Transaction.sponsor` against a live node (no gRPC connection in this task).
- Multi-signature accounts (the fake returns a single signature).
- The x402 client's sender-signature verification (out of scope; that is the client's job).

---

## BLOCKED

- **Real signing** — requires a separately provisioned `AccountSigner` (HSM / signing
  service). Not implemented by design.
- **Real submission** — `submitTransaction` is not implemented in the adapter; the
  facilitator's durable pipeline owns submission and settlement stays disabled.
- **Testnet activation** — requires maintainer approval and a funded sponsor account.

---

## Security and Compatibility Limitations

1. **No key material in the adapter.** Structural: no parameter accepts a key. A future
   implementation must supply an `AccountSigner` from outside this repository.
2. **No submission.** The adapter signs only; the facilitator's durable pipeline (TASK29)
   owns broadcast, pre-broadcast hash persistence, and crash recovery.
3. **No sender-signature verification.** The adapter trusts the client's sender signature.
   Verifying it requires on-chain account info (`getAccountInfo`), which is a separate
   concern (the official SDK's facilitator signer does it via gRPC).
4. **`Transaction.signableFromJSON` shape.** The SDK requires `header.executionEnergyAmount`
   and `header.sponsor.account`. The x402 V2 wire shape uses `sponsor.address` and omits
   `executionEnergyAmount`, so a real client must either send the SDK shape or a converter
   must be added. **This is a compatibility gap for the production client integration.**
5. **`Transaction.toJSON` is not exported from the SDK's `index.js`.** The adapter uses
   `Transaction.toJSON` from the `Transaction` namespace, which works at runtime but is not
   in the package's declared export list — a packaging quirk to watch.
6. **Energy/fee caps are advisory in the adapter.** The authoritative cap is enforced by
   the authorization owner (`narrowSponsorMock` policy), not by the signer.

---

## Next Implementation Prerequisite

Before real Testnet signing:

1. **Provision a dedicated signing service** (separate UID, IPC boundary, no key material
   in the facilitator). It exposes an `AccountSigner` over IPC.
2. **Wire the adapter** to that service via a transport, replacing the injected fake.
3. **Resolve the wire-shape gap** (§Security 4): either the client sends the SDK signable
   shape, or the adapter converts `sponsor.address` → `sponsor.account` and derives
   `executionEnergyAmount`.
4. **Add sender-signature verification** before signing (Rule 8 of the x402 spec).
5. **Fund a Testnet sponsor account** and enable `FACILITATOR_MODE=real` behind an explicit
   maintainer decision.

---

## Files

**New**
- `services/facilitator/src/sdkSponsorSigner.ts` — adapter + pure context validators
- `test/task35-sdk-sponsor-signer.test.mts` — 14 unit tests
- `test/task35-adapter-integration.test.mts` — 6 integration tests
- `docs/archive/TASK35-sponsor-signer-adapter.md`

**Unchanged**
- `services/facilitator/src/signer.ts` — mock signer + `computeTransactionHash` still used
- `services/facilitator/src/core.ts` — authorization boundary unchanged
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
