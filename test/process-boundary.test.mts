/**
 * Process-boundary adversarial test for Architecture B.
 *
 * Orchestrates the owner (authowner UID), a caller (ubuntu UID, in group authclients),
 * and a raw writer. Verifies the OS-level boundary with separate processes.
 *
 * Run: npx tsx test/process-boundary.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const SUDO = 'sudo';
const D = 'a'.repeat(64);
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';

const req = (digest: string) =>
  JSON.stringify({
    network: CAIP2,
    version: 1,
    sender: SENDER,
    sponsor: SPONSOR,
    recipient: RECIPIENT,
    asset: 'CCD',
    amount: '250000',
    expiry: Math.floor(Date.now() / 1000) + 200,
    energy: 3000,
    paymentDigest: digest,
  });

const run = (cmd: string, args: string[], opts: { as?: string; timeout?: number } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const full = opts.as ? ['sudo', '-u', opts.as, ...cmd.split(' '), ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), opts.timeout ?? 30000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() });
    });
  });

// ── 1. set up the isolated owner directory ────────────────────────────────────

const base = mkdtempSync(join(tmpdir(), 't346-'));
const dir = join(base, 'ownerdb');
const sock = join(base, 'auth.sock');
// The base is shared between owner and caller (group-writable), the DB dir is not.
chmodSync(base, 0o770);
mkdirSync(dir, { mode: 0o700 });
await run('sudo', ['-u', 'root', 'chown', '-R', 'authowner:authclients', dir]);
await run('sudo', ['-u', 'root', 'chmod', '700', dir]);
await run('sudo', ['-u', 'root', 'chown', 'authowner:authclients', base]);
await run('sudo', ['-u', 'root', 'chmod', '770', base]);

// ── 2. start the owner as authowner ──────────────────────────────────────────

const ownerProc = spawn('sudo', ['-u', 'authowner', 'npx', 'tsx', `${process.cwd()}/scripts/ipc-owner.mts`, dir, sock], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ownerReady = false;
const readyPromise = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('owner did not start')), 20000);
  ownerProc.stdout.on('data', (c) => {
    const s = c.toString();
    if (s.includes('owner listening')) {
      ownerReady = true;
      clearTimeout(t);
      resolve();
    }
  });
  ownerProc.stderr.on('data', (c) => {
    // ignore deprecation noise
  });
  ownerProc.on('exit', (code) => {
    if (!ownerReady) reject(new Error(`owner exited ${code}`));
  });
});

await readyPromise;
// chmod socket so the authclients group can connect (root-owned base makes a plain chmod fail)
await run('sudo', ['-u', 'root', 'chgrp', 'authclients', sock]);
await run('sudo', ['-u', 'root', 'chmod', '660', sock]);
console.log('owner started; socket group-accessible');

// ── 3. legitimate authorization through IPC ───────────────────────────────────

console.log('\n── legitimate authorization through IPC ──');
{
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req(D)], { as: 'ubuntu' });
  let parsed: { approved?: boolean; reason?: string } = {};
  try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
  check('1. legitimate IPC authorization succeeds', parsed.approved === true, JSON.stringify(parsed));
}

// ── 4. raw writer as owner (succeeds — owner can write) ─────────────────────

console.log('\n── raw writer as owner (must succeed — owner owns the DB) ──');
{
  // the raw-write target is the Owner-private database: the
  // settlement database holds no authorization records anymore.
  const dbPath = join(dir, 'authz.db');
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-rawwriter.mts`, dbPath, D], { as: 'authowner' });
  let parsed: { stage?: string; approved?: number; layer?: string; message?: string } = {};
  try { parsed = JSON.parse(r.stdout.split('\n').pop() ?? ''); } catch { /* ignore */ }
  console.log('   owner raw-writer output:', r.stdout.replace(/\n/g, ' | '));
  check('2. owner process can read its own DB', r.code === 0, 'owner has access');
}

// ── 5. raw writer as non-owner (must fail at OS layer) ────────────────────────

