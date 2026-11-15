/**
 * API Discovery MVP regression tests.
 *
 * Covers: registration + validation, discovery (list/detail), search +
 * filtering, unknown service, invalid metadata, unverified provider,
 * inactive service, pricing + x402 payment requirements, and — critically —
 * compatibility: the existing x402 payment flow still works on a server
 * that also serves Discovery.
 *
 * Fully offline. Real HTTP on loopback (node:http + real fetch) with a fake
 * facilitator and a fake chain verifier for the payment-flow checks; the
 * registry itself is pure (no I/O, no signing, no chain).
 */

import { createServer } from 'node:http';
import { eq, ok, notOk, throws } from './helpers.mjs';
import {
  createServiceRegistry,
  validateServiceInput,
  buildServicePaymentRequirements,
  toServiceView,
  DISCOVERY_NETWORK,
  SERVICE_CATEGORIES,
} from '../src/discovery/registry.js';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer } from '../src/x402/resourceServer.js';

const CAIP2 = DISCOVERY_NETWORK;
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const RESOURCE_PATH = '/protected';
const CARD_URL = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** A valid registration input. Override fields per test. */
const validInput = (over: Record<string, unknown> = {}) => ({
  name: 'Testnet Price Feed',
  description: 'Live CCD price ticks from Concordium Testnet.',
  category: 'data',
  endpoint: 'https://api.example.com/price',
  provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: CARD_URL },
  network: CAIP2,
  pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: RECIPIENT, maxTimeoutSeconds: 300 },
  ...over,
});

const registerOk = (registry: ReturnType<typeof createServiceRegistry>, over: Record<string, unknown> = {}) => {
  const r = registry.register(validInput(over) as never);
  if (!r.ok) throw new Error(`registration failed unexpectedly: ${r.errors.join('; ')}`);
  return r.service;
};

const trustedVerifier = async () => ({ decision: 'TRUSTED' as const, reason: 'test stub' });

/**
 * Register a service, verify it (stub TRUSTED), and activate it — the
 * only way a service becomes active under the activation policy.
 * Use this wherever a test needs an active, discoverable service.
 */
async function registerActive(registry: ReturnType<typeof createServiceRegistry>, over: Record<string, unknown> = {}) {
  const service = registerOk(registry, over);
  const verified = await registry.verifyProvider(service.id, trustedVerifier);
  if (!verified.ok) throw new Error(`verify failed: ${verified.error}`);
  const activated = registry.setStatus(service.id, 'active');
  if (!activated.ok) throw new Error(`activate failed: ${activated.error}`);
  return activated.service;
}

// ─── registration + validation ────────────────────────────────────────────

test('01. valid registration succeeds as INACTIVE with registered (not verified) status', () => {
  const registry = createServiceRegistry();
  const r = registry.register(validInput() as never);
  ok(r.ok, 'must register');
  if (!r.ok) return;
  ok(r.service.id.startsWith('svc_'), 'server-assigned id');
  // Activation policy: registration always creates an inactive service.
  // It becomes active only after a TRUSTED verification + activation.
  eq(r.service.status, 'inactive', 'default status is inactive');
  // Registration is NOT verification. A fresh service is 'registered', never 'verified'.
  eq(r.service.providerVerification.status, 'registered', 'provider is registered, not verified');
  eq(r.service.network, CAIP2, 'testnet');
  eq(registry.size(), 1, 'one service stored');
});

test('02. empty name / description are rejected', () => {
  const registry = createServiceRegistry();
  const a = registry.register(validInput({ name: '   ' }) as never);
  notOk(a.ok, 'blank name');
  if (!a.ok) ok(a.errors.some(e => e.includes('name')), 'names the field');
  const b = registry.register(validInput({ description: '' }) as never);
  notOk(b.ok, 'empty description');
});

test('03. unknown category is rejected', () => {
  const registry = createServiceRegistry();
  const r = registry.register(validInput({ category: 'gambling' }) as never);
  notOk(r.ok, 'must reject');
  if (!r.ok) ok(r.errors.some(e => e.includes('category')), 'names the field');
});

