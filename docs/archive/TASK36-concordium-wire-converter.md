# TASK 36 — Concordium Transaction Wire Converter

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Converter only.** No signing, no key material, no submission, no settlement.

---

## Executive Verdict

**PASS.** The converter produces a valid SDK-compatible V1 wire object from an x402 V2
payment payload. Every field is validated; no value is silently defaulted. Energy is
explicitly validated against a policy cap. Serialization uses the installed SDK's
`Transaction.toJSON` (with the packaging quirk isolated behind one wrapper). TASK35's
adapter accepts the converted wire object (verified by `Transaction.signableFromJSON`).

---

## SDK Wire Contract

Verified against the installed SDK (`@concordium/web-sdk` 12.0.2):

| SDK field | Type | Required | Source |
|---|---|---|---|
| `version` | `1` | yes | literal |
| `header.sender` | base58check string | yes | V2 `header.sender` |
| `header.nonce` | number \| string | yes | V2 `header.nonce` |
| `header.expiry` | number \| string | yes | V2 `header.expiry` |
| `header.executionEnergyAmount` | integer | yes | V2 `header.executionEnergyAmount` (validated) |
| `header.numSignatures` | number \| string | no | V2 `header.numSignatures` (optional) |
| `header.sponsor.account` | base58check string | yes | V2 `header.sponsor.address` or `.account` |
| `header.sponsor.numSignatures` | number \| string | yes | V2 `header.sponsor.numSignatures` (default 1) |
| `payload` | object | yes | V2 `payload` (preserved) |
| `signatures.sender` | credential-indexed hex map | yes | V2 `signatures.sender` |
| `signatures.sponsor` | credential-indexed hex map | yes | V2 `signatures.sponsor` |

The SDK's `signableFromJSON` enforces these at parse time (`headerFromJSON` requires
`executionEnergyAmount`; `sponsorDetailsFromJSON` requires `account`).

---

## V2-to-V1 Mapping

| V2 field | V1 field | Transformation |
|---|---|---|
| `version` | `version` | must be exactly 1 |
| `header.sender` | `header.sender` | identity |
| `header.nonce` | `header.nonce` | identity |
| `header.expiry` | `header.expiry` | identity |
| `header.executionEnergyAmount` | `header.executionEnergyAmount` | validated integer |
| `header.numSignatures` | `header.numSignatures` | identity (optional) |
| `header.sponsor.address` OR `header.sponsor.account` | `header.sponsor.account` | resolve alias; reject if both differ |
| `header.sponsor.numSignatures` | `header.sponsor.numSignatures` | identity (default 1) |
| `payload` | `payload` | identity (preserved byte-for-byte) |
| `signatures.sender` | `signatures.sender` | identity |
| `signatures.sponsor` | `signatures.sponsor` | identity |

No field is silently replaced with a default. Missing `executionEnergyAmount` is rejected
(`missing_field`), not defaulted.

---

## Energy Policy

Energy is taken from the input (never invented) and validated against an explicit
`WireConversionPolicy.maxExecutionEnergy` cap:

- Missing → `missing_field`
- Non-integer / ≤ 0 → `malformed_field`
- > cap → `energy_exceeds_policy`

The policy cap is the same value the authorization owner enforces (`maxEnergy` in
`narrowSponsor`). The converter does not make energy decisions; it only enforces the
policy boundary.

---

## Serialization Compatibility

**Problem:** `Transaction.toJSON` is exported from the SDK's `Transaction` namespace at
runtime (`typeof Transaction.toJSON === 'function'`) but is **not** listed in the package's
public `.d.ts` export surface.

**Resolution:** isolated behind `serializeSignableToJson()` and `parseSignableFromJson()`
in `wireConverter.ts`. Both are thin wrappers. If a future SDK bump removes or renames
the function, only these two wrappers need updating.

No cryptographic serialization logic was copied or reimplemented. The adapter delegates to
the installed SDK entirely.

---

## VERIFIED

### Unit — `test/task36-wire-converter.test.mts` — **27/27**

