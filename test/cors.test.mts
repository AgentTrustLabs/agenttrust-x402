/**
 * Controlled CORS tests for the x402 resource server.
 *
 * Coverage:
 *   1. allowlist parsing: comma-separated, trim, dedupe, empty entries dropped
 *   2. allowlist parsing rejects wildcards and malformed origins (fail-closed)
 *   3. allowed production origin: GET /api/services → 200 + ACAO + Vary
 *   4. allowed preview origin: GET /protected → 402 + ACAO + Vary
 *   5. rejected origin: GET → same body, no ACAO, Vary only
 *   6. preflight, allowed origin: OPTIONS /protected → 204 + full headers
 *   7. preflight, allowed origin: OPTIONS /api/services → 204 + full headers
 *   8. preflight, rejected origin: OPTIONS /protected → 403, no permission headers
 *   9. existing GET behavior preserved (CORS server vs no-CORS server, no Origin)
 *  10. OPTIONS without Origin → existing 405 (not a preflight)
 *  11. CORS disabled: OPTIONS with Origin → 405; GET with Origin → no CORS headers
 *  12. prefixed resource path (/agenttrust/protected): CORS follows the
 *      configured path, not a hardcoded /protected; detail route covered
 *  13. paid 200 with an allowed origin still carries the payment response
 *      headers (payment flow untouched, CORS merged)
 *
 * The facilitator and the chain are fakes, so every path is reachable with
 * no node, no signing, and no transaction. No fake ever claims a real
 * Testnet settlement. No credentials anywhere.
 */

import { createServer } from 'node:http';
import { eq, ok, notOk, throws } from './helpers.mjs';
import { createServiceRegistry } from '../src/discovery/registry.js';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer } from '../src/x402/resourceServer.js';
import { parseCorsOrigins } from '../src/x402/cors.js';

console.log('── cors ──');

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const BLOCK_HASH = 'cd'.repeat(32);
const PROD_ORIGIN = 'https://agenttrust.vercel.app';
const PREVIEW_ORIGIN = 'https://agenttrust-git-preview-naninu123.vercel.app';
const EVIL_ORIGIN = 'https://evil.example.invalid';
const ALLOWLIST = [PROD_ORIGIN, PREVIEW_ORIGIN];

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

const chainFinalized = (over: Partial<ChainTransferSummary> = {}): ChainTransferSummary => ({
  status: 'finalized',
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  amount: '1',
  network: CAIP2,
  blockHash: BLOCK_HASH,
  failed: false,
  ...over,
});

const fakeFacilitator = () => ({
  verify: async () => ({ isValid: true }),
  settle: async () => ({ success: true, transaction: HASH, network: CAIP2 }),
});

const stubPayload = (requirements: unknown, resourceUrl: string, requestId: string) => ({
  x402Version: 2,
  accepted: requirements,
  payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
  resource: { url: resourceUrl },
  requestId,
});

interface ServerCtx {
  url: string;
  resourceUrl: string;
  resourcePath: string;
  close: () => Promise<void>;
}

async function withServer(opts: {
  corsOrigins?: readonly string[];
  resourcePath?: string;
}): Promise<ServerCtx> {
  const port = await freePort();
  const resourcePath = opts.resourcePath ?? '/protected';
  const endpoint = `http://127.0.0.1:${port}${resourcePath}`;
  const registry = createServiceRegistry();
  const requirements = buildPaymentRequirements({
    payTo: RECIPIENT,
    amountMicroCcd: '1',
    resourceUrl: endpoint,
    network: CAIP2,
    maxTimeoutSeconds: 300,
    feePayer: SPONSOR,
  });
  const provider = createX402Provider(
    { requirements, resourceUrl: endpoint, resource: { body: 'PROTECTED-CONTENT', url: endpoint } },
    { facilitator: fakeFacilitator() as never, chain: { readTransfer: async () => chainFinalized() } },
    {
      preflight: preflightPaymentPayload,
      buildRequired: buildPaymentRequired,
      replayStore: new ReplayStore(),
      expectSender: SENDER,
      expectSponsor: SPONSOR,
    },
  );
  const started = await startX402ResourceServer({
    provider,
    resourcePath,
    host: '127.0.0.1',
    port,
    discovery: registry,
    ...(opts.corsOrigins !== undefined ? { corsOrigins: opts.corsOrigins } : {}),
  });
  return {
    url: started.url,
    resourceUrl: endpoint,
    resourcePath,
    close: async () => {
      await started.close();
      registry.close();
    },
  };
}

