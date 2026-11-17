/**
 * Signing service — IPC server + client for the Ed25519 sponsor signer.
 *
 * A separate service that holds an injected `AccountSigner` and exposes signing over a
 * narrow IPC contract. The facilitator never sees the signer or its key material; it
 * talks to this service through `IpcAccountSigner`, which implements the SDK's
 * `AccountSigner` interface.
 *
 * Security invariant (protocol v2): **the digest is never trusted on its own.**
 * Every sign request carries the full signable V1 transaction, and the service
 * recomputes the digest from that transaction (`Transaction.signableFromJSON` →
 * `Transaction.preFinalized` → `AccountTransactionV1.signDigest`) and compares it
 * with the requested digest before signing anything. Every field the service
 * validates — sponsor, sender, recipient, amount, energy, fee, expiry — is read
 * from the PARSED transaction, so the validated properties are, by construction,
 * properties of the transaction whose digest gets signed. The service signs the
 * RECOMPUTED digest, never the caller-supplied one.
 *
 * Transfer-family validation covers BOTH transfer kinds the SDK can parse:
 * `Transfer` and `TransferWithMemo` (same recipient + amount checks; the memo
 * itself is opaque bytes committed by the digest). Every other transfer-family
 * kind the protocol defines (`TransferWithSchedule`, `EncryptedAmountTransfer`,
 * `TransferToEncrypted`, `TransferToPublic`, `EncryptedAmountTransferWithMemo`,
 * `TransferWithScheduleAndMemo`) is NOT parseable by the installed SDK's
 * `Payload.fromJSON` — `signableFromJSON` throws for them — so they are
 * rejected as `invalid_transaction`, never silently accepted. Non-transfer
 * payloads (DeployModule, InitContract, Update, UpdateCredentials, RegisterData,
 * ConfigureDelegation, ConfigureBaker, TokenUpdate) carry no recipient/amount
 * and pass this block by design; they still face the sponsor/sender/energy/
 * fee/expiry checks.
 *
 * Fee check is an ESTIMATE-based policy, not a guaranteed maximum actual fee:
 * the fee estimate is recomputed energy x `ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG`
 * (see `energy.ts` for why no actual-fee guarantee is provable at this boundary).
 * Energy caps are NOT weakened by this: the energy cap binds the recomputed
 * energy directly, independent of the fee estimate.
 *
 * Replay handling is concurrency-safe: a requestId/fingerprint is RESERVED in the
 * replay map (as a pending entry holding the in-flight promise) synchronously,
 * before any asynchronous signing begins. A concurrent duplicate with the same
 * fingerprint awaits the original result instead of signing twice; a concurrent
 * duplicate with a different fingerprint is rejected with `request_id_reuse`
 * without waiting. Completed entries return the original result; a signing
 * failure is stored as a deterministic rejection, so a retry returns the same
 * rejection and never re-signs. The pending promise is never rejected (every
 * failure path resolves to a `SigningResponse`), so there are no unhandled
 * rejections and no lock to deadlock on — the map entry is the only shared
 * state, and it transitions pending → done exactly once.
 *
 * What this does NOT prove (honest residual, inherent to the architecture):
 * - It does not prove "the Owner authorized THIS transaction" by itself —
 *   that is what the  authorization certificate + consume step prove
 *   (see `ownerAuthorization.ts`): the request must carry an Owner-signed
 *   certificate binding the exact transaction, and the service consumes that
 *   authorization at the Owner before signing. What remains assumed, not
 *   proven here: the Owner's private key is readable only by the Owner's UID
 *   (distinct from the facilitator's), and the consume channel really reaches
 *   the Owner (client-side SO_PEERCRED on the Owner socket).
 * - The network is a config-equality check (`req.network === opts.network`), NOT
 *   cryptographically bound: the sponsor digest commits to expiry, sender, nonce,
 *   payload size, recomputed energy, sponsor, and the full payload, but NOT to the
 *   network/genesis. A wrong-network transaction would be rejected by the node at
 *   submission, not by this service. (The certificate DOES bind the network
 *   the Owner authorized, so a wrong-network certificate fails the binding.)
 *
 * Protocol v3 : every sign request MUST carry an Owner authorization
 * certificate (`authorization`) and the payment digest it belongs to
 * (`paymentDigest`). The service verifies the certificate's signature against
 * the Owner's configured public key, compares every bound field against the
 * parsed transaction, and consumes the authorization at the Owner before
 * signing. A v2 request (no certificate) is rejected as
 * `unsupported_protocol`, and a request carrying a `context` key is rejected
 * as `malformed_request`: metadata the signer cannot verify must not travel
 * with the request at all. Protocol v1 (digest-only) is likewise gone.
 *
 * Process boundary: the facilitator (uid 1001, gid 1002 `authclients`) connects
 * over a Unix socket; the service enforces the peer uid via `SO_PEERCRED`
 * (`scripts/authz-peercred`). The service does NOT re-check the client's uid —
 * the kernel does that at connect time.
 *
 * Test-only: `createFakeSigner` generates an ephemeral keypair in-process.
 * No sponsor key, no wallet, no funding, no broadcast, no settlement.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { lstatSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sign as edSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { AccountAddress, AccountTransactionType, Transaction } from '@concordium/web-sdk';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import type { AccountSigner, AccountTransactionSignature } from '@concordium/web-sdk';
import { ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG } from './energy.js';
import {
  loadOwnerAuthorizationPublicKey,
  verifyOwnerAuthorizationCertificate,
  type OwnerAuthorizationCertificate,
  type OwnerConsumeClient,
} from './ownerAuthorization.js';

// ─── protocol ─────────────────────────────────────────────────────────────

export const SIGNING_PROTOCOL_VERSION = 3;
export const SIGNING_MAX_MSG = 64 * 1024;

/**
 * Default caps, mirroring the facilitator config defaults (`config.ts`:
 * `FACILITATOR_MAX_ENERGY` / `FACILITATOR_MAX_FEE_MICROCCD`). The production
 * launcher passes explicit values; these defaults keep standalone harnesses and
 * tests safe when no caps are given.
 */
