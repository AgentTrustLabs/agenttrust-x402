/**
 * HTTP x402 resource-server + client regression tests.
 *
 * Exercises the real HTTP layer (node:http on loopback + real fetch) with a
 * fake facilitator and a fake chain verifier. No node, no signing, no
 * transactions. The provider itself is the real `createX402Provider`; the
 * chain/facilitator behind it are fakes, so every failure path is reachable.
 *
 * Also pins the wire contract between the resource server and the real
 * facilitator: `createHttpFacilitator` must POST
 * `{ x402Version: 2, paymentPayload, paymentRequirements }` to /verify and
 * /settle — exactly what the facilitator core's `parseEnvelope` accepts.
 */

import { createServer } from 'node:http';
import { eq, ok } from './helpers.mjs';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { createHttpFacilitator } from '../src/payments/x402Sdk.js';
import { startX402ResourceServer, resolveBindHost, decodePaymentResponse } from '../src/x402/resourceServer.js';
import { fetchPaidResource, parsePaymentRequired } from '../src/x402/client.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const RESOURCE_PATH = '/protected';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const requirementsFor = (resourceUrl: string) => buildPaymentRequirements({
  payTo: RECIPIENT,
  amountMicroCcd: '1',
  maxTimeoutSeconds: 300,
  resourceUrl,
  feePayer: SPONSOR,
  network: CAIP2,
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

/** Fake facilitator. `calls` records the order of verify/settle invocations. */
const fakeFacilitator = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  return {
    calls,
    verify: async () => {
      calls.push('verify');
      return { isValid: true };
    },
    settle: async () => {
      calls.push('settle');
      return { success: true, transaction: HASH, network: CAIP2 };
    },
    ...over,
  };
};

/** Structural X-PAYMENT payload: version-1 signed-transaction shape, no real signature. */
const stubPayload = (requirements: unknown, resourceUrl: string, requestId: string) => ({
  x402Version: 2,
  accepted: requirements,
  payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
  resource: { url: resourceUrl },
  requestId,
});

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

interface ServerCtx {
  url: string;
  resourceUrl: string;
  facilitator: ReturnType<typeof fakeFacilitator>;
  close: () => Promise<void>;
}

async function withServer(opts: {
  facilitator?: ReturnType<typeof fakeFacilitator>;
  chain?: { readTransfer: (hash: string) => Promise<ChainTransferSummary> };
}): Promise<ServerCtx> {
  const port = await freePort();
  const resourceUrl = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
  const facilitator = opts.facilitator ?? fakeFacilitator();
  const chain = opts.chain ?? { readTransfer: async () => chainFinalized() };
  const provider = createX402Provider(
    { requirements: requirementsFor(resourceUrl), resourceUrl, description: 'Protected', resource: { secret: 'data' } },
    { facilitator: facilitator as never, chain },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore(), expectSender: SENDER, expectSponsor: SPONSOR },
  );
  const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host: '127.0.0.1', port });
  return { url: started.url, resourceUrl, facilitator, close: started.close };
}

