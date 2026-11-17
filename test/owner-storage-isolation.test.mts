/**
 * Owner storage isolation  — adversarial OS-level tests.
 *
 * Proves the facilitator process cannot modify Owner authorization state
 * even with full write access to its own settlement database:
 *
 *   - Filesystem isolation: the facilitator UID cannot open the Owner
 *     database for writing, cannot modify its WAL/SHM files, cannot read
 *     the Owner private key, and the Owner still performs legitimate
 *     authorization operations. Permission/ownership misconfiguration
 *     prevents production startup.
 *   - Authorization integrity: direct attempts to reset consumed_at, clear
 *     revoked_at, insert a fabricated approval, or replace a valid approval
 *     all fail; replaying a consumed or revoked certificate fails closed;
 *     a wrong-UID Owner IPC peer is rejected; an unavailable/corrupted
 *     Owner database fails closed.
 *   - Concurrency and recovery: concurrent consumption signs exactly once;
 *     restart preserves consumed/revoked state; a crash between consume and
 *     signing never signs twice and recovery is an explicit fresh
 *     authorization; backup/restore preserves consumed+revoked state.
 *
 * Real OS users and a real Owner process (scripts/authz-owner.mts as
 * authowner). No mocked permission checks anywhere: every adversarial
 * attempt runs as the facilitator UID (ubuntu) via sudo.
 *
 * Run as root (like test/ipc-protocol.test.mts): the suite spawns the Owner
 * as authowner and drives the facilitator side as ubuntu. When the required
 * users or sudo are unavailable it SKIPS cleanly (CI is authoritative there).
 *
 * Run: npx tsx test/owner-storage-isolation.test.mts
 */
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { eq, ok } from './helpers.mjs';
import { signingDigestOf } from '../services/facilitator/src/signingService.js';
import type { SigningRequest } from '../services/facilitator/src/signingService.js';
import { IpcOwnerConsumeClient, generateOwnerAuthorizationKeyPair, ownerAuthorizationPublicKeyHex } from '../services/facilitator/src/ownerAuthorization.js';
import type { OwnerAuthorizationCertificate } from '../services/facilitator/src/ownerAuthorization.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { seedSettlementDb } from './owner-authz-helper.mts';
import { recomputedEnergyOf } from './owner-authz-helper.mts';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER_USER = 'authowner';
const FACILITATOR_UID = Number(process.env.TEST_FACILITATOR_UID ?? 1001);
const TEST_UID = typeof process.getuid === 'function' ? process.getuid() : -1;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── gating: real OS users + sudo ─────────────────────────────────────────────
const uidOf = (user: string): number | null => {
  try {
    return Number(execSync(`id -u ${user}`, { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
};
const OWNER_UID = uidOf(OWNER_USER);
const canSudo = (user: string): boolean => {
  const r = spawnSync('sudo', ['-u', user, 'id', '-u'], { encoding: 'utf8' });
  return r.status === 0;
};
// The signing service is a third, distinct UID (authsigner): the Owner and
// the facilitator enforce distinct UIDs for Owner / facilitator / signing
// service, so the signing calls cannot share the facilitator's UID. The
// intruder role stays with authzintruder — never the signing service.
if (TEST_UID !== 0 || OWNER_UID === null || uidOf('ubuntu') === null || uidOf('authsigner') === null || !canSudo(OWNER_USER) || !canSudo('ubuntu') || !canSudo('authsigner')) {
  console.log('owner-storage-isolation: SKIPPED — needs root + users authowner/ubuntu/authsigner + sudo to all three');
  console.log(`  (uid=${TEST_UID}, authowner=${OWNER_UID}, ubuntu=${uidOf('ubuntu')}, authsigner=${uidOf('authsigner')})`);
  console.log('  run as root: npx tsx test/owner-storage-isolation.test.mts');
  process.exit(3);
}
const FAC_UID = uidOf('ubuntu') as number;
const SIGNING_UID = uidOf('authsigner') as number;

// ── helpers ──────────────────────────────────────────────────────────────────
const run = (cmd: string, args: string[], as?: string, timeout = 30000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const full = as ? ['sudo', '-u', as, cmd, ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() });
    });
  });

const attempt = async (op: string, ownerDb: string, keyFile: string, digest?: string) => {
  const r = await run('npx', ['tsx', 'test/iso-attempt.mts', op, ownerDb, keyFile, ...(digest ? [digest] : [])], 'ubuntu', 30000);
  let parsed: { ok?: boolean; detail?: string; rows?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(r.stdout.split('\n').filter(Boolean).pop() ?? '');
  } catch { /* non-JSON output */ }
  return { ...r, parsed };
};

