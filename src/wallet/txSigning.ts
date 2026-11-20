/**
 * Wallet Context signing protocol core (offline, no broadcast).
 * Input: prepared sponsored transaction JSON. Output: signedTransaction JSON
 * with sender signature added; sponsor signature preserved. Only the signed
 * transaction leaves the iframe; seed/private key/signer never do.
 */
import { Transaction, type AccountSigner } from '@concordium/web-sdk';

export interface PreparedSigningRequest {
  protocolVersion: string;
  network: 'testnet';
  prepared: Record<string, unknown>;
  credentialIndex?: number;
  keyIndex?: number;
}

export interface SignDeps {
  status(): { state: 'locked' | 'unlocked' };
  getSigner(credentialIndex: number): AccountSigner | null;
  requestApproval(details: Record<string, unknown>): Promise<boolean>;
}

export type SignResult =
  | { ok: true; signedTransaction: Record<string, unknown>; senderAddress: string; credentialIndex: number }
  | { ok: false; reason: string };

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export function canonicalHeaderKey(header: unknown): string {
  const h = { ...(header as Record<string, unknown>) };
  for (const key of ['nonce', 'expiry', 'executionEnergyAmount', 'numSignatures']) {
    if (h[key] !== undefined) h[key] = String(h[key]);
  }
  const sponsor = h['sponsor'] as Record<string, unknown> | undefined;
  if (sponsor) h['sponsor'] = { ...sponsor, numSignatures: String(sponsor['numSignatures']) };
  return stableStringify(h);
}

function bindingKey(prepared: Record<string, unknown>): string {
  return canonicalHeaderKey(prepared['header']) + '|' + stableStringify(prepared['payload']);
}

function details(prepared: Record<string, unknown>): Record<string, unknown> {
  const h = (prepared['header'] ?? {}) as Record<string, unknown>;
  const p = (prepared['payload'] ?? {}) as Record<string, unknown>;
  const sponsor = (h['sponsor'] as Record<string, unknown> | undefined) ?? {};
  return {
    network: 'testnet',
    sender: h['sender'],
    sponsor: sponsor['account'],
    payloadType: p['type'],
    recipient: p['toAddress'],
    amount: p['amount'],
    nonce: h['nonce'],
    expiry: h['expiry'],
    executionEnergy: h['executionEnergyAmount'],
  };
}

export async function signPreparedTransaction(req: PreparedSigningRequest, deps: SignDeps): Promise<SignResult> {
  if (deps.status().state !== 'unlocked') return { ok: false, reason: 'wallet_locked' };
  if (req.network !== 'testnet') return { ok: false, reason: 'network_mismatch' };
  const prepared = req.prepared;
  const sponsorSigs = (prepared?.['signatures'] as Record<string, unknown> | undefined)?.['sponsor'];
  if (!sponsorSigs || Object.keys(sponsorSigs as Record<string, unknown>).length === 0) {
    return { ok: false, reason: 'sponsor_signature_missing' };
  }
  let signable: ReturnType<typeof Transaction.signableFromJSON>;
  try {
    signable = Transaction.signableFromJSON(prepared as never);
    const header = (signable as unknown as { header?: { sender?: unknown } }).header;
    if (header?.sender === undefined || header.sender === null || String(header.sender).length === 0) return { ok: false, reason: 'invalid_transaction' };
  } catch { return { ok: false, reason: 'invalid_transaction' }; }

  const key = bindingKey(prepared);
  const approved = await deps.requestApproval(details(prepared));
  if (!approved) return { ok: false, reason: 'user_rejected' };
  // Fail closed if the prepared object changed while the user was approving.
  if (bindingKey(prepared) !== key) return { ok: false, reason: 'approval_payload_tampered' };
  if (deps.status().state !== 'unlocked') return { ok: false, reason: 'wallet_locked' };

  const credentialIndex = req.credentialIndex ?? 0;
  const signer = deps.getSigner(credentialIndex);
  if (!signer) return { ok: false, reason: 'wallet_locked' };
  try {
    const signed = await Transaction.sign(signable as never, signer);
    const json = Transaction.toJSON(signed) as unknown as Record<string, unknown>;
    const sponsor = (json['signatures'] as Record<string, unknown> | undefined)?.['sponsor'];
    const sender = (json['signatures'] as Record<string, unknown> | undefined)?.['sender'];
    if (!sponsor || Object.keys(sponsor as Record<string, unknown>).length === 0) return { ok: false, reason: 'sponsor_signature_missing' };
    if (!sender || Object.keys(sender as Record<string, unknown>).length === 0) return { ok: false, reason: 'sender_signature_missing' };
    const header = (json['header'] ?? {}) as Record<string, unknown>;
    return { ok: true, signedTransaction: json, senderAddress: String(header['sender']), credentialIndex };
  } catch { return { ok: false, reason: 'signing_failed' }; }
}