async function runWithServer<T>(
  opts: Parameters<typeof withServer>[0],
  fn: (ctx: ServerCtx) => Promise<T>,
): Promise<T> {
  const ctx = await withServer(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
}

async function fetchRaw(url: string, init?: RequestInit): Promise<RawResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: () => JSON.parse(text),
  };
}

const hasCredentials = (h: Headers): boolean => h.has('access-control-allow-credentials');

// ── parsing ──────────────────────────────────────────────────────────────────

test('allowlist parsing: comma-separated, trim, dedupe, empty entries dropped', () => {
  eq(
    JSON.stringify(parseCorsOrigins(` ${PROD_ORIGIN} , , ${PREVIEW_ORIGIN},${PROD_ORIGIN} `)),
    JSON.stringify([PROD_ORIGIN, PREVIEW_ORIGIN]),
    'parsing normalizes the list',
  );
  eq(JSON.stringify(parseCorsOrigins(undefined)), '[]', 'unset → disabled');
  eq(JSON.stringify(parseCorsOrigins('  ')), '[]', 'blank → disabled');
});

test('allowlist parsing rejects wildcards and malformed origins', () => {
  throws(() => parseCorsOrigins('*'), 'wildcard', "'*' is rejected");
  throws(() => parseCorsOrigins('https://*.vercel.app'), 'wildcard', "'*.vercel.app' is rejected");
  throws(() => parseCorsOrigins('https://*.example.com, https://ok.example'), 'wildcard', 'a wildcard entry rejects the whole value');
  throws(() => parseCorsOrigins('not-a-url'), 'valid URL', 'a non-URL is rejected');
  throws(() => parseCorsOrigins('ftp://example.com'), 'http', 'a non-http(s) scheme is rejected');
  throws(() => parseCorsOrigins('https://user:pass@example.com'), 'credentials', 'credentials in an origin are rejected');
  throws(() => parseCorsOrigins('https://example.com/'), 'bare origin', 'a trailing slash is rejected');
  throws(() => parseCorsOrigins('https://example.com/path'), 'bare origin', 'a path is rejected');
  throws(() => parseCorsOrigins('https://example.com:443'), 'bare origin', 'a default port is rejected');
  eq(
    JSON.stringify(parseCorsOrigins('http://127.0.0.1:4590')),
    JSON.stringify(['http://127.0.0.1:4590']),
    'an http loopback origin is accepted (local dev)',
  );
});

// ── allowed origins ──────────────────────────────────────────────────────────

test('allowed production origin: GET /api/services → 200 + ACAO + Vary', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/api/services`, { headers: { Origin: PROD_ORIGIN } });
    eq(res.status, 200, 'list returns 200');
    eq(res.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'ACAO echoes the allowed origin');
    eq(res.headers.get('vary'), 'Origin', 'Vary: Origin is set');
    notOk(hasCredentials(res.headers), 'no credentials header is set');
    const body = res.json() as { services: unknown[]; total: number };
    eq(body.total, 0, 'empty registry lists zero services');
  });
});

test('allowed preview origin: GET /protected → 402 + ACAO + Vary', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/protected`, { headers: { Origin: PREVIEW_ORIGIN } });
    eq(res.status, 402, 'unpaid request still returns 402');
    eq(res.headers.get('access-control-allow-origin'), PREVIEW_ORIGIN, 'ACAO echoes the preview origin');
    eq(res.headers.get('vary'), 'Origin', 'Vary: Origin is set');
    notOk(hasCredentials(res.headers), 'no credentials header is set');
    const body = res.json() as { x402Version: number; resource: { url: string } };
    eq(body.x402Version, 2, 'challenge is x402 v2');
    eq(body.resource.url, ctx.resourceUrl, 'challenge names the canonical resource URL');
  });
});

