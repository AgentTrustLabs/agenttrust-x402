/**
 * Safe mock-only resource server mode — regression tests.
 *
 * Covers `AGENTTRUST_X402_FACILITATOR_MODE` (src/x402/resourceServer.ts) and
 * the script wiring (scripts/x402-resource-server.mts): the server can run
 * in an explicit `mock` mode to test Discovery and the HTTP 402 challenge
 * without a sponsor account, wallet, signing service, real facilitator, or
 * any Concordium transaction — and a mock settlement can never unlock the
 * resource.
 *
 *   1. Mode resolution: unset/empty → 'real' (production default).
 *   2. Mode resolution: 'real' and 'mock' accepted.
 *   3. Mode resolution: invalid values fail startup loudly (no silent
 *      fallback, no case folding).
 *   4. Mock chain verifier: never reports a finalization (always
 *      'unavailable'), never throws.
 *   5. Mock server serves the 402 challenge with NO feePayer (none is
 *      invented as a workaround).
 *   6. Mock server serves the Discovery API (list + detail + 404).
 *   7. Mock settlement NEVER produces a paid HTTP 200: a structurally
 *      valid payment is "settled" by the mock facilitator, then fails
 *      closed at the on-chain read (503). A second payment, with a
 *      different requestId, fails the same way. No PAYMENT-RESPONSE.
 *   8. Mock mode composes with the public resource URL (402 names the
 *      public URL; paid requests still fail closed).
 *   9. Real mode stays strict: buildPaymentRequirements rejects an
 *      invalid feePayer, and accepts a genuine one.
 *  10. Script-level mock mode (subprocess): the real launcher starts
 *      with AGENTTRUST_X402_FACILITATOR_MODE=mock plus the production-
 *      guard opt-in AGENTTRUST_X402_ALLOW_MOCK=1, a closed-port
 *      facilitator URL (proving no startup probe ran), and a temp DB —
 *      and serves 402 + Discovery while refusing every paid request.
 *
 * Offline: mock facilitator + mock chain verifier, real provider + real
 * HTTP layer on loopback. No signing, no transactions, no wallet, no
 * facilitator, no chain node, no CCD spend anywhere in this file.
 *
 * Run with: npm test  (tsx)
 */

import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk, throws } from './helpers.mjs';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import {
  startX402ResourceServer,
  resolveFacilitatorMode,
  createMockChainVerifier,
} from '../src/x402/resourceServer.js';
import { mockFacilitator } from '../src/commerce/simulation.js';
import { createServiceRegistry } from '../src/discovery/registry.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const RESOURCE_PATH = '/protected';
const PUBLIC_URL = 'https://api.sabokun.my.id/agenttrust/protected';
const CARD_URL = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ─── 1–3. resolveFacilitatorMode ────────────────────────────────────────────

test('mode resolution: unset, empty, or whitespace defaults to real (fail-closed production default)', () => {
  eq(resolveFacilitatorMode(undefined), 'real', 'undefined → real');
  eq(resolveFacilitatorMode(''), 'real', 'empty → real');
  eq(resolveFacilitatorMode('   '), 'real', 'whitespace → real');
});

test('mode resolution: real and mock are accepted', () => {
  eq(resolveFacilitatorMode('real'), 'real', 'real → real');
  eq(resolveFacilitatorMode('mock'), 'mock', 'mock → mock');
  eq(resolveFacilitatorMode('  mock  '), 'mock', 'surrounding whitespace is trimmed');
});

test('mode resolution: invalid values fail loudly — no silent fallback, no case folding', () => {
  for (const bad of ['Mock', 'MOCK', 'yes', 'off', '1', 'mockk', 'realx', 'none', 'test']) {
    throws(
      () => resolveFacilitatorMode(bad),
      'AGENTTRUST_X402_FACILITATOR_MODE must be "real" or "mock"',
      `invalid mode ${JSON.stringify(bad)} throws with the env var named`,
    );
  }
});

// ─── 4. createMockChainVerifier ─────────────────────────────────────────────

