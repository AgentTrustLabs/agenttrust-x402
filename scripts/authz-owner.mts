/**
 * Authorization Owner service — the "agenttrust-authz v1" protocol endpoint.
 *
 * Implements the IPC contract in a self-contained service:
 *   - Unix domain socket, UTF-8 JSONL framing, 64 KiB max message.
 *   - Strict validation, protocol version, operation allow-list.
 *   - Rejection of caller-supplied authorization-result fields.
 *   - SO_PEERCRED peer verification against an explicit Facilitator UID.
 *   - Durable request idempotency (requestId → canonical request identity).
 *   - Deterministic crash injection via CRASH_AT.
 *
 * It reads and writes the shared settlement database through the same repository
 * class the facilitator uses (SqliteSettlementRepository); it never signs and it
 * never submits. It owns the authorization decision: the durable state gate plus
 * the full policy, using the facilitator repository against a SQLite database.
 *
 * Deployment configuration (environment; defaults preserve the original test
 * harness behaviour so existing protocol tests keep passing):
 *   AUTHZ_SPONSOR_ADDRESS         sponsor account (default: the harness placeholder)
 *   AUTHZ_NETWORK                 CAIP-2 network (default: Concordium Testnet)
 *   AUTHZ_MAX_ENERGY              max execution energy in NRG (default: 10000)
 *   AUTHZ_MAX_EXPIRY_OFFSET_SECONDS  max expiry offset from now (default: 600)
 *   AUTHZ_ALLOWED_ASSETS          comma-separated assets (default: CCD)
 *   AUTHZ_POLICY_VERSION          version recorded in sign events (default: v348)
 *   AUTHZ_DB_FILE                 authorization database file. Default: <db-dir>/auth.db.
 *                                 For a live deployment this MUST be the facilitator's
 *                                 database file: the owner reads the same `payments` rows
 *                                 the facilitator claims, and writes the same `sign_events`
 *                                 the facilitator recovers from. There is no "register
 *                                 payment" operation in the v1 protocol, so a separate
 *                                 database would see every payment as `unknown_payment`.
 *   AUTHZ_SEED_FIXTURES           '1' seeds the harness digests a..e into the
 *                                 database so protocol tests have something to authorize.
 *                                 Default is '0' (no seeding): a production database must
 *                                 never receive fake payments. Tests and the harness
 *                                 opt in explicitly with '1'.
 *   AUTHZ_AUTHORIZATION_KEY_FILE  REQUIRED (Task 11). PKCS8 PEM file holding the
 *                                 Owner's Ed25519 authorization-signing key (mode
 *                                 0600, owned by the Owner UID). The Owner signs
 *                                 one certificate per approval; the signing
 *                                 service verifies it. Refuses to start when
 *                                 unset, unreadable, or wrongly permissioned.
 *                                 Only the public-key fingerprint is logged.
 *   AUTHZ_SIGNING_SERVICE_UID     UID of the signing service (argv[5] overrides).
 *                                 Only this UID may call the `consume` operation.
 *                                 When unset, `consume` is refused outright.
 *   AUTHZ_REQUIRE_DISTINCT_OWNER_UID  '1' refuses to start when the facilitator
 *                                 UID equals the Owner's own UID, or when the
 *                                 signing-service UID equals the facilitator
 *                                 UID. Default '0' (test compatibility).
 *                                 PRODUCTION MUST SET '1': the certificate is
 *                                 the only thing stopping a compromised
 *                                 facilitator from forging approvals, and it
 *                                 holds only while the Owner key is out of the
 *                                 facilitator's reach.
 *
 * Operations (v1): authorize, recover, db_identity, consume, revoke.
 *   - authorize/recover: facilitator UID only. On approval the response
 *     carries a `certificate`: the Owner's Ed25519 signature binding the
 *     exact transaction (digest, type, sender, sponsor, recipient, amount,
 *     network, energy, fee policy, expiry, authorization id).
 *   - consume: signing-service UID only. Atomically consumes one approval;
 *     the signing service calls it before signing.
 *   - revoke: facilitator UID only. Revokes an unconsumed approval.
 *
 * Run: npx tsx scripts/authz-owner.mts <db-dir> <socket-path> <facilitator-uid> [signing-service-uid]
 * Env:  CRASH_AT = 1..5 (crash injection point)
 */

import { createServer } from 'node:net';
import { mkdirSync, chmodSync, rmSync, existsSync, lstatSync, readFileSync, readdirSync, appendFileSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { AccountAddress } from '@concordium/web-sdk';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import type { SignEventRow } from '../services/facilitator/src/repository.js';
import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import {
  issueOwnerAuthorizationCertificate,
  loadOwnerAuthorizationPrivateKey,
  ownerAuthorizationKeyFingerprint,
} from '../services/facilitator/src/ownerAuthorization.js';
import type { OwnerAuthorizationCertificate } from '../services/facilitator/src/ownerAuthorization.js';

const CAIP2 = process.env.AUTHZ_NETWORK ?? 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = process.env.AUTHZ_SPONSOR_ADDRESS ?? '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
// AUTHZ_MAX_ENERGY must parse as a positive integer. BigInt() throws on garbage
// ('abc', '', '10.5'), so a failed parse leaves 0n and the positive check below
// produces the same clean "refusing to start" exit instead of an uncaught
// SyntaxError stack trace.
let maxEnergy = 0n;
try {
  maxEnergy = BigInt(process.env.AUTHZ_MAX_ENERGY ?? '10000');
} catch {
  maxEnergy = 0n;
}
const POLICY = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy,
  maxExpiryOffsetSeconds: Number(process.env.AUTHZ_MAX_EXPIRY_OFFSET_SECONDS ?? '600'),
  allowedAssets: (process.env.AUTHZ_ALLOWED_ASSETS ?? 'CCD').split(',').map((s) => s.trim()).filter(Boolean),
  policyVersion: process.env.AUTHZ_POLICY_VERSION ?? 'v348',
};

