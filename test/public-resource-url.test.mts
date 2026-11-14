/**
 * Public resource URL support — regression tests.
 *
 * Covers `resolveResourceUrl` (src/x402/resourceServer.ts) and the resource
 * server behind a reverse proxy: when `AGENTTRUST_X402_PUBLIC_URL` is set,
 * the 402 challenge and the provider-side resource binding use the public
 * URL, while the server still binds loopback. The public URL is operator
 * configuration only — it is never derived from request headers.
 *
 *   1. Valid public HTTPS URL (incl. a reverse-proxy prefix in the path).
 *   2. Invalid HTTP URL is rejected at startup.
 *   3. URL containing credentials is rejected.
 *   4. URL containing a query or a fragment is rejected.
 *   5. Incorrect resource path is rejected.
 *   6. Absent public URL preserves the loopback URL.
 *   7. 402 challenge uses the configured public URL.
 *   8. Payment resource binding accepts the exact configured public URL.
 *   9. Mismatched resource URL is rejected (and never reaches the facilitator).
 *  10. The actual listener remains bound to loopback.
 *
 * Offline: fake facilitator + fake chain verifier, real provider + real HTTP
 * layer on loopback. No signing, no transactions, no network.
 *
 * Run with: npm test  (tsx)
 */

import { createServer } from 'node:http';
import { eq, ok, throws } from './helpers.mjs';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer, resolveResourceUrl } from '../src/x402/resourceServer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const RESOURCE_PATH = '/protected';
const PUBLIC_URL = 'https://api.sabokun.my.id/agenttrust/protected';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ─── resolveResourceUrl: validation ─────────────────────────────────────────

