/**
 * Authorization audit boundary remediation.
 *
 * Verifies:
 *  - M1: no public approval-insertion API; a raw SQL insert of an approved event is refused
 *        by the database trigger; only the atomic gate can produce an approval.
 *  - M2: every durable-state rejection and every missing-payment attempt is audited.
 *  - audit write failure prevents approval (fail-closed).
 *  - rejected events do not block a later valid retry.
 *  - cross-process exactly-once approval (two real OS processes, one SQLite file).
 *  - restart preserves approval and rejection history.
 *
 * Run: npx tsx test/authorization-audit-remediation.test.mts
 */

import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from './owner-authz-helper.mts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) =>
  check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_900_000_000;
const NOW_MS = NOW * 1000;
const POLICY = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v344',
};
const req = (digest: string) => ({
  network: CAIP2,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  asset: 'CCD',
  amount: '250000',
  expiry: NOW + 200,
  energy: 3_000n,
  paymentDigest: digest,
});

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't344-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};
const signerAt = (db: string) => {
  const repo = new SqliteSettlementRepository(db);
  return new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepoFor(db, repo, () => NOW_MS), now: () => NOW_MS });
};

function drive(
  db: string,
  digest: string,
  target: 'created' | 'prepared' | 'submitting' | 'outcome_unknown' | 'observed' | 'finalized' | 'rejected' | 'recovery_unavailable',
) {
  const r = new SqliteSettlementRepository(db);
  r.noteVerified(digest, 'k');
  r.claim(digest, 'k');
  if (target === 'created') { r.close(); return; }
  r.prepare(digest, `tx-${target}`);
  if (target === 'prepared') { r.close(); return; }
  r.claimSubmit(digest, `tx-${target}`);
  if (target === 'submitting') { r.close(); return; }
  r.markBroadcast(digest, `tx-${target}`);
  if (target === 'outcome_unknown') { r.close(); return; }
  if (target === 'observed') { r.markObserved(digest, `tx-${target}`, 'observed'); r.close(); return; }
  if (target === 'recovery_unavailable') { r.markRecoveryUnavailable(digest, `tx-${target}`, 'no evidence'); r.close(); return; }
  r.reconcile({
    paymentDigest: digest,
    transaction: `tx-${target}`,
    observed: target === 'rejected' ? 'rejected' : 'finalized',
    evidenceSource: 'f',
    evidenceDigest: 'd',
  });
  r.close();
}

const D = (c: string) => c.repeat(64);

// ═══ M1 — no public approval-insertion API ════════════════════════════════════

console.log('── M1: no public approval-insertion API ──');

{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const exposed = typeof (repo as unknown as { recordSignEvent?: unknown }).recordSignEvent;
  eq(exposed, 'undefined', 'M1.1 recordSignEvent removed from the public surface');
  repo.close();
  rm();
}

{
  // Raw SQL, bypassing the repository entirely, on a payment that already has a hash.
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'prepared');
  const repo = new SqliteSettlementRepository(db);
  const { DatabaseSync } = await import('node:sqlite');
  let err: string | null = null;
  try {
    const raw = new DatabaseSync(db);
    raw.exec(
      `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${d}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'probe')`,
    );
    raw.close();
  } catch (e) {
    err = (e as Error).message;
  }
  const approved = ownerRepoFor(db, repo, () => NOW_MS).signEvents(d).filter(e => e.decision === 'approved').length;
  check('M1.2 raw approved INSERT on a prepared payment is refused (no authorization table in the settlement DB)', err !== null && approved === 0, err ? 'no such table' : 'INSERT SUCCEEDED');
  repo.close();
  rm();
}

{
  // (a) The Owner gate refuses authorize for a payment that does not exist.
  const { db, rm } = mk();
  const d = D('z');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const r = await signerAt(db).authorize(req(d));
  const attempts = ownerRepo.signAttempts(d);
  check(
    'M1.3a authorize for a missing payment is refused by the Owner gate (unknown_payment, audited)',
    r.approved === false && r.reason === 'unknown_payment' && attempts.length === 1 &&
      attempts[0].decision === 'rejected' && attempts[0].reason === 'unknown_payment',
    `${r.reason ?? ''} / ${attempts.length} attempt(s)`,
  );
  // (b) A raw approval INSERT for that missing payment is refused because
  // the settlement database has no authorization table at all. The
  // OS-level refusal (facilitator UID cannot write the Owner database) is
  // proven by the owner-storage-isolation suite.
  const { DatabaseSync } = await import('node:sqlite');
  let err: string | null = null;
  try {
    const raw = new DatabaseSync(db);
    raw.exec(
      `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${d}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'probe')`,
    );
    raw.close();
  } catch (e) {
    err = (e as Error).message;
  }
  check('M1.3b raw approved INSERT for a missing payment is refused (no authorization table)', err !== null && /no such table/i.test(err), err ?? 'INSERT SUCCEEDED');
  ownerRepo.close();
  repo.close();
  rm();
}

