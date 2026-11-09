/**
 * TASK 59 — finalization confirmation & rejection evidence.
 *
 * GAP E (TASK53): a single `rejected` observation permanently terminalized a payment.
 * TASK59 requires REJECTION_CONFIRMATIONS_REQUIRED (2) consistent observations of the
 * SAME transaction hash before `rejected` is applied.
 *
 * Fake signer / fake transport / isolated SQLite only. No broadcast, no signing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  SqliteSettlementRepository,
  REJECTION_CONFIRMATIONS_REQUIRED,
} from '../services/facilitator/src/repository.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { requirementsKey } from '../services/facilitator/src/store.js';
import { interpretObservation } from '../services/facilitator/src/state.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import type { SponsorSigner } from '../services/facilitator/src/signer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const NOW = 1_800_000_000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ok = (v: unknown, m: string): void => check(m, Boolean(v));
const eq = (a: unknown, b: unknown, m: string): void => {
  const norm = (v: unknown): string =>
    typeof v === 'bigint' ? `${v}n` : JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val));
  check(m, norm(a) === norm(b), `expected ${norm(b)}, got ${norm(a)}`);
};

const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '250000', asset: 'CCD' },
  'agenttrust://resource/1004',
);

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t59-${tag}-`));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Seed a broadcast-capable row with a durable hash. */
function seed(repo: SqliteSettlementRepository, digest: string, hash: string): void {
  repo.claim(digest, REQ_KEY);
  repo.prepare(digest, hash);
  repo.claimSubmit(digest, hash);
  repo.markBroadcast(digest, hash);
}

const digestOf = (n: number): string => n.toString(16).padStart(64, '0');

// ═══ 1. status semantics unchanged ════════════════════════════════════════

console.log('\n── 1. status semantics ──');

eq(interpretObservation('finalized').advance, 'finalized', '01. finalized → finalized');
eq(interpretObservation('failed').advance, 'rejected', '02. failed → rejected (evidence class)');
eq(interpretObservation('rejected').advance, 'rejected', '03. rejected → rejected (evidence class)');
eq(interpretObservation('pending').advance, 'stay', '04. pending → stay');
eq(interpretObservation('committed').advance, 'stay', '05. committed → stay');
eq(interpretObservation('unknown').advance, 'stay', '06. unknown → stay (never rejection)');
eq(REJECTION_CONFIRMATIONS_REQUIRED, 2, '07. confirmation threshold is 2');

// ═══ 2. evidence sequence matrix ═══════════════════════════════════════════

console.log('\n── 2. evidence sequence matrix ──');

type Step = { observed: 'finalized' | 'failed' | 'rejected' | 'pending' | 'committed' | 'unknown'; expectState: string; expectChanged: boolean };

function runSequence(tag: string, steps: Step[]): SqliteSettlementRepository {
  const w = tmp(tag);
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(1);
  const hash = 'ab'.repeat(32);
  seed(repo, digest, hash);
  for (const s of steps) {
    const r = repo.reconcile({
      paymentDigest: digest,
      transaction: hash,
      observed: s.observed,
      evidenceSource: 't59',
      evidenceDigest: 'd',
    });
    ok(r.ok, `${tag}: reconcile(${s.observed}) ok`);
    if (r.ok) {
      eq(r.state, s.expectState, `${tag}: after ${s.observed} state=${s.expectState}`);
      eq(r.changed, s.expectChanged, `${tag}: after ${s.observed} changed=${s.expectChanged}`);
    }
  }
  const row = repo.get(digest)!;
  eq(row.tx_hash, hash, `${tag}: hash unchanged`);
  repo.close();
  return repo;
}

// rejected → rejected  ⇒ terminal rejected after the second observation
{
  const w = tmp('rr');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(10);
  const hash = 'b1'.repeat(32);
  seed(repo, digest, hash);

  const first = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  ok(first.ok, '08. first rejection observation accepted');
  if (first.ok) {
    eq(first.changed, false, '09. first rejection does NOT terminalize');
    eq(first.state, 'outcome_unknown', '10. state stays outcome_unknown after one rejection');
  }
  eq(repo.get(digest)!.rejection_observation_count, 1, '11. rejection counter = 1');

  const second = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd2' });
  ok(second.ok, '12. confirming rejection accepted');
  if (second.ok) {
    eq(second.changed, true, '13. second rejection terminalizes');
    eq(second.state, 'rejected', '14. state is rejected');
  }
  eq(repo.get(digest)!.rejection_observation_count, 0, '15. counter cleared on terminalization');
  eq(repo.get(digest)!.tx_hash, hash, '16. hash unchanged');
  repo.close();
  w.rm();
}