async function runWithServer<T>(opts: Parameters<typeof withServer>[0], fn: (ctx: ServerCtx) => Promise<T>): Promise<T> {
  const ctx = await withServer(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

// ── resource server: happy path + challenge ──────────────────────────────

test('01. unpaid GET returns 402 with a challenge', async () => {
  await runWithServer({}, async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`);
    eq(res.status, 402, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['x402Version'], 2, 'x402Version');
    const accepts = body['accepts'] as Array<Record<string, unknown>>;
    ok(Array.isArray(accepts) && accepts.length === 1, 'one accept');
    eq(accepts[0]['payTo'], RECIPIENT, 'payTo');
    eq(accepts[0]['amount'], '1', 'amount');
    eq((body['resource'] as Record<string, unknown>)['url'], resourceUrl, 'resource url');
  });
});

test('02. valid X-PAYMENT returns 200, resource, and settlement headers', async () => {
  await runWithServer({}, async ({ url, resourceUrl }) => {
    const requirements = requirementsFor(resourceUrl);
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, resourceUrl, 'req-1')) },
    });
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, any>;
    eq(body.resource.secret, 'data', 'resource body');
    eq(body.payment.transaction, HASH, 'transaction hash');
    const header = res.headers.get('payment-response');
    ok(header !== null, 'PAYMENT-RESPONSE present');
    eq(res.headers.get('x-payment-response'), header, 'X-PAYMENT-RESPONSE alias matches');
    const decoded = decodePaymentResponse(header!);
    eq(decoded?.['success'], true, 'settlement success');
    eq(decoded?.['transaction'], HASH, 'settlement transaction');
  });
});

test('03. empty X-PAYMENT header is rejected', async () => {
  await runWithServer({}, async ({ url }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, { headers: { 'x-payment': '   ' } });
    eq(res.status, 400, 'status');
  });
});

test('04. malformed X-PAYMENT JSON is rejected', async () => {
  await runWithServer({}, async ({ url }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, { headers: { 'x-payment': '{not json' } });
    eq(res.status, 400, 'status');
  });
});

test('05. wrong path is 404, wrong method is 405', async () => {
  await runWithServer({}, async ({ url }) => {
    eq((await fetch(`${url}/other`)).status, 404, 'unknown path');
    const post = await fetch(`${url}${RESOURCE_PATH}`, { method: 'POST' });
    eq(post.status, 405, 'POST status');
    eq(post.headers.get('allow'), 'GET', 'Allow header');
  });
});

// ── resource server: rejection paths (no access granted) ─────────────────

test('06. invalid facilitator verify is rejected with 402', async () => {
  const facilitator = fakeFacilitator({ verify: async () => ({ isValid: false, invalidReason: 'invalid_signature' }) });
  await runWithServer({ facilitator }, async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
    });
    eq(res.status, 402, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['error'], 'payment invalid', 'error');
  });
});

test('07. expired payment is rejected with 402', async () => {
  await runWithServer({}, async ({ url, resourceUrl }) => {
    const payload = stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1') as Record<string, any>;
    payload.payload.signedTransaction.header.expiry = Math.floor(Date.now() / 1000) - 10;
    const res = await fetch(`${url}${RESOURCE_PATH}`, { headers: { 'x-payment': JSON.stringify(payload) } });
    eq(res.status, 402, 'status');
  });
});

test('08. replay of the same X-PAYMENT is rejected with 409', async () => {
  await runWithServer({}, async ({ url, resourceUrl }) => {
    const header = JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1'));
    const first = await fetch(`${url}${RESOURCE_PATH}`, { headers: { 'x-payment': header } });
    eq(first.status, 200, 'first');
    await first.text();
    const second = await fetch(`${url}${RESOURCE_PATH}`, { headers: { 'x-payment': header } });
    eq(second.status, 409, 'second is replay');
    const body = (await second.json()) as Record<string, unknown>;
    eq(body['error'], 'payment already consumed', 'replay error');
  });
});

test('09. settle that throws stays locked with 503 (ambiguous, no grant)', async () => {
  const facilitator = fakeFacilitator({
    settle: async () => {
      throw new Error('facilitator timeout');
    },
  });
  await runWithServer({ facilitator }, async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
    });
    eq(res.status, 503, 'status');
  });
});

test('10. settle success without a hash never unlocks', async () => {
  const facilitator = fakeFacilitator({ settle: async () => ({ success: true, transaction: '', network: CAIP2 }) });
  await runWithServer({ facilitator }, async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
    });
    eq(res.status, 402, 'status');
  });
});

test('11. pending transaction never unlocks', async () => {
  await runWithServer(
    { chain: { readTransfer: async () => ({ status: 'pending' as const }) } },
    async ({ url, resourceUrl }) => {
      const res = await fetch(`${url}${RESOURCE_PATH}`, {
        headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
      });
      eq(res.status, 402, 'status');
      const body = (await res.json()) as Record<string, unknown>;
      eq(body['error'], 'transaction not finalized', 'error');
    },
  );
});

test('12. chain mismatch (wrong recipient) never unlocks', async () => {
  await runWithServer(
    { chain: { readTransfer: async () => chainFinalized({ recipient: SENDER }) } },
    async ({ url, resourceUrl }) => {
      const res = await fetch(`${url}${RESOURCE_PATH}`, {
        headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
      });
      eq(res.status, 402, 'status');
    },
  );
});

test('13. chain unavailable stays locked with 503', async () => {
  await runWithServer(
    { chain: { readTransfer: async () => ({ status: 'unavailable' as const }) } },
    async ({ url, resourceUrl }) => {
      const res = await fetch(`${url}${RESOURCE_PATH}`, {
        headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
      });
      eq(res.status, 503, 'status');
    },
  );
});

test('14. facilitator failure status WITH a hash still verifies on chain (hash is truth)', async () => {
  const facilitator = fakeFacilitator({
    settle: async () => ({ success: false, transaction: HASH, network: CAIP2, errorReason: 'hash_mismatch' }),
  });
  await runWithServer({ facilitator }, async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirementsFor(resourceUrl), resourceUrl, 'req-1')) },
    });
    eq(res.status, 200, 'chain-confirmed payment grants despite facilitator status');
  });
});

// ── client: 402 → pay → grant ────────────────────────────────────────────

test('15. client pays the 402 and receives the resource + settlement', async () => {
  await runWithServer({}, async ({ url, resourceUrl }) => {
    const result = await fetchPaidResource(`${url}${RESOURCE_PATH}`, {
      createPaymentPayload: async ({ requirements, resourceUrl: r, requestId }) => stubPayload(requirements, r, requestId),
    });
    eq(result.status, 200, 'status');
    eq((result.body as Record<string, any>).resource.secret, 'data', 'resource body');
    eq(result.paymentResponse?.['transaction'], HASH, 'settlement transaction');
    eq(result.paymentResponse?.['success'], true, 'settlement success');
  });
});

test('16. client that cannot build a payload never reaches settle', async () => {
  await runWithServer({}, async ({ url, facilitator }) => {
    const result = await fetchPaidResource(`${url}${RESOURCE_PATH}`, {
      createPaymentPayload: async () => {
        throw new Error('no wallet configured');
      },
    });
    eq(result.status, 402, 'status');
    eq(result.error, 'payload_error', 'error stage');
    eq(facilitator.calls.includes('settle'), false, 'settle never called');
    eq(facilitator.calls.includes('verify'), false, 'verify never called');
  });
});

test('17. client rejects a malformed 402 challenge', async () => {
  const bad = createServer((_req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ x402Version: 2, accepts: [] }));
  });
  await new Promise<void>(resolve => bad.listen(0, '127.0.0.1', () => resolve()));
  try {
    const addr = bad.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const result = await fetchPaidResource(`http://127.0.0.1:${port}${RESOURCE_PATH}`, {
      createPaymentPayload: async () => ({}),
    });
    eq(result.status, 402, 'status');
    eq(result.error, 'malformed_requirement', 'error stage');
  } finally {
    await new Promise<void>(resolve => bad.close(() => resolve()));
  }
});

