/**
 * Payment detail: verifiable settlement evidence (facilitator layer).
 *
 * Covers the pure builder (`getPaymentDetail`) and the HTTP route
 * (`GET /payment/:id`): a finalized payment renders its stored record plus
 * live on-chain evidence; an `outcome_unknown` payment is NEVER shown as
 * finalized — even when the chain already reports its transaction as
 * finalized, the detail reports the chain observation separately and keeps
 * the stored state as the only finalized verdict.
 *
 * Fully offline. Temp SQLite + fake verifier with a canned node-style
 * `getBlockItemStatus` response. No broadcast, no signing, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { requirementsKey } from '../services/facilitator/src/store.js';
import {
  getPaymentDetail,
  parseRequirementsKey,
  type BlockInfoProvider,
} from '../services/facilitator/src/paymentDetail.js';
import type { EvidenceVerifier } from '../services/facilitator/src/evidence.js';
import { startFacilitator } from '../services/facilitator/src/server.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RESOURCE_URL = 'http://127.0.0.1:4590/protected';

const FINAL_DIGEST = 'a1'.repeat(32);
const FINAL_TX = 'a2'.repeat(32);
const BLOCK_HASH = 'a3'.repeat(32);
const UNKNOWN_DIGEST = 'a4'.repeat(32);
const UNKNOWN_TX = 'a5'.repeat(32);
const NO_SUCH = 'a6'.repeat(32);

const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '1', asset: 'CCD' },
  RESOURCE_URL,
);

/** Canned node-style `getBlockItemStatus` response for a finalized sponsored transfer. */
const NODE_RAW_FINAL = {
  status: 'finalized',
  outcome: {
    blockHash: BLOCK_HASH,
    summary: {
      index: '0',
      hash: FINAL_TX,
      type: 'accountTransaction',
      cost: '0',
      energyCost: { value: '635', __type: 'ccd_energy' },
      sender: SENDER,
      sponsor: { cost: '4800331', sponsor: SPONSOR },
      transactionType: 'transfer',
      transfer: { tag: 'Transferred', amount: '1', to: PAY_TO },
    },
  },
};

type FakeVerifier = EvidenceVerifier & Partial<BlockInfoProvider>;

function makeVerifier(finalizedFor: Set<string>): FakeVerifier {
  return {
    name: 'test-fake',
    verify: async ({ transaction }: { transaction: string }) => {
      if (finalizedFor.has(transaction)) {
        return { available: true, observed: 'finalized' as const, source: 'concordium-grpc', raw: NODE_RAW_FINAL };
      }
      return { available: false, observed: 'unknown' as const, source: 'concordium-grpc', error: 'transaction not found' };
    },
    blockInfo: async (hash: string) =>
      hash === BLOCK_HASH ? { blockHeight: '50970567', blockSlotTime: '2026-11-18T11:01:24.585Z' } : null,
  };
}

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `payment-detail-${tag}-`));
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

// ═══ builder: finalized payment ═════════════════════════════════════════

test('01. by-digest finalized detail carries stored record + live evidence', async () => {
  const t = tmp('final');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    seedFinalized(repo, FINAL_DIGEST, FINAL_TX);
    const verifier = makeVerifier(new Set([FINAL_TX]));
    const res = await getPaymentDetail({ repository: repo, verifier }, FINAL_DIGEST);
    ok(res.ok, 'ok');
    if (!res.ok) return;
    const d = res.detail;
    eq(d.paymentDigest, FINAL_DIGEST, 'digest');
    eq(d.state, 'finalized', 'stored state finalized');
    eq(d.finalized, true, 'finalized true');
    eq(d.transactionHash, FINAL_TX, 'tx hash');
    eq(d.requirements.network, CAIP2, 'network from requirements key');
    eq(d.requirements.payTo, PAY_TO, 'payTo');
    eq(d.requirements.amount, '1', 'amount');
    eq(d.requirements.asset, 'CCD', 'asset');
    eq(d.requirements.resourceUrl, RESOURCE_URL, 'resource url');
    eq(d.attempted, 1, 'attempted');
    const v = d.verification;
    eq(v.available, true, 'verification available');
    eq(v.observed, 'finalized', 'chain observed finalized');
    eq(v.source, 'concordium-grpc', 'source');
    eq(v.finalized, true, 'live finalized');
    eq(v.blockHash, BLOCK_HASH, 'block hash');
    eq(v.blockHeight, '50970567', 'block height from node');
    eq(v.blockSlotTime, '2026-11-18T11:01:24.585Z', 'block slot time');
    eq(v.sender, SENDER, 'sender from summary');
    eq(v.sponsor, SPONSOR, 'sponsor from summary');
    eq(v.feeMicroCcd, '4800331', 'fee is the SPONSOR charge, not the sender cost');
    eq(v.energy, '635', 'energy');
    eq(v.recipient, PAY_TO, 'recipient from transfer');
    eq(v.transferAmount, '1', 'transfer amount');
    eq(v.error, null, 'no error');
    const fin = d.transitions.find((tr) => tr.to === 'finalized');
    ok(fin, 'finalize transition present');
    eq(fin?.evidence?.source, 'concordium-grpc', 'finalize evidence source');
    eq(fin?.evidence?.digest, 'e1'.repeat(32), 'finalize evidence digest');
    repo.close();
  } finally {
    t.rm();
  }
});

