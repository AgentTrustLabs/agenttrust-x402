/**
 * Payment list (facilitator layer): repository `listPayments()` + HTTP
 * `GET /payments`.
 *
 * Covers:
 *   - the repository query: newest first (updated_at DESC) with the
 *     payment digest as the deterministic tie-breaker, and the limit;
 *   - the HTTP route: default + explicit limit, 400 on an invalid limit,
 *     public fields only (no requirements key, no rejection counters,
 *     no signatures), and no live verification per item — the route
 *     works with no verifier configured and lists stored state only.
 *
 * Fully offline. Temp SQLite + mock-mode facilitator on port 0.
 * No broadcast, no signing, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { requirementsKey } from '../services/facilitator/src/store.js';
import { startFacilitator } from '../services/facilitator/src/server.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RESOURCE_URL = 'http://127.0.0.1:4590/protected';

const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '1', asset: 'CCD' },
  RESOURCE_URL,
);

// Digests/tx hashes are 64-hex fixtures, never real payments.
const DIGEST_A = 'a1'.repeat(32); // tie group, updated_at 3000, finalized
const TX_A = 'a2'.repeat(32);
const DIGEST_B = 'b1'.repeat(32); // tie group, updated_at 3000, outcome_unknown
const TX_B = 'b2'.repeat(32);
const DIGEST_C = 'c1'.repeat(32); // older, updated_at 1000, finalized
const TX_C = 'c2'.repeat(32);

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `payment-list-${tag}-`));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

function seedBroadcast(repo: SqliteSettlementRepository, digest: string, hash: string): void {
  repo.claim(digest, REQ_KEY);
  repo.prepare(digest, hash);
  repo.claimSubmit(digest, hash);
  repo.markBroadcast(digest, hash);
}

function seedFinalized(repo: SqliteSettlementRepository, digest: string, hash: string): void {
  seedBroadcast(repo, digest, hash);
  const r = repo.reconcile({
    paymentDigest: digest,
    transaction: hash,
    observed: 'finalized',
    evidenceSource: 'concordium-grpc',
    evidenceDigest: 'e1'.repeat(32),
  });
  if (!r.ok) throw new Error(`seed reconcile failed: ${r.reason}`);
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ repository: order + limit ═══════════════════════════════════════════

test('01. repository lists newest first, digest breaks updated_at ties', async () => {
  const t = tmp('order');
  try {
    let nowMs = 3000;
    const repo = new SqliteSettlementRepository(t.db, { now: () => nowMs });
    seedFinalized(repo, DIGEST_A, TX_A); // updated_at 3000
    seedBroadcast(repo, DIGEST_B, TX_B); // updated_at 3000 (tie with A)
    nowMs = 1000;
    seedFinalized(repo, DIGEST_C, TX_C); // updated_at 1000
    const rows = repo.listPayments(10);
    eq(rows.length, 3, 'three rows');
    eq(rows[0]!.payment_digest, DIGEST_A, 'tie group first, digest ASC');
    eq(rows[1]!.payment_digest, DIGEST_B, 'tie group second');
    eq(rows[2]!.payment_digest, DIGEST_C, 'older row last');
    eq(rows[0]!.updated_at, 3000, 'newest updated_at first');
    eq(rows[2]!.updated_at, 1000, 'oldest updated_at last');
    eq(rows[0]!.state, 'finalized', 'stored state carried');
    eq(rows[1]!.state, 'outcome_unknown', 'stored state carried');
    repo.close();
  } finally {
    t.rm();
  }
});

test('02. repository limit bounds the result to the newest rows', async () => {
  const t = tmp('limit');
  try {
    let nowMs = 1000;
    const repo = new SqliteSettlementRepository(t.db, { now: () => nowMs });
    const digests = ['d1', 'd2', 'd3', 'd4', 'd5'].map((p) => p.repeat(32));
    const hashes = ['e1', 'e2', 'e3', 'e4', 'e5'].map((p) => p.repeat(32));
    for (let i = 0; i < 5; i++) {
      nowMs = 1000 + i * 1000;
      seedBroadcast(repo, digests[i]!, hashes[i]!);
    }
    const two = repo.listPayments(2);
    eq(two.length, 2, 'limit 2 returns two rows');
    eq(two[0]!.payment_digest, digests[4], 'newest first');
    eq(two[1]!.payment_digest, digests[3], 'second newest second');
    const all = repo.listPayments(100);
    eq(all.length, 5, 'limit above the row count returns everything');
    repo.close();
  } finally {
    t.rm();
  }
});

test('03. repository lists zero rows from an empty database', async () => {
  const t = tmp('empty');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    eq(repo.listPayments(10).length, 0, 'empty list');
    repo.close();
  } finally {
    t.rm();
  }
});

// ═══ HTTP: GET /payments ═════════════════════════════════════════════════

async function seedHttpDb(t: { db: string }): Promise<void> {
  let nowMs = 3000;
  const repo = new SqliteSettlementRepository(t.db, { now: () => nowMs });
  seedFinalized(repo, DIGEST_A, TX_A);
  seedBroadcast(repo, DIGEST_B, TX_B);
  nowMs = 1000;
  seedFinalized(repo, DIGEST_C, TX_C);
  repo.close();
}

test('04. HTTP list: 200, newest first, public fields only', async () => {
  const t = tmp('http');
  await seedHttpDb(t);
  const f = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: t.db,
  });
  try {
    const res = await fetch(`${f.url}/payments`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['count'], 3, 'count');
    eq(body['limit'], 50, 'default limit');
    const payments = body['payments'] as Array<Record<string, unknown>>;
    eq(payments.length, 3, 'three payments');
    eq(payments[0]!['paymentDigest'], DIGEST_A, 'tie group first, digest ASC');
    eq(payments[1]!['paymentDigest'], DIGEST_B, 'tie group second');
    eq(payments[2]!['paymentDigest'], DIGEST_C, 'older row last');
    for (const p of payments) {
      eq(Object.keys(p).sort().join(','), 'attempted,createdAt,paymentDigest,state,transactionHash,updatedAt', 'public fields only');
      ok(typeof p['paymentDigest'] === 'string', 'digest present');
      ok(typeof p['state'] === 'string', 'state present');
      ok(typeof p['updatedAt'] === 'number', 'updatedAt present');
    }
    eq(payments[0]!['state'], 'finalized', 'stored finalized');
    eq(payments[1]!['state'], 'outcome_unknown', 'stored outcome_unknown');
    eq(payments[0]!['transactionHash'], TX_A, 'tx hash carried');
    ok(!('requirements_key' in payments[0]!), 'no requirements key');
    ok(!('rejection_observation_count' in payments[0]!), 'no rejection counter');
    ok(!('verification' in payments[0]!), 'no live verification section');
  } finally {
    await f.close();
    t.rm();
  }
});

test('05. HTTP list: explicit limit honored, invalid limits are 400', async () => {
  const t = tmp('http-limit');
  await seedHttpDb(t);
  const f = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: t.db,
  });
  try {
    const two = await fetch(`${f.url}/payments?limit=2`);
    eq(two.status, 200, 'limit=2 status');
    const twoBody = (await two.json()) as Record<string, unknown>;
    eq(twoBody['limit'], 2, 'limit echoed');
    eq((twoBody['payments'] as unknown[]).length, 2, 'two rows');
    for (const bad of ['0', '101', 'abc', '-1', '1.5']) {
      const res = await fetch(`${f.url}/payments?limit=${bad}`);
      eq(res.status, 400, `limit=${bad} is 400`);
      eq(((await res.json()) as Record<string, unknown>)['error'], 'invalid_request', 'invalid_request code');
    }
  } finally {
    await f.close();
    t.rm();
  }
});

test('06. HTTP list: trailing slash and extra segments are 404', async () => {
  const t = tmp('http-404');
  await seedHttpDb(t);
  const f = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: t.db,
  });
  try {
    eq((await fetch(`${f.url}/payments/`)).status, 404, 'trailing slash 404');
    eq((await fetch(`${f.url}/payments/extra`)).status, 404, 'extra segment 404');
  } finally {
    await f.close();
    t.rm();
  }
});

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\npayment-list: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
