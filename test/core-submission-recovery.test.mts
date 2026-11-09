/**
 * TASK 52 — FacilitatorCore V1 submission integration + restart recovery (mock transport only).
 *
 * Run: npx tsx test/core-submission-recovery.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import type { ConcordiumGrpcClientLike } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest } from '../services/facilitator/src/store.js';
import { Transaction } from '@concordium/web-sdk';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { createHash } from 'node:crypto';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = Math.floor(Date.now() / 1000);
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const BLOCK = 'ef'.repeat(32);

const payloadFixture = () => ({
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
  payload: {
    signedTransaction: {
      version: 1,
      header: {
        sender: SENDER,
        nonce: 7,
        expiry: NOW + 200,
        numSignatures: 1,
        sponsor: { address: SPONSOR, numSignatures: 0 },
      },
      payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
      signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
    },
  },
});
const envelope = (p: any) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });

const successSummary = () => ({ type: 'accountTransaction', transactionType: 'transfer' });
const failedSummary = (tag: string) => ({
  type: 'accountTransaction',
  transactionType: 'failed',
  rejectReason: { tag },
});
const finalizedStatus = (summary: unknown) => ({
  status: 'finalized',
  outcome: { summary, blockHash: BLOCK },
});

/** Fake gRPC client that returns the real local hash so core/transport hashes agree. */
function fakeClient(over: {
  status?: () => unknown;
  onSend?: () => void;
  throwOnSend?: boolean;
  throwOnStatus?: boolean;
} = {}): ConcordiumGrpcClientLike {
  return {
    sendTransaction: async (tx: unknown) => {
      over.onSend?.();
      if (over.throwOnSend) throw new Error('FAILED_PRECONDITION: rejected by node');
      return createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(tx as never))).digest('hex');
    },
    getBlockItemStatus: async () => {
      if (over.throwOnStatus) throw new Error('UNAVAILABLE: node offline');
      return (over.status?.() ?? { status: 'committed', outcomes: [] }) as never;
    },
  };
}

/** SponsorSigner backed by the TASK49/50/51 submitter (no keys, no network). */
function submitterSigner(client: ConcordiumGrpcClientLike) {
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  return {
    submitter,
    signer: {
      info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
      addSponsorSignature: async (tx: unknown) => ({
    ...(tx as Record<string, unknown>),
    signatures: {
      ...((tx as { signatures?: unknown }).signatures as Record<string, unknown> ?? {}),
      sponsor: { 0: { 0: 'bb'.repeat(64) } },
    },
  }),
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
      getAccountInfo: async () => ({}),
      getTokenBalance: async () => 0n,
      getTokenDecimals: async () => 6,
    },
  };
}

/**
 * Signer that signs (fixture signature only) but has NO submission adapter configured,
 * mirroring a TASK46-era `IpcSponsorSigner` with no `submitter` injected. Must stay
 * fail-closed exactly like `noSubmit('submitTransaction')`.
 */
function noSubmitterSigner() {
  const refuse = (what: string): never => {
    throw new Error(`${what} is not available in IPC signing mode: this prototype signs only and never broadcasts`);
  };
  return {
    info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
    addSponsorSignature: async (tx: unknown) => ({
      ...(tx as Record<string, unknown>),
      signatures: {
        ...(((tx as { signatures?: unknown }).signatures as Record<string, unknown>) ?? {}),
        sponsor: { 0: { 0: 'bb'.repeat(64) } },
      },
    }),
    validateContext: () => null,
    submitTransaction: () => refuse('submitTransaction'),
    waitForFinalization: () => refuse('waitForFinalization'),
    getAccountInfo: async () => ({}),
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 6,
  };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

function tempDb(): { dir: string; db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t52-'));
  return { dir, db: join(dir, 'f.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── 1. full V1 lifecycle through FacilitatorCore ────────────────────────────

test('01. complete V1 lifecycle: success requires confirmed finalization', async () => {
  const w = tempDb();
  try {
    const { signer } = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()) }));
    const core = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    eq(res.success, true, 'success only after finalization');
    ok(/^[0-9a-f]{64}$/.test(res.transaction), `durable hash: ${res.transaction}`);
    const row = core.store.get(paymentDigest(p));
    eq(row?.state, 'finalized', 'state finalized');
    eq(row?.tx_hash, res.transaction, 'hash matches');
  } finally {
    w.cleanup();
  }
});