test('valid public HTTPS URL is used verbatim as the canonical resource URL', () => {
  eq(
    resolveResourceUrl({ publicUrl: PUBLIC_URL, host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    PUBLIC_URL,
    'the real public URL is accepted verbatim',
  );
  // No proxy prefix: the public path may be the resource route itself.
  eq(
    resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'https://api.sabokun.my.id/protected',
    'a public URL with no proxy prefix is accepted',
  );
  // A different resource route, configured consistently, is accepted.
  eq(
    resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/paid', host: '127.0.0.1', port: 4590, resourcePath: '/paid' }),
    'https://api.sabokun.my.id/agenttrust/paid',
    'the route is the configured one, not hardcoded',
  );
  // A default https port is normalised away (canonical form).
  eq(
    resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id:443/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    PUBLIC_URL,
    'https :443 is dropped from the canonical URL',
  );
});

test('invalid HTTP URL is rejected at startup', () => {
  throws(
    () => resolveResourceUrl({ publicUrl: 'http://api.sabokun.my.id/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'https',
    'plain http is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'not a url', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'absolute URL',
    'a non-URL is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: '/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'absolute URL',
    'a relative path is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://:443/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'absolute URL',
    'a URL with an empty host is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://./agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'hostname',
    'a degenerate hostname (".") is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://../agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'hostname',
    'a degenerate hostname ("..") is rejected',
  );
});

test('URL containing credentials is rejected', () => {
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://user:pass@api.sabokun.my.id/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'credentials',
    'username + password are rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://user@api.sabokun.my.id/agenttrust/protected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'credentials',
    'a username alone is rejected',
  );
});

test('URL containing a query or a fragment is rejected', () => {
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/protected?x=1', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'query or fragment',
    'a query string is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/protected#section', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'query or fragment',
    'a fragment is rejected',
  );
});

test('incorrect resource path is rejected', () => {
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/other', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'path must be /protected',
    'a different route is rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/protected/extra', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'path must be /protected',
    'extra segments after the route are rejected',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/otherprotected', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'path must be /protected',
    'a route that merely ends with the same letters is rejected (segment boundary)',
  );
  throws(
    () => resolveResourceUrl({ publicUrl: 'https://api.sabokun.my.id/agenttrust/protected/', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'path must be /protected',
    'a trailing slash after the route is rejected',
  );
});

test('absent public URL preserves the loopback URL', () => {
  eq(
    resolveResourceUrl({ host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'http://127.0.0.1:4590/protected',
    'undefined → loopback, as before',
  );
  eq(
    resolveResourceUrl({ publicUrl: '', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'http://127.0.0.1:4590/protected',
    'empty string → loopback, as before',
  );
  eq(
    resolveResourceUrl({ publicUrl: '   ', host: '127.0.0.1', port: 4590, resourcePath: RESOURCE_PATH }),
    'http://127.0.0.1:4590/protected',
    'whitespace-only → loopback, as before',
  );
  eq(
    resolveResourceUrl({ host: '::1', port: 4590, resourcePath: RESOURCE_PATH }),
    'http://[::1]:4590/protected',
    'IPv6 loopback is bracketed, as before',
  );
});

// ─── resource server behind a reverse proxy ─────────────────────────────────

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
  port: number;
  facilitator: ReturnType<typeof fakeFacilitator>;
  close: () => Promise<void>;
}

/** Server bound to loopback, provider bound to the PUBLIC resource URL. */
async function withPublicServer(): Promise<ServerCtx & { started: Awaited<ReturnType<typeof startX402ResourceServer>> }> {
  const port = await freePort();
  const facilitator = fakeFacilitator();
  const chain = { readTransfer: async () => chainFinalized() };
  const provider = createX402Provider(
    { requirements: requirementsFor(PUBLIC_URL), resourceUrl: PUBLIC_URL, description: 'Protected', resource: { secret: 'data' } },
    { facilitator: facilitator as never, chain },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore(), expectSender: SENDER, expectSponsor: SPONSOR },
  );
  const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host: '127.0.0.1', port });
  return { url: started.url, port, facilitator, started, close: started.close };
}

async function runWithPublicServer<T>(fn: (ctx: ServerCtx & { started: Awaited<ReturnType<typeof startX402ResourceServer>> }) => Promise<T>): Promise<T> {
  const ctx = await withPublicServer();
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('402 challenge uses the configured public URL', async () => {
  await runWithPublicServer(async ({ url }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`);
    eq(res.status, 402, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['x402Version'], 2, 'x402Version');
    eq((body['resource'] as Record<string, unknown>)['url'], PUBLIC_URL, 'resource.url is the public URL, not loopback');
    const accepts = body['accepts'] as Array<Record<string, unknown>>;
    ok(Array.isArray(accepts) && accepts.length === 1, 'one accept');
    eq(accepts[0]['network'], CAIP2, 'Testnet network');
    eq(accepts[0]['payTo'], RECIPIENT, 'payTo');
    eq(accepts[0]['amount'], '1', 'amount 1 microCCD');
  });
});

test('payment resource binding accepts the exact configured public URL', async () => {
  await runWithPublicServer(async ({ url, facilitator }) => {
    const requirements = requirementsFor(PUBLIC_URL);
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, PUBLIC_URL, 'req-public-1')) },
    });
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, any>;
    eq(body.resource.secret, 'data', 'resource body');
    eq(body.payment.transaction, HASH, 'transaction hash');
    ok(res.headers.get('payment-response') !== null, 'PAYMENT-RESPONSE present');
    eq(facilitator.calls.join(','), 'verify,settle', 'facilitator verify + settle were called');
  });
});

test('mismatched resource URL is rejected and never reaches the facilitator', async () => {
  await runWithPublicServer(async ({ url, port, facilitator }) => {
    const requirements = requirementsFor(PUBLIC_URL);
    // The loopback URL is a real URL the server listens on — but the provider
    // is bound to the public URL, so a payment for loopback must be refused.
    const loopbackUrl = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
    const res = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, loopbackUrl, 'req-mismatch-1')) },
    });
    eq(res.status, 400, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['error'], 'payment is not bound to this resource', 'binding error');
    eq(body['expected'], PUBLIC_URL, 'expected is the public URL');
    eq(facilitator.calls.length, 0, 'the facilitator was never called (binding is checked first)');
  });
});

test('the actual listener remains bound to loopback', async () => {
  await runWithPublicServer(async ({ url, started }) => {
    ok(url.startsWith('http://127.0.0.1:'), `started.url is loopback (${url})`);
    ok(!url.includes('sabokun'), 'started.url never names the public host');
    const addr = started.server.address();
    ok(typeof addr === 'object' && addr !== null, 'server has an address');
    eq((addr as { address: string }).address, '127.0.0.1', 'the socket is bound to 127.0.0.1, not 0.0.0.0');
    // And the challenge served on that loopback socket still names the public URL.
    const res = await fetch(`${url}${RESOURCE_PATH}`);
    eq(res.status, 402, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq((body['resource'] as Record<string, unknown>)['url'], PUBLIC_URL, 'challenge names the public URL while listening on loopback');
  });
});

// ─── runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\npublic-resource-url: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
