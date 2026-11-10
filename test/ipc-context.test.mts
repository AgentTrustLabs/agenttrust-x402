/**
 * TASK 34.14 — real IPC context integrity.
 *
 * Starts a live authorization owner, authorizes a payment, then proves that changing any
 * bound payment-context field (amount, asset, expiry, energy, sponsor, recipient, sender,
 * network) makes recovery refuse to return "approved".
 *
 * Run (as the facilitator UID so the socket is reachable):
 *   sudo -u ubuntu npx tsx test/ipc-context.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const OWNER_USER = 'authowner';
const FACILITATOR_UID = 1001;
const FACILITATOR_GID = 1002;
const EXPIRY = Math.floor(Date.now() / 1000) + 600;

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

const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
const gids = typeof process.getgroups === 'function' ? process.getgroups() : [];
if (uid !== FACILITATOR_UID || !gids.includes(FACILITATOR_GID)) {
  console.log(`task34.14 IPC: SKIPPED — requires uid ${FACILITATOR_UID} + group ${FACILITATOR_GID} (uid=${uid}, groups=${gids.join(',')})`);
  console.log('  run: sudo -u ubuntu npx tsx test/ipc-context.test.mts');
  process.exit(0);
}

const base = mkdtempSync(join(tmpdir(), 't3414ipc-'));
const dbDir = join(base, 'ownerdb');
const sock = join(base, 'authz.sock');
const logPath = join(dbDir, 'owner.log');
mkdirSync(dbDir, { mode: 0o700 });
await run('chown', ['-R', `${OWNER_USER}:authclients`, base], 'root');
await run('chmod', ['770', base], 'root');
await run('chmod', ['700', dbDir], 'root');

const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');

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
  ...over,
});

try {
  const owner = spawn('sudo', ['-u', OWNER_USER, 'env', `TASK348_LOG=${logPath}`, `TASK348_PEERCRED_BIN=${peercredBin}`, 'AUTHZ_SEED_FIXTURES=1', 'npx', 'tsx', ownerScript, dbDir, sock, String(FACILITATOR_UID)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), 40000);
    owner.stdout.on('data', (c) => { if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); } });
    owner.on('exit', () => { clearTimeout(t); resolve(); });
  });
  await run('chown', ['authowner:authclients', sock], 'root');
  await run('chmod', ['660', sock], 'root');

  const client = new IpcAuthorizationClient(sock);

  const auth = await client.authorize(req());
  check('01. authorize returns approved', auth.outcome === 'approved', `${auth.outcome}/${auth.reason}`);

  const base2 = await client.recover(req());
  check('02. matching context recovers approved', base2.outcome === 'approved', `${base2.outcome}/${base2.reason}`);

  const cases: Array<[string, Partial<AuthorizationRequest>]> = [
    ['03. amount changed', { amount: '999999' }],
    ['04. asset changed', { asset: 'USDC' }],
    ['05. expiry changed', { expiry: EXPIRY + 1 }],
    ['06. energy changed', { energy: 999n }],
    ['07. sponsor changed', { sponsor: SENDER }],
    ['08. recipient changed', { recipient: SENDER }],
    ['09. sender changed', { sender: RECIPIENT }],
    ['10. network changed', { network: 'ccd:0000' }],
  ];
  for (const [name, over] of cases) {
    const r = await client.recover(req(over));
    check(name, r.outcome !== 'approved', `${r.outcome}/${r.reason}`);
  }

  // Recovery must not create a second approval.
  const reauth = await client.authorize(req());
  check('11. re-authorize still refused', reauth.outcome === 'rejected', `${reauth.outcome}/${reauth.reason}`);

  owner.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  const pg = await run('pgrep', ['-f', `scripts/authz-owner.mts ${base}`], 'root');
  for (const pid of pg.stdout.trim().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) await run('kill', ['-9', pid], 'root');
  }
} catch (e) {
  console.log(`[error] ${(e as Error).message}`);
  process.exit(1);
} finally {
  await run('rm', ['-rf', base], 'root').catch(() => {});
}

const failed = results.filter((r) => !r[1]).length;
console.log(`\ntask34.14 IPC: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