test('mock chain verifier never reports a finalization and never throws', async () => {
  const chain = createMockChainVerifier();
  for (const hash of [HASH, '00'.repeat(32), 'not-a-hash', '']) {
    const summary = await chain.readTransfer(hash);
    eq(summary.status, 'unavailable', `readTransfer(${JSON.stringify(hash)}) → unavailable`);
  }
});

// ─── shared mock-server harness ─────────────────────────────────────────────

const stubPayload = (requirements: unknown, resourceUrl: string, requestId: string) => ({
  x402Version: 2,
  accepted: requirements,
  payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
  resource: { url: resourceUrl },
  requestId,
});

/** Requirements exactly as the mock-mode script builds them: no feePayer. */
const requirementsFor = (resourceUrl: string) =>
  buildPaymentRequirements({
    payTo: RECIPIENT,
    amountMicroCcd: '1',
    resourceUrl,
    network: CAIP2,
    maxTimeoutSeconds: 300,
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

interface MockServerCtx {
  url: string;
  port: number;
  resourceUrl: string;
  requirements: ReturnType<typeof requirementsFor>;
  facilitator: ReturnType<typeof mockFacilitator>;
  serviceId: string;
  close: () => Promise<void>;
}

/** A mock-mode server: mock facilitator + mock chain, in-memory Discovery registry. */
async function withMockServer(resourceUrlOverride?: string): Promise<MockServerCtx> {
  const port = await freePort();
  const resourceUrl = resourceUrlOverride ?? `http://127.0.0.1:${port}${RESOURCE_PATH}`;
  const requirements = requirementsFor(resourceUrl);
  const facilitator = mockFacilitator('ok');
  const chain = createMockChainVerifier();
  const discovery = createServiceRegistry();
  const registered = discovery.register({
    name: 'Testnet Price Feed',
    description: 'Live CCD price ticks from Concordium Testnet.',
    category: 'data',
    endpoint: 'https://api.example.com/price',
    provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: CARD_URL },
    network: CAIP2,
    pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: RECIPIENT, maxTimeoutSeconds: 300 },
  } as never);
  if (!registered.ok) throw new Error(`mock-server fixture registration failed: ${registered.errors.join('; ')}`);
  // The fixture service must be active to appear in the Discovery list:
  // verify it (stub TRUSTED) and activate it (activation policy).
  const verified = await discovery.verifyProvider(registered.service.id, async () => ({ decision: 'TRUSTED', reason: 'mock fixture (stub)' }));
  if (!verified.ok) throw new Error(`mock-server fixture verification failed: ${verified.error}`);
  const activated = discovery.setStatus(registered.service.id, 'active');
  if (!activated.ok) throw new Error(`mock-server fixture activation failed: ${activated.error}`);
  const provider = createX402Provider(
    { requirements, resourceUrl, resource: { body: 'PROTECTED-CONTENT', url: resourceUrl } },
    { facilitator, chain },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore() },
  );
  const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host: '127.0.0.1', port, discovery });
  return {
    url: started.url,
    port,
    resourceUrl,
    requirements,
    facilitator,
    serviceId: registered.service.id,
    close: started.close,
  };
}

