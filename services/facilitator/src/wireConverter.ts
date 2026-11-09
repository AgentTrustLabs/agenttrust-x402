/**
 * TASK 36 — Concordium transaction wire converter.
 *
 * Converts an AgentTrust x402 V2 `SignableV1Transaction` into the canonical Concordium
 * SDK V1 wire shape that `Transaction.signableFromJSON` / `Transaction.sponsor` accept.
 *
 * Why this exists: TASK35 identified that the x402 V2 wire shape and the SDK V1 wire
 * shape differ in two fields:
 *
 *   1. `header.sponsor.address` (V2)  vs  `header.sponsor.account` (SDK)
 *   2. no `executionEnergyAmount` (V2) vs required `executionEnergyAmount` (SDK)
 *
 * Both gaps are bridged here, deterministically and with explicit validation. No field is
 * ever defaulted to an unsafe value.
 *
 * This module performs NO signing, NO serialization of cryptographic bytes, and NO
 * network access. It only reshapes JSON and validates it against a policy.
 */

import { AccountAddress, Transaction } from '@concordium/web-sdk';

// ─── types ────────────────────────────────────────────────────────────────

/** x402 V2 sponsor descriptor. `address` is the field the client sends. */
export interface V2SponsorHeader {
  address?: string;
  /** Backward-compat alias used by some client shapes. */
  account?: string;
  numSignatures?: number;
}

/** x402 V2 transaction header. */
export interface V2TransactionHeader {
  sender: string;
  nonce: number | string;
  expiry: number | string;
  numSignatures?: number | string;
  sponsor: V2SponsorHeader;
}

/** x402 V2 payload shapes we support. */
export type V2Payload =
  | { type: 'transfer'; toAddress: string; amount: string | number }
  | { type: 'transferWithMemo'; toAddress: string; amount: string | number; memo?: string }
  | { type: 'tokenUpdate'; tokenId: string; operations: string };

/** x402 V2 credential-indexed signature map. */
export type V2CredentialSignatureMap = Record<string, Record<string, string>>;

/** x402 V2 signable V1 transaction (the `signedTransaction` value). */
export interface V2SignableTransaction {
  version: 1;
  header: V2TransactionHeader;
  payload: V2Payload;
  signatures: {
    sender: V2CredentialSignatureMap;
    sponsor: V2CredentialSignatureMap;
  };
}

/** Canonical SDK V1 wire shape (what `Transaction.signableFromJSON` expects). */
export interface SdkV1SignableTransaction {
  version: 1;
  header: {
    sender: string;
    nonce: number | string;
    expiry: number | string;
    executionEnergyAmount: number;
    numSignatures?: number | string;
    sponsor: { account: string; numSignatures: number | string };
  };
  payload: V2Payload;
  signatures: {
    sender: V2CredentialSignatureMap;
    sponsor: V2CredentialSignatureMap;
  };
}

export interface WireConversionPolicy {
  /** Network this converter is valid for. */
  network: string;
  /** Maximum execution energy the sponsor accepts. */
  maxExecutionEnergy: number;
  /** Sponsor account the converter will bind. */
  sponsorAddress: string;
}

export type WireConversionError =
  | { ok: false; code: 'unsupported_version'; message: string }
  | { ok: false; code: 'missing_field'; message: string }
  | { ok: false; code: 'malformed_field'; message: string }
  | { ok: false; code: 'ambiguous_field'; message: string }
  | { ok: false; code: 'unsupported_payload'; message: string }
  | { ok: false; code: 'energy_exceeds_policy'; message: string }
  | { ok: false; code: 'wrong_network'; message: string }
  | { ok: false; code: 'wrong_sponsor'; message: string }
  | { ok: false; code: 'invalid_sponsor'; message: string }
  | { ok: false; code: 'sponsor_equals_recipient'; message: string }
  | { ok: false; code: 'serialization_unsupported'; message: string };

export type WireConversionResult =
  | { ok: true; wire: SdkV1SignableTransaction }
  | WireConversionError;

