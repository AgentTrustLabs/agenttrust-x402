/**
 * Local sender signing for Concordium x402 sponsored transactions.
 *
 * The sender signs the sender part of a V1 sponsored transaction ON THE
 * LOCAL MACHINE, using an injected `AccountSigner` that the caller built
 * from the sender's own wallet export. The private key never leaves this
 * process: this module accepts only an already-constructed signer, never a
 * key, mnemonic, keystore path, or wallet file, and it never sends anything
 * to the facilitator. Only the signed transaction JSON leaves, with the
 * sponsor signature slot still empty — the facilitator adds the sponsor
 * signature later, during settlement.
 *
 * Fail-closed: every structural, identity, energy, nonce, and expiry check
 * runs BEFORE any signing. A validation failure throws and nothing is
 * signed. A transaction that already carries a sender (or sponsor)
 * signature is refused — signatures are never overwritten.
 *
 * Energy semantics (verified against the installed `@concordium/web-sdk`
 * 12.0.2; see `test/local-sender-signing.test.mts`):
 *   - `header.executionEnergyAmount` is the transaction-specific base cost
 *     C_t, NOT the total energy. For a plain transfer C_t = 300.
 *   - The SDK recomputes the TOTAL energy as
 *     `100 * signatureCount + 1 * (headerSize + payloadSize) + C_t`.
 *     For the standard sponsored transfer (1 sender + 1 sponsor signature)
 *     that total is 635 NRG.
 *   - Passing a TOTAL (e.g. 635 or 691) as `executionEnergyAmount` is a
 *     bug: the SDK treats it as C_t and recomputes a larger total, so the
 *     node prices a different transaction than the sender signed. This
 *     module therefore requires C_t to equal the known base cost for the
 *     payload type (300 for a transfer), and validates the recomputed
 *     total against the caller's energy cap.
 *
 * No network, no key material, no facilitator contact. Pure local work.
 */

import { AccountAddress, AccountTransactionV1, Transaction } from '@concordium/web-sdk';
import type { AccountSigner } from '@concordium/web-sdk';

// ─── policy constants ──────────────────────────────────────────────────────

/** Transaction-specific base cost C_t for a plain CCD transfer (Concordium `Cost.hs`). */
export const SIMPLE_TRANSFER_BASE_COST = 300n;
/** Maximum expiry window the sender will sign (1 hour from now). */
export const MAX_EXPIRY_SECONDS = 3600;
/** Default cap on the SDK-recomputed total energy (NRG). Callers may lower it. */
export const DEFAULT_MAX_TOTAL_ENERGY = 100_000n;

// ─── types ────────────────────────────────────────────────────────────────

export interface LocalSenderSigningOptions {
  /** The sender account that MUST match `header.sender`. Public identifier. */
  expectedSender: string;
  /** Cap on the SDK-recomputed total energy (NRG). Defaults to 100_000. */
  maxTotalEnergy?: bigint;
  /** Clock in milliseconds. Defaults to `Date.now`. Injected for tests. */
  now?: () => number;
}

export interface SignedSenderTransaction {
  /** The signed transaction JSON (BigInt fields converted to numbers). */
  signedTransaction: Record<string, unknown>;
  /** SDK-recomputed total energy (NRG) of the signed transaction. */
  energy: bigint;
  /** Hex signing digest the sender signed (the pre-finalized digest). */
  digest: string;
}

