/**
 * Browser-initiated sponsored x402 bridge (prepare / confirm).
 *
 * The browser wallet signs AND submits (`sendSponsoredTransaction`), so the
 * facilitator cannot submit. This module therefore splits the flow:
 *
 *   prepare  — validate requirements, obtain the Owner authorization for the
 *              exact unsigned transaction, ask the signing service for the
 *              sponsor signature, and hand the sponsor-signed signable to the
 *              browser. NOTHING is submitted here.
 *   confirm  — the browser returns the wallet-submitted txHash plus the final
 *              signable (sender signature added by the wallet). Verify the
 *              sender and sponsor signatures against on-chain keys, read the
 *              transaction on-chain, and record the outcome only from evidence.
 *
 * Authorization is NOT weakened: `preFinalized` strips ALL signatures and
 * `signDigest` hashes only header+payload, so the sponsor digest (and every
 * policy field) is identical before and after the wallet adds the sender
 * signature. The Owner certificate issued at prepare therefore binds the exact
 * transaction the wallet later submits.
 *
 * The CLI settlement path (`FacilitatorCore.settle`) is untouched.
 */

import { randomBytes } from 'node:crypto';
import { AccountAddress, Transaction } from '@concordium/web-sdk';
import type { AccountInfo, AccountTransactionSignature } from '@concordium/web-sdk';
import { convertV2ToSdkV1 } from './wireConverter.js';
import { signingDigestOf, transactionEnergyOf } from './signingService.js';
import { paymentDigest, requirementsKey } from './store.js';
import { SIMPLE_TRANSFER_BASE_COST } from './energy.js';
import type { AuthorizationClient, AuthorizationRequest } from './authorization.js';
import type { OwnerAuthorizationCertificate } from './ownerAuthorization.js';
import type { SponsorSigner } from './signer.js';

export const MAX_EXPIRY_OFFSET_SECONDS = 600;

export type BrowserPaymentState =
  | 'requested'
  | 'authorized'
  | 'sponsor_signed'
  | 'submitting'
  | 'submitted'
  | 'pending_confirmation'
  | 'finalized'
  | 'failed'
  | 'outcome_unknown';

export interface BrowserPaymentRow {
  payment_ref: string;
  request_id: string;
  prepared_digest: string;
  requirements_key: string;
  resource_url: string;
  sender: string;
  sponsor: string;
  state: BrowserPaymentState;
  tx_hash: string | null;
  prepared_transaction: string;
  sponsor_signed_transaction: string;
  final_transaction: string | null;
  evidence: string | null;
  submission_claimed?: number;
  submission_tx_hash?: string | null;
  submission_error?: string | null;
  created_at: number;
  updated_at: number;
}

export interface BrowserPaymentStore {
  createBrowserPayment(row: BrowserPaymentRow): { ok: true } | { ok: false; reason: string };
  getBrowserPayment(paymentRef: string): BrowserPaymentRow | null;
  getBrowserPaymentByTxHash(txHash: string): BrowserPaymentRow | null;
  listBrowserPayments(limit: number): BrowserPaymentRow[];
  updateBrowserPayment(paymentRef: string, patch: Partial<BrowserPaymentRow>): { ok: true } | { ok: false; reason: string };
  claimSubmission(paymentRef: string): { ok: true } | { ok: false; reason: string };
}

export interface BrowserChainVerifier {
  /** Read-only transfer summary for a block-item hash. null = not available. */
  readTransfer(txHash: string): Promise<{
    status: 'finalized' | 'pending' | 'rejected' | 'unavailable';
    sender: string;
    sponsor: string;
    recipient: string;
    amount: string;
    network: string;
    failed: boolean;
    blockHash?: string;
    blockHeight?: string;
  } | null>;
}

export interface BrowserAccountProvider {
  getAccountInfo(address: string, network: string): Promise<AccountInfo | null>;
}

export interface BrowserBridgeOptions {
  network: string;
  sponsorAddress: string;
  maxEnergy: bigint;
  maxFeeMicroCcd: string;
  authorization: AuthorizationClient;
  signer: SponsorSigner;
  store: BrowserPaymentStore;
  chain: BrowserChainVerifier;
  accountProvider: BrowserAccountProvider;
  senderVerifier?: (txJson: unknown) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** TEST seam: defaults to SDK verification against on-chain sponsor keys. */
  sponsorVerifier?: (txJson: unknown, sponsor: string) => Promise<boolean>;
  now?: () => number;
  paymentRefFactory?: () => string;
  requestIdFactory?: () => string;
}

export interface PrepareRequest {
  requirements: Record<string, unknown>;
  resourceUrl: string;
  sender: string;
  requestId?: string;
}

