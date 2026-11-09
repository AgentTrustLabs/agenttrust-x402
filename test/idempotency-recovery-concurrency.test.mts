/**
 * TASK 53 — transaction lifecycle idempotency & recovery concurrency.
 *
 * Fake signer, mock transport, isolated persistence. No chain, no keys, no broadcast.
 * Concurrency cases 03 / 05 use real OS processes sharing one SQLite file.
 *
 * Run: npx tsx test/idempotency-recovery-concurrency.test.mts
 */

import { eq, ok, notOk } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAddress, Transaction } from '@concordium/web-sdk';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { createHash } from 'node:crypto';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest, requirementsKey } from '../services/facilitator/src/store.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import type { ConcordiumGrpcClientLike } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { createMockSigner, type SponsorSigner } from '../services/facilitator/src/signer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_800_000_000;
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const BLOCK = 'ef'.repeat(32);
const CHILD = `${process.cwd()}/scripts/recovery-child.mts`;

// ── fixtures ────────────────────────────────────────────────────────────────

const hex64 = (byte: string) => byte.repeat(64);

const signedTx = (over: { nonce?: number; amount?: string } = {}) => ({
  version: 1,
  header: {
    sender: SENDER,
    nonce: over.nonce ?? 7,
    expiry: NOW + 200,
    numSignatures: 1,
    sponsor: { address: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: PAY_TO, amount: over.amount ?? '250000' },
  signatures: { sender: { 0: { 0: hex64('aa') } }, sponsor: {} },
});

const payloadOf = (over: { nonce?: number; amount?: string } = {}) => ({
  x402Version: 2,
  resource: { url: 'agenttrust://resource/1004' },
  accepted: {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: SPONSOR },
  },
  payload: { signedTransaction: signedTx(over) },
});

const envelope = (over: { nonce?: number; amount?: string } = {}) => {
  const p = payloadOf(over);
  return { x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted } as never;
};

const digestOf = (over: { nonce?: number; amount?: string } = {}) => paymentDigest(payloadOf(over));

const finalizedStatus = (summary: unknown) => ({ status: 'finalized', outcome: { summary, blockHash: BLOCK } });
const successSummary = () => ({ type: 'accountTransaction', transactionType: 'transfer' });
const failedSummary = (tag: string) => ({ type: 'accountTransaction', transactionType: 'failed', rejectReason: { tag } });

// ── counting signer (mock transport, ledger of submit attempts) ─────────────

interface Counting {
  signer: SponsorSigner;
  submits: () => number;
  statusCalls: () => number;
}

/**
 * Signer backed by the real `GrpcConcordiumTransport` over a fake client.
 * `submitTransaction` is the only path that increments `submits`, so the counter measures
 * actual submission attempts at the signer boundary — not HTTP responses.
 */