// Fail closed on an unusable policy before listening: a bad sponsor address or a
// non-positive limit must never start a service that authorizes real settlements.
try {
  AccountAddress.fromBase58(POLICY.sponsor);
} catch {
  console.error(`refusing to start: AUTHZ_SPONSOR_ADDRESS is not a valid Concordium account: ${POLICY.sponsor}`);
  process.exit(3);
}
if (POLICY.maxEnergy <= 0n) {
  console.error('refusing to start: AUTHZ_MAX_ENERGY must be a positive integer');
  process.exit(3);
}
if (!Number.isSafeInteger(POLICY.maxExpiryOffsetSeconds) || POLICY.maxExpiryOffsetSeconds <= 0) {
  console.error('refusing to start: AUTHZ_MAX_EXPIRY_OFFSET_SECONDS must be a positive safe integer');
  process.exit(3);
}
if (POLICY.allowedAssets.length === 0) {
  console.error('refusing to start: AUTHZ_ALLOWED_ASSETS must list at least one asset');
  process.exit(3);
}

const MAX_MSG = 64 * 1024;
const dir = process.argv[2];
const sock = process.argv[3];
const facilitatorUid = Number(process.argv[4] ?? process.getuid());
// Task 11: the signing-service UID gates the `consume` operation. argv[5]
// overrides the environment. When neither is set, `consume` is refused.
const signingServiceUidRaw = process.argv[5] ?? process.env.AUTHZ_SIGNING_SERVICE_UID;
const signingServiceUid = signingServiceUidRaw === undefined ? null : Number(signingServiceUidRaw);
const crashAt = Number(process.env.CRASH_AT ?? 0);
const logPath = process.env.TASK348_LOG ?? join(dir, 'owner.log');

if (!dir || !sock) {
  console.error('usage: authz-owner.mts <db-dir> <socket-path> <facilitator-uid> [signing-service-uid]');
  process.exit(2);
}
if (signingServiceUid !== null && (!Number.isSafeInteger(signingServiceUid) || signingServiceUid < 0)) {
  console.error('refusing to start: AUTHZ_SIGNING_SERVICE_UID must be a non-negative integer');
  process.exit(3);
}

// Task 11: the Owner's authorization-signing key. REQUIRED: without it the
// Owner cannot issue certificates, and an approval without a certificate is
// not verifiable authorization evidence. The key file must be mode 0600 and
// owned by the Owner UID; only the public-key fingerprint is ever logged.
const keyFile = process.env.AUTHZ_AUTHORIZATION_KEY_FILE;
if (!keyFile) {
  console.error('refusing to start: AUTHZ_AUTHORIZATION_KEY_FILE is required (Task 11: the Owner signs one certificate per approval)');
  process.exit(3);
}
let ownerKey: KeyObject;
try {
  ownerKey = loadOwnerAuthorizationPrivateKey(keyFile);
} catch (e) {
  console.error(`refusing to start: cannot load Owner authorization key: ${(e as Error).message}`);
  process.exit(3);
}

// Task 11: opt-in deployment hardening. When AUTHZ_REQUIRE_DISTINCT_OWNER_UID=1
// the Owner refuses to run under the facilitator's UID, and refuses a
// signing-service UID equal to the facilitator UID. The certificate design
// assumes the Owner key is out of the facilitator's reach; same-UID
// deployment voids that assumption. Default '0' keeps the test harness
// (which runs everything as one user) working; production MUST set '1'.
if (process.env.AUTHZ_REQUIRE_DISTINCT_OWNER_UID === '1') {
  if (facilitatorUid === process.getuid()) {
    console.error('refusing to start: AUTHZ_REQUIRE_DISTINCT_OWNER_UID=1 and the facilitator UID equals the Owner UID — run the Owner as a distinct user');
    process.exit(3);
  }
  if (signingServiceUid !== null && signingServiceUid === facilitatorUid) {
    console.error('refusing to start: AUTHZ_REQUIRE_DISTINCT_OWNER_UID=1 and the signing-service UID equals the facilitator UID');
    process.exit(3);
  }
}

const log = (line: string) => {
  try { appendFileSync(logPath, line + '\n'); } catch { /* best-effort */ }
};
// Public-key fingerprint only — never the key itself. The fingerprint takes
// the PUBLIC key: derive it from the loaded private key first (exporting a
// private key as 'spki' throws).
log(`owner authorization key fingerprint=${ownerAuthorizationKeyFingerprint(createPublicKey(ownerKey))}`);
process.on('uncaughtException', (e) => { log(`UNCAUGHT ${(e as Error)?.stack ?? e}`); process.exit(70); });
process.on('unhandledRejection', (e) => { log(`UNHANDLED ${(e as Error)?.stack ?? e}`); process.exit(71); });

