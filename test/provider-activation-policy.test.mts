/**
 * Provider activation policy — regression tests.
 *
 * The invariant: a service is 'active' ONLY while its provider
 * verification is TRUSTED (`providerVerification.status === 'verified'`).
 * No path — register, activate, onboard, verify, or the HTTP API — may
 * leave an unverified provider active or discoverable.
 *
 * Mandatory cases (from the brief):
 *   1. Register without status → INACTIVE.
 *   2. Register with a smuggled input status ACTIVE → still INACTIVE
 *      (the registration input has no status field; the registry never
 *      reads one).
 *   3. Activate UNVERIFIED provider → rejected.
 *   4. Activate REJECTED provider → rejected.
 *   5. Activate INCONCLUSIVE provider → rejected.
 *   6. Activate TRUSTED provider → succeeds.
 *   7. Onboard TRUSTED → active and discoverable.
 *   8. Onboard fails → stays INACTIVE.
 *   9. Re-onboard idempotent still works.
 *  10. No other path can bypass verification — an audit that tries
 *      every mutation path (register, setStatus, onboard, verify,
 *      a legacy pre-policy row, the HTTP API) and proves none of them
 *      can make an unverified provider active.
 *  11. Re-verification that stops being TRUSTED deactivates an active
 *      service (the invariant is maintained when evidence changes).
 *  12. CLI: `activate` on an unverified service exits 1; `activate` on
 *      a verified service (seeded via the library) exits 0.
 *
 * Offline (stub verifiers only; the CLI test seeds its DB via the
 * library, so no production verifier is involved). No signing, no
 * settlement, no broadcast, no CCD spend, no real provider is created.
 *
 * Run with: npm test  (tsx)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import { createServiceRegistry, toServiceView } from '../src/discovery/registry.js';
import { handleDiscoveryRequest } from '../src/discovery/http.js';
import { onboardProvider } from '../src/discovery/onboarding.js';
import { SqliteServiceStore, type ServiceStore } from '../src/discovery/store.js';
import { createMemoryServiceStore } from '../src/discovery/memoryStore.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const CARD_URL = 'https://api.sabokun.my.id/.well-known/agent-card.json';

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

function registerOk(registry: ReturnType<typeof createServiceRegistry>, over: Record<string, unknown> = {}) {
  const r = registry.register(validInput(over) as never);
  if (!r.ok) throw new Error(`registration failed unexpectedly: ${r.errors.join('; ')}`);
  return r.service;
}

async function registerActive(registry: ReturnType<typeof createServiceRegistry>, over: Record<string, unknown> = {}) {
  const service = registerOk(registry, over);
  const verified = await registry.verifyProvider(service.id, trustedVerifier);
  if (!verified.ok) throw new Error(`verify failed: ${verified.error}`);
  const activated = registry.setStatus(service.id, 'active');
  if (!activated.ok) throw new Error(`activate failed: ${activated.error}`);
  return activated.service;
}

function discoveryCall(registry: ReturnType<typeof createServiceRegistry>, method: string, url: string) {
  const req = { method, url } as Parameters<typeof handleDiscoveryRequest>[1];
  const result = handleDiscoveryRequest(registry, req);
  if (result === null) throw new Error(`not a discovery route: ${method} ${url}`);
  return result;
}

// ─── 1. Register without status → INACTIVE ────────────────────────────────

test('1. register without status → INACTIVE', () => {
  const registry = createServiceRegistry();
  const service = registerOk(registry);
  eq(service.status, 'inactive', 'registration always creates an inactive service');
  eq(service.providerVerification.status, 'registered', 'never verified');
  const list = discoveryCall(registry, 'GET', '/api/services');
  eq((list.body as Record<string, unknown>)['total'], 0, 'not in the default (active) Discovery list');
  registry.close();
});

// ─── 2. Smuggled status ACTIVE → still INACTIVE ───────────────────────────

test('2. register with a smuggled input status ACTIVE → still INACTIVE', () => {
  const registry = createServiceRegistry();
  // The registration input has no status field. A caller built from an
  // old client (or a hand-built object) might still carry one; the
  // registry never reads it.
  const service = registerOk(registry, { status: 'active' });
  eq(service.status, 'inactive', 'the smuggled status value is ignored');
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 0, 'not discoverable');
  registry.close();
});

// ─── 3. Activate UNVERIFIED → rejected ────────────────────────────────────

test('3. activate UNVERIFIED provider (never verified) → rejected', () => {
  const registry = createServiceRegistry();
  const service = registerOk(registry);
  eq(service.providerVerification.status, 'registered', 'never verified');
  const result = registry.setStatus(service.id, 'active');
  notOk(result.ok, 'activation refused');
  if (!result.ok) {
    ok(result.error.includes('not TRUSTED'), 'error names the guard');
    ok(result.error.includes('registered'), 'error names the verification status');
  }
  eq(registry.get(service.id)?.status, 'inactive', 'still inactive');
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 0, 'not discoverable');
  registry.close();
});

// ─── 4. Activate REJECTED → rejected ──────────────────────────────────────

test('4. activate REJECTED provider → rejected', async () => {
  const registry = createServiceRegistry();
  const service = registerOk(registry);
  const verified = await registry.verifyProvider(service.id, rejectedVerifier);
  ok(verified.ok, 'verify runs');
  eq(verified.service.providerVerification.status, 'rejected', 'verification rejected');
  const result = registry.setStatus(service.id, 'active');
  notOk(result.ok, 'activation refused');
  if (!result.ok) ok(result.error.includes('rejected'), 'error names the rejected status');
  eq(registry.get(service.id)?.status, 'inactive', 'still inactive');
  registry.close();
});

// ─── 5. Activate INCONCLUSIVE → rejected ──────────────────────────────────

test('5. activate INCONCLUSIVE provider → rejected', async () => {
  const registry = createServiceRegistry();
  const service = registerOk(registry);
  const verified = await registry.verifyProvider(service.id, inconclusiveVerifier);
  ok(verified.ok, 'verify runs');
  eq(verified.service.providerVerification.status, 'unverified', 'verification unverified (inconclusive)');
  const result = registry.setStatus(service.id, 'active');
  notOk(result.ok, 'activation refused');
  if (!result.ok) ok(result.error.includes('unverified'), 'error names the unverified status');
  eq(registry.get(service.id)?.status, 'inactive', 'still inactive');
  registry.close();
});

// ─── 6. Activate TRUSTED → succeeds ───────────────────────────────────────

test('6. activate TRUSTED provider → succeeds, active and discoverable', async () => {
  const registry = createServiceRegistry();
  const service = await registerActive(registry);
  eq(service.status, 'active', 'active');
  eq(service.providerVerification.status, 'verified', 'verified');
  const list = discoveryCall(registry, 'GET', '/api/services');
  eq((list.body as Record<string, unknown>)['total'], 1, 'discoverable in the default list');
  const view = toServiceView(service);
  ok(view.paymentRequirements !== undefined, 'payment requirements offered');
  ok(view.available, 'available');
  registry.close();
});

// ─── 7. Onboard TRUSTED → active and discoverable ─────────────────────────

test('7. onboard TRUSTED → active and discoverable', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, validInput({ id: 'svc_policy-onboard' }) as never, trustedVerifier);
  ok(result.ok, 'onboarding completed');
  ok(result.activated, 'activated');
  eq(result.service?.status, 'active', 'active');
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 1, 'discoverable');
  registry.close();
});

// ─── 8. Onboard fails → stays INACTIVE ────────────────────────────────────

test('8. onboard fails (REJECTED) → stays INACTIVE, not discoverable', async () => {
  const registry = createServiceRegistry();
  const result = await onboardProvider(registry, validInput({ id: 'svc_policy-onboard-fail' }) as never, rejectedVerifier);
  ok(result.ok, 'onboarding completed (a rejection is an outcome, not a failure)');
  notOk(result.activated, 'not activated');
  eq(result.service?.status, 'inactive', 'inactive');
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 0, 'not discoverable');
  registry.close();
});

// ─── 9. Re-onboard idempotent ─────────────────────────────────────────────

test('9. re-onboard idempotent still works', async () => {
  const registry = createServiceRegistry();
  const first = await onboardProvider(registry, validInput({ id: 'svc_policy-reonboard' }) as never, trustedVerifier);
  ok(first.activated, 'first onboard activated');
  eq(registry.size(), 1, 'one row');
  const second = await onboardProvider(registry, validInput({ id: 'svc_policy-reonboard' }) as never, trustedVerifier);
  ok(second.ok, 'second onboard completed');
  ok(second.activated, 'still activated');
  eq(second.reason, 'already onboarded: provider verified and service active', 'idempotent reason');
  eq(registry.size(), 1, 'still one row');
  registry.close();
});

// ─── 10. No bypass — audit every mutation path ─────────────────────────────

test('10. no bypass: no mutation path can make an unverified provider active', async () => {
  const store = createMemoryServiceStore();
  const registry = createServiceRegistry(store);

  // (a) register (with and without a smuggled status) → inactive.
  const a = registerOk(registry, { id: 'svc_bypass-a' });
  eq(a.status, 'inactive', '(a) register → inactive');
  const a2 = registerOk(registry, { id: 'svc_bypass-a2', status: 'active' });
  eq(a2.status, 'inactive', '(a) register with smuggled status → inactive');

  // (b) setStatus('active') on an unverified service → refused.
  const b = registry.setStatus('svc_bypass-a', 'active');
  notOk(b.ok, '(b) activate unverified refused');
  eq(registry.get('svc_bypass-a')?.status, 'inactive', '(b) still inactive');

  // (c) onboard with a failing verifier → inactive.
  const c = await onboardProvider(registry, validInput({ id: 'svc_bypass-c' }) as never, rejectedVerifier);
  notOk(c.activated, '(c) onboard REJECTED → not activated');
  eq(registry.get('svc_bypass-c')?.status, 'inactive', '(c) inactive');

  // (d) a legacy pre-policy row (active + unverified, written directly
  // to the store — no registry API can create this state anymore):
  // trying to activate it deactivates it instead of maintaining it.
  const legacy = registerOk(registry, { id: 'svc_bypass-d' });
  const row = store.get('svc_bypass-d')!;
  row.status = 'active';
  store.update(row);
  eq(registry.get('svc_bypass-d')?.status, 'active', '(d) legacy row is active + unverified');
  const d = registry.setStatus('svc_bypass-d', 'active');
  notOk(d.ok, '(d) re-activating the legacy row is refused');
  eq(registry.get('svc_bypass-d')?.status, 'inactive', '(d) the attempt deactivated it (self-correcting)');
  if (!d.ok) ok(d.error.includes('deactivated'), '(d) the error says it was deactivated');

  // (e) verifyProvider with REJECTED on an active + verified service
  // deactivates it (the invariant is maintained when evidence changes).
  const e = await registerActive(registry, { id: 'svc_bypass-e' });
  eq(e.status, 'active', '(e) active + verified');
  const reVerified = await registry.verifyProvider('svc_bypass-e', rejectedVerifier);
  ok(reVerified.ok, '(e) re-verification runs');
  eq(reVerified.service.providerVerification.status, 'rejected', '(e) now rejected');
  eq(registry.get('svc_bypass-e')?.status, 'inactive', '(e) re-verification deactivated it');
  const e2 = registry.setStatus('svc_bypass-e', 'active');
  notOk(e2.ok, '(e) it cannot be re-activated while rejected');

  // (f) the HTTP API has no write path: POST/PUT/DELETE are rejected.
  const post = handleDiscoveryRequest(registry, { method: 'POST', url: '/api/services' } as Parameters<typeof handleDiscoveryRequest>[1]);
  eq(post?.status, 405, '(f) POST /api/services → 405');
  const put = handleDiscoveryRequest(registry, { method: 'PUT', url: '/api/services/svc_bypass-a' } as Parameters<typeof handleDiscoveryRequest>[1]);
  eq(put?.status, 405, '(f) PUT /api/services/:id → 405');

  // After all of that, the default Discovery list contains exactly the
  // services that are verified + active — none of the unverified ones.
  // (svc_bypass-e was deactivated, so nothing here is active.)
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 0, 'no unverified service is discoverable');
  registry.close();
});

// ─── 11. Re-verification deactivates ──────────────────────────────────────

test('11. re-verification that stops being TRUSTED deactivates an active service', async () => {
  const registry = createServiceRegistry();
  const service = await registerActive(registry);
  eq(service.status, 'active', 'active + verified');
  // The provider's card is republished with a wrong hash: the next
  // verification comes back INCONCLUSIVE.
  const reVerified = await registry.verifyProvider(service.id, inconclusiveVerifier);
  ok(reVerified.ok, 're-verification runs');
  eq(reVerified.service.providerVerification.status, 'unverified', 'now unverified');
  eq(registry.get(service.id)?.status, 'inactive', 'deactivated when the evidence stopped being TRUSTED');
  eq((discoveryCall(registry, 'GET', '/api/services').body as Record<string, unknown>)['total'], 0, 'no longer discoverable');
  // And it cannot be re-activated until a fresh TRUSTED verification.
  const again = registry.setStatus(service.id, 'active');
  notOk(again.ok, 'cannot re-activate while unverified');
  const fresh = await registry.verifyProvider(service.id, trustedVerifier);
  ok(fresh.ok, 'fresh verification runs');
  eq(fresh.service.providerVerification.status, 'verified', 'verified again');
  const reactivated = registry.setStatus(service.id, 'active');
  ok(reactivated.ok, 're-activation succeeds after a fresh TRUSTED verification');
  eq(registry.get(service.id)?.status, 'active', 'active again');
  registry.close();
});

// ─── 12. CLI ──────────────────────────────────────────────────────────────

const CLI = new URL('../src/cli/discovery.ts', import.meta.url).pathname;

function runCli(args: string[], db: string) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args, '--db', db], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('12. CLI: activate on an unverified service exits 1; activate on a verified service exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-cli-'));
  const db = join(dir, 'discovery.db');
  try {
    // (a) unverified: register via the CLI, then activate → refused.
    const reg = runCli([
      'register', '--name', 'Testnet Price Feed', '--description', 'Live CCD price ticks.',
      '--category', 'data', '--endpoint', 'https://api.example.com/price',
      '--token-id', '1004', '--owner', SENDER, '--agent-uri', CARD_URL,
      '--amount', '10', '--pay-to', RECIPIENT, '--id', 'svc_policy-cli',
    ], db);
    eq(reg.status, 0, 'register exits 0');
    const regJson = JSON.parse(reg.stdout) as Record<string, unknown>;
    eq(regJson['status'], 'inactive', 'register creates an inactive service');
    const actBad = runCli(['activate', '--id', 'svc_policy-cli'], db);
    eq(actBad.status, 1, 'activate on an unverified service exits 1');
    ok(actBad.stderr.includes('not TRUSTED'), 'error names the guard');

    // (b) verified: seed a verified (but inactive) service via the
    // library, then activate via the CLI → succeeds. (Seeding via the
    // library avoids the production verifier, which needs the network;
    // the CLI `activate` itself is what is under test here.)
    const store = new SqliteServiceStore(db);
    const registry = createServiceRegistry(store);
    const seeded = registry.register(validInput({ id: 'svc_policy-cli-verified' }) as never);
    ok(seeded.ok, 'seeded service registered');
    const verified = await registry.verifyProvider('svc_policy-cli-verified', trustedVerifier);
    ok(verified.ok, 'seeded service verified');
    registry.close();

    const actOk = runCli(['activate', '--id', 'svc_policy-cli-verified'], db);
    eq(actOk.status, 0, 'activate on a verified service exits 0');
    const actJson = JSON.parse(actOk.stdout) as Record<string, unknown>;
    eq(actJson['status'], 'active', 'now active');
    eq((actJson['providerVerification'] as Record<string, unknown>)['status'], 'verified', 'verified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 13. L2: persist failure is not reported as success ───────────────────

/**
 * A store that reads fine but fails every write to `update` — the
 * storage-failure shape (read-only file, full disk, I/O error).
 * `insert` and `appendAudit` still work, so registration succeeds and
 * the failure audit row is recorded; only the verification persist
 * fails.
 */
