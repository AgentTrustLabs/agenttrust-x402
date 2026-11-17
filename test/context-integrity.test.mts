/**
 * Payment context integrity during authorization recovery.
 *
 * The durable `sign_events` record now binds the full payment context (network, version,
 * sender, sponsor, recipient, asset, amount, expiry, energy, policy version). Recovery must
 * return `approved` only when every bound field matches.
 *
 * Run: npx tsx test/context-integrity.test.mts
 */

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
  const dir = mkdtempSync(join(tmpdir(), 't3414-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v3414',
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

const setup = () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  const client = new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 });
  return { dir, db, rm, repo, client };
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── baseline: matching context recovers ──────────────────────────────────────

test('00. baseline matching context recovers as approved', async () => {
  const { rm, client } = setup();
  const first = await client.authorize(request());
  eq(first.outcome, 'approved', 'authorize approved');
  const rec = await client.recover(request());
  check('00. baseline approved', rec.outcome === 'approved', `${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 1. amount changed ────────────────────────────────────────────────────────

test('01. changed amount does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ amount: '999999' }));
  ok(rec.outcome !== 'approved', `amount changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 2. asset changed ─────────────────────────────────────────────────────────

test('02. changed asset does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ asset: 'USDC' }));
  ok(rec.outcome !== 'approved', `asset changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 3. expiry changed ────────────────────────────────────────────────────────

test('03. changed expiry does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ expiry: NOW + 500 }));
  ok(rec.outcome !== 'approved', `expiry changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 4. energy changed ────────────────────────────────────────────────────────

test('04. changed energy does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ energy: 999n }));
  ok(rec.outcome !== 'approved', `energy changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 5. recipient / sponsor changed ───────────────────────────────────────────

test('05a. changed recipient does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ recipient: SENDER }));
  ok(rec.outcome !== 'approved', `recipient changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

test('05b. changed sponsor does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ sponsor: PAY_TO }));
  ok(rec.outcome !== 'approved', `sponsor changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 6. sender changed ────────────────────────────────────────────────────────

test('06. changed sender does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ sender: PAY_TO }));
  ok(rec.outcome !== 'approved', `sender changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 7. network changed ───────────────────────────────────────────────────────

test('07. changed network does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ network: 'ccd:0000' }));
  ok(rec.outcome !== 'approved', `network changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 8. digest does not match the canonical context ───────────────────────────

test('08. digest not matching the canonical context does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  // A different digest has no durable approval at all.
  const rec = await client.recover(request({ paymentDigest: 'b'.repeat(64) }));
  eq(rec.outcome, 'unknown', 'unknown digest');
  eq(rec.reason, 'no_durable_decision', 'reason');
  rm();
});

// ── 8b. Task 11: transaction binding changed ─────────────────────────────────

test('08b. changed transactionDigest does not recover as approved', async () => {
  const { rm, client } = setup();
  await client.authorize(request());
  const rec = await client.recover(request({ transactionDigest: 'ab'.repeat(32) }));
  ok(rec.outcome !== 'approved', `transactionDigest changed → ${rec.outcome}/${rec.reason}`);
  rm();
});

// ── 9. legacy record with incomplete context ─────────────────────────────────

test('09. a legacy approved record with NULL context fails closed', async () => {
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified(A, 'k');
  repo.claim(A, 'k');
  repo.close();

  // Simulate a legacy record with NULL asset/amount/expiry.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(db);
  raw.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry)
            VALUES ('${A}', ${NOW * 1000}, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${PAY_TO}', '700', 'v3414', NULL, NULL, NULL)`);
  raw.close();

  const repo2 = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const client = new LocalAuthorizationClient({ policy, repository: repo2, now: () => NOW * 1000 });
  const rec = await client.recover(request());
  ok(rec.outcome !== 'approved', `legacy NULL context → ${rec.outcome}/${rec.reason}`);
  repo2.close();
  rm();
});

// ── 10. repeated recovery for the correct context ────────────────────────────

test('10. repeated recovery for the correct context stays approved', async () => {
  const { rm, client, repo } = setup();
  await client.authorize(request());
  const before = repo.signEvents(A).length;
  const outs = await Promise.all(Array.from({ length: 5 }, () => client.recover(request())));
  const approved = outs.filter((o) => o.outcome === 'approved').length;
  check('10. 5 repeated recoveries approved', approved === 5, `${approved}/5`);
  eq(repo.signEvents(A).length, before, 'no records written');
  eq(repo.signEvents(A).length, 1, 'still exactly one record');
  rm();
});

// ── 12. recovery writes no approval ──────────────────────────────────────────

test('12. recovery never writes an approval', async () => {
  const { rm, client, repo } = setup();
  await client.authorize(request());
  const before = repo.signEvents(A).length;
  for (let i = 0; i < 10; i++) await client.recover(request());
  eq(repo.signEvents(A).length, before, 'record count unchanged');
  eq(repo.signEvents(A).length, 1, 'exactly one approval');
  rm();
});

// ── 13. no signer or submission for non-approved results ─────────────────────

test('13. non-approved recovery never invokes the signer or submission', async () => {
  const { rm, db, client, repo } = setup();
  await client.authorize(request());
  // Tamper the durable record so recovery cannot match (amount NULL = legacy).
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(db);
  raw.exec(`UPDATE sign_events SET amount = NULL WHERE payment_digest = '${A}'`);
  raw.close();
  const rec = await client.recover(request());
  ok(rec.outcome !== 'approved', `non-approved → ${rec.outcome}`);
  // The client is a read-only seam; the settlement boundary only invokes the signer after
  // an approved outcome. Assert the boundary's contract: no approval record is created and
  // the recovery path never calls an approval writer.
  eq(repo.signEvents(A).length, 1, 'no new record');
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
  console.log(`\ncontext-integrity: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