test('02. a committed (non-final) node status never yields success', async () => {
  const w = tempDb();
  try {
    const { signer } = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }) }));
    const core = new FacilitatorCore({
      network: CAIP2,
      signer: signer as never,
      dbPath: w.db,
      now: () => NOW * 1000,
      finalizationTimeoutMs: 100,
    });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    eq(res.success, false, 'not success');
    eq(res.errorReason, 'settlement_pending', 'pending');
    eq(core.store.get(paymentDigest(p))?.state, 'outcome_unknown', 'durable non-terminal state');
  } finally {
    w.cleanup();
  }
});

test('03. a finalized rejection is terminal failure, not success', async () => {
  const w = tempDb();
  try {
    const { signer } = submitterSigner(fakeClient({ status: () => finalizedStatus(failedSummary('OutOfEnergy')) }));
    const core = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    eq(res.success, false, 'not success');
    eq(res.errorReason, 'transaction_failed', 'reason');
    // TASK 59: one rejection observation is not terminal; confirm it with a second
    // observation through recovery (same node status) before asserting the terminal state.
    eq(core.store.get(paymentDigest(p))?.state, 'outcome_unknown', 'first rejection recorded, not terminal');
    const summary = await core.recoverPending();
    eq(summary.failed, 1, 'confirmation observed');
    eq(core.store.get(paymentDigest(p))?.state, 'rejected', 'rejected after confirmation');
  } finally {
    w.cleanup();
  }
});

// ── 2. persistence ordering ────────────────────────────────────────────────

test('04. the transaction hash is persisted before submission', async () => {
  const w = tempDb();
  let stateAtSubmit: string | undefined;
  let hashAtSubmit: string | null | undefined;
  try {
    const client = fakeClient({
      status: () => finalizedStatus(successSummary()),
      onSend: () => {
        const row = repo.get(paymentDigest(payloadFixture()));
        stateAtSubmit = row?.state;
        hashAtSubmit = row?.tx_hash;
      },
    });
    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    const { signer } = submitterSigner(client);
    const core = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    await core.settle(envelope(payloadFixture()));
    eq(stateAtSubmit, 'submitting', 'state was submitting at submission time');
    ok(/^[0-9a-f]{64}$/.test(hashAtSubmit ?? ''), `hash already durable: ${hashAtSubmit}`);
    repo.close();
  } finally {
    w.cleanup();
  }
});

test('05. a persistence failure aborts before any submission', async () => {
  const w = tempDb();
  let submitted = false;
  try {
    const real = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    // Fail-closed store: prepare() cannot make the hash durable.
    const failing = Object.create(real) as SqliteSettlementRepository;
    (failing as unknown as { prepare: () => never }).prepare = () => {
      throw new Error('disk full (simulated persistence failure)');
    };
    const { signer } = submitterSigner(
      fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submitted = true; } }),
    );
    const core = new FacilitatorCore({
      network: CAIP2,
      signer: signer as never,
      store: failing,
      now: () => NOW * 1000,
    });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    eq(res.success, false, 'not success');
    eq(res.errorReason, 'hash_persistence_failed', 'reason');
    eq(submitted, false, 'nothing was submitted');
    const row = real.get(paymentDigest(p));
    // The hash may be recorded for audit (markFailed carries it), but it must never reach a
    // broadcast-eligible state: only prepare() may do that, and it threw.
    ok(row?.state !== 'prepared' && row?.state !== 'submitting', `not submission-eligible: ${row?.state}`);
    real.close();
  } finally {
    w.cleanup();
  }
});

// ── 3. crash + restart recovery ────────────────────────────────────────────

test('06. restart with a persisted hash recovers finalization without resubmitting', async () => {
  const w = tempDb();
  try {
    // First process: submission succeeds but finalization is never observed.
    let submits = 0;
    const first = submitterSigner(
      fakeClient({
        status: () => ({ status: 'committed', outcomes: [] }),
        onSend: () => { submits++; },
      }),
    );
    const core1 = new FacilitatorCore({
      network: CAIP2,
      signer: first.signer as never,
      dbPath: w.db,
      now: () => NOW * 1000,
      finalizationTimeoutMs: 100,
    });
    const p = payloadFixture();
    const r1 = await core1.settle(envelope(p));
    eq(r1.success, false, 'first process does not succeed');
    eq(submits, 1, 'one submission');
    const digest = paymentDigest(p);
    const row = core1.store.get(digest);
    eq(row?.state, 'outcome_unknown', 'ambiguous state');
    const hash = row?.tx_hash ?? '';
    ok(/^[0-9a-f]{64}$/.test(hash), 'hash durable');

    // Second process: same DB, different core instance, node now reports finalized.
    const second = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const summary = await core2.recoverPending();
    eq(summary.scanned, 1, 'one recoverable row');
    eq(summary.finalized, 1, 'finalized by recovery');
    eq(submits, 1, 'recovery never resubmitted');
    eq(core2.store.get(digest)?.state, 'finalized', 'finalized');
    eq(core2.store.get(digest)?.tx_hash, hash, 'same hash');
  } finally {
    w.cleanup();
  }
});

