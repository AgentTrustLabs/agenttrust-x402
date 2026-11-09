/**
 * TASK 49 — Concordium transaction submission & finalization adapter tests.
 *
 * Deterministic mock transport only. No Concordium Testnet or Mainnet contact.
 *
 * Run: npx tsx test/task49-transaction-submission-finalization.test.mts
 */

import { eq, ok } from './helpers.mjs';
import {
  ConcordiumTransactionSubmitter,
  type ConcordiumTransactionTransport,
  type TransportStatus,
} from '../services/facilitator/src/concordiumTransactionSubmitter.js';

const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);
const BLOCK = 'ef'.repeat(32);

const validTx = () => ({
  version: 1,
  header: {
    sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    nonce: 7,
    expiry: Math.floor(Date.now() / 1000) + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5', numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', amount: '1' },
  signatures: {
    sender: { 0: { 0: 'aa'.repeat(64) } },
    sponsor: { 0: { 0: 'bb'.repeat(64) } },
  },
});

/** A scriptable mock transport. Every method is recorded so tests can assert call counts. */
function mockTransport(over: Partial<ConcordiumTransactionTransport> = {}) {
  const calls: Array<{ method: string; hash?: string }> = [];
  const state = {
    submitCalls: 0,
    getStatusCalls: 0,
    submitImpl: over.submit ?? (async () => HASH),
    statusImpl: over.getStatus ?? (async () => ({ status: 'pending' as const })),
  };
  const transport: ConcordiumTransactionTransport = {
    async submit(tx: unknown) {
      calls.push({ method: 'submit' });
      state.submitCalls++;
      void tx;
      return state.submitImpl(tx);
    },
    async getStatus(hash: string) {
      calls.push({ method: 'getStatus', hash });
      state.getStatusCalls++;
      return state.statusImpl(hash);
    },
  };
  return { transport, calls, state };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 1. successful submission ────────────────────────────────────────────────

test('01. successful submission returns the transport hash', async () => {
  const { transport, state } = mockTransport({ submit: async () => HASH });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const r = await sub.submit(validTx());
  eq(r.status, 'accepted', 'status');
  eq(r.hash, HASH, 'hash');
  eq(state.submitCalls, 1, 'transport called once');
});

// ── 2. transaction hash propagation ──────────────────────────────────────────

test('02. the hash returned by submit propagates into awaitFinalization', async () => {
  const { transport, calls } = mockTransport({
    submit: async () => HASH2,
    getStatus: async () => ({ status: 'finalized' as const, blockHash: BLOCK }),
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const s = await sub.submit(validTx());
  const f = await sub.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.hash, HASH2, 'finalization hash matches submission hash');
  eq(f.status, 'finalized', 'finalized');
  eq(calls[1]?.method, 'getStatus', 'status queried');
  eq(calls[1]?.hash, HASH2, 'status queried for the submitted hash');
});

// ── 3. duplicate submission behavior ─────────────────────────────────────────

test('03. duplicate submission: the transport decides; the adapter does not dedupe', async () => {
  const { transport, state } = mockTransport({ submit: async () => HASH });
  const sub = new ConcordiumTransactionSubmitter(transport);
  await sub.submit(validTx());
  await sub.submit(validTx());
  eq(state.submitCalls, 2, 'adapter forwards every submission; dedupe is the transport/pipeline job');
});

test('03b. a transport that rejects a duplicate surfaces the rejection', async () => {
  const { transport } = mockTransport({
    submit: async () => { throw new Error('duplicate transaction: already in the node'); },
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  let msg = '';
  try { await sub.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/submission rejected: duplicate transaction/.test(msg), `rejection preserved: "${msg}"`);
});

// ── 4. submission rejection ──────────────────────────────────────────────────

test('04. submission rejection propagates the transport reason', async () => {
  const { transport } = mockTransport({
    submit: async () => { throw new Error('insufficient balance for fee'); },
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  let msg = '';
  try { await sub.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/insufficient balance for fee/.test(msg), `reason preserved: "${msg}"`);
});

// ── 5. malformed transaction input ──────────────────────────────────────────────

test('05. malformed transactions are rejected before the transport is touched', async () => {
  const { transport, state } = mockTransport();
  const sub = new ConcordiumTransactionSubmitter(transport);
  const cases: Array<[string, unknown]> = [
    ['not an object', null],
    ['array', []],
    ['missing header', { version: 1, payload: {}, signatures: {} }],
    ['missing payload', { version: 1, header: {}, signatures: {} }],
    ['missing signatures', { version: 1, header: {}, payload: {} }],
    ['empty sponsor signature', { ...validTx(), signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} } }],
    ['v0 transaction', { ...validTx(), version: 0 }],
  ];
  for (const [label, tx] of cases) {
    let msg = '';
    try { await sub.submit(tx); } catch (e) { msg = (e as Error).message; }
    ok(/malformed transaction/.test(msg), `${label} rejected`);
  }
  eq(state.submitCalls, 0, 'transport never reached for malformed input');
});

// ── 6. finalization pending ──────────────────────────────────────────────────

test('06. pending status is reported as pending, never as success', async () => {
  const { transport } = mockTransport({ getStatus: async () => ({ status: 'pending' as const }) });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 60, intervalMs: 10 });
  eq(f.status, 'timeout', 'bounded wait ends in timeout, not success');
  ok(f.reason !== undefined, 'a reason is supplied');
});

// ── 7. finalization success ──────────────────────────────────────────────────

test('07. finalized status is reported with the block hash', async () => {
  const { transport } = mockTransport({
    getStatus: async () => ({ status: 'finalized' as const, blockHash: BLOCK }),
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'finalized', 'finalized');
  eq(f.blockHash, BLOCK, 'block hash propagated');
  eq(f.reason, undefined, 'no rejection reason on success');
});

// ── 8. finalization rejection with reason ────────────────────────────────────

test('08. rejected status preserves the SDK reject reason', async () => {
  const { transport } = mockTransport({
    getStatus: async () => ({ status: 'rejected' as const, reason: 'NonExistentAccount' }),
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'rejected', 'rejected');
  eq(f.reason, 'NonExistentAccount', 'reason preserved');
  eq(f.blockHash, undefined, 'no block hash on rejection');
});

// ── 9. finalization timeout ──────────────────────────────────────────────────

test('09. timeout is bounded and never becomes success', async () => {
  const { transport } = mockTransport({ getStatus: async () => ({ status: 'pending' as const }) });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const started = Date.now();
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 120, intervalMs: 20 });
  const elapsed = Date.now() - started;
  eq(f.status, 'timeout', 'timeout');
  ok(elapsed < 1_000, `bounded (took ${elapsed}ms)`);
  eq(f.blockHash, undefined, 'no block hash on timeout');
});

// ── 10. RPC disconnect during monitoring ─────────────────────────────────────

test('10. a transport error during monitoring is a transport_error, not success', async () => {
  const { transport } = mockTransport({
    getStatus: async () => { throw new Error('grpc: connection reset by peer'); },
  });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'transport_error', 'transport_error');
  ok(/connection reset by peer/.test(f.reason ?? ''), `reason preserved: "${f.reason}"`);
});

// ── 11. invalid or unknown finalization response ─────────────────────────────

test('11. an unrecognized status is a transport_error, not success', async () => {
  const weird = {
    submit: async () => HASH,
    getStatus: async (): Promise<TransportStatus> => ({ status: 'committed' as never }),
  };
  const sub = new ConcordiumTransactionSubmitter(weird);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'transport_error', 'unrecognized status fails closed');
  ok(/unrecognized finalization status/.test(f.reason ?? ''), `reason: "${f.reason}"`);
});