// rejected → finalized success ⇒ success wins, counter reset
{
  const w = tmp('rf');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(11);
  const hash = 'b2'.repeat(32);
  seed(repo, digest, hash);

  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  eq(repo.get(digest)!.rejection_observation_count, 1, '17. one rejection recorded');

  const fin = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'finalized', evidenceSource: 't59', evidenceDigest: 'd2' });
  ok(fin.ok, '18. finalized observation accepted');
  if (fin.ok) {
    eq(fin.changed, true, '19. finalized terminalizes immediately (not gated)');
    eq(fin.state, 'finalized', '20. state is finalized, NOT rejected');
  }
  eq(repo.get(digest)!.rejection_observation_count, 0, '21. rejection counter cleared by success');
  repo.close();
  w.rm();
}

// rejected → pending ⇒ counter reset, no terminal
{
  const w = tmp('rp');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(12);
  const hash = 'b3'.repeat(32);
  seed(repo, digest, hash);

  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  eq(repo.get(digest)!.rejection_observation_count, 1, '22. one rejection recorded');

  const pend = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'pending', evidenceSource: 't59', evidenceDigest: 'd2' });
  ok(pend.ok, '23. pending observation accepted');
  if (pend.ok) {
    eq(pend.changed, false, '24. pending does not terminalize');
    eq(pend.state, 'outcome_unknown', '25. state unchanged');
  }
  eq(repo.get(digest)!.rejection_observation_count, 0, '26. pending resets the rejection counter');
  repo.close();
  w.rm();
}

// rejected → unknown ⇒ counter reset
{
  const w = tmp('ru');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(13);
  const hash = 'b4'.repeat(32);
  seed(repo, digest, hash);

  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  const unk = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'unknown', evidenceSource: 't59', evidenceDigest: 'd2' });
  ok(unk.ok, '27. unknown observation accepted');
  if (unk.ok) eq(unk.changed, false, '28. unknown never terminalizes');
  eq(repo.get(digest)!.rejection_observation_count, 0, '29. unknown resets the rejection counter');
  eq(repo.get(digest)!.state, 'outcome_unknown', '30. unknown leaves state non-terminal');
  repo.close();
  w.rm();
}

// rejected → transport error (recovery path) ⇒ counter reset, non-terminal
{
  const w = tmp('rt');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(14);
  const hash = 'b5'.repeat(32);
  seed(repo, digest, hash);
  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  eq(repo.get(digest)!.rejection_observation_count, 1, '31. one rejection recorded');

  // A transport error is handled by markPending in core.recoverPending, not reconcile.
  repo.markPending(digest, hash, 'recovery transport error: UNAVAILABLE');
  eq(repo.get(digest)!.state, 'outcome_unknown', '32. transport error leaves state non-terminal');
  eq(repo.get(digest)!.tx_hash, hash, '33. hash unchanged after transport error');
  repo.close();
  w.rm();
}

// finalized success → rejected ⇒ finalized is never overwritten
{
  const w = tmp('fr');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(15);
  const hash = 'b6'.repeat(32);
  seed(repo, digest, hash);

  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'finalized', evidenceSource: 't59', evidenceDigest: 'd1' });
  eq(repo.get(digest)!.state, 'finalized', '34. finalized applied');

  const late = repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd2' });
  if (late.ok) {
    eq(late.changed, false, '35. late rejection cannot change a finalized payment');
    eq(late.state, 'finalized', '36. state stays finalized');
  } else {
    ok(/terminally finalized/i.test(late.reason), '35. late rejection refused');
  }
  eq(repo.get(digest)!.state, 'finalized', '37. persisted state is finalized');
  repo.close();
  w.rm();
}

// hash mismatch never counts as confirmation
{
  const w = tmp('hm');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(16);
  const hash = 'b7'.repeat(32);
  seed(repo, digest, hash);
  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd1' });
  const wrong = repo.reconcile({ paymentDigest: digest, transaction: 'cc'.repeat(32), observed: 'failed', evidenceSource: 't59', evidenceDigest: 'd2' });
  eq(wrong.ok, false, '38. a rejection naming a different hash is refused');
  eq(repo.get(digest)!.rejection_observation_count, 1, '39. mismatched hash does not increment the counter');
  eq(repo.get(digest)!.state, 'outcome_unknown', '40. state remains non-terminal');
  repo.close();
  w.rm();
}

// ═══ 3. core.recoverPending honours the confirmation gate ═════════════════

console.log('\n── 3. recovery path ──');