export const DEFAULT_SIGNING_MAX_ENERGY = 1000n;
export const DEFAULT_SIGNING_MAX_FEE_MICROCCD = 10_000_000n;

export interface SigningRequest {
  protocolVersion: number;
  requestId: string;
  operation: 'sign';
  digest: string; // 64-char hex (32 bytes)
  /**
   * The signable V1 transaction whose digest MUST equal `digest`. REQUIRED.
   * The service parses it, recomputes the digest from it, and validates every
   * field from the parsed form. A request without a transaction is rejected.
   */
  transaction: unknown;
  sponsor: string; // base58check sponsor address
  network: string; // CAIP-2
  /**
   * the Owner's authorization certificate for the exact
   * transaction. REQUIRED. The service verifies its signature against the
   * Owner's configured public key and compares every bound field against
   * the parsed transaction before signing anything. A request without a
   * certificate is rejected: the service never signs on a caller's bare
   * claim that the Owner approved.
   */
  authorization: unknown;
  /**
   * the AgentTrust payment digest the authorization belongs to.
   * REQUIRED, 64-hex. The service requires the certificate's paymentDigest
   * to equal it, so a certificate issued for one payment cannot authorize
   * a transaction for another.
   */
  paymentDigest: string;
}

export interface SigningResponse {
  protocolVersion: number;
  requestId: string;
  outcome: 'signed' | 'rejected' | 'unknown' | 'owner_unavailable' | 'protocol_error';
  signature: AccountTransactionSignature | null;
  reason: string | null;
  detail: string | null;
}

// ─── validation ────────────────────────────────────────────────────────────

const FORBIDDEN = new Set(['decision', 'approved', 'outcome', 'reason', 'result', 'signature']);
const REQ_ALLOWED = new Set(['protocolVersion', 'requestId', 'operation', 'digest', 'sponsor', 'network', 'transaction', 'authorization', 'paymentDigest']);

export function validateSigningRequest(req: unknown): { ok: true; value: SigningRequest } | { ok: false; reason: string } {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { ok: false, reason: 'malformed_request' };
  }
  const r = req as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
    if (!REQ_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
  }
  if (typeof r.protocolVersion !== 'number' || r.protocolVersion !== SIGNING_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  if (typeof r.requestId !== 'string' || r.requestId.length < 1 || r.requestId.length > 128) {
    return { ok: false, reason: 'invalid_field' };
  }
  if (r.operation !== 'sign') return { ok: false, reason: 'unknown_operation' };
  if (typeof r.digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.digest)) {
    return { ok: false, reason: 'invalid_digest' };
  }
  if (r.transaction === undefined) {
    return { ok: false, reason: 'missing_transaction' };
  }
  if (
    typeof r.transaction !== 'object' ||
    r.transaction === null ||
    Array.isArray(r.transaction)
  ) {
    return { ok: false, reason: 'invalid_transaction' };
  }
  if (typeof r.sponsor !== 'string' || r.sponsor.length === 0) {
    return { ok: false, reason: 'invalid_sponsor' };
  }
  if (typeof r.network !== 'string' || r.network.length === 0) {
    return { ok: false, reason: 'invalid_network' };
  }
  // the authorization certificate is REQUIRED. Its signature and
  // field binding are verified in runSign, after the transaction binding;
  // here the request is rejected early if the evidence is absent entirely.
  if (r.authorization === undefined) {
    return { ok: false, reason: 'authorization_missing' };
  }
  if (typeof r.authorization !== 'object' || r.authorization === null || Array.isArray(r.authorization)) {
    return { ok: false, reason: 'authorization_invalid' };
  }
  if (typeof r.paymentDigest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.paymentDigest)) {
    return { ok: false, reason: 'invalid_field' };
  }
  return { ok: true, value: r as unknown as SigningRequest };
}

// ─── digest ↔ transaction binding ──────────────────────────────────────────

/**
 * Recompute the sponsor sign digest of a signable V1 transaction JSON.
 * Throws on malformed input. This is the digest the service MUST sign: the
 * caller-supplied digest is compared against it and rejected on mismatch.
 * The digest commits to expiry, sender, nonce, payload size, RECOMPUTED energy
 * (the header's claimed energy is ignored by `preFinalized`), sponsor, and the
 * full payload (recipient + amount for transfers).
 */
export function signingDigestOf(transaction: unknown): string {
  const signable = Transaction.signableFromJSON(transaction);
  if (signable.version !== 1) {
    throw new Error('only V1 transactions can be sponsor-signed');
  }
  const unsigned = Transaction.preFinalized(signable);
  const digest = AccountTransactionV1.signDigest(unsigned);
  return Buffer.from(digest).toString('hex');
}

/**
 * Recompute the execution energy (NRG) of a signable V1 transaction JSON —
 * the same value the signing service enforces (`preFinalized` + the
 * unsigned header's energy amount). Returns null when the transaction
 * cannot be parsed or carries no energy.
 *
 * the facilitator MUST authorize (and fee) on THIS value, not on
 * `deriveEnergyExposure`'s JSON-length estimate. The two disagree (596 vs
 * 635 NRG for the standard transfer: the estimate counts only the header's
 * signature count and measures the payload as JSON text, while the chain
 * counts both signature slots and the binary payload size), and the
 * certificate must bind the energy the signing service actually enforces.
 * Authorizing on the estimate would make every real settlement fail the
 * certificate check — and would understate the fee the sponsor pays.
 */