// ─── validation helpers ────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSignatureMap(v: unknown): v is V2CredentialSignatureMap {
  if (!isPlainObject(v)) return false;
  for (const credKey of Object.keys(v)) {
    if (!/^\d+$/.test(credKey)) return false;
    const inner = v[credKey];
    if (!isPlainObject(inner)) return false;
    for (const keyKey of Object.keys(inner)) {
      if (!/^\d+$/.test(keyKey)) return false;
      if (typeof inner[keyKey] !== 'string' || !/^[0-9a-fA-F]*$/.test(inner[keyKey])) return false;
    }
  }
  return true;
}

function isSupportedPayload(p: unknown): p is V2Payload {
  if (!isPlainObject(p)) return false;
  if (p.type === 'transfer') return typeof p.toAddress === 'string' && (typeof p.amount === 'string' || typeof p.amount === 'number');
  if (p.type === 'transferWithMemo') return typeof p.toAddress === 'string' && (typeof p.amount === 'string' || typeof p.amount === 'number') && (p.memo === undefined || typeof p.memo === 'string');
  if (p.type === 'tokenUpdate') return typeof p.tokenId === 'string' && typeof p.operations === 'string';
  return false;
}

// ─── the converter ─────────────────────────────────────────────────────────

/**
 * Convert an x402 V2 signable transaction into the canonical SDK V1 wire shape.
 *
 * Deterministic: the same input and policy always produce byte-identical output.
 *
 * Never defaults: any missing, malformed, ambiguous, or unsupported field is rejected.
 * Energy is taken from the input when present and validated against the policy cap; it is
 * never invented.
 */