test('02. by-transaction-hash resolves to the same payment', async () => {
  const t = tmp('byhash');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    seedFinalized(repo, FINAL_DIGEST, FINAL_TX);
    const res = await getPaymentDetail({ repository: repo, verifier: makeVerifier(new Set([FINAL_TX])) }, FINAL_TX);
    ok(res.ok, 'ok');
    if (!res.ok) return;
    eq(res.detail.paymentDigest, FINAL_DIGEST, 'same digest via tx hash');
    eq(res.detail.finalized, true, 'finalized via tx hash');
    repo.close();
  } finally {
    t.rm();
  }
});

// ═══ builder: non-finalized is never shown as finalized ══════════════════

test('03. outcome_unknown with unavailable verification stays not-finalized', async () => {
  const t = tmp('unknown');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    seedBroadcast(repo, UNKNOWN_DIGEST, UNKNOWN_TX);
    const res = await getPaymentDetail({ repository: repo, verifier: makeVerifier(new Set([FINAL_TX])) }, UNKNOWN_DIGEST);
    ok(res.ok, 'ok');
    if (!res.ok) return;
    const d = res.detail;
    eq(d.state, 'outcome_unknown', 'stored state outcome_unknown');
    eq(d.finalized, false, 'finalized false');
    eq(d.transactionHash, UNKNOWN_TX, 'tx hash recorded');
    eq(d.verification.available, false, 'verification unavailable');
    eq(d.verification.observed, 'unknown', 'observed unknown');
    eq(d.verification.finalized, false, 'live finalized false');
    eq(d.verification.blockHeight, null, 'no block height');
    eq(d.verification.blockHash, null, 'no block hash');
    ok((d.verification.error ?? '').includes('not found'), 'error names the cause');
    repo.close();
  } finally {
    t.rm();
  }
});

test('04. outcome_unknown whose chain says finalized is STILL not finalized', async () => {
  const t = tmp('pending');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    seedBroadcast(repo, UNKNOWN_DIGEST, UNKNOWN_TX);
    // The chain reports this transaction finalized — but the stored state
    // has not advanced. The detail must report the chain observation
    // separately and NEVER promote the payment to finalized.
    const verifier = makeVerifier(new Set([FINAL_TX, UNKNOWN_TX]));
    const res = await getPaymentDetail({ repository: repo, verifier }, UNKNOWN_DIGEST);
    ok(res.ok, 'ok');
    if (!res.ok) return;
    eq(res.detail.state, 'outcome_unknown', 'stored state unchanged');
    eq(res.detail.finalized, false, 'detail finalized stays false');
    eq(res.detail.verification.available, true, 'live observation available');
    eq(res.detail.verification.observed, 'finalized', 'chain observed finalized');
    eq(res.detail.verification.finalized, true, 'live finalized true');
    repo.close();
  } finally {
    t.rm();
  }
});

// ═══ builder: errors ═════════════════════════════════════════════════════

test('05. unknown identifier → unknown_payment', async () => {
  const t = tmp('nouser');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    const res = await getPaymentDetail({ repository: repo, verifier: makeVerifier(new Set()) }, NO_SUCH);
    eq(res.ok, false, 'not ok');
    if (res.ok) return;
    eq(res.code, 'unknown_payment', 'unknown_payment');
    repo.close();
  } finally {
    t.rm();
  }
});

test('06. malformed identifier → invalid_request', async () => {
  const t = tmp('badid');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    const verifier = makeVerifier(new Set());
    for (const bad of ['', 'xyz', '0x' + FINAL_TX, FINAL_TX.slice(0, 63), 'g'.repeat(64)]) {
      const res = await getPaymentDetail({ repository: repo, verifier }, bad);
      eq(res.ok, false, `not ok for ${JSON.stringify(bad)}`);
      if (!res.ok) eq(res.code, 'invalid_request', `invalid_request for ${JSON.stringify(bad)}`);
    }
    repo.close();
  } finally {
    t.rm();
  }
});

test('07. requirements key that does not parse yields nulls, keeps raw', () => {
  const p = parseRequirementsKey('not-a-key');
  eq(p.network, null, 'network null');
  eq(p.payTo, null, 'payTo null');
  eq(p.amount, null, 'amount null');
  eq(p.asset, null, 'asset null');
  eq(p.resourceUrl, null, 'resourceUrl null');
  eq(p.raw, 'not-a-key', 'raw kept');
  const q = parseRequirementsKey(REQ_KEY);
  eq(q.network, CAIP2, 'parses when well-formed');
});

