/**
 * TASK 34.9 — real SQLite transaction crash owner (test-only).
 *
 * Replicates the authorization transaction with deterministic SIGKILL injection points.
 * Uses a raw DatabaseSync for the transaction (so crash injection can happen BETWEEN
 * BEGIN/reads/insert/COMMIT), but the schema and policy come from the real repository
 * and narrowSponsor modules.
 *
 * Run: npx tsx scripts/task349-owner.mts <db-dir> <socket-path> <facilitator-uid>
 * Env:  CRASH_AT = 1..5 (crash injection point)
 *
 * Crash points:
 *   1: before transaction begins
 *   2: after BEGIN IMMEDIATE, before authorization reads
 *   3: after authorization reads, before insert
 *   4: after insert, before COMMIT
 *   5: after COMMIT + idempotency record, before response
 */

import { createServer } from 'node:net';
import { mkdirSync, chmodSync, rmSync, existsSync, lstatSync, readFileSync, appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { decideAuthorization } from '../services/facilitator/src/narrowSponsor.js';
import { randomUUID } from 'node:crypto';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const POLICY = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v349',
};

const dir = process.argv[2];
const sock = process.argv[3];
const facilitatorUid = Number(process.argv[4] ?? 1001);
const crashAt = Number(process.env.CRASH_AT ?? 0);
const logPath = process.env.TASK349_LOG ?? `${dir}/owner.log`;

if (!dir || !sock) {
  console.error('usage: task349-owner.mts <db-dir> <socket-path> <facilitator-uid>');
  process.exit(2);
}

const log = (line: string) => {
  try { appendFileSync(logPath, line + '\n'); } catch { /* best-effort */ }
};

// socket safety
let st: ReturnType<typeof lstatSync> | null = null;
try { st = lstatSync(sock); } catch { st = null; }
if (st) {
  if (st.isSymbolicLink() || !st.isSocket()) { console.error('unsafe socket path'); process.exit(3); }
  rmSync(sock, { force: true });
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

// Create schema via the real repository (then close — we'll use raw connections for the test tx).
const bootstrap = new SqliteSettlementRepository(`${dir}/auth.db`, { now: () => Date.now() });
bootstrap.close();

// Seed payments via a fresh repo.
const seedRepo = new SqliteSettlementRepository(`${dir}/auth.db`, { now: () => Date.now() });
for (const c of ['a', 'b', 'c', 'd', 'e']) {
  const digest = c.repeat(64);
  seedRepo.noteVerified(digest, 'k');
  seedRepo.claim(digest, 'k');
}
seedRepo.close();

// idempotency store (owner-only, separate DB)
const idemDb = new DatabaseSync(`${dir}/idem.db`);
idemDb.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS idem (
  request_id      TEXT PRIMARY KEY,
  canonical       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  decided_at      INTEGER NOT NULL,
  policy_version  TEXT NOT NULL
);
`);

const canonicalOf = (req: Record<string, unknown>): string => JSON.stringify({
  v: req.protocolVersion,
  op: req.operation,
  pd: req.paymentDigest,
  ctx: req.context,
});

const idemGet = (requestId: string) => {
  return idemDb.prepare('SELECT outcome, reason, decided_at, policy_version FROM idem WHERE request_id = ?').get(requestId) as
    | { outcome: string; reason: string | null; decided_at: number; policy_version: string }
    | undefined;
};

const idemPut = (requestId: string, canonical: string, r: Record<string, unknown>) => {
  idemDb.prepare('INSERT INTO idem (request_id, canonical, outcome, reason, decided_at, policy_version) VALUES (?,?,?,?,?,?)')
    .run(requestId, canonical, String(r.outcome), (r.reason as string) ?? null, Number(r.decidedAt), String(r.policyVersion));
};

const crash = (point: number, why: string) => {
  if (crashAt === point) {
    log(`CRASH_AT=${point} ${why}`);
    process.kill(process.pid, 'SIGKILL');
  }
};

// peer credentials via C helper
import { execFileSync } from 'node:child_process';
const PEERCRED_BIN = process.env.TASK349_PEERCRED_BIN ?? `${process.cwd()}/scripts/task348-peercred`;
const peerCredOf = (conn: import('node:net').Socket): { uid: number } | null => {
  const fd = (conn as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== 'number') return null;
  try {
    const out = execFileSync(PEERCRED_BIN, ['0'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
    return JSON.parse(out.trim()) as { uid: number };
  } catch (e) {
    log(`peercred failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
};

const FACILITATOR_UID = facilitatorUid;

const validate = (req: Record<string, unknown>): { ok: true } | { ok: false; reason: string } => {
  if (typeof req.protocolVersion !== 'number' || req.protocolVersion !== 1) return { ok: false, reason: 'unsupported_protocol' };
  if (typeof req.requestId !== 'string' || req.requestId.length < 1) return { ok: false, reason: 'invalid_field' };
  if (typeof req.operation !== 'string' || req.operation !== 'authorize') return { ok: false, reason: 'unknown_operation' };
  if (typeof req.paymentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(req.paymentDigest)) return { ok: false, reason: 'invalid_field' };
  if (typeof req.context !== 'object' || req.context === null) return { ok: false, reason: 'missing_field' };
  const c = req.context as Record<string, unknown>;
  if (typeof c.network !== 'string' || c.network !== CAIP2) return { ok: false, reason: 'wrong_network' };
  if (typeof c.version !== 'number' || c.version !== 1) return { ok: false, reason: 'wrong_version' };
  if (typeof c.sender !== 'string') return { ok: false, reason: 'invalid_sender' };
  if (typeof c.sponsor !== 'string' || c.sponsor !== SPONSOR) return { ok: false, reason: 'wrong_sponsor' };
  if (typeof c.recipient !== 'string') return { ok: false, reason: 'invalid_recipient' };
  if (typeof c.asset !== 'string' || !POLICY.allowedAssets.includes(c.asset)) return { ok: false, reason: 'unsupported_asset' };
  if (typeof c.amount !== 'string' || !/^[0-9]+$/.test(c.amount)) return { ok: false, reason: 'invalid_field' };
  if (typeof c.expiry !== 'number' || !Number.isInteger(c.expiry)) return { ok: false, reason: 'invalid_field' };
  if (typeof c.energy !== 'string' || !/^[0-9]+$/.test(c.energy)) return { ok: false, reason: 'energy_malformed' };
  return { ok: true };
};