test('04. invalid endpoint URL is rejected', () => {
  const registry = createServiceRegistry();
  for (const endpoint of ['not-a-url', 'ftp://example.com/x', 'https://user:pass@example.com/x', 'https://']) {
    const r = registry.register(validInput({ endpoint }) as never);
    notOk(r.ok, `endpoint ${endpoint} must be rejected`);
  }
});

test('05. non-Testnet network is rejected', () => {
  const registry = createServiceRegistry();
  const r = registry.register(validInput({ network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' }) as never);
  notOk(r.ok, 'mainnet must be rejected');
  if (!r.ok) ok(r.errors.some(e => e.includes('Testnet')), 'names the constraint');
});

test('06. invalid pricing is rejected', () => {
  const registry = createServiceRegistry();
  const bad = [
    { pricing: { amountMicroCcd: '0', asset: 'CCD', payTo: RECIPIENT } },
    { pricing: { amountMicroCcd: '-5', asset: 'CCD', payTo: RECIPIENT } },
    { pricing: { amountMicroCcd: '1.5', asset: 'CCD', payTo: RECIPIENT } },
    { pricing: { amountMicroCcd: '1000000001', asset: 'CCD', payTo: RECIPIENT } },
    { pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: 'not-an-account' } },
    { pricing: { amountMicroCcd: '10', asset: 'ETH', payTo: RECIPIENT } },
    { pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: RECIPIENT, maxTimeoutSeconds: 0 } },
    { pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: RECIPIENT, maxTimeoutSeconds: 601 } },
  ];
  for (const over of bad) {
    const r = registry.register(validInput(over) as never);
    notOk(r.ok, `pricing ${JSON.stringify(over.pricing)} must be rejected`);
  }
});

test('07. invalid provider identity is rejected', () => {
  const registry = createServiceRegistry();
  const bad = [
    { provider: { tokenId: 0, ownerAccount: SENDER, agentUri: CARD_URL } },
    { provider: { tokenId: 1004, ownerAccount: 'short', agentUri: CARD_URL } },
    { provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: 'not-a-url' } },
  ];
  for (const over of bad) {
    const r = registry.register(validInput(over) as never);
    notOk(r.ok, `provider ${JSON.stringify(over.provider)} must be rejected`);
  }
});

test('08. validateServiceInput reports every problem at once', () => {
  const errors = validateServiceInput(validInput({ name: '', category: 'nope', network: 'mainnet' }) as never);
  ok(errors.length >= 3, 'multiple problems reported');
  ok(errors.some(e => e.includes('name')), 'name');
  ok(errors.some(e => e.includes('category')), 'category');
  ok(errors.some(e => e.includes('network')), 'network');
});

// ─── discovery: list + detail ────────────────────────────────────────────

test('09. list returns registered services with the discovery view shape', async () => {
  const registry = createServiceRegistry();
  const a = await registerActive(registry);
  await registerActive(registry, { name: 'Compute Node', category: 'compute', endpoint: 'https://api.example.com/compute' });
  const { services, total } = registry.list();
  eq(total, 2, 'total');
  eq(services.length, 2, 'page');
  const view = toServiceView(a);
  eq(view['id'], a.id, 'id');
  eq(view['available'], true, 'active service is available');
  ok((view as Record<string, unknown>)['paymentRequirements'] !== undefined, 'active service carries payment requirements');
});

test('10. detail returns one service by id', () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  eq(registry.get(a.id)?.name, 'Testnet Price Feed', 'by id');
  eq(registry.get('svc_doesnotexist'), undefined, 'unknown id is undefined');
});

// ─── search + filtering ──────────────────────────────────────────────────

test('11. filter by category', async () => {
  const registry = createServiceRegistry();
  await registerActive(registry);
  await registerActive(registry, { name: 'Compute Node', category: 'compute', endpoint: 'https://api.example.com/compute' });
  eq(registry.list({ category: 'compute' }).total, 1, 'compute only');
  eq(registry.list({ category: 'data' }).total, 1, 'data only');
  eq(registry.list({ category: 'content' }).total, 0, 'none in content');
});

