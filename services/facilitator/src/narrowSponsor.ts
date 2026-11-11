/**
 * TASK 34 — Narrow Sponsor Signer authorization boundary.
 *
 * The official SDK's `AccountSigner.sign(digest)` is a **general-purpose** digest signer: it
 * will sign any digest handed to it. The SDK does not constrain which digest may be signed.
 * This module therefore enforces authorization *before* any signing operation, and the
 * authorization request is not a raw digest.
 *
 * `authorize(request)` receives a fully validated transaction context and answers
 * `{approved: true}` only when every policy holds. A future real signer MUST call this first
 * and MUST refuse to sign when it returns `{approved: false}`.
 *
 * This task implements only a **mock/no-op authorization backend**: no signature is produced,
 * no `AccountSigner` is implemented, and no signing function is reachable.
 *
 * Fail-closed rules:
 *  - missing limits → reject
 *  - malformed / negative / non-integer / overflowing / excessive energy → reject
 *  - sponsor !== configured sponsor → reject
 *  - sponsor === sender or sponsor === recipient → reject
 *  - sender / recipient missing or invalid address → reject
 *  - wrong network, wrong version, wrong asset, duplicate digest → reject
 *  - audit write failure → reject (approval is never granted without a durable event)
 */

import { AccountAddress } from '@concordium/web-sdk';

export interface SponsorAuthorizationRequest {
  /** CAIP-2 network identity. */
  network: string;
  /** Transaction version. Only 1 (sponsored) is supported. */
  version: number;
  /** Sender account (base58check). */
  sender: string;
  /** Sponsor account (base58check). */
  sponsor: string;
  /** Payment recipient (base58check). */
  recipient: string;
  /** Asset identifier, e.g. "CCD". */
  asset: string;
  /** Amount in smallest units. */
  amount: string;
  /** Expiry, epoch seconds. */
  expiry: number;
  /** Transaction execution energy cost. */
  energy: bigint;
  /** The AgentTrust payment digest (replay key). */
  paymentDigest: string;
  // TASK 34.2 (L1): `paymentState` was removed. It was accepted but never read, and the
  // durable database row is the only authoritative source for state. Callers must not be
  // able to assert a state.
}

export type SponsorRejectionReason =
  | 'wrong_network'
  | 'wrong_version'
  | 'missing_sender'
  | 'missing_recipient'
  | 'missing_sponsor'
  | 'invalid_sender'
  | 'invalid_recipient'
  | 'invalid_sponsor'
  | 'wrong_sponsor'
  | 'sponsor_is_sender'
  | 'sponsor_is_recipient'
  | 'expired'
  | 'expiry_excessive'
  | 'missing_energy_limit'
  | 'energy_malformed'
  | 'energy_negative'
  | 'energy_overflow'
  | 'energy_exceeds_cap'
  | 'duplicate_payment'
  | 'unsupported_asset'
  | 'audit_write_failed'
  // TASK 34.2 durable-state gate reasons.
  | 'unknown_payment'
  | 'payment_not_authorizable'
  | 'transaction_hash_already_prepared'
  | 'authorization_already_recorded'
  | 'payment_digest_mismatch';

export interface SponsorAuthorizationResult {
  approved: boolean;
  reason?: SponsorRejectionReason;
  detail?: string;
}

export interface SponsorPolicy {
  /** Required CAIP-2 network. */
  network: string;
  /** Configured sponsor address. Must be a valid Concordium account. */
  sponsor: string;
  /** Maximum allowed execution energy. */
  maxEnergy: bigint;
  /** Maximum allowed expiry offset from now, seconds. */
  maxExpiryOffsetSeconds: number;
  /** Allowed asset identifiers. */
  allowedAssets: readonly string[];
  /** Policy version recorded in the audit log. */
  policyVersion: string;
}

/**
 * Validate a policy. Every field is mandatory — a missing limit fails closed.
 */
export function validatePolicy(policy: SponsorPolicy): { ok: true } | { ok: false; reason: SponsorRejectionReason; detail: string } {
  if (typeof policy.network !== 'string' || policy.network.trim() === '') {
    return { ok: false, reason: 'wrong_network', detail: 'network must be a non-empty string' };
  }
  if (typeof policy.sponsor !== 'string' || policy.sponsor.trim() === '') {
    return { ok: false, reason: 'missing_sponsor', detail: 'sponsor is required' };
  }
  if (typeof policy.maxEnergy !== 'bigint') {
    return { ok: false, reason: 'missing_energy_limit', detail: 'maxEnergy must be a bigint' };
  }
  if (policy.maxEnergy <= 0n) {
    return { ok: false, reason: 'energy_negative', detail: `maxEnergy must be positive, got ${policy.maxEnergy}` };
  }
  if (!Number.isSafeInteger(policy.maxExpiryOffsetSeconds) || policy.maxExpiryOffsetSeconds <= 0) {
    return { ok: false, reason: 'expiry_excessive', detail: 'maxExpiryOffsetSeconds must be a positive safe integer' };
  }
  if (!Array.isArray(policy.allowedAssets) || policy.allowedAssets.length === 0) {
    return { ok: false, reason: 'unsupported_asset', detail: 'allowedAssets must be a non-empty array' };
  }
  try {
    AccountAddress.fromBase58(policy.sponsor);
  } catch {
    return { ok: false, reason: 'invalid_sponsor', detail: 'policy sponsor is not a valid Concordium address' };
  }
  return { ok: true };
}