const server = createServer((conn) => {
  let buf = '';
  let bytes = 0;
  const idleTimer = setTimeout(() => conn.destroy(), 30_000);
  conn.on('data', async (chunk) => {
    bytes += chunk.length;
    if (bytes > 65536) { conn.write(JSON.stringify({ outcome: 'protocol_error', reason: 'message_too_large' }) + '\n'); conn.destroy(); return; }
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(line) as Record<string, unknown>;
        if (typeof req !== 'object' || req === null || Array.isArray(req)) throw new Error('not object');
      } catch {
        conn.write(JSON.stringify({ outcome: 'protocol_error', reason: 'malformed_request' }) + '\n');
        continue;
      }
      const requestId = req.requestId as string;

      // peer auth
      const peer = peerCredOf(conn);
      const peerUid = peer?.uid ?? null;
      if (peerUid === null || peerUid !== FACILITATOR_UID || peerUid === 0) {
        log(`unauthorized peer uid=${peerUid}`);
        conn.write(JSON.stringify({ outcome: 'protocol_error', reason: 'unauthorized_peer' }) + '\n');
        continue;
      }

      // validation
      const v = validate(req);
      if (!v.ok) {
        conn.write(JSON.stringify({ outcome: 'rejected', reason: (v as { reason: string }).reason }) + '\n');
        continue;
      }

      const canonical = canonicalOf(req);
      const prior = idemGet(requestId);
      if (prior) {
        const storedCanonical = (idemDb.prepare('SELECT canonical FROM idem WHERE request_id = ?').get(requestId) as { canonical: string }).canonical;
        if (storedCanonical !== canonical) {
          conn.write(JSON.stringify({ outcome: 'rejected', reason: 'request_id_conflict' }) + '\n');
          continue;
        }
        conn.write(JSON.stringify({ outcome: prior.outcome, reason: prior.reason }) + '\n');
        continue;
      }

      const digest = req.paymentDigest as string;
      const c = req.context as Record<string, unknown>;

      crash(1, 'before transaction begins');

      // Open a raw connection for the transaction (schema already exists).
      const db = new DatabaseSync(`${dir}/auth.db`);
      db.exec('PRAGMA busy_timeout = 5000');

      crash(2, 'after BEGIN IMMEDIATE, before authorization reads');
      db.exec('BEGIN IMMEDIATE');

      // read payment state
      const row = db.prepare('SELECT payment_digest, state, tx_hash FROM payments WHERE payment_digest = ?').get(digest) as
        | { payment_digest: string; state: string; tx_hash: string | null }
        | undefined;

      crash(3, 'after authorization reads, before insert');

      let result: { approved: boolean; reason?: string };
      if (!row || row.state !== 'created' || row.tx_hash !== null) {
        result = { approved: false, reason: row ? (row.tx_hash !== null ? 'transaction_hash_already_prepared' : 'payment_not_authorizable') : 'unknown_payment' };
      } else {
        const priorApproved = db.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest = ? AND decision = 'approved'").get(digest) as { n: number };
        if (Number(priorApproved.n) > 0) {
          result = { approved: false, reason: 'authorization_already_recorded' };
        } else {
          // policy check (narrow sponsor)
          const decision = decideAuthorization(
            {
              network: c.network as string,
              version: c.version as number,
              sender: c.sender as string,
              sponsor: c.sponsor as string,
              recipient: c.recipient as string,
              asset: c.asset as string,
              amount: c.amount as string,
              expiry: c.expiry as number,
              energy: BigInt(c.energy as string),
              paymentDigest: digest,
            },
            POLICY,
            Math.floor(Date.now() / 1000),
          );
          if (!decision.approved) {
            // insert rejected event
            db.prepare('INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(digest, Date.now(), 'rejected', decision.reason ?? null, c.network as string, c.sender as string, c.sponsor as string, c.recipient as string, c.energy as string, POLICY.policyVersion);
            result = { approved: false, reason: decision.reason };
          } else {
            // insert approved event
            db.prepare('INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(digest, Date.now(), 'approved', null, c.network as string, c.sender as string, c.sponsor as string, c.recipient as string, c.energy as string, POLICY.policyVersion);
            result = { approved: true };
          }
        }
      }

      crash(4, 'after insert, before COMMIT');

      db.exec('COMMIT');
      db.close();

      // The authorization is now durable. Persist the idempotency record so a retry after a
      // crash-before-response recovers the ORIGINAL result instead of re-deriving one.
      const r = {
        protocolVersion: 1,
        requestId,
        outcome: result.approved ? 'approved' : 'rejected',
        reason: result.approved ? null : result.reason,
        detail: null,
        decidedAt: Date.now(),
        policyVersion: POLICY.policyVersion,
      };
      idemPut(requestId, canonical, r);
      log(`committed + idem persisted for ${requestId}`);

      // Crash point 5: durable commit AND durable idempotency record, but no response yet.
      crash(5, 'after COMMIT and idempotency record, before response');

      conn.write(JSON.stringify(r) + '\n');
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
  process.exit(0);
});
