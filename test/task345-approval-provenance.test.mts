/**
 * TASK 34.5 — database-level approval provenance verification.
 *
 * Probes whether a raw SQL writer can insert an 'approved' event for a valid 'created'
 * payment, bypassing authorizeSignEvent() and its policy checks.
 *
 * The verdict is recorded from EXECUTED probes, not from TypeScript visibility or API
 * restrictions. See docs/archive/TASK34.5-approval-provenance-verification.md.
 *
 * Run: npx tsx test/task345-approval-provenance.test.mts
 */

import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (name: string, detail: string) => console.log(`INFO  ${name} — ${detail}`);

const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_900_000_000;
const NOW_MS = NOW * 1000;
const POLICY = { network: CAIP2, sponsor: SPONSOR, maxEnergy: 10_000n, maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 'v345' };
const req = (digest: string) => ({ network: CAIP2, version: 1, sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, asset: 'CCD', amount: '250000', expiry: NOW + 200, energy: 3_000n, paymentDigest: digest });
const mk = () => { const dir = mkdtempSync(join(tmpdir(), 't345-')); return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) }; };
const signerAt = (db: string) => new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
const D = (c: string) => c.repeat(64);

/** Drive a payment to a target state using the real repository. */
function drive(db: string, digest: string, target: 'created' | 'prepared' | 'submitting' | 'outcome_unknown') {
  const r = new SqliteSettlementRepository(db);
  r.noteVerified(digest, 'k');
  r.claim(digest, 'k');
  if (target === 'created') { r.close(); return; }
  r.prepare(digest, `tx-${target}`);
  if (target === 'prepared') { r.close(); return; }
  r.claimSubmit(digest, `tx-${target}`);
  if (target === 'submitting') { r.close(); return; }
  r.markBroadcast(digest, `tx-${target}`);
  r.close();
}

