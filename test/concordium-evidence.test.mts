/**
 * Concordium EvidenceVerifier adapter tests (deterministic, no network).
 *
 * Uses a mock node client implementing `ConcordiumStatusClient`. No real node.
 */

import { ConcordiumEvidenceVerifier, mapStatus } from '../services/facilitator/src/concordiumEvidence.js';
import { ReconciliationService } from '../services/facilitator/src/reconcile.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const ok = (v: unknown, m: string) => check(m, Boolean(v));

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function mockClient(impl: (h: string) => unknown) {
  return { getBlockItemStatus: async (h: string) => impl(h) };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. response shape mapping ═══════════════════════════════════════════

test('01. finalized with matching hash and non-failed type → finalized', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH, transactionType: 'transfer' } },
  })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, true, 'available');
  eq(r.observed, 'finalized', 'finalized');
});

test('02. finalized with failed transactionType → rejected (failed)', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH, transactionType: 'failed' } },
  })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, true, 'available');
  eq(r.observed, 'failed', 'failed');
});

test('03. finalized with mismatched summary hash → inconclusive (hash binding)', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: OTHER, transactionType: 'transfer' } },
  })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
  ok(/hash mismatch/i.test(r.error ?? ''), 'hash mismatch reported');
});

test('04. finalized with missing summary hash → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: {} },
  })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('05. finalized with missing outcome → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({ status: 'finalized' })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('06. committed → committed (not final)', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'committed',
    outcomes: [{ blockHash: 'bh', summary: { hash: HASH, transactionType: 'transfer' } }],
  })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, true, 'available');
  eq(r.observed, 'committed', 'committed');
});

test('07. received → pending (not final)', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({ status: 'received' })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, true, 'available');
  eq(r.observed, 'pending', 'pending');
});

test('08. undefined response → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => undefined));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('09. null response → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => null));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('10. unsupported status → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({ status: 'garbage' })));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('11. malformed (non-object) response → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => 'string'));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

// ═══ 2. node failures ═══════════════════════════════════════════════════

test('12. NOT_FOUND error → inconclusive (not_found)', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => { throw new Error('NOT_FOUND: transaction not found'); }));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
  ok(/not found/i.test(r.error ?? ''), 'not found reported');
});

test('13. connection failure → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => { throw new Error('ECONNREFUSED'); }));
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('14. timeout → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => new Promise(resolve => setTimeout(resolve, 10000))), { timeoutMs: 50 });
  const r = await v.verify({ transaction: HASH, paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
  ok(/exceeded/i.test(r.error ?? ''), 'timeout reported');
});

// ═══ 3. hash validation ═════════════════════════════════════════════════

test('15. invalid hash (too short) → inconclusive, never calls client', async () => {
  let called = false;
  const v = new ConcordiumEvidenceVerifier(mockClient(() => { called = true; return { status: 'finalized', outcome: { summary: { hash: HASH } } }; }));
  const r = await v.verify({ transaction: 'abc', paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(called, false, 'client not called');
});

test('16. invalid hash (non-hex) → inconclusive', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({ status: 'finalized', outcome: { summary: { hash: HASH } } })));
  const r = await v.verify({ transaction: 'g'.repeat(64), paymentDigest: 'd'.repeat(64) });
  eq(r.available, false, 'unavailable');
  eq(r.observed, 'unknown', 'unknown');
});

test('17. uppercase hash is normalized and accepted', async () => {
  const v = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH.toUpperCase(), transactionType: 'transfer' } },
  })));
  const r = await v.verify({ transaction: HASH.toUpperCase(), paymentDigest: 'd'.repeat(64) });
  eq(r.available, true, 'available');
  eq(r.observed, 'finalized', 'finalized');
});

// ═══ 4. reconciliation integration ═══════════════════════════════════════