export function transactionEnergyOf(transaction: unknown): bigint | null {
  let signable: ReturnType<typeof Transaction.signableFromJSON>;
  try {
    signable = Transaction.signableFromJSON(transaction);
  } catch {
    return null;
  }
  if (signable.version !== 1) return null;
  let unsigned: ReturnType<typeof Transaction.preFinalized>;
  try {
    unsigned = Transaction.preFinalized(signable);
  } catch {
    return null;
  }
  return energyOf(unsigned.header.energyAmount);
}

/** Canonical base58 of an address string or an AccountAddress object, or null if invalid. */
function canonicalAddress(value: unknown): string | null {
  try {
    if (typeof value === 'string') {
      return AccountAddress.toBase58(AccountAddress.fromBase58(value));
    }
    if (value && typeof value === 'object' && AccountAddress.instanceOf(value)) {
      return AccountAddress.toBase58(value);
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract a bigint amount from a parsed transfer payload, or null if absent/unparseable. */
function amountOf(payload: unknown): bigint | null {
  const p = payload as { amount?: unknown } | null;
  if (!p || typeof p !== 'object') return null;
  const a = p.amount;
  if (a === undefined) return null;
  if (typeof a === 'bigint') return a;
  if (typeof a === 'string' || typeof a === 'number') {
    try {
      return BigInt(a);
    } catch {
      return null;
    }
  }
  if (typeof a === 'object' && a !== null) {
    const m = (a as { microCcdAmount?: unknown }).microCcdAmount;
    if (typeof m === 'bigint') return m;
    if (typeof m === 'string' || typeof m === 'number') {
      try {
        return BigInt(m);
      } catch {
        return null;
      }
    }
    const toJson = (a as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      try {
        const j = (toJson as () => unknown).call(a);
        if (typeof j === 'string' || typeof j === 'number') return BigInt(j);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Extract the recomputed energy (bigint NRG) from an unsigned header, or null. */
function energyOf(value: unknown): bigint | null {
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

/** Extract the expiry epoch (seconds) from an unsigned header, or null. */
function expiryOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    const s = (value as { expiryEpochSeconds?: unknown }).expiryEpochSeconds;
    if (typeof s === 'bigint') return s;
    if (typeof s === 'string' || typeof s === 'number') {
      try {
        return BigInt(s);
      } catch {
        return null;
      }
    }
  }
  return null;
}

type BindingCheck =
  | {
      ok: true;
      digest: string;
      energy: bigint;
      estimatedFeeMicroCcd: bigint;
      /** Parsed fields, for the authorization-certificate binding . */
      sender: string;
      sponsor: string;
      /** Transfer-family recipient, or null for non-transfer payloads. */
      recipient: string | null;
      /** Transfer-family amount (microCCD), or null for non-transfer payloads. */
      amount: bigint | null;
      /** Raw payload type string from the transaction JSON, e.g. 'transfer'. */
      transactionType: string;
      /** Transaction expiry, epoch seconds. */
      expiry: bigint;
    }
  | { ok: false; reason: string; detail: string };

/**
 * Transfer-family payload kinds, as parsed by the SDK. Both carry a
 * `toAddress` recipient and a CCD `amount`, so both get the same signing-
 * boundary validation. Any other transfer-family kind cannot be parsed by
 * `Transaction.signableFromJSON` at all (the SDK's `Payload.fromJSON` switch
 * has no case for it) and therefore fails earlier, as `invalid_transaction`.
 */
const TRANSFER_FAMILY_TYPES: ReadonlySet<AccountTransactionType> = new Set([
  AccountTransactionType.Transfer,
  AccountTransactionType.TransferWithMemo,
]);

/**
 * Validate that the requested digest is the hash of the given transaction, and
 * that the transaction's own fields satisfy the signing policy. Every field is
 * read from the PARSED transaction — never from request metadata — so the
 * validated properties are, by construction, properties of the transaction
 * whose digest gets signed.
 */
function checkTransactionBinding(
  req: SigningRequest,
  opts: SigningServiceOptions,
  nowMs: number,
): BindingCheck {
  let signable: ReturnType<typeof Transaction.signableFromJSON>;
  try {
    signable = Transaction.signableFromJSON(req.transaction);
  } catch {
    return { ok: false, reason: 'invalid_transaction', detail: 'transaction is not a valid signable V1 transaction' };
  }
  if (signable.version !== 1) {
    return { ok: false, reason: 'invalid_transaction', detail: 'only V1 transactions can be sponsor-signed' };
  }
  let unsigned: ReturnType<typeof Transaction.preFinalized>;
  let digest: string;
  try {
    unsigned = Transaction.preFinalized(signable);
    digest = Buffer.from(AccountTransactionV1.signDigest(unsigned)).toString('hex');
  } catch {
    return { ok: false, reason: 'invalid_transaction', detail: 'transaction cannot be finalized for signing' };
  }
  if (digest !== req.digest.toLowerCase()) {
    return { ok: false, reason: 'digest_mismatch', detail: 'digest does not match the transaction' };
  }
  // Sponsor — from the transaction itself, never from the request metadata.
  const sponsorAddr = canonicalAddress(unsigned.header.sponsor);
  if (sponsorAddr === null) {
    return { ok: false, reason: 'wrong_sponsor', detail: 'transaction has no sponsor' };
  }
  if (sponsorAddr !== canonicalAddress(opts.sponsorAddress)) {
    return { ok: false, reason: 'wrong_sponsor', detail: 'transaction sponsor does not match the configured sponsor' };
  }
  // Sender — present, and never the sponsor (the sponsor pays for someone else's tx).
  const senderAddr = canonicalAddress(unsigned.header.sender);
  if (senderAddr === null) {
    return { ok: false, reason: 'sender_missing', detail: 'transaction has no sender' };
  }
  if (senderAddr === sponsorAddr) {
    return { ok: false, reason: 'sender_equals_sponsor', detail: 'sender must not be the sponsor' };
  }
  // Transfer-family payloads: recipient + amount are committed by the digest;
  // validate them. Covers Transfer AND TransferWithMemo — the memo is opaque
  // bytes already committed by the digest, so it needs no separate check.
  // Non-transfer payloads have no recipient/amount and skip this block.
  let recipientAddr: string | null = null;
  let amount: bigint | null = null;
  if (TRANSFER_FAMILY_TYPES.has(signable.payload.type)) {
    const to = (signable.payload as { toAddress?: unknown }).toAddress;
    if (to === undefined) {
      return { ok: false, reason: 'recipient_missing', detail: 'transfer has no recipient' };
    }
    recipientAddr = canonicalAddress(to);
    if (recipientAddr === null) {
      return { ok: false, reason: 'recipient_malformed', detail: 'recipient is not a valid account address' };
    }
    if (recipientAddr === sponsorAddr) {
      return { ok: false, reason: 'recipient_equals_sponsor', detail: 'recipient must not be the sponsor' };
    }
    amount = amountOf(signable.payload);
    if (amount === null) {
      return { ok: false, reason: 'amount_missing', detail: 'transfer has no amount' };
    }
    if (amount <= 0n) {
      return { ok: false, reason: 'amount_invalid', detail: 'amount must be greater than zero' };
    }
  }
  // Energy — the RECOMPUTED value from the transaction, never the header claim.
  const energy = energyOf(unsigned.header.energyAmount);
  if (energy === null) {
    return { ok: false, reason: 'energy_missing', detail: 'transaction has no energy amount' };
  }
  if (energy <= 0n) {
    return { ok: false, reason: 'energy_invalid', detail: 'energy must be greater than zero' };
  }
  const maxEnergy = opts.maxEnergy ?? DEFAULT_SIGNING_MAX_ENERGY;
  if (energy > maxEnergy) {
    return { ok: false, reason: 'energy_exceeds_cap', detail: `energy ${energy} exceeds cap ${maxEnergy}` };
  }
  // Fee — ESTIMATE-based policy only (see `energy.ts`): recomputed energy x the
  // fixed estimate rate. This bounds the estimate, not the actual on-chain fee,
  // which the service cannot know at signing time. The energy cap above binds
  // the recomputed energy directly and is unaffected by the fee estimate.
  const estimatedFeeMicroCcd = energy * ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG;
  const maxFee = opts.maxFeeMicroCcd ?? DEFAULT_SIGNING_MAX_FEE_MICROCCD;
  if (estimatedFeeMicroCcd > maxFee) {
    return { ok: false, reason: 'fee_exceeds_cap', detail: `estimated fee ${estimatedFeeMicroCcd} exceeds cap ${maxFee}` };
  }
  // Expiry — the transaction must still be alive when the service signs it.
  const expiry = expiryOf(unsigned.header.expiry);
  if (expiry === null || expiry * 1000n <= BigInt(nowMs)) {
    return { ok: false, reason: 'transaction_expired', detail: 'transaction expiry is in the past' };
  }
  // Raw payload type string from the transaction JSON (e.g. 'transfer'). The
  // digest commits to the payload, so this string is bound by the digest;
  // the certificate must name exactly this type.
  const rawPayload = req.transaction as { payload?: { type?: unknown } };
  const transactionType = typeof rawPayload.payload?.type === 'string' ? rawPayload.payload.type : '';
  if (transactionType === '') {
    return { ok: false, reason: 'invalid_transaction', detail: 'transaction has no payload type' };
  }
  return {
    ok: true,
    digest,
    energy,
    estimatedFeeMicroCcd,
    sender: senderAddr,
    sponsor: sponsorAddr,
    recipient: recipientAddr,
    amount,
    transactionType,
    expiry,
  };
}

/**
 * verify the Owner authorization certificate against the parsed
 * transaction. The signature is checked first (a forged or tampered
 * certificate fails here, before any field is trusted), then every bound
 * field is compared against the transaction the service parsed and the
 * request's payment digest. A certificate that verifies but covers a
 * different transaction is a mismatch, not an approval.
 */
function checkAuthorizationBinding(
  cert: unknown,
  bound: Extract<BindingCheck, { ok: true }>,
  req: SigningRequest,
  opts: SigningServiceOptions,
  ownerPublicKey: KeyObject,
  nowMs: number,
): { ok: true; fields: OwnerAuthorizationCertificate } | { ok: false; reason: string; detail: string } {
  const v = verifyOwnerAuthorizationCertificate(cert, ownerPublicKey);
  if (!v.ok) {
    return { ok: false, reason: v.reason, detail: v.detail };
  }
  const f = v.fields;
  // The certificate must belong to this payment: a certificate issued for
  // another payment cannot authorize this transaction, even if the
  // transaction itself is identical.
  if (f.paymentDigest.toLowerCase() !== req.paymentDigest.toLowerCase()) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate paymentDigest does not match the request' };
  }
  if (f.transactionDigest.toLowerCase() !== bound.digest) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate transactionDigest does not match the transaction' };
  }
  if (f.network !== opts.network) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate network does not match the configured network' };
  }
  if (f.sender !== bound.sender) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate sender does not match the transaction' };
  }
  if (f.sponsor !== bound.sponsor) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate sponsor does not match the transaction' };
  }
  if (f.transactionType !== bound.transactionType) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate transactionType does not match the transaction' };
  }
  // Transfer-family: recipient + amount must equal the transaction's own.
  // Non-transfer payloads carry no recipient/amount in the transaction; the
  // certificate's values are checked for shape only (the Owner already
  // enforced sponsor != recipient and amount validity at issuance).
  if (bound.recipient !== null) {
    if (f.recipient !== bound.recipient) {
      return { ok: false, reason: 'authorization_mismatch', detail: 'certificate recipient does not match the transaction' };
    }
  } else if (f.recipient === f.sponsor) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate recipient equals the sponsor' };
  }
  if (bound.amount !== null) {
    if (f.amount !== bound.amount.toString()) {
      return { ok: false, reason: 'authorization_mismatch', detail: 'certificate amount does not match the transaction' };
    }
  }
  // Energy: the certificate authorizes EXACTLY the recomputed energy. A
  // transaction whose energy differs from the authorized value is a
  // different transaction for authorization purposes.
  if (f.energy !== bound.energy.toString()) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate energy does not match the transaction' };
  }
  // Fee policy: the authorized energy and the caps the authorization was
  // issued under must permit this transaction. The service still enforces
  // its own caps independently (checkTransactionBinding above).
  let maxEnergy: bigint;
  let maxFee: bigint;
  try {
    maxEnergy = BigInt(f.maxEnergy);
    maxFee = BigInt(f.maxFeeMicroCcd);
  } catch {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate energy/fee caps are not integers' };
  }
  if (bound.energy > maxEnergy) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'transaction energy exceeds the authorized energy cap' };
  }
  if (bound.estimatedFeeMicroCcd > maxFee) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'estimated fee exceeds the authorized fee cap' };
  }
  // Expiry: the certificate binds the transaction's expiry, and it must
  // still be in the future. (The Owner re-checks expiry at consumption.)
  if (f.expiry !== Number(bound.expiry)) {
    return { ok: false, reason: 'authorization_mismatch', detail: 'certificate expiry does not match the transaction' };
  }
  if (BigInt(f.expiry) * 1000n <= BigInt(nowMs)) {
    return { ok: false, reason: 'authorization_expired', detail: 'certificate expiry is in the past' };
  }
  return { ok: true, fields: { ...f, signature: (cert as OwnerAuthorizationCertificate).signature } };
}

