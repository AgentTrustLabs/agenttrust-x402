/**
 * Owner authorization evidence — the transaction-specific binding Task 11 adds.
 *
 * The gap (Task 10 honest residual): the signing service proved "the digest it
 * signs is the hash of the transaction it validated", but it could NOT prove
 * "this is the transaction the Owner authorized". The facilitator's word that
 * the Owner approved a transaction was the only link, and the signing service
 * had no way to check it.
 *
 * This module closes that gap with TWO independent mechanisms, both required:
 *
 *   1. An Owner-issued Ed25519 AUTHORIZATION CERTIFICATE. The Owner signs a
 *      canonical encoding of every bound field (authorization id, payment
 *      digest, transaction digest, transaction type, network, sender,
 *      sponsor, recipient, asset, amount, expiry, energy, energy cap, fee
 *      cap, policy version, issued-at). The signing service verifies the
 *      signature against the Owner's configured PUBLIC key and compares every
 *      field against the transaction it parsed — before signing anything.
 *      A caller-supplied "approved: true" is worthless here: without the
 *      Owner's private key the certificate cannot be forged, and any field
 *      changed after issuance invalidates the signature.
 *
 *   2. An atomic CONSUME step at the Owner. After the certificate verifies,
 *      the signing service asks the Owner to consume the authorization
 *      (over IPC, authenticated by SO_PEERCRED — the Owner only accepts
 *      `consume` from the signing service's UID). The Owner marks the
 *      approval consumed in the SAME durable store that recorded it, in one
 *      `BEGIN IMMEDIATE` transaction, and only then does the signing service
 *      sign. Consumption is what makes an approval single-use, restart-proof,
 *      and revocable: a replayed certificate fails consumption (already
 *      consumed), a revoked approval fails consumption, and an expired one
 *      fails consumption — even though the certificate itself still verifies.
 *
 * Trust boundaries, stated plainly:
 *   - The Owner holds the authorization private key. The signing service
 *     holds ONLY the public key. The facilitator holds NEITHER — it forwards
 *     the certificate opaquely and can neither forge nor alter it.
 *   - The certificate's security rests on the Owner's private key file being
 *     readable ONLY by the Owner's UID (0600, owned by that UID). If the
 *     Owner and the facilitator run as the SAME UID, the facilitator can
 *     read the key and forge certificates — the binding is void. Production
 *     MUST run the Owner as a distinct UID from the facilitator (see
 *     `AUTHZ_REQUIRE_DISTINCT_OWNER_UID` in scripts/authz-owner.mts).
 *   - The consume step's security rests on the Owner's socket being
 *     reachable ONLY by its configured UIDs and on the Owner's database
 *     being writable ONLY by the Owner and the facilitator processes that
 *     already share it. A facilitator that writes the shared database
 *     directly can forge approval ROWS — the certificate is what stops that
 *     forgery from reaching the signing service, because the forged row has
 *     no Owner signature.
 *   - The signing service verifies the Owner's identity on the consume
 *     channel itself (client-side SO_PEERCRED on the connected socket): a
 *     process that merely binds a socket at the Owner's path cannot answer
 *     for the Owner unless it also runs as the Owner's UID.
 *
 * No Concordium wallet material is involved: the authorization key is a
 * plain Ed25519 keypair used ONLY to sign authorization certificates. It is
 * not a Concordium account key, cannot sign Concordium transactions, and is
 * never a wallet export, seed phrase, or sponsor key.
 */