test('rejected origin: GET → same body, no ACAO, Vary only', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const rejected = await fetchRaw(`${ctx.url}/api/services`, { headers: { Origin: EVIL_ORIGIN } });
    const plain = await fetchRaw(`${ctx.url}/api/services`);
    eq(rejected.status, 200, 'rejected origin still gets the response (CORS is a browser gate, not auth)');
    eq(rejected.headers.get('access-control-allow-origin'), null, 'no ACAO for an unlisted origin');
    eq(rejected.headers.get('vary'), 'Origin', 'Vary: Origin is still set');
    eq(rejected.text, plain.text, 'rejected-origin body is identical to the plain body');
    const detail = await fetchRaw(`${ctx.url}/api/services/nope`, { headers: { Origin: PROD_ORIGIN } });
    eq(detail.status, 404, 'detail route still 404s for an unknown id');
    eq(detail.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'detail route is in the CORS family');
  });
});

// ── preflight ────────────────────────────────────────────────────────────────

test('preflight, allowed origin: OPTIONS /protected → 204 + full headers', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/protected`, {
      method: 'OPTIONS',
      headers: {
        Origin: PROD_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-PAYMENT',
      },
    });
    eq(res.status, 204, 'allowed preflight returns 204');
    eq(res.text, '', '204 carries no body');
    eq(res.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'ACAO echoes the origin');
    eq(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS', 'ACAM lists GET, OPTIONS');
    eq(res.headers.get('access-control-allow-headers'), 'X-PAYMENT, Content-Type', 'ACAH covers X-PAYMENT and Content-Type');
    eq(res.headers.get('vary'), 'Origin', 'Vary: Origin is set');
    notOk(hasCredentials(res.headers), 'no credentials header is set');
  });
});

test('preflight, allowed origin: OPTIONS /api/services → 204 + full headers', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/api/services`, {
      method: 'OPTIONS',
      headers: { Origin: PREVIEW_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    eq(res.status, 204, 'allowed preflight on the discovery route returns 204');
    eq(res.headers.get('access-control-allow-origin'), PREVIEW_ORIGIN, 'ACAO echoes the preview origin');
    eq(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS', 'ACAM lists GET, OPTIONS');
    eq(res.headers.get('access-control-allow-headers'), 'X-PAYMENT, Content-Type', 'ACAH covers X-PAYMENT and Content-Type');
  });
});

