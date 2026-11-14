/**
 * Discovery read-path fail-closed — regression tests.
 *
 * The invariant, on EVERY Discovery response:
 *   Discoverable ⇔ status === 'active' AND providerVerification.status === 'verified'
 *
 * A legacy row that is stored 'active' but whose provider verification
 * is NOT TRUSTED must never appear as an active service, never be
 * retrievable as an active service, and never receive
 * `paymentRequirements`. The read/projection layer (`toServiceView` +
 * `list`) enforces this; the stored row is NEVER changed by a read.
 *
 * Mandatory cases (from the brief):
 *   1. Legacy active + unverified → not discoverable.
 *   2. Legacy active + rejected → not discoverable.
 *   3. Legacy active + inconclusive → not discoverable.
 *   4. Legacy active + verification evidence missing/null → not
 *      discoverable (and it must not throw).
 *   5. Detail endpoint for such a provider → does not reveal an active
 *      service or payment requirements.
 *   6. Active + verified → still discoverable.
 *   7. Inactive + verified → still not discoverable.
 *   8. The database row is unchanged after Discovery requests.
 *   9. No regression on onboarding, activation policy, and the x402
 *      resource server (end-to-end over HTTP, mock facilitator).
 *
 * Legacy rows are built by writing directly to the store (bypassing the
 * registry guard) — exactly what a pre-policy database row looks like.
 * No registry API can create that state anymore, so the store is the
 * only way to simulate it. In-memory store only; no production DB.
 *
 * Run with: npm test  (tsx)
 */

import { createServer } from 'node:http';
import { eq, ok, notOk } from './helpers.mjs';
import { createServiceRegistry, isDiscoverable, toServiceView } from '../src/discovery/registry.js';
import { handleDiscoveryRequest } from '../src/discovery/http.js';
import { onboardProvider } from '../src/discovery/onboarding.js';
import { createMemoryServiceStore } from '../src/discovery/store.js';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { mockFacilitator } from '../src/commerce/simulation.js';
import { createMockChainVerifier, startX402ResourceServer } from '../src/x402/resourceServer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const CARD_URL = 'https://api.sabokun.my.id/.well-known/agent-card.json';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

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

const trustedVerifier = async () => ({ decision: 'TRUSTED' as const, reason: 'test stub' });
const rejectedVerifier = async () => ({ decision: 'REJECTED' as const, reason: 'owner mismatch (stub)' });
const inconclusiveVerifier = async () => ({ decision: 'INCONCLUSIVE' as const, reason: 'card fetch failed (stub)' });

type Registry = ReturnType<typeof createServiceRegistry>;
type Store = ReturnType<typeof createMemoryServiceStore>;

function registerOk(registry: Registry, over: Record<string, unknown> = {}) {
  const r = registry.register(validInput(over) as never);
  if (!r.ok) throw new Error(`registration failed unexpectedly: ${r.errors.join('; ')}`);
  return r.service;
}

async function registerActive(registry: Registry, over: Record<string, unknown> = {}) {
  const service = registerOk(registry, over);
  const verified = await registry.verifyProvider(service.id, trustedVerifier);
  if (!verified.ok) throw new Error(`verify failed: ${verified.error}`);
  const activated = registry.setStatus(service.id, 'active');
  if (!activated.ok) throw new Error(`activate failed: ${activated.error}`);
  return activated.service;
}

function discoveryCall(registry: Registry, method: string, url: string) {
  const req = { method, url } as Parameters<typeof handleDiscoveryRequest>[1];
  const result = handleDiscoveryRequest(registry, req);
  if (result === null) throw new Error(`not a discovery route: ${method} ${url}`);
  return result;
}

function listTotal(registry: Registry, url = '/api/services'): number {
  return (discoveryCall(registry, 'GET', url).body as Record<string, unknown>)['total'] as number;
}

function listIds(registry: Registry, url = '/api/services'): string[] {
  const services = (discoveryCall(registry, 'GET', url).body as Record<string, unknown>)['services'] as Array<Record<string, unknown>>;
  return services.map(s => s['id'] as string);
}