test('11b. a malformed status object fails closed', async () => {
  const sub = new ConcordiumTransactionSubmitter({
    submit: async () => HASH,
    getStatus: async () => (undefined as unknown as TransportStatus),
  });
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'transport_error', 'missing status fails closed');
});

// ── 12. cancellation and bounded polling ─────────────────────────────────────

test('12. an aborted signal resolves as timeout/cancelled', async () => {
  const { transport } = mockTransport({ getStatus: async () => ({ status: 'pending' as const }) });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const ac = new AbortController();
  ac.abort();
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 5_000, intervalMs: 10, signal: ac.signal });
  eq(f.status, 'timeout', 'timeout');
  eq(f.reason, 'cancelled', 'cancelled reason');
});

test('12b. the abort signal can stop a wait mid-flight', async () => {
  const { transport, state } = mockTransport({ getStatus: async () => ({ status: 'pending' as const }) });
  const sub = new ConcordiumTransactionSubmitter(transport);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 5_000, intervalMs: 20, signal: ac.signal });
  eq(f.status, 'timeout', 'timeout');
  eq(f.reason, 'cancelled', 'cancelled reason');
  ok(state.getStatusCalls < 100, `polling stopped (calls=${state.getStatusCalls})`);
});

test('12c. bounded polling: pending then finalized resolves on the second poll', async () => {
  let calls = 0;
  const sub = new ConcordiumTransactionSubmitter({
    submit: async () => HASH,
    getStatus: async () => {
      calls++;
      return calls < 2 ? { status: 'pending' as const } : { status: 'finalized' as const, blockHash: BLOCK };
    },
  });
  const f = await sub.awaitFinalization(HASH, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'finalized', 'finalized after pending');
  eq(calls, 2, 'polled twice');
});

