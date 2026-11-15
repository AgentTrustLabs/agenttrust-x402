/**
 * Provider onboarding — regression tests.
 *
 * Covers `onboardProvider` (src/discovery/onboarding.ts) and the
 * `agenttrust-discovery onboard` CLI command: the single, controlled path
 * that takes a provider submission from input to a discoverable service.
 *
 * The fixture provider (test/fixtures/discovery/fixture-provider.json)
 * is EXPLICITLY a test fixture — tokenId 999999 does not exist on the
 * Concordium registry, its endpoint and Agent Card URL are .example
 * addresses that resolve nowhere, and it must never be presented as a
 * real provider. In these tests its identity is "verified" only by a
 * stub verifier that simulates the production verifier's verdicts; the
 * production verifier itself is exercised by the CLI subprocess test,
 * where it correctly refuses to verify the fixture (INCONCLUSIVE).
 *
 *   1. Success: fixture + TRUSTED stub → verified, active, discoverable
 *      via the Discovery API, paymentRequirements present.
 *   2. Success end-to-end over HTTP: the onboarded service is listed by
 *      a real server's GET /api/services.
 *   3. Failed identity (REJECTED): registered but inactive, not in the
 *      default Discovery list, no paymentRequirements.
 *   4. Invalid Agent Card (INCONCLUSIVE): unverified, inactive, not
 *      discoverable.
 *   5. No Agent Card (agentUri null): the verifier is never called,
 *      unverified, inactive.
 *   6. Duplicate data: re-onboarding the same fixture is idempotent
 *      (already onboarded, one row); the same id with different content
 *      is a conflict and the original is untouched.
 *   7. Incomplete input: missing/invalid fields are rejected and
 *      nothing is registered.
 *   8. Retry after failure: REJECTED then TRUSTED → first inactive,
 *      second verified + active.
 *   9. Fail-closed deactivation: a service made active by the plain
 *      `register` command (unverified) is deactivated by an onboard
 *      attempt whose verification fails.
 *  10. The input `status` field cannot smuggle an active service past
 *      verification: onboard with status 'active' + REJECTED still
 *      leaves the service inactive.
 *  11. CLI subprocess: `onboard` with the fixture + the production
 *      verifier completes (exit 0) but does NOT activate — the fixture
 *      cannot be verified on-chain, so it stays inactive (fail-closed).
 *
 * Offline except test 11, which runs the production verifier against
 * the real registry MCP (it returns INCONCLUSIVE for the fake tokenId
 * whether or not the network is reachable). No signing, no settlement,
 * no broadcast, no CCD spend, no real provider is created anywhere.
 *
 * Run with: npm test  (tsx)
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk, throws } from './helpers.mjs';
import { createServiceRegistry, toServiceView } from '../src/discovery/registry.js';
import { handleDiscoveryRequest } from '../src/discovery/http.js';
import { onboardProvider } from '../src/discovery/onboarding.js';
import { SqliteServiceStore, createMemoryServiceStore } from '../src/discovery/store.js';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { mockFacilitator } from '../src/commerce/simulation.js';
import { createMockChainVerifier, startX402ResourceServer } from '../src/x402/resourceServer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RESOURCE_PATH = '/protected';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ─── the fixture ────────────────────────────────────────────────────────────

/** The fixture provider input, read from the JSON fixture file (the source of truth). */
function fixtureInput(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/discovery/fixture-provider.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  ok(raw['fixture'] === true, 'the fixture file is marked as a fixture');
  const { fixture: _fixture, note: _note, ...input } = raw;
  return input;
}

function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixtureInput())) as Record<string, unknown>;
}

// ─── stub verifiers (simulate the production verifier's verdicts) ──────────

const trustedVerifier = async () => ({ decision: 'TRUSTED' as const, reason: 'fixture card verified (stub)' });
const rejectedVerifier = async () => ({ decision: 'REJECTED' as const, reason: 'owner mismatch (stub)' });
const inconclusiveVerifier = async () => ({ decision: 'INCONCLUSIVE' as const, reason: 'card fetch failed (stub)' });

// ─── Discovery API helpers ──────────────────────────────────────────────────

/** Call the Discovery HTTP handler directly (no socket). */
function discoveryCall(registry: ReturnType<typeof createServiceRegistry>, method: string, url: string) {
  const req = { method, url } as Parameters<typeof handleDiscoveryRequest>[1];
  const result = handleDiscoveryRequest(registry, req);
  if (result === null) throw new Error(`not a discovery route: ${method} ${url}`);
  return result;
}

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