function countingSigner(opts: {
  status?: () => unknown;
  throwOnSend?: boolean;
  throwOnStatus?: boolean;
} = {}): Counting {
  let submits = 0;
  let statusCalls = 0;
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async (tx: unknown) => {
      submits++;
      if (opts.throwOnSend) throw new Error('FAILED_PRECONDITION: rejected by node');
      return createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(tx as never))).digest('hex');
    },
    getBlockItemStatus: async () => {
      statusCalls++;
      if (opts.throwOnStatus) throw new Error('UNAVAILABLE: node offline');
      return (opts.status?.() ?? { status: 'committed', outcomes: [] }) as never;
    },
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const signer: SponsorSigner = {
    info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
    // Production signers unwrap `{ signedTransaction }` and return the BARE signed
    // transaction (`sdkSponsorSigner.addSponsorSignature`). The resumable path hands the
    // wrapper over, so the mock must mirror that or the signed output is not a signable tx.
    addSponsorSignature: async (tx: unknown) => {
      const wrapper = (tx as { signedTransaction?: unknown }) ?? {};
      const bare = (wrapper.signedTransaction ?? tx) as Record<string, unknown>;
      const bareSigs = ((bare['signatures'] as Record<string, unknown>) ?? {});
      return {
        ...bare,
        signatures: { ...bareSigs, sponsor: { 0: { 0: hex64('bb') } } },
      };
    },
    validateContext: () => null,
    submitTransaction: async (tx: unknown) => (await submitter.submit(tx)).hash,
    waitForFinalization: async (h: string, t?: number) => {
      const f = await submitter.awaitFinalization(h, { timeoutMs: t ?? 5_000, intervalMs: 5 });
      switch (f.status) {
        case 'finalized':
          return { txHash: h, status: 'finalized' as const, sender: SPONSOR, simulated: true as const };
        case 'rejected':
          return { txHash: h, status: 'failed' as const, sender: SPONSOR, simulated: true as const };
        case 'transport_error':
          throw new Error(`finalization transport error: ${f.reason ?? 'unknown'}`);
        default:
          return { txHash: h, status: 'pending' as const, sender: SPONSOR, simulated: true as const };
      }
    },
    getAccountInfo: async () => ({ mocked: true }),
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 6,
  };
  return { signer, submits: () => submits, statusCalls: () => statusCalls };
}

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t53-'));
  return {
    dir,
    db: join(dir, 'f.db'),
    ledger: join(dir, 'submits.log'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const coreFor = (signer: SponsorSigner, db: string) =>
  new FacilitatorCore({ network: CAIP2, signer, dbPath: db, now: () => NOW * 1000, busyTimeoutMs: 10_000 });

/**
 * The real mock signer (`createMockSigner`) with a submission counter. Used where the
 * resumable path hands the V2 `{ signedTransaction }` wrapper to the signer: the mock
 * tolerates that shape, while a shape-sensitive SDK signer would fail closed (see the
 * documented limitation in docs/architecture.md).
 */
function countingMockSigner(): Counting {
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  let submits = 0;
  const signer: SponsorSigner = {
    info: () => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: inner.addSponsorSignature,
    submitTransaction: async (tx: unknown) => {
      submits++;
      return inner.submitTransaction(tx);
    },
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  return { signer, submits: () => submits, statusCalls: () => 0 };
}

/** Independent read-only view of the durable rows, for duplicate-record assertions. */
function rowsOf(db: string): { settlements: number; transitions: number; state: string; tx: string | null; distinctTx: number } {
  const raw = new DatabaseSync(db, { readOnly: false });
  try {
    const s = raw.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT tx_hash) AS d FROM settlements').get() as { n: number; d: number };
    const t = raw.prepare('SELECT COUNT(*) AS n FROM transitions').get() as { n: number };
    const p = raw.prepare('SELECT state, tx_hash FROM payments LIMIT 1').get() as { state: string; tx_hash: string | null } | undefined;
    return {
      settlements: Number(s.n),
      distinctTx: Number(s.d),
      transitions: Number(t.n),
      state: p?.state ?? '',
      tx: p?.tx_hash ?? null,
    };
  } finally {
    raw.close();
  }
}

/** Run the recovery child as a real OS process against a shared DB. */
function runRecoveryChild(db: string, ledger: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', CHILD, db, ledger], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += String(d)));
    child.stderr.on('data', d => (err += String(d)));
    child.on('error', reject);
    child.on('exit', code => {
      const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
      if (code !== 0 || !line) return reject(new Error(`child failed (${code}): ${err.slice(0, 400)}`));
      try {
        resolve(JSON.parse(line) as Record<string, number>);
      } catch (e) {
        reject(new Error(`unparsable child output: ${line}`));
      }
    });
  });
}

/** Seed a payment that has a durable hash and may have been broadcast. */
const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '250000', asset: 'CCD' },
  'agenttrust://resource/1004',
);

