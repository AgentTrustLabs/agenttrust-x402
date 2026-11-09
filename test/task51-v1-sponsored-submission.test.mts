/**
 * TASK 51 — V1 sponsored submission path and signer-boundary integration (mock only).
 *
 * Run: npx tsx test/task51-v1-sponsored-submission.test.mts
 */

import { eq, ok } from './helpers.mjs';
import {
  GrpcConcordiumTransport,
  type ConcordiumGrpcClientLike,
} from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
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

const finalized = (summary: unknown, blockHash: unknown = BLOCK) => ({
  status: 'finalized',
  outcome: { summary, blockHash },
});
const successSummary = () => ({ type: 'accountTransaction', transactionType: 'transfer' });
const failedSummary = (tag: string) => ({
  type: 'accountTransaction',
  transactionType: 'failed',
  rejectReason: { tag },
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── V1 transport: finalize + sendTransaction ────────────────────────────────

test('V1-01. V1 submission uses sendTransaction, not sendAccountTransaction', async () => {
  const seen: { tx?: unknown; accountCalled?: boolean } = {};
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async (tx) => {
      seen.tx = tx;
      return HASH;
    },
    sendAccountTransaction: async () => {
      seen.accountCalled = true;
      return HASH;
    },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  const h = await t.submit(validTx());
  eq(h, HASH, 'hash');
  ok(seen.tx !== undefined, 'sendTransaction received a finalized transaction');
  ok((seen.tx as { version?: number })?.version === 1, 'finalized transaction is V1');
  ok(seen.accountCalled !== true, 'the V0-only path was not used');
});

test('V1-02. a TransactionHash instance return value is normalized to hex', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => TransactionHash.fromHexString(HASH),
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  eq(await t.submit(validTx()), HASH, 'hex');
});

test('V1-03. pending / committed / finalized / rejected / unknown / malformed', async () => {
  const cases: Array<[string, unknown, string | RegExp]> = [
    ['received', { status: 'received' }, 'pending'],
    ['committed', { status: 'committed', outcomes: [] }, 'pending'],
    ['finalized', finalized(successSummary()), 'finalized'],
    ['rejected', finalized(failedSummary('OutOfEnergy')), 'rejected'],
    ['unknown', { status: 'frobnicated' }, /unrecognized BlockItemStatus/],
    ['malformed', null, /malformed BlockItemStatus/],
  ];
  for (const [label, value, expected] of cases) {
    const client: ConcordiumGrpcClientLike = {
      sendTransaction: async () => HASH,
      getBlockItemStatus: async () => value as never,
    };
    const t = new GrpcConcordiumTransport(client);
    if (typeof expected === 'string') {
      const r = await t.getStatus(HASH);
      eq(r.status, expected, `${label} -> ${expected}`);
      if (expected === 'rejected') eq(r.reason, 'OutOfEnergy', 'reason');
      if (expected === 'finalized') eq(r.blockHash, BLOCK, 'block hash');
    } else {
      let msg = '';
      try { await t.getStatus(HASH); } catch (e) { msg = (e as Error).message; }
      ok(expected.test(msg), `${label}: "${msg}"`);
    }
  }
});

test('V1-04. submission gRPC error propagates as rejection', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => { throw new Error('FAILED_PRECONDITION: insufficient balance'); },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/submission rejected: FAILED_PRECONDITION: insufficient balance/.test(msg), `preserved: "${msg}"`);
});

test('V1-05. malformed signed transaction never reaches the client', async () => {
  let called = false;
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => { called = true; return HASH; },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  let msg = '';
  try { await t.submit({ version: 1 }); } catch (e) { msg = (e as Error).message; }
  ok(/malformed signed transaction/.test(msg), `rejected: "${msg}"`);
  ok(!called, 'client never called');
});

test('V1-06. constructor refuses a client without any submission method', () => {
  let msg = '';
  try {
    new GrpcConcordiumTransport({ getBlockItemStatus: async () => ({ status: 'received' }) } as never);
  } catch (e) { msg = (e as Error).message; }
  ok(/requires a client/.test(msg), `refused: "${msg}"`);
});

