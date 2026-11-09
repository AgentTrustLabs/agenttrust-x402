/**
 * TASK 70 — x402 HTTP provider regression tests (mocks only, no node).
 *
 * Uses the real x402 protocol layer (buildPaymentRequirements, buildPaymentRequired,
 * preflightPaymentPayload) against a fake facilitator and a fake chain verifier.
 * Every negative case is exercised. No network, no signing, no transactions.
 */

import { eq, ok } from './helpers.mjs';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RESOURCE_URL = 'http://127.0.0.1/protected';
const HASH = 'ab'.repeat(32);

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const requirements = () => buildPaymentRequirements({
  payTo: RECIPIENT,
  amountMicroCcd: '1',
  maxTimeoutSeconds: 300,
  resourceUrl: RESOURCE_URL,
  feePayer: SPONSOR,
  network: CAIP2,
});

const payload = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: RESOURCE_URL },
  requestId: 'req-1',
  accepted: requirements(),
  payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
  ...over,
});

const chainFinalized = (over: Partial<ChainTransferSummary> = {}): ChainTransferSummary => ({
  status: 'finalized',
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  amount: '1',
  network: CAIP2,
  blockHash: 'cd'.repeat(32),
  failed: false,
  ...over,
});

const makeProvider = (opts: {
  facilitator?: any;
  chain?: any;
  replay?: ReplayStore;
  now?: () => number;
}) => {
  const facilitator = opts.facilitator ?? {
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: HASH, network: CAIP2 }),
  };
  const chain = opts.chain ?? { readTransfer: async () => chainFinalized() };
  return createX402Provider(
    { requirements: requirements(), resourceUrl: RESOURCE_URL, description: 'Protected', resource: { secret: 'data' }, now: opts.now },
    { facilitator, chain },
    {
      preflight,
      buildRequired: buildPaymentRequired,
      replayStore: opts.replay,
      expectSender: SENDER,
      expectSponsor: SPONSOR,
    },
  );
};

function preflight(p: unknown, r: unknown, now: number) {
  return preflightPaymentPayload(p, r as any, now);
}

test('01. unpaid request returns 402 with a challenge', () => {
  const p = makeProvider({});
  const out = p.handleUnpaid();
  eq(out.status, 402, 'status');
  eq((out.body as any).x402Version, 2, 'x402Version');
  ok(Array.isArray((out.body as any).accepts), 'accepts present');
});

test('02. valid finalized payment returns 200 and the resource', async () => {
  const p = makeProvider({});
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 200, 'status');
  eq(out.reason, 'paid', 'reason');
  eq((out.body as any).resource.secret, 'data', 'resource body');
  eq((out.body as any).payment.transaction, HASH, 'transaction hash');
});

test('03. missing header is rejected', async () => {
  const p = makeProvider({});
  const out = await p.handlePayment(undefined);
  eq(out.status, 400, 'status');
  eq(out.reason, 'malformed', 'reason');
});

test('04. malformed JSON is rejected', async () => {
  const p = makeProvider({});
  const out = await p.handlePayment('{not json');
  eq(out.status, 400, 'status');
  eq(out.reason, 'malformed', 'reason');
});

test('05. wrong network is rejected at preflight', async () => {
  const p = makeProvider({});
  const bad = payload();
  (bad as any).accepted.network = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
  const out = await p.handlePayment(JSON.stringify(bad));
  eq(out.status, 402, 'status');
  ok(/network mismatch/.test((out.body as any).reason), 'network reason');
});

test('06. wrong recipient is rejected', async () => {
  const p = makeProvider({});
  const bad = payload();
  (bad as any).accepted.payTo = SENDER;
  const out = await p.handlePayment(JSON.stringify(bad));
  eq(out.status, 402, 'status');
  ok(/payTo mismatch/.test((out.body as any).reason), 'payTo reason');
});

