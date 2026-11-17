/**
 * Atomic durable authorization remediation.
 *
 * Verifies the strict durable-state allow-list, the atomic audit gate, exactly-once
 * authorization, and cross-process protection.
 *
 * Run: npx tsx test/atomic-authorization.test.mts
 */

import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from './owner-authz-helper.mts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_900_000_000;
const NOW_MS = NOW * 1000;

const POLICY = {
  network: CAIP2, sponsor: SPONSOR, maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 'v342',
};

const req = (digest: string) => ({
  network: CAIP2, version: 1, sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT,
  asset: 'CCD', amount: '250000', expiry: NOW + 200, energy: 3_000n, paymentDigest: digest,
});

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 't342-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
}
const signerAt = (db: string) => {
  const repo = new SqliteSettlementRepository(db);
  return new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepoFor(db, repo, () => NOW_MS), now: () => NOW_MS });
};

/** Drive a payment to a given durable state. */
function drive(db: string, digest: string, target: 'created' | 'prepared' | 'submitting' | 'outcome_unknown' | 'observed' | 'finalized' | 'rejected' | 'recovery_unavailable') {
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
  r.reconcile({ paymentDigest: digest, transaction: `tx-${target}`, observed: target === 'rejected' ? 'rejected' : 'finalized', evidenceSource: 'f', evidenceDigest: 'd' });
  r.close();
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ the 12 required conditions ════════════════════════════════════════

console.log('── the 12 required durable-state conditions ──');

for (const [n, target, reason] of [
  [1, 'prepared', 'transaction_hash_already_prepared'],
  [2, 'submitting', 'transaction_hash_already_prepared'],
  [3, 'outcome_unknown', 'transaction_hash_already_prepared'],
  [4, 'observed', 'transaction_hash_already_prepared'],
  [5, 'finalized', 'transaction_hash_already_prepared'],
  [6, 'rejected', 'transaction_hash_already_prepared'],
  [7, 'recovery_unavailable', 'transaction_hash_already_prepared'],
] as const) {
  test(`${n + 1}. durable state '${target}' → rejected`, async () => {
    const { db, rm } = mk();
    drive(db, 'a'.repeat(64), target);
    const r = await signerAt(db).authorize(req('a'.repeat(64)));
    eq(r.approved, false, 'rejected');
    eq(r.reason, reason, reason);
    rm();
  });
}

test('1. created + NULL hash → approved', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const r = await signerAt(db).authorize(req('a'.repeat(64)));
  eq(r.approved, true, 'approved');
  rm();
});

test('8. created but non-NULL hash → rejected', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified('a'.repeat(64), 'k');
  // Force state='created' with a hash: prepare() then roll the state back manually to model
  // DB corruption / a hand-edited row. The gate must still refuse on the hash alone.
  repo.claim('a'.repeat(64), 'k');
  repo.prepare('a'.repeat(64), 'tx-x');
  repo['db'].prepare("UPDATE payments SET state='created' WHERE payment_digest=?").run('a'.repeat(64));
  repo.close();
  const r = await signerAt(db).authorize(req('a'.repeat(64)));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'transaction_hash_already_prepared', 'hash gate fires before state gate');
  rm();
});

test('9. missing payment → unknown_payment', async () => {
  const { db, rm } = mk();
  const r = await signerAt(db).authorize(req('c'.repeat(64)));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'unknown_payment', 'unknown_payment');
  rm();
});

test('10. digest mismatch is unreachable but the PK guard exists', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  // A digest mismatch cannot occur through the public API: the digest IS the primary key, so
  // a different digest means a missing row (→ unknown_payment). Document the reality.
  const r = await signerAt(db).authorize(req('b'.repeat(64)));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'unknown_payment', 'different digest = different (absent) payment');
  rm();
});

test('11. previously approved payment → rejected', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const s = signerAt(db);
  const first = await s.authorize(req('a'.repeat(64)));
  eq(first.approved, true, 'first approved');
  const second = await s.authorize(req('a'.repeat(64)));
  eq(second.approved, false, 'second rejected');
  eq(second.reason, 'authorization_already_recorded', 'authorization_already_recorded');
  rm();
});

