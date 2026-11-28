/**
 * Real IPC recovery probe.
 *
 * Starts a live authorization owner, authorizes a payment, then recovers it over IPC and
 * probes mismatch / absence / rejection cases. Verifies the owner never writes a record
 * during recovery.
 *
 * Run (as the facilitator UID so the socket is reachable):
 *   sudo -u ubuntu npx tsx test/ipc-recovery.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { generateOwnerAuthorizationKeyPair } from '../services/facilitator/src/ownerAuthorization.js';
import { seedSettlementDb } from './owner-authz-helper.mts';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { requireFacilitatorProcess } from './os-identity.mts';
import { IpcAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const OWNER_USER = 'authowner';
// Fixed expiry: the request must be byte-identical across authorize and recover. Using the
// live clock here would change `expiry` between calls and (correctly) fail recovery now that
// Expiry is bound into the durable record.
const EXPIRY = Math.floor(Date.now() / 1000) + 200;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const run = (cmd: string, args: string[], as?: string, timeout = 30000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const full = as ? ['sudo', '-u', as, cmd, ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() }); });
  });

// The owner authorizes ONLY the facilitator UID over SO_PEERCRED. The connecting
// process must therefore run as the facilitator OS user (ubuntu) AND hold the
// authclients group, which the socket grants connect permission to. The
// identity is resolved at runtime (see os-identity.mts); a wrong identity
// exits 3 (SKIPPED) instead of failing falsely. Run the full peer check:
// sudo -u ubuntu npx tsx test/ipc-recovery.test.mts
const FACILITATOR_UID = requireFacilitatorProcess('ipc-recovery');

const base = mkdtempSync(join(tmpdir(), 't3413ipc-'));
const dbDir = join(base, 'ownerdb');
const sock = join(base, 'authz.sock');
const logPath = join(dbDir, 'owner.log');
mkdirSync(dbDir, { mode: 0o700 });
// the Owner needs an authorization-signing key. Ephemeral for this run.
// Write it BEFORE chowning the dir to the Owner: a non-root test user
// (CI runner) cannot write into a 0700 dir owned by another uid.
const ownerKeyFile = join(dbDir, 'owner-key.pem');
writeFileSync(ownerKeyFile, generateOwnerAuthorizationKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await run('chown', ['-R', `${OWNER_USER}:authclients`, base], 'root');
await run('chmod', ['770', base], 'root');
await run('chmod', ['700', dbDir], 'root');
// the Owner never seeds the settlement database
// (AUTHZ_SEED_FIXTURES was removed). Seed digests a..e directly, in a
// SEPARATE directory the Owner can read (0644) but not write.
const settlementDir = join(base, 'facdb');
mkdirSync(settlementDir);
// The Owner UID must traverse this directory: the test runs as root with
// umask 0007, so a default mkdir is 0770 root:root and authowner cannot
// reach the settlement file inside it.
chmodSync(settlementDir, 0o755);
const settlementDb = join(settlementDir, 'f.db');
seedSettlementDb(settlementDb, ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64)), () => Date.now());
// The Owner opens the settlement database read-only. A read-only open of a
// WAL database must create the -shm wal-index when none exists, which needs
// write access to the directory — the Owner UID has neither. Holding one
// facilitator-side connection open keeps the -shm present (world-readable),
// so the Owner's read-only reads work. In production the facilitator server
// holds its store open for its lifetime, so this holds naturally; the Owner
// still never opens the settlement database read-write.
// fileMode 0644: the repository tightens db/-wal/-shm to 0600 on open by
// default, which would lock the Owner UID out again. 0644 is test-only
// (temp dir); production uses 0644 (see repository.ts F7).
const settlementHolder = new SqliteSettlementRepository(settlementDb, { now: () => Date.now(), fileMode: 0o644 });
void settlementHolder;


const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');
const owner = spawn('sudo', ['-u', OWNER_USER, 'env', `AUTHZ_OWNER_LOG=${logPath}`, `AUTHZ_OWNER_PEERCRED_BIN=${peercredBin}`, `AUTHZ_DB_FILE=${join(dbDir, 'authz.db')}`, `AUTHZ_SETTLEMENT_DB_FILE=${settlementDb}`, `AUTHZ_AUTHORIZATION_KEY_FILE=${ownerKeyFile}`, 'npx', 'tsx', ownerScript, dbDir, sock, String(FACILITATOR_UID)], { stdio: ['ignore', 'pipe', 'pipe'] });
let ownerErr = '';
let ready = false;
owner.stderr.on('data', (c) => (ownerErr += c));
await new Promise<void>((resolve) => {
  const t = setTimeout(() => resolve(), 40000);
  owner.stdout.on('data', (c) => { if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); } });
  owner.on('exit', (c) => { clearTimeout(t); if (!ready) { console.log(`owner exited early code=${c}\n${ownerErr.slice(0, 1500)}`); resolve(); } });
});
await run('chown', ['authowner:authclients', sock], 'root');
await run('chmod', ['660', sock], 'root');

const client = new IpcAuthorizationClient(sock);
const req = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  paymentDigest: 'a'.repeat(64),
  network: CAIP2,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  asset: 'CCD',
  amount: '250000',
  expiry: EXPIRY,
  energy: 3000n,
  transactionDigest: 'cd'.repeat(32),
  transactionType: 'transfer',
  maxFeeMicroCcd: '10000000',
  ...over,
});

try {
  // 1. authorize (the harness owner seeds 'a'*64 as a created payment)
  const auth = await client.authorize(req());
  check('01. authorize returns approved', auth.outcome === 'approved', `${auth.outcome}/${auth.reason}`);

  // 2. recover the same payment → approved
  const rec = await client.recover(req());
  check('02. recovery returns approved', rec.outcome === 'approved', `${rec.outcome}/${rec.reason}`);

  // 3. recover with a mismatched sponsor → not approved
  const badSponsor = await client.recover(req({ sponsor: SENDER }));
  check('03. mismatched sponsor is not approved', badSponsor.outcome !== 'approved', `${badSponsor.outcome}/${badSponsor.reason}`);

  // 4. recover with a mismatched energy → not approved
  const badEnergy = await client.recover(req({ energy: 999n }));
  check('04. mismatched energy is not approved', badEnergy.outcome !== 'approved', `${badEnergy.outcome}/${badEnergy.reason}`);

  // 5. recover an unknown payment → unknown
  const unknown = await client.recover(req({ paymentDigest: 'f'.repeat(64) }));
  check('05. unknown payment → unknown', unknown.outcome === 'unknown', `${unknown.outcome}/${unknown.reason}`);

  // 6. recovery must not create a second record: recover again and re-authorize
  const again = await client.recover(req());
  check('06. repeated recovery stays approved', again.outcome === 'approved', `${again.outcome}/${again.reason}/${again.detail ?? ''}`);
  const reauth = await client.authorize(req());
  check('07. re-authorize is refused (no second approval)', reauth.outcome === 'rejected', `${reauth.outcome}/${reauth.reason}`);
  eq(reauth.reason, 'authorization_already_recorded', 'durable gate refused');
} finally {
  owner.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  const pg = await run('pgrep', ['-f', `scripts/authz-owner.mts ${base}`], 'root');
  for (const pid of pg.stdout.trim().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) await run('kill', ['-9', pid], 'root');
  }
  await run('rm', ['-rf', base], 'root');
}

const failed = results.filter((r) => !r[1]).length;
console.log(`\nipc-recovery: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
