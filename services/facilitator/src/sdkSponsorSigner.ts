/**
 * Concordium SDK sponsor signer adapter.
 *
 * Production-facing sponsor signer boundary. Wraps the official Concordium SDK's
 * `sponsor()` flow behind the existing `SponsorSigner` interface so that
 * `FacilitatorCore.settle()` can reach a real sponsor signature without ever
 * handling a private key.
 *
 * Key invariants (non-negotiable):
 *   - The adapter NEVER accepts, stores, reads, imports, or exports a private key,
 *     mnemonic, keystore path, or wallet file. The ONLY signing input is an
 *     injected `AccountSigner` (already constructed by the caller's key custody).
 *   - The adapter NEVER constructs an `AccountSigner` from key material. Callers
 *     must supply one (e.g. from an HSM, a dedicated signing service, or a
 *     test fake).
 *   - `submitTransaction` and `waitForFinalization` are NOT implemented: the
 *     adapter signs only. Submission stays in the facilitator's durable pipeline.
 *   - Authorization must be obtained BEFORE `addSponsorSignature` is called. The
 *     adapter does not call authorization itself; `FacilitatorCore.settle()`
 *     enforces the ordering.
 *
 * SDK integration:
 *   - `sponsor(transaction, signer)` from `@concordium/web-sdk/transactions`
 *   - `signableFromJSON` / `signableToJSON` for JSON round-trip
 *   - `AccountTransactionV1.getAccountTransactionHash` for post-signature hashing
 */

import { AccountAddress, Transaction } from '@concordium/web-sdk';
import type { AccountSigner } from '@concordium/web-sdk';
import { computeTransactionHash } from './signer.js';
import { ConfigurationError } from './config.js';

export interface SdkSponsorSignerOptions {
  /** Sponsor account address (base58check). Public identifier, never a secret. */
  sponsorAddress: string;
  /** Network this signer is valid for (e.g. "ccd:4221332d..."). */
  network: string;
  /** Injected SDK signer. The adapter never constructs one from key material. */
  accountSigner: AccountSigner;
  /** Maximum energy (cost) the sponsor will accept. */
  maxEnergy: bigint;
  /** Maximum fee (in microCCD) the sponsor will accept. */
  maxFeeMicroCcd: bigint;
  /** Clock, ms. */
  now?: () => number;
}

export interface SdkSignerInfo {
  address: string;
  network: string;
  canSign: true;
  sdk: true;
}

/**
 * Validate that a sponsor address is a well-formed Concordium base58check address.
 * Returns null on success, an error message on failure.
 */
export function validateSponsorAddress(address: string): string | null {
  try {
    AccountAddress.fromBase58(address);
    return null;
  } catch {
    return `invalid sponsor address: ${address}`;
  }
}

/**
 * Validate sponsor context before signing. Returns null on success, an error message
 * on failure. Pure function — no I/O, no signing.
 */
export function validateSponsorContext(
  opts: Pick<SdkSponsorSignerOptions, 'sponsorAddress' | 'network' | 'maxEnergy' | 'maxFeeMicroCcd'>,
  ctx: { network: string; sponsor: string; recipient: string; energy: bigint; feeMicroCcd: bigint },
): string | null {
  if (ctx.network !== opts.network) {
    return `wrong network: ${ctx.network} != ${opts.network}`;
  }
  if (ctx.sponsor !== opts.sponsorAddress) {
    return `wrong sponsor: ${ctx.sponsor} != ${opts.sponsorAddress}`;
  }
  if (ctx.sponsor === ctx.recipient) {
    return 'sponsor must not equal recipient';
  }
  // Reject malformed / negative / unsafe values before any comparison.
  // Integer-safe: both values are bigint, so no float rounding can slip under a cap.
  const energyOk = typeof ctx.energy === 'bigint' && ctx.energy > 0n;
  const feeOk = typeof ctx.feeMicroCcd === 'bigint' && ctx.feeMicroCcd >= 0n;
  if (!energyOk || !feeOk) {
    return `malformed fee/energy context: energy=${String(ctx.energy)} feeMicroCcd=${String(ctx.feeMicroCcd)}`;
  }
  if (ctx.energy > opts.maxEnergy) {
    return `energy ${ctx.energy} exceeds cap ${opts.maxEnergy}`;
  }
  if (ctx.feeMicroCcd > opts.maxFeeMicroCcd) {
    return `fee ${ctx.feeMicroCcd} exceeds cap ${opts.maxFeeMicroCcd}`;
  }
  const addrErr = validateSponsorAddress(ctx.sponsor);
  if (addrErr) return addrErr;
  return null;
}


