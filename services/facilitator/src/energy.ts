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
