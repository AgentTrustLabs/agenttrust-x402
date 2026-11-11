/**
 * Post-submission / pre-markBroadcast crash verification.
 *
 * The exact window: submitTransaction() returned successfully, but the process was SIGKILLed
 * before markBroadcast() committed. The database still says "submitting" even though the
 * transaction was already broadcast.
 *
 * Proves:
 *  - exactly one submission attempt across the original and recovery processes
 *  - the hash survives the crash
 *  - recovery never calls submitTransaction() again
 *  - recovery transitions submitting → outcome_unknown and reconciles by hash
 *  - inconclusive evidence stays pending; verified matching evidence finalizes
 *  - wrong-hash evidence cannot finalize; a different payment cannot reuse the hash
 *
 * Run: npx tsx test/postsubmit-crash.test.mts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest, requirementsKey } from '../services/facilitator/src/store.js';
import { FixtureEvidenceVerifier } from '../services/facilitator/src/evidence.js';
import { ReconciliationService } from '../services/facilitator/src/reconcile.js';
import { createHash } from 'node:crypto';

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
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t291-'));
  return { dir, db: join(dir, 'f.db'), ledger: join(dir, 'sub.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function fixture(over: Record<string, unknown> = {}) {
  const reqs = {
    scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' },
    ...(over.requirements as object ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: (over.resourceUrl as string) ?? 'agenttrust://resource/1004' },
    accepted: reqs,
    payload: {
      signedTransaction: {
        version: 1,
        header: { sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1, sponsor: { address: '3mockSponsorPlaceholderNotARealAccountAddress0000', numSignatures: 0 } },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: (over.amount as string) ?? '250000' },
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
async function reconcile(url: string, digest: string, token: string) {
  const r = await fetch(`${url}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ paymentDigest: digest }),
  });
  return { status: r.status, body: await r.json() as any };
}
const baseEnv = (w: ReturnType<typeof ws>) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_HOST: '127.0.0.1',
  FACILITATOR_PORT: '0',
  FACILITATOR_DB_PATH: w.db,
  FACILITATOR_SUBMIT_LEDGER: w.ledger,
});
const TOKEN = 'test-operator-token';
const tokenHash = createHash('sha256').update(TOKEN).digest('hex');

// ═══ 1. the exact window: kill after submitTransaction, before markBroadcast ═════════

console.log('\n── 1. crash between submitTransaction() and markBroadcast() ──');
let crashHash = '';
{
  const w = ws();
  const p = fixture();
  crashHash = paymentDigest(p);
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: 'after-submit', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));

  console.log(`   ledger: ${JSON.stringify(readLedger(w.ledger).map(e => e.event))}`);
  eq(attempts(w.ledger), 1, 'exactly one submission attempt before the crash');

  const repo = new SqliteSettlementRepository(w.db);
  const row = repo.get(crashHash);
  try {
    ok(/^[0-9a-f]{64}$/.test(row?.tx_hash ?? ''), `hash persisted: ${row?.tx_hash?.slice(0, 16)}…`);
    eq(row?.state, 'submitting', 'state is still submitting — markBroadcast never committed');
    eq(row?.attempted, 1, 'attempted recorded');
    // The payment claim is intact: a second claim for a different authorisation is refused.
    const otherKey = 'different-requirements-key';
    const claim = repo.claim(crashHash, otherKey);
    eq(claim.ok, false, 'claim intact: different authorisation refused');
    // No terminal state was written.
    eq(row?.state === 'finalized' || row?.state === 'rejected', false, 'not terminal');
  } finally {
    repo.close();
  }
}

// ═══ 2. recovery uses the persisted hash and never resubmits ════════════════════════

console.log('\n── 2. recovery from a separate process ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: 'after-submit', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));
  const before = new SqliteSettlementRepository(w.db);
  const hashBefore = before.get(d)?.tx_hash ?? '';
  before.close();

  const rec = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'recovery' });
  try {
    const r = await settle(rec.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 150));
    eq(r.body.success, false, 'recovery does not report success');
    eq(r.body.errorReason, 'settlement_pending', 'recovery reports pending');
    eq(r.body.transaction, hashBefore, 'recovery reports the persisted hash');
    eq(attempts(w.ledger), 1, 'recovery did NOT submit again');

    const after = new SqliteSettlementRepository(w.db);
    const row = after.get(d);
    try {
      eq(row?.tx_hash, hashBefore, 'hash unchanged by recovery');
      eq(row?.state, 'outcome_unknown', 'submitting transitioned to outcome_unknown');
    } finally {
      after.close();
    }
  } finally {
    await rec.stop();
    w.cleanup();
  }
}

// ═══ 3. reconciliation: inconclusive evidence stays pending ═════════════════════════

console.log('\n── 3. inconclusive evidence remains pending ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const repo = new SqliteSettlementRepository(w.db);
  try {
    repo.noteVerified(d, requirementsKey(p.accepted, p.resource.url));
    repo.claim(d, requirementsKey(p.accepted, p.resource.url));
    repo.prepare(d, 'hash-inconclusive');
    repo.claimSubmit(d, 'hash-inconclusive');
    repo.markBroadcast(d, 'hash-inconclusive');
  } finally {
    repo.close();
  }

  const svc = new ReconciliationService({ repository: new SqliteSettlementRepository(w.db), verifier: new FixtureEvidenceVerifier({}) });
  const r = await svc.reconcile({ paymentDigest: d, transaction: 'hash-inconclusive' });
  eq(r.ok, true, 'reconcile accepted');
  eq(r.changed, false, 'nothing changed');
  eq(r.state, 'outcome_unknown', 'stays outcome_unknown');

  for (const observed of ['committed', 'pending', 'unknown'] as const) {
    const repo2 = new SqliteSettlementRepository(w.db);
    const svc2 = new ReconciliationService({ repository: repo2, verifier: new FixtureEvidenceVerifier({ 'hash-inconclusive': observed }) });
    const rr = await svc2.reconcile({ paymentDigest: d, transaction: 'hash-inconclusive' });
    eq(rr.ok, true, `${observed}: accepted`);
    eq(rr.changed, false, `${observed}: nothing changed`);
    eq(rr.state, 'outcome_unknown', `${observed}: stays outcome_unknown`);
    repo2.close();
  }

  const repo3 = new SqliteSettlementRepository(w.db);
  const svc3 = new ReconciliationService({ repository: repo3, verifier: new FixtureEvidenceVerifier({}, { unreachable: true }) });
  const r3 = await svc3.reconcile({ paymentDigest: d, transaction: 'hash-inconclusive' });
  eq(r3.ok, true, 'unavailable evidence: accepted');
  eq(r3.changed, false, 'unavailable evidence: nothing changed');
  eq(r3.state, 'outcome_unknown', 'unavailable evidence: stays outcome_unknown');
  repo3.close();
  w.cleanup();
}

// ═══ 4. verified matching evidence finalizes; wrong hash cannot ═════════════════════

console.log('\n── 4. verified evidence finalizes; wrong hash is refused ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const repo = new SqliteSettlementRepository(w.db);
  try {
    repo.noteVerified(d, requirementsKey(p.accepted, p.resource.url));
    repo.claim(d, requirementsKey(p.accepted, p.resource.url));
    repo.prepare(d, 'hash-finalize');
    repo.claimSubmit(d, 'hash-finalize');
    repo.markBroadcast(d, 'hash-finalize');
  } finally {
    repo.close();
  }

  const svc = new ReconciliationService({ repository: new SqliteSettlementRepository(w.db), verifier: new FixtureEvidenceVerifier({ 'hash-finalize': 'finalized' }) });
  const r = await svc.reconcile({ paymentDigest: d, transaction: 'hash-finalize' });
  eq(r.ok, true, 'verified finalization accepted');
  eq(r.changed, true, 'state advanced');
  eq(r.state, 'finalized', 'finalized');
  eq(r.evidence.source, 'fixture', 'evidence source recorded');

  const repo2 = new SqliteSettlementRepository(w.db);
  const svc2 = new ReconciliationService({ repository: repo2, verifier: new FixtureEvidenceVerifier({}) });
  const r2 = await svc2.reconcile({ paymentDigest: d, transaction: 'hash-finalize' });
  eq(r2.ok, true, 'duplicate finalization accepted');
  eq(r2.changed, false, 'idempotent');
  eq(r2.state, 'finalized', 'still finalized');
  repo2.close();
  w.cleanup();
}

console.log('\n── 4b. wrong-hash evidence cannot finalize ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const repo = new SqliteSettlementRepository(w.db);
  try {
    repo.noteVerified(d, requirementsKey(p.accepted, p.resource.url));
    repo.claim(d, requirementsKey(p.accepted, p.resource.url));
    repo.prepare(d, 'hash-recorded');
    repo.claimSubmit(d, 'hash-recorded');
    repo.markBroadcast(d, 'hash-recorded');
  } finally {
    repo.close();
  }

  const svc = new ReconciliationService({ repository: new SqliteSettlementRepository(w.db), verifier: new FixtureEvidenceVerifier({ 'hash-other': 'finalized' }) });
  const r = await svc.reconcile({ paymentDigest: d, transaction: 'hash-other' });
  eq(r.ok, false, 'wrong hash refused');
  const repo2 = new SqliteSettlementRepository(w.db);
  eq(repo2.get(d)?.state, 'outcome_unknown', 'still pending');
  repo2.close();
  w.cleanup();
}

// ═══ 5. a different payment cannot reuse the persisted hash ═════════════════════════

console.log('\n── 5. a different payment cannot reuse the hash ──');
{
  const w = ws();
  const p1 = fixture();
  const p2 = fixture({ amount: '999999' });
  const d1 = paymentDigest(p1);
  const d2 = paymentDigest(p2);
  ok(d1 !== d2, 'different payments have different digests');

  const repo = new SqliteSettlementRepository(w.db);
  try {
    repo.noteVerified(d1, requirementsKey(p1.accepted, p1.resource.url));
    repo.claim(d1, requirementsKey(p1.accepted, p1.resource.url));
    repo.prepare(d1, 'hash-p1');
    repo.claimSubmit(d1, 'hash-p1');
    repo.markBroadcast(d1, 'hash-p1');
  } finally {
    repo.close();
  }

  const svc = new ReconciliationService({ repository: new SqliteSettlementRepository(w.db), verifier: new FixtureEvidenceVerifier({ 'hash-p1': 'finalized' }) });
  const r = await svc.reconcile({ paymentDigest: d2, transaction: 'hash-p1' });
  eq(r.ok, false, 'refused');
  w.cleanup();
}

// ═══ 6. recovery-process crash does not cause a new submission ═══════════════════════

console.log('\n── 6. recovery-process crash does not cause a new submission ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: 'after-submit', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));

  const rec = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'recovery' });
  const r = await settle(rec.url, envelope(p));
  await rec.stop();
  await new Promise(r2 => setTimeout(r2, 120));
  eq(r.body.success, false, 'recovery did not finalize');
  eq(attempts(w.ledger), 1, 'still exactly one submission');

  const repo = new SqliteSettlementRepository(w.db);
  eq(repo.get(d)?.tx_hash, r.body.transaction, 'hash unchanged');
  repo.close();
  w.cleanup();
}

// ═══ 7. concurrent recovery does not duplicate submission ═══════════════════════════

console.log('\n── 7. two concurrent recovery processes ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: 'after-submit', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));

  const a = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-a' });
  const b = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-b' });
  try {
    const [ra, rb] = await Promise.all([settle(a.url, envelope(p)), settle(b.url, envelope(p))]);
    await new Promise(r2 => setTimeout(r2, 150));
    eq(attempts(w.ledger), 1, 'concurrent recovery: still exactly one submission');
    for (const r of [ra, rb]) {
      eq(r.body.success, false, 'not success');
      eq(r.body.errorReason, 'settlement_pending', 'pending');
    }
    const repo = new SqliteSettlementRepository(w.db);
    eq(repo.get(d)?.state, 'outcome_unknown', 'state advanced to outcome_unknown');
    repo.close();
  } finally {
    await a.stop();
    await b.stop();
    w.cleanup();
  }
}

// ═══ 8. replay protection intact ════════════════════════════════════════════════════

console.log('\n── 8. replay protection remains intact ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_DIE_AT: 'after-submit', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r => setTimeout(r, 150));

  // Same payment, different resource → still refused.
  const otherResource = { ...p, resource: { url: 'agenttrust://resource/OTHER' } };
  const rec = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'recovery' });
  try {
    const r = await settle(rec.url, envelope(otherResource));
    await new Promise(r2 => setTimeout(r2, 120));
    eq(r.body.success, false, 'different resource refused');
    eq(attempts(w.ledger), 1, 'no second submission');
  } finally {
    await rec.stop();
    w.cleanup();
  }
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\npostsubmit-crash: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