const signerWith = (answers: Array<'finalized' | 'failed' | 'pending'>): { signer: SponsorSigner; calls: () => number } => {
  let i = 0;
  const signer: SponsorSigner = {
    info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
    addSponsorSignature: async (t: unknown) => t,
    submitTransaction: async () => {
      throw new Error('t59: recovery must never submit');
    },
    waitForFinalization: async (h: string) => {
      const a = answers[Math.min(i++, answers.length - 1)]!;
      return { txHash: h, status: a, sender: SPONSOR, simulated: true as const };
    },
    getAccountInfo: async () => ({ mocked: true }),
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 6,
  };
  return { signer, calls: () => i };
};

{
  const w = tmp('rec1');
  const digest = digestOf(20);
  const hash = 'd1'.repeat(32);
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  seed(repo, digest, hash);
  repo.close();

  // First recovery pass observes `failed` once.
  const s1 = signerWith(['failed']);
  const c1 = new FacilitatorCore({ network: CAIP2, signer: s1.signer, dbPath: w.db, now: () => NOW * 1000 });
  const r1 = await c1.recoverPending();
  eq(r1.failed, 0, '41. one failed observation does NOT count as a finalized failure');
  const after1 = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  eq(after1.get(digest)!.state, 'outcome_unknown', '42. state still non-terminal after one pass');
  eq(after1.get(digest)!.rejection_observation_count, 1, '43. counter = 1 after one pass');
  after1.close();

  // Second recovery pass confirms.
  const s2 = signerWith(['failed']);
  const c2 = new FacilitatorCore({ network: CAIP2, signer: s2.signer, dbPath: w.db, now: () => NOW * 1000 });
  const r2 = await c2.recoverPending();
  eq(r2.failed, 1, '44. second pass confirms the rejection');
  const after2 = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  eq(after2.get(digest)!.state, 'rejected', '45. state is rejected after confirmation');
  eq(after2.get(digest)!.tx_hash, hash, '46. hash unchanged');
  after2.close();
  w.rm();
}

{
  // A rejected-then-finalized sequence inside recovery resolves to finalized.
  const w = tmp('rec2');
  const digest = digestOf(21);
  const hash = 'd2'.repeat(32);
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  seed(repo, digest, hash);
  repo.close();

  const c1 = new FacilitatorCore({ network: CAIP2, signer: signerWith(['failed']).signer, dbPath: w.db, now: () => NOW * 1000 });
  await c1.recoverPending();

  const c2 = new FacilitatorCore({ network: CAIP2, signer: signerWith(['finalized']).signer, dbPath: w.db, now: () => NOW * 1000 });
  const r2 = await c2.recoverPending();
  eq(r2.finalized, 1, '47. later finalized evidence finalizes');
  const after = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  eq(after.get(digest)!.state, 'finalized', '48. state is finalized, not rejected');
  after.close();
  w.rm();
}

// ═══ 4. concurrency: two workers cannot bypass confirmation ═══════════════

console.log('\n── 4. concurrency ──');

{
  const w = tmp('conc');
  const digest = digestOf(30);
  const hash = 'e1'.repeat(32);
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  seed(repo, digest, hash);
  repo.close();

  // Two independent cores (separate connections) both observe `failed` once.
  const a = new FacilitatorCore({ network: CAIP2, signer: signerWith(['failed']).signer, dbPath: w.db, now: () => NOW * 1000 });
  const b = new FacilitatorCore({ network: CAIP2, signer: signerWith(['failed']).signer, dbPath: w.db, now: () => NOW * 1000 });
  const [ra, rb] = await Promise.all([a.recoverPending(), b.recoverPending()]);

  const after = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const row = after.get(digest)!;
  // Two concurrent observations ARE two consistent observations → terminal is legitimate.
  eq(row.state, 'rejected', '49. two concurrent consistent rejections terminalize');
  eq(row.tx_hash, hash, '50. hash unchanged');
  eq(ra.failed + rb.failed, 1, '51. exactly one worker reports the finalizing rejection');
  // Exactly one settlement row.
  const raw = new (await import('node:sqlite')).DatabaseSync(w.db, { readOnly: true });
  const n = raw.prepare('SELECT COUNT(*) AS n FROM settlements').get() as { n: number };
  const distinct = raw.prepare('SELECT COUNT(DISTINCT tx_hash) AS d FROM settlements').get() as { d: number };
  raw.close();
  eq(Number(n.n), 1, '52. exactly one settlement record');
  eq(Number(distinct.d), 1, '53. exactly one distinct hash');
  after.close();
  w.rm();
}