function failingUpdateStore(): ServiceStore {
  const inner = createMemoryServiceStore();
  return {
    ...inner,
    update() {
      throw new Error('simulated storage failure: disk full');
    },
  };
}

test('13. verifyProvider with a failing store returns {ok:false} and never presents the failed state as persisted (L2)', async () => {
  const registry = createServiceRegistry(failingUpdateStore());
  const service = registerOk(registry);
  eq(service.providerVerification.status, 'registered', 'starts registered');

  // TRUSTED verification whose persist fails → NOT ok.
  const result = await registry.verifyProvider(service.id, trustedVerifier);
  notOk(result.ok, 'verifyProvider must fail when the result cannot be saved');
  if (!result.ok) {
    ok(result.error.includes('could not be saved'), 'error says the result could not be saved');
  }

  // The failed state is NOT presented as valid persistent state: a
  // fresh read still shows the old verification (registered), not the
  // TRUSTED result that never reached the store.
  const stored = registry.get(service.id)!;
  eq(stored.providerVerification.status, 'registered', 'stored verification is unchanged (still registered)');
  eq(stored.status, 'inactive', 'stored status is unchanged (still inactive)');
  notOk(
    (stored.providerVerification as { decision?: string }).decision === 'TRUSTED',
    'no TRUSTED decision is stored',
  );

  // The audit does not claim a successful persist: the failure row
  // names the persistence failure.
  const audit = registry.auditLog(service.id);
  ok(audit.some(a => a.detail.includes('PERSISTENCE FAILED')), 'audit records the persistence failure');
  ok(!audit.some(a => a.detail === 'verification: verified (TRUSTED)'), 'no audit row claims a successful verified persist');
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
console.log(`\nprovider-activation-policy: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