/** Fingerprint of a request's signable content, for replay detection. */
function requestFingerprint(req: SigningRequest): string {
  return createHash('sha256')
    .update(req.digest)
    .update(JSON.stringify(req.transaction))
    .update(req.paymentDigest)
    .update(JSON.stringify(req.authorization))
    .digest('hex');
}

// ─── fake signer ────────────────────────────────────────────────────────────

export interface FakeSignerOptions {
  /** Fixed signature hex to return (deterministic). */
  signature?: string;
  /** Behaviour override. */
  behaviour?: 'sign-ok' | 'sign-throws' | 'sign-hangs';
}

export function createFakeSigner(opts: FakeSignerOptions = {}): AccountSigner {
  const sig = opts.signature ?? 'ff'.repeat(64);
  const behaviour = opts.behaviour ?? 'sign-ok';
  return {
    async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
      if (behaviour === 'sign-throws') throw new Error('fake signer: signing refused');
      if (behaviour === 'sign-hangs') await new Promise(() => {});
      return { 0: { 0: sig } } as AccountTransactionSignature;
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
}

// ─── service factory ────────────────────────────────────────────────────────

export interface SigningServiceOptions {
  /** The injected AccountSigner. Never constructed from key material by this service. */
  accountSigner: AccountSigner;
  /** Configured sponsor address (base58check). Must match every request's sponsor. */
  sponsorAddress: string;
  /** CAIP-2 network this service is bound to. */
  network: string;
  /** Allowed peer UID (SO_PEERCRED). */
  allowedUid: number;
  /** Peer-credential helper binary path. */
  peerCredBin?: string;
  /** Clock. */
  now?: () => number;
  /** Maximum energy (NRG) a signed transaction may carry. Default 1000. */
  maxEnergy?: bigint;
  /**
   * Maximum sponsor fee (microCCD) a signed transaction may cost, as an
   * ESTIMATE-based policy (recomputed energy x the fixed estimate rate — see
   * `energy.ts`). Default 10_000_000 (10 CCD). This is NOT a guaranteed maximum
   * actual chain fee: passing the estimate does not prove the on-chain fee
   * stays under the cap. The energy cap above is the hard bound.
   */
  maxFeeMicroCcd?: bigint;
  /**
   * Owner authorization verification. REQUIRED: the service cannot
   * sign without it, and `createSigningService` throws when it is absent.
   * `publicKey` is the Owner's authorization public key (SPKI DER hex or a
   * KeyObject) — the service verifies certificate signatures against it and
   * never sees the Owner's private key. `consume` is the Owner consume
   * client (real IPC or a test fake with identical atomic semantics).
   */
  ownerAuthorization: {
    publicKey: string | KeyObject;
    consume: OwnerConsumeClient;
  };
}

export interface SigningService {
  /** Start listening. Returns the socket path. */
  listen(socketPath: string): Promise<void>;
  /** Stop listening and clean up. */
  close(): Promise<void>;
  /** In-process sign (for tests that bypass IPC). */
  sign(request: SigningRequest): Promise<SigningResponse>;
}

export function createSigningService(opts: SigningServiceOptions): SigningService {
  const now = opts.now ?? (() => Date.now());
  // the Owner authorization verifier is REQUIRED. Fail closed at
  // construction: a service built without it could never verify evidence, so
  // it must not exist. The public key is parsed once, here.
  if (!opts.ownerAuthorization || typeof opts.ownerAuthorization.consume?.consume !== 'function') {
    throw new Error('createSigningService: ownerAuthorization with a consume client is required');
  }
  let ownerPublicKey: KeyObject;
  try {
    ownerPublicKey =
      typeof opts.ownerAuthorization.publicKey === 'string'
        ? loadOwnerAuthorizationPublicKey(opts.ownerAuthorization.publicKey)
        : opts.ownerAuthorization.publicKey;
  } catch (e) {
    throw new Error(`createSigningService: invalid Owner public key: ${(e as Error).message}`);
  }
  if (ownerPublicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('createSigningService: Owner public key is not Ed25519');
  }
  const ownerConsume = opts.ownerAuthorization.consume;
  /**
   * Replay store. A `pending` entry is the concurrency reservation: it is
   * written synchronously, before any `await`, so a second concurrent request
   * with the same requestId can never slip past the check and reach the
   * signer. It holds the in-flight promise so a same-content duplicate awaits
   * the original result instead of signing twice. It transitions to `done`
   * exactly once, holding the original response (including rejections — a
   * retry after a failure returns the same deterministic rejection and never
   * re-signs). Entries are never evicted in this service's lifetime; that is
   * pre-existing behavior, not a new retention policy.
   */
  type ReplayEntry =
    | { status: 'pending'; fingerprint: string; promise: Promise<SigningResponse> }
    | { status: 'done'; fingerprint: string; response: SigningResponse };
  const replay = new Map<string, ReplayEntry>();

  const peerCredOf = (conn: Socket): { uid: number; gid: number; pid: number } | null => {
    const handle = (conn as any)._handle;
    const fd = handle?.fd;
    if (typeof fd !== 'number') return null;
    const bin = opts.peerCredBin ?? `${process.cwd()}/scripts/authz-peercred`;
    try {
      const out = execFileSync(bin, ['0'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(out.trim());
      if (typeof parsed.uid !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  };

  /**
   * Binding + authorization + signing for one request. Pure work: validates
   * the digest ↔ transaction binding from the parsed transaction, verifies
   * the Owner authorization certificate against that transaction, consumes
   * the authorization at the Owner, and only then signs the recomputed
   * digest. NEVER touches the replay map — the caller (`doSign`) owns
   * reservation and storage. Always resolves to a `SigningResponse`; it must
   * never throw, so the pending reservation always transitions to `done`.
   *
   * Order matters : a rejected authorization NEVER reaches the
   * signing operation. Certificate verification and field binding run before
   * consumption, and consumption runs before signing. A consume failure
   * discards the request without signing.
   */
  const runSign = async (req: SigningRequest): Promise<SigningResponse> => {
    const rid = req.requestId;
    // Digest ↔ transaction binding + field validation, from the parsed transaction.
    const bound = checkTransactionBinding(req, opts, now());
    if (!bound.ok) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: bound.reason, detail: bound.detail };
    }
    // Owner authorization certificate: signature + every bound field, checked
    // against the parsed transaction. A forged, tampered, or mismatched
    // certificate never reaches consumption or signing.
    const authz = checkAuthorizationBinding(req.authorization, bound, req, opts, ownerPublicKey, now());
    if (!authz.ok) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: authz.reason, detail: authz.detail };
    }
    const cert = authz.fields;
    // Consume the authorization at the Owner: single-use, restart-proof,
    // revocable. Only a consumed authorization may be signed.
    let consumed: Awaited<ReturnType<OwnerConsumeClient['consume']>>;
    try {
      consumed = await ownerConsume.consume({
        authorizationId: cert.authorizationId,
        transactionDigest: bound.digest,
        context: {
          paymentDigest: cert.paymentDigest,
          network: cert.network,
          sender: cert.sender,
          sponsor: cert.sponsor,
          recipient: cert.recipient,
          asset: cert.asset,
          amount: cert.amount,
          expiry: cert.expiry,
          energy: cert.energy,
          transactionType: cert.transactionType,
          maxEnergy: cert.maxEnergy,
          maxFeeMicroCcd: cert.maxFeeMicroCcd,
        },
      });
    } catch (e) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'owner_unavailable', signature: null, reason: 'owner_unavailable', detail: `consume threw: ${(e as Error).message}` };
    }
    if (consumed.outcome === 'owner_unavailable') {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'owner_unavailable', signature: null, reason: 'owner_unavailable', detail: consumed.detail ?? 'Owner unavailable at consume time' };
    }
    if (consumed.outcome === 'protocol_error') {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'protocol_error', signature: null, reason: consumed.reason ?? 'protocol_error', detail: consumed.detail };
    }
    if (consumed.outcome !== 'consumed') {
      // 'rejected' or 'unknown': the Owner refused consumption (already
      // consumed, revoked, expired, mismatched, or no such authorization).
      // The approval is spent or invalid — never sign.
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: consumed.reason ?? 'authorization_not_consumed', detail: consumed.detail };
    }
    // Sign the RECOMPUTED digest, never the caller-supplied one. The Buffer view
    // (not `.buffer.slice`) is passed, so the signer reads exactly these 32 bytes.
    let signature: AccountTransactionSignature;
    try {
      signature = await opts.accountSigner.sign(Buffer.from(bound.digest, 'hex'));
    } catch (e) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: 'signer_error', detail: (e as Error).message };
    }
    return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'signed', signature, reason: null, detail: null };
  };

  const doSign = async (req: SigningRequest): Promise<SigningResponse> => {
    const rid = req.requestId;
    // Sponsor identity check (request metadata — the transaction's own sponsor
    // is checked again in the binding step below, from the parsed transaction).
    if (req.sponsor !== opts.sponsorAddress) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: 'wrong_sponsor', detail: `sponsor ${req.sponsor} != configured ${opts.sponsorAddress}` };
    }
    // Network check. Config equality only — NOT cryptographically bound by the
    // digest (see the header comment). A wrong-network transaction would be
    // rejected by the node at submission, not here.
    if (req.network !== opts.network) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: 'wrong_network', detail: `network ${req.network} != configured ${opts.network}` };
    }
    // Replay protection: the same requestId must carry the same signable content.
    // A reused requestId with DIFFERENT content is a protocol violation, not a replay.
    // The reservation below is synchronous — everything up to `replay.set` runs
    // without yielding — so two concurrent calls cannot both pass this check.
    const fingerprint = requestFingerprint(req);
    const prior = replay.get(rid);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'protocol_error', signature: null, reason: 'request_id_reuse', detail: 'requestId already used with different content' };
      }
      if (prior.status === 'done') {
        // Replayed request must return the original result.
        return { ...prior.response, requestId: rid };
      }
      // Same requestId + same fingerprint while the original is still in flight:
      // await the original result. Do not sign twice.
      return prior.promise;
    }
    // Reserve BEFORE any asynchronous signing begins. The entry is written
    // synchronously, so any concurrent duplicate sees it immediately.
    let resolvePending!: (r: SigningResponse) => void;
    const pending = new Promise<SigningResponse>((resolve) => {
      resolvePending = resolve;
    });
    replay.set(rid, { status: 'pending', fingerprint, promise: pending });
    let result: SigningResponse;
    try {
      result = await runSign(req);
    } catch (e) {
      // `runSign` is specified never to throw; this is defense-in-depth so a
      // surprise throw (e.g. a throwing clock) still transitions the entry to
      // `done` with a deterministic rejection instead of stranding waiters.
      result = { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: rid, outcome: 'rejected', signature: null, reason: 'signer_error', detail: (e as Error).message ?? 'signing failed' };
    }
    replay.set(rid, { status: 'done', fingerprint, response: result });
    resolvePending(result);
    return result;
  };

  let server: ReturnType<typeof createServer> | null = null;

  return {
    async listen(socketPath: string): Promise<void> {
      // A crashed predecessor leaves its socket file behind; replace a
      // STALE socket before listening, the way the Owner launchers do
      // (scripts/authz-owner.mts): a socket file is removed, anything else
      // at the path (symlink, regular file) refuses startup instead of
      // being unlinked. Without this, restart after a crash fails
      // EADDRINUSE and the stale file keeps refusing every new client.
      let st: ReturnType<typeof lstatSync> | null = null;
      try { st = lstatSync(socketPath); } catch { st = null; }
      if (st !== null) {
        if (!st.isSocket()) throw new Error(`refusing to listen: ${socketPath} exists and is not a socket`);
        try { unlinkSync(socketPath); } catch { /* listen below reports */ }
      }
      return new Promise<void>((resolve, reject) => {
        server = createServer((conn) => {
          let buf = '';
          let bytes = 0;
          const idleTimer = setTimeout(() => conn.destroy(), 30_000);
          conn.on('data', async (chunk) => {
            bytes += chunk.length;
            if (bytes > SIGNING_MAX_MSG) {
              conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: null, outcome: 'protocol_error', reason: 'message_too_large', signature: null, detail: null }) + '\n');
              conn.destroy();
              return;
            }
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              let req: unknown;
              try {
                req = JSON.parse(line);
              } catch {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: null, outcome: 'protocol_error', reason: 'malformed_request', signature: null, detail: null }) + '\n');
                continue;
              }
              // peer auth
              const peer = peerCredOf(conn);
              if (!peer || peer.uid !== opts.allowedUid || peer.uid === 0) {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: (req as any)?.requestId ?? null, outcome: 'protocol_error', reason: 'unauthorized_peer', signature: null, detail: null }) + '\n');
                continue;
              }
              const v = validateSigningRequest(req);
              if (!v.ok) {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: (req as any)?.requestId ?? null, outcome: 'protocol_error', reason: v.reason, signature: null, detail: null }) + '\n');
                continue;
              }
              const r = await doSign(v.value);
              conn.write(JSON.stringify(r) + '\n');
            }
          });
          conn.on('error', () => conn.destroy());
          conn.on('close', () => clearTimeout(idleTimer));
        });
        server!.listen(socketPath, () => resolve());
        server!.on('error', reject);
      });
    },
    async close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      });
    },
    async sign(request: SigningRequest): Promise<SigningResponse> {
      // In-process path (no IPC). Reuses the same logic.
      const v = validateSigningRequest(request);
      if (!v.ok) {
        return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: request.requestId, outcome: 'protocol_error', signature: null, reason: v.reason, detail: null };
      }
      return doSign(v.value);
    },
  };
}