const isoClient = async (sock: string, op: string, digest: string, context?: Record<string, unknown>) => {
  const r = await run('npx', ['tsx', 'test/iso-client.mts', sock, op, digest, ...(context ? [JSON.stringify(context)] : [])], 'ubuntu', 30000);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(r.stdout.split('\n').filter(Boolean).pop() ?? '');
  } catch { /* non-JSON output */ }
  return { ...r, parsed };
};

const dumpAsOwner = async (ownerDb: string, keyFile: string) => {
  const r = await run('npx', ['tsx', 'test/iso-attempt.mts', 'dump', ownerDb, keyFile], OWNER_USER, 30000);
  try {
    return JSON.parse(r.stdout) as { rows: Array<Record<string, unknown>> };
  } catch {
    return { rows: [] };
  }
};

// ── fixture transaction (real-time clock: the Owner runs on real time) ───────
const fixtureTx = (expirySec: number) => ({
  version: 1,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: expirySec,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
});


// ── suite setup: real Owner process as authowner ─────────────────────────────
const base = mkdtempSync(join(tmpdir(), 't111-iso-'));
const ownerDir = join(base, 'ownerdb');
// The socket lives in its own authowner-owned directory: the Owner must be
// able to CREATE the socket file there, and the facilitator UID must be able
// to traverse to it (group authclients). The base dir itself stays
// root-owned 0755 (traversable, not writable by the Owner — the Owner must
// never be able to rename the settlement directory).
const sockDir = join(base, 'sockdir');
mkdirSync(sockDir);
const sock = join(sockDir, 'authz.sock');
const logPath = join(ownerDir, 'owner.log');
const ownerDb = join(ownerDir, 'authz.db');
mkdirSync(ownerDir, { mode: 0o700 });
const ownerKey = generateOwnerAuthorizationKeyPair();
const ownerKeyFile = join(ownerDir, 'owner-key.pem');
writeFileSync(ownerKeyFile, ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
// The settlement database lives in its own directory, readable (0644) but
// not writable by the Owner UID; one facilitator-side connection stays open
// so the WAL -shm exists for the Owner's read-only reads.
const settlementDir = join(base, 'facdb');
mkdirSync(settlementDir);
chmodSync(settlementDir, 0o755);
const settlementDb = join(settlementDir, 'f.db');
seedSettlementDb(settlementDb, ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64)), () => Date.now());
const settlementHolder = new SqliteSettlementRepository(settlementDb, { now: () => Date.now(), fileMode: 0o644 });
void settlementHolder;

const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');