test('V1-07. TASK49 adapter works end-to-end with the V1 transport', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(successSummary()) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  eq(s.hash, HASH, 'submit hash');
  eq(s.status, 'accepted', 'accepted');
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'finalized', 'finalized');
  eq(f.blockHash, BLOCK, 'block hash');
});

test('V1-08. TASK49 adapter surfaces a finalized rejection', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(failedSummary('NonExistentAccount')) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'rejected', 'rejected');
  eq(f.reason, 'NonExistentAccount', 'reason');
});

test('V1-09. TASK49 adapter times out on a committed (never finalized) transaction', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 60, intervalMs: 10 });
  eq(f.status, 'timeout', 'timeout');
});

test('V1-10. duplicate submissions are not deduplicated by the adapter', async () => {
  const calls: number[] = [];
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => {
      calls.push(1);
      return HASH;
    },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  await submitter.submit(validTx());
  await submitter.submit(validTx());
  eq(calls.length, 2, 'two transport submissions');
});

// ── IpcSponsorSigner integration ────────────────────────────────────────────

test('IPC-01. without a submitter, submission stays fail-closed', async () => {
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
  });
  let msg = '';
  try { await signer.submitTransaction(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/not available/i.test(msg), `refused: "${msg}"`);
});

test('IPC-02. with a submitter, submission delegates and returns the hash', async () => {
  const transport = new GrpcConcordiumTransport({
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'received' }),
  } as never);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
    submitter,
  });
  eq(await signer.submitTransaction(validTx()), HASH, 'delegated hash');
});

test('IPC-03. waitForFinalization delegates and maps finalized to finalized', async () => {
  const transport = new GrpcConcordiumTransport({
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(successSummary()) as never,
  } as never);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
    submitter,
  });
  const r = await signer.waitForFinalization(HASH, 1_000);
  eq(r.status, 'finalized', 'finalized');
  eq(r.txHash, HASH, 'hash');
});

test('IPC-04. waitForFinalization maps a finalized rejection to failed', async () => {
  const transport = new GrpcConcordiumTransport({
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(failedSummary('NonExistentAccount')) as never,
  } as never);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
    submitter,
  });
  const r = await signer.waitForFinalization(HASH, 1_000);
  eq(r.status, 'failed', 'failed');
});

test('IPC-05. waitForFinalization maps a timeout to pending', async () => {
  const transport = new GrpcConcordiumTransport({
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
  } as never);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
    submitter,
  });
  const r = await signer.waitForFinalization(HASH, 60);
  eq(r.status, 'pending', 'pending');
});

test('IPC-06. waitForFinalization throws on a transport error', async () => {
  const transport = new GrpcConcordiumTransport({
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => { throw new Error('UNAVAILABLE'); },
  } as never);
  const submitter = new ConcordiumTransactionSubmitter(transport);
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    socketPath: '/tmp/task51.sock',
    expectedUid: 1000,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 1000n,
    submitter,
  });
  let msg = '';
  try { await signer.waitForFinalization(HASH, 1_000); } catch (e) { msg = (e as Error).message; }
  ok(/transport error/i.test(msg), `threw: "${msg}"`);
});

// ── crash-window semantics at the adapter/transport boundary ─────────────────

test('CW-01. submission rejected before a hash is returned is never success', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => { throw new Error('FAILED_PRECONDITION'); },
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  let msg = '';
  try { await submitter.submit(validTx()); } catch (e) { msg = (e as Error).message; }
  ok(/submission rejected/.test(msg), `rejected: "${msg}"`);
});

test('CW-02. after a returned hash, a transport error during finalization is not success', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => { throw new Error('UNAVAILABLE'); },
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'transport_error', 'transport_error');
  eq(f.status === 'finalized', false, 'never finalized');
});

test('CW-03. finalization timeout is not success', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 60, intervalMs: 10 });
  eq(f.status, 'timeout', 'timeout');
});

test('CW-04. finalized rejection is not success', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(failedSummary('RuntimeFailure')) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'rejected', 'rejected');
  eq(f.reason, 'RuntimeFailure', 'reason');
});

