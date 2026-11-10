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
 *
 * Run: npx tsx scripts/authz-owner.mts <db-dir> <socket-path> <facilitator-uid>
 * Env:  CRASH_AT = 1..5 (crash injection point)
 */

import { createServer } from 'node:net';
import { mkdirSync, chmodSync, rmSync, existsSync, lstatSync, readFileSync, readdirSync, appendFileSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AccountAddress } from '@concordium/web-sdk';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';

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
const crashAt = Number(process.env.CRASH_AT ?? 0);
const logPath = process.env.TASK348_LOG ?? join(dir, 'owner.log');

if (!dir || !sock) {
  console.error('usage: authz-owner.mts <db-dir> <socket-path> <facilitator-uid>');
  process.exit(2);
}

const log = (line: string) => {
  try { appendFileSync(logPath, line + '\n'); } catch { /* best-effort */ }
};
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
  });
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
const FORBIDDEN = new Set(['decision', 'approved', 'outcome', 'reason', 'result', 'authorization']);
const REQ_ALLOWED = new Set(['protocolVersion', 'requestId', 'operation', 'paymentDigest', 'context']);
const CTX_ALLOWED = new Set(['network', 'version', 'sender', 'sponsor', 'recipient', 'asset', 'amount', 'expiry', 'energy']);
const validate = (req: Record<string, unknown>): { ok: true } | { ok: false; reason: string } => {
  for (const k of Object.keys(req)) {
    if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
    if (!REQ_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
  }
  if (typeof req.protocolVersion !== 'number' || req.protocolVersion !== 1) return { ok: false, reason: 'unsupported_protocol' };
  if (typeof req.requestId !== 'string' || req.requestId.length < 1 || req.requestId.length > 128) return { ok: false, reason: 'invalid_field' };
  const OPS = new Set(['authorize', 'recover', 'db_identity']);
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

      // 1. peer credentials (before any authorization processing)
      const peer = peerCredOf(conn);
      const peerUid = peer?.uid ?? null;
      // Documented root policy: reject root unless the facilitator IS root (never in prod).
      if (peerUid === null || peerUid !== facilitatorUid || peerUid === 0) {
        log(`unauthorized peer uid=${peerUid} gid=${peer?.gid ?? null} pid=${peer?.pid ?? null}`);
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

      // TASK 34.13: owner-mediated recovery. Reads durable records only — never creates,
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
        const ev = approvedEvents[0];
        const mismatches: string[] = [];
        if (ev.payment_digest !== digest) mismatches.push('payment_digest');
        if (ev.network !== String(ctx.network)) mismatches.push('network');
        if (ev.sender !== String(ctx.sender)) mismatches.push('sender');
        if (ev.sponsor !== String(ctx.sponsor)) mismatches.push('sponsor');
        if (ev.recipient !== String(ctx.recipient)) mismatches.push('recipient');
        if (ev.energy !== String(ctx.energy)) mismatches.push('energy');
        if (ev.policy_version !== POLICY.policyVersion) mismatches.push('policy_version');
        // TASK 34.14/34.16: full payment context binding. NULL means the record predates the
        // binding — we cannot prove the context matches, so recovery fails closed. Legacy
        // rows get a distinct reason so operators can tell "unrecoverable legacy record"
        // apart from a genuine context mismatch.
        const legacy = ev.asset === null || ev.amount === null || ev.expiry === null;
        if (ev.asset === null) mismatches.push('asset (missing durable evidence)');
        else if (ev.asset !== String(ctx.asset)) mismatches.push('asset');
        if (ev.amount === null) mismatches.push('amount (missing durable evidence)');
        else if (ev.amount !== String(ctx.amount)) mismatches.push('amount');
        if (ev.expiry === null) mismatches.push('expiry (missing durable evidence)');
        else if (ev.expiry !== Number(ctx.expiry)) mismatches.push('expiry');

        if (mismatches.length > 0) {
          conn.write(JSON.stringify({
            protocolVersion: 1, requestId, outcome: 'unknown',
            reason: legacy ? 'legacy_context_missing' : 'context_mismatch',
            detail: `approval exists but does not match: ${mismatches.join(', ')}`,
          }) + '\n');
          continue;
        }

        // The approval matches. Report the durable authorization result.
        conn.write(JSON.stringify({
          protocolVersion: 1, requestId, outcome: 'approved',
          reason: null,
          detail: 'durable approval verified against request context',
          decidedAt: ev.decided_at,
          policyVersion: ev.policy_version,
        }) + '\n');
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
      });

      // NOTE: signer.authorize() owns its transaction internally; it has already committed
      // when control returns. This point is therefore AFTER commit, before the idempotency
      // record — a genuine pre-commit crash is not reachable without mocking (see report).
      crash(3, 'after authorize() committed, before idempotency record');

      const outcome = result.approved ? 'approved' : 'rejected';
      const r = {
        protocolVersion: 1,
        requestId,
        outcome,
        reason: result.approved ? null : result.reason,
        detail: result.detail ?? null,
        decidedAt: Date.now(),
        policyVersion: POLICY.policyVersion,
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
