/**
 * Payment detail API (resource-server layer): GET /api/payments/:id.
 *
 * Covers the route the frontend calls: a 200 detail is enriched with the
 * explorer link built from the payment's network (SDK mapping, never a
 * hardcoded URL); the facilitator's 404/400 pass through; a dead port
 * yields 503; no port means the route does not exist (404); non-GET is
 * 405; CORS applies to the route for listed origins.
 *
 * Fully offline. Real HTTP on loopback (node:http + real fetch) with a
 * stub detail port; the provider/facilitator are fakes. No signing, no
 * chain, no facilitator process.
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

type DetailPort = { getPaymentDetail?: (id: string) => Promise<{ status: number; body: unknown }> };

interface ServerCtx {
  url: string;
  close: () => Promise<void>;
}

async function withServer(opts: {
  paymentDetail?: DetailPort;
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
  opts: { paymentDetail?: DetailPort; corsOrigins?: string[] },
  fn: (ctx: ServerCtx) => Promise<T>,
): Promise<T> {
  const ctx = await withServer(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

const stubPort = (): DetailPort => ({
  getPaymentDetail: async (id: string) => {
    if (id === KNOWN) return { status: 200, body: knownDetail() };
    return { status: 404, body: { ok: false, code: 'unknown_payment', reason: 'no payment with this digest or transaction hash' } };
  },
});

test('01. 200 detail is enriched with the explorer link for its network', async () => {
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['paymentDigest'], KNOWN, 'digest passes through');
    eq(body['finalized'], true, 'finalized passes through');
    eq(body['explorerUrl'], EXPECTED_EXPLORER, 'explorer link built from the network mapping');
  });
});

test('02. unknown payment passes the facilitator 404 through', async () => {
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${'b2'.repeat(32)}`);
    eq(res.status, 404, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['code'], 'unknown_payment', 'code passes through');
  });
});

test('03. malformed identifier is 400 without touching the port', async () => {
  let called = false;
  const port: DetailPort = {
    getPaymentDetail: async () => {
      called = true;
      return { status: 200, body: {} };
    },
  };
  await runWithServer({ paymentDetail: port }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/xyz`);
    eq(res.status, 400, 'status');
    notOk(called, 'port not called for a malformed id');
  });
});

test('04. a throwing port yields 503, not a crash', async () => {
  const port: DetailPort = {
    getPaymentDetail: async () => {
      throw new Error('facilitator down');
    },
  };
  await runWithServer({ paymentDetail: port }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`);
    eq(res.status, 503, 'status');
    eq(((await res.json()) as Record<string, unknown>)['error'], 'payment_detail_unavailable', 'error code');
  });
});

test('05. no port means the route does not exist (404)', async () => {
  await runWithServer({}, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`);
    eq(res.status, 404, 'status');
  });
});

test('06. non-GET on the route is 405 with allow: GET', async () => {
  await runWithServer({ paymentDetail: stubPort() }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`, { method: 'POST' });
    eq(res.status, 405, 'status');
    eq(res.headers.get('allow'), 'GET', 'allow header');
  });
});

test('07. CORS headers apply to the detail route for a listed origin', async () => {
  await runWithServer(
    { paymentDetail: stubPort(), corsOrigins: ['https://app.example.com'] },
    async ({ url }) => {
      const res = await fetch(`${url}/api/payments/${KNOWN}`, {
        headers: { origin: 'https://app.example.com' },
      });
      eq(res.status, 200, 'status');
      eq(res.headers.get('access-control-allow-origin'), 'https://app.example.com', 'CORS origin echoed');
      const unlisted = await fetch(`${url}/api/payments/${KNOWN}`, {
        headers: { origin: 'https://evil.example.com' },
      });
      eq(unlisted.status, 200, 'unlisted origin still gets the detail');
      ok(unlisted.headers.get('access-control-allow-origin') === null, 'no CORS header for an unlisted origin');
    },
  );
});

test('08. explorerUrl is null when the detail carries no network or hash', async () => {
  const port: DetailPort = {
    getPaymentDetail: async () => ({
      status: 200,
      body: { paymentDigest: KNOWN, state: 'created', finalized: false, transactionHash: null, requirements: { network: null } },
    }),
  };
  await runWithServer({ paymentDetail: port }, async ({ url }) => {
    const res = await fetch(`${url}/api/payments/${KNOWN}`);
    eq(res.status, 200, 'status');
    eq(((await res.json()) as Record<string, unknown>)['explorerUrl'], null, 'no explorer link without network + hash');
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
console.log(`\npayment-detail-api: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