// ── 13. no false success ─────────────────────────────────────────────────────

test('13. no failure path reports finalized', async () => {
  const failures: Array<[string, ConcordiumTransactionTransport]> = [
    ['timeout', { submit: async () => HASH, getStatus: async () => ({ status: 'pending' }) }],
    ['rejection', { submit: async () => HASH, getStatus: async () => ({ status: 'rejected', reason: 'X' }) }],
    ['transport error', { submit: async () => HASH, getStatus: async () => { throw new Error('down'); } }],
    ['unknown status', { submit: async () => HASH, getStatus: async () => ({ status: 'committed' as never }) }],
  ];
  for (const [label, transport] of failures) {
    const sub = new ConcordiumTransactionSubmitter(transport);
    const f = await sub.awaitFinalization(HASH, { timeoutMs: 60, intervalMs: 10 });
    ok(f.status !== 'finalized', `${label} never reports finalized`);
    eq(f.blockHash, undefined, `${label} has no block hash`);
  }
});

// ── safety invariants ───────────────────────────────────────────────────────

test('S01. the adapter holds no key material or signing logic', () => {
  const { transport } = mockTransport();
  const sub = new ConcordiumTransactionSubmitter(transport);
  const keys = Object.keys(sub);
  for (const forbidden of ['privateKey', 'mnemonic', 'sign', 'key', 'seed']) {
    ok(!keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase())), `no ${forbidden} on the adapter`);
  }
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(sub));
  for (const forbidden of ['sign', 'signTransaction', 'addSponsorSignature']) {
    ok(!proto.includes(forbidden), `no ${forbidden} method`);
  }
});

test('S02. DENY_ALL_FACILITATOR remains intact', async () => {
  const { DENY_ALL_FACILITATOR } = await import('../src/payments/x402.js');
  ok(DENY_ALL_FACILITATOR !== undefined, 'exported');
  const verifyThrew = await DENY_ALL_FACILITATOR.verify({} as never, {} as never).then(() => false, () => true);
  const settleThrew = await DENY_ALL_FACILITATOR.settle({} as never, {} as never).then(() => false, () => true);
  ok(verifyThrew, 'verify refuses');
  ok(settleThrew, 'settle refuses');
});

test('S03. settlement stays disabled by default (guardSettlement)', async () => {
  const { guardSettlement } = await import('../src/payments/operatorSigning.js');
  const g = guardSettlement({
    allowSettlement: false,
    payload: {},
    requirements: {} as never,
    expectedSponsor: '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5',
    authorization: undefined,
  });
  eq(g.ok, false, 'refused');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
});

test('S04. constructing the adapter without a transport fails closed', () => {
  let msg = '';
  try {
    new ConcordiumTransactionSubmitter(undefined as unknown as ConcordiumTransactionTransport);
  } catch (e) { msg = (e as Error).message; }
  ok(/requires a transport/.test(msg), `refused: "${msg}"`);
});

// ═══ runner ═════════════════════════════════════════════════════════════════

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
  console.log(`\ntask49: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
