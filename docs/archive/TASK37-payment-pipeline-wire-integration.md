# TASK 37 — Payment Pipeline Wire Integration

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Integration only.** No signing, no key material, no submission, no settlement.

---

## Executive Verdict

**PASS.** The TASK36 converter is wired into `FacilitatorCore.settle()`. The pipeline
preserves the required ordering: `validate → claim → authorize → recover → convert →
signer → hash → durable submit`. Energy is derived from the authoritative policy
(`deriveEnergyExposure`), never from client input. Authorization remains mandatory before
the signer. Rejected/inconclusive outcomes produce zero converter and signer calls.
The TASK29 durable ordering and TASK34 recovery are intact. Mock mode still works.

---

## Pipeline Changes

`core.ts` settle flow (after authorization):

```
derivedEnergy = deriveEnergyExposure(preimage, { transactionSpecificCost: 300 })
if (derivedEnergy === null) → fail closed
withPolicyEnergy = { ...signedTransaction, header: { ...header, executionEnergyAmount: derivedEnergy } }
conversion = wireConverter(withPolicyEnergy, { network, sponsorAddress: signer.info().address, maxWireEnergy })
if (!conversion.ok) → fail closed (wire_conversion_failed)
converted = conversion.wire
signerInput = converted ?? payload.payload  (resumable path keeps original)
sponsored = signer.addSponsorSignature(signerInput)
hash = computeTransactionHash(sponsored)   // after signature
persist hash → claimSubmit → submitTransaction
```

### CoreOptions additions

- `maxWireEnergy?: number` — converter policy cap (default 100_000).
- `wireConverter?: ...` — seam for instrumented tests (defaults to `convertV2ToSdkV1`).

### New fields on FacilitatorCore

- `maxWireEnergy: number`
- `wireConverter: (input, policy) => WireConversionResult`

---

## Energy Policy Integration

Energy originates from `energy.deriveEnergyExposure(preimage, { transactionSpecificCost: SIMPLE_TRANSFER_BASE_COST })`.
The client's `executionEnergyAmount` (if present) is **overwritten** by the policy-derived
value before conversion. A client cannot override the policy decision.

- Missing energy → `authorization_failed` (fail closed)
- Energy above cap → `wire_conversion_failed` / `energy_exceeds_policy`
- The converter's cap (`maxWireEnergy`) mirrors the authorization cap (100_000).

---

## Authorization Ordering

Unchanged from TASK34.11/34.13. The converter runs **after** authorization and **before**
the signer. No conversion or signing occurs on a non-approved outcome.

| Authorization outcome | Converter called | Signer called |
|---|---|---|
| `rejected` | **0** | **0** |
| `unknown` | **0** | **0** |
| `owner_unavailable` | **0** | **0** |
| `protocol_error` | **0** | **0** |
| `approved` | 1 | 1 |

---

## Recovery Compatibility

- `resumableHash` skips conversion and authorization (the hash is already durable from a
  prior authorized attempt).
- Repeated settle on a prepared payment does not re-convert or re-sign.
- Context mismatch still fails closed.

---

## Durable Submission Ordering

Preserved from TASK29:

1. Sponsor signature added (via converted wire object)
2. Final transaction hash computed (after signature)
3. Hash durably persisted (`prepare`) **before** any broadcast
4. Broadcast claim taken (`claimSubmit`)
5. `submitTransaction()` called
6. Broadcast recorded (`markBroadcast`)
7. Hash comparison → finalization

No broadcast in this task (mock only).

---

## VERIFIED

### Integration — `test/task37-pipeline-wire-integration.test.mts` — **15/15**

| # | Scenario | Result |
|---|---|---|
| 01 | valid V2 payment converts and signs | ✓ |
| 02 | converter receives policy-derived energy, not client value | ✓ |
| 03 | client energy above cap fails closed | ✓ |
| 04 | wrong sponsor rejected before signer | ✓ |
| 05 | sponsor == recipient rejected | ✓ |
| 06 | missing executionEnergyAmount supplied by pipeline | ✓ |
| 07 | unsupported version rejected | ✓ |
| 08 | rejected/unknown/owner_unavailable/protocol_error → zero converter/signer | ✓ |
| 09 | recovery idempotent (second settle does not re-sign) | ✓ |
| 10 | final hash derived from fully signed transaction | ✓ |
| 11 | durable hash persisted before submit eligibility | ✓ |
| 12 | mock payment flow remains functional | ✓ |

### Regression

- Full suite: **2027/2027 · 52 suites · 0 FAIL**
- Facilitator typecheck: PASS
- Gateway typecheck: PASS

---

## NOT TESTED

- Real SDK `AccountSigner` (no such signer in this repository).
- Live Testnet conversion (no node connection).
- Multi-signature sponsor accounts.
- The x402 client's sender-signature verification (out of scope).
- Energy computation against a real transaction's actual size (the formula is unit-tested
  in `energy.ts` but not against a live node's reported energy).

---

## BLOCKED

- **Real signing** — requires a separately provisioned `AccountSigner`.
- **Real submission** — settlement stays disabled (`DENY_ALL_FACILITATOR`).
- **Testnet activation** — requires maintainer approval and a funded sponsor account.

---

## Known Limitations

1. **Wire-shape gap for production clients.** The x402 V2 wire shape (`sponsor.address`,
   no `executionEnergyAmount`) differs from the SDK's signable shape. The converter bridges
   this server-side; a real client must either send the SDK shape or the converter must be
   applied.
2. **`Transaction.toJSON` packaging quirk.** Isolated behind `serializeSignableToJson()`.
3. **Energy is caller-supplied to the converter.** The pipeline overwrites it with the
   policy-derived value, so the converter never trusts client energy. But the converter
   itself does not recompute it.
4. **`sponsor.numSignatures` defaults to 1.** May not match all deployments.

---

## Next Prerequisite

1. **Resolve the wire-shape gap** (§Known Limitations 1).
2. **Provision a dedicated signing service** with an `AccountSigner`.
3. **Wire the converter + adapter** into the facilitator's real-mode path.
4. **Add sender-signature verification** (Rule 8 of the x402 spec).
5. **Fund a Testnet sponsor account** and enable `FACILITATOR_MODE=real` behind an
   explicit maintainer decision.

---

## Files

**Changed**
- `services/facilitator/src/core.ts` — converter integration, `maxWireEnergy`, `wireConverter` seam

**New**
- `test/task37-pipeline-wire-integration.test.mts` — 15 integration tests
- `docs/archive/TASK37-payment-pipeline-wire-integration.md`

**Unchanged**
- `services/facilitator/src/wireConverter.ts` — converter (TASK36)
- `services/facilitator/src/sdkSponsorSigner.ts` — adapter (TASK35)
- `services/facilitator/src/signer.ts` — mock signer + `computeTransactionHash`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
