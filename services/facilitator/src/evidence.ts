/**
 * Trusted evidence boundary for reconciliation.
 *
 * The problem this solves: an operator calling `/reconcile` must not be able to *assert*
 * success. A string `"finalized"` in a request body is a claim, not evidence.
 *
 * The rule enforced here is that a payment may only be finalized when an
 * `EvidenceVerifier` — an interface that is expected to consult an independent source —
 * confirms the observation for the exact transaction hash we recorded. The verifier's
 * verdict is bound to the hash and to the payment, and a caller can choose *which hash to
 * ask about* but can never choose *what the answer is*.
 *
 * In this prototype the verifier is deterministic and offline. A future implementation wraps
 * a gRPC `getBlockItemStatus`; it must satisfy the same contract, and the state machine does
 * not need to change.
 */

import type { ObservedStatus } from './state.js';

export interface EvidenceRequest {
  /** The hash recorded for this payment. Callers may not substitute a different one. */
  transaction: string;
  /** Payment the evidence is being sought for. */
  paymentDigest: string;
}

export interface EvidenceResult {
  /** Whether the verifier could establish anything at all. */
  available: boolean;
  /** Chain-reported status, verbatim. Never a caller-supplied string. */
  observed: ObservedStatus;
  /** Provenance, recorded in the audit trail. */
  source: string;
  /** Raw evidence the verifier relied on, for the audit digest. */
  raw?: unknown;
  /** Set when the verifier failed or could not be asked. */
  error?: string;
}

export interface EvidenceVerifier {
  readonly name: string;
  /** Look up the status of a specific transaction hash. Must never invent a hash. */
  verify(request: EvidenceRequest): Promise<EvidenceResult>;
}

/**
 * Offline verifier for tests and for the mock prototype.
 *
 * It answers from a fixed table keyed by transaction hash. It cannot be persuaded to report
 * `finalized` for a hash that is not in the table, and it has no way to accept a caller's
 * claim. That is the whole point: this is the *trusted* side of the boundary.
 */
export class FixtureEvidenceVerifier implements EvidenceVerifier {
  readonly name = 'fixture';
  private readonly table: Map<string, ObservedStatus>;
  private readonly unreachable: boolean;

  constructor(fixtures: Record<string, ObservedStatus> = {}, opts: { unreachable?: boolean } = {}) {
    this.table = new Map(Object.entries(fixtures));
    this.unreachable = opts.unreachable ?? false;
  }

  async verify(request: EvidenceRequest): Promise<EvidenceResult> {
    if (this.unreachable) {
      return {
        available: false,
        observed: 'unknown',
        source: this.name,
        error: 'evidence source unreachable',
      };
    }
    const status = this.table.get(request.transaction);
    if (status === undefined) {
      return {
        available: false,
        observed: 'unknown',
        source: this.name,
        error: `no evidence for transaction ${request.transaction.slice(0, 16)}…`,
      };
    }
    return {
      available: true,
      observed: status,
      source: this.name,
      raw: { transaction: request.transaction, status },
    };
  }
}

/**
 * A verifier that consults the mock signer's own submission record.
 *
 * This models the realistic production shape: the facilitator asks the same component that
 * submitted the transaction what the chain now says. In this prototype it is still offline.
 */
export function createSignerBackedVerifier(signer: {
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<{ txHash: string; status: ObservedStatus }>;
}, opts: { timeoutMs?: number } = {}): EvidenceVerifier {
  return {
    name: 'mock-signer',
    async verify(request) {
      try {
        const r = await signer.waitForFinalization(request.transaction, opts.timeoutMs ?? 5_000);
        // Bind the answer to the hash we asked about; a verifier that returns a different
        // hash has not answered the question.
        if (r.txHash !== request.transaction) {
          return {
            available: false,
            observed: 'unknown',
            source: 'mock-signer',
            error: `verifier answered for a different transaction (${r.txHash.slice(0, 16)}…)`,
          };
        }
        return { available: true, observed: r.status, source: 'mock-signer', raw: r };
      } catch (e) {
        return {
          available: false,
          observed: 'unknown',
          source: 'mock-signer',
          error: String((e as Error)?.message ?? e).slice(0, 200),
        };
      }
    },
  };
}