/**
 * The narrow authorization interface. A future signer implements this; the SDK's general
 * `AccountSigner` is deliberately NOT part of this contract.
 */
export interface NarrowSponsorSigner {
  readonly policyVersion: string;
  authorize(request: SponsorAuthorizationRequest): Promise<SponsorAuthorizationResult>;
}

/** Pure authorization decision. No I/O — the caller persists the audit event. */
export function decideAuthorization(
  request: SponsorAuthorizationRequest,
  policy: SponsorPolicy,
  nowSec: number,
): SponsorAuthorizationResult {
  // Policy first: an unusable policy can authorize nothing.
  const policyCheck = validatePolicy(policy);
  if (!policyCheck.ok) return { approved: false, reason: policyCheck.reason, detail: policyCheck.detail };

  if (request.network !== policy.network) {
    return { approved: false, reason: 'wrong_network', detail: `request network ${request.network} != policy ${policy.network}` };
  }
  if (request.version !== 1) {
    return { approved: false, reason: 'wrong_version', detail: `version ${request.version} is not sponsored V1` };
  }
  if (!policy.allowedAssets.includes(request.asset)) {
    return { approved: false, reason: 'unsupported_asset', detail: `asset ${request.asset} not allowed` };
  }

  // Addresses: presence, then canonical validity.
  if (typeof request.sender !== 'string' || request.sender.trim() === '') {
    return { approved: false, reason: 'missing_sender', detail: 'sender is required' };
  }
  if (typeof request.recipient !== 'string' || request.recipient.trim() === '') {
    return { approved: false, reason: 'missing_recipient', detail: 'recipient is required' };
  }
  if (typeof request.sponsor !== 'string' || request.sponsor.trim() === '') {
    return { approved: false, reason: 'missing_sponsor', detail: 'sponsor is required' };
  }

  let senderAddr: AccountAddress.Type;
  let recipientAddr: AccountAddress.Type;
  let sponsorAddr: AccountAddress.Type;
  try { senderAddr = AccountAddress.fromBase58(request.sender); } catch { return { approved: false, reason: 'invalid_sender', detail: 'sender is not a valid Concordium address' }; }
  try { recipientAddr = AccountAddress.fromBase58(request.recipient); } catch { return { approved: false, reason: 'invalid_recipient', detail: 'recipient is not a valid Concordium address' }; }
  try { sponsorAddr = AccountAddress.fromBase58(request.sponsor); } catch { return { approved: false, reason: 'invalid_sponsor', detail: 'sponsor is not a valid Concordium address' }; }

  // Canonical comparison, not string comparison: base58check has one canonical form, but
  // normalise explicitly so a case/whitespace variant cannot slip through.
  const senderCanon = senderAddr.address;
  const recipientCanon = recipientAddr.address;
  const sponsorCanon = sponsorAddr.address;

  if (sponsorCanon !== policy.sponsor) {
    return { approved: false, reason: 'wrong_sponsor', detail: `sponsor ${sponsorCanon} != configured ${policy.sponsor}` };
  }
  if (sponsorCanon === senderCanon) {
    return { approved: false, reason: 'sponsor_is_sender', detail: 'sponsor must not be the sender' };
  }
  if (sponsorCanon === recipientCanon) {
    return { approved: false, reason: 'sponsor_is_recipient', detail: 'sponsor must not be the payment recipient' };
  }

  // Expiry.
  if (!Number.isSafeInteger(request.expiry)) {
    return { approved: false, reason: 'expired', detail: `expiry ${String(request.expiry)} is not a safe integer` };
  }
  if (request.expiry <= nowSec) {
    return { approved: false, reason: 'expired', detail: `expiry ${request.expiry} <= now ${nowSec}` };
  }
  if (request.expiry > nowSec + policy.maxExpiryOffsetSeconds) {
    return { approved: false, reason: 'expiry_excessive', detail: `expiry ${request.expiry} exceeds now+${policy.maxExpiryOffsetSeconds}` };
  }

  // Energy: type, sign, overflow, cap.
  if (typeof request.energy !== 'bigint') {
    return { approved: false, reason: 'energy_malformed', detail: `energy must be a bigint, got ${typeof request.energy}` };
  }
  if (request.energy <= 0n) {
    return { approved: false, reason: 'energy_negative', detail: `energy ${request.energy} is not positive` };
  }
  // Overflow guard: energy must fit in a signed 64-bit transaction energy field.
  if (request.energy > 0x7fffffffffffffffn) {
    return { approved: false, reason: 'energy_overflow', detail: `energy ${request.energy} exceeds int64 range` };
  }
  if (request.energy > policy.maxEnergy) {
    return { approved: false, reason: 'energy_exceeds_cap', detail: `energy ${request.energy} > cap ${policy.maxEnergy}` };
  }

  return { approved: true };
}