test('07. restart while still pending keeps the payment non-terminal', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({
      network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000, finalizationTimeoutMs: 100,
    });
    const p = payloadFixture();
    await core1.settle(envelope(p));

    const second = submitterSigner(fakeClient({ status: () => ({ status: 'received' }), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const summary = await core2.recoverPending();
    eq(summary.finalized, 0, 'not finalized');
    eq(summary.pending, 1, 'reported pending');
    eq(submits, 1, 'no resubmission');
    eq(core2.store.get(paymentDigest(p))?.state, 'outcome_unknown', 'still non-terminal');
  } finally {
    w.cleanup();
  }
});

test('08. restart after finalized success is a no-op (idempotent) and never resubmits', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({ network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    eq((await core1.settle(envelope(p))).success, true, 'finalized');

    const second = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const summary = await core2.recoverPending();
    eq(summary.scanned, 0, 'terminal rows are not recoverable');
    eq(submits, 1, 'no resubmission');
    eq(core2.store.get(paymentDigest(p))?.state, 'finalized', 'still finalized');
  } finally {
    w.cleanup();
  }
});

test('09. restart after finalized rejection stays terminal and is never reopened', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => finalizedStatus(failedSummary('NonExistentAccount')), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({ network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    eq((await core1.settle(envelope(p))).success, false, 'rejected');

    // TASK 59: confirm the rejection with a second observation so it becomes terminal.
    const confirm = submitterSigner(fakeClient({ status: () => finalizedStatus(failedSummary('NonExistentAccount')), onSend: () => { submits++; } }));
    const coreConfirm = new FacilitatorCore({ network: CAIP2, signer: confirm.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const confirmSummary = await coreConfirm.recoverPending();
    eq(confirmSummary.failed, 1, 'confirmation observed');
    eq(coreConfirm.store.get(paymentDigest(p))?.state, 'rejected', 'rejected after confirmation');

    const second = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const summary = await core2.recoverPending();
    eq(summary.scanned, 0, 'terminal rows skipped');
    eq(summary.finalized, 0, 'a rejection is never reopened');
    eq(submits, 1, 'no resubmission');
    eq(core2.store.get(paymentDigest(p))?.state, 'rejected', 'still rejected');
  } finally {
    w.cleanup();
  }
});

test('10. repeated recovery is safe and creates no duplicate records', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({
      network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000, finalizationTimeoutMs: 100,
    });
    const p = payloadFixture();
    await core1.settle(envelope(p));

    const second = submitterSigner(fakeClient({ status: () => ({ status: 'received' }), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    for (let i = 0; i < 3; i++) {
      const s = await core2.recoverPending();
      eq(s.scanned, 1, `pass ${i + 1}: still one recoverable row`);
    }
    eq(submits, 1, 'still exactly one submission');
    const repo = core2.store as SqliteSettlementRepository;
    eq(repo.transitions(paymentDigest(p)).filter((t) => t.to_state === 'finalized').length, 0, 'never finalized');
    eq(repo.pendingCount(), 1, 'exactly one non-terminal row');
  } finally {
    w.cleanup();
  }
});

test('11. recovery with an unknown/malformed status stays non-terminal', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({
      network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000, finalizationTimeoutMs: 100,
    });
    const p = payloadFixture();
    await core1.settle(envelope(p));

    // Malformed BlockItemStatus -> transport throws -> recovery treats it as ambiguous.
    const second = submitterSigner(fakeClient({ status: () => ({ status: 'frobnicated' }), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const s = await core2.recoverPending();
    eq(s.finalized, 0, 'never finalized');
    eq(s.transportErrors, 1, 'reported as transport error');
    eq(submits, 1, 'no resubmission');
    eq(core2.store.get(paymentDigest(p))?.state, 'outcome_unknown', 'non-terminal');
  } finally {
    w.cleanup();
  }
});

test('12. a transport failure during recovery is not success and not a resubmission', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({
      network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000, finalizationTimeoutMs: 100,
    });
    await core1.settle(envelope(payloadFixture()));

    const second = submitterSigner(fakeClient({ throwOnStatus: true, onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: second.signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const s = await core2.recoverPending();
    eq(s.finalized, 0, 'never finalized');
    eq(s.transportErrors, 1, 'transport error recorded');
    eq(submits, 1, 'no resubmission');
  } finally {
    w.cleanup();
  }
});

// ── 4. fail-closed configuration ───────────────────────────────────────────

test('13. a signer without a configured submitter stays fail-closed', async () => {
  const w = tempDb();
  try {
    const signer = noSubmitterSigner();
    const core = new FacilitatorCore({ network: CAIP2, signer, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    eq(res.success, false, 'never success');
    eq(res.errorReason, 'settlement_pending', 'ambiguous/pending');
    ok(/never broadcasts/i.test(String(res.errorMessage)), `fail-closed: ${res.errorMessage}`);
    eq(core.store.get(paymentDigest(p))?.state, 'outcome_unknown', 'non-terminal');
  } finally {
    w.cleanup();
  }
});

test('14. recovery without a configured submitter never reports success', async () => {
  const w = tempDb();
  try {
    let submits = 0;
    const first = submitterSigner(fakeClient({ status: () => ({ status: 'committed', outcomes: [] }), onSend: () => { submits++; } }));
    const core1 = new FacilitatorCore({
      network: CAIP2, signer: first.signer as never, dbPath: w.db, now: () => NOW * 1000, finalizationTimeoutMs: 100,
    });
    await core1.settle(envelope(payloadFixture()));

    const signer = noSubmitterSigner();
    const core2 = new FacilitatorCore({ network: CAIP2, signer, dbPath: w.db, now: () => NOW * 1000 });
    const s = await core2.recoverPending();
    eq(s.finalized, 0, 'nothing finalized');
    eq(s.transportErrors, 1, 'refused lookup counted as transport error');
    eq(submits, 1, 'no resubmission');
  } finally {
    w.cleanup();
  }
});

// ── 5. real-process crash + restart ────────────────────────────────────────

test('15. real process: SIGKILL after submit, restart recovers from the persisted hash', async () => {
  const w = tempDb();
  const child = new URL('../scripts/recovery-crash-child.mts', import.meta.url).pathname;
  try {
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', child, w.db], {
        cwd: new URL('..', import.meta.url).pathname,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      c.on('exit', () => resolve());
    });

    const repo = new SqliteSettlementRepository(w.db, { now: () => NOW * 1000 });
    const rows = repo.listRecoverable();
    eq(rows.length, 1, 'exactly one ambiguous row survived the kill');
    eq(rows[0]?.state, 'outcome_unknown', 'state is ambiguous, not success');
    ok(/^[0-9a-f]{64}$/.test(rows[0]?.tx_hash ?? ''), 'hash survived');
    eq(rows[0]?.state === 'finalized', false, 'never success');
    repo.close();

    // Restart: a fresh core (fresh DB handle) recovers to finalized without resubmitting.
    let submits = 0;
    const { signer } = submitterSigner(fakeClient({ status: () => finalizedStatus(successSummary()), onSend: () => { submits++; } }));
    const core2 = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const s = await core2.recoverPending();
    eq(s.finalized, 1, 'recovered to finalized');
    eq(submits, 0, 'recovery issued zero submissions');
  } finally {
    w.cleanup();
  }
});

// ── safety invariants ──────────────────────────────────────────────────────

test('S01. DENY_ALL_FACILITATOR remains intact', async () => {
  const { DENY_ALL_FACILITATOR } = await import('../src/payments/x402.js');
  ok(DENY_ALL_FACILITATOR !== undefined, 'exported');
  const v = await DENY_ALL_FACILITATOR.verify({} as never, {} as never).then(() => false, () => true);
  const s = await DENY_ALL_FACILITATOR.settle({} as never, {} as never).then(() => false, () => true);
  ok(v, 'verify refuses');
  ok(s, 'settle refuses');
});

test('S02. settlement stays disabled by default', async () => {
  const { guardSettlement } = await import('../src/payments/operatorSigning.js');
  const g = guardSettlement({
    allowSettlement: false,
    payload: {},
    requirements: {} as never,
    expectedSponsor: SPONSOR,
    authorization: undefined,
  });
  eq(g.ok, false, 'refused');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
});

test('S03. recovery exposes no submission method of its own', () => {
  const core = new FacilitatorCore({ network: CAIP2, signer: submitterSigner(fakeClient()).signer as never });
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(core));
  ok(proto.includes('recoverPending'), 'recovery exists');
  for (const forbidden of ['submit', 'resubmit', 'sign', 'broadcast']) {
    ok(!proto.some((m) => m.toLowerCase() === forbidden), `no ${forbidden}() method on the core`);
  }
});

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
  console.log(`\ntask52: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