{
  // A single observation from one worker must not terminalize even with a second worker
  // that observes `pending` (inconsistent evidence).
  const w = tmp('conc2');
  const digest = digestOf(31);
  const hash = 'e2'.repeat(32);
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  seed(repo, digest, hash);
  repo.close();

  const a = new FacilitatorCore({ network: CAIP2, signer: signerWith(['failed']).signer, dbPath: w.db, now: () => NOW * 1000 });
  const b = new FacilitatorCore({ network: CAIP2, signer: signerWith(['pending']).signer, dbPath: w.db, now: () => NOW * 1000 });
  await Promise.all([a.recoverPending(), b.recoverPending()]);

  const after = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  eq(after.get(digest)!.state, 'outcome_unknown', '54. inconsistent evidence does not terminalize');
  ok([0, 1].includes(after.get(digest)!.rejection_observation_count), '55. counter is 0 or 1 (reset or pending)');
  after.close();
  w.rm();
}

// ═══ 5. transport-level: rejected requires a finalized reject outcome ═════

console.log('\n── 5. transport classification ──');

{
  const mk = (status: () => unknown) => {
    const client = {
      sendTransaction: async () => 'ff'.repeat(32),
      getBlockItemStatus: async () => status() as never,
    };
    return new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  };

  const rejected = await mk(() => ({
    status: 'finalized',
    outcome: { summary: { type: 'accountTransaction', hash: 'ff'.repeat(32), transactionType: 'failed' }, blockHash: 'ab'.repeat(32) },
  })).awaitFinalization('ff'.repeat(32), { timeoutMs: 500, intervalMs: 50 });
  eq(rejected.status, 'rejected', '56. finalized+failed → rejected');

  const finalized = await mk(() => ({
    status: 'finalized',
    outcome: { summary: { type: 'accountTransaction', hash: 'ff'.repeat(32), transactionType: 'transfer' }, blockHash: 'ab'.repeat(32) },
  })).awaitFinalization('ff'.repeat(32), { timeoutMs: 500, intervalMs: 50 });
  eq(finalized.status, 'finalized', '57. finalized+success → finalized');

  const pending = await mk(() => ({ status: 'received' })).awaitFinalization('ff'.repeat(32), { timeoutMs: 300, intervalMs: 50 });
  eq(pending.status, 'timeout', '58. received → pending (timeout), never rejected');

  const committed = await mk(() => ({ status: 'committed' })).awaitFinalization('ff'.repeat(32), { timeoutMs: 300, intervalMs: 50 });
  eq(committed.status, 'timeout', '59. committed → pending (timeout), never rejected');

  const notFound = new ConcordiumTransactionSubmitter(
    new GrpcConcordiumTransport({
      sendTransaction: async () => 'ff'.repeat(32),
      getBlockItemStatus: async () => { throw new Error('transaction not found.'); },
    }),
  );
  const nf = await notFound.awaitFinalization('ff'.repeat(32), { timeoutMs: 300, intervalMs: 50 });
  eq(nf.status, 'transport_error', '60. not-found → transport_error, never rejected');

  const malformed = await mk(() => ({ status: 'weird' })).awaitFinalization('ff'.repeat(32), { timeoutMs: 300, intervalMs: 50 });
  eq(malformed.status, 'transport_error', '61. malformed status → transport_error, never rejected');
}

// ═══ 6. legacy / boundary preservation ════════════════════════════════════

console.log('\n── 6. preserved behaviour ──');

{
  const w = tmp('legacy');
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  const digest = digestOf(40);
  const hash = 'f1'.repeat(32);
  seed(repo, digest, hash);

  // markFailed on a broadcast-capable row with a hash is still a no-op (TASK53).
  repo.markFailed(digest, 'late failure');
  eq(repo.get(digest)!.state, 'outcome_unknown', '62. markFailed cannot terminalize a broadcast row');
  repo.close();
  w.rm();
}

{
  // A fresh database created by an older schema migrates the counter column.
  const w = tmp('migrate');
  const db = new (await import('node:sqlite')).DatabaseSync(w.db);
  db.exec(`CREATE TABLE payments (
    payment_digest TEXT PRIMARY KEY, requirements_key TEXT NOT NULL, state TEXT NOT NULL,
    tx_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempted INTEGER NOT NULL DEFAULT 0);
  `);
  db.exec("INSERT INTO payments VALUES ('x','k','outcome_unknown','h',1,1,1)");
  db.close();
  const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
  eq(repo.get('x')!.rejection_observation_count, 0, '63. migration adds the counter defaulting to 0');
  repo.close();
  w.rm();
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask59: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