async function runWithMockServer<T>(fn: (ctx: MockServerCtx) => Promise<T>, resourceUrlOverride?: string): Promise<T> {
  const ctx = await withMockServer(resourceUrlOverride);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

// ─── 5. Mock 402 challenge: no feePayer ─────────────────────────────────────

test('mock server serves the 402 challenge with NO feePayer (none is invented)', async () => {
  await runWithMockServer(async ({ url, resourceUrl }) => {
    const res = await fetch(`${url}${RESOURCE_PATH}`);
    eq(res.status, 402, 'status');
    const body = (await res.json()) as Record<string, unknown>;
    eq(body['x402Version'], 2, 'x402Version');
    eq((body['resource'] as Record<string, unknown>)['url'], resourceUrl, 'resource.url is the resource URL');
    const accepts = body['accepts'] as Array<Record<string, unknown>>;
    ok(Array.isArray(accepts) && accepts.length === 1, 'one accept');
    eq(accepts[0]['network'], CAIP2, 'Testnet network');
    eq(accepts[0]['payTo'], RECIPIENT, 'payTo');
    eq(accepts[0]['amount'], '1', 'amount 1 microCCD');
    const extra = accepts[0]['extra'] as Record<string, unknown> | undefined;
    ok(!extra || extra['feePayer'] === undefined, 'no feePayer is announced in the challenge');
  });
});

// ─── 6. Mock server serves the Discovery API ────────────────────────────────

test('mock server serves the Discovery API (list, detail, 404)', async () => {
  await runWithMockServer(async ({ url, serviceId }) => {
    const list = await fetch(`${url}/api/services`);
    eq(list.status, 200, 'list status');
    const listBody = (await list.json()) as Record<string, unknown>;
    eq(listBody['total'], 1, 'one service registered');
    const services = listBody['services'] as Array<Record<string, unknown>>;
    eq(services[0]?.['id'], serviceId, 'the registered service is listed');

    const detail = await fetch(`${url}/api/services/${serviceId}`);
    eq(detail.status, 200, 'detail status');
    const detailBody = (await detail.json()) as Record<string, unknown>;
    eq(detailBody['id'], serviceId, 'detail returns the service');

    const missing = await fetch(`${url}/api/services/svc_no_such_service`);
    eq(missing.status, 404, 'unknown service → 404');
  });
});

// ─── 7. Mock settlement NEVER produces a paid HTTP 200 ─────────────────────

test('mock settlement never produces a paid HTTP 200 — it fails closed at the on-chain read', async () => {
  await runWithMockServer(async ({ url, resourceUrl, requirements, facilitator }) => {
    // First paid attempt: structurally valid, so the mock facilitator
    // verifies AND settles it. The chain can never confirm it.
    const res1 = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, resourceUrl, 'req-mock-1')) },
    });
    eq(res1.status, 503, 'first paid attempt → 503, never 200');
    const body1 = (await res1.json()) as Record<string, unknown>;
    eq(body1['error'], 'on-chain verification unavailable', 'fail-closed at the on-chain read');
    ok(res1.headers.get('payment-response') === null, 'no PAYMENT-RESPONSE header on a failed payment');
    ok(facilitator.calls.includes('verify'), 'mock facilitator verify ran');
    ok(facilitator.calls.includes('settle'), 'mock facilitator settle ran — and still did not unlock');

    // Second paid attempt, a different requestId: also fails closed.
    // (A replayed requestId would also fail — nothing is ever claimed,
    // because the claim happens only after a successful chain read.)
    const res2 = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, resourceUrl, 'req-mock-2')) },
    });
    eq(res2.status, 503, 'second paid attempt → 503, never 200');
  });
});

// ─── 8. Mock mode composes with the public resource URL ────────────────────

test('mock mode + public URL: 402 names the public URL, paid requests still fail closed', async () => {
  await runWithMockServer(async ({ url, resourceUrl, requirements, facilitator }) => {
    eq(resourceUrl, PUBLIC_URL, 'resource URL is the public URL');
    const challenge = await fetch(`${url}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    const challengeBody = (await challenge.json()) as Record<string, unknown>;
    eq((challengeBody['resource'] as Record<string, unknown>)['url'], PUBLIC_URL, 'challenge names the public URL');

    const paid = await fetch(`${url}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, PUBLIC_URL, 'req-mock-public-1')) },
    });
    eq(paid.status, 503, 'paid request with the public URL → 503, never 200');
    ok(facilitator.calls.includes('settle'), 'mock settle ran and still did not unlock');
  }, PUBLIC_URL);
});

// ─── 9. Real mode stays strict ──────────────────────────────────────────────