// ── socket path safety ───────────────────────────────────────────────────────
// lstat does NOT follow symlinks; existsSync would, and a dangling symlink would be missed.
let st: ReturnType<typeof lstatSync> | null = null;
try { st = lstatSync(sock); } catch { st = null; }
if (st) {
  if (st.isSymbolicLink()) {
    console.error('refusing symlink socket path');
    process.exit(3);
  }
  if (st.isSocket()) rmSync(sock, { force: true });
  else {
    console.error('socket path exists and is not a socket');
    process.exit(3);
  }
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

// Authorization database. Default: <db-dir>/auth.db (the harness layout). A live
// deployment points this at the facilitator's database file so the owner reads the
// same payment rows the facilitator claims. The idempotency store below stays
// owner-private regardless.
const dbFileEnv = process.env.AUTHZ_DB_FILE;
if (dbFileEnv !== undefined && !dbFileEnv.startsWith('/')) {
  console.error('refusing to start: AUTHZ_DB_FILE must be an absolute path');
  process.exit(3);
}
const db = dbFileEnv ?? `${dir}/auth.db`;
const repo = new SqliteSettlementRepository(db, { now: () => Date.now() });
const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: repo, now: () => Date.now() });

// Fixture seeding (harness only). Default OFF: a production database must never
// receive fake payments. Tests and the harness opt in explicitly with
// AUTHZ_SEED_FIXTURES=1, and only ever against a test database.
if (process.env.AUTHZ_SEED_FIXTURES === '1') {
  for (const c of ['a', 'b', 'c', 'd', 'e']) {
    const digest = c.repeat(64);
    repo.noteVerified(digest, 'k');
    repo.claim(digest, 'k');
  }
}