// ─── IPC client (facilitator side) ─────────────────────────────────────────

export interface IpcAccountSignerOptions {
  socketPath: string;
  /** Expected signing-service UID (SO_PEERCRED). */
  expectedUid: number;
  /** Sponsor address the client expects to sign for. The SERVICE validates this against its
   *  own configured sponsor — a mismatch is rejected, so the client cannot influence policy. */
  sponsorAddress: string;
  /** CAIP-2 network the client expects. The SERVICE validates this against its own config. */
  network: string;
  /** Timeout per request (ms). */
  timeoutMs?: number;
  /** Clock. */
  now?: () => number;
  /**
   * The signable V1 transaction this signer is bound to. REQUIRED to sign: a bare
   * digest is never sent. The digest passed to `sign()` must equal the recomputed
   * digest of this transaction, checked client-side before anything crosses the
   * socket; the service re-verifies it independently (the client is not trusted).
   */
  transaction?: unknown;
  /**
   * the Owner's authorization certificate for the bound transaction.
   * REQUIRED to sign: the service verifies it and consumes the authorization
   * before signing. Without it the client refuses client-side, and the
   * service would reject the request as `authorization_missing`.
   */
  authorization?: OwnerAuthorizationCertificate;
  /**
   * the AgentTrust payment digest the authorization belongs to.
   * REQUIRED to sign (with `authorization`): the service requires the
   * certificate's paymentDigest to equal it.
   */
  paymentDigest?: string;
}

