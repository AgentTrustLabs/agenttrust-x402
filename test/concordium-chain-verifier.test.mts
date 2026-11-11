/**
 * Focused tests for the real Concordium Testnet chain verifier.
 *
 * These tests use an injected fake node client: no live node is contacted by the
 * automated suite. The live read-only validation is performed separately by
 * `scripts/verify-testnet-chain.mts` (see docs/testnet-demo.md).
 */
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { ConcordiumChainVerifier } from '../src/x402/concordiumChainVerifier.js';
import type { ChainTransferSummary } from '../src/x402/provider.js';

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const HASH = 'c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a';
const BLOCK = 'f7dcec686e29bfd6acca13f7b8f3d2e88d054058776c4a4df5db68d6b4320bd7';

type FakeStatus = Record<string, unknown>;

function fakeClient(
  status: FakeStatus,
  consensus: FakeStatus = { genesisBlock: GENESIS },
): { getBlockItemStatus: () => Promise<unknown>; getConsensusStatus: () => Promise<unknown> } {
  return {
    getBlockItemStatus: async () => status,
    getConsensusStatus: async () => consensus,
  };
}

function newVerifier(status: FakeStatus, consensus?: FakeStatus): ConcordiumChainVerifier {
  return new ConcordiumChainVerifier({
    host: 'fake.test',
    port: 1,
    network: TESTNET,
    client: fakeClient(status, consensus) as never,
  });
}

/** A finalized, successful simple transfer of 1 microCCD. */
function finalizedTransfer(): FakeStatus {
  return {
    status: 'finalized',
    outcome: {
      blockHash: BLOCK,
      summary: {
        hash: HASH,
        type: 'accountTransaction',
        transactionType: 'transfer',
        sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
        sponsor: { sponsor: '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK', cost: '1' },
        transfer: { tag: 'Transferred', amount: { microCcdAmount: 1n }, to: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB' },
      },
    },
  };
}

test('T80.1 a real finalized transfer is recognized with full details', async () => {
  const v = newVerifier(finalizedTransfer());
  const s = await v.readTransfer(HASH);
  deepStrictEqual(s, {
    status: 'finalized',
    failed: false,
    sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    sponsor: '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK',
    recipient: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
    amount: '1',
    network: TESTNET,
    blockHash: BLOCK,
  } satisfies ChainTransferSummary);
});

test('T80.2 committed is pending, never finalized', async () => {
  const v = newVerifier({ status: 'committed', outcomes: [{ blockHash: BLOCK, summary: { hash: HASH } }] });
  const s = await v.readTransfer(HASH);
  deepStrictEqual(s, { status: 'pending' });
});

test('T80.3 received is pending', async () => {
  const v = newVerifier({ status: 'received' });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'pending' });
});

test('T80.4 failed transaction is finalized+failed (never released)', async () => {
  const v = newVerifier({
    status: 'finalized',
    outcome: { blockHash: BLOCK, summary: { hash: HASH, transactionType: 'failed' } },
  });
  const s = await v.readTransfer(HASH);
  strictEqual(s.status, 'finalized');
  strictEqual(s.failed, true);
});

test('T80.5 hash mismatch is unavailable (fail closed)', async () => {
  const v = newVerifier({
    status: 'finalized',
    outcome: { blockHash: BLOCK, summary: { hash: '0'.repeat(64), transactionType: 'transfer' } },
  });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.6 missing outcome/summary is unavailable', async () => {
  deepStrictEqual(await newVerifier({ status: 'finalized' }).readTransfer(HASH), { status: 'unavailable' });
  deepStrictEqual(
    await newVerifier({ status: 'finalized', outcome: { blockHash: BLOCK } }).readTransfer(HASH),
    { status: 'unavailable' },
  );
});