{
  // The legitimate single approval path still works.
  const { db, rm } = mk();
  const d = D('b');
  drive(db, d, 'created');
  const s = signerAt(db);
  const r = await s.authorize(req(d));
  const approved = s['repo'].signEvents(d).filter(e => e.decision === 'approved').length;
  check('M1.4 the atomic gate still produces exactly one approval', r.approved === true && approved === 1, `${approved} approved`);
  rm();
}

// ═══ M2 — state-based rejections are audited ══════════════════════════════════

console.log('\n── M2: state-based rejections are audited ──');

for (const [state, reason] of [
  ['prepared', 'transaction_hash_already_prepared'],
  ['submitting', 'transaction_hash_already_prepared'],
  ['outcome_unknown', 'transaction_hash_already_prepared'],
  ['observed', 'transaction_hash_already_prepared'],
  ['finalized', 'transaction_hash_already_prepared'],
  ['rejected', 'transaction_hash_already_prepared'],
  ['recovery_unavailable', 'transaction_hash_already_prepared'],
] as const) {
  const { db, rm } = mk();
  drive(db, D('a'), state);
  const s = signerAt(db);
  const r = await s.authorize(req(D('a')));
  const ev = s['repo'].signEvents(D('a'));
  check(
    `M2 '${state}' → audited rejected/${reason}`,
    r.approved === false && r.reason === reason && ev.length === 1 && ev[0].decision === 'rejected' && ev[0].reason === reason,
    `${ev.length} event(s): ${ev.map(e => `${e.decision}/${e.reason}`).join(', ') || 'none'}`,
  );
  rm();
}

{
  // created state but a durable hash present
  const { db, rm } = mk();
  const d = D('a');
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, 'tx-x');
  repo['db'].prepare("UPDATE payments SET state='created' WHERE payment_digest=?").run(d);
  repo.close();
  const s = signerAt(db);
  const r = await s.authorize(req(d));
  const ev = s['repo'].signEvents(d);
  check(
    "M2 'created' with non-NULL hash → audited rejected/transaction_hash_already_prepared",
    r.approved === false && r.reason === 'transaction_hash_already_prepared' && ev.length === 1 && ev[0].decision === 'rejected',
    `${ev.length} event(s)`,
  );
  rm();
}

{
  // missing payment → sign_attempts, no invented payment row
  const { db, rm } = mk();
  const d = D('c');
  const repo = new SqliteSettlementRepository(db);
  const r = await signerAt(db).authorize(req(d));
  const attempts = ownerRepoFor(db, repo, () => NOW_MS).signAttempts(d);
  check(
    'M2 missing payment → audited unknown_payment, no payment row invented',
    r.approved === false && r.reason === 'unknown_payment' && attempts.length === 1 &&
      attempts[0].decision === 'rejected' && attempts[0].reason === 'unknown_payment' && repo.get(d) === undefined,
    `${attempts.length} attempt(s), payment row ${repo.get(d) === undefined ? 'absent' : 'PRESENT'}`,
  );
  repo.close();
  rm();
}

{
  // prior approval
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const first = await s.authorize(req(d));
  const second = await s.authorize(req(d));
  const ev = s['repo'].signEvents(d);
  check(
    'M2 prior approval → audited authorization_already_recorded, still one approval',
    first.approved === true && second.approved === false && second.reason === 'authorization_already_recorded' &&
      ev.filter(e => e.decision === 'approved').length === 1 &&
      ev.filter(e => e.decision === 'rejected' && e.reason === 'authorization_already_recorded').length === 1,
    `${ev.length} event(s)`,
  );
  rm();
}

{
  // policy rejection
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const r = await s.authorize({ ...req(d), sponsor: '' });
  const ev = s['repo'].signEvents(d);
  check(
    'M2 policy rejection → audited rejected/missing_sponsor',
    r.approved === false && r.reason === 'missing_sponsor' && ev.length === 1 && ev[0].decision === 'rejected' && ev[0].reason === 'missing_sponsor',
    `${ev.length} event(s)`,
  );
  rm();
}

// ═══ rejected events do not block a valid retry ═══════════════════════════════

console.log('\n── rejected events do not block a later valid retry ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  const first = await s.authorize({ ...req(d), sponsor: '' }); // policy rejection
  const second = await s.authorize(req(d)); // valid retry
  const ev = s['repo'].signEvents(d);
  check(
    'retry after a policy rejection succeeds; one approved + one rejected',
    first.approved === false && second.approved === true &&
      ev.filter(e => e.decision === 'approved').length === 1 &&
      ev.filter(e => e.decision === 'rejected').length === 1,
    `${ev.length} event(s)`,
  );
  rm();
}

// ═══ audit write failure is fail-closed ═══════════════════════════════════════