export interface ConfirmRequest {
  paymentRef: string;
  requestId: string;
  signedTransaction: Record<string, unknown>;
  txHash: string;
}

export type PrepareResult =
  | { ok: true; paymentRef: string; requestId: string; sponsoredTransaction: unknown }
  | { ok: false; status: number; reason: string };

export type ConfirmResult =
  | { ok: true; state: BrowserPaymentState; paymentRef: string; txHash: string; idempotent: boolean }
  | { ok: false; status: number; reason: string };

function isAddress(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  try { AccountAddress.fromBase58(v); return true; } catch { return false; }
}

function isDigits(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

/** JSON.stringify that tolerates SDK bigint fields in signable transactions. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}

/** SDK `Transaction.toJSON` emits numeric header fields as decimal strings;
 *  our prepared transaction uses JSON numbers. Compare semantically. */
export function canonicalHeaderKey(header: unknown): string {
  const h = { ...(header as Record<string, unknown>) };
  for (const key of ['nonce', 'expiry', 'executionEnergyAmount', 'numSignatures']) {
    if (h[key] !== undefined) h[key] = String(h[key]);
  }
  const sponsor = h['sponsor'] as Record<string, unknown> | undefined;
  if (sponsor) h['sponsor'] = { ...sponsor, numSignatures: String(sponsor['numSignatures']) };
  return stableStringify(h);
}

export class BrowserPaymentBridge {
  private readonly opts: BrowserBridgeOptions;
  constructor(opts: BrowserBridgeOptions) { this.opts = opts; }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  async prepare(req: PrepareRequest): Promise<PrepareResult> {
    const r = req.requirements ?? {};
    const fail = (reason: string, status = 400): PrepareResult => ({ ok: false, status, reason });

    if (r['scheme'] !== 'exact') return fail('unsupported_scheme');
    if (r['network'] !== this.opts.network) return fail('network_mismatch');
    if (r['asset'] !== 'CCD') return fail('unsupported_asset');
    if (!isDigits(r['amount']) || BigInt(r['amount'] as string) <= 0n) return fail('invalid_amount');
    if (!isAddress(r['payTo'])) return fail('invalid_recipient');
    if (!isAddress(req.sender)) return fail('invalid_sender');
    if (req.sender === r['payTo']) return fail('sender_is_recipient');
    const extra = (r['extra'] ?? {}) as Record<string, unknown>;
    const sponsor = typeof extra['feePayer'] === 'string' ? extra['feePayer'] : this.opts.sponsorAddress;
    if (!isAddress(sponsor)) return fail('invalid_sponsor');
    if (sponsor !== this.opts.sponsorAddress) return fail('wrong_sponsor');
    if (sponsor === req.sender || sponsor === r['payTo']) return fail('sponsor_collision');
    const timeout = Number(r['maxTimeoutSeconds'] ?? 300);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_EXPIRY_OFFSET_SECONDS) return fail('invalid_expiry_window');
    if (typeof req.resourceUrl !== 'string' || req.resourceUrl.length === 0) return fail('invalid_resource_url');

    const nowSec = Math.floor(this.now() / 1000);
    const expiry = nowSec + timeout;
    let nonce: bigint;
    try {
      const info = await this.opts.accountProvider.getAccountInfo(req.sender, this.opts.network);
      if (info === null) return fail('sender_not_found', 404);
      nonce = BigInt(info.accountNonce as unknown as bigint);
    } catch { return fail('account_provider_unavailable', 503); }
    if (!Number.isSafeInteger(Number(nonce)) || nonce < 0n) return fail('invalid_nonce');

    const requestId = req.requestId ?? (this.opts.requestIdFactory?.() ?? randomBytes(16).toString('hex'));
    const preparedTx = {
      version: 1,
      header: {
        sender: req.sender,
        nonce: Number(nonce),
        expiry,
        executionEnergyAmount: Number(SIMPLE_TRANSFER_BASE_COST),
        numSignatures: 1,
        sponsor: { account: sponsor, numSignatures: 1 },
      },
      payload: { type: 'transfer', toAddress: r['payTo'], amount: String(r['amount']) },
      signatures: { sender: {}, sponsor: {} },
    };
    const payload = {
      x402Version: 2,
      accepted: r,
      payload: { signedTransaction: preparedTx },
      resource: { url: req.resourceUrl },
      requestId,
    };
    const digestPrep = paymentDigest(payload);
    const reqKey = requirementsKey(r as never, req.resourceUrl);

    const conversion = convertV2ToSdkV1(preparedTx as never, {
      network: this.opts.network,
      sponsorAddress: sponsor,
      maxExecutionEnergy: Number(this.opts.maxEnergy),
    });
    if (!conversion.ok) return fail(`wire_conversion_failed:${conversion.code}`);
    let txDigest: string; let energy: bigint; let txType: string;
    try {
      txDigest = signingDigestOf(conversion.wire);
      energy = transactionEnergyOf(conversion.wire) ?? (() => { throw new Error('no energy'); })();
      const wirePayload = (conversion.wire as unknown as Record<string, unknown>)['payload'] as Record<string, unknown> | undefined;
      txType = String(wirePayload?.['type'] ?? '');
    } catch { return fail('authorization_digest_failed'); }
    if (txType === '') return fail('authorization_transaction_type_missing');
    if (energy > this.opts.maxEnergy) return fail('energy_exceeds_policy');

    const paymentRef = this.opts.paymentRefFactory?.() ?? randomBytes(32).toString('hex');
    const row: BrowserPaymentRow = {
      payment_ref: paymentRef,
      request_id: requestId,
      prepared_digest: digestPrep,
      requirements_key: reqKey,
      resource_url: req.resourceUrl,
      sender: req.sender,
      sponsor,
      state: 'requested',
      tx_hash: null,
      prepared_transaction: JSON.stringify(preparedTx),
      sponsor_signed_transaction: '',
      final_transaction: null,
      evidence: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    const created = this.opts.store.createBrowserPayment(row);
    if (!created.ok) return fail(created.reason, 409);

    const authRequest: AuthorizationRequest = {
      paymentDigest: digestPrep,
      network: this.opts.network,
      version: 1,
      sender: req.sender,
      sponsor,
      recipient: String(r['payTo']),
      asset: String(r['asset']),
      amount: String(r['amount']),
      expiry,
      energy,
      transactionDigest: txDigest,
      transactionType: txType,
      maxFeeMicroCcd: this.opts.maxFeeMicroCcd,
    };
    let auth;
    try { auth = await this.opts.authorization.authorize(authRequest); }
    catch { this.opts.store.updateBrowserPayment(paymentRef, { state: 'outcome_unknown' }); return fail('authorization_failed', 503); }
    if (auth.outcome !== 'approved' || !auth.certificate) {
      const reason = auth.reason ?? auth.outcome;
      this.opts.store.updateBrowserPayment(paymentRef, { state: 'failed', evidence: JSON.stringify({ authorization: auth.outcome, reason }) });
      return fail(`authorization_${auth.outcome}`, 403);
    }
    this.opts.store.updateBrowserPayment(paymentRef, { state: 'authorized' });

    let sponsored: unknown;
    try {
      sponsored = await this.opts.signer.addSponsorSignature(conversion.wire, {
        authorization: auth.certificate as OwnerAuthorizationCertificate,
        paymentDigest: digestPrep,
      });
    } catch {
      this.opts.store.updateBrowserPayment(paymentRef, { state: 'failed', evidence: JSON.stringify({ sponsorSigning: 'failed' }) });
      return fail('sponsor_signing_failed', 503);
    }
    this.opts.store.updateBrowserPayment(paymentRef, { state: 'sponsor_signed', sponsor_signed_transaction: JSON.stringify(sponsored) });
    return { ok: true, paymentRef, requestId, sponsoredTransaction: sponsored };
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmResult> {
    const fail = (reason: string, status = 400): ConfirmResult => ({ ok: false, status, reason });
    if (!/^[0-9a-fA-F]{64}$/.test(req.txHash)) return fail('invalid_tx_hash');
    const row = this.opts.store.getBrowserPayment(req.paymentRef);
    if (!row) return fail('unknown_payment_ref', 404);
    if (row.request_id !== req.requestId) return fail('request_id_mismatch', 409);
    if (row.state === 'finalized' || row.state === 'submitted' || row.state === 'pending_confirmation') {
      if (row.tx_hash === req.txHash.toLowerCase()) {
        return { ok: true, state: row.state, paymentRef: row.payment_ref, txHash: row.tx_hash, idempotent: true };
      }
      return fail('hash_mismatch_for_payment_ref', 409);
    }
    if (row.state === 'failed') return fail('payment_failed', 409);

    // The final signable must be the prepared transaction plus a sender signature.
    const prepared = JSON.parse(row.prepared_transaction) as Record<string, unknown>;
    const final = req.signedTransaction;
    const sameHeader = canonicalHeaderKey(prepared['header']) === canonicalHeaderKey(final['header']);
    const samePayload = stableStringify(prepared['payload']) === stableStringify(final['payload']);
    const sponsorSigs = (final['signatures'] as Record<string, unknown> | undefined)?.['sponsor'];
    const senderSigs = (final['signatures'] as Record<string, unknown> | undefined)?.['sender'];
    if (!sameHeader || !samePayload) return fail('transaction_binding_mismatch', 409);
    if (!sponsorSigs || Object.keys(sponsorSigs).length === 0) return fail('sponsor_signature_missing', 409);
    if (!senderSigs || Object.keys(senderSigs).length === 0) return fail('sender_signature_missing', 400);

    // Sender signature: official SDK verification against on-chain keys.
    if (this.opts.senderVerifier) {
      const v = await this.opts.senderVerifier(final);
      if (!v.ok) return fail(`sender_signature_invalid:${v.reason}`, 403);
    } else {
      const verified = await this.verifySenderSignature(final);
      if (!verified) return fail('sender_signature_invalid', 403);
    }
    const sponsorOk = this.opts.sponsorVerifier
      ? await this.opts.sponsorVerifier(final, row.sponsor)
      : await this.verifySponsorSignature(final, row.sponsor);
    if (!sponsorOk) return fail('sponsor_signature_invalid', 403);

    // On-chain evidence: the only source of finality.
    let summary;
    try { summary = await this.opts.chain.readTransfer(req.txHash); }
    catch { summary = null; }
    if (summary === null) {
      this.opts.store.updateBrowserPayment(req.paymentRef, { state: 'outcome_unknown', tx_hash: req.txHash.toLowerCase(), final_transaction: stableStringify(final), evidence: JSON.stringify({ chain: 'unavailable' }) });
      return fail('chain_evidence_unavailable', 503);
    }
    const matches =
      summary.sender === row.sender &&
      summary.sponsor === row.sponsor &&
      summary.recipient === (prepared['payload'] as Record<string, unknown>)['toAddress'] &&
      String(summary.amount) === String((prepared['payload'] as Record<string, unknown>)['amount']) &&
      summary.network === this.opts.network;
    if (!matches) {
      this.opts.store.updateBrowserPayment(req.paymentRef, { state: 'failed', tx_hash: req.txHash.toLowerCase(), final_transaction: stableStringify(final), evidence: JSON.stringify({ chainMismatch: true, summary }) });
      return fail('chain_evidence_mismatch', 409);
    }
    if (summary.status === 'rejected' || summary.failed) {
      this.opts.store.updateBrowserPayment(req.paymentRef, { state: 'failed', tx_hash: req.txHash.toLowerCase(), final_transaction: stableStringify(final), evidence: JSON.stringify(summary) });
      return fail('transaction_rejected', 409);
    }
    if (summary.status === 'pending') {
      this.opts.store.updateBrowserPayment(req.paymentRef, { state: 'pending_confirmation', tx_hash: req.txHash.toLowerCase(), final_transaction: stableStringify(final), evidence: JSON.stringify(summary) });
      return { ok: true, state: 'pending_confirmation', paymentRef: req.paymentRef, txHash: req.txHash.toLowerCase(), idempotent: false };
    }
    // finalized
    this.opts.store.updateBrowserPayment(req.paymentRef, { state: 'finalized', tx_hash: req.txHash.toLowerCase(), final_transaction: stableStringify(final), evidence: JSON.stringify(summary) });
    return { ok: true, state: 'finalized', paymentRef: req.paymentRef, txHash: req.txHash.toLowerCase(), idempotent: false };
  }

  private async verifySenderSignature(final: Record<string, unknown>): Promise<boolean> {
    try {
      const signable = Transaction.signableFromJSON(final as never);
      const senderRaw = signable.header?.sender;
      const sender = typeof senderRaw === 'string' ? senderRaw : String(senderRaw);
      const info = await this.opts.accountProvider.getAccountInfo(sender, this.opts.network);
      if (!info) return false;
      return await Transaction.verifySignature(signable, (signable as unknown as { signatures?: { sender?: AccountTransactionSignature } }).signatures?.sender ?? ({} as AccountTransactionSignature), {
        accountThreshold: info.accountThreshold,
        accountCredentials: info.accountCredentials,
        accountAddress: info.accountAddress,
      });
    } catch { return false; }
  }

  private async verifySponsorSignature(final: Record<string, unknown>, sponsor: string): Promise<boolean> {
    try {
      const signable = Transaction.signableFromJSON(final as never);
      const info = await this.opts.accountProvider.getAccountInfo(sponsor, this.opts.network);
      if (!info) return false;
      return await Transaction.verifySignature(signable, (signable as unknown as { signatures?: { sponsor?: AccountTransactionSignature } }).signatures?.sponsor ?? ({} as AccountTransactionSignature), {
        accountThreshold: info.accountThreshold,
        accountCredentials: info.accountCredentials,
        accountAddress: info.accountAddress,
      });
    } catch { return false; }
  }
}