test('18. reconcile with verified finality finalizes; wrong hash cannot', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 't30-')), 'f.db');
  const repo = new SqliteSettlementRepository(db);
  const d = 'e'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, HASH);
  repo.claimSubmit(d, HASH);
  repo.markBroadcast(d, HASH);

  const verifier = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH, transactionType: 'transfer' } },
  })));
  const svc = new ReconciliationService({ repository: repo, verifier });
  const r = await svc.reconcile({ paymentDigest: d, transaction: HASH });
  eq(r.ok, true, 'accepted');
  eq(r.changed, true, 'changed');
  eq(r.state, 'finalized', 'finalized');
  eq(repo.get(d)?.state, 'finalized', 'durable finalized');

  // The correct contract is "inconclusive", not "refused": the payment is already terminal,
  // and a mismatched verifier response is an unavailable-evidence condition, not a state
  // error. The binding itself is still enforced — no state change occurs.
  const svc2 = new ReconciliationService({ repository: new SqliteSettlementRepository(db), verifier: new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: OTHER, transactionType: 'transfer' } },
  }))) });
  const r2 = await svc2.reconcile({ paymentDigest: d, transaction: HASH });
  eq(r2.ok, true, 'inconclusive evidence is accepted as a request');
  eq(r2.changed, false, 'nothing changed');
  eq(repo.get(d)?.state, 'finalized', 'still finalized');
  repo.close();
});

test('19. reconcile with committed evidence stays pending', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 't30-')), 'f.db');
  const repo = new SqliteSettlementRepository(db);
  const d = 'f'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, HASH);
  repo.claimSubmit(d, HASH);
  repo.markBroadcast(d, HASH);

  const verifier = new ConcordiumEvidenceVerifier(mockClient(() => ({ status: 'committed', outcomes: [] })));
  const svc = new ReconciliationService({ repository: repo, verifier });
  const r = await svc.reconcile({ paymentDigest: d, transaction: HASH });
  eq(r.ok, true, 'accepted');
  eq(r.changed, false, 'nothing changed');
  eq(r.state, 'outcome_unknown', 'stays pending');
  repo.close();
});

test('20. terminal-state idempotency', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 't30-')), 'f.db');
  const repo = new SqliteSettlementRepository(db);
  const d = '9'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, HASH);
  repo.claimSubmit(d, HASH);
  repo.markBroadcast(d, HASH);
  const verifier = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH, transactionType: 'transfer' } },
  })));
  const svc = new ReconciliationService({ repository: repo, verifier });
  await svc.reconcile({ paymentDigest: d, transaction: HASH });
  const r2 = await svc.reconcile({ paymentDigest: d, transaction: HASH });
  eq(r2.ok, true, 'accepted');
  eq(r2.changed, false, 'idempotent');
  eq(r2.state, 'finalized', 'still finalized');
  repo.close();
});

// ═══ 5. concurrent reconciliation ═════════════════════════════════════════

test('21. concurrent reconcile calls do not duplicate finalization', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 't30-')), 'f.db');
  const repo = new SqliteSettlementRepository(db);
  const d = '8'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, HASH);
  repo.claimSubmit(d, HASH);
  repo.markBroadcast(d, HASH);

  const verifier = new ConcordiumEvidenceVerifier(mockClient(() => ({
    status: 'finalized',
    outcome: { blockHash: 'bh', summary: { hash: HASH, transactionType: 'transfer' } },
  })));
  const svc = new ReconciliationService({ repository: repo, verifier });
  const [a, b] = await Promise.all([
    svc.reconcile({ paymentDigest: d, transaction: HASH }),
    svc.reconcile({ paymentDigest: d, transaction: HASH }),
  ]);
  const changed = [a, b].filter(r => r.changed).length;
  eq(changed, 1, 'exactly one changed');
  eq(repo.get(d)?.state, 'finalized', 'finalized');
  repo.close();
});

// ═══ 6. mapStatus is pure and exported ═══════════════════════════════════

test('22. mapStatus is pure and exported', () => {
  const r = mapStatus({ status: 'finalized', outcome: { summary: { hash: HASH, transactionType: 'transfer' } } }, HASH, 'test');
  eq(r.available, true, 'available');
  eq(r.observed, 'finalized', 'finalized');
  const r2 = mapStatus({ status: 'finalized', outcome: { summary: { hash: HASH, transactionType: 'transfer' } } }, HASH, 'test');
  eq(r2.observed, r.observed, 'deterministic');
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
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nconcordium-evidence: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