type OwnerProc = { proc: ReturnType<typeof spawn> };
const startOwner = async (dir: string, sockPath: string, crashAt = 0): Promise<OwnerProc> => {
  const proc = spawn('sudo', ['-u', OWNER_USER, 'env',
    `AUTHZ_OWNER_LOG=${join(dir, 'owner.log')}`,
    `AUTHZ_OWNER_PEERCRED_BIN=${peercredBin}`,
    `CRASH_AT=${crashAt}`,
    'AUTHZ_SPONSOR_ADDRESS=' + SPONSOR,
    'AUTHZ_NETWORK=' + NETWORK,
    'AUTHZ_MAX_ENERGY=10000',
    'AUTHZ_MAX_EXPIRY_OFFSET_SECONDS=600',
    'AUTHZ_ALLOWED_ASSETS=CCD',
    'AUTHZ_POLICY_VERSION=isolation-v1',
    `AUTHZ_DB_FILE=${join(dir, 'authz.db')}`,
    `AUTHZ_SETTLEMENT_DB_FILE=${settlementDb}`,
    `AUTHZ_AUTHORIZATION_KEY_FILE=${ownerKeyFile}`,
    'npx', 'tsx', ownerScript, dir, sockPath, String(FAC_UID),
    // Signing-service UID: authsigner, a third UID distinct from both the
    // Owner and the facilitator. The Owner refuses consume from uid 0
    // outright, so the suite's own uid (root, TEST_UID) must never be
    // configured here — signing runs in the iso-sign helper as authsigner
    // (see below).
    String(SIGNING_UID),
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let ready = false;
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), 40000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); }
    });
    proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
  if (!ready) throw new Error(`owner failed to start: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  await run('chgrp', ['authclients', sockPath], 'root');
  await run('chmod', ['660', sockPath], 'root');
  return { proc };
};
const stopOwner = async (o: OwnerProc) => {
  // Kill the whole process GROUP (detached spawn above): SIGTERM to the
  // sudo process alone never reaches the node child through the
  // sudo → npx → sh → node chain, which is why earlier runs leaked Owner
  // processes (50+ found alive after their suites had finished).
  const pid = o.proc.pid;
  if (pid !== undefined) {
    try { process.kill(-pid, 'SIGTERM'); } catch { o.proc.kill('SIGTERM'); }
  } else o.proc.kill('SIGTERM');
  // Wait for the process to actually exit: the Owner checkpoints its WAL
  // on close (SIGTERM handler), and a backup taken while it is still alive
  // would miss rows still in the -wal. SIGKILL only after a grace period.
  const exited = await new Promise<boolean>((resolve) => {
    if (o.proc.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), 10000);
    o.proc.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) {
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGKILL'); } catch { o.proc.kill('SIGKILL'); }
    } else o.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
  }
};

// Owner dir ownership must be the Owner UID before the first start.
await run('chown', ['-R', `${OWNER_USER}:authclients`, ownerDir], 'root');
await run('chmod', ['700', ownerDir], 'root');
await run('chown', [`${OWNER_USER}:authclients`, sockDir], 'root');
await run('chmod', ['770', sockDir], 'root');
await run('chmod', ['755', base], 'root');

let owner = await startOwner(ownerDir, sock);

// Signing service calls run in the iso-sign helper as the signing-service
// UID (authsigner) — see test/iso-sign.mts. An in-process service cannot work:
// this suite runs as root and the Owner refuses consume from uid 0 outright.
// The helper builds a fresh service per call; exactly-once lives in the
// Owner's atomic consumption, so that is sound (each request also carries a
// fresh requestId). totalSignerCalls accumulates the helper's per-call
// signer-invocation counts for the "signer never invoked" assertions.
let totalSignerCalls = 0;
const isoSign = async (req: SigningRequest, mode: 'counting' | 'throwing' = 'counting') => {
  const r = await run('npx', ['tsx', 'test/iso-sign.mts', sock, String(OWNER_UID), ownerAuthorizationPublicKeyHex(ownerKey.publicKey), mode, JSON.stringify(req)], 'authsigner', 30000);
  let parsed: { outcome?: string; reason?: string | null; detail?: string | null; signerCalls?: number } | null = null;
  try {
    parsed = JSON.parse(r.stdout.split('\n').filter(Boolean).pop() ?? '');
  } catch { /* non-JSON output */ }
  totalSignerCalls += parsed?.signerCalls ?? 0;
  return { outcome: parsed?.outcome ?? 'no-response', reason: parsed?.reason ?? (r.stderr.slice(0, 200) || 'no-response'), detail: parsed?.detail ?? null };
};
const sign = (tx: unknown, cert: OwnerAuthorizationCertificate, digest: string) => isoSign(signReq(tx, cert, digest));
const signThrowing = (tx: unknown, cert: OwnerAuthorizationCertificate, digest: string) => isoSign(signReq(tx, cert, digest), 'throwing');

/** Authorize a fresh payment through the real Owner (as the facilitator UID). */
const authorizeFresh = async (digest: string) => {
  // Seed the payment on demand (idempotent): the settlement holder is the
  // facilitator-side connection, so this never touches Owner storage.
  if (settlementHolder.get(digest) === undefined) {
    settlementHolder.noteVerified(digest, 'k');
    settlementHolder.claim(digest, 'k');
  }
  const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
  const context = {
    energy: String(recomputedEnergyOf(tx)),
    transactionDigest: signingDigestOf(tx),
    // Bind the certificate to THIS transaction's expiry. iso-client
    // computes its own default expiry (its spawn time, ~1s later), which
    // would otherwise mismatch the tx expiry at the signing service
    // (authorization_mismatch: certificate expiry does not match).
    expiry: tx.header.expiry,
  };
  const r = await isoClient(sock, 'authorize', digest, context);
  if (r.parsed?.outcome !== 'approved' || !r.parsed?.certificate) {
    throw new Error(`authorize failed: parsed=${JSON.stringify(r.parsed)} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.slice(0, 400))}`);
  }
  return { tx, cert: r.parsed.certificate as OwnerAuthorizationCertificate, digest };
};

/** Authorize against an arbitrary Owner socket (for the restored Owner). */
const authorizeFreshOn = async (sockPath: string, digest: string) => {
  if (settlementHolder.get(digest) === undefined) {
    settlementHolder.noteVerified(digest, 'k');
    settlementHolder.claim(digest, 'k');
  }
  const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
  const r = await isoClient(sockPath, 'authorize', digest, {
    energy: String(recomputedEnergyOf(tx)),
    transactionDigest: signingDigestOf(tx),
    // Same expiry binding as authorizeFresh: the certificate must carry
    // this transaction's expiry, not iso-client's spawn-time default.
    expiry: tx.header.expiry,
  });
  return { outcome: (r.parsed?.outcome as string) ?? 'no-response', raw: r.parsed ?? r.stdout };
};

const signReq = (tx: unknown, cert: OwnerAuthorizationCertificate, digest: string): SigningRequest => ({
  protocolVersion: 3,
  requestId: randomUUID(),
  operation: 'sign',
  digest: signingDigestOf(tx),
  transaction: tx,
  sponsor: SPONSOR,
  network: NETWORK,
  // Protocol v3: `authorization` IS the certificate itself (see
  // SigningRequest + owner-authorization-binding.test.mts). Wrapping it as
  // `{ certificate: cert }` fails structural verification with
  // authorization_invalid ('unexpected certificate field: certificate').
  authorization: cert,
  paymentDigest: digest,
});

// ═══ filesystem isolation ────────────────────────────────────────────────────

test('01. facilitator UID cannot open the Owner database for writing', async () => {
  const r = await attempt('open-rw', ownerDb, ownerKeyFile);
  check('01. facilitator UID cannot open the Owner database for writing', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
});

test('02. facilitator UID cannot reset consumed_at', async () => {
  // First create a consumed approval to reset (legit flow on digest 'b').
  const { tx, cert, digest } = await authorizeFresh('b'.repeat(64));
  const signed = await sign(tx, cert, digest);
  eq(signed.outcome, 'signed', 'legit sign consumed the approval');
  const r = await attempt('reset-consumed', ownerDb, ownerKeyFile, digest);
  check('02. facilitator UID cannot reset consumed_at', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
  // The consumption survived: replay is still refused.
  const replay = await sign(tx, cert, digest);
  check('02b. consumption survived the reset attempt', replay.outcome === 'rejected' && replay.reason === 'authorization_already_consumed', replay.reason ?? '');
});

test('03. facilitator UID cannot clear revoked_at', async () => {
  const { tx, cert, digest } = await authorizeFresh('c'.repeat(64));
  const revoked = await isoClient(sock, 'revoke', cert.authorizationId);
  eq(revoked.parsed?.outcome, 'revoked', `revoke outcome ${JSON.stringify(revoked.parsed)}`);
  const r = await attempt('clear-revoked', ownerDb, ownerKeyFile, digest);
  check('03. facilitator UID cannot clear revoked_at', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
  const replay = await sign(tx, cert, digest);
  check('03b. revocation survived the clear attempt', replay.outcome === 'rejected' && replay.reason === 'authorization_revoked', replay.reason ?? '');
});

test('04. facilitator UID cannot insert a fabricated authorization', async () => {
  const r = await attempt('insert-fabricated', ownerDb, ownerKeyFile, 'd'.repeat(64));
  check('04. facilitator UID cannot insert a fabricated authorization', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
});

test('05. facilitator UID cannot replace a valid authorization record', async () => {
  const { digest } = await authorizeFresh('e'.repeat(64));
  const r = await attempt('replace-row', ownerDb, ownerKeyFile, digest);
  check('05. facilitator UID cannot replace a valid authorization record', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
});

test('06. facilitator UID cannot modify the Owner WAL or SHM files', async () => {
  const w = await attempt('write-wal', ownerDb, ownerKeyFile);
  const s = await attempt('write-shm', ownerDb, ownerKeyFile);
  check('06a. facilitator UID cannot modify the Owner WAL file', w.parsed?.ok !== true, w.parsed?.detail ?? w.stderr ?? 'no output');
  check('06b. facilitator UID cannot modify the Owner SHM file', s.parsed?.ok !== true, s.parsed?.detail ?? s.stderr ?? 'no output');
});

test('07. facilitator UID cannot read the Owner private key', async () => {
  const r = await attempt('read-key', ownerDb, ownerKeyFile);
  check('07. facilitator UID cannot read the Owner private key', r.parsed?.ok !== true, r.parsed?.detail ?? r.stderr ?? 'no output');
});

test('08. Owner database is unchanged after all facilitator attempts', async () => {
  const before = await dumpAsOwner(ownerDb, ownerKeyFile);
  // One more attempt round, then compare.
  await attempt('open-rw', ownerDb, ownerKeyFile);
  await attempt('insert-fabricated', ownerDb, ownerKeyFile, 'f'.repeat(64));
  const after = await dumpAsOwner(ownerDb, ownerKeyFile);
  eq(JSON.stringify(after.rows), JSON.stringify(before.rows), 'no row added, removed, or altered');
  check('08. Owner database is unchanged after all facilitator attempts', JSON.stringify(after.rows) === JSON.stringify(before.rows), `${before.rows.length} row(s) before and after`);
});

test('09. Owner still performs legitimate authorization operations', async () => {
  const { tx, cert, digest } = await authorizeFresh('f'.repeat(64));
  const callsBefore = totalSignerCalls;
  const res = await sign(tx, cert, digest);
  check('09. Owner still performs legitimate authorization operations', res.outcome === 'signed', res.reason ?? '');
  eq(totalSignerCalls - callsBefore, 1, 'signer invoked exactly once for the legit flow in this test');
});

// ═══ startup misconfiguration refuses ────────────────────────────────────────

test('10. startup misconfiguration prevents production startup', async () => {
  const startScratch = (envOver: Record<string, string | undefined>, dirMode: number, dirOwner?: string) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), 't111-miscfg-'));
      const sockPath = join(dir, 'authz.sock');
      const key = join(dir, 'owner-key.pem');
      writeFileSync(key, ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const env: Record<string, string | undefined> = {
        ...process.env,
        AUTHZ_SPONSOR_ADDRESS: SPONSOR,
        AUTHZ_NETWORK: NETWORK,
        AUTHZ_MAX_ENERGY: '10000',
        AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
        AUTHZ_ALLOWED_ASSETS: 'CCD',
        AUTHZ_POLICY_VERSION: 'isolation-v1',
        AUTHZ_DB_FILE: join(dir, 'authz.db'),
        AUTHZ_SETTLEMENT_DB_FILE: settlementDb,
        AUTHZ_AUTHORIZATION_KEY_FILE: key,
        ...envOver,
      };
      // '__SCRATCH__' means "the scratch dir itself" (for the same-directory check).
      if (env.AUTHZ_SETTLEMENT_DB_FILE === '__SCRATCH__') env.AUTHZ_SETTLEMENT_DB_FILE = join(dir, 'f.db');
      for (const [k, v] of Object.entries(envOver)) if (v === undefined) delete env[k];
      chmodSync(dir, dirMode);
      if (dirOwner) spawnSync('sudo', ['-u', 'root', 'chown', dirOwner, dir]);
      const proc = spawn('npx', ['tsx', ownerScript, dir, sockPath, String(FAC_UID), String(TEST_UID)], {
        env: env as Record<string, string>,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: -1, stderr: 'timeout' }); }, 20000);
      proc.on('exit', (code) => {
        clearTimeout(t);
        proc.kill('SIGKILL');
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* e.g. nobody-owned dir */ }
        resolve({ code: code ?? -1, stderr });
      });
    });

  // 10a. Owner directory mode 0777.
  const a = await startScratch({}, 0o777);
  check('10a. Owner directory 0777 refuses startup', a.code === 3 && /mode 0o777/.test(a.stderr), `exit=${a.code} ${a.stderr.slice(0, 120)}`);
  // 10b. Owner DB path == settlement DB path.
  const b = await startScratch({ AUTHZ_DB_FILE: settlementDb }, 0o700);
  check('10b. Owner DB == settlement DB refuses startup', b.code === 3 && /same file/.test(b.stderr), `exit=${b.code} ${b.stderr.slice(0, 120)}`);
  // 10c. Settlement DB in the same directory as the Owner DB.
  const c = await startScratch({ AUTHZ_SETTLEMENT_DB_FILE: '__SCRATCH__' }, 0o700);
  check('10c. settlement DB in the Owner directory refuses startup', c.code === 3 && /same directory|Owner database directory/.test(c.stderr), `exit=${c.code} ${c.stderr.slice(0, 120)}`);
  // 10d. Key file 0644.
  const dirD = mkdtempSync(join(tmpdir(), 't111-miscfg-d-'));
  const keyD = join(dirD, 'owner-key.pem');
  writeFileSync(keyD, ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
  const dProc = spawn('npx', ['tsx', ownerScript, dirD, join(dirD, 'authz.sock'), String(FAC_UID), String(TEST_UID)], {
    env: {
      ...process.env,
      AUTHZ_SPONSOR_ADDRESS: SPONSOR,
      AUTHZ_NETWORK: NETWORK,
      AUTHZ_MAX_ENERGY: '10000',
      AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
      AUTHZ_ALLOWED_ASSETS: 'CCD',
      AUTHZ_POLICY_VERSION: 'isolation-v1',
      AUTHZ_DB_FILE: join(dirD, 'authz.db'),
      AUTHZ_SETTLEMENT_DB_FILE: settlementDb,
      AUTHZ_AUTHORIZATION_KEY_FILE: keyD,
    } as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dRes = await new Promise<{ code: number; stderr: string }>((resolve) => {
    let stderr = '';
    dProc.stderr.on('data', (x) => { stderr += x.toString(); });
    const t = setTimeout(() => { dProc.kill('SIGKILL'); resolve({ code: -1, stderr: 'timeout' }); }, 20000);
    dProc.on('exit', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stderr }); });
  });
  rmSync(dirD, { recursive: true, force: true });
  check('10d. key file 0644 refuses startup', dRes.code === 3 && /authorization key/i.test(dRes.stderr), `exit=${dRes.code} ${dRes.stderr.slice(0, 120)}`);
  // 10e. Owner directory owned by the wrong UID.
  const e = await startScratch({}, 0o700, 'nobody');
  check('10e. Owner directory owned by the wrong UID refuses startup', e.code === 3 && /owned by uid/.test(e.stderr), `exit=${e.code} ${e.stderr.slice(0, 120)}`);
  // 10f. Settlement DB holding legacy authorization rows.
  const legacyDir = mkdtempSync(join(tmpdir(), 't111-legacy-'));
  const legacyDb = join(legacyDir, 'legacy.db');
  {
    const raw = new DatabaseSync(legacyDb);
    raw.exec(`CREATE TABLE payments (payment_digest TEXT PRIMARY KEY, requirements_key TEXT NOT NULL, state TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sign_events (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_digest TEXT NOT NULL, decided_at INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT, network TEXT NOT NULL, sender TEXT NOT NULL, sponsor TEXT NOT NULL, recipient TEXT NOT NULL, energy TEXT NOT NULL, policy_version TEXT NOT NULL);`);
    raw.prepare("INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?, 1, 'approved', NULL, ?, ?, ?, ?, '1', 'v')").run('a'.repeat(64), NETWORK, SENDER, SPONSOR, RECIPIENT);
    raw.close();
    chmodSync(legacyDb, 0o644);
  }
  const f = await startScratch({ AUTHZ_SETTLEMENT_DB_FILE: legacyDb }, 0o700);
  rmSync(legacyDir, { recursive: true, force: true });
  check('10f. settlement DB with legacy authorization rows refuses startup', f.code === 3 && /legacy sign_events/.test(f.stderr), `exit=${f.code} ${f.stderr.slice(0, 120)}`);
});

// ═══ authorization integrity through the real Owner ──────────────────────────

test('11. replay of a consumed certificate after an Owner restart is rejected', async () => {
  const { tx, cert, digest } = await authorizeFresh('a'.repeat(64));
  // 'a' was authorized fresh here; sign once (consumes), restart the Owner, replay.
  const first = await sign(tx, cert, digest);
  eq(first.outcome, 'signed', 'first sign consumed the approval');
  const callsBefore = totalSignerCalls;
  await stopOwner(owner);
  owner = await startOwner(ownerDir, sock);
  const replay = await sign(tx, cert, digest);
  check('11. replay of a consumed certificate after an Owner restart is rejected', replay.outcome === 'rejected' && replay.reason === 'authorization_already_consumed', replay.reason ?? '');
  eq(totalSignerCalls, callsBefore, 'restarted Owner never signed again');
});

test('12. replay of a revoked certificate is rejected', async () => {
  const { tx, cert, digest } = await authorizeFresh('d'.repeat(64));
  const revoked = await isoClient(sock, 'revoke', cert.authorizationId);
  eq(revoked.parsed?.outcome, 'revoked', `revoke outcome ${JSON.stringify(revoked.parsed)}`);
  const callsBefore = totalSignerCalls;
  const res = await sign(tx, cert, digest);
  check('12. replay of a revoked certificate is rejected', res.outcome === 'rejected' && res.reason === 'authorization_revoked', res.reason ?? '');
  eq(totalSignerCalls, callsBefore, 'signer never invoked for a revoked approval');
});

test('13. signing service rejects an Owner IPC peer with the wrong UID', async () => {
  // A fake Owner socket served by the facilitator UID (ubuntu): the consume
  // client must reject the peer BEFORE sending the consume request.
  const fakeSock = join(sockDir, 'fake-owner.sock');
  const fakeProc = spawn('sudo', ['-u', 'ubuntu', 'npx', 'tsx', '-e', `
    import { createServer } from 'node:net';
    const srv = createServer((conn) => { conn.on('data', () => {}); });
    srv.listen(${JSON.stringify(fakeSock)}, () => console.log('fake listening'));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const consume = new IpcOwnerConsumeClient({ socketPath: fakeSock, ownerUid: OWNER_UID as number });
    // IpcOwnerConsumeClient.consume() NEVER throws on a peer mismatch: it
    // resolves { outcome: 'protocol_error', reason: 'unauthorized_peer' }
    // (fail-closed by return value, see ownerAuthorization.ts). Assert on
    // the returned outcome, not on a thrown error.
    const res = await consume.consume({
      authorizationId: randomUUID(),
      transactionDigest: 'c'.repeat(64),
      paymentDigest: 'a'.repeat(64),
      context: {
        network: NETWORK, version: 1, sender: SENDER, sponsor: SPONSOR,
        recipient: RECIPIENT, asset: 'CCD', amount: '250000', expiry: Math.floor(Date.now() / 1000) + 200,
        energy: 3000n, transactionDigest: 'c'.repeat(64), transactionType: 'transfer', maxFeeMicroCcd: '10000000',
      },
    });
    check('13. signing service rejects an Owner IPC peer with the wrong UID', res.outcome === 'protocol_error' && res.reason === 'unauthorized_peer', `${res.outcome}/${res.reason ?? '-'}`);
  } finally {
    fakeProc.kill('SIGKILL');
    rmSync(fakeSock, { force: true });
  }
});

