/**
 * browserChainAdapter — real node response shape regression (offline).
 *
 * Mirrors the runtime structure observed from Concordium Testnet
 * (grpc.testnet.concordium.com:20000): summary.sender is an AccountAddress
 * OBJECT, transfer is {tag, amount, to}, sponsor is {cost, sponsor}.
 * No node access: fixtures are offline; hash binding and fail-closed hold.
 */
import { eq, ok } from './helpers.mjs';
import { AccountAddress, CcdAmount } from '@concordium/web-sdk';
import { createBrowserChainVerifier } from '../services/facilitator/src/browserChainAdapter.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const BLOCK = '387ae4ffed5ae328566efb30e379539cf3632714ed55564a60237420a49310a4';

const realSummary = (over: Record<string, unknown> = {}) => ({
  hash: HASH,
  type: 'accountTransaction',
  transactionType: 'transfer',
  energyCost: { value: 635n },
  sender: AccountAddress.fromBase58(SENDER),
  transfer: { tag: 'Transferred', amount: CcdAmount.fromMicroCcd(1n), to: RECIPIENT },
  sponsor: { cost: CcdAmount.fromMicroCcd(4620843n), sponsor: SPONSOR },
  ...over,
});

const mk = (status: string, summary?: unknown) => ({
  status,
  outcome: summary ? { blockHash: Buffer.from(BLOCK, 'hex'), summary } : undefined,
});

async function run(raw: unknown) {
  const v = createBrowserChainVerifier({ getBlockItemStatus: async () => raw as never }, NETWORK);
  return v.readTransfer(HASH);
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. real finalized shape → finalized with sender/recipient/sponsor/amount/blockHash', async () => {
  const r = await run(mk('finalized', realSummary()));
  ok(r, 'not null');
  if (!r) return;
  eq(r.status, 'finalized', 'status');
  eq(r.sender, SENDER, 'sender normalized from AccountAddress');
  eq(r.recipient, RECIPIENT, 'recipient');
  eq(r.sponsor, SPONSOR, 'sponsor');
  eq(r.amount, '1', 'amount');
  eq(r.blockHash, BLOCK, 'blockHash');
  eq(r.failed, false, 'failed');
});

test('02. committed/received → pending; failed → rejected; received without outcome → null', async () => {
  eq((await run(mk('committed', realSummary()))).status, 'pending', 'committed');
  eq((await run(mk('received', realSummary()))).status, 'pending', 'received pending');
  eq(await run(mk('received')), null, 'received no outcome null');
  const f = await run(mk('finalized', realSummary({ transactionType: 'failed' })));
  ok(f, 'not null'); if (f) { eq(f.status, 'rejected', 'rejected'); eq(f.failed, true, 'failed'); }
});

test('03. hash mismatch → null (hash binding preserved)', async () => {
  eq(await run(mk('finalized', realSummary({ hash: 'c1'.repeat(32) }))), null, 'null');
});

test('04. unavailable / malformed / incomplete never finalize', async () => {
  const throwing = createBrowserChainVerifier({ getBlockItemStatus: async () => { throw new Error('rpc down'); } }, NETWORK);
  eq(await throwing.readTransfer(HASH), null, 'throw null');
  eq(await run({ status: 'finalized' }), null, 'missing outcome null');
  eq(await run(mk('finalized', realSummary({ sender: undefined }))), null, 'missing sender null');
  eq(await run(mk('finalized', realSummary({ sponsor: {} }))), null, 'missing sponsor null');
  eq(await run(mk('finalized', realSummary({ transfer: { tag: 'Transferred', to: RECIPIENT } }))), null, 'missing amount null');
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nbrowser-chain-adapter: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