/**
 * Build a legacy pre-policy row: a service stored 'active' whose
 * provider verification is NOT TRUSTED. No registry API can create this
 * state anymore, so the stored status is flipped directly on the store
 * — exactly what a row written before the activation policy looks like.
 * `verification` selects the evidence state:
 *   'registered'   — never verified (the fresh-registration state).
 *   'rejected'     — verified and contradicted (via verifyProvider).
 *   'inconclusive' — verification ran but could not establish evidence.
 *   null           — the verification evidence is missing/null (a
 *                    corrupted or hand-written row).
 */
async function makeLegacyRow(store: Store, registry: Registry, id: string, verification: 'registered' | 'rejected' | 'inconclusive' | null) {
  registerOk(registry, { id });
  if (verification === 'rejected') {
    const r = await registry.verifyProvider(id, rejectedVerifier);
    if (!r.ok) throw new Error(`verify failed: ${r.error}`);
  } else if (verification === 'inconclusive') {
    const r = await registry.verifyProvider(id, inconclusiveVerifier);
    if (!r.ok) throw new Error(`verify failed: ${r.error}`);
  }
  const record = store.get(id)!;
  if (verification === null) {
    (record as unknown as { providerVerification: unknown }).providerVerification = null;
  }
  record.status = 'active';
  store.update(record);
  const stored = registry.get(id)!;
  eq(stored.status, 'active', 'legacy row is stored active');
  return stored;
}

function assertNotDiscoverable(registry: Registry, id: string, label: string) {
  const stored = registry.get(id)!;
  eq(stored.status, 'active', `${label}: stored status is still active (read must not change it)`);
  notOk(isDiscoverable(stored), `${label}: isDiscoverable is false`);
  notOk(listIds(registry).includes(id), `${label}: not in the default (active) list`);
  notOk(listIds(registry, '/api/services?status=active').includes(id), `${label}: not in the ?status=active list`);
  // It IS visible under status=all / status=inactive (as an inactive
  // service), so the operator can still find and fix it.
  ok(listIds(registry, '/api/services?status=all').includes(id), `${label}: visible under status=all`);
  ok(listIds(registry, '/api/services?status=inactive').includes(id), `${label}: visible under status=inactive`);
  const view = toServiceView(stored);
  eq(view['status'], 'inactive', `${label}: the view never shows it as active`);
  eq(view['available'], false, `${label}: not available`);
  eq(view['paymentRequirements'], undefined, `${label}: no payment requirements`);
  const detail = discoveryCall(registry, 'GET', `/api/services/${id}`);
  eq(detail.status, 200, `${label}: detail returns 200 (the service exists)`);
  const detailBody = detail.body as Record<string, unknown>;
  eq(detailBody['status'], 'inactive', `${label}: detail does not reveal an active service`);
  eq(detailBody['available'], false, `${label}: detail is not available`);
  eq(detailBody['paymentRequirements'], undefined, `${label}: detail has no payment requirements`);
}

// ─── 1. Legacy active + unverified ────────────────────────────────────────

test('1. legacy active + unverified (registered, never verified) → not discoverable', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-unverified', 'registered');
  assertNotDiscoverable(registry, 'svc_legacy-unverified', 'legacy unverified');
  registry.close();
});

// ─── 2. Legacy active + rejected ──────────────────────────────────────────

test('2. legacy active + rejected → not discoverable', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-rejected', 'rejected');
  assertNotDiscoverable(registry, 'svc_legacy-rejected', 'legacy rejected');
  registry.close();
});

// ─── 3. Legacy active + inconclusive ──────────────────────────────────────

test('3. legacy active + inconclusive → not discoverable', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-inconclusive', 'inconclusive');
  assertNotDiscoverable(registry, 'svc_legacy-inconclusive', 'legacy inconclusive');
  registry.close();
});

// ─── 4. Legacy active + verification evidence missing/null ────────────────