test('real mode stays strict: an invalid feePayer is rejected, a genuine one is accepted', () => {
  // A fake / arbitrary address must never be usable as a workaround.
  for (const bad of ['not-an-account', '3xRV448Q', '0x1234', '', 'a'.repeat(49), 'a'.repeat(51)]) {
    throws(
      () =>
        buildPaymentRequirements({
          payTo: RECIPIENT,
          amountMicroCcd: '1',
          resourceUrl: `http://127.0.0.1:4590${RESOURCE_PATH}`,
          network: CAIP2,
          feePayer: bad,
        }),
      'feePayer is not a valid Concordium account',
      `invalid feePayer ${JSON.stringify(bad)} is rejected`,
    );
  }
  // The genuine sponsor address still builds a requirement with feePayer.
  const req = buildPaymentRequirements({
    payTo: RECIPIENT,
    amountMicroCcd: '1',
    resourceUrl: `http://127.0.0.1:4590${RESOURCE_PATH}`,
    network: CAIP2,
    feePayer: SPONSOR,
  });
  eq((req.extra as Record<string, unknown>)['feePayer'], SPONSOR, 'genuine feePayer is carried');
  // And the default mode is real.
  eq(resolveFacilitatorMode(undefined), 'real', 'default mode is real');
});

// ─── 10. Script-level mock mode (subprocess) ────────────────────────────────

const SCRIPT = new URL('../scripts/x402-resource-server.mts', import.meta.url).pathname;

/** Poll GET <url> until it answers (any status) or the deadline passes. */
async function waitForHttp(url: string, child: ChildProcess, deadlineMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`mock server exited early with code ${child.exitCode}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() - started > deadlineMs) {
        throw new Error(`mock server did not answer ${url} within ${deadlineMs}ms`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

test('script starts in mock mode without a facilitator or sponsor, serves 402 + Discovery, refuses payment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-mode-'));
  const dbPath = join(dir, 'discovery.db');
  const port = await freePort();
  // A closed port for the facilitator URL: if the script probed it, the
  // probe would fail and the process would exit 2. Starting successfully
  // against a dead facilitator proves no startup probe ran.
  const deadFacilitatorPort = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
    env: {
      ...process.env,
      AGENTTRUST_X402_FACILITATOR_MODE: 'mock',
      // The mock production guard (src/x402/mockModeGuard.ts) requires
      // this explicit opt-in; without it the launcher refuses to start.
      AGENTTRUST_X402_ALLOW_MOCK: '1',
      AGENTTRUST_X402_HOST: '127.0.0.1',
      AGENTTRUST_X402_PORT: String(port),
      AGENTTRUST_FACILITATOR_URL: `http://127.0.0.1:${deadFacilitatorPort}`,
      AGENTTRUST_DISCOVERY_DB: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', d => { stdout += String(d); });
  child.stderr?.on('data', d => { stderr += String(d); });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}${RESOURCE_PATH}`, child, 20_000);
    ok(child.exitCode === null, 'server is still running (did not exit on a missing facilitator)');

    const challenge = await fetch(`${base}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    const challengeBody = (await challenge.json()) as Record<string, unknown>;
    const accepts = challengeBody['accepts'] as Array<Record<string, unknown>>;
    const extra = accepts[0]?.['extra'] as Record<string, unknown> | undefined;
    ok(!extra || extra['feePayer'] === undefined, 'script mock challenge names no feePayer');

    const list = await fetch(`${base}/api/services`);
    eq(list.status, 200, 'Discovery list status');
    eq(((await list.json()) as Record<string, unknown>)['total'], 0, 'empty registry in the temp DB');

    const requirements = requirementsFor(`${base}${RESOURCE_PATH}`);
    const paid = await fetch(`${base}${RESOURCE_PATH}`, {
      headers: { 'x-payment': JSON.stringify(stubPayload(requirements, `${base}${RESOURCE_PATH}`, 'req-script-mock-1')) },
    });
    notOk(paid.status === 200, 'paid request never returns 200 in mock mode');
    eq(paid.status, 503, 'paid request → 503 fail-closed');

    ok(stdout.includes('mock'), 'startup log names mock mode');
    ok(!stdout.includes('facilitator probe failed'), 'no facilitator probe failure in the log');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
    ok(!existsSync(dbPath), 'temp DB removed after the test');
  }
  ok(!stderr.includes('facilitator probe failed'), 'stderr has no facilitator probe failure');
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
console.log(`\nmock-facilitator-mode: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
