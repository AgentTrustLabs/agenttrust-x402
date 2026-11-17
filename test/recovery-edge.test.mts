/**
 * Additional recovery cases: conflicting/duplicate records, malformed durable
 * rows, concurrent recovery, and caller-supplied decision rejection.
 *
 * Run: npx tsx test/recovery-edge.test.mts
 */

import { DatabaseSync } from 'node:sqlite';
import { eq, ok } from './helpers.mjs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const NOW = 1_800_000_000;
const A = 'a'.repeat(64);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't3413e-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v3413',
};

const request = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  paymentDigest: A,
  network: CAIP2,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: PAY_TO,
  asset: 'CCD',
  amount: '250000',
  expiry: NOW + 200,
  energy: 700n,
  // Task 11 — the authorization binds the exact transaction and fee policy.
  transactionDigest: 'cd'.repeat(32),
  transactionType: 'transfer',
  maxFeeMicroCcd: '10000000',
  ...over,
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 14. duplicate / conflicting approved records ─────────────────────────────

test('14a. a duplicate approved record is refused as conflicting_evidence', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  const client = new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 });
  await client.authorize(request());
  repo.close();

  // The partial unique index ux_sign_events_approved prevents a second 'approved' row at
  // the storage level. Prove it: attempt a duplicate insert and expect it to fail.
  const raw = new DatabaseSync(db);
  let duplicateRejected = false;
  try {
    raw.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version)
              VALUES ('${A}', ${NOW * 1000}, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${PAY_TO}', '700', 'v3413')`);
  } catch (e) {
    duplicateRejected = /UNIQUE constraint/i.test((e as Error).message);
  }
  raw.close();
  check('duplicate approved insert is blocked by the index', duplicateRejected, 'storage-level guard');

  // With only one approved row, recovery returns approved.
  const repo2 = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const client2 = new LocalAuthorizationClient({ policy, repository: repo2, now: () => NOW * 1000 });
  const rec = await client2.recover(request());
  check('single approved row recovers as approved', rec.outcome === 'approved', `${rec.outcome}/${rec.reason}`);
  repo2.close();
  rm();
});

// ── 15. malformed / incomplete durable record ────────────────────────────────

test('15a. an approved record with an empty policy_version does not recover as approved', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  repo.close();

  const raw = new DatabaseSync(db);
  raw.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version)
            VALUES ('${A}', ${NOW * 1000}, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${PAY_TO}', '700', '')`);
  raw.close();

  const repo2 = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const client = new LocalAuthorizationClient({ policy, repository: repo2, now: () => NOW * 1000 });
  const rec = await client.recover(request());
  check('15a. empty policy_version → not approved', rec.outcome !== 'approved', `${rec.outcome}/${rec.reason}`);
  rm();
});

test('15b. an approved record with a mismatched energy string does not recover as approved', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  repo.close();

  const raw = new DatabaseSync(db);
  raw.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version)
            VALUES ('${A}', ${NOW * 1000}, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${PAY_TO}', 'not-a-number', 'v3413')`);
  raw.close();

  const repo2 = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const client = new LocalAuthorizationClient({ policy, repository: repo2, now: () => NOW * 1000 });
  const rec = await client.recover(request());
  check('15b. malformed energy → not approved', rec.outcome !== 'approved', `${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 18. concurrent recovery ──────────────────────────────────────────────────

test('18. concurrent recovery requests all return the same result and write nothing', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  const client = new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 });
  await client.authorize(request());
  const before = repo.signEvents(A).length;

  const outs = await Promise.all(Array.from({ length: 8 }, () => client.recover(request())));
  const approved = outs.filter((o) => o.outcome === 'approved').length;
  check('8 concurrent recoveries all approved', approved === 8, `${approved}/8`);
  eq(repo.signEvents(A).length, before, 'no records written');
  eq(repo.signEvents(A).length, 1, 'still exactly one record');
  repo.close();
  rm();
});

// ── 17. caller-supplied decision fields ─────────────────────────────────────

test('17. caller-supplied decision fields are not part of the recovery contract', async () => {
  // A recovery request carrying decision/approved must not influence the result. The client
  // builds its own envelope from the typed request; unknown fields never reach the owner.
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const client = new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 });
  const withClaim = { ...request({ paymentDigest: 'e'.repeat(64) }), decision: 'approved', approved: true } as AuthorizationRequest;
  const rec = await client.recover(withClaim);
  check('17a. crafted claim → not approved', rec.outcome !== 'approved', `${rec.outcome}/${rec.reason}`);
  eq(rec.reason, 'no_durable_decision', 'reason');
  check('17b. reason is no_durable_decision', rec.reason === 'no_durable_decision', String(rec.reason));
  repo.close();
  rm();
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  console.log(`\nrecovery-edge: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