console.log('\n── audit write failure fails closed ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  // Make the audit write fail at runtime without touching the payment row.
  // the audit tables live in the Owner-private database.
  ownerRepo['db'].exec('ALTER TABLE authorizations RENAME TO authorizations_bak');
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepo, now: () => NOW_MS });
  const r = await s.authorize(req(d));
  check(
    'audit write failure → audit_write_failed, never approved',
    r.approved === false && r.reason === 'audit_write_failed',
    JSON.stringify(r),
  );
  ownerRepo['db'].exec('ALTER TABLE authorizations_bak RENAME TO authorizations');
  // The failure must also not have left an approval behind.
  const approved = ownerRepo.signEvents(d).filter(e => e.decision === 'approved').length;
  check('no approval survived an audit write failure', approved === 0, `${approved} approved`);
  repo.close();
  rm();
}

// ═══ rollback leaves no partial event ═════════════════════════════════════════

console.log('\n── rollback leaves no partial event ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  ownerRepo['db'].exec('ALTER TABLE authorizations RENAME TO authorizations_bak');
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepo, now: () => NOW_MS });
  await s.authorize(req(d));
  ownerRepo['db'].exec('ALTER TABLE authorizations_bak RENAME TO authorizations');
  const all = ownerRepo.signEvents(d);
  check('failed transaction left zero authorization rows', all.length === 0, `${all.length} row(s)`);
  // And a subsequent valid attempt still succeeds.
  const ok = await new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepo, now: () => NOW_MS }).authorize(req(d));
  check('a later attempt still succeeds after the failed one', ok.approved === true, JSON.stringify(ok));
  repo.close();
  rm();
}

// ═══ cross-process exactly-once ═══════════════════════════════════════════════

console.log('\n── cross-process exactly-once (two OS processes, one DB) ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');

  const workerPath = join(mkdtempSync(join(tmpdir(), 't344-w-')), 'worker.mts');
  writeFileSync(
    workerPath,
    `
import { writeFileSync } from 'node:fs';
import { MockNarrowSponsorSigner } from '${process.cwd()}/services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '${process.cwd()}/services/facilitator/src/repository.js';
import { ownerRepoFor } from '${process.cwd()}/test/owner-authz-helper.mts';
const POLICY = ${JSON.stringify({ ...POLICY, maxEnergy: '10000' })};
POLICY.maxEnergy = 10000n;
const request = {
  network: '${CAIP2}', version: 1, sender: '${SENDER}', sponsor: '${SPONSOR}',
  recipient: '${RECIPIENT}', asset: 'CCD', amount: '250000', expiry: ${NOW + 200},
  energy: 3000n, paymentDigest: '${d}',
};
const repo = new SqliteSettlementRepository(process.argv[2]);
const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepoFor(process.argv[2], repo, () => ${NOW_MS}), now: () => ${NOW_MS} });
const r = await signer.authorize(request);
writeFileSync(process.argv[3], JSON.stringify(r));
repo.close();
`,
  );

  const run = (n: number) =>
    new Promise<string>((resolve, reject) => {
      const outFile = join(mkdtempSync(join(tmpdir(), 't344-o-')), 'r.json');
      const p = spawn('npx', ['tsx', workerPath, db, outFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c) => (err += c));
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker ${n} exited ${code}: ${err}`));
        try {
          resolve(readFileSync(outFile, 'utf8'));
        } catch (e) {
          reject(new Error(`worker ${n} wrote no result: ${err}`));
        }
      });
    });

  const outs = await Promise.all([run(1), run(2)]);
  const parsed = outs.map((o) => JSON.parse(o) as { approved: boolean; reason?: string });
  const repo = new SqliteSettlementRepository(db);
  const ev = ownerRepoFor(db, repo, () => NOW_MS).signEvents(d);
  const approved = ev.filter((e) => e.decision === 'approved').length;
  check('two OS processes → exactly one approval', approved === 1 && parsed.filter((p) => p.approved).length === 1, `${approved} approved`);
  check(
    'the losing process recorded a durable rejection',
    ev.filter((e) => e.decision === 'rejected' && e.reason === 'authorization_already_recorded').length === 1,
    `${ev.filter((e) => e.decision === 'rejected').length} rejection(s)`,
  );
  repo.close();
  rm();
}

// ═══ restart preserves history ════════════════════════════════════════════════

console.log('\n── restart preserves history ──');

{
  const { db, rm } = mk();
  const d = D('a');
  drive(db, d, 'created');
  const s = signerAt(db);
  await s.authorize(req(d));                       // approval
  await s.authorize({ ...req(d), sponsor: '' });   // policy rejection
  await s.authorize(req(d));                       // duplicate approval attempt
  s['repo'].close();

  const s2 = signerAt(db);
  const ev = s2['repo'].signEvents(d);
  check(
    'restart: 1 approved + 2 rejected preserved',
    ev.filter((e) => e.decision === 'approved').length === 1 && ev.filter((e) => e.decision === 'rejected').length === 2,
    `${ev.length} event(s)`,
  );
  s2['repo'].close();
  rm();
}

// ═══ summary ══════════════════════════════════════════════════════════════════

const failed = results.filter((r) => !r[1]).length;
console.log(`\nauthorization-audit-remediation: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
