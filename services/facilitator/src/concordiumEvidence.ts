/**
 * Real Concordium EvidenceVerifier adapter (read-only).
 *
 * Queries transaction status by persisted transaction hash through the official
 * Concordium SDK's `GRPCClient.getBlockItemStatus()`. Maps node responses into the
 * facilitator's `EvidenceVerifier` contract. Never signs, submits, or constructs
 * transactions.
 *
 * Verified SDK behaviour (see docs/archive/TASK30-concordium-evidence-verifier.md):
 *  - `getBlockItemStatus(hash)` returns `{status: 'received'|'committed'|'finalized', ...}`.
 *  - `finalized` carries `outcome.blockHash` and `outcome.summary.hash` (the tx hash).
 *  - `committed` carries `outcomes[]` (array of `{blockHash, summary}`).
 *  - A missing transaction is a NOT_FOUND RPC error, NOT a `finalized` status.
 *  - `undefined` status is a translation error, not a success.
 *
 * Mapping:
 *  - finalized + summary.hash === requested + not failed  → `finalized`
 *  - finalized + summary.hash === requested + failed      → `rejected`
 *  - finalized + summary.hash !== requested              → inconclusive (hash mismatch)
 *  - committed                                           → `committed` (not final)
 *  - received                                            → `pending` (not final)
 *  - not found / undefined / error / timeout / malformed  → inconclusive
 *
 * Only a `finalized` observation with a matching hash can advance a payment.
 */

import type { EvidenceRequest, EvidenceResult, EvidenceVerifier } from './evidence.js';
import type { ObservedStatus } from './state.js';

/** Minimal client surface needed by the verifier. */
export interface ConcordiumStatusClient {
  getBlockItemStatus(hash: unknown): Promise<unknown>;
}

export interface ConcordiumVerifierOptions {
  /** Per-query timeout in ms. Default 10s. */
  timeoutMs?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class ConcordiumEvidenceVerifier implements EvidenceVerifier {
  readonly name = 'concordium-grpc';
  private readonly client: ConcordiumStatusClient;
  private readonly timeoutMs: number;

  constructor(client: ConcordiumStatusClient, opts: ConcordiumVerifierOptions = {}) {
    this.client = client;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async verify(request: EvidenceRequest): Promise<EvidenceResult> {
    const rawInput = request.transaction;
    // Normalize case before validating: Concordium hashes are hex, and a caller may present
    // them in either case. The recorded form is lowercase.
    const transaction = typeof rawInput === 'string' ? rawInput.toLowerCase() : rawInput;

    // Only a previously persisted 64-char hash is accepted. Anything else is inconclusive.
    if (typeof transaction !== 'string' || !HEX64.test(transaction)) {
      return {
        available: false,
        observed: 'unknown',
        source: this.name,
        error: `invalid transaction hash: ${String(rawInput)}`,
      };
    }

    let raw: unknown;
    try {
      // The node client expects a TransactionHash, not a string. Convert here so callers
      // (and tests) can hand us a plain 64-hex string.
      let hashArg: unknown = transaction;
      try {
        const { TransactionHash } = await import('@concordium/web-sdk/types');
        hashArg = TransactionHash.fromHexString(transaction);
      } catch {
        // Already a TransactionHash or unknown — pass through and let the node reject it.
      }
      raw = await withTimeout(this.client.getBlockItemStatus(hashArg), this.timeoutMs);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // NOT_FOUND is a definitive "not on this node" answer — inconclusive, not success.
      if (/not.?found|NOT_FOUND/i.test(msg)) {
        return { available: false, observed: 'unknown', source: this.name, error: `not found: ${msg}` };
      }
      return { available: false, observed: 'unknown', source: this.name, error: `node query failed: ${msg}` };
    }

    return mapStatus(raw, transaction, this.name);
  }
}

/**
 * Map a raw node response to evidence. Pure function — no I/O.
 *
 * The hash binding is the critical step: a `finalized` status is only trusted when the
 * response names the exact transaction we asked about. Otherwise it is inconclusive.
 */
export function mapStatus(
  raw: unknown,
  requestedHash: string,
  source: string,
): EvidenceResult {
  if (raw === null || raw === undefined) {
    return { available: false, observed: 'unknown', source, error: 'empty response' };
  }
  if (typeof raw !== 'object') {
    return { available: false, observed: 'unknown', source, error: `malformed response: ${typeof raw}` };
  }

  const r = raw as { status?: unknown; outcomes?: unknown; outcome?: unknown };

  if (r.status !== 'received' && r.status !== 'committed' && r.status !== 'finalized') {
    return { available: false, observed: 'unknown', source, error: `unsupported status: ${String(r.status)}` };
  }

  if (r.status === 'received') {
    return { available: true, observed: 'pending', source, raw };
  }

  if (r.status === 'committed') {
    // Committed is NOT final. No hash binding is required to say "not yet".
    return { available: true, observed: 'committed', source, raw };
  }

  // status === 'finalized': the outcome must name the requested transaction.
  const outcome = r.outcome as
    | { blockHash?: unknown; summary?: { hash?: unknown; transactionType?: unknown } }
    | undefined;
  if (!outcome || typeof outcome !== 'object') {
    return { available: false, observed: 'unknown', source, error: 'finalized response missing outcome' };
  }

  const summaryHash = outcome.summary?.hash;
  if (summaryHash === undefined || summaryHash === null) {
    return { available: false, observed: 'unknown', source, error: 'finalized outcome missing summary hash' };
  }

  // Normalize: the SDK returns a TransactionHash object; accept its hex form or a string.
  const summaryHex = normalizeHash(summaryHash);
  if (summaryHex === null) {
    return { available: false, observed: 'unknown', source, error: 'finalized summary hash is not a valid hash' };
  }
  if (summaryHex !== requestedHash) {
    return {
      available: false,
      observed: 'unknown',
      source,
      error: `hash mismatch: requested=${requestedHash} reported=${summaryHex}`,
    };
  }

  const transactionType = outcome.summary?.transactionType;
  if (transactionType === 'failed') {
    return { available: true, observed: 'failed', source, raw };
  }
  return { available: true, observed: 'finalized', source, raw };
}

function normalizeHash(value: unknown): string | null {
  if (typeof value === 'string') return HEX64.test(value.toLowerCase()) ? value.toLowerCase() : null;
  const obj = value as { toString?: () => string; value?: unknown } | null;
  if (obj && typeof obj.toString === 'function') {
    const s = obj.toString();
    if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`node query exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Re-export so tests and the config can use the same mapping. */
export const EVIDENCE_STATUSES: readonly ObservedStatus[] = [
  'finalized',
  'failed',
  'rejected',
  'committed',
  'pending',
  'unknown',
];