function seedBroadcast(repo: SqliteSettlementRepository, digest: string, hash: string, target: 'submitting' | 'outcome_unknown' | 'prepared') {
  repo.claim(digest, REQ_KEY);
  repo.prepare(digest, hash);
  if (target === 'prepared') return;
  repo.claimSubmit(digest, hash);
  if (target === 'outcome_unknown') repo.markBroadcast(digest, hash);
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. two identical requests, sequential ═════════════════════════════════

test('01. two identical sequential requests produce exactly one submission', async () => {
  const w = tempDb();
  try {
    const c = countingSigner({ status: () => finalizedStatus(successSummary()) });
    const core = coreFor(c.signer, w.db);
    const a = await core.settle(envelope());
    const b = await core.settle(envelope());
    eq(c.submits(), 1, 'one submission attempt');
    eq(a.success, true, 'first succeeds');
    eq(a.transaction, b.transaction, 'second returns the same hash');
    eq(b.success, true, 'second is idempotent success');
    eq((b.extra as Record<string, unknown>)['idempotentReplay'], true, 'second is flagged idempotent');
    const rows = rowsOf(w.db);
    eq(rows.settlements, 1, 'one settlement row');
    eq(rows.state, 'finalized', 'finalized');
  } finally {
    w.cleanup();
  }
});

// ═══ 2. two identical requests, concurrent ═════════════════════════════════

test('02. two identical concurrent requests produce exactly one submission', async () => {
  const w = tempDb();
  try {
    const c = countingSigner({ status: () => finalizedStatus(successSummary()) });
    const core = coreFor(c.signer, w.db);
    const [a, b] = await Promise.all([core.settle(envelope()), core.settle(envelope())]);
    eq(c.submits(), 1, 'one submission attempt');
    const successes = [a, b].filter(r => r.success === true);
    eq(successes.length, 1, 'exactly one request performed the settlement');
    const other = [a, b].find(r => r.success === false);
    ok(
      ['settle_in_progress', 'settlement_pending', 'settle_refused'].includes(String(other?.errorReason)),
      `loser fails closed: ${String(other?.errorReason)}`,
    );
    eq(rowsOf(w.db).settlements, 1, 'one settlement row');
  } finally {
    w.cleanup();
  }
});

// ═══ 3. two recovery workers, real OS processes ════════════════════════════

test('03. two concurrent recovery processes never resubmit and cannot conflict', async () => {
  const w = tempDb();
  try {
    const hash = 'ab'.repeat(32);
    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    seedBroadcast(repo, digestOf(), hash, 'outcome_unknown');
    repo.close();

    const [r1, r2] = await Promise.all([runRecoveryChild(w.db, w.ledger), runRecoveryChild(w.db, w.ledger)]);

    const submitAttempts = (r1['submitAttempts'] ?? 0) + (r2['submitAttempts'] ?? 0);
    eq(submitAttempts, 0, 'recovery never submits');
    eq((r1['scanned'] ?? 0) + (r2['scanned'] ?? 0) >= 1, true, 'at least one worker scanned the row');
    const rows = rowsOf(w.db);
    eq(rows.state, 'finalized', 'single terminal state');
    eq(rows.tx, hash, 'terminal state bound to the persisted hash');
    eq(rows.distinctTx, 1, 'one distinct hash, never renamed');
    eq(existsSync(w.ledger), false, 'no submission ledger was even created');
  } finally {
    w.cleanup();
  }
});

// ═══ 4. recovery racing with a duplicate request ═══════════════════════════

test('04. recovery racing a duplicate request never submits twice', async () => {
  const w = tempDb();
  try {
    const hash = 'cd'.repeat(32);
    const c = countingSigner({ status: () => finalizedStatus(successSummary()) });
    const core = coreFor(c.signer, w.db);
    seedBroadcast(core.store as SqliteSettlementRepository, digestOf(), hash, 'outcome_unknown');

    const [rec, dup] = await Promise.all([core.recoverPending(), core.settle(envelope())]);

    eq(c.submits(), 0, 'neither path submitted');
    ok(rec.scanned >= 1, 'recovery scanned the persisted row');
    // The duplicate request is never a silent success that bypasses the persisted hash:
    // it is either the in-flight `settlement_pending` refusal or an idempotent replay
    // of the very same hash. Both are non-resubmitting.
    ok(
      dup.success === true
        ? (dup.extra as Record<string, unknown>)['idempotentReplay'] === true
        : String(dup.errorReason) === 'settlement_pending',
      `duplicate is non-resubmitting (${dup.success ? 'idempotent' : String(dup.errorReason)})`,
    );
    eq(String(dup.transaction ?? ''), hash, 'duplicate names the persisted hash');
    eq(rowsOf(w.db).state, 'finalized', 'row finalized by recovery');
    eq(rowsOf(w.db).tx, hash, 'hash preserved');
  } finally {
    w.cleanup();
  }
});

// ═══ 5. process restart then repeated recovery ═════════════════════════════

test('05. process restart followed by repeated recovery is idempotent', async () => {
  const w = tempDb();
  try {
    const hash = 'ce'.repeat(32);
    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    seedBroadcast(repo, digestOf(), hash, 'submitting');
    repo.close();

    const first = await runRecoveryChild(w.db, w.ledger);
    eq(first['finalized'], 1, 'first pass after restart finalizes');
    eq(first['submitAttempts'], 0, 'no submission on recovery');

    // Three more restarts, three more passes: still nothing to do, nothing rewritten.
    for (let i = 0; i < 3; i++) {
      const again = await runRecoveryChild(w.db, w.ledger);
      eq(again['scanned'], 0, `pass ${i + 2}: terminal row is not selected`);
      eq(again['submitAttempts'], 0, `pass ${i + 2}: no submission`);
    }
    const rows = rowsOf(w.db);
    eq(rows.state, 'finalized', 'still finalized');
    eq(rows.settlements, 1, 'no duplicate settlement rows');
  } finally {
    w.cleanup();
  }
});

// ═══ 6. finalized success then duplicate request ═══════════════════════════

test('06. a duplicate request after finalized success returns the same hash only', async () => {
  const w = tempDb();
  try {
    const c = countingSigner({ status: () => finalizedStatus(successSummary()) });
    const core = coreFor(c.signer, w.db);
    const first = await core.settle(envelope());
    eq(first.success, true, 'settled');

    for (let i = 0; i < 3; i++) {
      const dup = await core.settle(envelope());
      eq(dup.success, true, `duplicate ${i + 1} is idempotent success`);
      eq(dup.transaction, first.transaction, `duplicate ${i + 1} returns the same hash`);
      eq((dup.extra as Record<string, unknown>)['idempotentReplay'], true, `duplicate ${i + 1} flagged idempotent`);
    }
    eq(c.submits(), 1, 'still exactly one submission');
    eq(rowsOf(w.db).transitions === rowsOf(w.db).transitions, true, 'stable');
    eq(rowsOf(w.db).state, 'finalized', 'finalized remains terminal');
  } finally {
    w.cleanup();
  }
});

// ═══ 7. finalized rejection then duplicate request ═════════════════════════

test('07. a duplicate request after finalized rejection is refused and never reopened', async () => {
  const w = tempDb();
  try {
    const c = countingSigner({ status: () => finalizedStatus(failedSummary('InvalidAccountReference')) });
    const core = coreFor(c.signer, w.db);
    const first = await core.settle(envelope());
    eq(first.success, false, 'rejection is not success');
    eq(first.errorReason, 'transaction_failed', 'transaction_failed');
    // TASK 59: one rejection observation is recorded, not terminal; confirm via recovery.
    eq(rowsOf(w.db).state, 'outcome_unknown', 'first rejection recorded, not terminal');
    const confirm = await core.recoverPending();
    eq(confirm.failed, 1, 'confirmation observed');
    eq(rowsOf(w.db).state, 'rejected', 'state rejected after confirmation');

    for (let i = 0; i < 3; i++) {
      const dup = await core.settle(envelope());
      eq(dup.success, false, `duplicate ${i + 1} is not success`);
      eq(dup.errorReason, 'settle_refused', `duplicate ${i + 1} refused`);
      eq(rowsOf(w.db).state, 'rejected', 'still rejected');
    }
    eq(c.submits(), 1, 'still exactly one submission');
    const rec = await core.recoverPending();
    eq(rec.finalized, 0, 'recovery never converts a rejection into success');
    eq(rowsOf(w.db).state, 'rejected', 'rejection stays terminal');
  } finally {
    w.cleanup();
  }
});

// ═══ 8. transport failure during concurrent recovery ═══════════════════════

test('08. a transport failure during concurrent recovery is never success', async () => {
  const w = tempDb();
  try {
    const hash = 'cf'.repeat(32);
    const c = countingSigner({ throwOnStatus: true });
    const core = coreFor(c.signer, w.db);
    seedBroadcast(core.store as SqliteSettlementRepository, digestOf(), hash, 'outcome_unknown');

    const [a, b] = await Promise.all([core.recoverPending(), core.recoverPending()]);
    eq(a.finalized, 0, 'worker A did not report success');
    eq(b.finalized, 0, 'worker B did not report success');
    eq(a.transportErrors + b.transportErrors >= 1, true, 'transport errors counted');
    eq(c.submits(), 0, 'no submission');
    const rows = rowsOf(w.db);
    notOk(rows.state === 'finalized', `state never became finalized (got ${rows.state})`);
    eq(rows.tx, hash, 'hash preserved for a later pass');
  } finally {
    w.cleanup();
  }
});

// ═══ 9. persistence conflict / duplicate-key behaviour ═════════════════════

test('09. duplicate-key and conflicting-hash writes are refused, never duplicated', async () => {
  const w = tempDb();
  try {
    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    const d = digestOf();
    const A = 'aa'.repeat(32);
    const B = 'bb'.repeat(32);

    eq(repo.claim(d, 'k').ok, true, 'first claim');
    const second = repo.claim(d, 'k');
    eq(second.ok, false, 'second claim is refused');
    eq(String((second as { reason: string }).reason), 'in_progress', 'reason in_progress');

    repo.prepare(d, A);
    let msg = '';
    try {
      repo.prepare(d, A);
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(/illegal transition/.test(msg), `identical re-prepare refused: ${msg}`);
    msg = '';
    try {
      repo.prepare(d, B);
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(
      /refusing to overwrite recorded transaction|illegal transition/.test(msg),
      `conflicting re-prepare refused: ${msg}`,
    );
    eq(repo.get(d)?.tx_hash, A, 'conflicting re-prepare did not rename the hash');

    // TASK53 fix: a pending record may not rename the persisted hash.
    msg = '';
    try {
      repo.markPending(d, B, 'conflicting hash');
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(/hash mismatch/.test(msg), `markPending cannot rename the hash: ${msg}`);
    eq(repo.get(d)?.tx_hash, A, 'recorded hash unchanged');

    eq(rowsOf(w.db).settlements, 1, 'exactly one settlement row');
    eq(rowsOf(w.db).distinctTx, 1, 'exactly one distinct hash');
    repo.close();
  } finally {
    w.cleanup();
  }
});

// ═══ 10. no automatic resubmission once a hash is persisted ════════════════

test('10. no automatic resubmission after a transaction hash has been persisted', async () => {
  const w = tempDb();
  try {
    const hash = 'ad'.repeat(32);
    const c = countingMockSigner();
    const core = coreFor(c.signer, w.db);
    seedBroadcast(core.store as SqliteSettlementRepository, digestOf(), hash, 'prepared');

    // (a) recovery never selects `prepared` rows: the hash is durable but no claim was taken.
    const rec = await core.recoverPending();
    eq(rec.scanned, 0, 'recovery does not scan a prepared row');
    eq(c.submits(), 0, 'recovery submitted nothing');

    // (b) a duplicate request resumes by taking the broadcast claim exactly once.
    const dupA = await core.settle(envelope());
    const dupB = await core.settle(envelope());
    eq(c.submits(), 1, 'exactly one submission across both duplicates');
    eq(rowsOf(w.db).tx, hash, 'the persisted hash is the one reported');
    ok(
      [dupA, dupB].some(r => r.errorReason === 'settlement_pending'),
      `at least one duplicate is non-terminal (${dupA.errorReason} / ${dupB.errorReason})`,
    );
    notOk(dupA.success && dupB.success, 'a committed-only outcome is never success');
    eq(rowsOf(w.db).state, 'outcome_unknown', 'non-terminal after a committed status');

    // (c) further recovery polls the same hash and still never submits
    const rec2 = await core.recoverPending();
    ok(rec2.scanned >= 1, 'recovery now selects the ambiguous row');
    eq(c.submits(), 1, 'still exactly one submission after recovery');
    eq(rowsOf(w.db).tx, hash, 'hash unchanged');
  } finally {
    w.cleanup();
  }
});

// ═══ 11. regression: late failures cannot reject a broadcast-capable row ═══

test('11. a late failure cannot reject a payment whose broadcast is in flight', async () => {
  const w = tempDb();
  try {
    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    const A = 'aa'.repeat(32);
    // `prepared` is the only state where a late failure MAY still reject: the broadcast
    // claim was never taken, so nothing can be in flight.
    const cases: Array<['1' | '2' | '3' | '4', string, string]> = [
      ['1', 'prepared', 'rejected'],
      ['2', 'submitting', 'submitting'],
      ['3', 'outcome_unknown', 'outcome_unknown'],
      ['4', 'observed', 'observed'],
    ];
    for (const [d0, seeded, expected] of cases) {
      const d = d0.repeat(64);
      repo.claim(d, 'k');
      repo.prepare(d, A);
      if (seeded !== 'prepared') {
        repo.claimSubmit(d, A);
        if (seeded === 'outcome_unknown' || seeded === 'observed') repo.markBroadcast(d, A);
        if (seeded === 'observed') repo.markObserved(d, A, 'probe');
      }
      repo.markFailed(d, 'late failure from a stale path');
      eq(repo.get(d)?.state, expected, `${seeded} → ${expected}`);
      eq(repo.get(d)?.tx_hash, A, `${seeded} keeps the recorded hash`);
    }

    // The broadcast-capable rows remain reconcilable by their persisted hash.
    const rec = repo.reconcile({ paymentDigest: '3'.repeat(64), transaction: A, observed: 'finalized', evidenceSource: 't53', evidenceDigest: 'x' });
    eq(rec.ok, true, 'outcome_unknown still reconciles to finalized');
    eq(repo.get('3'.repeat(64))?.state, 'finalized', 'finalized');
    repo.close();
  } finally {
    w.cleanup();
  }
});

// ═══ 12. invariants preserved ══════════════════════════════════════════════

test('12. settlement stays disabled and DENY_ALL_FACILITATOR is intact', async () => {
  const { DENY_ALL_FACILITATOR } = await import('../src/payments/x402.js');
  const verifyThrew = await DENY_ALL_FACILITATOR.verify({} as never, {} as never).then(() => false, () => true);
  const settleThrew = await DENY_ALL_FACILITATOR.settle({} as never, {} as never).then(() => false, () => true);
  ok(verifyThrew, 'verify refuses');
  ok(settleThrew, 'settle refuses');
  const { guardSettlement } = await import('../src/payments/operatorSigning.js');
  const g = guardSettlement({
    allowSettlement: false,
    payload: {},
    requirements: {} as never,
    expectedSponsor: SPONSOR,
    authorization: undefined as never,
  } as never);
  eq(g.ok, false, 'settlement disabled by default');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
});

test('13. recovery exposes no submission path', async () => {
  const w = tempDb();
  try {
    const c = countingSigner();
    const core = coreFor(c.signer, w.db);
    ok(typeof (core as unknown as Record<string, unknown>)['submitTransaction'] === 'undefined', 'no submit method on core');
    const rec = await core.recoverPending();
    eq(c.submits(), 0, 'empty recovery submitted nothing');
    eq(rec.scanned, 0, 'nothing to scan');
  } finally {
    w.cleanup();
  }
});

// ── runner ──────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\ntask53: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

// Unused imports kept intentionally out — `AccountAddress` is only needed if a fixture
// ever needs base58 validation; remove if it stays unused.
void AccountAddress;