/**
 * An `AccountSigner` that talks to the dedicated signing service over IPC.
 * Conforms to the SDK's `AccountSigner` interface so it can be injected into
 * `createSdkSponsorSigner({ accountSigner })`.
 */
export class IpcAccountSigner {
  private readonly socketPath: string;
  private readonly expectedUid: number;
  private readonly sponsorAddress: string;
  private readonly network: string;
  private readonly timeoutMs: number;
  private readonly transaction: unknown;
  private readonly authorization: OwnerAuthorizationCertificate | undefined;
  private readonly paymentDigest: string | undefined;

  constructor(opts: IpcAccountSignerOptions) {
    this.socketPath = opts.socketPath;
    this.expectedUid = opts.expectedUid;
    this.sponsorAddress = opts.sponsorAddress;
    this.network = opts.network;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.transaction = opts.transaction;
    this.authorization = opts.authorization;
    this.paymentDigest = opts.paymentDigest;
  }

  getSignatureCount(): bigint {
    return 1n;
  }

  async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
    if (this.transaction === undefined) {
      throw new Error('IpcAccountSigner: no transaction bound — refusing to sign a bare digest');
    }
    // no Owner authorization evidence, no signing. The service
    // would reject the request, but refusing here keeps an unevidenced
    // request from ever crossing the socket.
    if (this.authorization === undefined || this.paymentDigest === undefined) {
      throw new Error('IpcAccountSigner: no Owner authorization bound — refusing to sign without authorization evidence');
    }
    // Client-side binding: the digest must be the hash of the bound transaction.
    // The service re-verifies this independently; the client is not trusted.
    const boundDigest = signingDigestOf(this.transaction);
    const digestHex = Buffer.from(digest).toString('hex');
    if (digestHex.toLowerCase() !== boundDigest) {
      throw new Error('IpcAccountSigner: digest does not match the bound transaction');
    }
    const net = await import('node:net');
    const requestId = randomUUID();
    const request: SigningRequest = {
      protocolVersion: SIGNING_PROTOCOL_VERSION,
      requestId,
      operation: 'sign',
      digest: digestHex,
      transaction: this.transaction,
      sponsor: this.sponsorAddress,
      network: this.network,
      authorization: this.authorization,
      paymentDigest: this.paymentDigest,
    };
    // The service validates sponsor/network against ITS OWN configured values. A client
    // that sends a mismatched sponsor/network is rejected — the client cannot influence
    // signing policy.
    return new Promise<AccountTransactionSignature>((resolve, reject) => {
      let settled = false;
      const conn = net.createConnection(this.socketPath, () => {
        conn.write(JSON.stringify(request) + '\n');
      });
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        conn.destroy();
        reject(new Error('signing service timeout'));
      }, this.timeoutMs);
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        reject(new Error(message));
      };
      const succeed = (signature: AccountTransactionSignature): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.end();
        resolve(signature);
      };
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        let parsed: SigningResponse;
        try {
          parsed = JSON.parse(buf.slice(0, idx)) as SigningResponse;
        } catch {
          fail('malformed response from signing service');
          return;
        }
        if (parsed.requestId !== requestId) {
          fail('request ID mismatch in signing service response');
          return;
        }
        if (parsed.protocolVersion !== SIGNING_PROTOCOL_VERSION) {
          fail('unsupported protocol version in signing service response');
          return;
        }
        if (parsed.outcome !== 'signed' || !parsed.signature) {
          fail(`signing service refused: ${parsed.reason ?? parsed.outcome}`);
          return;
        }
        succeed(parsed.signature);
      });
      conn.on('error', (e) => {
        fail(`signing service unavailable: ${e.message}`);
      });
      // A service that exits mid-request closes the socket without a response. Without this
      // the caller would wait out the full timeout; either way it fails closed, but an
      // immediate, distinguishable error is what the lifecycle tests need.
      conn.on('close', () => {
        fail('signing service closed the connection before responding');
      });
    });
  }
}

/**
 * Startup reachability probe for the dedicated signing service.
 *
 * Verifies only that the Unix socket accepts a connection and can be closed again. It does
 * NOT sign, does not send a request, and does not authenticate the peer — authentication is
 * the service's job (SO_PEERCRED), and a probe that could not distinguish "listening" from
 * "accepting our UID" must not pretend to.
 *
 * Returns a reason string on failure; `null` means reachable.
 */
export async function probeSigningService(
  socketPath: string,
  timeoutMs = 5_000,
): Promise<string | null> {
  const net = await import('node:net');
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const conn = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve('signing service probe timeout');
    }, timeoutMs);
    const done = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reason);
    };
    conn.once('connect', () => done(null));
    conn.once('error', (e) => done(`signing service unreachable: ${e.message}`));
  });
}