test('T80.7 non-transfer transaction has no recipient/amount (provider rejects on mismatch)', async () => {
  const v = newVerifier({
    status: 'finalized',
    outcome: { blockHash: BLOCK, summary: { hash: HASH, transactionType: 'registerData' } },
  });
  const s = await v.readTransfer(HASH);
  strictEqual(s.status, 'finalized');
  strictEqual(s.recipient, undefined);
  strictEqual(s.amount, undefined);
});

test('T80.8 malformed hash is unavailable', async () => {
  const v = newVerifier(finalizedTransfer());
  deepStrictEqual(await v.readTransfer('not-a-hash'), { status: 'unavailable' });
});

test('T80.9 unknown network is rejected at construction', () => {
  throws(() => new ConcordiumChainVerifier({ host: 'x', port: 1, network: 'ccd:deadbeef' }), /unknown network/);
});

test('T80.10 genesis mismatch fails closed as unavailable', async () => {
  const v = newVerifier(finalizedTransfer(), { genesisBlock: '0'.repeat(64) });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.11 node error is unavailable, never throws', async () => {
  const v = new ConcordiumChainVerifier({
    host: 'x',
    port: 1,
    network: TESTNET,
    client: {
      getBlockItemStatus: async () => { throw new Error('NOT_FOUND: transaction not found'); },
      getConsensusStatus: async () => ({ genesisBlock: GENESIS }),
    } as never,
  });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.12 timeout is unavailable, never throws', async () => {
  const v = new ConcordiumChainVerifier({
    host: 'x',
    port: 1,
    network: TESTNET,
    timeoutMs: 20,
    client: {
      getBlockItemStatus: () => new Promise(() => {}),
      getConsensusStatus: async () => ({ genesisBlock: GENESIS }),
    } as never,
  });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.13 unsupported status is unavailable', async () => {
  const v = newVerifier({ status: 'weird' });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.14 sponsor is optional', async () => {
  const s = finalizedTransfer();
  delete (s.outcome as { summary: Record<string, unknown> }).summary.sponsor;
  const v = newVerifier(s);
  const r = await v.readTransfer(HASH);
  strictEqual(r.sponsor, undefined);
  strictEqual(r.recipient, '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB');
});

test('T80.15 amount is integer microCCD only', async () => {
  const s = finalizedTransfer();
  (s.outcome as { summary: Record<string, unknown> }).summary.transfer = {
    tag: 'Transferred',
    amount: { microCcdAmount: 500n },
    to: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
  };
  const v = newVerifier(s);
  strictEqual((await v.readTransfer(HASH)).amount, '500');
});
test('T80.16 malformed sender address is ignored, never guessed', async () => {
  const s = finalizedTransfer();
  (s.outcome as { summary: Record<string, unknown> }).summary.sender = {
    toString: () => '[object Object]',
  };
  const r = await newVerifier(s).readTransfer(HASH);
  strictEqual(r.status, 'finalized');
  strictEqual(r.sender, undefined);
  strictEqual(r.recipient, '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB');
});

test('T80.17 non-integer amount is omitted, never coerced', async () => {
  const s = finalizedTransfer();
  (s.outcome as { summary: Record<string, unknown> }).summary.transfer = {
    tag: 'Transferred',
    amount: { microCcdAmount: 'not-a-number' },
    to: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
  };
  const r = await newVerifier(s).readTransfer(HASH);
  strictEqual(r.status, 'finalized');
  strictEqual(r.amount, undefined);
  strictEqual(r.recipient, '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB');
});

test('T80.18 empty outcome summary is unavailable, never partial release', async () => {
  const v = newVerifier({
    status: 'finalized',
    outcome: { blockHash: BLOCK, summary: {} },
  });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'unavailable' });
});

test('T80.19 committed outcome is pending even when it carries a full summary', async () => {
  const v = newVerifier({
    status: 'committed',
    outcomes: [{ blockHash: BLOCK, summary: finalizedTransfer().outcome.summary }],
  });
  deepStrictEqual(await v.readTransfer(HASH), { status: 'pending' });
});
