/**
 * Payment list API (resource-server layer): GET /api/payments.
 *
 * Covers the route the frontend calls: a 200 list passes the
 * facilitator's status/body through unchanged; only a validated `limit`
 * is forwarded (the raw query string is never passed on); an invalid
 * limit is 400 without touching the port; a dead port yields 503; no
 * port means the route does not exist (404); non-GET is 405; CORS
 * applies to the route for listed origins, exactly as for the detail
 * route; and the detail route still works beside the new one.
 *
 * Fully offline. Real HTTP on loopback (node:http + real fetch) with a
 * stub list/detail port; the provider/facilitator are fakes. No signing,
 * no chain, no facilitator process.
 */

import { createServer } from 'node:http';
import { eq, ok, notOk } from './helpers.mjs';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer } from '../src/x402/resourceServer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const KNOWN = 'a1'.repeat(32);
const BLOCK_HASH = 'a3'.repeat(32);
const RESOURCE_PATH = '/protected';
// The SDK's network mapping (@x402/concordium) points Testnet at
// CCDExplorer, not CCDScan. The API must return whatever the SDK maps to —
// the test pins the SDK's actual mapping, it does not invent one.
const EXPECTED_EXPLORER = `https://ccdexplorer.io/testnet/transaction/${KNOWN}`;

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const chainFinalized = (): ChainTransferSummary => ({
  status: 'finalized',
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  amount: '1',
  network: CAIP2,
  blockHash: BLOCK_HASH,
  failed: false,
});

const fakeFacilitator = () => ({
  verify: async () => ({ isValid: true }),
  settle: async () => ({ success: true, transaction: KNOWN, network: CAIP2 }),
});

/** A detail exactly as the facilitator's GET /payment/:id returns it. */
const knownDetail = () => ({
  paymentDigest: KNOWN,
  state: 'finalized',
  finalized: true,
  transactionHash: KNOWN,
  requirements: {
    network: CAIP2,
    payTo: RECIPIENT,
    amount: '1',
    asset: 'CCD',
    resourceUrl: 'http://127.0.0.1:4590/protected',
    raw: `${CAIP2}|${RECIPIENT}|1|CCD|http://127.0.0.1:4590/protected`,
  },
  attempted: 1,
  createdAt: 1,
  updatedAt: 2,
  transitions: [],
  verification: {
    available: true,
    observed: 'finalized',
    source: 'concordium-grpc',
    finalized: true,
    blockHash: BLOCK_HASH,
    blockHeight: '50970567',
    blockSlotTime: '2026-11-18T11:01:24.585Z',
    sender: SENDER,
    sponsor: SPONSOR,
    feeMicroCcd: '4800331',
    energy: '635',
    recipient: RECIPIENT,
    transferAmount: '1',
    error: null,
  },
});

/** A list exactly as the facilitator's GET /payments returns it. */
const knownList = (limit: number | undefined) => ({
  payments: [
    { paymentDigest: 'a1'.repeat(32), state: 'finalized', transactionHash: 'a2'.repeat(32), createdAt: 3000, updatedAt: 3000, attempted: 1 },
    { paymentDigest: 'b1'.repeat(32), state: 'outcome_unknown', transactionHash: 'b2'.repeat(32), createdAt: 3000, updatedAt: 3000, attempted: 1 },
  ],
  count: 2,
  limit: limit ?? 50,
});

type PaymentPort = {
  getPaymentDetail?: (id: string) => Promise<{ status: number; body: unknown }>;
  listPayments?: (limit?: number) => Promise<{ status: number; body: unknown }>;
};

interface ServerCtx {
  url: string;
  close: () => Promise<void>;
}

async function withServer(opts: {
  paymentDetail?: PaymentPort;
  corsOrigins?: string[];
}): Promise<ServerCtx> {
  const port = await freePort();
  const resourceUrl = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
  const requirements = buildPaymentRequirements({
    payTo: RECIPIENT, amountMicroCcd: '1', maxTimeoutSeconds: 300, resourceUrl, feePayer: SPONSOR, network: CAIP2,
  });
  const provider = createX402Provider(
    { requirements, resourceUrl, description: 'Protected', resource: { secret: 'data' } },
    { facilitator: fakeFacilitator() as never, chain: { readTransfer: async () => chainFinalized() } },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore(), expectSender: SENDER, expectSponsor: SPONSOR },
  );
  const started = await startX402ResourceServer({
    provider,
    resourcePath: RESOURCE_PATH,
    host: '127.0.0.1',
    port,
    ...(opts.paymentDetail ? { paymentDetail: opts.paymentDetail } : {}),
    ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
  });
  return { url: started.url, close: started.close };
}