test('14. Owner database unavailable or corrupted fails closed', async () => {
  // 14a. Owner dead → consume fails closed, signer never invoked.
  const { tx, cert, digest } = await authorizeFresh('1'.repeat(64));
  await stopOwner(owner);
  const callsBefore = totalSignerCalls;
  const res = await sign(tx, cert, digest);
  check('14a. Owner dead fails closed (owner_unavailable)', res.outcome === 'owner_unavailable', `${res.outcome}/${res.reason ?? '-'}`);
  eq(totalSignerCalls, callsBefore, 'signer never invoked while the Owner is down');
  // 14b. Corrupted Owner database → the Owner refuses to start.
  owner = await startOwner(ownerDir, sock);
  const corruptDir = mkdtempSync(join(tmpdir(), 't111-corrupt-'));
  const corruptDb = join(corruptDir, 'authz.db');
  writeFileSync(corruptDb, Buffer.from('this is not a sqlite database at all, just garbage bytes'));
  chmodSync(corruptDb, 0o600);
  const keyCopy = join(corruptDir, 'owner-key.pem');
  copyFileSync(ownerKeyFile, keyCopy);
  chmodSync(keyCopy, 0o600);
  const proc = spawn('npx', ['tsx', ownerScript, corruptDir, join(corruptDir, 'authz.sock'), String(FAC_UID), String(TEST_UID)], {
    env: {
      ...process.env,
      AUTHZ_SPONSOR_ADDRESS: SPONSOR,
      AUTHZ_NETWORK: NETWORK,
      AUTHZ_MAX_ENERGY: '10000',
      AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
      AUTHZ_ALLOWED_ASSETS: 'CCD',
      AUTHZ_POLICY_VERSION: 'isolation-v1',
      AUTHZ_DB_FILE: corruptDb,
      AUTHZ_SETTLEMENT_DB_FILE: settlementDb,
      AUTHZ_AUTHORIZATION_KEY_FILE: keyCopy,
    } as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 20000);
    proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  rmSync(corruptDir, { recursive: true, force: true });
  check('14b. corrupted Owner database refuses startup', code !== 0, `exit=${code}`);
});

// ═══ concurrency and recovery ────────────────────────────────────────────────

test('15. concurrent consumption signs exactly once', async () => {
  const { tx, cert, digest } = await authorizeFresh('2'.repeat(64));
  const callsBefore = totalSignerCalls;
  const outs = await Promise.all(
    Array.from({ length: 8 }, () => sign(tx, cert, digest)),
  );
  const signed = outs.filter((o) => o.outcome === 'signed').length;
  check('15. concurrent consumption signs exactly once', signed === 1, `${signed} signed of 8`);
  eq(totalSignerCalls - callsBefore, 1, 'signer invoked exactly once');
});

test('16. crash between consume and signing never signs twice; recovery is a fresh authorization', async () => {
  // A signer that throws AFTER the service has consumed the approval
  // simulates a crash between consume and signing (helper mode 'throwing').
  const digest = '3'.repeat(64);
  const { tx, cert } = await authorizeFresh(digest);
  const first = await signThrowing(tx, cert, digest);
  check('16a. crash after consume surfaces as a failure, not a silent sign', first.outcome !== 'signed', `${first.outcome}/${first.reason ?? '-'}`);
  // The approval is consumed: a second sign with the same certificate must
  // fail closed without reaching any signer.
  const callsBefore = totalSignerCalls;
  const second = await sign(tx, cert, digest);
  check('16b. replay after the crash is rejected (already consumed)', second.outcome === 'rejected' && second.reason === 'authorization_already_consumed', second.reason ?? '');
  eq(totalSignerCalls, callsBefore, 'no signer invoked on the replay');
  // Recovery is explicit: a FRESH authorization for the same payment
  // (still created, NULL hash in the settlement DB) signs exactly once.
  const fresh = await authorizeFresh(digest);
  const recovered = await sign(fresh.tx, fresh.cert, fresh.digest);
  check('16c. recovery via a fresh authorization signs exactly once', recovered.outcome === 'signed', recovered.reason ?? '');
});

test('17. backup and restore preserve consumed and revoked state', async () => {
  // Stop the Owner first: a live WAL copy is not a consistent snapshot.
  // With the Owner stopped the last connection closes, the WAL checkpoints,
  // and authz.db alone is the full state.
  await stopOwner(owner);
  const backupDir = mkdtempSync(join(tmpdir(), 't111-backup-'));
  await run('cp', [ownerDb, join(backupDir, 'authz.db')], 'root');
  // A WAL-mode backup must include the -wal when one is present: rows not
  // yet checkpointed live only there, and a db-only copy silently loses
  // them (that is what 17a/17b measured before this fix). After a clean
  // stop the WAL is normally checkpointed away, so this is belt-and-braces.
  if (existsSync(`${ownerDb}-wal`)) await run('cp', [`${ownerDb}-wal`, join(backupDir, 'authz.db-wal')], 'root');
  owner = await startOwner(ownerDir, sock);
  const restoreDir = mkdtempSync(join(tmpdir(), 't111-restore-'));
  await run('cp', [join(backupDir, 'authz.db'), join(restoreDir, 'authz.db')], 'root');
  if (existsSync(join(backupDir, 'authz.db-wal'))) await run('cp', [join(backupDir, 'authz.db-wal'), join(restoreDir, 'authz.db-wal')], 'root');
  await run('chown', ['-R', `${OWNER_USER}:authclients`, restoreDir], 'root');
  await run('chmod', ['700', restoreDir], 'root');
  const restoreSock = join(sockDir, 'restore.sock');
  const restored = await startOwner(restoreDir, restoreSock);
  try {
    const dump = await dumpAsOwner(join(restoreDir, 'authz.db'), ownerKeyFile);
    const consumed = dump.rows.filter((r) => r.consumed_at !== null);
    const revoked = dump.rows.filter((r) => r.revoked_at !== null);
    check('17a. restored database preserves consumed state', consumed.length >= 1, `${consumed.length} consumed row(s)`);
    check('17b. restored database preserves revoked state', revoked.length >= 1, `${revoked.length} revoked row(s)`);
    // And the restored Owner still authorizes a fresh payment.
    const fresh = await authorizeFreshOn(restoreSock, '4'.repeat(64));
    check('17c. restored Owner still authorizes fresh payments', fresh.outcome === 'approved', JSON.stringify(fresh));
  } finally {
    await stopOwner(restored);
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(restoreDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ═══ runner ═════════════════════════════════════════════════════════════════

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  const failedChecks = results.filter((r) => !r[1]).length;
  console.log(`\nowner-storage-isolation: ${tests.length - failed}/${tests.length} tests passed, ${failed} threw, ${failedChecks} failed checks`);
  await stopOwner(owner).catch(() => {});
  try { settlementHolder.close(); } catch { /* already closed */ }
  rmSync(base, { recursive: true, force: true });
  process.exit(failed || failedChecks ? 1 : 0);
})();
