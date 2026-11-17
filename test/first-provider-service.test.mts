/**
 * First-provider service tests: AgentTrust as its own first discoverable,
 * callable service (`svc_agenttrust_x402`, CIS-8004 Token #1004).
 *
 * Coverage:
 *   1. onboarding is idempotent (same id, no duplicate row, no duplicate audit)
 *   2. the registry returns the AgentTrust service (active + verified)
 *   3. MCP discover_services returns the registered service
 *   4. MCP get_service_details returns the correct payment requirements
 *   5. an unpaid request returns HTTP 402
 *   6. an invalid payment is rejected (malformed / facilitator-rejected /
 *      wrong amount) — never with the resource attached
 *   7. a valid verified payment returns the service JSON + payment proof
 *   8. a duplicate payment / request id is refused (409)
 *   9. a facilitator failure never exposes the paid resource
 *  10. Owner Authorization Binding v3 remains enforced at the service layer
 *
 * The facilitator and the chain are fakes, so every failure path is
 * reachable with no node, no signing, and no transaction. The fakes model
 * the facilitator's decision boundary only: a fake that enforces v3
 * refuses settlement when the Owner never authorized (the Owner
 * authorization itself is the facilitator's job — its Ed25519
 * certificate verification is covered by owner-authorization-binding
 * and owner-storage-isolation, not re-implemented here). No fake ever
 * claims a real Testnet settlement.
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import {
  createServiceRegistry,
  buildServicePaymentRequirements,
  type ServiceRecord,
} from '../src/discovery/registry.js';
import { SqliteServiceStore } from '../src/discovery/store.js';
import {
  AGENTTRUST_SERVICE_ID,
  AGENTTRUST_TOKEN_ID,
  AGENTTRUST_OWNER_ACCOUNT,
  AGENTTRUST_AGENT_URI,
  AGENTTRUST_PAY_TO,
  onboardAgentTrustService,
  agenttrustServiceResource,
} from '../src/discovery/firstProvider.js';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer, decodePaymentResponse } from '../src/x402/resourceServer.js';
import { callTool, type ServerConfig } from '../src/mcp/tools.js';

console.log('── first-provider-service ──');

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = AGENTTRUST_PAY_TO;
const HASH = 'ab'.repeat(32);
const BLOCK_HASH = 'cd'.repeat(32);
const RESOURCE_PATH = '/protected';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const trustedVerifier = async () => ({ decision: 'TRUSTED' as const });

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

/** Onboard the first-provider service into a throwaway SQLite registry. */
async function onboardedRegistry(endpoint: string) {
  const dir = mkdtempSync(join(tmpdir(), 'first-provider-'));
  const dbPath = join(dir, 'discovery.db');
  const registry = createServiceRegistry(new SqliteServiceStore(dbPath));
  const result = await onboardAgentTrustService(registry, trustedVerifier, endpoint, {
    actor: 'first-provider-test',
  });
  ok(result.ok, 'onboarding succeeds');
  ok(result.activated, 'service activates on TRUSTED');
  return { registry, service: result.service as ServiceRecord, dir, dbPath };
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* throwaway dir: cleanup is best-effort */
  }
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

/**
 * Fake facilitator that enforces the Owner-authorization decision
 * boundary (protocol v3): settlement is refused when the Owner never
 * authorized. The flag stands in for the facilitator + Owner pair; the
 * certificate cryptography itself is not modeled here.
 */