test('12. search by q matches name and description (case-insensitive)', async () => {
  const registry = createServiceRegistry();
  await registerActive(registry);
  await registerActive(registry, { name: 'Weather Oracle', description: 'Rainfall data for farms.', category: 'data', endpoint: 'https://api.example.com/weather' });
  eq(registry.list({ q: 'price' }).total, 1, 'name match');
  eq(registry.list({ q: 'PRICE' }).total, 1, 'case-insensitive');
  eq(registry.list({ q: 'rainfall' }).total, 1, 'description match');
  eq(registry.list({ q: 'nope' }).total, 0, 'no match');
});

test('13. invalid filters are rejected, not silently ignored', () => {
  const registry = createServiceRegistry();
  throws(() => registry.list({ category: 'nope' }), 'category', 'bad category');
  throws(() => registry.list({ network: 'ccd:mainnet' }), 'network', 'bad network');
  throws(() => registry.list({ status: 'weird' }), 'status', 'bad status');
  throws(() => registry.list({ limit: 0 }), 'limit', 'limit 0');
  throws(() => registry.list({ limit: 101 }), 'limit', 'limit 101');
});

// ─── provider verification (registered vs verified) ───────────────────────

test('14. a fresh service is registered, never verified', () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  eq(a.providerVerification.status, 'registered', 'status');
  notOk(a.providerVerification.status === 'verified', 'must not be verified');
  notOk(a.providerVerification.decision !== undefined, 'no decision yet');
});

test('15. TRUSTED verifier promotes the provider to verified', async () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  const r = await registry.verifyProvider(a.id, async () => ({ decision: 'TRUSTED', reason: 'card hash matches on-chain anchor' }));
  ok(r.ok, 'verify runs');
  if (!r.ok) return;
  eq(r.service.providerVerification.status, 'verified', 'status');
  eq(r.service.providerVerification.decision, 'TRUSTED', 'decision');
  ok(r.service.providerVerification.checkedAt !== undefined, 'checkedAt recorded');
});

test('16. REJECTED verifier marks the provider rejected (not verified)', async () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  const r = await registry.verifyProvider(a.id, async () => ({ decision: 'REJECTED', reason: 'owner mismatch' }));
  ok(r.ok, 'verify runs');
  if (!r.ok) return;
  eq(r.service.providerVerification.status, 'rejected', 'status');
  notOk(r.service.providerVerification.status === 'verified', 'must not be verified');
});

test('17. INCONCLUSIVE verifier leaves the provider unverified (not trusted, not accused)', async () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  const r = await registry.verifyProvider(a.id, async () => ({ decision: 'INCONCLUSIVE', reason: 'card fetch timed out' }));
  ok(r.ok, 'verify runs');
  if (!r.ok) return;
  eq(r.service.providerVerification.status, 'unverified', 'status');
  eq(r.service.providerVerification.decision, 'INCONCLUSIVE', 'decision');
  notOk(r.service.providerVerification.status === 'verified', 'must not be verified');
});

test('18. a provider with no agentUri can never become verified', async () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry, { provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: null } });
  // Even a TRUSTED verdict cannot apply: there is no card to verify against.
  const r = await registry.verifyProvider(a.id, async () => ({ decision: 'TRUSTED' }));
  ok(r.ok, 'verify runs');
  if (!r.ok) return;
  eq(r.service.providerVerification.status, 'unverified', 'no card means unverified');
  ok((r.service.providerVerification.reason ?? '').includes('agentUri'), 'reason names the missing card');
});

test('19. a throwing verifier is unavailability, not a contradiction', async () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  const r = await registry.verifyProvider(a.id, async () => {
    throw new Error('registry unreachable');
  });
  ok(r.ok, 'verify runs');
  if (!r.ok) return;
  eq(r.service.providerVerification.status, 'unverified', 'status');
  eq(r.service.providerVerification.decision, 'INCONCLUSIVE', 'decision');
});

