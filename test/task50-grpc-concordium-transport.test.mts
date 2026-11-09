/**
 * TASK 50 — gRPC Concordium transport tests (fake GRPCClient only).
 *
 * The injected client mirrors the installed SDK's `GRPCClient` surface:
 *   sendAccountTransaction(tx, sig) / getBlockItemStatus(hash)
 * No live RPC, no network, no keys, no broadcast.
 *
 * Run: npx tsx test/task50-grpc-concordium-transport.test.mts
 */

import { eq, ok } from './helpers.mjs';
import {
  GrpcConcordiumTransport,
  type ConcordiumGrpcClientLike,
} from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { TransactionHash } from '@concordium/web-sdk';

const HASH = 'ab'.repeat(32);
const BLOCK = 'ef'.repeat(32);
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';

const validTx = () => ({
  version: 1,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: Math.floor(Date.now() / 1000) + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: SENDER, amount: '1' },
  signatures: {
    sender: { 0: { 0: 'aa'.repeat(64) } },
    sponsor: { 0: { 0: 'bb'.repeat(64) } },
  },
});

const validV0Tx = () => ({
  version: 0,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: Math.floor(Date.now() / 1000) + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
  },
  payload: { type: 'transfer', toAddress: SENDER, amount: '1' },
  signature: { 0: { 0: 'aa'.repeat(64) } },
});

const successSummary = () => ({ type: 'accountTransaction', transactionType: 'transfer' });
const failedSummary = (tag: string) => ({
  type: 'accountTransaction',
  transactionType: 'failed',
  rejectReason: { tag },
});

const finalized = (summary: unknown, blockHash: unknown = BLOCK) => ({
  status: 'finalized',
  outcome: { summary, blockHash },
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. successful submission returns the SDK hash', async () => {
  const seen: { tx?: unknown; sig?: unknown } = {};
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async (tx, sig) => {
      seen.tx = tx;
      seen.sig = sig;
      return HASH;
    },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  const h = await t.submit(validTx());
  eq(h, HASH, 'hash');
  ok(seen.tx !== undefined, 'sendAccountTransaction received a transaction');
  ok(typeof seen.sig === 'object' && seen.sig !== null, 'and a signature map');
});

test('01b. a TransactionHash instance return value is normalized to hex', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => TransactionHash.fromHexString(HASH),
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  eq(await t.submit(validTx()), HASH, 'hex');
});

test('01c. a V0 signed transaction uses its single signature map', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async (_tx, sig) => {
      eq(JSON.stringify(sig), JSON.stringify({ 0: { 0: 'aa'.repeat(64) } }), 'V0 signature');
      return HASH;
    },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  eq(await t.submit(validV0Tx()), HASH, 'hash');
});

test('02. the submitted hash propagates into getStatus', async () => {
  let looked = '';
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async (h) => {
      looked = String(h);
      return finalized(successSummary()) as never;
    },
  };
  const t = new GrpcConcordiumTransport(client);
  const h = await t.submit(validTx());
  eq(h, HASH, 'submit hash');
  const st = await t.getStatus(h);
  eq(st.status, 'finalized', 'finalized');
  eq(looked, HASH, 'the same hash was looked up');
});

test('03. pending status maps to pending', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  const st = await t.getStatus(HASH);
  eq(st.status, 'pending', 'pending');
  eq(st.blockHash, undefined, 'no block hash on pending');
});

test('04. committed status maps to pending (committed is not final)', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
  };
  const t = new GrpcConcordiumTransport(client);
  const st = await t.getStatus(HASH);
  eq(st.status, 'pending', 'committed is pending');
  eq(st.blockHash, undefined, 'no block hash for a committed outcome');
});

test('05. finalized success maps to finalized with the block hash', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(successSummary()) as never,
  };
  const t = new GrpcConcordiumTransport(client);
  const st = await t.getStatus(HASH);
  eq(st.status, 'finalized', 'finalized');
  eq(st.blockHash, BLOCK, 'block hash');
  eq(st.reason, undefined, 'no reason on success');
});

test('06. finalized rejection preserves the reject reason', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(failedSummary('NonExistentAccount')) as never,
  };
  const t = new GrpcConcordiumTransport(client);
  const st = await t.getStatus(HASH);
  eq(st.status, 'rejected', 'rejected');
  eq(st.reason, 'NonExistentAccount', 'reason tag preserved verbatim');
});

test('06b. a rejection without a reason still fails closed as rejected', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () =>
      finalized({ type: 'accountTransaction', transactionType: 'failed', rejectReason: null }) as never,
  };
  const t = new GrpcConcordiumTransport(client);
  const st = await t.getStatus(HASH);
  eq(st.status, 'rejected', 'rejected');
  ok(/no reason supplied/.test(st.reason ?? ''), `reason: "${st.reason}"`);
});

test('07. unknown status throws (fail closed)', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'frobnicated' }) as never,
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.getStatus(HASH); } catch (e) { msg = (e as Error).message; }
  ok(/unrecognized BlockItemStatus/.test(msg), `rejected: "${msg}"`);
});