test('4. legacy active + verification evidence missing/null → not discoverable (and it must not throw)', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-nulled', null);
  // isDiscoverable must fail closed, not throw, on a null verification.
  const stored = registry.get('svc_legacy-nulled')!;
  eq(stored.providerVerification, null, 'verification evidence is null in the stored row');
  notOk(isDiscoverable(stored), 'null verification is not discoverable');
  // The list and detail calls must not throw either.
  eq(listTotal(registry), 0, 'not in the default list');
  const detail = discoveryCall(registry, 'GET', '/api/services/svc_legacy-nulled');
  eq(detail.status, 200, 'detail returns 200');
  const body = detail.body as Record<string, unknown>;
  eq(body['status'], 'inactive', 'detail does not reveal an active service');
  eq(body['available'], false, 'detail is not available');
  eq(body['paymentRequirements'], undefined, 'detail has no payment requirements');
  registry.close();
});

// ─── 5. Detail endpoint (dedicated) ───────────────────────────────────────

test('5. detail endpoint for a legacy provider → no active service, no payment requirements', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-detail', 'rejected');
  // Also register a good service, so the detail response is checked
  // against a real discoverable service in the same registry.
  await registerActive(registry, { id: 'svc_good' });
  const bad = discoveryCall(registry, 'GET', '/api/services/svc_legacy-detail');
  const badBody = bad.body as Record<string, unknown>;
  eq(badBody['status'], 'inactive', 'legacy detail: status is inactive');
  eq(badBody['available'], false, 'legacy detail: not available');
  eq(badBody['paymentRequirements'], undefined, 'legacy detail: no payment requirements');
  const good = discoveryCall(registry, 'GET', '/api/services/svc_good');
  const goodBody = good.body as Record<string, unknown>;
  eq(goodBody['status'], 'active', 'good detail: status is active');
  eq(goodBody['available'], true, 'good detail: available');
  ok(goodBody['paymentRequirements'] !== undefined, 'good detail: payment requirements present');
  registry.close();
});

// ─── 6. Active + verified → still discoverable ────────────────────────────

test('6. active + verified → still discoverable', async () => {
  const registry = createServiceRegistry();
  const service = await registerActive(registry);
  ok(isDiscoverable(service), 'discoverable');
  eq(listTotal(registry), 1, 'in the default list');
  const detail = discoveryCall(registry, 'GET', `/api/services/${service.id}`);
  const body = detail.body as Record<string, unknown>;
  eq(body['status'], 'active', 'detail: active');
  eq(body['available'], true, 'detail: available');
  ok(body['paymentRequirements'] !== undefined, 'detail: payment requirements present');
  registry.close();
});

// ─── 7. Inactive + verified → still not discoverable ──────────────────────

test('7. inactive + verified → still not discoverable', async () => {
  const registry = createServiceRegistry();
  const service = registerOk(registry);
  const verified = await registry.verifyProvider(service.id, trustedVerifier);
  ok(verified.ok, 'verify runs');
  eq(verified.service.providerVerification.status, 'verified', 'verified');
  eq(verified.service.status, 'inactive', 'but still inactive');
  notOk(isDiscoverable(verified.service), 'not discoverable (inactive beats verified)');
  eq(listTotal(registry), 0, 'not in the default list');
  const detail = discoveryCall(registry, 'GET', `/api/services/${service.id}`);
  const body = detail.body as Record<string, unknown>;
  eq(body['status'], 'inactive', 'detail: inactive');
  eq(body['available'], false, 'detail: not available');
  eq(body['paymentRequirements'], undefined, 'detail: no payment requirements');
  registry.close();
});

// ─── 8. The database row is unchanged after Discovery requests ────────────