import { createHash, randomUUID, sign as edSign, verify as edVerify, generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ─── certificate ──────────────────────────────────────────────────────────

/** Version of the certificate encoding. Bump on any field change. */
export const OWNER_AUTHORIZATION_VERSION = 1;

/** Fields the Owner binds into every certificate. All values are JSON-safe. */
export interface OwnerAuthorizationFields {
  /** Encoding version. Always 1. */
  version: 1;
  /** Unique authorization id (uuid), created by the Owner at approval time. */
  authorizationId: string;
  /** AgentTrust payment digest (the x402 payment replay key), 64-hex. */
  paymentDigest: string;
  /** Concordium sponsor-sign digest of the exact transaction, 64-hex. */
  transactionDigest: string;
  /** Raw payload type string of the transaction, e.g. 'transfer'. */
  transactionType: string;
  /** CAIP-2 network. */
  network: string;
  /** Canonical base58 sender. */
  sender: string;
  /** Canonical base58 sponsor. */
  sponsor: string;
  /** Canonical base58 recipient. */
  recipient: string;
  /** Asset identifier, e.g. 'CCD'. */
  asset: string;
  /** Amount in smallest units, decimal string. */
  amount: string;
  /** Transaction expiry, epoch seconds. */
  expiry: number;
  /** Authorized execution energy (NRG), decimal string. */
  energy: string;
  /** Energy cap the Owner enforced (NRG), decimal string. */
  maxEnergy: string;
  /** Fee cap the authorization was issued under (microCCD), decimal string. */
  maxFeeMicroCcd: string;
  /** Owner policy version recorded in the approval. */
  policyVersion: string;
  /** Issuance time, ms since epoch. */
  issuedAt: number;
}

/** A certificate is its fields plus the Owner's Ed25519 signature over them. */
export interface OwnerAuthorizationCertificate extends OwnerAuthorizationFields {
  /** Hex Ed25519 signature over the canonical field encoding. */
  signature: string;
}

const FIELD_ORDER: Array<keyof OwnerAuthorizationFields> = [
  'version',
  'authorizationId',
  'paymentDigest',
  'transactionDigest',
  'transactionType',
  'network',
  'sender',
  'sponsor',
  'recipient',
  'asset',
  'amount',
  'expiry',
  'energy',
  'maxEnergy',
  'maxFeeMicroCcd',
  'policyVersion',
  'issuedAt',
];

/**
 * Canonical encoding of the bound fields: a JSON object with keys in the
 * fixed order above. The signature covers exactly these bytes. Verification
 * re-encodes from the parsed fields, so any reordering, renaming, or value
 * change invalidates the signature.
 */
export function canonicalAuthorizationEncoding(fields: OwnerAuthorizationFields): string {
  const ordered: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) ordered[k] = fields[k];
  return JSON.stringify(ordered);
}

/** Issue a certificate: sign the canonical encoding with the Owner key. */
export function issueOwnerAuthorizationCertificate(
  fields: OwnerAuthorizationFields,
  privateKey: KeyObject,
): OwnerAuthorizationCertificate {
  const signature = edSign(null, Buffer.from(canonicalAuthorizationEncoding(fields), 'utf8'), privateKey);
  return { ...fields, signature: signature.toString('hex') };
}

export type CertificateVerification =
  | { ok: true; fields: OwnerAuthorizationFields }
  | { ok: false; reason: string; detail: string };

const HEX64 = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/;
const DECIMAL = /^[0-9]+$/;

/**
 * Verify a caller-supplied certificate against the Owner's public key.
 * Structural validation runs first (wrong shapes never reach the crypto),
 * then the signature is verified over the re-encoded fields. Returns the
 * bound fields on success — callers MUST compare those fields against the
 * transaction they are about to sign; a valid signature alone proves only
 * that the Owner issued SOME authorization, not that it covers this tx.
 */