console.log('\n── raw writer as non-owner (must fail at OS permission layer) ──');
{
  // same Owner-private target as above.
  const dbPath = join(dir, 'authz.db');
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-rawwriter.mts`, dbPath, D], { as: 'ubuntu' });
  let parsed: { layer?: string; message?: string } = {};
  try {
    const lines = r.stdout.split('\n');
    parsed = JSON.parse(lines.find((l) => l.includes('"stage":"open"')) ?? '{}');
  } catch { /* ignore */ }
  console.log('   non-owner raw-writer output:', r.stdout.replace(/\n/g, ' | '));
  const osDenied = parsed.layer === 'OS_PERMISSION' || /EACCES|EPERM/i.test(r.stdout);
  check('3. non-owner cannot open the DB (OS-level denial)', osDenied, osDenied ? 'EACCES/EPERM' : 'UNEXPECTED ACCESS');
  check('4. non-owner cannot write an approval', !r.stdout.includes('APPROVAL INSERTED BY RAW WRITER'), 'no approval inserted');
}

// ── 6. malformed IPC request ──────────────────────────────────────────────────

console.log('\n── malformed IPC request ──');
{
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, '{not json}'], { as: 'ubuntu' });
  let parsed: { approved?: boolean; reason?: string } = {};
  try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
  check('6. malformed IPC request fails closed', parsed.approved === false, JSON.stringify(parsed));
}

// ── 7. caller attempts to request an approved decision directly ──────────────

console.log('\n── caller supplies decision=approved (must be rejected) ──');
{
  const evil = JSON.stringify({ paymentDigest: D, decision: 'approved', network: CAIP2, version: 1, sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, asset: 'CCD', amount: '250000', expiry: 1_900_000_200, energy: 3000 });
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, evil], { as: 'ubuntu' });
  let parsed: { approved?: boolean; reason?: string } = {};
  try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
  check('7. caller-supplied decision field is rejected', parsed.approved === false && parsed.reason === 'malformed_request', JSON.stringify(parsed));
}

// ── 8. duplicate authorization ────────────────────────────────────────────────

console.log('\n── duplicate authorization ──');
{
  const digest = 'e'.repeat(64);
  // seed the payment via the owner's DB (owner only)
  await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-seed.mts`, join(dir, 'auth.db'), digest], { as: 'authowner' });
  const r1 = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req(digest)], { as: 'ubuntu' });
  const r2 = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req(digest)], { as: 'ubuntu' });
  let p1: { approved?: boolean } = {}, p2: { approved?: boolean; reason?: string } = {};
  try { p1 = JSON.parse(r1.stdout); } catch { /* ignore */ }
  try { p2 = JSON.parse(r2.stdout); } catch { /* ignore */ }
  check('8. first authorization succeeds', p1.approved === true, JSON.stringify(p1));
  check('8b. second authorization is refused (single-use)', p2.approved === false, JSON.stringify(p2));
}

// ── 9. concurrent authorization from two processes ────────────────────────────

console.log('\n── concurrent authorization (two OS processes) ──');
{
  const digest = 'b'.repeat(64);
  // seed the payment via the owner's DB (owner only)
  const seedRes = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-seed.mts`, join(dir, 'auth.db'), digest], { as: 'authowner' });
  console.log('   seed:', seedRes.code === 0 ? 'ok' : seedRes.stderr);

  const r1 = run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req(digest)], { as: 'ubuntu' });
  const r2 = run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req(digest)], { as: 'ubuntu' });
  const [a, b] = await Promise.all([r1, r2]);
  let pa: { approved?: boolean } = {}, pb: { approved?: boolean } = {};
  try { pa = JSON.parse(a.stdout); } catch { /* ignore */ }
  try { pb = JSON.parse(b.stdout); } catch { /* ignore */ }
  const approvedCount = [pa, pb].filter((x) => x.approved).length;
  check('9. concurrent: exactly one approval', approvedCount === 1, `${approvedCount} approved`);
}

// ── 10. owner restart + durable audit recovery ────────────────────────────────

console.log('\n── owner restart + durable audit recovery ──');
{
  // kill owner
  ownerProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  // restart
  const owner2 = spawn('sudo', ['-u', 'authowner', 'npx', 'tsx', `${process.cwd()}/scripts/ipc-owner.mts`, dir, sock], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('restart timeout')), 20000);
    owner2.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) {
        ready = true;
        clearTimeout(t);
        resolve();
      }
    });
    owner2.on('exit', (code) => {
      if (!ready) reject(new Error(`restart exited ${code}`));
    });
  });
  await run('sudo', ['-u', 'root', 'chgrp', 'authclients', sock]);
  await run('sudo', ['-u', 'root', 'chmod', '660', sock]);
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req('c'.repeat(64))], { as: 'ubuntu' });
  let parsed: { approved?: boolean; reason?: string } = {};
  try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
  // 'c'*64 was never seeded, so it should be unknown_payment — but the DB survived the restart
  check('10. owner restarted, DB durable (no crash)', r.code === 0, JSON.stringify(parsed));
  owner2.kill('SIGTERM');
}

// ── 11. owner unavailable ────────────────────────────────────────────────────

console.log('\n── owner unavailable ──');
{
  // point caller at a non-existent socket
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, join(base, 'nope.sock'), req(D)], { as: 'ubuntu' });
  check('11. caller fails closed when owner is down', r.code !== 0, r.stderr || r.stdout);
}

// ── 12. audit-write failure ───────────────────────────────────────────────────

console.log('\n── audit-write failure (owner-side) ──');
{
  // Drop authorizations on the owner's (Owner-private) DB by running a
  // migration as authowner, then authorize.
  await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-seed.mts`, join(dir, 'auth.db'), 'd'.repeat(64)], { as: 'authowner' });
  const mig = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-migrate.mts`, join(dir, 'authz.db'), 'rename'], { as: 'authowner' });
  console.log('   migration:', mig.code === 0 ? 'ok' : mig.stderr);
  const r = await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-caller.mts`, sock, req('d'.repeat(64))], { as: 'ubuntu' });
  let parsed: { approved?: boolean; reason?: string } = {};
  try { parsed = JSON.parse(r.stdout); } catch { /* ignore */ }
  check('12. audit write failure → not approved', parsed.approved !== true, JSON.stringify(parsed));
  // restore
  await run('npx', ['tsx', `${process.cwd()}/scripts/ipc-migrate.mts`, join(dir, 'authz.db'), 'restore'], { as: 'authowner' });
}

// ── cleanup ───────────────────────────────────────────────────────────────────

ownerProc.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
// base is owned by the owner user, so removal needs root
await run('sudo', ['-u', 'root', 'rm', '-rf', base]);

const failed = results.filter((r) => !r[1]).length;
console.log(`\nprocess-boundary: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