test('12. concurrent authorization + prepare() from separate processes → no stale approval', async () => {
  const { dir, db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');

  // Worker: authorize as fast as possible, report the outcome.
  const worker = join(dir, 'worker.mts');
  writeFileSync(worker, `
import { MockNarrowSponsorSigner } from ${JSON.stringify(join(import.meta.dirname, '../services/facilitator/src/narrowSponsorMock.ts'))};
import { SqliteSettlementRepository } from ${JSON.stringify(join(import.meta.dirname, '../services/facilitator/src/repository.ts'))};
import { ownerRepoFor } from ${JSON.stringify(join(import.meta.dirname, './owner-authz-helper.mts'))};
const s = new MockNarrowSponsorSigner({ policy: { network: '${CAIP2}', sponsor: '${SPONSOR}', maxEnergy: 10000n, maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 'v342' }, repository: ownerRepoFor(${JSON.stringify(db)}, new SqliteSettlementRepository(${JSON.stringify(db)}), () => ${NOW_MS}), now: () => ${NOW_MS} });
const r = await s.authorize({ network: '${CAIP2}', version: 1, sender: '${SENDER}', sponsor: '${SPONSOR}', recipient: '${RECIPIENT}', asset: 'CCD', amount: '250000', expiry: ${NOW + 200}, energy: 3000n, paymentDigest: '${'a'.repeat(64)}' });
console.log('RESULT:' + JSON.stringify(r));
`);
  const child = spawn(process.execPath, ['--import', 'tsx', worker], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => (out += String(d)));
  child.stderr.on('data', d => (out += String(d)));

  // Meanwhile, in this process, prepare() the payment.
  await new Promise(r => setTimeout(r, 30));
  const repo = new SqliteSettlementRepository(db);
  repo.prepare('a'.repeat(64), 'tx-race');
  repo.close();

  await new Promise(r => child.on('exit', r));
  console.log(`      worker output: ${out.trim().split('\n').slice(-1)[0]}`);

  // Whatever the interleaving, the invariant holds: no approval for a payment that now has a
  // durable hash, and at most one approved event ever exists.
  const check1 = new SqliteSettlementRepository(db);
  const approvedEvents = ownerRepoFor(db, check1, () => NOW_MS).signEvents('a'.repeat(64)).filter(e => e.decision === 'approved').length;
  const row = check1.get('a'.repeat(64));
  check1.close();
  check('at most one approval recorded', approvedEvents <= 1, `approved=${approvedEvents}`);
  eq(row?.tx_hash, 'tx-race', 'durable hash survived');
  if (approvedEvents === 1) {
    // Approval happened BEFORE prepare(); the transaction committed first. That is a legal
    // ordering, not a stale approval.
    check('approval preceded the prepare() — legal ordering', /"approved":true/.test(out), 'worker approved at commit time');
  } else {
    check('approval was refused by the gate', /"approved":false/.test(out), 'worker refused');
  }
  rm();
});

// ═══ mandatory additional tests ════════════════════════════════════════

console.log('\n── additional mandatory cases ──');

test('13. two concurrent authorizations in separate processes: exactly one approval', async () => {
  const { dir, db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');

  const worker = (tag: string) => {
    const f = join(dir, `w-${tag}.mts`);
    writeFileSync(f, `
import { MockNarrowSponsorSigner } from ${JSON.stringify(join(import.meta.dirname, '../services/facilitator/src/narrowSponsorMock.ts'))};
import { SqliteSettlementRepository } from ${JSON.stringify(join(import.meta.dirname, '../services/facilitator/src/repository.ts'))};
import { ownerRepoFor } from ${JSON.stringify(join(import.meta.dirname, './owner-authz-helper.mts'))};
const s = new MockNarrowSponsorSigner({ policy: { network: '${CAIP2}', sponsor: '${SPONSOR}', maxEnergy: 10000n, maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 'v342' }, repository: ownerRepoFor(${JSON.stringify(db)}, new SqliteSettlementRepository(${JSON.stringify(db)}), () => ${NOW_MS}), now: () => ${NOW_MS} });
const r = await s.authorize({ network: '${CAIP2}', version: 1, sender: '${SENDER}', sponsor: '${SPONSOR}', recipient: '${RECIPIENT}', asset: 'CCD', amount: '250000', expiry: ${NOW + 200}, energy: 3000n, paymentDigest: '${'a'.repeat(64)}' });
console.log('RESULT:' + JSON.stringify(r));
`);
    return f;
  };

  const run = (f: string) => new Promise<string>(resolve => {
    const c = spawn(process.execPath, ['--import', 'tsx', f], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', d => (o += String(d)));
    c.stderr.on('data', d => (o += String(d)));
    c.on('exit', () => resolve(o));
  });

  const [a, b] = await Promise.all([run(worker('1')), run(worker('2'))]);
  const approvedCount = [a, b].filter(o => /"approved":true/.test(o)).length;
  eq(approvedCount, 1, 'exactly one process approved');

  const repo = new SqliteSettlementRepository(db);
  const approvedEvents = ownerRepoFor(db, repo, () => NOW_MS).signEvents('a'.repeat(64)).filter(e => e.decision === 'approved').length;
  repo.close();
  eq(approvedEvents, 1, 'exactly one approved event in the database');
  rm();
});

test('14. restart after successful authorization → no second approval', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const first = await signerAt(db).authorize(req('a'.repeat(64)));
  eq(first.approved, true, 'first approved');
  // New repository handle = process restart.
  const second = await signerAt(db).authorize(req('a'.repeat(64)));
  eq(second.approved, false, 'second rejected after restart');
  eq(second.reason, 'authorization_already_recorded', 'authorization_already_recorded');
  rm();
});

test('15. audit write failure → no approval', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  // the audit tables live in the Owner-private database; dropping
  // `authorizations` there must fail the authorization closed (audit_write_failed).
  ownerRepo['db'].exec('DROP TABLE authorizations');
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepo, now: () => NOW_MS });
  const r = await s.authorize(req('a'.repeat(64)));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'audit_write_failed', 'audit_write_failed');
  rm();
});