// ─── 1. Success ─────────────────────────────────────────────────────────────

test('success: fixture + TRUSTED → verified, active, discoverable, payable', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(result.ok, 'onboarding completed');
  ok(result.activated, 'service activated');
  eq(result.verification?.status, 'verified', 'verification verified');
  eq(result.service?.status, 'active', 'service active');
  eq(result.service?.id, 'svc_fixture-provider', 'the fixture id is used');
  eq(registry.size(), 1, 'one service registered');

  // Discoverable via the Discovery API (list + detail), with payment requirements.
  const list = discoveryCall(registry, 'GET', '/api/services');
  eq(list.status, 200, 'list status');
  const listBody = list.body as Record<string, unknown>;
  eq(listBody['total'], 1, 'one service in the default (active) list');
  const services = listBody['services'] as Array<Record<string, unknown>>;
  eq(services[0]?.['id'], 'svc_fixture-provider', 'the onboarded service is listed');
  ok(services[0]?.['paymentRequirements'] !== undefined, 'paymentRequirements offered for an active service');

  const detail = discoveryCall(registry, 'GET', '/api/services/svc_fixture-provider');
  eq(detail.status, 200, 'detail status');
  const detailBody = detail.body as Record<string, unknown>;
  eq(detailBody['id'], 'svc_fixture-provider', 'detail returns the service');
  eq((detailBody['providerVerification'] as Record<string, unknown>)['status'], 'verified', 'detail shows verified');
  registry.close();
});

// ─── 2. Success end-to-end over HTTP ────────────────────────────────────────

test('success over HTTP: a real server lists the onboarded service at GET /api/services', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(result.activated, 'onboarded and activated');

  // A real HTTP server with the onboarded registry mounted (mock payment
  // layer — the point here is Discovery, not payment).
  const port = await freePort();
  const resourceUrl = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
  const requirements = buildPaymentRequirements({ payTo: RECIPIENT, amountMicroCcd: '1', resourceUrl, network: CAIP2, maxTimeoutSeconds: 300 });
  const provider = createX402Provider(
    { requirements, resourceUrl, resource: { body: 'PROTECTED-CONTENT', url: resourceUrl } },
    { facilitator: mockFacilitator('ok'), chain: createMockChainVerifier() },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore() },
  );
  const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host: '127.0.0.1', port, discovery: registry });
  try {
    const res = await fetch(`${started.url}/api/services`);
    eq(res.status, 200, 'GET /api/services status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['total'], 1, 'one service listed over HTTP');
    const services = body['services'] as Array<Record<string, unknown>>;
    eq(services[0]?.['id'], 'svc_fixture-provider', 'the onboarded service is discoverable over HTTP');
    eq(services[0]?.['name'], 'Fixture Provider — Test Only', 'the fixture name is served');
  } finally {
    await started.close();
    registry.close();
  }
});

// ─── 3. Failed identity (REJECTED) ──────────────────────────────────────────

test('failed identity: REJECTED → registered but inactive, not discoverable, not payable', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, fixture() as never, rejectedVerifier);
  ok(result.ok, 'onboarding completed (a rejection is an outcome, not a command failure)');
  notOk(result.activated, 'service NOT activated');
  eq(result.verification?.status, 'rejected', 'verification rejected');
  eq(result.service?.status, 'inactive', 'service inactive');
  eq(registry.size(), 1, 'the service is still registered (for audit/retry)');

  const list = discoveryCall(registry, 'GET', '/api/services');
  eq((list.body as Record<string, unknown>)['total'], 0, 'not in the default (active) list');
  const listAll = discoveryCall(registry, 'GET', '/api/services?status=all');
  eq((listAll.body as Record<string, unknown>)['total'], 1, 'visible only with status=all');
  const view = toServiceView(result.service!);
  ok(view.paymentRequirements === undefined, 'no paymentRequirements for an inactive service');
  ok(!view.available, 'not available');
  registry.close();
});

// ─── 4. Invalid Agent Card (INCONCLUSIVE) ───────────────────────────────────

test('invalid Agent Card: INCONCLUSIVE → unverified, inactive, not discoverable', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, fixture() as never, inconclusiveVerifier);
  ok(result.ok, 'onboarding completed');
  notOk(result.activated, 'service NOT activated');
  eq(result.verification?.status, 'unverified', 'verification unverified (inconclusive)');
  eq(result.service?.status, 'inactive', 'service inactive');
  const list = discoveryCall(registry, 'GET', '/api/services');
  eq((list.body as Record<string, unknown>)['total'], 0, 'not in the default list');
  registry.close();
});