// ── durable idempotency store (owner-only) ───────────────────────────────────
const idemDb = new DatabaseSync(`${dir}/idem.db`);
log(`idemDb path=${dir}/idem.db`);
idemDb.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS idem (
  request_id      TEXT PRIMARY KEY,
  canonical       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  detail          TEXT,
  decided_at      INTEGER NOT NULL,
  policy_version  TEXT NOT NULL
);
`);
// Owner-private idempotency store: keep it owner-only (0600). Best-effort — the
// directory is 0700, so this is defense-in-depth, not the access boundary.
for (const suffix of ['', '-wal', '-shm']) {
  try { chmodSync(`${dir}/idem.db${suffix}`, 0o600); } catch { /* file may not exist yet */ }
}

const canonicalOf = (req: Record<string, unknown>): string => {
  const c = req.context as Record<string, unknown>;
  // Canonical identity: protocol version + operation + payment digest + normalized context.
  // Energy is normalized to a decimal string so "3000" and "03000" are equivalent.
  // Task 11: the exact-transaction binding fields are part of the identity —
  // the same requestId must never authorize two different transactions.
  return JSON.stringify({
    v: req.protocolVersion,
    op: req.operation,
    pd: req.paymentDigest,
    n: c?.network,
    ver: c?.version,
    s: c?.sender,
    sp: c?.sponsor,
    r: c?.recipient,
    a: c?.asset,
    amt: c?.amount,
    exp: c?.expiry,
    e: String(c?.energy),
    td: c?.transactionDigest,
    tt: c?.transactionType,
    mf: c?.maxFeeMicroCcd,
  });
};

/**
 * Task 11 — check a durable approval against the request context.
 * Returns the list of mismatching fields. NULL in the record means the
 * approval predates the binding — that is reported as legacy, and the
 * caller fails closed with a distinct reason.
 */
const matchApproval = (
  ev: SignEventRow,
  digest: string,
  ctx: Record<string, unknown>,
): { mismatches: string[]; legacy: boolean } => {
  const mismatches: string[] = [];
  let legacy = false;
  if (ev.payment_digest !== digest) mismatches.push('payment_digest');
  if (ev.network !== String(ctx.network)) mismatches.push('network');
  if (ev.sender !== String(ctx.sender)) mismatches.push('sender');
  if (ev.sponsor !== String(ctx.sponsor)) mismatches.push('sponsor');
  if (ev.recipient !== String(ctx.recipient)) mismatches.push('recipient');
  if (ev.energy !== String(ctx.energy)) mismatches.push('energy');
  if (ev.policy_version !== POLICY.policyVersion) mismatches.push('policy_version');
  if (ev.asset === null) { mismatches.push('asset (missing durable evidence)'); legacy = true; }
  else if (ev.asset !== String(ctx.asset)) mismatches.push('asset');
  if (ev.amount === null) { mismatches.push('amount (missing durable evidence)'); legacy = true; }
  else if (ev.amount !== String(ctx.amount)) mismatches.push('amount');
  if (ev.expiry === null) { mismatches.push('expiry (missing durable evidence)'); legacy = true; }
  else if (ev.expiry !== Number(ctx.expiry)) mismatches.push('expiry');
  if (ev.transaction_digest === null) { mismatches.push('transaction_digest (missing durable evidence)'); legacy = true; }
  else if (ev.transaction_digest !== String(ctx.transactionDigest)) mismatches.push('transaction_digest');
  if (ev.transaction_type === null) { mismatches.push('transaction_type (missing durable evidence)'); legacy = true; }
  else if (ev.transaction_type !== String(ctx.transactionType)) mismatches.push('transaction_type');
  if (ev.max_fee_microccd === null) { mismatches.push('max_fee_microccd (missing durable evidence)'); legacy = true; }
  else if (ev.max_fee_microccd !== String(ctx.maxFeeMicroCcd)) mismatches.push('max_fee_microccd');
  return { mismatches, legacy };
};

/**
 * Task 11 — issue (or re-issue) the certificate for a durable approval,
 * from the stored row. Ed25519 is deterministic, so re-issuing the same
 * approval with the row's decided_at as issuedAt reproduces the identical
 * bytes. Returns null when the row predates the certificate binding.
 */
const certificateFromRow = (
  ev: SignEventRow,
): OwnerAuthorizationCertificate | null => {
  if (
    ev.authorization_id === null ||
    ev.transaction_digest === null ||
    ev.transaction_type === null ||
    ev.max_energy === null ||
    ev.max_fee_microccd === null ||
    ev.asset === null ||
    ev.amount === null ||
    ev.expiry === null
  ) {
    return null;
  }
  return issueOwnerAuthorizationCertificate(
    {
      version: 1,
      authorizationId: ev.authorization_id,
      paymentDigest: ev.payment_digest,
      transactionDigest: ev.transaction_digest,
      transactionType: ev.transaction_type,
      network: ev.network,
      sender: ev.sender,
      sponsor: ev.sponsor,
      recipient: ev.recipient,
      asset: ev.asset,
      amount: ev.amount,
      expiry: ev.expiry,
      energy: ev.energy,
      maxEnergy: ev.max_energy,
      maxFeeMicroCcd: ev.max_fee_microccd,
      policyVersion: ev.policy_version,
      issuedAt: ev.decided_at,
    },
    ownerKey,
  );
};

const idemGet = (requestId: string): Record<string, unknown> | undefined => {
  const row = idemDb.prepare('SELECT outcome, reason, detail, decided_at, policy_version FROM idem WHERE request_id = ?').get(requestId) as
    | { outcome: string; reason: string | null; detail: string | null; decided_at: number; policy_version: string }
    | undefined;
  if (!row) return undefined;
  return {
    protocolVersion: 1,
    requestId,
    outcome: row.outcome,
    reason: row.reason,
    detail: row.detail,
    decidedAt: row.decided_at,
    policyVersion: row.policy_version,
  };
};

const idemPut = (requestId: string, canonical: string, r: Record<string, unknown>): void => {
  // INSERT OR IGNORE: two concurrent authorize calls with the same requestId can
  // both miss idemGet and both reach here. The second insert must be dropped,
  // not crash the owner with SQLITE_CONSTRAINT. The durable gate — not this
  // store — is what prevents a second approval: authorizeSignEvent is one
  // BEGIN IMMEDIATE transaction guarded by a partial unique index.
  idemDb
    .prepare(
      'INSERT OR IGNORE INTO idem (request_id, canonical, outcome, reason, detail, decided_at, policy_version) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      requestId,
      canonical,
      String(r.outcome),
      (r.reason as string) ?? null,
      (r.detail as string) ?? null,
      Number(r.decidedAt),
      String(r.policyVersion),
    );
};

const crash = (point: number, why: string): void => {
  if (crashAt === point) {
    log(`CRASH_AT=${point} ${why}`);
    process.kill(process.pid, 'SIGKILL');
  }
};

// ── peer credentials (SO_PEERCRED) ───────────────────────────────────────────
// Node does not expose SO_PEERCRED. The harness shells out to a tiny C helper that performs
// getsockopt(SO_PEERCRED) on the accepted socket fd. The fd comes from the Node socket
// handle; the kernel -- not the caller -- reports the identity.
import { execFileSync } from 'node:child_process';
const PEERCRED_BIN = process.env.TASK348_PEERCRED_BIN ?? `${process.cwd()}/scripts/authz-peercred`;

type PeerCred = { uid: number; gid: number; pid: number };
const peerCredOf = (conn: import('node:net').Socket): PeerCred | null => {
  const handle = (conn as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  log(`peercred fd=${fd} handleType=${typeof handle}`);
  if (typeof fd !== 'number') return null;
  try {
    const out = execFileSync(PEERCRED_BIN, ['0'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
    log(`peercred out=${out.trim()}`);
    const parsed = JSON.parse(out.trim()) as PeerCred;
    if (typeof parsed.uid !== 'number') return null;
    return parsed;
  } catch (e) {
    log(`peercred failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
};