test('07. wrong amount is rejected', async () => {
  const p = makeProvider({});
  const bad = payload();
  (bad as any).accepted.amount = '2';
  const out = await p.handlePayment(JSON.stringify(bad));
  eq(out.status, 402, 'status');
  ok(/amount mismatch/.test((out.body as any).reason), 'amount reason');
});

test('08. wrong sender is rejected by the chain check', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => chainFinalized({ sender: SPONSOR }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'chain_mismatch', 'reason');
});

test('09. wrong sponsor is rejected by the chain check', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => chainFinalized({ sponsor: SENDER }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'chain_mismatch', 'reason');
});

test('10. pending transaction never unlocks', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => ({ status: 'pending' }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'not_finalized', 'reason');
});

test('11. failed/rejected transaction never unlocks', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => chainFinalized({ failed: true }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'chain_mismatch', 'reason');
});

test('12. chain mismatch (recipient/amount) is rejected', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => chainFinalized({ recipient: SENDER }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'chain_mismatch', 'reason');
});

test('13. verification unavailable stays locked', async () => {
  const p = makeProvider({ chain: { readTransfer: async () => ({ status: 'unavailable' }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 503, 'status');
  eq(out.reason, 'verification_unavailable', 'reason');
});

test('14. invalid facilitator verify is rejected', async () => {
  const p = makeProvider({ facilitator: { verify: async () => ({ isValid: false, invalidReason: 'invalid_signature' }), settle: async () => ({ success: true, transaction: HASH }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'verify', 'reason');
});

test('15. settle failure never unlocks', async () => {
  const p = makeProvider({ facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: 'insufficient_funds' }) } });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'settle', 'reason');
});

test('16. request binding mismatch is rejected', async () => {
  const p = makeProvider({});
  const bad = payload();
  (bad as any).resource.url = 'http://127.0.0.1/other';
  const out = await p.handlePayment(JSON.stringify(bad));
  eq(out.status, 400, 'status');
  eq(out.reason, 'binding', 'reason');
});

test('17. expired requirement is rejected', async () => {
  const p = makeProvider({ now: () => 2_000_000_000_000 });
  const out = await p.handlePayment(JSON.stringify(payload()));
  eq(out.status, 402, 'status');
  eq(out.reason, 'expired', 'reason');
});

test('18. replay by transaction hash is rejected', async () => {
  const p = makeProvider({});
  const first = await p.handlePayment(JSON.stringify(payload({ requestId: 'req-a' })));
  eq(first.status, 200, 'first payment');
  const second = await p.handlePayment(JSON.stringify(payload({ requestId: 'req-b' })));
  eq(second.status, 409, 'replay status');
  eq(second.reason, 'replay', 'replay reason');
});

test('19. replay by request id is rejected', async () => {
  const p = makeProvider({});
  const first = await p.handlePayment(JSON.stringify(payload({ requestId: 'same' })));
  eq(first.status, 200, 'first');
  const second = await p.handlePayment(JSON.stringify(payload({ requestId: 'same' })));
  eq(second.status, 409, 'replay status');
});

test('20. concurrent duplicate redemption is rejected exactly once', async () => {
  const p = makeProvider({});
  const [a, b] = await Promise.all([
    p.handlePayment(JSON.stringify(payload({ requestId: 'dup' }))),
    p.handlePayment(JSON.stringify(payload({ requestId: 'dup' }))),
  ]);
  const statuses = [a.status, b.status].sort();
  eq(statuses.join(','), '200,409', 'exactly one winner');
});

test('21. two different request ids sharing one hash are rejected', async () => {
  const p = makeProvider({});
  const a = await p.handlePayment(JSON.stringify(payload({ requestId: 'r1' })));
  eq(a.status, 200, 'first');
  const b = await p.handlePayment(JSON.stringify(payload({ requestId: 'r2' })));
  eq(b.status, 409, 'second must be replay');
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${(e as Error).message}`);
  }
}
console.log(`\ntask70: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