// ─── 5. No Agent Card ───────────────────────────────────────────────────────

test('no Agent Card: agentUri null → the verifier is never called, unverified, inactive', async () => {
  const registry = createServiceRegistry();
  let verifierCalled = false;
  const recordingVerifier = async () => {
    verifierCalled = true;
    return { decision: 'TRUSTED' as const, reason: 'would-be TRUSTED (stub)' };
  };
  const input = fixture();
  (input['provider'] as Record<string, unknown>)['agentUri'] = null;
  const result = await onboardProvider(registry, input as never, recordingVerifier);
  ok(result.ok, 'onboarding completed');
  notOk(verifierCalled, 'the verifier was never called — there is no card to verify');
  notOk(result.activated, 'service NOT activated');
  eq(result.verification?.status, 'unverified', 'verification unverified');
  eq(result.service?.status, 'inactive', 'service inactive');
  registry.close();
});

// ─── 6. Duplicate data ──────────────────────────────────────────────────────

test('duplicate data: re-onboarding the same fixture is idempotent (already onboarded, one row)', async () => {
  const registry = createServiceRegistry();
  const first = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(first.activated, 'first onboard activated');
  eq(registry.size(), 1, 'one row after the first onboard');

  const second = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(second.ok, 'second onboard completed');
  ok(second.activated, 'second onboard reports activated');
  eq(second.service?.id, 'svc_fixture-provider', 'same id');
  eq(second.reason, 'already onboarded: provider verified and service active', 'idempotent reason');
  eq(registry.size(), 1, 'still one row — no duplicate');
  registry.close();
});

test('duplicate data: the same id with different content is a conflict, original untouched', async () => {
  const registry = createServiceRegistry();
  const first = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(first.activated, 'first onboard activated');

  const conflicting = fixture();
  conflicting['endpoint'] = 'https://fixture.example.com/other-service';
  const second = await onboardProvider(registry, conflicting as never, trustedVerifier);
  notOk(second.ok, 'conflicting onboard is rejected');
  ok((second.errors ?? []).some(e => e.includes('already exists')), 'error names the duplicate');
  eq(registry.size(), 1, 'still one row');
  eq(registry.get('svc_fixture-provider')?.endpoint, 'https://fixture.example.com/service', 'original content untouched');
  eq(registry.get('svc_fixture-provider')?.status, 'active', 'original still active');
  registry.close();
});

// ─── 7. Incomplete input ────────────────────────────────────────────────────

test('incomplete input: missing/invalid fields are rejected and nothing is registered', async () => {
  const cases: Array<[string, (input: Record<string, unknown>) => void, string]> = [
    ['missing name', i => { delete i['name']; }, 'name'],
    ['missing endpoint', i => { delete i['endpoint']; }, 'endpoint'],
    ['invalid category', i => { i['category'] = 'not-a-category'; }, 'category'],
    ['invalid payTo', i => { (i['pricing'] as Record<string, unknown>)['payTo'] = 'not-an-account'; }, 'payTo'],
    ['zero amount', i => { (i['pricing'] as Record<string, unknown>)['amountMicroCcd'] = '0'; }, 'amount'],
    ['missing agentUri field', i => { delete (i['provider'] as Record<string, unknown>)['agentUri']; }, 'agentUri'],
  ];
  for (const [label, mutate, field] of cases) {
    const registry = createServiceRegistry();
    const input = fixture();
    mutate(input);
    const result = await onboardProvider(registry, input as never, trustedVerifier);
    notOk(result.ok, `${label}: onboarding rejected`);
    ok((result.errors ?? []).some(e => e.toLowerCase().includes(field.toLowerCase())), `${label}: error names the field`);
    eq(registry.size(), 0, `${label}: nothing registered`);
    registry.close();
  }
});

// ─── 8. Retry after failure ─────────────────────────────────────────────────

test('retry after failure: REJECTED then TRUSTED → first inactive, second verified + active', async () => {
  const registry = createServiceRegistry();
  const first = await onboardProvider(registry, fixture() as never, rejectedVerifier);
  notOk(first.activated, 'first attempt not activated');
  eq(first.verification?.status, 'rejected', 'first verification rejected');

  const second = await onboardProvider(registry, fixture() as never, trustedVerifier);
  ok(second.ok, 'retry completed');
  ok(second.activated, 'retry activated');
  eq(second.verification?.status, 'verified', 'retry verification verified');
  eq(registry.size(), 1, 'still one row');
  registry.close();
});