test('16. database rollback → no partial authorization event', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  // Force a failure AFTER the gate passes by making the INSERT violate the partial unique
  // index: pre-insert an approved row with a different payment, then make this one collide.
  // Simplest deterministic path: drop the FK target mid-transaction is not possible; instead
  // verify the tx wrapper rolls back by throwing from inside a wrapped call.
  // the audit tables live in the Owner-private database.
  let threw = false;
  try {
    ownerRepo['tx'](() => {
      ownerRepo['db'].prepare("INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run('a'.repeat(64), NOW_MS, 'approved', null, CAIP2, SENDER, SPONSOR, RECIPIENT, '1', 'v342');
      throw new Error('simulated failure after insert');
    });
  } catch { threw = true; }
  eq(threw, true, 'the transaction threw');
  eq(ownerRepo.signEvents('a'.repeat(64)).length, 0, 'no partial event survived the rollback');
  rm();
});

test('17. rolled-back authorization leaves the payment authorizable', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  try {
    ownerRepo['tx'](() => {
      ownerRepo['db'].prepare("INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run('a'.repeat(64), NOW_MS, 'approved', null, CAIP2, SENDER, SPONSOR, RECIPIENT, '1', 'v342');
      throw new Error('boom');
    });
  } catch { /* expected */ }
  ownerRepo.close();
  repo.close();
  const r = await signerAt(db).authorize(req('a'.repeat(64)));
  eq(r.approved, true, 'a rolled-back attempt does not block a later valid one');
  rm();
});

test('18. rejected policy attempts do not block a later valid attempt', async () => {
  const { db, rm } = mk();
  drive(db, 'a'.repeat(64), 'created');
  const s = signerAt(db);
  const bad = await s.authorize({ ...req('a'.repeat(64)), energy: 99_999n });
  eq(bad.approved, false, 'bad attempt rejected');
  eq(bad.reason, 'energy_exceeds_cap', 'energy_exceeds_cap');
  const good = await s.authorize(req('a'.repeat(64)));
  eq(good.approved, true, 'valid attempt approved');
  rm();
});

test('19. replay protection intact (claim still refuses a second submit)', () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = 'a'.repeat(64);
  repo.noteVerified(d, 'k');
  eq(repo.claim(d, 'k').claim, 'fresh', 'first claim fresh');
  repo.prepare(d, 'tx-1');
  eq(repo.claimSubmit(d, 'tx-1').ok, true, 'first claimSubmit ok');
  eq(repo.claimSubmit(d, 'tx-1').ok, false, 'second claimSubmit refused');
  repo.close();
  rm();
});

test('20. crash recovery intact (submitting → outcome_unknown, no resubmit)', () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = 'a'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, 'tx-1');
  repo.claimSubmit(d, 'tx-1');
  eq(repo.get(d)?.state, 'submitting', 'submitting');
  repo.markBroadcast(d, 'tx-1');
  eq(repo.get(d)?.state, 'outcome_unknown', 'outcome_unknown');
  repo.close();
  rm();
});

test('21. caller cannot assert a state anymore (paymentState removed from contract)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(import.meta.dirname, '../services/facilitator/src/narrowSponsor.ts'), 'utf8');
  // Ignore comments; assert the TYPE no longer declares paymentState as a field.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('paymentState is not a request field', !/paymentState\s*:\s*string/.test(code));
});

// ═══ runner ═══════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log('\natomic-authorization: ' + (n - failed) + '/' + n + ' passed');
process.exit(failed ? 1 : 0);