test('preflight, rejected origin: OPTIONS /protected → 403, no permission headers', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/protected`, {
      method: 'OPTIONS',
      headers: {
        Origin: EVIL_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-PAYMENT',
      },
    });
    eq(res.status, 403, 'rejected preflight is refused');
    eq(res.headers.get('access-control-allow-origin'), null, 'no ACAO for an unlisted origin');
    eq(res.headers.get('access-control-allow-methods'), null, 'no ACAM for an unlisted origin');
    eq(res.headers.get('access-control-allow-headers'), null, 'no ACAH for an unlisted origin');
    eq(res.headers.get('vary'), 'Origin', 'Vary: Origin is still set');
    const body = res.json() as { error: string };
    eq(body.error, 'origin not allowed', 'rejection names the reason');
  });
});

// ── existing behavior preserved ─────────────────────────────────────────────

test('existing GET behavior preserved (CORS server vs no-CORS server, no Origin)', async () => {
  // The two servers bind different ephemeral ports, so the 402 challenge
  // names a different loopback resource URL in each; normalize the port
  // before comparing bodies. Everything else must be byte-identical.
  const norm = (text: string) => text.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:PORT');
  const plain = await runWithServer({}, async (ctx) => {
    const a = await fetchRaw(`${ctx.url}/protected`);
    const b = await fetchRaw(`${ctx.url}/api/services`);
    return { protectedText: a.text, protectedStatus: a.status, servicesText: b.text, servicesStatus: b.status };
  });
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const a = await fetchRaw(`${ctx.url}/protected`);
    const b = await fetchRaw(`${ctx.url}/api/services`);
    eq(a.status, plain.protectedStatus, '402 status unchanged');
    eq(norm(a.text), norm(plain.protectedText), '402 body is identical without an Origin header');
    eq(a.headers.get('access-control-allow-origin'), null, 'no ACAO without an Origin header');
    eq(a.headers.get('vary'), null, 'no Vary without an Origin header');
    eq(b.status, plain.servicesStatus, '200 status unchanged');
    eq(b.text, plain.servicesText, 'discovery body is byte-identical without an Origin header');
    eq(b.headers.get('access-control-allow-origin'), null, 'no ACAO on the discovery route without Origin');
  });
});

test('OPTIONS without Origin → existing 405 (not a preflight)', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const res = await fetchRaw(`${ctx.url}/protected`, { method: 'OPTIONS' });
    eq(res.status, 405, 'OPTIONS without Origin falls through to the existing 405');
    eq(res.headers.get('allow'), 'GET', 'Allow: GET is preserved');
    eq(res.headers.get('access-control-allow-origin'), null, 'no ACAO without an Origin header');
  });
});

test('CORS disabled: OPTIONS with Origin → 405; GET with Origin → no CORS headers', async () => {
  await runWithServer({}, async (ctx) => {
    const pre = await fetchRaw(`${ctx.url}/protected`, {
      method: 'OPTIONS',
      headers: { Origin: PROD_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    eq(pre.status, 405, 'with CORS unconfigured, preflight falls through to the old 405');
    const get = await fetchRaw(`${ctx.url}/api/services`, { headers: { Origin: PROD_ORIGIN } });
    eq(get.status, 200, 'GET still works with CORS unconfigured');
    eq(get.headers.get('access-control-allow-origin'), null, 'no ACAO when CORS is unconfigured');
    eq(get.headers.get('vary'), null, 'no Vary when CORS is unconfigured');
  });
});

// ── deployment path ──────────────────────────────────────────────────────────

test('prefixed resource path: CORS follows the configured path', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST, resourcePath: '/agenttrust/protected' }, async (ctx) => {
    const pre = await fetchRaw(`${ctx.url}/agenttrust/protected`, {
      method: 'OPTIONS',
      headers: { Origin: PROD_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    eq(pre.status, 204, 'preflight on the prefixed path returns 204');
    eq(pre.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'ACAO on the prefixed path');
    const get = await fetchRaw(`${ctx.url}/agenttrust/protected`, { headers: { Origin: PROD_ORIGIN } });
    eq(get.status, 402, 'GET on the prefixed path still returns the 402 challenge');
    eq(get.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'ACAO on the prefixed GET');
    const bare = await fetchRaw(`${ctx.url}/protected`, { headers: { Origin: PROD_ORIGIN } });
    eq(bare.status, 404, 'the bare path is not served when the configured path is prefixed');
    eq(bare.headers.get('access-control-allow-origin'), null, 'no CORS headers on a non-CORS path');
  });
});

// ── payment flow untouched ───────────────────────────────────────────────────

test('paid 200 with an allowed origin still carries the payment response headers', async () => {
  await runWithServer({ corsOrigins: ALLOWLIST }, async (ctx) => {
    const requirements = buildPaymentRequirements({
      payTo: RECIPIENT,
      amountMicroCcd: '1',
      resourceUrl: ctx.resourceUrl,
      network: CAIP2,
      maxTimeoutSeconds: 300,
      feePayer: SPONSOR,
    });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-cors-1'));
    const res = await fetchRaw(`${ctx.url}/protected`, {
      headers: { Origin: PROD_ORIGIN, 'X-PAYMENT': payload },
    });
    eq(res.status, 200, 'a valid verified payment still returns 200 through the CORS handler');
    eq(res.headers.get('access-control-allow-origin'), PROD_ORIGIN, 'ACAO is merged onto the 200');
    ok(res.headers.get('payment-response'), 'PAYMENT-RESPONSE header is still present');
    ok(res.headers.get('x-payment-response'), 'X-PAYMENT-RESPONSE alias is still present');
    const body = res.json() as { payment: { transaction: string } };
    eq(body.payment.transaction, HASH, 'settlement hash is unchanged');
  });
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
console.log(`\ncors: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