/**
 * True when the value is an x402 payment payload wrapping a signed transaction.
 */
function isSignedTransactionWrapper(value: unknown): value is { signedTransaction: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'signedTransaction' in value &&
    typeof (value as { signedTransaction?: unknown }).signedTransaction === 'object' &&
    (value as { signedTransaction?: unknown }).signedTransaction !== null
  );
}

/**
 * Create an SDK-backed sponsor signer.
 *
 * The signer is injected — this function NEVER constructs an AccountSigner from key
 * material. The caller (a dedicated signing service, an HSM adapter, or a test fake)
 * is responsible for key custody.
 */
export function createSdkSponsorSigner(opts: SdkSponsorSignerOptions): {
  info: () => SdkSignerInfo;
  addSponsorSignature: (txJson: unknown) => Promise<unknown>;
  computeHashAfterSignature: (txJson: unknown) => string;
  validateContext: (ctx: { network: string; sponsor: string; recipient: string; energy: bigint; feeMicroCcd: bigint }) => string | null;
} {
  const now = opts.now ?? (() => Date.now());
  const addrErr = validateSponsorAddress(opts.sponsorAddress);
  if (addrErr) throw new ConfigurationError(addrErr);

  const info = (): SdkSignerInfo => ({
    address: opts.sponsorAddress,
    network: opts.network,
    canSign: true,
    sdk: true,
  });

  const validateContext = (ctx: { network: string; sponsor: string; recipient: string; energy: bigint; feeMicroCcd: bigint }): string | null => {
    return validateSponsorContext(opts, { ...ctx, network: ctx.network });
  };

  const addSponsorSignature = async (txJson: unknown): Promise<unknown> => {
    // Accept both the bare signable transaction and the x402 wrapper
    // `{ signedTransaction: <SignableV1Transaction> }`. The facilitator core passes the
    // x402 payload, so unwrapping is required; the SDK's own FacilitatorConcordiumSigner
    // expects the bare shape.
    const bare = isSignedTransactionWrapper(txJson) ? txJson.signedTransaction : txJson;

    // The transaction must already be a signable V1 (sender-signed). We convert
    // from JSON, call the SDK's sponsor() which adds the sponsor signature using
    // the injected AccountSigner, then convert back to JSON.
    let signable: any;
    try {
      signable = Transaction.signableFromJSON(bare);
    } catch (e) {
      throw new Error(`sdk sponsor signer: invalid transaction: ${(e as Error)?.message ?? e}`);
    }
    if (!signable || signable.version !== 1) {
      throw new Error('sdk sponsor signer: only V1 sponsored transactions are supported');
    }

    let signed: any;
    try {
      signed = await Transaction.sponsor(signable, opts.accountSigner);
    } catch (e) {
      throw new Error(`sdk sponsor signer: signing failed: ${(e as Error)?.message ?? e}`);
    }

    // Transaction.toJSON detects a signable and converts it to the JSON shape the
    // facilitator's pipeline expects (version/header/payload/signatures).
    return Transaction.toJSON(signed);
  };

  const computeHashAfterSignature = (txJson: unknown): string => {
    // The sponsor signature MUST already be present. computeTransactionHash uses
    // AccountTransactionV1.getAccountTransactionHash which covers signatures.
    return computeTransactionHash(txJson);
  };

  return { info, addSponsorSignature, computeHashAfterSignature, validateContext };
}