export function verifyOwnerAuthorizationCertificate(
  cert: unknown,
  publicKey: KeyObject,
): CertificateVerification {
  if (typeof cert !== 'object' || cert === null || Array.isArray(cert)) {
    return { ok: false, reason: 'authorization_invalid', detail: 'certificate is not an object' };
  }
  const c = cert as Record<string, unknown>;
  const allowed = new Set([...FIELD_ORDER, 'signature']);
  for (const k of Object.keys(c)) {
    if (!allowed.has(k)) return { ok: false, reason: 'authorization_invalid', detail: `unexpected certificate field: ${k}` };
  }
  for (const k of FIELD_ORDER) {
    if (c[k] === undefined) return { ok: false, reason: 'authorization_invalid', detail: `missing certificate field: ${k}` };
  }
  if (c['version'] !== OWNER_AUTHORIZATION_VERSION) {
    return { ok: false, reason: 'authorization_invalid', detail: `unsupported certificate version: ${String(c['version'])}` };
  }
  if (typeof c['authorizationId'] !== 'string' || !UUID.test(c['authorizationId'])) {
    return { ok: false, reason: 'authorization_invalid', detail: 'authorizationId is not a uuid' };
  }
  if (typeof c['paymentDigest'] !== 'string' || !HEX64.test(c['paymentDigest'])) {
    return { ok: false, reason: 'authorization_invalid', detail: 'paymentDigest is not 64-hex' };
  }
  if (typeof c['transactionDigest'] !== 'string' || !HEX64.test(c['transactionDigest'])) {
    return { ok: false, reason: 'authorization_invalid', detail: 'transactionDigest is not 64-hex' };
  }
  if (typeof c['transactionType'] !== 'string' || c['transactionType'].length === 0 || c['transactionType'].length > 64) {
    return { ok: false, reason: 'authorization_invalid', detail: 'transactionType is not a non-empty string' };
  }
  if (typeof c['network'] !== 'string' || c['network'].length === 0) {
    return { ok: false, reason: 'authorization_invalid', detail: 'network is empty' };
  }
  for (const k of ['sender', 'sponsor', 'recipient'] as const) {
    if (typeof c[k] !== 'string' || !BASE58.test(c[k])) {
      return { ok: false, reason: 'authorization_invalid', detail: `${k} is not a base58 account address` };
    }
  }
  if (typeof c['asset'] !== 'string' || c['asset'].length === 0) {
    return { ok: false, reason: 'authorization_invalid', detail: 'asset is empty' };
  }
  if (typeof c['amount'] !== 'string' || !DECIMAL.test(c['amount'])) {
    return { ok: false, reason: 'authorization_invalid', detail: 'amount is not a decimal string' };
  }
  if (typeof c['expiry'] !== 'number' || !Number.isSafeInteger(c['expiry']) || c['expiry'] <= 0) {
    return { ok: false, reason: 'authorization_invalid', detail: 'expiry is not a positive safe integer' };
  }
  for (const k of ['energy', 'maxEnergy', 'maxFeeMicroCcd'] as const) {
    if (typeof c[k] !== 'string' || !DECIMAL.test(c[k])) {
      return { ok: false, reason: 'authorization_invalid', detail: `${k} is not a decimal string` };
    }
  }
  if (typeof c['policyVersion'] !== 'string' || c['policyVersion'].length === 0) {
    return { ok: false, reason: 'authorization_invalid', detail: 'policyVersion is empty' };
  }
  if (typeof c['issuedAt'] !== 'number' || !Number.isSafeInteger(c['issuedAt']) || c['issuedAt'] <= 0) {
    return { ok: false, reason: 'authorization_invalid', detail: 'issuedAt is not a positive safe integer' };
  }
  if (typeof c['signature'] !== 'string' || !/^[0-9a-fA-F]{128}$/.test(c['signature'])) {
    return { ok: false, reason: 'authorization_invalid', detail: 'signature is not 128-hex' };
  }
  const fields = Object.fromEntries(FIELD_ORDER.map((k) => [k, c[k]])) as unknown as OwnerAuthorizationFields;
  let valid = false;
  try {
    valid = edVerify(
      null,
      Buffer.from(canonicalAuthorizationEncoding(fields), 'utf8'),
      publicKey,
      Buffer.from(c['signature'] as string, 'hex'),
    );
  } catch {
    return { ok: false, reason: 'authorization_signature_invalid', detail: 'signature verification threw' };
  }
  if (!valid) {
    return { ok: false, reason: 'authorization_signature_invalid', detail: 'signature does not match the certificate fields' };
  }
  return { ok: true, fields };
}

// ─── keys ─────────────────────────────────────────────────────────────────

/** Generate a fresh ephemeral Owner authorization keypair (tests + keygen). */
export function generateOwnerAuthorizationKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

/** SPKI DER hex of an Ed25519 public key — the form the signing service is configured with. */
export function ownerAuthorizationPublicKeyHex(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
}

/** SHA-256 fingerprint of a public key, for logs. Never log a private key.
 * Accepts a private key too (the public half is derived) so a caller that
 * only holds the private key cannot crash by passing it directly. */
export function ownerAuthorizationKeyFingerprint(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Parse a configured Owner public key (SPKI DER hex). Throws on garbage. */
export function loadOwnerAuthorizationPublicKey(hex: string): KeyObject {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Owner public key must be hex');
  }
  const key = createPublicKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Owner public key is not Ed25519');
  return key;
}

/**
 * Load the Owner's private key from a PEM (PKCS8) file.
 *
 * Fail-closed: the file must exist, parse as an Ed25519 private key, and be
 * readable ONLY by its owner (mode 0600 — any group/other permission bit
 * refuses startup). The key file must be owned by the Owner's UID; the
 * filesystem, not this check, enforces that — a key readable by the
 * facilitator's UID voids the binding (see the module header).
 */
