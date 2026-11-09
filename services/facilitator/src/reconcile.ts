/**
 * Reconciliation service: the only path from `settlement_pending` to `finalized`.
 *
 * Order of operations exists because each step can independently refuse:
 *
 *   1. authentication                 — operator only
 *   2. request shape                  — strict, no extra trust-bearing fields
 *   3. find the recorded payment      — unknown payment is refused
 *   4. bind to the RECORDED hash      — the caller cannot nominate a different transaction
 *   5. ask the trusted verifier       — the caller cannot supply finality
 *   6. apply only if evidence agrees  — mismatched/unavailable evidence retains pending
 *
 * A caller-supplied `status` field is *ignored entirely*. That is the entire point: the wire
 * format does not even have a place to put a finality claim.
 */

import type { EvidenceVerifier } from './evidence.js';
import { evidenceDigestOf, type ReconcileResult, type SettlementRepository } from './repository.js';

export interface ReconcileRequest {
  paymentDigest: string;
  /** Optional. When present it MUST equal the recorded hash; it never overrides it. */
  transaction?: string;
}

export type ReconcileOutcome =
  | { ok: true; state: string; changed: boolean; reason: string; evidence: { source: string; digest: string } }
  | { ok: false; code: string; reason: string };

export class ReconciliationService {
  private readonly repo: SettlementRepository;
  private readonly verifier: EvidenceVerifier;

  constructor(deps: { repository: SettlementRepository; verifier: EvidenceVerifier }) {
    this.repo = deps.repository;
    this.verifier = deps.verifier;
  }

  async reconcile(req: ReconcileRequest): Promise<ReconcileOutcome> {
    if (typeof req.paymentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(req.paymentDigest)) {
      return { ok: false, code: 'invalid_request', reason: 'paymentDigest must be a 64-char hex digest' };
    }

    const row = this.repo.get(req.paymentDigest);
    if (!row) return { ok: false, code: 'unknown_payment', reason: 'no such payment' };

    // The recorded hash is authoritative. A caller may repeat it; it may not replace it.
    const recorded = row.tx_hash;
    if (!recorded || recorded === 'unknown') {
      return {
        ok: false,
        code: 'no_recorded_transaction',
        reason: 'this payment has no transaction hash to reconcile against',
      };
    }
    if (req.transaction !== undefined && req.transaction !== recorded) {
      return { ok: false, code: 'hash_mismatch', reason: `recorded=${recorded} supplied=${req.transaction}` };
    }
    if (row.state === 'finalized') {
      return { ok: true, state: 'finalized', changed: false, reason: 'already finalized', evidence: { source: 'none', digest: '' } };
    }
    if (row.state === 'rejected') {
      return { ok: false, code: 'terminal', reason: 'payment is terminally rejected; evidence cannot reopen it' };
    }
    // observed / recovery_unavailable are reconcilable: evidence may still arrive later.
    if (row.state === 'prepared' || row.state === 'submitting' || row.state === 'created') {
      return {
        ok: false,
        code: 'not_reconcilable',
        reason: `payment is ${row.state}; there is nothing to reconcile against yet`,
      };
    }

    // ── trusted evidence. The caller has no influence on the answer. ──
    const ev = await this.verifier.verify({ transaction: recorded, paymentDigest: req.paymentDigest });
    if (!ev.available) {
      return {
        ok: true,
        state: row.state,
        changed: false,
        reason: `evidence unavailable (${ev.error ?? 'unknown'}); retained ${row.state}`,
        evidence: { source: ev.source, digest: '' },
      };
    }

    const digest = evidenceDigestOf({ source: ev.source, observed: ev.observed, raw: ev.raw ?? null });
    const result: ReconcileResult = this.repo.reconcile({
      paymentDigest: req.paymentDigest,
      transaction: recorded,
      observed: ev.observed,
      evidenceSource: ev.source,
      evidenceDigest: digest,
    });

    if (!result.ok) return { ok: false, code: 'refused', reason: result.reason };
    return {
      ok: true,
      state: result.state,
      changed: result.changed,
      reason: result.reason,
      evidence: { source: ev.source, digest },
    };
  }
}