test('18. parsePaymentRequired validates the challenge shape', () => {
  eq(parsePaymentRequired(null), null, 'null');
  eq(parsePaymentRequired({ x402Version: 2, accepts: [] }), null, 'empty accepts');
  const parsed = parsePaymentRequired({
    x402Version: 2,
    resource: { url: 'http://127.0.0.1/protected' },
    accepts: [{ scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: {} }],
  });
  ok(parsed !== null, 'valid challenge parses');
  eq(parsed!.resourceUrl, 'http://127.0.0.1/protected', 'resource url');
  eq(parsed!.requirements.amount, '1', 'amount');
});

// ── facilitator HTTP client contract ─────────────────────────────────────

test('19. createHttpFacilitator posts the exact envelope the core parses', async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text.trim() ? JSON.parse(text) : null;
      seen.push({ path: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/supported') {
        res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: CAIP2 }] }));
      } else if (req.url === '/verify') {
        res.end(JSON.stringify({ isValid: true, payer: SENDER }));
      } else {
        res.end(JSON.stringify({ success: true, transaction: HASH, network: CAIP2 }));
      }
    });
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', () => resolve()));
  try {
    const addr = stub.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const f = createHttpFacilitator({ url: `http://127.0.0.1:${port}` });
    const payload = { x402Version: 2, accepted: requirementsFor('http://127.0.0.1/protected'), payload: {} };
    const requirements = requirementsFor('http://127.0.0.1/protected');
    const verify = await f.verify(payload as never, requirements);
    eq((verify as Record<string, unknown>)['isValid'], true, 'verify passes through');
    const settle = await f.settle(payload as never, requirements);
    eq((settle as Record<string, unknown>)['transaction'], HASH, 'settle passes through');
    const supported = await f.getSupported();
    eq(supported.kinds[0]?.network, CAIP2, 'supported passes through');
    eq(seen.length, 3, 'three calls');
    for (const { path, body } of seen.filter(s => s.path === '/verify' || s.path === '/settle')) {
      const b = body as Record<string, unknown>;
      eq(b['x402Version'], 2, `${path} x402Version`);
      ok('paymentPayload' in b && 'paymentRequirements' in b, `${path} envelope keys`);
      eq(JSON.stringify(b['paymentPayload']), JSON.stringify(payload), `${path} payload verbatim`);
      eq(JSON.stringify(b['paymentRequirements']), JSON.stringify(requirements), `${path} requirements verbatim`);
    }
  } finally {
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});