async function runWithServer<T>(
  opts: { paymentDetail?: PaymentPort; corsOrigins?: string[] },
  fn: (ctx: ServerCtx) => Promise<T>,
): Promise<T> {
  const ctx = await withServer(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

const stubPort = (): PaymentPort => ({
  getPaymentDetail: async (id: string) => {
    if (id === KNOWN) return { status: 200, body: knownDetail() };
    return { status: 404, body: { ok: false, code: 'unknown_payment', reason: 'no payment with this digest or transaction hash' } };
  },
  listPayments: async (limit?: number) => ({ status: 200, body: knownList(limit) }),
});

test('01. 200 list passes the facilitator body through unchanged', async () => {
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['count'], 2, 'count passes through');
    eq(body['limit'], 50, 'default limit echoed');
    const payments = body['payments'] as Array<Record<string, unknown>>;
    eq(payments.length, 2, 'two payments');
    eq(payments[0]!['paymentDigest'], 'a1'.repeat(32), 'first digest');
    eq(payments[0]!['state'], 'finalized', 'stored finalized');
    eq(payments[1]!['state'], 'outcome_unknown', 'stored outcome_unknown');
  });
});

test('02. only a validated limit is forwarded; no param means undefined', async () => {
  const seen: Array<number | undefined> = [];
  const port: PaymentPort = {
    listPayments: async (limit?: number) => {
      seen.push(limit);
      return { status: 200, body: knownList(limit) };
    },
  };
  await runWithServer({ paymentDetail: port }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments?limit=2`);
    eq(res.status, 200, 'status');
    eq(((await res.json()) as Record<string, unknown>)['limit'], 2, 'limit echoed');
    const plain = await fetch(`${url}/api/payments`);
    eq(plain.status, 200, 'no-param status');
    eq(seen.length, 2, 'port called twice');
    eq(seen[0], 2, 'explicit limit forwarded');
    eq(seen[1], undefined, 'no param forwards undefined');
  });
});

test('03. an invalid limit is 400 without touching the port', async () => {
  let called = false;
  const port: PaymentPort = {
    listPayments: async () => {
      called = true;
      return { status: 200, body: knownList(undefined) };
    },
  };
  await runWithServer({ paymentDetail: port }, async ({ url }) => {
    for (const bad of ['0', '101', 'abc', '-1']) {
      const res = await fetch(`${url}/api/payments?limit=${bad}`);
      eq(res.status, 400, `limit=${bad} is 400`);
      eq(((await res.json()) as Record<string, unknown>)['error'], 'invalid_request', 'invalid_request code');
    }
    notOk(called, 'port never called for invalid limits');
  });
});

test('04. a facilitator error passes through; a throwing port yields 503', async () => {
  const errorPort: PaymentPort = {
    listPayments: async () => ({ status: 404, body: { error: 'not found' } }),
  };
  await runWithServer({ paymentDetail: errorPort }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments`);
    eq(res.status, 404, 'facilitator 404 passes through');
  });
  const throwingPort: PaymentPort = {
    listPayments: async () => {
      throw new Error('facilitator down');
    },
  };
  await runWithServer({ paymentDetail: throwingPort }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments`);
    eq(res.status, 503, 'status');
    eq(((await res.json()) as Record<string, unknown>)['error'], 'payment_list_unavailable', 'error code');
  });
});

test('05. no port means the route does not exist (404); non-GET is 405', async () => {
  await runWithServer({}, async ({ url }) => {
    const res = await fetch(`${url}/api/payments`);
    eq(res.status, 404, 'no-port status');
  });
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments`, { method: 'POST' });
    eq(res.status, 405, 'POST status');
    eq(res.headers.get('allow'), 'GET', 'allow header');
  });
});

test('06. CORS preflight + headers apply to the list route for a listed origin', async () => {
  await runWithServer(
    { paymentDetail: stubPort(), corsOrigins: ['https://app.example.com'] },
    async ({ url }) => {
      const preflight = await fetch(`${url}/api/payments`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
      });
      eq(preflight.status, 204, 'allowed preflight returns 204');
      eq(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com', 'preflight echoes the origin');
      const rejected = await fetch(`${url}/api/payments`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
      });
      eq(rejected.status, 403, 'unlisted origin preflight is 403');
      const res = await fetch(`${url}/api/payments`, {
        headers: { origin: 'https://app.example.com' },
      });
      eq(res.status, 200, 'GET status');
      eq(res.headers.get('access-control-allow-origin'), 'https://app.example.com', 'GET echoes the origin');
      const unlisted = await fetch(`${url}/api/payments`, {
        headers: { origin: 'https://evil.example.com' },
      });
      eq(unlisted.status, 200, 'unlisted origin still gets the list');
      ok(unlisted.headers.get('access-control-allow-origin') === null, 'no CORS header for an unlisted origin');
    },
  );
});

test('07. the detail route still works beside the new list route', async () => {
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`);
    eq(res.status, 200, 'detail status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['paymentDigest'], KNOWN, 'digest passes through');
    eq(body['explorerUrl'], EXPECTED_EXPLORER, 'explorer link built from the network mapping');
    const list = await fetch(`${url}/api/payments`);
    eq(list.status, 200, 'list status on the same server');
  });
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
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\npayment-list-api: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