test('8. the database row is unchanged after Discovery requests', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  await makeLegacyRow(store, registry, 'svc_legacy-frozen', 'rejected');
  const good = await registerActive(registry, { id: 'svc_good-frozen' });
  const beforeLegacy = JSON.stringify(store.get('svc_legacy-frozen'));
  const beforeGood = JSON.stringify(store.get('svc_good-frozen'));
  // A burst of Discovery reads: list (all filters), detail (both
  // services), and the search/category filters.
  discoveryCall(registry, 'GET', '/api/services');
  discoveryCall(registry, 'GET', '/api/services?status=all');
  discoveryCall(registry, 'GET', '/api/services?status=active');
  discoveryCall(registry, 'GET', '/api/services?status=inactive');
  discoveryCall(registry, 'GET', '/api/services?category=data');
  discoveryCall(registry, 'GET', '/api/services?q=price');
  discoveryCall(registry, 'GET', '/api/services/svc_legacy-frozen');
  discoveryCall(registry, 'GET', `/api/services/${good.id}`);
  discoveryCall(registry, 'GET', '/api/services/svc_doesnotexist');
  eq(JSON.stringify(store.get('svc_legacy-frozen')), beforeLegacy, 'legacy row byte-identical after reads');
  eq(JSON.stringify(store.get('svc_good-frozen')), beforeGood, 'good row byte-identical after reads');
  eq(registry.get('svc_legacy-frozen')!.status, 'active', 'legacy row is still stored active');
  registry.close();
});

// ─── 9. No regression: onboarding + activation policy + x402 server ───────

test('9. no regression: onboarding, activation policy, and the x402 resource server still work end-to-end', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  // Onboard TRUSTED → active + discoverable (onboarding still works).
  const onboarded = await onboardProvider(registry, validInput({ id: 'svc_regression-onboard' }) as never, trustedVerifier);
  ok(onboarded.ok && onboarded.activated, 'onboard TRUSTED activates');
  ok(isDiscoverable(onboarded.service!), 'onboarded service is discoverable');
  // Onboard REJECTED → inactive, not discoverable.
  const failed = await onboardProvider(registry, validInput({ id: 'svc_regression-onboard-fail' }) as never, rejectedVerifier);
  ok(failed.ok && !failed.activated, 'onboard REJECTED does not activate');
  notOk(isDiscoverable(failed.service!), 'failed onboard is not discoverable');
  // Activation policy still holds: setStatus('active') on the failed
  // service is refused.
  const refused = registry.setStatus('svc_regression-onboard-fail', 'active');
  notOk(refused.ok, 'activation policy still refuses an unverified service');
  // A legacy row next to them is hidden, not deleted.
  await makeLegacyRow(store, registry, 'svc_regression-legacy', 'rejected');
  eq(listTotal(registry), 1, 'only the onboarded service is in the default list');
  eq(listIds(registry, '/api/services?status=all').length, 3, 'all three are visible under status=all');

  // The x402 resource server with this registry mounted: Discovery over
  // HTTP (mock facilitator) + the 402 challenge still work.
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
  const resourceUrl = `http://127.0.0.1:${port}/protected`;
  const requirements = buildPaymentRequirements({ payTo: RECIPIENT, amountMicroCcd: '1', maxTimeoutSeconds: 300, resourceUrl, feePayer: SPONSOR, network: CAIP2 });
  const provider = createX402Provider(
    { requirements, resourceUrl, resource: { body: 'PROTECTED-CONTENT', url: resourceUrl } },
    { facilitator: mockFacilitator('ok'), chain: createMockChainVerifier() },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore() },
  );
  const started = await startX402ResourceServer({ provider, resourcePath: '/protected', host: '127.0.0.1', port, discovery: registry });
  try {
    const listRes = await fetch(`${started.url}/api/services`);
    eq(listRes.status, 200, 'HTTP Discovery list is 200');
    const listBody = (await listRes.json()) as Record<string, unknown>;
    eq(listBody['total'], 1, 'HTTP list shows only the discoverable service');
    const legacyDetail = await fetch(`${started.url}/api/services/svc_regression-legacy`);
    eq(legacyDetail.status, 200, 'HTTP legacy detail is 200');
    const legacyBody = (await legacyDetail.json()) as Record<string, unknown>;
    eq(legacyBody['status'], 'inactive', 'HTTP legacy detail is not active');
    eq(legacyBody['paymentRequirements'], undefined, 'HTTP legacy detail has no payment requirements');
    const challenge = await fetch(`${started.url}/protected`);
    eq(challenge.status, 402, 'the 402 challenge still works');
    const challengeBody = (await challenge.json()) as Record<string, unknown>;
    eq(challengeBody['x402Version'], 2, '402 version');
  } finally {
    await started.close();
  }
  registry.close();
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
console.log(`\ndiscovery-read-path-fail-closed: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