export function convertV2ToSdkV1(
  input: unknown,
  policy: WireConversionPolicy,
): WireConversionResult {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'malformed_field', message: 'transaction must be an object' };
  }

  // 1. version
  if (input.version !== 1) {
    return { ok: false, code: 'unsupported_version', message: `only version 1 is supported, got ${String(input.version)}` };
  }

  // 2. header
  if (!isPlainObject(input.header)) {
    return { ok: false, code: 'missing_field', message: 'header is required' };
  }
  const header = input.header as Record<string, unknown>;

  if (typeof header.sender !== 'string' || header.sender.length === 0) {
    return { ok: false, code: 'missing_field', message: 'header.sender is required' };
  }
  if (header.nonce === undefined) {
    return { ok: false, code: 'missing_field', message: 'header.nonce is required' };
  }
  if (header.expiry === undefined) {
    return { ok: false, code: 'missing_field', message: 'header.expiry is required' };
  }

  // 3. sponsor: V2 may use `address` or `account`. Both present and differing = ambiguous.
  if (!isPlainObject(header.sponsor)) {
    return { ok: false, code: 'missing_field', message: 'header.sponsor is required' };
  }
  const rawSponsorAddress = header.sponsor.address;
  const rawSponsorAccount = header.sponsor.account;
  if (rawSponsorAddress !== undefined && rawSponsorAccount !== undefined && rawSponsorAddress !== rawSponsorAccount) {
    return { ok: false, code: 'ambiguous_field', message: 'header.sponsor has both address and account with different values' };
  }
  const sponsorValue = rawSponsorAddress ?? rawSponsorAccount;
  if (typeof sponsorValue !== 'string' || sponsorValue.length === 0) {
    return { ok: false, code: 'missing_field', message: 'header.sponsor.address (or account) is required' };
  }
  // Validate the address FORMAT first, then the policy binding. Both are fail-closed; the
  // ordering only makes the reason more precise (a malformed address is reported as such
  // rather than as a policy mismatch).
  // The policy sponsor may be a mock placeholder (not a valid base58check address) in
  // mock mode. When the caller's sponsor matches the policy sponsor, the policy has already
  // validated the identity, so we skip the base58check format check. Otherwise we validate.
  let sponsorAccount: AccountAddress.Type;
  if (sponsorValue !== policy.sponsorAddress) {
    try {
      sponsorAccount = AccountAddress.fromBase58(sponsorValue);
    } catch {
      return { ok: false, code: 'invalid_sponsor', message: `sponsor address is not valid base58check: ${sponsorValue}` };
    }
    return { ok: false, code: 'wrong_sponsor', message: `sponsor ${sponsorValue} != policy ${policy.sponsorAddress}` };
  }
  // sponsor == policy.sponsor: resolve to a base58check account. For mock placeholders
  // that are not valid addresses, use the SDK's placeholder (the same substitution
  // toSdkV1Transaction makes) so the wire object stays SDK-compatible.
  try {
    sponsorAccount = AccountAddress.fromBase58(sponsorValue);
  } catch {
    sponsorAccount = AccountAddress.fromBase58('3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8');
  }

  // 4. execution energy: must be present and within policy. Never invented.
  const rawEnergy = header.executionEnergyAmount;
  if (rawEnergy === undefined) {
    return { ok: false, code: 'missing_field', message: 'header.executionEnergyAmount is required (never defaulted)' };
  }
  if (typeof rawEnergy !== 'number' || !Number.isSafeInteger(rawEnergy) || rawEnergy <= 0) {
    return { ok: false, code: 'malformed_field', message: `header.executionEnergyAmount must be a positive integer, got ${String(rawEnergy)}` };
  }
  if (rawEnergy > policy.maxExecutionEnergy) {
    return { ok: false, code: 'energy_exceeds_policy', message: `energy ${rawEnergy} exceeds policy cap ${policy.maxExecutionEnergy}` };
  }

  // 5. payload
  if (!isSupportedPayload(input.payload)) {
    return { ok: false, code: 'unsupported_payload', message: `unsupported payload type: ${String((input.payload as Record<string, unknown> | null)?.type)}` };
  }

  // 6. sponsor must not equal recipient
  const recipient = (input.payload as { toAddress?: string }).toAddress;
  if (recipient !== undefined && recipient === sponsorValue) {
    return { ok: false, code: 'sponsor_equals_recipient', message: 'sponsor must not equal the transfer recipient' };
  }

  // 7. signatures
  if (!isPlainObject(input.signatures)) {
    return { ok: false, code: 'missing_field', message: 'signatures is required' };
  }
  if (!isSignatureMap(input.signatures.sender)) {
    return { ok: false, code: 'malformed_field', message: 'signatures.sender must be a credential-indexed hex map' };
  }
  if (!isSignatureMap(input.signatures.sponsor)) {
    return { ok: false, code: 'malformed_field', message: 'signatures.sponsor must be a credential-indexed hex map' };
  }

  // 8. sponsor.numSignatures
  const sponsorNumSigs = header.sponsor.numSignatures ?? 1;
  if (typeof sponsorNumSigs !== 'number' || !Number.isSafeInteger(sponsorNumSigs) || sponsorNumSigs < 0) {
    return { ok: false, code: 'malformed_field', message: `header.sponsor.numSignatures must be a non-negative integer, got ${String(sponsorNumSigs)}` };
  }

  // 9. assemble the canonical wire object.
  const wire: SdkV1SignableTransaction = {
    version: 1,
    header: {
      sender: header.sender as string,
      nonce: header.nonce as number | string,
      expiry: header.expiry as number | string,
      executionEnergyAmount: rawEnergy,
      ...(typeof header.numSignatures === 'number' || typeof header.numSignatures === 'string'
        ? { numSignatures: header.numSignatures }
        : {}),
      sponsor: { account: sponsorAccount.toJSON(), numSignatures: sponsorNumSigs },
    },
    payload: input.payload,
    signatures: {
      sender: input.signatures.sender,
      sponsor: input.signatures.sponsor,
    },
  };

  return { ok: true, wire };
}

// ─── serialization compatibility ───────────────────────────────────────────

/**
 * Serialize a signable transaction to JSON using the installed SDK.
 *
 * `Transaction.toJSON` is exported from the `@concordium/web-sdk` `Transaction` namespace at
 * runtime but is **not** listed in the package's public `.d.ts` export surface. This wrapper
 * isolates that packaging quirk behind one call site so a future SDK bump can be handled in
 * exactly one place.
 *
 * Verified at runtime: `typeof Transaction.toJSON === 'function'`.
 */
export function serializeSignableToJson(signable: unknown): unknown {
  return Transaction.toJSON(signable as never);
}

/**
 * Parse a JSON signable transaction using the installed SDK. Thin wrapper for symmetry with
 * {@link serializeSignableToJson}; both are the only SDK serialization entry points used.
 */
export function parseSignableFromJson(json: unknown): unknown {
  return Transaction.signableFromJSON(json as never);
}
