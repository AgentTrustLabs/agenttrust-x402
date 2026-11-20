/**
 * Isolated PoC: local sponsored-transaction signing.
 *
 * Proves: prepared sponsored transaction + sender signature → complete
 * signedTransaction, using only @concordium/web-sdk APIs.
 *
 * Hard rules:
 *  - no network, no broadcast, no node access (nothing here can submit);
 *  - no private keys in this module: the signer is injected;
 *  - no logs, files, DB, or telemetry of key material;
 *  - signatures are verified with the same Transaction.verifySignature the
 *    facilitator /confirm path uses.
 */
import { Transaction, type AccountSigner } from '@concordium/web-sdk';

export interface LocalSponsoredSigningInput {
  /** Prepared signable (sponsor-signed or sponsorable) as JSON. */
  preparedSponsored: unknown;
  /** Injected sender signer. The module never creates or reads keys. */
  senderSigner: AccountSigner;
  /** Optional injected sponsor signer, used when the prepared tx is not yet sponsored. */
  sponsorSigner?: AccountSigner;
}

export interface LocalSponsoredSigningResult {
  /** Complete signed transaction JSON (sender + sponsor signatures). */
  signedTransaction: Record<string, unknown>;
  senderSignature: unknown;
  sponsorSignature: unknown;
}

/** Sign a prepared sponsored transaction locally. Never broadcasts. */
export async function signPreparedSponsoredTransaction(
  input: LocalSponsoredSigningInput,
): Promise<LocalSponsoredSigningResult> {
  const signable = Transaction.signableFromJSON(input.preparedSponsored);
  const sponsored = input.sponsorSigner
    ? await Transaction.sponsor(signable as never, input.sponsorSigner)
    : signable;
  const signed = await Transaction.sign(sponsored as never, input.senderSigner);
  const json = Transaction.toJSON(signed) as unknown as Record<string, unknown>;
  const signatures = (json['signatures'] ?? {}) as Record<string, unknown>;
  return {
    signedTransaction: json,
    senderSignature: signatures['sender'] ?? {},
    sponsorSignature: signatures['sponsor'] ?? {},
  };
}

/** JSON with SDK bigint fields normalized, for exact structural comparisons. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
}

/** SDK toJSON emits numeric header fields as decimal strings; compare semantically. */
export function canonicalHeaderKey(header: unknown): string {
  const h = { ...(header as Record<string, unknown>) };
  for (const key of ['nonce', 'expiry', 'executionEnergyAmount', 'numSignatures']) {
    if (h[key] !== undefined) h[key] = String(h[key]);
  }
  const sponsor = h['sponsor'] as Record<string, unknown> | undefined;
  if (sponsor) h['sponsor'] = { ...sponsor, numSignatures: String(sponsor['numSignatures']) };
  return stableStringify(h);
}

export function headerPayloadBinding(prepared: unknown, signed: unknown): boolean {
  const p = prepared as Record<string, unknown>;
  const s = signed as Record<string, unknown>;
  return canonicalHeaderKey(p['header']) === canonicalHeaderKey(s['header'])
    && stableStringify(p['payload']) === stableStringify(s['payload']);
}

/** Verify both signatures with the same SDK primitive /confirm uses. */
export async function verifySignedTransaction(
  signed: unknown,
  accountInfoFor: (address: string) => { accountThreshold: number; accountCredentials: unknown; accountAddress: unknown },
): Promise<{ sender: boolean; sponsor: boolean }> {
  const signable = Transaction.signableFromJSON(signed);
  const signatures = (signable as unknown as { signatures?: { sender?: unknown; sponsor?: unknown } }).signatures ?? {};
  const senderSig = signatures.sender ?? ({} as never);
  const sponsorSig = signatures.sponsor ?? ({} as never);
  const header = (signable as unknown as { header?: { sender?: unknown } }).header;
  const senderRaw = header?.sender;
  const sender = typeof senderRaw === 'string' ? senderRaw : String(senderRaw);
  const sponsorRaw = (signable as unknown as { header?: { sponsor?: { account?: unknown } } }).header?.sponsor?.account;
  const sponsor = typeof sponsorRaw === 'string' ? sponsorRaw : String(sponsorRaw);
  return {
    sender: await Transaction.verifySignature(signable, senderSig as never, accountInfoFor(sender) as never),
    sponsor: await Transaction.verifySignature(signable, sponsorSig as never, accountInfoFor(sponsor) as never),
  };
}
