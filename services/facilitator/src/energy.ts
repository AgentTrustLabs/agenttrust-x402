/**
 * Derive the authorization energy exposure from a sponsored V1 transaction.
 *
 * Uses the same formula the chain uses (Concordium `energyCost.js`):
 *
 *   energy = constantA * signatureCount + constantB * (headerSize + payloadSize) + C_t
 *
 * with constantA = 100n, constantB = 1n, headerSize = 94 for a V1 transaction WITH a sponsor
 * (2 bitmap + 60 v0 header + 32 sponsor address).
 *
 * `C_t` (the transaction-specific base cost, e.g. 300n for a simple transfer) is NOT added
 * here. The value returned is therefore a LOWER BOUND on the real cost, which is the
 * conservative direction for a *cap* check only when combined with an explicit base-cost
 * argument. Callers that need an exact figure must pass `transactionSpecificCost`.
 *
 * Returns null when the transaction shape does not permit a derivation — the caller must
 * treat null as `energy_malformed` and refuse authorization.
 */

export const CONSTANT_A = 100n;
export const CONSTANT_B = 1n;
/** V1 header with a sponsor: 2 (bitmap) + 60 (v0 header) + 32 (sponsor address). */
export const V1_SPONSORED_HEADER_SIZE = 94n;
/** Base cost of a simple CCD transfer, from Concordium's `Cost.hs`. */
export const SIMPLE_TRANSFER_BASE_COST = 300n;
/**
 * ESTIMATED sponsor fee, microCCD per NRG. Slightly above the measured
 * Testnet rate (7939.534 microCCD/NRG). Shared by the facilitator core and the
 * signing service so both enforce the SAME fee model: the core estimates the fee
 * before signing, the service re-derives it from the transaction it hashed.
 *
 * ESTIMATE ONLY — this is NOT a guaranteed maximum actual chain fee (Option B,
 * Task 10.1). Evidence:
 * - The installed SDK exposes no energy-rate / fee-calculation API: there is no
 *   `getEnergyRate` or fee-from-energy helper anywhere in `@concordium/web-sdk`
 *   (only unrelated baker-commission fields). Nothing in the repo can query a
 *   current protocol rate.
 * - The rate is a MEASURED observation, not a protocol constant: the actual CCD
 *   fee is energy x the chain's energy price, which is EUR-denominated and moves
 *   with the CCD/EUR exchange rate set by chain updates. The codebase itself
 *   records two different measured live rates (7939.534 here vs 7172.71 in
 *   `config.ts`), i.e. the rate drifts between measurements.
 * - The signing service has no node transport (no gRPC client, no rate source in
 *   config, no freshness check), so it cannot obtain or validate a current rate
 *   at signing time. A fixed-rate "guarantee" would be false.
 * The `FACILITATOR_MAX_FEE_MICROCCD` cap therefore binds an ESTIMATE-based
 * policy only: a transaction whose estimated fee exceeds the cap is refused,
 * but passing the estimate does not prove the actual on-chain fee will stay
 * under the cap. An actual fee guarantee needs a separate design (a trusted,
 * fresh energy-rate source at settle time) and remains UNRESOLVED.
 */
export const ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG = 8000n;

export function deriveEnergyExposure(
  signedTransaction: unknown,
  opts: { transactionSpecificCost?: bigint } = {},
): bigint | null {
  if (!signedTransaction || typeof signedTransaction !== 'object') return null;
  const tx = signedTransaction as Record<string, unknown>;

  // Version must be 1 (sponsored). Anything else cannot be priced with this formula.
  if (tx['version'] !== 1) return null;

  const header = tx['header'];
  if (!header || typeof header !== 'object') return null;
  const h = header as Record<string, unknown>;

  const numSignatures = Number(h['numSignatures']);
  if (!Number.isInteger(numSignatures) || numSignatures < 0) return null;

  const payload = tx['payload'];
  if (!payload || typeof payload !== 'object') return null;

  // Payload size: the serialized byte length of the payload object.
  const payloadSize = BigInt(Buffer.byteLength(JSON.stringify(payload), 'utf8'));

  const specific = opts.transactionSpecificCost ?? 0n;
  return (
    CONSTANT_A * BigInt(numSignatures) +
    CONSTANT_B * (V1_SPONSORED_HEADER_SIZE + payloadSize) +
    specific
  );
}