/** Attempt a raw SQL approval INSERT, bypassing the repository entirely. */
function rawApprovedInsert(db: string, digest: string): { err: string | null; approved: number } {
  const sql = new DatabaseSync(db);
  let err: string | null = null;
  try {
    sql.exec(
      `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${digest}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'raw')`,
    );
  } catch (e) {
    err = (e as Error).message;
  }
  const n = (sql.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest=? AND decision='approved'").get(digest) as { n: number }).n;
  sql.close();
  return { err, approved: Number(n) };
}

// ═══ required probes: raw SQL for valid states ════════════════════════════════

console.log('── raw SQL approval INSERT vs. valid payment states ──');

{
  const { db, rm } = mk();
  drive(db, D('a'), 'created');
  const r = rawApprovedInsert(db, D('a'));
  info('1. raw SQL approval INSERT for a valid created payment', r.err ?? `ACCEPTED — ${r.approved} approved row(s) (the remaining gap)`);
  rm();
}

{
  const { db, rm } = mk();
  drive(db, D('a'), 'prepared');
  const r = rawApprovedInsert(db, D('a'));
  check('2. raw SQL approval INSERT for prepared — refused', r.approved === 0 && r.err !== null, r.err ?? 'ACCEPTED');
  rm();
}

{
  const { db, rm } = mk();
  drive(db, D('a'), 'submitting');
  const r = rawApprovedInsert(db, D('a'));
  check('3. raw SQL approval INSERT for submitting — refused', r.approved === 0 && r.err !== null, r.err ?? 'ACCEPTED');
  rm();
}

{
  const { db, rm } = mk();
  drive(db, D('a'), 'outcome_unknown');
  const r = rawApprovedInsert(db, D('a'));
  check('4. raw SQL approval INSERT for outcome_unknown — refused', r.approved === 0 && r.err !== null, r.err ?? 'ACCEPTED');
  rm();
}

// ═══ documented residual limitation: coordinated two-statement attack ══════════

console.log('\n── documented residual limitation (SQLite cannot enforce provenance) ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const sql = new DatabaseSync(db);
  let err: string | null = null;
  try {
    sql.exec('BEGIN IMMEDIATE');
    sql.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${d}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'raw')`);
    sql.exec('COMMIT');
  } catch (e) {
    err = (e as Error).message;
    try { sql.exec('ROLLBACK'); } catch { /* already aborted */ }
  }
  const n = (sql.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest=? AND decision='approved'").get(d) as { n: number }).n;
  sql.close();
  info('5. coordinated raw attack (single tx, approved insert)', err ?? 'ACCEPTED — SQLite cannot enforce provenance (known limitation)');
  rm();
}

// ═══ legitimate authorization path still works ═══════════════════════════════

console.log('\n── legitimate authorization path ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const r = await s.authorize(req(d));
  const ev = s['repo'].signEvents(d);
  check('6. authorizeSignEvent() approves a valid created payment', r.approved === true && ev.filter(e => e.decision === 'approved').length === 1, `${ev.length} event(s)`);
  rm();
}

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const r = await s.authorize({ ...req(d), sponsor: '' });
  const ev = s['repo'].signEvents(d);
  check('7. policy rejection creates only a rejected event', r.approved === false && ev.length === 1 && ev[0].decision === 'rejected', `${ev.length} event(s)`);
  rm();
}

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const a = await s.authorize(req(d));
  const b = await s.authorize(req(d));
  const ev = s['repo'].signEvents(d);
  check('8. duplicate authorization cannot create a second approval', a.approved === true && b.approved === false && ev.filter(e => e.decision === 'approved').length === 1, `${ev.filter(e => e.decision === 'approved').length} approved`);
  rm();
}

// ═══ cross-process concurrent authorization ═════════════════════════════════

console.log('\n── cross-process concurrent authorization ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const workerPath = join(mkdtempSync(join(tmpdir(), 't345-w-')), 'worker.mts');
  writeFileSync(workerPath, `
import { writeFileSync } from 'node:fs';
import { MockNarrowSponsorSigner } from '${process.cwd()}/services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '${process.cwd()}/services/facilitator/src/repository.js';
const POLICY = ${JSON.stringify({ ...POLICY, maxEnergy: '10000' })};
POLICY.maxEnergy = 10000n;
const request = { network: '${CAIP2}', version: 1, sender: '${SENDER}', sponsor: '${SPONSOR}', recipient: '${RECIPIENT}', asset: 'CCD', amount: '250000', expiry: ${NOW + 200}, energy: 3000n, paymentDigest: '${d}' };
const repo = new SqliteSettlementRepository(process.argv[2]);
const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: repo, now: () => ${NOW_MS} });
const r = await signer.authorize(request);
writeFileSync(process.argv[3], JSON.stringify(r));
repo.close();
`);
  const run = (n: number) => new Promise<string>((resolve, reject) => {
    const outFile = join(mkdtempSync(join(tmpdir(), 't345-o-')), 'r.json');
    const p = spawn('npx', ['tsx', workerPath, db, outFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker ${n}: ${err}`));
      try { resolve(readFileSync(outFile, 'utf8')); } catch (e) { reject(new Error(`worker ${n} no result`)); }
    });
  });
  const outs = await Promise.all([run(1), run(2)]);
  const parsed = outs.map((o) => JSON.parse(o) as { approved: boolean });
  const repo = new SqliteSettlementRepository(db);
  const approved = repo.signEvents(d).filter(e => e.decision === 'approved').length;
  check('9. cross-process → exactly one approval', approved === 1 && parsed.filter(p => p.approved).length === 1, `${approved} approved`);
  repo.close();
  rm();
}

// ═══ audit-write failure remains fail-closed ════════════════════════════════

console.log('\n── audit-write failure remains fail-closed ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const repo = new SqliteSettlementRepository(db);
  repo['db'].exec('ALTER TABLE sign_events RENAME TO sign_events_bak');
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: repo, now: () => NOW_MS });
  const r = await s.authorize(req(d));
  repo['db'].exec('ALTER TABLE sign_events_bak RENAME TO sign_events');
  const approved = repo.signEvents(d).filter(e => e.decision === 'approved').length;
  check('10. audit write failure → audit_write_failed, no approval', r.approved === false && r.reason === 'audit_write_failed' && approved === 0, JSON.stringify(r));
  repo.close();
  rm();
}

// ═══ existing rejection audit remains durable ═══════════════════════════════

console.log('\n── existing rejection audit remains durable ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  await s.authorize({ ...req(d), sponsor: '' });   // policy rejection
  await s.authorize(req(d));                        // approval
  s['repo'].close();
  const s2 = signerAt(db);
  const ev = s2['repo'].signEvents(d);
  check('11. rejection audit survives restart', ev.filter(e => e.decision === 'rejected').length === 1 && ev.filter(e => e.decision === 'approved').length === 1, `${ev.length} event(s)`);
  s2['repo'].close();
  rm();
}

// ═══ summary ═════════════════════════════════════════════════════════════════

const failed = results.filter((r) => !r[1]).length;
console.log(`\ntask34.5: ${results.length - failed}/${results.length} passed, ${failed} failed`);
console.log('NOTE: tests 1 and 5 are EXPECTED to show the gap — they are recorded evidence, not pass/fail regressions.');
process.exit(failed ? 1 : 0);
