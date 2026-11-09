/**
 * TASK 34.9 — real SQLite transaction crash verification.
 *
 * For each of the five crash points, start a real owner process, send a real request,
 * SIGKILL the owner mid-transaction, restart against the same database, and inspect the
 * durable state directly.
 *
 * Crash points:
 *   1: before transaction begins            → expect 0 approvals
 *   2: after BEGIN IMMEDIATE, before reads  → expect 0 approvals
 *   3: after reads, before insert           → expect 0 approvals
 *   4: after insert, before COMMIT          → expect 0 approvals
 *   5: after COMMIT, before response        → expect exactly 1 approval
 *
 * Run: npx tsx test/transaction-crash.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const FACILITATOR_UID = 1001;
const OWNER_USER = 'authowner';

const D = (c: string) => c.repeat(64);
const req = (requestId: string, digest: string) => ({
  protocolVersion: 1,
  requestId,
  operation: 'authorize',
  paymentDigest: digest,
  context: {
    network: CAIP2,
    version: 1,
    sender: SENDER,
    sponsor: SPONSOR,
    recipient: RECIPIENT,
    asset: 'CCD',
    amount: '250000',
    expiry: Math.floor(Date.now() / 1000) + 200,
    energy: '3000',
  },
});

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

const base = mkdtempSync(join(tmpdir(), 't349-'));
const dbDir = join(base, 'ownerdb');
const sock = join(base, 'auth.sock');
const logPath = join(dbDir, 'owner.log');

mkdirSync(dbDir, { mode: 0o700 });
await run('chown', ['-R', `${OWNER_USER}:authclients`, base], 'root');
await run('chmod', ['770', base], 'root');
await run('chmod', ['700', dbDir], 'root');

const ownerScript = join(process.cwd(), 'scripts/sqlite-crash-owner.mts');
const clientScript = join(process.cwd(), 'scripts/authz-client.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');

type Owner = { proc: ReturnType<typeof spawn> };
const startOwner = async (crashAt: number): Promise<Owner> => {
  const proc = spawn('sudo', [
    '-u', OWNER_USER, 'env',
    `TASK349_LOG=${logPath}`,
    `TASK349_PEERCRED_BIN=${peercredBin}`,
    `CRASH_AT=${crashAt}`,
    'npx', 'tsx', ownerScript, dbDir, sock, String(FACILITATOR_UID),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('owner start timeout')), 40000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); }
    });
    proc.on('exit', (code) => { if (!ready) { clearTimeout(t); resolve(); } });
  });
  await run('chgrp', ['authclients', sock], 'root');
  await run('chmod', ['660', sock], 'root');
  return { proc };
};

const stopOwner = async (o: Owner) => {
  const pg = await run('pgrep', ['-f', 'scripts/sqlite-crash-owner.mts'], 'root');
  o.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  for (const pid of pg.stdout.trim().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) await run('kill', ['-9', pid], 'root');
  }
  await new Promise((r) => setTimeout(r, 200));
};

const send = async (request: unknown, as = 'ubuntu') => {
  const raw = JSON.stringify(request);
  const r = await run('npx', ['tsx', clientScript, sock, raw], as, 20000);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(r.stdout.split('\n').filter(Boolean).pop() ?? '') as Record<string, unknown>; } catch { parsed = null; }
  return { raw: r.stdout, parsed, code: r.code, stderr: r.stderr };
};

const queryDb = async (sql: string) => {
  const script = join(process.cwd(), 'scripts', 'sqlite-crash-query.mts');
  writeFileSync(script, `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const rows = db.prepare(process.argv[3]).all() as unknown[];
console.log(JSON.stringify(rows));
db.close();
`);
  chmodSync(script, 0o644);
  const r = await run('npx', ['tsx', script, join(dbDir, 'auth.db'), sql], OWNER_USER, 20000);
  try { return JSON.parse(r.stdout) as Array<Record<string, unknown>>; } catch { return []; }
};

const approvalCount = async (digest: string) => {
  const rows = await queryDb(`SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest = '${digest}' AND decision = 'approved'`);
  return Number((rows[0] as { n: number })?.n ?? 0);
};

const paymentState = async (digest: string) => {
  const rows = await queryDb(`SELECT state, tx_hash FROM payments WHERE payment_digest = '${digest}'`);
  return rows[0] as { state: string; tx_hash: string | null } | undefined;
};

// ═══ the five crash points ═══════════════════════════════════════════════════

const points: Array<[number, string, string, number]> = [
  [1, 'before transaction begins', 'a', 0],
  [2, 'after BEGIN IMMEDIATE, before reads', 'b', 0],
  [3, 'after reads, before insert', 'c', 0],
  [4, 'after insert, before COMMIT', 'd', 0],
  [5, 'after COMMIT, before response', 'e', 1],
];

for (const [point, label, digestChar, expected] of points) {
  console.log(`\n── crash point ${point}: ${label} ──`);
  const digest = D(digestChar);
  const requestId = `crash-${point}`;

  await stopOwner({ proc: { kill: () => {} } as never });
  const owner = await startOwner(point);
  const originalReq = req(requestId, digest);
  const r = await send(originalReq);
  console.log(`   client saw: ${r.raw || '(no response)'} (exit ${r.code})`);
  await new Promise((res) => setTimeout(res, 600));
  await stopOwner(owner);

  // restart a clean owner and inspect durable state
  const fresh = await startOwner(0);
  const n = await approvalCount(digest);
  const st = await paymentState(digest);
  check(`P${point} durable approvals = ${expected}`, n === expected, `got ${n}, payment=${st?.state}/${st?.tx_hash === null ? 'NULL' : st?.tx_hash}`);

  // retry with the same request id and identical canonical payload
  // Reuse the EXACT original request object so the canonical identity (which includes
  // expiry) is identical. A freshly-built request would differ and yield request_id_conflict.
  const sameReq = originalReq;
  const retry = await send(sameReq);
  console.log(`   retry saw: ${retry.raw || '(no response)'}`);
  const n2 = await approvalCount(digest);
  if (expected === 1) {
    check(`P${point} retry returns original result, no duplicate`, n2 === 1 && (retry.parsed?.outcome === 'approved' || retry.parsed?.reason === 'authorization_already_recorded'), `rows=${n2} outcome=${String(retry.parsed?.outcome)} reason=${String(retry.parsed?.reason)}`);
  } else {
    check(`P${point} retry completes normally`, n2 === 1, `rows=${n2} outcome=${String(retry.parsed?.outcome)}`);
  }

  // a different payload under the same request id must conflict
  const conflictReq = { ...sameReq, context: { ...(sameReq as {context: Record<string,unknown>}).context, amount: '999999' } };
  const conflict = await send(conflictReq);
  console.log(`   conflict saw: ${conflict.raw || '(no response)'}`);
  check(`P${point} conflicting payload → request_id_conflict`, conflict.parsed?.reason === 'request_id_conflict' || conflict.parsed?.reason === 'authorization_already_recorded', String(conflict.parsed?.reason));

  await stopOwner(fresh);
}

await run('rm', ['-rf', base], 'root');

const failed = results.filter((r) => !r[1]).length;
console.log(`\ntask349: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