test('CW-05. finalized success is the only success path', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => finalized(successSummary()) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const s = await submitter.submit(validTx());
  const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
  eq(f.status, 'finalized', 'finalized');
  eq(f.blockHash, BLOCK, 'block hash');
});

test('CW-06. malformed and unknown statuses fail closed', async () => {
  for (const value of [null, {}, { status: 42 }, { status: 'finalized', outcome: {} }, { status: 'frobnicated' }]) {
    const client: ConcordiumGrpcClientLike = {
      sendTransaction: async () => HASH,
      getBlockItemStatus: async () => value as never,
    };
    const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
    const s = await submitter.submit(validTx());
    let threw = false;
    let status: string | undefined;
    try {
      const f = await submitter.awaitFinalization(s.hash, { timeoutMs: 1_000, intervalMs: 10 });
      status = f.status;
    } catch (e) {
      threw = true;
    }
    ok(threw || status === 'transport_error', `fail closed for ${JSON.stringify(value)}`);
  }
});

test('S01. transport holds no key material or signing logic', () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'received' }),
  };
  const t = new GrpcConcordiumTransport(client);
  for (const forbidden of ['privateKey', 'mnemonic', 'sign', 'key', 'seed']) {
    ok(!Object.keys(t).some((k) => k.toLowerCase().includes(forbidden)), `no ${forbidden}`);
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

test('S03. settlement stays disabled by default', async () => {
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


// ── real-process crash windows (reuses the TASK29 harness pattern) ────────────

const CHILD = new URL('../scripts/task51-crash-child.mts', import.meta.url).pathname;
const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { spawn } = await import('node:child_process');

async function runChild(mode: string, ledger: string, hashFile: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, mode, ledger, hashFile], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function readLedger(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return { bad: true }; }
  });
}

test('CW-07. real process: die immediately after submission -> one attempt, hash durable, recovery does not resubmit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t51-crash-'));
  const ledger = join(dir, 'ledger.log');
  const hashFile = join(dir, 'hash.json');
  try {
    const died = await runChild('die-after-submit', ledger, hashFile);
    ok(died.signal === 'SIGKILL', `child SIGKILLed (${died.signal})`);
    const events = readLedger(ledger);
    eq(events.filter((e) => e['event'] === 'submit_attempt').length, 1, 'exactly one submission');
    eq(events.some((e) => e['event'] === 'hash_returned'), true, 'node returned a hash');
    ok(existsSync(hashFile), 'hash was durable before death');
    const recovered = await runChild('recover', ledger, hashFile);
    eq(recovered.code, 0, 'recovery completed');
    const after = readLedger(ledger);
    eq(after.filter((e) => e['event'] === 'submit_attempt').length, 1, 'no resubmission after crash');
    eq(after.some((e) => e['event'] === 'recover_lookup'), true, 'recovery looked up the persisted hash');
    eq(after.some((e) => e['event'] === 'status_lookup'), true, 'recovery polled finalization');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CW-08. real process: die while finalization is unobserved -> hash durable, no success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t51-window-'));
  const ledger = join(dir, 'ledger.log');
  const hashFile = join(dir, 'hash.json');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, 'die-during-finalization', ledger, hashFile], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // Poll for the child's progress instead of guessing a startup delay (tsx boot is slow).
    for (let i = 0; i < 100; i++) {
      const seen = readLedger(ledger).some((e) => e['event'] === 'status_lookup');
      if (seen) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const events = readLedger(ledger);
    eq(events.filter((e) => e['event'] === 'submit_attempt').length, 1, 'one submission');
    eq(events.some((e) => e['event'] === 'status_lookup'), true, 'finalization was polled');
    ok(existsSync(hashFile), 'hash durable');
    const wasRunning = child.exitCode === null;
    child.kill('SIGKILL');
    const code = await exited;
    ok(wasRunning, `child was still running when killed (exitCode=${child.exitCode})`);
    ok(code === null || code === 0, `child terminated by signal (code=${String(code)})`);
    const after = readLedger(ledger);
    eq(after.some((e) => e['event'] === 'finalization_observed'), false, 'finalization never observed');
    eq(after.filter((e) => e['event'] === 'submit_attempt').length, 1, 'no duplicate submission');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  console.log(`\ntask51: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
