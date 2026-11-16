/**
 * MCP service discovery tests (discover_services + get_service_details).
 *
 * All fixtures are synthetic (tokenId 9001..9004, synthetic base58 accounts,
 * service ids svc_test-*).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import {
  createServiceRegistry,
  DISCOVERY_NETWORK,
  type ServiceRecord,
  type ServiceRegistrationInput,
} from '../src/discovery/registry.js';
import { createMemoryServiceStore, SqliteServiceStore } from '../src/discovery/store.js';
import { TOOLS, callTool, type ServerConfig } from '../src/mcp/tools.js';

console.log('── mcp-discovery ──');

// Synthetic 50-char base58 accounts (never real owner/sponsor accounts)
const SYNTH_OWNER_1 = '3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SYNTH_OWNER_2 = '3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SYNTH_PAYTO_1 = '3ccccccccccccccccccccccccccccccccccccccccccccccccc';

function makeInput(overrides: Partial<ServiceRegistrationInput> = {}): ServiceRegistrationInput {
  return {
    id: 'svc_test-alpha',
    name: 'Synthetic Market Data Feed',
    description: 'Synthetic market telemetry service for unit tests',
    category: 'data',
    endpoint: 'https://synthetic.example.test/api/feed',
    provider: {
      tokenId: 9001,
      ownerAccount: SYNTH_OWNER_1,
      agentUri: 'https://synthetic.example.test/agent-card-9001.json',
    },
    network: DISCOVERY_NETWORK,
    pricing: {
      amountMicroCcd: '250000',
      asset: 'CCD',
      payTo: SYNTH_PAYTO_1,
      maxTimeoutSeconds: 300,
      description: 'Per request fee',
    },
    ...overrides,
  };
}

function baseCfg(discovery?: ReturnType<typeof createServiceRegistry>): ServerConfig {
  return {
    registryBase: 'http://127.0.0.1:0',
    ...(discovery ? { discovery } : {}),
  };
}

// 1. Empty registry → { services: [], total: 0 } and get_service_details → 'service not found'
{
  const reg = createServiceRegistry(createMemoryServiceStore());
  const cfg = baseCfg(reg);

  const listOut = await callTool(cfg, 'discover_services', {});
  ok(listOut.ok, 'empty registry discover_services succeeds');
  if (listOut.ok) {
    const res = listOut.result as { services: unknown[]; total: number; filters: { status: string; limit: number } };
    eq(res.services.length, 0, 'empty registry returns 0 services');
    eq(res.total, 0, 'empty registry total is 0');
    eq(res.filters.status, 'active', 'default status filter is active');
    eq(res.filters.limit, 10, 'default limit is 10');
  }

  const detailOut = await callTool(cfg, 'get_service_details', { service_id: 'svc_test-missing' });
  notOk(detailOut.ok, 'missing service fails');
  if (!detailOut.ok) {
    eq(detailOut.error.code, 'INVALID_INPUT', 'missing service error code is INVALID_INPUT');
    eq(detailOut.error.message, 'service not found', 'missing service message is service not found');
  }
}

// 2. Multiple discoverable services listed (status active + providerVerification verified)
{
  const store = createMemoryServiceStore();
  const reg = createServiceRegistry(store);
  reg.register(makeInput({ id: 'svc_test-one', name: 'Synthetic Alpha' }));
  reg.register(
    makeInput({
      id: 'svc_test-two',
      name: 'Synthetic Beta',
      category: 'compute',
      provider: {
        tokenId: 9002,
        ownerAccount: SYNTH_OWNER_2,
        agentUri: 'https://synthetic.example.test/agent-card-9002.json',
      },
    }),
  );
  await reg.verifyProvider('svc_test-one', async () => ({ decision: 'TRUSTED' }));
  await reg.verifyProvider('svc_test-two', async () => ({ decision: 'TRUSTED' }));
  reg.setStatus('svc_test-one', 'active');
  reg.setStatus('svc_test-two', 'active');

  const out = await callTool(baseCfg(reg), 'discover_services', {});
  ok(out.ok, 'multiple discoverable services call succeeds');
  if (out.ok) {
    const res = out.result as { services: Record<string, unknown>[]; total: number };
    eq(res.total, 2, 'returns both discoverable services');
    for (const s of res.services) {
      eq(s['status'], 'active', `${s['id']} is active`);
      eq(s['available'], true, `${s['id']} has available: true`);
      ok(Boolean(s['paymentRequirements']), `${s['id']} includes paymentRequirements`);
    }
  }
}

// 3. Non-discoverable services (stored active but unverified; registered; rejected) excluded from active list
{
  const store = createMemoryServiceStore();
  const reg = createServiceRegistry(store);

  // Registered (never verified)
  reg.register(makeInput({ id: 'svc_test-registered', name: 'Registered Only' }));

  // Rejected
  reg.register(makeInput({ id: 'svc_test-rejected', name: 'Rejected Provider' }));
  await reg.verifyProvider('svc_test-rejected', async () => ({ decision: 'REJECTED', reason: 'bad hash' }));

  // Legacy / anomalous stored-active-but-unverified row injected directly into store
  const legacyRow: ServiceRecord = {
    ...makeInput({ id: 'svc_test-legacy-unverified', name: 'Legacy Active Unverified' }),
    id: 'svc_test-legacy-unverified',
    category: 'data',
    status: 'active',
    providerVerification: { status: 'unverified', decision: 'INCONCLUSIVE', reason: 'card unreachable' },
    registeredAt: new Date().toISOString(),
  };
  store.insert(legacyRow);

  const activeOut = await callTool(baseCfg(reg), 'discover_services', {});
  ok(activeOut.ok, 'discover_services active call succeeds');
  if (activeOut.ok) {
    const res = activeOut.result as { services: Record<string, unknown>[]; total: number };
    eq(res.total, 0, 'no non-discoverable service appears in default active list');
  }

  const inactiveOut = await callTool(baseCfg(reg), 'discover_services', { status: 'inactive' });
  ok(inactiveOut.ok, 'discover_services status=inactive succeeds');
  if (inactiveOut.ok) {
    const res = inactiveOut.result as { services: Record<string, unknown>[]; total: number };
    eq(res.total, 3, 'all 3 non-discoverable services appear under status=inactive');
    for (const s of res.services) {
      eq(s['status'], 'inactive', `${s['id']} projected as inactive`);
      eq(s['available'], false, `${s['id']} projected with available: false`);
      notOk('paymentRequirements' in s, `${s['id']} omits paymentRequirements`);
    }
  }
}

// 4. Inactive services excluded from active list even when provider is verified
{
  const reg = createServiceRegistry(createMemoryServiceStore());
  reg.register(makeInput({ id: 'svc_test-verified-inactive' }));
  await reg.verifyProvider('svc_test-verified-inactive', async () => ({ decision: 'TRUSTED' }));
  // Not activated via setStatus('active')
  const out = await callTool(baseCfg(reg), 'discover_services', { status: 'active' });
  ok(out.ok, 'active list call succeeds');
  if (out.ok) {
    const res = out.result as { services: unknown[]; total: number };
    eq(res.total, 0, 'verified but inactive service is excluded from active list');
  }
}

// 5. Invalid service identifiers rejected
{
  const reg = createServiceRegistry(createMemoryServiceStore());
  const cfg = baseCfg(reg);
  const badIds: unknown[] = [
    '',
    'not_prefixed',
    'svc_bad/slash',
    'svc_bad space',
    'svc_' + 'a'.repeat(65),
    12345,
    null,
  ];
  for (const badId of badIds) {
    const out = await callTool(cfg, 'get_service_details', { service_id: badId });
    notOk(out.ok, `invalid service_id rejected: ${JSON.stringify(badId)}`);
    if (!out.ok) {
      eq(out.error.code, 'INVALID_INPUT', 'invalid service_id returns INVALID_INPUT');
    }
  }
}

// 6. Unknown service id → INVALID_INPUT 'service not found'
{
  const reg = createServiceRegistry(createMemoryServiceStore());
  const out = await callTool(baseCfg(reg), 'get_service_details', { service_id: 'svc_test-does-not-exist' });
  notOk(out.ok, 'unknown service id fails');
  if (!out.ok) {
    eq(out.error.code, 'INVALID_INPUT', 'unknown service id code is INVALID_INPUT');
    eq(out.error.message, 'service not found', 'unknown service id message is service not found');
  }
}

// 7. Malformed records: stored row with missing/null providerVerification fails closed without crashing
{
  const store = createMemoryServiceStore();
  const reg = createServiceRegistry(store);
  const malformed = {
    ...makeInput({ id: 'svc_test-malformed' }),
    id: 'svc_test-malformed',
    category: 'data' as const,
    status: 'active' as const,
    providerVerification: undefined as unknown as ServiceRecord['providerVerification'],
    registeredAt: new Date().toISOString(),
  };
  store.insert(malformed);

  const listOut = await callTool(baseCfg(reg), 'discover_services', { status: 'active' });
  ok(listOut.ok, 'discover_services does not crash on malformed providerVerification');
  if (listOut.ok) {
    const res = listOut.result as { services: unknown[]; total: number };
    eq(res.total, 0, 'malformed record is not discoverable');
  }

  const detailOut = await callTool(baseCfg(reg), 'get_service_details', { service_id: 'svc_test-malformed' });
  ok(detailOut.ok, 'get_service_details projects malformed record safely');
  if (detailOut.ok) {
    const view = detailOut.result as Record<string, unknown>;
    eq(view['status'], 'inactive', 'malformed record projected as inactive');
    eq(view['available'], false, 'malformed record projected as available: false');
    notOk('paymentRequirements' in view, 'malformed record has no paymentRequirements');
  }
}

// 8. Store unavailable: ServerConfig without a registry → both tools return STORE_UNAVAILABLE
{
  const cfgNoStore = baseCfg(undefined);
  const listOut = await callTool(cfgNoStore, 'discover_services', {});
  notOk(listOut.ok, 'discover_services without store fails closed');
  if (!listOut.ok) {
    eq(listOut.error.code, 'STORE_UNAVAILABLE', 'discover_services returns STORE_UNAVAILABLE');
  }

  const detailOut = await callTool(cfgNoStore, 'get_service_details', { service_id: 'svc_test-alpha' });
  notOk(detailOut.ok, 'get_service_details without store fails closed');
  if (!detailOut.ok) {
    eq(detailOut.error.code, 'STORE_UNAVAILABLE', 'get_service_details returns STORE_UNAVAILABLE');
  }
}

// 9. Sensitive / extra internal fields not exposed; only toServiceView keys returned
{
  const store = createMemoryServiceStore();
  const reg = createServiceRegistry(store);
  const recordWithExtra = {
    ...makeInput({ id: 'svc_test-view-shape' }),
    id: 'svc_test-view-shape',
    category: 'data' as const,
    status: 'active' as const,
    providerVerification: { status: 'verified' as const, decision: 'TRUSTED' as const },
    registeredAt: new Date().toISOString(),
    internalSecret: 'must-never-leak',
  } as unknown as ServiceRecord;
  store.insert(recordWithExtra);

  const allowedActiveKeys = new Set([
    'id',
    'name',
    'description',
    'category',
    'endpoint',
    'provider',
    'network',
    'pricing',
    'status',
    'available',
    'providerVerification',
    'registeredAt',
    'paymentRequirements',
  ]);

  const detailOut = await callTool(baseCfg(reg), 'get_service_details', { service_id: 'svc_test-view-shape' });
  ok(detailOut.ok, 'get_service_details succeeds');
  if (detailOut.ok) {
    const view = detailOut.result as Record<string, unknown>;
    for (const k of Object.keys(view)) {
      ok(allowedActiveKeys.has(k), `returned key '${k}' is in toServiceView projection`);
    }
    notOk('internalSecret' in view, 'extra internal field is stripped by toServiceView');
  }
}

// 10. Filtering works: category, query substring, limit, status='all'
{
  const reg = createServiceRegistry(createMemoryServiceStore());
  reg.register(makeInput({ id: 'svc_test-data-1', name: 'Weather Feed', description: 'Forecast data', category: 'data' }));
  reg.register(makeInput({ id: 'svc_test-comp-1', name: 'GPU Infer', description: 'Matrix compute', category: 'compute' }));
  reg.register(makeInput({ id: 'svc_test-util-1', name: 'Weather Parser', description: 'Utility parser', category: 'utility' }));
  await reg.verifyProvider('svc_test-data-1', async () => ({ decision: 'TRUSTED' }));
  await reg.verifyProvider('svc_test-comp-1', async () => ({ decision: 'TRUSTED' }));
  reg.setStatus('svc_test-data-1', 'active');
  reg.setStatus('svc_test-comp-1', 'active');

  const catOut = await callTool(baseCfg(reg), 'discover_services', { category: 'compute' });
  ok(catOut.ok && (catOut.result as { total: number }).total === 1, 'category filter matches compute service');

  const qOut = await callTool(baseCfg(reg), 'discover_services', { query: 'weather', status: 'all' });
  ok(qOut.ok && (qOut.result as { total: number }).total === 2, 'query + status=all matches both active and inactive weather services');

  const limOut = await callTool(baseCfg(reg), 'discover_services', { status: 'all', limit: 1 });
  if (limOut.ok) {
    const res = limOut.result as { services: unknown[]; total: number };
    eq(res.services.length, 1, 'limit=1 bounds returned array length');
    eq(res.total, 3, 'total reflects full matching count before limit slice');
  }
}

// 11. tools/list catalogue exposes both new tools with the exact design-doc schemas
{
  const discoverTool = TOOLS.find(t => t.name === 'discover_services');
  const detailsTool = TOOLS.find(t => t.name === 'get_service_details');
  ok(Boolean(discoverTool), 'discover_services registered in TOOLS');
  ok(Boolean(detailsTool), 'get_service_details registered in TOOLS');
  eq(discoverTool?.inputSchema['additionalProperties'], false, 'discover_services schema has additionalProperties: false');
  eq(detailsTool?.inputSchema['additionalProperties'], false, 'get_service_details schema has additionalProperties: false');
  eq((detailsTool?.inputSchema['required'] as string[])?.[0], 'service_id', 'get_service_details requires service_id');
}

// 12. Stdio end-to-end subprocess test against compiled dist/mcp/server.js
{
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-mcp-disc-'));
  const dbPath = join(dir, 'discovery.db');
  try {
    const sqliteStore = new SqliteServiceStore(dbPath);
    const reg = createServiceRegistry(sqliteStore);
    reg.register(makeInput({ id: 'svc_test-live', name: 'Live Stdio Service' }));
    reg.register(makeInput({ id: 'svc_test-unverified', name: 'Unverified Stdio Service' }));
    await reg.verifyProvider('svc_test-live', async () => ({ decision: 'TRUSTED' }));
    reg.setStatus('svc_test-live', 'active');
    reg.close();

    const child = spawn(process.execPath, ['dist/mcp/server.js'], {
      env: { ...process.env, AGENTTRUST_DISCOVERY_DB: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses: Array<{ id: number; result?: unknown; error?: unknown }> = [];
    let stdoutBuf = '';
    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    const sendRpc = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
    sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'discover_services', arguments: {} },
    });
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('stdio MCP server timed out'));
      }, 10_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', reject);
    });

    eq(responses.length, 3, 'received 3 JSON-RPC responses over stdio');
    const toolsList = (responses[1]?.result as { tools: Array<{ name: string }> })?.tools ?? [];
    ok(toolsList.some(t => t.name === 'discover_services'), 'stdio tools/list includes discover_services');
    ok(toolsList.some(t => t.name === 'get_service_details'), 'stdio tools/list includes get_service_details');

    const callEnvelope = responses[2]?.result as { content: Array<{ text: string }>; isError?: boolean };
    notOk(Boolean(callEnvelope?.isError), 'stdio discover_services call succeeded');
    const parsed = JSON.parse(callEnvelope.content[0]!.text) as { services: Array<{ id: string }>; total: number };
    eq(parsed.total, 1, 'stdio discover_services returns only the 1 verified+active service');
    eq(parsed.services[0]?.id, 'svc_test-live', 'stdio discover_services returns svc_test-live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("mcp-discovery: 12 sections passed");