const fakeV3Facilitator = (ownerAuthorized: boolean) => {
  const seenPayloads: unknown[] = [];
  return {
    seenPayloads,
    verify: async (payload: unknown) => {
      seenPayloads.push(payload);
      if (!ownerAuthorized) {
        return { isValid: false, invalidReason: 'owner_authorization_required' };
      }
      return { isValid: true };
    },
    settle: async (payload: unknown) => {
      seenPayloads.push(payload);
      if (!ownerAuthorized) {
        return { success: false, errorReason: 'owner_authorization_missing' };
      }
      return { success: true, transaction: HASH, network: CAIP2 };
    },
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

interface ServerCtx {
  url: string;
  resourceUrl: string;
  service: ServiceRecord;
  registry: ReturnType<typeof createServiceRegistry>;
  dir: string;
  close: () => Promise<void>;
}

async function withServer(opts: {
  facilitator?: ReturnType<typeof fakeFacilitator> | ReturnType<typeof fakeV3Facilitator>;
  chain?: { readTransfer: (hash: string) => Promise<ChainTransferSummary> };
}): Promise<ServerCtx> {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}${RESOURCE_PATH}`;
  const { registry, service, dir } = await onboardedRegistry(endpoint);
  const requirements = buildServicePaymentRequirements(service, endpoint, { feePayer: SPONSOR });
  const facilitator = opts.facilitator ?? fakeFacilitator();
  const chain = opts.chain ?? { readTransfer: async () => chainFinalized() };
  const provider = createX402Provider(
    { requirements, resourceUrl: endpoint, resource: agenttrustServiceResource(service) },
    { facilitator: facilitator as never, chain },
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
    resourcePath: RESOURCE_PATH,
    host: '127.0.0.1',
    port,
    discovery: registry,
  });
  return {
    url: started.url,
    resourceUrl: endpoint,
    service,
    registry,
    dir,
    close: async () => {
      await started.close();
      registry.close();
      cleanupDir(dir);
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

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _unparsed: text };
  }
  return { status: res.status, body, headers: res.headers };
}

function mcpCfg(registry: ReturnType<typeof createServiceRegistry>): ServerConfig {
  return { registryBase: 'http://127.0.0.1:0', discovery: registry };
}

// 1. onboarding is idempotent
test('registration is idempotent', async () => {
  const endpoint = 'http://127.0.0.1:4590/protected';
  const { registry, dir } = await onboardedRegistry(endpoint);
  try {
    eq(registry.size(), 1, 'one service after first onboarding');
    const auditBefore = registry.auditLog(AGENTTRUST_SERVICE_ID);
    eq(auditBefore.filter((e) => e.action === 'register').length, 1, 'exactly one register audit row');

    const again = await onboardAgentTrustService(registry, trustedVerifier, endpoint, {
      actor: 'first-provider-test',
    });
    ok(again.ok, 'second onboarding succeeds');
    ok(again.activated, 'second onboarding still activated');
    ok(again.reason.includes('already onboarded'), 'second onboarding reports already onboarded');
    eq(again.service?.id, AGENTTRUST_SERVICE_ID, 'second onboarding returns the same service');
    eq(registry.size(), 1, 'still one service after second onboarding');
    const auditAfter = registry.auditLog(AGENTTRUST_SERVICE_ID);
    eq(auditAfter.filter((e) => e.action === 'register').length, 1, 'no duplicate register audit row');
  } finally {
    registry.close();
    cleanupDir(dir);
  }
});

// 2. the registry returns the AgentTrust service
test('registry returns the AgentTrust service', async () => {
  const endpoint = 'http://127.0.0.1:4590/protected';
  const { registry, service, dir } = await onboardedRegistry(endpoint);
  try {
    eq(service.id, AGENTTRUST_SERVICE_ID, 'service id');
    eq(service.name, 'AgentTrust', 'service name');
    eq(service.category, 'utility', 'category is utility');
    eq(service.endpoint, endpoint, 'endpoint is the registered URL');
    eq(service.provider.tokenId, AGENTTRUST_TOKEN_ID, 'provider token id is 1004');
    eq(service.provider.ownerAccount, AGENTTRUST_OWNER_ACCOUNT, 'provider owner account');
    eq(service.provider.agentUri, AGENTTRUST_AGENT_URI, 'provider agent card URI');
    eq(service.network, CAIP2, 'network is Concordium Testnet');
    eq(service.pricing.amountMicroCcd, '1', 'price is 1 microCCD');
    eq(service.pricing.asset, 'CCD', 'asset is CCD');
    eq(service.pricing.payTo, AGENTTRUST_PAY_TO, 'payTo is the live recipient');
    eq(service.status, 'active', 'service is active');
    eq(service.providerVerification.status, 'verified', 'provider verification is verified');
    eq(service.providerVerification.decision, 'TRUSTED', 'verification decision is TRUSTED');

    const listed = registry.list({ status: 'active' });
    eq(listed.total, 1, 'active list has one service');
    eq(listed.services[0]?.id, AGENTTRUST_SERVICE_ID, 'listed service is the AgentTrust service');
    const fetched = registry.get(AGENTTRUST_SERVICE_ID);
    eq(fetched?.id, AGENTTRUST_SERVICE_ID, 'get returns the AgentTrust service');
  } finally {
    registry.close();
    cleanupDir(dir);
  }
});

// 3. MCP discover_services returns the registered service
test('MCP discover_services returns the registered service', async () => {
  const endpoint = 'http://127.0.0.1:4590/protected';
  const { registry, dir } = await onboardedRegistry(endpoint);
  try {
    const out = await callTool(mcpCfg(registry), 'discover_services', {});
    ok(out.ok, 'discover_services succeeds');
    if (out.ok) {
      const res = out.result as { services: Record<string, unknown>[]; total: number };
      eq(res.total, 1, 'discovery total is 1');
      eq(res.services.length, 1, 'discovery returns one service');
      const svc = res.services[0] as Record<string, unknown>;
      eq(svc['id'], AGENTTRUST_SERVICE_ID, 'discovered service id');
      eq(svc['name'], 'AgentTrust', 'discovered service name');
      eq(svc['status'], 'active', 'discovered service is active');
      const provider = svc['provider'] as Record<string, unknown>;
      eq(provider['tokenId'], AGENTTRUST_TOKEN_ID, 'discovered provider token id');
      eq(provider['agentUri'], AGENTTRUST_AGENT_URI, 'discovered agent card reference');
      ok(svc['paymentRequirements'] !== undefined, 'discovered service carries payment requirements');
      const reqs = svc['paymentRequirements'] as Record<string, unknown>;
      eq(reqs['scheme'], 'exact', 'requirement scheme is exact');
      eq(reqs['network'], CAIP2, 'requirement network is Testnet');
      eq(reqs['asset'], 'CCD', 'requirement asset is CCD');
      eq(reqs['amount'], '1', 'requirement amount is 1 microCCD');
      eq(reqs['payTo'], AGENTTRUST_PAY_TO, 'requirement payTo');
    }
  } finally {
    registry.close();
    cleanupDir(dir);
  }
});

// 4. MCP get_service_details returns the correct payment requirements
test('MCP get_service_details returns correct payment requirements', async () => {
  const endpoint = 'http://127.0.0.1:4590/protected';
  const { registry, dir } = await onboardedRegistry(endpoint);
  try {
    const out = await callTool(mcpCfg(registry), 'get_service_details', { service_id: AGENTTRUST_SERVICE_ID });
    ok(out.ok, 'get_service_details succeeds');
    if (out.ok) {
      const svc = out.result as Record<string, unknown>;
      eq(svc['id'], AGENTTRUST_SERVICE_ID, 'detail service id');
      eq(svc['endpoint'], endpoint, 'detail endpoint');
      const verification = svc['providerVerification'] as Record<string, unknown>;
      eq(verification['status'], 'verified', 'detail verification status is verified');
      const reqs = svc['paymentRequirements'] as Record<string, unknown>;
      eq(reqs['scheme'], 'exact', 'detail requirement scheme');
      eq(reqs['network'], CAIP2, 'detail requirement network');
      eq(reqs['asset'], 'CCD', 'detail requirement asset');
      eq(reqs['amount'], '1', 'detail requirement amount');
      eq(reqs['payTo'], AGENTTRUST_PAY_TO, 'detail requirement payTo');
      // The resource URL lives in the 402 challenge body (buildPaymentRequired),
      // not in PaymentRequirements — the detail view's endpoint is the
      // URL the requirement binds to (asserted above, and pinned again by
      // the 402 challenge in the unpaid-request test).
    }
  } finally {
    registry.close();
    cleanupDir(dir);
  }
});

// 5. an unpaid request returns HTTP 402
test('unpaid request returns HTTP 402', async () => {
  await runWithServer({}, async (ctx) => {
    const unpaid = await fetchJson(`${ctx.url}${RESOURCE_PATH}`);
    eq(unpaid.status, 402, 'unpaid GET returns 402');
    eq(unpaid.body['x402Version'], 2, 'challenge is x402 v2');
    const accepts = unpaid.body['accepts'] as Array<Record<string, unknown>>;
    eq(accepts.length, 1, 'challenge carries one requirement');
    eq(accepts[0]?.['scheme'], 'exact', 'challenge scheme is exact');
    eq(accepts[0]?.['network'], CAIP2, 'challenge network is Testnet');
    eq(accepts[0]?.['asset'], 'CCD', 'challenge asset is CCD');
    eq(accepts[0]?.['amount'], '1', 'challenge amount is 1 microCCD');
    eq(accepts[0]?.['payTo'], AGENTTRUST_PAY_TO, 'challenge payTo');
    const resource = unpaid.body['resource'] as Record<string, unknown>;
    eq(resource['url'], ctx.resourceUrl, 'challenge resource URL is the service endpoint');

    const listed = await fetchJson(`${ctx.url}/api/services`);
    eq(listed.status, 200, 'discovery list returns 200');
    const services = listed.body['services'] as Array<Record<string, unknown>>;
    eq(services.length, 1, 'discovery list has one service');
    eq(services[0]?.['id'], AGENTTRUST_SERVICE_ID, 'discovery list shows the AgentTrust service');
  });
});

// 6. an invalid payment is rejected
test('invalid payment is rejected', async () => {
  await runWithServer({}, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });

    // (a) malformed X-PAYMENT: not JSON at all
    const malformed = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': 'not json' },
    });
    eq(malformed.status, 400, 'malformed X-PAYMENT returns 400');
    notOk('resource' in malformed.body, 'malformed response carries no resource');

    // (b) facilitator rejects the payment
    const rejecting = fakeFacilitator({
      verify: async () => ({ isValid: false, invalidReason: 'signature_invalid' }),
    });
    const ctxReject = await withServer({ facilitator: rejecting });
    try {
      const payload = JSON.stringify(stubPayload(requirements, ctxReject.resourceUrl, 'req-reject-1'));
      const rejected = await fetchJson(`${ctxReject.url}${RESOURCE_PATH}`, {
        headers: { 'X-PAYMENT': payload },
      });
      eq(rejected.status, 402, 'facilitator-rejected payment returns 402');
      notOk('resource' in rejected.body, 'rejected response carries no resource');
    } finally {
      await ctxReject.close();
    }

    // (c) wrong amount: the accepted amount does not match the requirement
    const wrongAmount = {
      ...stubPayload(requirements, ctx.resourceUrl, 'req-wrong-amount-1'),
      accepted: { ...requirements, amount: '2' },
    };
    const wrong = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': JSON.stringify(wrongAmount) },
    });
    eq(wrong.status, 402, 'wrong-amount payment returns 402');
    notOk('resource' in wrong.body, 'wrong-amount response carries no resource');
  });
});

// 7. a valid verified payment returns the service JSON
test('valid verified payment returns the service JSON', async () => {
  await runWithServer({}, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-valid-1'));
    const paid = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(paid.status, 200, 'verified payment returns 200');
    const resource = paid.body['resource'] as Record<string, unknown>;
    ok(resource !== undefined, 'response carries the service resource');
    const svc = resource['service'] as Record<string, unknown>;
    eq(svc['id'], AGENTTRUST_SERVICE_ID, 'resource service id');
    eq(svc['name'], 'AgentTrust', 'resource service name');
    const provider = resource['provider'] as Record<string, unknown>;
    eq(provider['tokenId'], AGENTTRUST_TOKEN_ID, 'resource provider token id');
    eq(provider['agentUri'], AGENTTRUST_AGENT_URI, 'resource agent card reference');
    const verification = resource['providerVerification'] as Record<string, unknown>;
    eq(verification['status'], 'verified', 'resource verification status is verified');
    const payment = paid.body['payment'] as Record<string, unknown>;
    eq(payment['transaction'], HASH, 'payment transaction hash');
    eq(payment['blockHash'], BLOCK_HASH, 'payment block hash');
    eq(payment['amount'], '1', 'payment amount');
    eq(payment['asset'], 'CCD', 'payment asset');
    eq(payment['payTo'], AGENTTRUST_PAY_TO, 'payment payTo');
    eq(payment['network'], CAIP2, 'payment network');
    const header = paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response');
    ok(header !== null, 'PAYMENT-RESPONSE header present');
    const decoded = header ? decodePaymentResponse(header) : null;
    ok(decoded !== null, 'PAYMENT-RESPONSE header decodes');
    eq(decoded?.['success'], true, 'payment response header reports success');
    eq(decoded?.['transaction'], HASH, 'payment response header carries the hash');
  });
});

// 8. a duplicate payment / request id is refused
test('duplicate payment is refused', async () => {
  await runWithServer({}, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-dup-1'));
    const first = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(first.status, 200, 'first presentation returns 200');

    // Same request id + same hash: replay.
    const replay = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(replay.status, 409, 'identical replay returns 409');
    notOk('resource' in replay.body, 'replay response carries no resource');

    // New request id, same settlement hash: still a replay of the payment.
    const sameHash = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-dup-2'));
    const replayHash = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': sameHash },
    });
    eq(replayHash.status, 409, 'same-hash second presentation returns 409');
    notOk('resource' in replayHash.body, 'same-hash replay carries no resource');
  });
});

// 9. a facilitator failure never exposes the paid resource
test('facilitator failure never exposes the paid resource', async () => {
  // (a) verify throws (facilitator unreachable / timed out)
  const throwing = fakeFacilitator({
    verify: async () => {
      throw new Error('facilitator unreachable');
    },
  });
  await runWithServer({ facilitator: throwing }, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-fail-1'));
    const res = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(res.status, 503, 'verify throw returns 503');
    notOk('resource' in res.body, 'verify-throw response carries no resource');
  });

  // (b) settle reports failure without a hash
  const settleFail = fakeFacilitator({
    settle: async () => ({ success: false, errorReason: 'settle_failed' }),
  });
  await runWithServer({ facilitator: settleFail }, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-fail-2'));
    const res = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(res.status, 402, 'settle failure returns 402');
    notOk('resource' in res.body, 'settle-failure response carries no resource');
  });

  // (c) chain read unavailable after settlement
  await runWithServer(
    { chain: { readTransfer: async () => ({ status: 'unavailable' }) } },
    async (ctx) => {
      const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
      const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-fail-3'));
      const res = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
        headers: { 'X-PAYMENT': payload },
      });
      eq(res.status, 503, 'chain-unavailable returns 503');
      notOk('resource' in res.body, 'chain-unavailable response carries no resource');
    },
  );
});

// 10. Owner Authorization Binding v3 remains enforced
test('Owner Authorization Binding v3 remains enforced', async () => {
  // (a) The Owner never authorized: the facilitator refuses at verify.
  // The service layer must propagate the refusal and never release the
  // resource — it must not substitute its own authorization.
  const unauthorized = fakeV3Facilitator(false);
  await runWithServer({ facilitator: unauthorized }, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-v3-1'));
    const res = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(res.status, 402, 'unauthorized payment returns 402');
    notOk('resource' in res.body, 'unauthorized response carries no resource');
    ok(unauthorized.seenPayloads.length >= 1, 'facilitator saw the payment');
    const seen = unauthorized.seenPayloads[0] as Record<string, unknown>;
    const inner = seen['payload'] as Record<string, unknown>;
    ok(inner !== undefined && typeof inner === 'object', 'payload forwarded to the facilitator intact');
  });

  // (b) Authorization revoked between verify and settle: settle refuses.
  const revoked = fakeV3Facilitator(true);
  const revoking = {
    ...revoked,
    settle: async (payload: unknown) => {
      revoked.seenPayloads.push(payload);
      return { success: false, errorReason: 'owner_authorization_missing' };
    },
  };
  await runWithServer({ facilitator: revoking }, async (ctx) => {
    const requirements = buildServicePaymentRequirements(ctx.service, ctx.resourceUrl, { feePayer: SPONSOR });
    const payload = JSON.stringify(stubPayload(requirements, ctx.resourceUrl, 'req-v3-2'));
    const res = await fetchJson(`${ctx.url}${RESOURCE_PATH}`, {
      headers: { 'X-PAYMENT': payload },
    });
    eq(res.status, 402, 'revoked-authorization payment returns 402');
    notOk('resource' in res.body, 'revoked-authorization response carries no resource');
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
console.log(`\nfirst-provider-service: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