// ─── 9. Fail-closed deactivation ────────────────────────────────────────────

test('fail-closed: onboarding deactivates a legacy active + unverified service (pre-policy row)', async () => {
  // Simulate a pre-policy database row: a service that is active but
  // was never verified. No registry API can create this state anymore
  // (register always creates inactive, setStatus refuses unverified
  // activation), so the stored status is flipped directly, bypassing
  // the registry guard — exactly what a pre-policy row looks like.
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);
  const registered = registry.register(fixture() as never);
  ok(registered.ok, 'register ok');
  const record = store.get('svc_fixture-provider')!;
  record.status = 'active';
  store.update(record);
  eq(registry.get('svc_fixture-provider')?.status, 'active', 'legacy row is active + unverified');
  eq(registry.get('svc_fixture-provider')?.providerVerification.status, 'registered', 'never verified');

  const result = await onboardProvider(registry, fixture() as never, rejectedVerifier);
  ok(result.ok, 'onboarding completed');
  notOk(result.activated, 'not activated');
  eq(registry.get('svc_fixture-provider')?.status, 'inactive', 'onboarding deactivated the unverified service');
  const list = discoveryCall(registry, 'GET', '/api/services');
  eq((list.body as Record<string, unknown>)['total'], 0, 'no longer in the default list');
  registry.close();
});

// ─── 10. A smuggled status value cannot bypass verification ─────────────
// The registration input has no status field anymore, but a caller
// built from an old client (or a hand-built object) might still carry
// `status: 'active'`. The registry never reads it: the service is
// created inactive regardless.
test('smuggled status is ignored: onboard with status active + REJECTED still leaves the service inactive', async () => {
  const registry = createServiceRegistry();
  const input = fixture();
  input['status'] = 'active';
  const result = await onboardProvider(registry, input as never, rejectedVerifier);
  ok(result.ok, 'onboarding completed');
  notOk(result.activated, 'not activated');
  eq(result.service?.status, 'inactive', 'the service is inactive despite status: active in the input');
  registry.close();
});

// ─── 11. CLI subprocess (production verifier, fail-closed) ──────────────────

const CLI = new URL('../src/cli/discovery.ts', import.meta.url).pathname;

function runCli(args: string[], db: string) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args, '--db', db], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fixtureCliArgs(input: Record<string, unknown>): string[] {
  const provider = input['provider'] as Record<string, unknown>;
  const pricing = input['pricing'] as Record<string, unknown>;
  return [
    'onboard',
    '--name', String(input['name']),
    '--description', String(input['description']),
    '--category', String(input['category']),
    '--endpoint', String(input['endpoint']),
    '--token-id', String(provider['tokenId']),
    '--owner', String(provider['ownerAccount']),
    '--agent-uri', String(provider['agentUri']),
    '--amount', String(pricing['amountMicroCcd']),
    '--pay-to', String(pricing['payTo']),
    '--id', String(input['id']),
    '--timeout-ms', '15000',
  ];
}

test('CLI: onboard with the fixture + production verifier completes but does NOT activate (fail-closed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-cli-'));
  const db = join(dir, 'discovery.db');
  try {
    // The fixture tokenId (999999) does not exist on the Concordium
    // registry, so the production verifier returns INCONCLUSIVE whether
    // or not the network is reachable. The service must stay inactive.
    const r = runCli(fixtureCliArgs(fixture()), db);
    eq(r.status, 0, `CLI exits 0 (the flow completed) — stderr: ${r.stderr.slice(0, 300)}`);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    eq(out['id'], 'svc_fixture-provider', 'the fixture id');
    eq(out['onboarded'], false, 'not onboarded (not activated)');
    eq((out['verification'] as Record<string, unknown>)['status'], 'unverified', 'verification unverified');
    eq(out['status'], 'inactive', 'service inactive');

    const shown = runCli(['show', '--id', 'svc_fixture-provider'], db);
    eq(shown.status, 0, 'show succeeds');
    const shownOut = JSON.parse(shown.stdout) as Record<string, unknown>;
    eq(shownOut['status'], 'inactive', 'show confirms inactive');
    eq((shownOut['providerVerification'] as Record<string, unknown>)['status'], 'unverified', 'show confirms unverified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
console.log(`\nprovider-onboarding: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