// ─── validation ───────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    AccountAddress.fromBase58(value);
    return true;
  } catch {
    return false;
  }
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEmptySignatureMap(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Unwrap the SDK's `Energy` value to a plain bigint (NRG). The SDK returns
 * an `Energy` class instance (`.value` is the bigint); a plain bigint or
 * number is accepted too. Returns null when the value cannot be read.
 */
function energyToBigint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    const v = (value as { value?: unknown }).value;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string' || typeof v === 'number') {
      try {
        return BigInt(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Validate a V1 sponsored transaction for local sender signing.
 * Returns an error message, or null when the transaction may be signed.
 * Pure function — no signing, no I/O.
 */
export function validateSenderTransaction(
  txJson: unknown,
  opts: LocalSenderSigningOptions,
): string | null {
  if (!isPlainObject(txJson)) return 'transaction must be a JSON object';
  if (txJson['version'] !== 1) return 'only V1 sponsored transactions are supported';

  const header = txJson['header'];
  if (!isPlainObject(header)) return 'header is required';

  // Sender identity: must be a valid address and must match the expected sender.
  const sender = header['sender'];
  if (!isValidAddress(sender)) return 'header.sender is not a valid Concordium address';
  if (sender !== opts.expectedSender) {
    return 'header.sender does not match the expected sender — refusing to sign';
  }

  // Nonce: a safe non-negative integer. The caller supplies it from the node;
  // this module only validates its shape, not its chain state.
  if (!isSafeNonNegativeInt(header['nonce'])) {
    return 'header.nonce must be a safe non-negative integer';
  }

  // Expiry: must be in the future and within the signing window.
  const expiry = header['expiry'];
  if (!isSafeNonNegativeInt(expiry)) {
    return 'header.expiry must be a safe non-negative integer (unix seconds)';
  }
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  if (expiry <= nowSec) return 'header.expiry is in the past — refusing to sign an expired transaction';
  if (expiry > nowSec + MAX_EXPIRY_SECONDS) {
    return `header.expiry is more than ${MAX_EXPIRY_SECONDS}s in the future — refusing to sign`;
  }

  // Energy base cost C_t: a positive safe integer. For transfer-family
  // payloads it MUST equal the known base cost; passing a total here is the
  // classic energy bug (the SDK recomputes a larger total from it).
  const cT = header['executionEnergyAmount'];
  if (!isSafeNonNegativeInt(cT) || cT <= 0) {
    return 'header.executionEnergyAmount must be a positive safe integer (the base cost C_t)';
  }

  // Sponsor: present, valid, distinct from sender.
  const sponsor = header['sponsor'];
  if (!isPlainObject(sponsor)) return 'header.sponsor is required';
  const sponsorAccount = sponsor['account'] ?? sponsor['address'];
  if (!isValidAddress(sponsorAccount)) return 'header.sponsor.account is not a valid Concordium address';
  if (sponsorAccount === sender) return 'sponsor must not equal the sender';
  const sponsorNumSigs = sponsor['numSignatures'];
  if (sponsorNumSigs !== undefined && !isSafeNonNegativeInt(sponsorNumSigs)) {
    return 'header.sponsor.numSignatures must be a safe non-negative integer';
  }

  // Payload: supported type, valid recipient/amount for transfers.
  const payload = txJson['payload'];
  if (!isPlainObject(payload)) return 'payload is required';
  const payloadType = payload['type'];
  if (payloadType !== 'transfer' && payloadType !== 'transferWithMemo' && payloadType !== 'tokenUpdate') {
    return `unsupported payload type: ${String(payloadType)}`;
  }
  if (payloadType === 'transfer' || payloadType === 'transferWithMemo') {
    // C_t must be the known transfer base cost.
    if (BigInt(cT) !== SIMPLE_TRANSFER_BASE_COST) {
      return `header.executionEnergyAmount for a transfer must be the base cost ${SIMPLE_TRANSFER_BASE_COST} (C_t), not a total — got ${cT}`;
    }
    const toAddress = payload['toAddress'];
    if (!isValidAddress(toAddress)) return 'payload.toAddress is not a valid Concordium address';
    if (toAddress === sponsorAccount) return 'sponsor must not equal the transfer recipient';
    const amount = payload['amount'];
    if (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint') {
      return 'payload.amount must be a string, number, or bigint';
    }
    try {
      if (BigInt(amount) <= 0n) return 'payload.amount must be positive';
    } catch {
      return 'payload.amount is not a valid integer amount';
    }
    if (payloadType === 'transferWithMemo' && payload['memo'] !== undefined && typeof payload['memo'] !== 'string') {
      return 'payload.memo must be a string when present';
    }
  }

  // Signatures: the sender slot must be EMPTY (we add it); the sponsor slot
  // must also be EMPTY (the facilitator adds it later). Never overwrite.
  const signatures = txJson['signatures'];
  if (!isPlainObject(signatures)) return 'signatures is required';
  if (!isEmptySignatureMap(signatures['sender'])) {
    return 'signatures.sender must be empty — refusing to overwrite an existing sender signature';
  }
  if (!isEmptySignatureMap(signatures['sponsor'])) {
    return 'signatures.sponsor must be empty — the sponsor signs later, at the facilitator';
  }

  return null;
}

// ─── signing ──────────────────────────────────────────────────────────────

/**
 * Sign the sender part of a V1 sponsored transaction, locally.
 *
 * The `signer` is an already-constructed `AccountSigner` (built by the
 * caller from the sender's wallet export). This module never reads a key
 * file, never accepts key material, and never sends anything anywhere.
 *
 * Throws on any validation failure, on a signing failure, or when the
 * SDK-recomputed total energy exceeds the cap. On success returns the
 * signed transaction JSON (BigInt-safe), the recomputed total energy, and
 * the signing digest.
 */
export async function signSenderTransaction(
  txJson: unknown,
  signer: AccountSigner,
  opts: LocalSenderSigningOptions,
): Promise<SignedSenderTransaction> {
  const invalid = validateSenderTransaction(txJson, opts);
  if (invalid !== null) {
    throw new Error(`local sender signing refused: ${invalid}`);
  }
  if (!signer || typeof signer !== 'object') {
    throw new Error('local sender signing refused: a signer is required');
  }

  // Parse through the SDK so a malformed shape fails here, before signing.
  let signable: ReturnType<typeof Transaction.signableFromJSON>;
  try {
    signable = Transaction.signableFromJSON(txJson as never);
  } catch (e) {
    throw new Error(`local sender signing refused: malformed transaction: ${(e as Error)?.message ?? e}`);
  }
  if (signable.version !== 1) {
    throw new Error('local sender signing refused: only V1 sponsored transactions are supported');
  }

  // Recompute the total energy from the exact transaction being signed.
  // This is the energy the node will charge; it must be within the cap.
  // `getEnergyCost` returns the SDK's `Energy` class instance — unwrap it
  // to a plain bigint so callers can compare it with `===`.
  const maxEnergy = opts.maxTotalEnergy ?? DEFAULT_MAX_TOTAL_ENERGY;
  let energy: bigint;
  try {
    const rawEnergy = Transaction.getEnergyCost(signable as never);
    const unwrapped = energyToBigint(rawEnergy);
    if (unwrapped === null) {
      throw new Error('recomputed energy is not a readable energy value');
    }
    energy = unwrapped;
  } catch (e) {
    throw new Error(`local sender signing refused: cannot compute energy: ${(e as Error)?.message ?? e}`);
  }
  if (energy <= 0n) {
    throw new Error('local sender signing refused: recomputed energy is not positive');
  }
  if (energy > maxEnergy) {
    throw new Error(`local sender signing refused: recomputed energy ${energy} exceeds cap ${maxEnergy}`);
  }

  // The signing digest commits to the pre-finalized transaction (recomputed
  // energy included). Record it for diagnostics/correlation.
  let digest: string;
  try {
    const unsigned = Transaction.preFinalized(signable as never);
    digest = Buffer.from(AccountTransactionV1.signDigest(unsigned as never)).toString('hex');
  } catch (e) {
    throw new Error(`local sender signing refused: cannot compute signing digest: ${(e as Error)?.message ?? e}`);
  }

  // Sign the sender part. The SDK signs the pre-finalized digest, so the
  // signature covers the recomputed energy, not the raw C_t.
  let signed: unknown;
  try {
    signed = await Transaction.sign(signable as never, signer);
  } catch (e) {
    throw new Error(`local sender signing failed: ${(e as Error)?.message ?? e}`);
  }

  // Serialize to JSON. SDK 12 `Transaction.toJSON` returns header.nonce and
  // header.executionEnergyAmount as BigInt — convert before stringifying,
  // or JSON.stringify throws.
  let signedJson: Record<string, unknown>;
  try {
    signedJson = Transaction.toJSON(signed as never) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`local sender signing failed: cannot serialize signed transaction: ${(e as Error)?.message ?? e}`);
  }
  const signedHeader = signedJson['header'] as Record<string, unknown> | undefined;
  if (signedHeader) {
    if (typeof signedHeader['nonce'] === 'bigint') {
      signedHeader['nonce'] = Number(signedHeader['nonce']);
    }
    if (typeof signedHeader['executionEnergyAmount'] === 'bigint') {
      signedHeader['executionEnergyAmount'] = Number(signedHeader['executionEnergyAmount']);
    }
  }

  return { signedTransaction: signedJson, energy, digest };
}
