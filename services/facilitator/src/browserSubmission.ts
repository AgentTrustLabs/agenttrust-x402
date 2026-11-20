/**
 * Browser payment submission handoff.
 *
 * The facilitator does NOT sign and does NOT hold keys. It validates the
 * wallet-produced signature against stored prepare state and on-chain keys,
 * claims a one-shot broadcast record, then uses the existing
 * ConcordiumTransactionSubmitter. A transport failure is never retried
 * blindly; the durable claim prevents a second broadcast.
 */
import { Transaction, type AccountInfo, type AccountTransactionSignature } from '@concordium/web-sdk';
import type { ConcordiumTransactionSubmitter } from './concordiumTransactionSubmitter.js';
import { SubmissionError } from './submissionErrors.js';
import {
  canonicalHeaderKey, stableStringify,
  type BrowserPaymentStore, type BrowserPaymentRow,
} from './browserBridge.js';
import { ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG } from './energy.js';
import { transactionEnergyOf } from './signingService.js';

export interface SubmitRequest {
  paymentRef: string;
  signedTransaction: Record<string, unknown>;
}

export type SubmitResult =
  | {
      ok: true;
      paymentRef: string;
      txHash: string;
      state: 'submitted' | 'idempotent';
      idempotent: boolean;
      status: 'submitted' | 'accepted';
    }
  | { ok: false; status: number; reason: string };

export interface BrowserSubmissionOptions {
  store: BrowserPaymentStore;
  submitter: ConcordiumTransactionSubmitter;
  accountProvider: { getAccountInfo(address: string, network: string): Promise<AccountInfo | null> };
  network: string;
  maxEnergy: bigint;
  maxFeeMicroCcd: bigint;
  now?: () => number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

function fail(reason: string, status = 400): SubmitResult { return { ok: false, status, reason }; }

export class BrowserSubmissionService {
  private readonly opts: BrowserSubmissionOptions;
  constructor(opts: BrowserSubmissionOptions) { this.opts = opts; }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    if (!req || typeof req.paymentRef !== 'string' || !HEX64.test(req.paymentRef)) return fail('invalid_payment_ref');
    const tx = req.signedTransaction;
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return fail('invalid_signed_transaction');

    const row = this.opts.store.getBrowserPayment(req.paymentRef);
    if (!row) return fail('unknown_payment_ref', 404);

    // Idempotency: an already-submitted payment returns the same hash, never a new broadcast.
    if (row.tx_hash && (row.state === 'submitted' || row.state === 'pending_confirmation' || row.state === 'finalized')) {
      return { ok: true, paymentRef: row.payment_ref, txHash: row.tx_hash, state: 'idempotent', idempotent: true, status: 'submitted' };
    }
    if (row.submission_claimed && !row.tx_hash) {
      return fail('submission_outcome_unknown', 409);
    }
    if (row.state === 'submitted' || row.state === 'pending_confirmation' || row.state === 'finalized') {
      return fail('payment_already_settled', 409);
    }

    const binding = this.validateBinding(row, tx);
    if (!binding.ok) return binding;

    const signatures = await this.verifySignatures(row, tx);
    if (!signatures.ok) return fail(signatures.reason, 403);

    // One-shot durable claim BEFORE the network call. A timeout after the node
    // received the transaction must never be retried as a second broadcast.
    const claim = this.opts.store.claimSubmission(req.paymentRef);
    if (!claim.ok) return fail('submission_outcome_unknown', 409);

    try {
      const result = await this.opts.submitter.submit(tx, { correlationId: req.paymentRef });
      this.opts.store.updateBrowserPayment(req.paymentRef, {
        state: 'submitted',
        tx_hash: result.hash,
        submission_tx_hash: result.hash,
        submission_error: null,
        final_transaction: stableStringify(tx),
      });
      return { ok: true, paymentRef: req.paymentRef, txHash: result.hash, state: 'submitted', idempotent: false, status: result.status };
    } catch (e) {
      const kind = e instanceof SubmissionError ? e.kind : 'transport';
      const reason = `submission_${kind}`;
      this.opts.store.updateBrowserPayment(req.paymentRef, {
        state: kind === 'validation' ? 'failed' : 'outcome_unknown',
        submission_error: reason,
        evidence: JSON.stringify({ submissionError: reason }),
      });
      return fail(reason, kind === 'validation' ? 400 : 503);
    }
  }

  private validateBinding(row: BrowserPaymentRow, tx: Record<string, unknown>): { ok: true } | { ok: false; status: number; reason: string } {
    let prepared: Record<string, unknown>;
    try { prepared = JSON.parse(row.prepared_transaction); } catch { return fail('prepared_transaction_invalid', 500); }
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return fail('prepared_transaction_invalid', 500);
    if (canonicalHeaderKey(prepared['header']) !== canonicalHeaderKey(tx['header'])) return fail('payment_binding_mismatch', 409);
    if (stableStringify(prepared['payload']) !== stableStringify(tx['payload'])) return fail('payment_binding_mismatch', 409);

    const reqParts = row.requirements_key.split('|');
    if (reqParts[0] !== this.opts.network) return fail('wrong_network', 409);
    const payload = prepared['payload'] as Record<string, unknown>;
    if (String(payload['toAddress']) !== reqParts[1] || String(payload['amount']) !== reqParts[2]) return fail('payment_binding_mismatch', 409);

    const header = prepared['header'] as Record<string, unknown>;
    const expiry = Number(header['expiry']);
    const nowSec = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (!Number.isFinite(expiry) || expiry <= nowSec) return fail('payment_expired', 409);

    const energy = transactionEnergyOf(tx);
    if (energy === null || energy <= 0n) return fail('energy_invalid', 400);
    if (energy > this.opts.maxEnergy) return fail('energy_exceeds_policy', 409);
    if (energy * ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG > this.opts.maxFeeMicroCcd) return fail('fee_exceeds_policy', 409);

    return { ok: true };
  }

  async verifySignatures(row: BrowserPaymentRow, tx: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const [party, address] of [['sender', row.sender], ['sponsor', row.sponsor]] as const) {
      const info = await this.opts.accountProvider.getAccountInfo(address, this.opts.network);
      if (!info) return { ok: false, reason: `${party}_account_not_found` };
      try {
        const signable = Transaction.signableFromJSON(tx as never);
        const signatures = (signable as unknown as { signatures?: Record<string, AccountTransactionSignature> }).signatures?.[party] ?? ({} as AccountTransactionSignature);
        const verified = await Transaction.verifySignature(signable, signatures, {
          accountThreshold: info.accountThreshold,
          accountCredentials: info.accountCredentials,
          accountAddress: info.accountAddress,
        });
        if (!verified) return { ok: false, reason: `${party}_signature_invalid` };
      } catch {
        return { ok: false, reason: `${party}_signature_invalid` };
      }
    }
    return { ok: true };
  }
}