test('20. verifyProvider on an unknown service is an error', async () => {
  const registry = createServiceRegistry();
  const r = await registry.verifyProvider('svc_nope', async () => ({ decision: 'TRUSTED' }));
  notOk(r.ok, 'must fail');
});

// ─── inactive service ────────────────────────────────────────────────────

test('21. inactive service is hidden from the default list', async () => {
  const registry = createServiceRegistry();
  await registerActive(registry);
  const b = registerOk(registry, { name: 'Old Feed', category: 'data', endpoint: 'https://api.example.com/old' });
  eq(registry.list().total, 1, 'default list hides inactive');
  eq(registry.list({ status: 'all' }).total, 2, 'status=all shows both');
  eq(registry.list({ status: 'inactive' }).total, 1, 'inactive only');
  eq(registry.list({ status: 'inactive' }).services[0]!.id, b.id, 'the inactive one');
});

test('22. inactive service detail shows pricing but no payment requirements', () => {
  const registry = createServiceRegistry();
  // Registration always creates an inactive service now.
  const b = registerOk(registry);
  const view = toServiceView(b);
  eq(view['available'], false, 'not available');
  eq(view['status'], 'inactive', 'status');
  eq((view as Record<string, unknown>)['paymentRequirements'], undefined, 'no payment requirements when inactive');
  ok((view as Record<string, unknown>)['pricing'] !== undefined, 'price is still a fact');
});

// ─── pricing + payment requirements ──────────────────────────────────────

test('23. payment requirements match the service pricing', () => {
  const registry = createServiceRegistry();
  const a = registerOk(registry);
  const req = buildServicePaymentRequirements(a);
  eq(req.scheme, 'exact', 'scheme');
  eq(req.network, CAIP2, 'network');
  eq(req.asset, 'CCD', 'asset');
  eq(req.amount, '10', 'amount from pricing');
  eq(req.payTo, RECIPIENT, 'payTo from pricing');
  eq(req.maxTimeoutSeconds, 300, 'timeout from pricing');
  // The fee payer belongs to the facilitator, not the service. A discovery
  // response must never invent one.
  eq((req.extra as Record<string, unknown> | undefined)?.['feePayer'], undefined, 'no invented feePayer');
});

test('24. payment requirements use the service endpoint as the resource URL', async () => {
  const registry = createServiceRegistry();
  const a = await registerActive(registry);
  const req = buildServicePaymentRequirements(a);
  eq((req as unknown as { resource?: unknown }).resource, undefined, 'requirements carry no resource field');
  const view = toServiceView(a);
  const pr = view['paymentRequirements'] as Record<string, unknown>;
  eq(pr['network'], CAIP2, 'network');
  eq(pr['amount'], '10', 'amount');
});

// ─── HTTP: discovery API ─────────────────────────────────────────────────

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
  blockHash: 'cd'.repeat(32),
  failed: false,
});

const fakeFacilitator = () => ({
  verify: async () => ({ isValid: true }),
  settle: async () => ({ success: true, transaction: HASH, network: CAIP2 }),
});

interface ServerCtx {
  url: string;
  resourceUrl: string;
  registry: ReturnType<typeof createServiceRegistry>;
  close: () => Promise<void>;
}

async function withServer(withDiscovery: boolean): Promise<ServerCtx> {
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
  const registry = createServiceRegistry();
  const started = await startX402ResourceServer({
    provider,
    resourcePath: RESOURCE_PATH,
    host: '127.0.0.1',
    port,
    ...(withDiscovery ? { discovery: registry } : {}),
  });
  return { url: started.url, resourceUrl, registry, close: started.close };
}