test('08. malformed status responses throw', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['null', null, /malformed BlockItemStatus/],
    ['missing status', {}, /malformed BlockItemStatus/],
    ['non-string status', { status: 42 }, /malformed BlockItemStatus/],
    ['finalized without outcome', { status: 'finalized' }, /missing outcome/],
    ['finalized without summary', { status: 'finalized', outcome: {} }, /missing summary/],
  ];
  for (const [label, value, re] of cases) {
    const client: ConcordiumGrpcClientLike = {
      sendAccountTransaction: async () => HASH,
      getBlockItemStatus: async () => value as never,
    };
    const t = new GrpcConcordiumTransport(client);
    let msg = '';
    try { await t.getStatus(HASH); } catch (e) { msg = (e as Error).message; }
    ok(re.test(msg), `${label}: "${msg}"`);
  }
});

test('08b. a malformed transaction hash is never sent to the client', async () => {
  let called = false;
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => { called = true; return { status: 'received' }; },
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.getStatus('not-a-hash'); } catch (e) { msg = (e as Error).message; }
  ok(/invalid transaction hash/.test(msg), `rejected: "${msg}"`);
  ok(!called, 'client never called');
});

test('09. submission gRPC error propagates as rejection', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => { throw new Error('FAILED_PRECONDITION: insufficient balance'); },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/submission rejected: FAILED_PRECONDITION: insufficient balance/.test(msg), `preserved: "${msg}"`);
});

test('09b. a malformed signed transaction never reaches the client', async () => {
  let called = false;
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => { called = true; return HASH; },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.submit({ version: 1 }); } catch (e) { msg = (e as Error).message; }
  ok(/malformed signed transaction/.test(msg), `rejected: "${msg}"`);
  ok(!called, 'client never called');
});

test('09c. an invalid hash returned by the node is rejected', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => 'deadbeef',
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/invalid transaction hash/.test(msg), `rejected: "${msg}"`);
});

test('10. status lookup gRPC error propagates', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => { throw new Error('UNAVAILABLE: connection reset'); },
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.getStatus(HASH); } catch (e) { msg = (e as Error).message; }
  ok(/status lookup failed: UNAVAILABLE: connection reset/.test(msg), `preserved: "${msg}"`);
});

test('11. constructor refuses a client missing sendAccountTransaction', () => {
  let msg = '';
  try {
    new GrpcConcordiumTransport({ getBlockItemStatus: async () => ({ status: 'received' }) } as never);
  } catch (e) { msg = (e as Error).message; }
  ok(/requires a client/.test(msg), `refused: "${msg}"`);
});

test('11b. constructor refuses a client missing getBlockItemStatus', () => {
  let msg = '';
  try {
    new GrpcConcordiumTransport({ sendAccountTransaction: async () => HASH } as never);
  } catch (e) { msg = (e as Error).message; }
  ok(/requires a client/.test(msg), `refused: "${msg}"`);
});

test('11c. constructor refuses a null client', () => {
  let msg = '';
  try { new GrpcConcordiumTransport(null as never); } catch (e) { msg = (e as Error).message; }
  ok(/requires a client/.test(msg), `refused: "${msg}"`);
});

test('12. TASK49 submitter works end-to-end with the gRPC transport', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(successSummary()) as never,
  };
  const transport = new GrpcConcordiumTransport(client);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const s = await submitter.submit(validTx());
  eq(s.hash, HASH, 'submit hash');
  eq(s.status, 'accepted', 'accepted');
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'finalized', 'finalized');
  eq(f.blockHash, BLOCK, 'block hash');
});

test('12b. TASK49 submitter surfaces a transport rejection reason', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(failedSummary('OutOfEnergy')) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'rejected', 'rejected');
  eq(f.reason, 'OutOfEnergy', 'reason through the adapter');
});

test('12c. TASK49 submitter times out while the transport stays committed', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 60, intervalMs: 10 });
  eq(f.status, 'timeout', 'committed never becomes finalized');
});

test('13. pending and committed never report finalized', async () => {
  for (const st of ['received', 'committed']) {
    const client: ConcordiumGrpcClientLike = {
      sendAccountTransaction: async () => HASH,
      getBlockItemStatus: async () =>
        (st === 'committed' ? { status: st, outcomes: [] } : { status: st }) as never,
    };
    const t = new GrpcConcordiumTransport(client);
    const r = await t.getStatus(HASH);
    ok(r.status !== 'finalized', `${st} is not finalized`);
    ok(r.status !== 'rejected', `${st} is not rejected`);
    eq(r.status, 'pending', `${st} maps to pending`);
  }
});

test('S01. the transport holds no key material or signing logic', () => {
  const client: ConcordiumGrpcClientLike = {
    sendAccountTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  for (const forbidden of ['privateKey', 'mnemonic', 'sign', 'key', 'seed']) {
    ok(
      !Object.keys(t).some((k) => k.toLowerCase().includes(forbidden)),
      `no ${forbidden} property on the transport`,
    );
  }
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(t));
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
    expectedSponsor: SPONSOR,
    authorization: undefined,
  });
  eq(g.ok, false, 'refused');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
});

test('S04. the transport is independently constructible and does not self-construct a client', () => {
  let msg = '';
  try { new (GrpcConcordiumTransport as never as new () => unknown)(); } catch (e) { msg = (e as Error).message; }
  ok(/requires a client/.test(msg), `no default client: "${msg}"`);
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
  console.log(`\ntask50: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