// ── validation ───────────────────────────────────────────────────────────────
const FORBIDDEN = new Set(['decision', 'approved', 'outcome', 'reason', 'result', 'authorization', 'certificate']);
const REQ_ALLOWED = new Set(['protocolVersion', 'requestId', 'operation', 'paymentDigest', 'context', 'authorizationId', 'transactionDigest']);
const CTX_ALLOWED = new Set(['network', 'version', 'sender', 'sponsor', 'recipient', 'asset', 'amount', 'expiry', 'energy', 'transactionDigest', 'transactionType', 'maxFeeMicroCcd']);
const CONSUME_CTX_ALLOWED = new Set(['paymentDigest', 'network', 'sender', 'sponsor', 'recipient', 'asset', 'amount', 'expiry', 'energy', 'transactionType', 'maxEnergy', 'maxFeeMicroCcd']);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const validate = (req: Record<string, unknown>): { ok: true } | { ok: false; reason: string } => {
  for (const k of Object.keys(req)) {
    if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
    if (!REQ_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
  }
  if (typeof req.protocolVersion !== 'number' || req.protocolVersion !== 1) return { ok: false, reason: 'unsupported_protocol' };
  if (typeof req.requestId !== 'string' || req.requestId.length < 1 || req.requestId.length > 128) return { ok: false, reason: 'invalid_field' };
  const OPS = new Set(['authorize', 'recover', 'db_identity', 'consume', 'revoke']);
  if (typeof req.operation !== 'string' || !OPS.has(req.operation)) return { ok: false, reason: 'unknown_operation' };
  // db_identity is a read-only readiness probe: it carries no payment digest and no
  // context, and must carry nothing else. It creates no state (no idempotency
  // record, no sign event) and never touches the payments tables.
  if (req.operation === 'db_identity') {
    for (const k of Object.keys(req)) {
      if (k !== 'protocolVersion' && k !== 'requestId' && k !== 'operation') return { ok: false, reason: 'malformed_request' };
    }
    return { ok: true };
  }
  // revoke carries only the authorization id. No payment digest, no context.
  if (req.operation === 'revoke') {
    for (const k of Object.keys(req)) {
      if (k !== 'protocolVersion' && k !== 'requestId' && k !== 'operation' && k !== 'authorizationId') return { ok: false, reason: 'malformed_request' };
    }
    if (typeof req.authorizationId !== 'string' || !UUID_RE.test(req.authorizationId)) return { ok: false, reason: 'invalid_field' };
    return { ok: true };
  }
  // consume carries the authorization id, the transaction digest, and the
  // certificate's bound fields as context (the Owner re-reads its durable
  // record by id and requires an exact match — the echo is never trusted).
  if (req.operation === 'consume') {
    for (const k of Object.keys(req)) {
      if (k !== 'protocolVersion' && k !== 'requestId' && k !== 'operation' && k !== 'authorizationId' && k !== 'transactionDigest' && k !== 'context') return { ok: false, reason: 'malformed_request' };
    }
    if (typeof req.authorizationId !== 'string' || !UUID_RE.test(req.authorizationId)) return { ok: false, reason: 'invalid_field' };
    if (typeof req.transactionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(req.transactionDigest)) return { ok: false, reason: 'invalid_field' };
    if (typeof req.context !== 'object' || req.context === null) return { ok: false, reason: 'missing_field' };
    const c = req.context as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
      if (!CONSUME_CTX_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
    }
    if (typeof c.paymentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(c.paymentDigest)) return { ok: false, reason: 'invalid_field' };
    if (typeof c.network !== 'string' || c.network !== POLICY.network) return { ok: false, reason: 'wrong_network' };
    if (typeof c.sender !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(c.sender)) return { ok: false, reason: 'invalid_sender' };
    if (typeof c.sponsor !== 'string' || c.sponsor !== POLICY.sponsor) return { ok: false, reason: 'wrong_sponsor' };
    if (typeof c.recipient !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(c.recipient)) return { ok: false, reason: 'invalid_recipient' };
    if (typeof c.asset !== 'string' || !POLICY.allowedAssets.includes(c.asset)) return { ok: false, reason: 'unsupported_asset' };
    if (typeof c.amount !== 'string' || !/^[0-9]+$/.test(c.amount)) return { ok: false, reason: 'invalid_field' };
    if (typeof c.expiry !== 'number' || !Number.isInteger(c.expiry)) return { ok: false, reason: 'invalid_field' };
    if (typeof c.energy !== 'string' || !/^[0-9]+$/.test(c.energy)) return { ok: false, reason: 'energy_malformed' };
    if (typeof c.transactionType !== 'string' || c.transactionType.length < 1 || c.transactionType.length > 64) return { ok: false, reason: 'invalid_field' };
    if (typeof c.maxEnergy !== 'string' || !/^[0-9]+$/.test(c.maxEnergy)) return { ok: false, reason: 'invalid_field' };
    if (typeof c.maxFeeMicroCcd !== 'string' || !/^[0-9]+$/.test(c.maxFeeMicroCcd)) return { ok: false, reason: 'invalid_field' };
    return { ok: true };
  }
  if (typeof req.paymentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(req.paymentDigest)) return { ok: false, reason: 'invalid_field' };
  if (typeof req.context !== 'object' || req.context === null) return { ok: false, reason: 'missing_field' };
  const c = req.context as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
    if (!CTX_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
  }
  if (typeof c.network !== 'string' || c.network !== POLICY.network) return { ok: false, reason: 'wrong_network' };
  if (typeof c.version !== 'number' || c.version !== 1) return { ok: false, reason: 'wrong_version' };
  if (typeof c.sender !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(c.sender)) return { ok: false, reason: 'invalid_sender' };
  if (typeof c.sponsor !== 'string' || c.sponsor !== POLICY.sponsor) return { ok: false, reason: 'wrong_sponsor' };
  if (typeof c.recipient !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(c.recipient)) return { ok: false, reason: 'invalid_recipient' };
  if (typeof c.asset !== 'string' || !POLICY.allowedAssets.includes(c.asset)) return { ok: false, reason: 'unsupported_asset' };
  if (typeof c.amount !== 'string' || !/^[0-9]+$/.test(c.amount)) return { ok: false, reason: 'invalid_field' };
  if (typeof c.expiry !== 'number' || !Number.isInteger(c.expiry)) return { ok: false, reason: 'invalid_field' };
  if (typeof c.energy !== 'string' || !/^[0-9]+$/.test(c.energy)) return { ok: false, reason: 'energy_malformed' };
  // Task 11: the authorization binds the exact transaction.
  if (typeof c.transactionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(c.transactionDigest)) return { ok: false, reason: 'invalid_field' };
  if (typeof c.transactionType !== 'string' || c.transactionType.length < 1 || c.transactionType.length > 64) return { ok: false, reason: 'invalid_field' };
  if (typeof c.maxFeeMicroCcd !== 'string' || !/^[0-9]+$/.test(c.maxFeeMicroCcd)) return { ok: false, reason: 'invalid_field' };
  return { ok: true };
};

// ── server ───────────────────────────────────────────────────────────────────
const server = createServer((conn) => {
  let buf = '';
  let bytes = 0;
  const idleTimer = setTimeout(() => conn.destroy(), 30_000);
  conn.on('data', async (chunk) => {
    log(`received ${chunk.length} bytes`);
    bytes += chunk.length;
    if (bytes > MAX_MSG) {
      conn.write(JSON.stringify({ protocolVersion: 1, requestId: null, outcome: 'protocol_error', reason: 'message_too_large' }) + '\n');
      conn.destroy();
      return;
    }
    try {
      buf += new TextDecoder('utf-8', { fatal: true }).decode(chunk);
    } catch {
      conn.write(JSON.stringify({ protocolVersion: 1, requestId: null, outcome: 'protocol_error', reason: 'malformed_request' }) + '\n');
      conn.destroy();
      return;
    }
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(line) as Record<string, unknown>;
        if (typeof req !== 'object' || req === null || Array.isArray(req)) throw new Error('not an object');
      } catch {
        conn.write(JSON.stringify({ protocolVersion: 1, requestId: null, outcome: 'protocol_error', reason: 'malformed_request' }) + '\n');
        continue;
      }
      const requestId = req.requestId as string;

      // 1. peer credentials (before any authorization processing). The
      //    expected peer depends on the operation (Task 11): the signing
      //    service alone may consume an authorization; every other
      //    operation is facilitator-only. A request that names no
      //    operation, or an unknown one, is gated on the facilitator UID
      //    and rejected by validation right after.
      const op = typeof req.operation === 'string' ? req.operation : '';
      let expectedUid: number | null = facilitatorUid;
      if (op === 'consume') {
        if (signingServiceUid === null) {
          conn.write(JSON.stringify({ protocolVersion: 1, requestId, outcome: 'protocol_error', reason: 'signing_service_uid_not_configured' }) + '\n');
          continue;
        }
        expectedUid = signingServiceUid;
      }
      const peer = peerCredOf(conn);
      const peerUid = peer?.uid ?? null;
      // Documented root policy: reject root unless the facilitator IS root (never in prod).
      if (peerUid === null || peerUid !== expectedUid || peerUid === 0) {
        log(`unauthorized peer uid=${peerUid} gid=${peer?.gid ?? null} pid=${peer?.pid ?? null} op=${op}`);
        conn.write(JSON.stringify({ protocolVersion: 1, requestId, outcome: 'protocol_error', reason: 'unauthorized_peer' }) + '\n');
        continue;
      }

      // 1b. protocol validation (after peer auth)
      const v0 = validate(req);
      log(`validate ${v0.ok ? 'ok' : (v0 as {reason: string}).reason}`);
      const v = v0;
      if (!v.ok) {
        conn.write(JSON.stringify({ protocolVersion: 1, requestId: req.requestId ?? null, outcome: 'rejected', reason: v.reason }) + '\n');
        continue;
      }
      // db_identity: read-only readiness probe (F2/F6). Answers with the identity
      // of the shared database file this owner is actually using, so the
      // facilitator can prove it is authorizing against the same file (same
      // device + inode after symlink resolution). No state is created or read
      // from the payments tables; the idempotency store is untouched.
      if (req.operation === 'db_identity') {
        let resolved: string;
        let st: ReturnType<typeof statSync>;
        try {
          resolved = realpathSync(db);
          st = statSync(resolved);
        } catch (e) {
          conn.write(JSON.stringify({ protocolVersion: 1, requestId, outcome: 'protocol_error', reason: 'db_identity_unavailable', detail: String((e as Error)?.message ?? e) }) + '\n');
          continue;
        }
        conn.write(JSON.stringify({ protocolVersion: 1, requestId, outcome: 'ok', dbPath: resolved, dbDev: st.dev, dbIno: st.ino }) + '\n');
        continue;
      }

      const canonical = canonicalOf(req);

      // Owner-mediated recovery. Reads durable records only — never creates,
      // modifies, or deletes an authorization record.
      if (req.operation === 'recover') {
        const ctx = req.context as Record<string, unknown>;
        const digest = req.paymentDigest as string;
        const payment = repo.get(digest);
        if (!payment) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: 'unknown_payment',
            detail: 'no durable payment row for this digest',
          }) + '\n');
          continue;
        }

        const events = repo.signEvents(digest);
        const approvedEvents = events.filter((e) => e.decision === 'approved');
        const rejectedEvents = events.filter((e) => e.decision === 'rejected');

        if (approvedEvents.length === 0) {
          if (rejectedEvents.length > 0) {
            const last = rejectedEvents[0]; // newest first
            conn.write(JSON.stringify({
              protocolVersion: 1, requestId, outcome: 'rejected',
              reason: last.reason ?? 'authorization_rejected',
              detail: 'a durable rejection exists for this payment',
            }) + '\n');
          } else {
            conn.write(JSON.stringify({
              protocolVersion: 1, requestId, outcome: 'unknown',
              reason: 'no_durable_decision',
              detail: 'no approved or rejected authorization record exists',
            }) + '\n');
          }
          continue;
        }

        if (approvedEvents.length > 1) {
          // The partial unique index makes this unreachable; if it ever happens, refuse.
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: 'conflicting_evidence',
            detail: `${approvedEvents.length} approved events for one payment`,
          }) + '\n');
          continue;
        }

        // Exactly one approval. Prove its context matches the request before reporting it.
        // Task 11: a consumed approval cannot authorize a second signing, and
        // a revoked approval cannot authorize at all — both fail here, before
        // any certificate is issued.
        const ev = approvedEvents[0];
        if (ev.consumed_at !== null) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: 'authorization_consumed',
            detail: 'the approval was already consumed',
          }) + '\n');
          continue;
        }
        if (ev.revoked_at !== null) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'rejected',
            reason: 'authorization_revoked',
            detail: 'the approval was revoked',
          }) + '\n');
          continue;
        }
        const { mismatches, legacy } = matchApproval(ev, digest, ctx);

        if (mismatches.length > 0) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: legacy ? 'legacy_context_missing' : 'context_mismatch',
            detail: `approval exists but does not match: ${mismatches.join(', ')}`,
          }) + '\n');
          continue;
        }

        // The approval matches. Re-issue its certificate (deterministic:
        // identical bytes to the original) and report the durable result.
        const certificate = certificateFromRow(ev);
        if (certificate === null) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: 'legacy_context_missing',
            detail: 'approval record predates the certificate binding',
          }) + '\n');
          continue;
        }
        conn.write(JSON.stringify({
          protocolVersion: 1, requestId, outcome: 'approved',
          reason: null,
          detail: 'durable approval verified against request context',
          decidedAt: ev.decided_at,
          policyVersion: ev.policy_version,
          certificate,
        }) + '\n');
        continue;
      }

      // Task 11 — consume: the signing service alone (peer-gated above)
      // spends one approval. Atomic in the repository: concurrent consumes
      // of the same authorization yield exactly one 'consumed'.
      if (req.operation === 'consume') {
        const ctx = req.context as Record<string, unknown>;
        const result = repo.consumeAuthorization({
          authorizationId: req.authorizationId as string,
          transactionDigest: req.transactionDigest as string,
          paymentDigest: ctx.paymentDigest as string,
          network: ctx.network as string,
          sender: ctx.sender as string,
          sponsor: ctx.sponsor as string,
          recipient: ctx.recipient as string,
          asset: ctx.asset as string,
          amount: ctx.amount as string,
          expiry: ctx.expiry as number,
          energy: ctx.energy as string,
          transactionType: ctx.transactionType as string,
          maxEnergy: ctx.maxEnergy as string,
          maxFeeMicroCcd: ctx.maxFeeMicroCcd as string,
        });
        if (result.ok) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'consumed',
            reason: null, detail: 'authorization consumed',
          }) + '\n');
        } else if (result.reason === 'unknown_authorization') {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: result.reason, detail: 'no such authorization',
          }) + '\n');
        } else {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'rejected',
            reason: result.reason, detail: 'authorization cannot be consumed',
          }) + '\n');
        }
        continue;
      }

      // Task 11 — revoke: the facilitator spends nothing; it marks an
      // unconsumed approval unusable. Idempotent; a consumed approval
      // cannot be revoked.
      if (req.operation === 'revoke') {
        const result = repo.revokeAuthorization(req.authorizationId as string);
        if (result.ok) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'revoked',
            reason: null, detail: 'authorization revoked',
          }) + '\n');
        } else if (result.reason === 'unknown_authorization') {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: result.reason, detail: 'no such authorization',
          }) + '\n');
        } else {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'rejected',
            reason: result.reason, detail: 'authorization already consumed',
          }) + '\n');
        }
        continue;
      }

      // 2. durable idempotency
      const prior = idemGet(requestId);
  log(`idemGet(${requestId}) = ${prior ? 'found' : 'none'}`);
      if (prior) {
        const storedCanonical = (idemDb.prepare('SELECT canonical FROM idem WHERE request_id = ?').get(requestId) as { canonical: string }).canonical;
        if (storedCanonical !== canonical) {
          conn.write(JSON.stringify({ protocolVersion: 1, requestId, outcome: 'rejected', reason: 'request_id_conflict' }) + '\n');
          continue;
        }
        // Task 11: the idempotency store holds no certificate (no schema
        // change). Re-derive it from the durable approval row, so a replayed
        // approval carries the same verifiable evidence as the first answer.
        // A consumed/revoked/mismatched approval yields no certificate —
        // the replayed 'approved' then fails closed at the caller, which
        // must recover (or re-authorize) instead of signing on it.
        if (prior.outcome === 'approved') {
          const ctx = req.context as Record<string, unknown>;
          const digest = req.paymentDigest as string;
          const approved = repo.signEvents(digest).filter((e) => e.decision === 'approved');
          if (approved.length === 1) {
            const ev = approved[0];
            const { mismatches } = matchApproval(ev, digest, ctx);
            if (mismatches.length === 0 && ev.consumed_at === null && ev.revoked_at === null) {
              const certificate = certificateFromRow(ev);
              if (certificate !== null) {
                conn.write(JSON.stringify({ ...prior, certificate }) + '\n');
                continue;
              }
            }
          }
        }
        conn.write(JSON.stringify(prior) + '\n');
        continue;
      }

      crash(1, 'before authorization transaction');

      // 3. resolve durable payment state
      const row = repo.get(req.paymentDigest as string);
      if (!row) {
        const r = { protocolVersion: 1, requestId, outcome: 'rejected', reason: 'unknown_payment', detail: null, decidedAt: Date.now(), policyVersion: POLICY.policyVersion };
        idemPut(requestId, canonical, r);
        conn.write(JSON.stringify(r) + '\n');
        continue;
      }

      crash(2, 'after reading payment state, before decision');

      // 4. evaluate authorization (durable gate + policy)
      const result = await signer.authorize({
        network: (req.context as Record<string, unknown>).network as string,
        version: (req.context as Record<string, unknown>).version as number,
        sender: (req.context as Record<string, unknown>).sender as string,
        sponsor: (req.context as Record<string, unknown>).sponsor as string,
        recipient: (req.context as Record<string, unknown>).recipient as string,
        asset: (req.context as Record<string, unknown>).asset as string,
        amount: (req.context as Record<string, unknown>).amount as string,
        expiry: (req.context as Record<string, unknown>).expiry as number,
        energy: BigInt((req.context as Record<string, unknown>).energy as string),
        paymentDigest: req.paymentDigest as string,
        // Task 11: the authorization binds the exact transaction.
        transactionDigest: (req.context as Record<string, unknown>).transactionDigest as string,
        transactionType: (req.context as Record<string, unknown>).transactionType as string,
        maxFeeMicroCcd: (req.context as Record<string, unknown>).maxFeeMicroCcd as string,
      });

      // NOTE: signer.authorize() owns its transaction internally; it has already committed
      // when control returns. This point is therefore AFTER commit, before the idempotency
      // record — a genuine pre-commit crash is not reachable without mocking (see report).
      crash(3, 'after authorize() committed, before idempotency record');

      const outcome = result.approved ? 'approved' : 'rejected';
      // Task 11: on approval, issue the certificate from the durable row —
      // the row is the authoritative record, and its decided_at is the
      // issuance time (so a later re-issue reproduces identical bytes).
      // An approval whose row cannot be read back is reported as a
      // certificate failure, never as a bare approval: the caller must
      // recover (which re-derives the certificate) instead of signing.
      let certificate: OwnerAuthorizationCertificate | null = null;
      let decidedAt = Date.now();
      if (result.approved) {
        const row = result.authorizationId ? repo.authorizationById(result.authorizationId) : undefined;
        if (row && row.decision === 'approved') {
          certificate = certificateFromRow(row);
          decidedAt = row.decided_at;
        }
        if (certificate === null) {
          const r = { protocolVersion: 1, requestId, outcome: 'rejected', reason: 'certificate_unavailable', detail: 'approval recorded but its certificate could not be issued — recover to re-derive it', decidedAt, policyVersion: POLICY.policyVersion };
          idemPut(requestId, canonical, r);
          conn.write(JSON.stringify(r) + '\n');
          continue;
        }
      }
      const r = {
        protocolVersion: 1,
        requestId,
        outcome,
        reason: result.approved ? null : result.reason,
        detail: result.detail ?? null,
        decidedAt,
        policyVersion: POLICY.policyVersion,
        ...(certificate !== null ? { certificate } : {}),
      };

      // The authorization event is already committed by signer.authorize(). Persist the
      // idempotency record, then die before the client sees a response.
      idemPut(requestId, canonical, r);
      log(`idemPut(${requestId}) done`);
      crash(4, 'after commit and idempotency record, before response');
      conn.write(JSON.stringify(r) + '\n');
      crash(5, 'during response transmission');
    }
  });
  conn.on('error', () => conn.destroy());
  conn.on('close', () => clearTimeout(idleTimer));
});

server.listen(sock, () => {
  chmodSync(sock, 0o660);
  console.log(`owner listening on ${sock}`);
});
process.on('SIGTERM', () => {
  server.close();
  repo.close();
  idemDb.close();
  process.exit(0);
});