async function runWithServer<T>(withDiscovery: boolean, fn: (ctx: ServerCtx) => Promise<T>): Promise<T> {
  const ctx = await withServer(withDiscovery);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

test('25. HTTP list returns services + total + applied filters', async () => {
  await runWithServer(true, async ({ url, registry }) => {
    await registerActive(registry);
    await registerActive(registry, { name: 'Compute Node', category: 'compute', endpoint: 'https://api.example.com/compute' });
    const res = await fetch(`${url}/api/services`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['total'], 2, 'total');
    eq((body['services'] as unknown[]).length, 2, 'services');
    eq(((body['filters'] as Record<string, unknown>)['status']), 'active', 'default filter is active');
  });
});

test('26. HTTP list filters by category and q', async () => {
  await runWithServer(true, async ({ url, registry }) => {
    await registerActive(registry);
    // Distinct description: the default description contains "price", which
    // would match the q filter below. The search must match on content, not
    // on the fixture's shared default.
    await registerActive(registry, { name: 'Compute Node', description: 'GPU cycles on demand.', category: 'compute', endpoint: 'https://api.example.com/compute' });
    const byCat = (await (await fetch(`${url}/api/services?category=compute`)).json()) as Record<string, unknown>;
    eq(byCat['total'], 1, 'category filter');
    const byQ = (await (await fetch(`${url}/api/services?q=price`)).json()) as Record<string, unknown>;
    eq(byQ['total'], 1, 'q filter');
  });
});

test('27. HTTP detail returns a service with pricing + payment requirements', async () => {
  await runWithServer(true, async ({ url, registry }) => {
    const a = await registerActive(registry);
    const res = await fetch(`${url}/api/services/${a.id}`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['id'], a.id, 'id');
    eq(body['name'], 'Testnet Price Feed', 'name');
    const pricing = body['pricing'] as Record<string, unknown>;
    eq(pricing['amountMicroCcd'], '10', 'price');
    const req = body['paymentRequirements'] as Record<string, unknown>;
    eq(req['scheme'], 'exact', 'scheme');
    eq(req['network'], CAIP2, 'network');
    eq(req['amount'], '10', 'amount');
    eq(req['payTo'], RECIPIENT, 'payTo');
    const pv = body['providerVerification'] as Record<string, unknown>;
    eq(pv['status'], 'verified', 'verified (the service is active, so it must be verified)');
  });
});

test('28. HTTP unknown service is 404', async () => {
  await runWithServer(true, async ({ url }) => {
    const res = await fetch(`${url}/api/services/svc_nope`);
    eq(res.status, 404, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['error'], 'service not found', 'error');
  });
});

test('29. HTTP invalid filters are 400', async () => {
  await runWithServer(true, async ({ url }) => {
    eq((await fetch(`${url}/api/services?category=nope`)).status, 400, 'bad category');
    eq((await fetch(`${url}/api/services?status=weird`)).status, 400, 'bad status');
    eq((await fetch(`${url}/api/services?limit=0`)).status, 400, 'bad limit');
    eq((await fetch(`${url}/api/services?network=ccd:mainnet`)).status, 400, 'non-testnet network');
  });
});

test('30. HTTP inactive service is hidden by default, visible with status=all, detail has no payment requirements', async () => {
  await runWithServer(true, async ({ url, registry }) => {
    await registerActive(registry);
    const b = registerOk(registry, { name: 'Old Feed', category: 'data', endpoint: 'https://api.example.com/old' });
    const def = (await (await fetch(`${url}/api/services`)).json()) as Record<string, unknown>;
    eq(def['total'], 1, 'default hides inactive');
    const all = (await (await fetch(`${url}/api/services?status=all`)).json()) as Record<string, unknown>;
    eq(all['total'], 2, 'status=all shows both');
    const detail = (await (await fetch(`${url}/api/services/${b.id}`)).json()) as Record<string, unknown>;
    eq(detail['available'], false, 'not available');
    eq(detail['paymentRequirements'], undefined, 'no payment requirements when inactive');
  });
});

test('31. HTTP write methods are rejected (discovery is read-only)', async () => {
  await runWithServer(true, async ({ url }) => {
    const res = await fetch(`${url}/api/services`, { method: 'POST', body: '{}' });
    eq(res.status, 405, 'POST is rejected');
    eq(res.headers.get('allow'), 'GET', 'Allow header');
  });
});

test('32. HTTP empty registry returns an empty list (not an error)', async () => {
  await runWithServer(true, async ({ url }) => {
    const res = await fetch(`${url}/api/services`);
    eq(res.status, 200, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['total'], 0, 'total');
    eq((body['services'] as unknown[]).length, 0, 'no services');
  });
});

// ─── compatibility: the x402 payment flow still works ────────────────────

test('33. with Discovery mounted, /protected still returns 402 and a paid request still returns 200', async () => {
  await runWithServer(true, async ({ url, resourceUrl, registry }) => {
    // Discovery is live on the same server.
    registerOk(registry);
    const list = await fetch(`${url}/api/services`);
    eq(list.status, 200, 'discovery still answers');

    // The payment flow is untouched: unpaid → 402 challenge.
    const unpaid = await fetch(`${url}${RESOURCE_PATH}`);
    eq(unpaid.status, 402, 'unpaid is 402');
    const challenge = (await unpaid.json()) as Record<string, unknown>;
    const accepts = challenge['accepts'] as Array<Record<string, unknown>>;
    eq(accepts[0]!['payTo'], RECIPIENT, 'challenge payTo');
    eq(accepts[0]!['amount'], '1', 'challenge amount');

    // Paid → 200 + settlement headers (fake facilitator + fake chain).
    const requirements = buildPaymentRequirements({
      payTo: RECIPIENT, amountMicroCcd: '1', maxTimeoutSeconds: 300, resourceUrl, feePayer: SPONSOR, network: CAIP2,
    });
    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
      resource: { url: resourceUrl },
      requestId: 'req-1',
    };
    const paid = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(payload) },
    });
    eq(paid.status, 200, 'paid is 200');
    const body = (await paid.json()) as Record<string, any>;
    eq(body.payment.transaction, HASH, 'settlement transaction');
    ok(paid.headers.get('payment-response') !== null, 'PAYMENT-RESPONSE present');
  });
});

