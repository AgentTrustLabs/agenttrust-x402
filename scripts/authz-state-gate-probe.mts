/**
 * Read-only probe: does the authorization gate reject payments that have already
 * entered a durable transaction state?
 *
 * This file only READS production code and observes behaviour. It does not modify anything.
 */

import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  policyVersion: 'probe-v1',
};

const req = (digest: string) => ({
  network: CAIP2, version: 1, sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT,
  asset: 'CCD', amount: '250000', expiry: NOW + 200, energy: 3_000n,
  paymentDigest: digest, paymentState: 'created',
});

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 't341-'));
  return { db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
}

const rows: Array<[string, string, string]> = [];
const probe = (name: string, expected: string, actual: string) => {
  // Compare the approved/rejected verdict only; the specific rejection reason is captured
  // separately by the test suite.
  const verdict = actual.startsWith('approved') ? 'approved' : 'rejected';
  const pass = verdict === expected;
  rows.push([name, expected, actual]);
  console.log(`${pass ? 'ok  ' : 'VIOLATION'} ${name}: expected=${expected} actual=${actual}`);
};

console.log('── which durable states does authorize() accept? ──');

{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '1'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('created, no hash', 'approved', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '2'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-prepared');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('prepared (hash durable)', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '3'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-sub'); repo.claimSubmit(d, 'tx-sub');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('submitting', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '4'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-ou'); repo.claimSubmit(d, 'tx-ou'); repo.markBroadcast(d, 'tx-ou');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('outcome_unknown', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '5'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-ob'); repo.claimSubmit(d, 'tx-ob'); repo.markBroadcast(d, 'tx-ob');
  repo.markObserved(d, 'tx-ob', 'observed committed');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('observed', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '6'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-fin'); repo.claimSubmit(d, 'tx-fin'); repo.markBroadcast(d, 'tx-fin');
  repo.reconcile({ paymentDigest: d, transaction: 'tx-fin', observed: 'finalized', evidenceSource: 'f', evidenceDigest: 'x' });
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('finalized', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '7'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-rej'); repo.claimSubmit(d, 'tx-rej'); repo.markBroadcast(d, 'tx-rej');
  repo.reconcile({ paymentDigest: d, transaction: 'tx-rej', observed: 'rejected', evidenceSource: 'f', evidenceDigest: 'x' });
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('rejected', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = '8'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-ru'); repo.claimSubmit(d, 'tx-ru'); repo.markBroadcast(d, 'tx-ru');
  repo.markRecoveryUnavailable(d, 'tx-ru', 'no evidence');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req(d));
  probe('recovery_unavailable', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}

console.log('\n── missing record ──');
{
  const { db, rm } = mk();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize(req('9'.repeat(64)));
  probe('payment record missing', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}

console.log('\n── caller-supplied paymentState is ignored? ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = 'a'.repeat(64);
  repo.noteVerified(d, 'k'); repo.claim(d, 'k'); repo.prepare(d, 'tx-liar');
  repo.close();
  const s = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await s.authorize({ ...req(d), paymentState: 'created' });
  probe('claims created while durable state is prepared', 'rejected', r.approved ? 'approved' : `rejected(${r.reason})`);
  rm();
}

const violations = rows.filter(([, e, a]) => {
  const av = a.startsWith('approved') ? 'approved' : 'rejected';
  return e !== av;
});
console.log(`\ntask34.1 probe: ${rows.length - violations.length}/${rows.length} conform, ${violations.length} VIOLATION(S)`);