test('09. SDK-shaped raw (rich types, BigInt, CcdAmount) extracts correctly', async () => {
  const t = tmp('sdkshape');
  try {
    const repo = new SqliteSettlementRepository(t.db);
    seedFinalized(repo, FINAL_DIGEST, FINAL_TX);
    // The live SDK returns BlockHash/AccountAddress/CcdAmount objects and
    // BigInts, not plain strings. A CcdAmount's String() is the CCD decimal
    // ('4.800331'); the fee must come from microCcdAmount ('4800331').
    const sdkRaw = {
      status: 'finalized',
      outcome: {
        blockHash: { toString: () => BLOCK_HASH },
        summary: {
          hash: { toString: () => FINAL_TX },
          type: 'accountTransaction',
          cost: 0n,
          energyCost: { value: 635n, toString: () => '635' },
          sender: { toString: () => SENDER },
          sponsor: { cost: { microCcdAmount: 4800331n, toString: () => '4.800331' }, sponsor: { toString: () => SPONSOR } },
          transactionType: 'transfer',
          transfer: { tag: 'Transferred', amount: { microCcdAmount: 1n, toString: () => '0.000001' }, to: { toString: () => PAY_TO } },
        },
      },
    };
    const verifier: FakeVerifier = {
      name: 'test-fake-sdk',
      verify: async () => ({ available: true, observed: 'finalized' as const, source: 'concordium-grpc', raw: sdkRaw }),
      blockInfo: async () => ({ blockHeight: '50970567', blockSlotTime: '2026-11-18T11:01:24.585Z' }),
    };
    const res = await getPaymentDetail({ repository: repo, verifier }, FINAL_DIGEST);
    ok(res.ok, 'ok');
    if (!res.ok) return;
    const v = res.detail.verification;
    eq(v.feeMicroCcd, '4800331', 'fee from microCcdAmount, not the CCD decimal');
    eq(v.blockHash, BLOCK_HASH, 'block hash from BlockHash object');
    eq(v.blockHeight, '50970567', 'block height');
    eq(v.sender, SENDER, 'sender from AccountAddress object');
    eq(v.sponsor, SPONSOR, 'sponsor from AccountAddress object');
    eq(v.energy, '635', 'energy from BigInt value');
    eq(v.transferAmount, '1', 'transfer amount from microCcdAmount');
    eq(v.recipient, PAY_TO, 'recipient from AccountAddress object');
    repo.close();
  } finally {
    t.rm();
  }
});

// ═══ HTTP: GET /payment/:id ══════════════════════════════════════════════

test('08. HTTP detail: 200 by digest and by tx hash, 404 unknown, 400 malformed', async () => {
  const t = tmp('http');
  const repo = new SqliteSettlementRepository(t.db);
  seedFinalized(repo, FINAL_DIGEST, FINAL_TX);
  seedBroadcast(repo, UNKNOWN_DIGEST, UNKNOWN_TX);
  repo.close();
  const f = await startFacilitator(
    {
      FACILITATOR_MODE: 'mock',
      FACILITATOR_PORT: '0',
      FACILITATOR_DB_PATH: t.db,
    },
    { verifier: makeVerifier(new Set([FINAL_TX])) },
  );
  try {
    const byDigest = await fetch(`${f.url}/payment/${FINAL_DIGEST}`);
    eq(byDigest.status, 200, 'by digest 200');
    const d = (await byDigest.json()) as Record<string, unknown>;
    eq(d['paymentDigest'], FINAL_DIGEST, 'digest in body');
    eq(d['finalized'], true, 'finalized in body');
    eq((d['verification'] as Record<string, unknown>)['feeMicroCcd'], '4800331', 'fee in body');
    eq((d['verification'] as Record<string, unknown>)['blockHeight'], '50970567', 'height in body');

    const byHash = await fetch(`${f.url}/payment/${FINAL_TX}`);
    eq(byHash.status, 200, 'by tx hash 200');
    eq(((await byHash.json()) as Record<string, unknown>)['paymentDigest'], FINAL_DIGEST, 'same digest via hash');

    const unknown = await fetch(`${f.url}/payment/${UNKNOWN_DIGEST}`);
    eq(unknown.status, 200, 'outcome_unknown still 200 (it exists)');
    eq(((await unknown.json()) as Record<string, unknown>)['finalized'], false, 'outcome_unknown not finalized over HTTP');

    const noSuch = await fetch(`${f.url}/payment/${NO_SUCH}`);
    eq(noSuch.status, 404, 'unknown 404');
    eq(((await noSuch.json()) as Record<string, unknown>)['code'], 'unknown_payment', 'unknown_payment code');

    const bad = await fetch(`${f.url}/payment/xyz`);
    eq(bad.status, 400, 'malformed 400');
    eq(((await bad.json()) as Record<string, unknown>)['code'], 'invalid_request', 'invalid_request code');

    const extra = await fetch(`${f.url}/payment/${FINAL_DIGEST}/extra`);
    eq(extra.status, 404, 'extra segment 404');
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
console.log(`\npayment-detail: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