export function loadOwnerAuthorizationPrivateKey(path: string): KeyObject {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`Owner authorization key file is not readable: ${path}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`Owner authorization key file must be mode 0600 (no group/other access): ${path}`);
  }
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Owner authorization key file is not readable: ${path}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('Owner authorization key file is not a valid PEM private key (PKCS8 expected)');
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Owner authorization key is not an Ed25519 private key');
  }
  return key;
}

/** New authorization id. */
export function newAuthorizationId(): string {
  return randomUUID();
}

// ─── consume ──────────────────────────────────────────────────────────────

/**
 * What the signing service sends the Owner to consume an authorization.
 * The context echoes the certificate's bound fields so the Owner can compare
 * them against its durable record — the Owner never trusts the echo alone:
 * it re-reads the record by authorizationId and requires an exact match.
 */
export interface OwnerConsumeRequest {
  authorizationId: string;
  transactionDigest: string;
  context: {
    /** AgentTrust payment digest the authorization belongs to, 64-hex. */
    paymentDigest: string;
    network: string;
    sender: string;
    sponsor: string;
    recipient: string;
    asset: string;
    amount: string;
    expiry: number;
    energy: string;
    transactionType: string;
    maxEnergy: string;
    maxFeeMicroCcd: string;
  };
}

export type OwnerConsumeOutcome = 'consumed' | 'rejected' | 'unknown' | 'owner_unavailable' | 'protocol_error';

export interface OwnerConsumeResponse {
  outcome: OwnerConsumeOutcome;
  reason: string | null;
  detail: string | null;
}

export interface OwnerConsumeClient {
  consume(req: OwnerConsumeRequest): Promise<OwnerConsumeResponse>;
}

/**
 * IPC consume client (signing service → Owner).
 *
 * The client verifies the SERVER's identity before sending anything: after
 * connect it reads SO_PEERCRED on the connected socket and requires the peer
 * UID to equal the configured Owner UID. A process that merely bound a socket
 * at the Owner's path under a different UID cannot answer for the Owner.
 * Any failure — timeout, close, malformed response, peer mismatch — resolves
 * to `owner_unavailable` / `protocol_error`: the caller fails closed and
 * never signs.
 */
export class IpcOwnerConsumeClient implements OwnerConsumeClient {
  private readonly socketPath: string;
  private readonly ownerUid: number;
  private readonly peerCredBin: string;
  private readonly timeoutMs: number;

  constructor(opts: { socketPath: string; ownerUid: number; peerCredBin?: string; timeoutMs?: number }) {
    this.socketPath = opts.socketPath;
    this.ownerUid = opts.ownerUid;
    this.peerCredBin = opts.peerCredBin ?? `${process.cwd()}/scripts/authz-peercred`;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private peerUidOf(conn: { _handle?: { fd?: number } }): number | null {
    const fd = conn._handle?.fd;
    if (typeof fd !== 'number') return null;
    try {
      const out = execFileSync(this.peerCredBin, ['0'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(out.trim()) as { uid?: unknown };
      return typeof parsed.uid === 'number' ? parsed.uid : null;
    } catch {
      return null;
    }
  }

  async consume(req: OwnerConsumeRequest): Promise<OwnerConsumeResponse> {
    const net = await import('node:net');
    const unavailable = (reason: string, detail: string): OwnerConsumeResponse => ({
      outcome: 'owner_unavailable',
      reason,
      detail,
    });
    return new Promise<OwnerConsumeResponse>((resolve) => {
      let settled = false;
      const done = (r: OwnerConsumeResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.destroy();
        } catch {
          /* already gone */
        }
        resolve(r);
      };
      const conn = net.createConnection(this.socketPath, () => {
        // Authenticate the server BEFORE sending the consume request.
        const peerUid = this.peerUidOf(conn as unknown as { _handle?: { fd?: number } });
        if (peerUid === null || peerUid !== this.ownerUid || peerUid === 0) {
          done({ outcome: 'protocol_error', reason: 'unauthorized_peer', detail: 'Owner socket peer is not the configured Owner UID' });
          return;
        }
        conn.write(
          JSON.stringify({
            protocolVersion: 1,
            requestId: randomUUID(),
            operation: 'consume',
            authorizationId: req.authorizationId,
            transactionDigest: req.transactionDigest,
            context: req.context,
          }) + '\n',
        );
      });
      let buf = '';
      const timer = setTimeout(() => done(unavailable('owner_unavailable', 'consume IPC timeout')), this.timeoutMs);
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(buf.slice(0, idx)) as Record<string, unknown>;
        } catch {
          done({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'invalid JSON response from Owner' });
          return;
        }
        const outcome = String(parsed.outcome ?? '') as OwnerConsumeOutcome;
        const valid: OwnerConsumeOutcome[] = ['consumed', 'rejected', 'unknown', 'owner_unavailable', 'protocol_error'];
        if (!valid.includes(outcome)) {
          done({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'unknown consume outcome from Owner' });
          return;
        }
        done({ outcome, reason: (parsed.reason as string | null) ?? null, detail: (parsed.detail as string | null) ?? null });
      });
      conn.on('error', (e) => done(unavailable('owner_unavailable', e.message)));
      conn.on('close', () => done(unavailable('owner_unavailable', 'connection closed before consume response')));
    });
  }
}