test('20. resolveBindHost: empty/whitespace/unset host is the loopback default; a valid host is unchanged', () => {
  // M1: an unset, empty, or whitespace-only host must be the loopback
  // default — never "bind to all interfaces" (Node binds '' to `::`).
  eq(resolveBindHost(undefined), '127.0.0.1', 'unset → loopback');
  eq(resolveBindHost(''), '127.0.0.1', 'empty → loopback');
  eq(resolveBindHost('   '), '127.0.0.1', 'whitespace-only → loopback');
  eq(resolveBindHost('  127.0.0.1  '), '127.0.0.1', 'whitespace-padded host is trimmed');
  // A valid, explicitly configured host is returned unchanged.
  eq(resolveBindHost('127.0.0.1'), '127.0.0.1', 'explicit loopback unchanged');
  eq(resolveBindHost('::1'), '::1', 'explicit ::1 unchanged');
  eq(resolveBindHost('localhost'), 'localhost', 'explicit localhost unchanged');
  eq(resolveBindHost('0.0.0.0'), '0.0.0.0', 'explicit 0.0.0.0 unchanged (operator chose it)');
  eq(resolveBindHost('192.168.1.10'), '192.168.1.10', 'explicit LAN IP unchanged');
});

test('21. startX402ResourceServer binds the ACTUAL loopback address for empty/whitespace/unset host', async () => {
  // M1: verify the real bind address (server.address()), not just the
  // variable value. An empty host must never bind to `::`.
  const cases: Array<{ host: string | undefined; expect: string }> = [
    { host: '', expect: '127.0.0.1' },
    { host: '   ', expect: '127.0.0.1' },
    { host: undefined, expect: '127.0.0.1' },
    { host: '127.0.0.1', expect: '127.0.0.1' },
    { host: '::1', expect: '::1' },
    { host: '0.0.0.0', expect: '0.0.0.0' },
  ];
  for (const { host, expect } of cases) {
    const port = await freePort();
    const resourceUrl = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
    const provider = createX402Provider(
      { requirements: requirementsFor(resourceUrl), resourceUrl, description: 'Protected', resource: { secret: 'data' } },
      { facilitator: fakeFacilitator() as never, chain: { readTransfer: async () => chainFinalized() } },
      { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore(), expectSender: SENDER, expectSponsor: SPONSOR },
    );
    const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host, port });
    try {
      const addr = started.server.address();
      const bound = typeof addr === 'object' && addr ? addr.address : '';
      eq(bound, expect, `host ${JSON.stringify(host)} binds to ${expect} (got ${bound})`);
      // The server actually serves on loopback when bound there.
      if (expect === '127.0.0.1') {
        const res = await fetch(`http://127.0.0.1:${port}${RESOURCE_PATH}`);
        eq(res.status, 402, `host ${JSON.stringify(host)}: serves the 402 challenge on loopback`);
      }
    } finally {
      await started.close();
    }
  }
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
console.log(`\nhttp-x402-resource-server: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