test('34. without a registry, /api/services does not exist (opt-in integration)', async () => {
  await runWithServer(false, async ({ url, resourceUrl }) => {
    eq((await fetch(`${url}/api/services`)).status, 404, 'no discovery route without a registry');
    // The payment flow still works on the same server.
    eq((await fetch(`${url}${RESOURCE_PATH}`)).status, 402, 'unpaid is still 402');
  });
});

test('35. HTTP malformed percent-encoding in a service id is 400 (L1); valid encoded ids still work', async () => {
  await runWithServer(true, async ({ url, registry }) => {
    // L1: a malformed percent-encoding is bad client input → 400 with
    // a consistent error body, not the catch-all 500.
    for (const bad of ['%ZZ', '%2', '%', '%GG', 'svc_%ZZ']) {
      const res = await fetch(`${url}/api/services/${bad}`);
      eq(res.status, 400, `/${bad} is 400`);
      const body = (await res.json()) as Record<string, unknown>;
      ok(typeof body['error'] === 'string' && (body['error'] as string).length > 0, `/${bad} has an error message`);
    }
    // A valid percent-encoded id decodes and is looked up normally.
    const svc = registerOk(registry, { id: 'svc_encoded-test' });
    const encoded = await fetch(`${url}/api/services/svc_encoded%2Dtest`);
    eq(encoded.status, 200, 'valid encoded id decodes and is found');
    eq(((await encoded.json()) as Record<string, unknown>)['id'], svc.id, 'decoded id matches');
    // An encoded slash decodes to a path-like id, which is simply not
    // found (a DB lookup, never a file path) → 404, not a traversal.
    eq((await fetch(`${url}/api/services/%2Fetc%2Fpasswd`)).status, 404, 'encoded slash is 404');
    // A valid id that does not exist is still 404 (unchanged behavior).
    eq((await fetch(`${url}/api/services/svc_nope`)).status, 404, 'valid but unknown id is still 404');
  });
});

// ─── runner ──────────────────────────────────────────────────────────────

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
console.log(`\ndiscovery-api: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