| # | Scenario | Result |
|---|---|---|
| 01 | valid V2 → SDK V1 wire | ✓ |
| 02 | converted wire accepted by `signableFromJSON` | ✓ |
| 03 | `serializeSignableToJson` uses `Transaction.toJSON` | ✓ |
| 04 | `parseSignableFromJson` round-trips | ✓ |
| 05 | missing sponsor → `missing_field` | ✓ |
| 06 | missing executionEnergyAmount → `missing_field` | ✓ |
| 07 | missing sender → `missing_field` | ✓ |
| 08 | missing nonce → `missing_field` | ✓ |
| 09 | missing expiry → `missing_field` | ✓ |
| 10 | missing payload → `unsupported_payload` | ✓ |
| 11 | missing signatures → `missing_field` | ✓ |
| 12 | invalid sponsor address → `invalid_sponsor` | ✓ |
| 13 | both `address` and `account` differing → `ambiguous_field` | ✓ |
| 14 | wrong sponsor → `wrong_sponsor` | ✓ |
| 15 | energy above cap → `energy_exceeds_policy` | ✓ |
| 16 | energy zero → `malformed_field` | ✓ |
| 17 | energy non-integer → `malformed_field` | ✓ |
| 18 | unsupported version → `unsupported_version` | ✓ |
| 19 | unsupported payload → `unsupported_payload` | ✓ |
| 20 | sponsor == recipient → `sponsor_equals_recipient` | ✓ |
| 21 | malformed signature map → `malformed_field` | ✓ |
| 22 | null input → `malformed_field` | ✓ |
| 23 | non-object input → `malformed_field` | ✓ |
| 24 | deterministic output (no side effects) | ✓ |
| 25 | `sponsor.account` alias accepted | ✓ |
| 26 | payload preserved byte-for-byte | ✓ |
| 27 | signatures preserved | ✓ |

### TASK35 adapter integration

`convertV2ToSdkV1` output is accepted by `Transaction.signableFromJSON` (test 02). The TASK35
adapter calls `Transaction.signableFromJSON` internally, so the converted wire object is
directly consumable by the adapter.

### Full suite

```
1997/1997 passed · 51 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

---

## NOT TESTED

- Real `AccountSigner` backed by an HSM (no such signer exists in this repository).
- Live Testnet serialization round-trip (no gRPC connection).
- `tokenUpdate` payload end-to-end (type exists but only structural validation is tested).
- Multi-signature accounts (the fake returns a single signature).
- The SDK's `Transaction.toJSON` against a *finalized* transaction (only *signable* tested).

---

## BLOCKED

- **Real Testnet signing** — requires a funded sponsor account and maintainer approval.
- **Real submission** — no broadcast; settlement stays disabled.
- **Live wire-shape verification** against a real Concordium node — no node connection in
  this task.

---

## Known Limitations

1. **Wire-shape gap for production clients.** The x402 V2 wire shape (`sponsor.address`,
   no `executionEnergyAmount`) differs from the SDK's signable shape
   (`sponsor.account`, `executionEnergyAmount`). The converter bridges this, but a real
   client must either send the SDK shape or the converter must be applied server-side.
   Currently server-side only.
2. **`Transaction.toJSON` packaging quirk.** The function exists at runtime but is absent
   from the package's public `.d.ts`. Isolated behind `serializeSignableToJson()` and
   `parseSignableFromJson()`; a future SDK bump may require a one-line update.
3. **Energy is caller-supplied.** The converter validates against a policy cap but does not
   compute energy. The authoritative computation is `deriveEnergyExposure()` in `energy.ts`
   (Concordium formula). The caller must supply the correct value.
4. **No sender-signature verification.** The converter validates structure, not
   cryptographic signatures. Signature verification is the client's / facilitator's concern.
5. **`sponsor.numSignatures` defaults to 1.** If the sponsor account has a different
   threshold, the caller must set it explicitly. The default is safe (single-key sponsor)
   but may not match all deployments.

---

## Next Prerequisite

Before a real Testnet payment:

1. **Resolve the wire-shape gap** (§Known Limitations 1): decide whether the client sends
   the SDK signable shape or the facilitator applies this converter.
2. **Wire the converter into the facilitator pipeline** between `addSponsorSignature` and
   `computeTransactionHash`.
3. **Provision a dedicated signing service** with an `AccountSigner` (TASK35 prerequisite).
4. **Add sender-signature verification** (Rule 8 of the x402 spec).
5. **Fund a Testnet sponsor account** and enable `FACILITATOR_MODE=real` behind an
   explicit maintainer decision.

---

## Files

**New**
- `services/facilitator/src/wireConverter.ts` — converter + policy + serialization wrappers
- `test/task36-wire-converter.test.mts` — 27 unit tests
- `docs/archive/TASK36-concordium-wire-converter.md`

**Unchanged**
- `services/facilitator/src/sdkSponsorSigner.ts` — adapter (consumes converter output)
- `services/facilitator/src/signer.ts` — mock signer + `computeTransactionHash`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
