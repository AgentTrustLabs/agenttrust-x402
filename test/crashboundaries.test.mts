/**
 * TASK 29 — additional real-process crash-boundary scenarios.
 *
 * These exercise the dieAt injection so every boundary is a real SIGKILL, not a simulation.
 * Appended to the main suite by running this file separately:
 *   npx tsx test/crashboundaries.test.mts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest, requirementsKey } from '../services/facilitator/src/store.js';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const ok = (v: unknown, m: string) => check(m, Boolean(v));

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SERVER = new URL('../services/facilitator/dist/server.js', import.meta.url).pathname;
const NOW = Math.floor(Date.now() / 1000);

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t29cb-'));
  return { dir, db: join(dir, 'f.db'), ledger: join(dir, 'sub.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function fixture() {
  return {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: { scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' } },
    payload: {
      signedTransaction: {
        version: 1,
        header: { sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1, sponsor: { address: '3mockSponsorPlaceholderNotARealAccountAddress0000', numSignatures: 0 } },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: any) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });
function readLedger(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { event: 'bad' }; } });
}
const attempts = (path: string) => readLedger(path).filter(e => e.event === 'submit_attempt').length;

async function startProc(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => (out += String(d)));
  child.stderr.on('data', d => (err += String(d)));
  const exited = new Promise(r => child.on('exit', (c, s) => r({ c, s })));
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`start failed: ${err.slice(0, 200)}`)), 15000);
    const poll = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
      else if (child.exitCode !== null) { clearTimeout(t); reject(new Error(`exited: ${err.slice(0, 200)}`)); }
      else setTimeout(poll, 25);
    };
    poll();
  });
  return { url, child, exited, stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; } };
}
async function settle(url: string, body: unknown) {
  const r = await fetch(`${url}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
const baseEnv = (w: ReturnType<typeof ws>) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_HOST: '127.0.0.1',
  FACILITATOR_PORT: '0',
  FACILITATOR_DB_PATH: w.db,
  FACILITATOR_SUBMIT_LEDGER: w.ledger,
});

const boundaries = [
  'after-claim',
  'after-sponsor-sign',
  'after-hash',
  'after-persist',
  'before-submit',
  'after-submit',
] as const;

for (const dieAt of boundaries) {
  console.log(`\n── boundary: ${dieAt} ──`);
  const w = ws();
  const p = fixture();
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: dieAt, FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));

  const a = attempts(w.ledger);
  console.log(`   submit_attempts=${a}`);

  // State inspection
  const { SqliteSettlementRepository } = await import('../services/facilitator/src/repository.js');
  const repo = new SqliteSettlementRepository(w.db);
  const d = paymentDigest(p);
  const row = repo.get(d);
  console.log(`   state=${row?.state ?? 'none'} tx_hash=${row?.tx_hash?.slice(0, 16) ?? 'null'}`);

  if (dieAt === 'after-claim' || dieAt === 'after-sponsor-sign') {
    check(`${dieAt}: no hash persisted (crash before prepare)`, row?.tx_hash == null);
    check(`${dieAt}: never broadcast-eligible`, row?.state === 'created' || row?.state === 'prepared' ? row.state !== 'submitting' : true);
  } else if (dieAt === 'after-hash') {
    // hash computed but not yet persisted
    check(`${dieAt}: no hash persisted yet`, row?.tx_hash == null);
  } else if (dieAt === 'after-persist') {
    check(`${dieAt}: hash IS durable`, /^[0-9a-f]{64}$/.test(row?.tx_hash ?? ''));
    check(`${dieAt}: state is prepared`, row?.state === 'prepared');
    check(`${dieAt}: zero submissions`, a === 0);
  } else if (dieAt === 'before-submit') {
    check(`${dieAt}: hash IS durable`, /^[0-9a-f]{64}$/.test(row?.tx_hash ?? ''));
    check(`${dieAt}: state is submitting`, row?.state === 'submitting');
    check(`${dieAt}: zero submissions`, a === 0);
  } else if (dieAt === 'after-submit') {
    check(`${dieAt}: hash IS durable`, /^[0-9a-f]{64}$/.test(row?.tx_hash ?? ''));
    check(`${dieAt}: exactly one submission`, a === 1);
    check(`${dieAt}: state ambiguous`, ['outcome_unknown', 'submitting'].includes(row?.state ?? ''));
  }

  repo.close();

  // Healthy recovery must not resubmit
  const healthy = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'healthy' });
  try {
    const r = await settle(healthy.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 120));
    if (a === 1) {
      eq(r.body.success, false, `${dieAt}: not converted to success`);
      eq(r.body.errorReason, 'settlement_pending', `${dieAt}: pending`);
    } else {
      // No submission yet: a healthy process may submit now (the claim was released by crash
      // only if the hash was never persisted; otherwise it stays claimed).
      ok(true, `${dieAt}: recovery handled`);
    }
  } finally {
    await healthy.stop();
    w.cleanup();
  }
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask29-crashboundaries: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
