/**
 * Provider Onboarding Foundation — regression tests.
 *
 * Covers the three onboarding pillars, all offline (no network, no chain,
 * no live MCP — the production verifier is exercised through injected
 * stubs; the live path is verified separately by a smoke test):
 *
 *   1. Production provider verification (the `verifyAgent` adapter):
 *      TRUSTED → verified, REJECTED → rejected, INCONCLUSIVE → unverified,
 *      and error / timeout → unverified. Nothing can yield `verified`
 *      without a TRUSTED verdict.
 *   2. Persistent service registry (SQLite via `node:sqlite`): services,
 *      status and verification survive a restart; duplicate ids are safe
 *      (identical re-registration is idempotent, conflicting content is an
 *      error); storage failures fail closed.
 *   3. Controlled provider registration (operator CLI): the CLI registers,
 *      lists, activates, deactivates and audits against the persistent
 *      registry. The public Discovery API stays read-only (POST → 405) and
 *      MCP has no registration tool.
 *   4. Regression: Discovery list/detail and the /protected 402/200 flow
 *      behave identically on the persistent registry.
 *
 * Run with: npm test  (tsx)
 */

import { mkdtempSync, rmSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createServiceRegistry,
  validateServiceInput,
  DISCOVERY_NETWORK,
  type ServiceRegistrationInput,
} from '../src/discovery/registry.js';
import { SqliteServiceStore, createMemoryServiceStore } from '../src/discovery/store.js';
import { createProductionVerifier } from '../src/discovery/verify.js';
import { handleDiscoveryRequest } from '../src/discovery/http.js';
import { startX402ResourceServer } from '../src/x402/resourceServer.js';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { TOOLS } from '../src/mcp/tools.js';
import { eq, ok, notOk } from './helpers.mjs';

const FIX = new URL('./fixtures/discovery/', import.meta.url).pathname;
const readBytes = (p: string) => new Uint8Array(readFileSync(FIX + p));
const CARD = () => readBytes('agent-card.raw.json');

const CAIP2 = DISCOVERY_NETWORK;
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const CARD_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';

/** The live `agent_of` record for token 1004 (public on-chain data). */
const RECORD_1004 = {
  network: 'testnet',
  token_address: 'JyP9YLib1wYgFmztkcKJL',
  token_id: '1004',
  token_id_u64: 1004,
  owner_account: SENDER,
  agent_uri: CARD_URI,
  metadata_hash_hex: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564',
  agent_wallet: SENDER,
  status: 'Active',
  registered_at: '2026-11-04T23:40:17.188+00:00',
};

const fetchServing = (bytes: Uint8Array, init: { ok?: boolean; status?: number; contentType?: string } = {}) => async () => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  headers: { get: () => init.contentType ?? 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const fetchFailing = (status = 503) => async () => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});
const fetchThrowing = () => async () => {
  throw new Error('ECONNREFUSED');
};

const stubMcp = (record: unknown) => ({
  callToolRaw: async (name: string, args: Record<string, unknown>) => {
    if (name !== 'agent_of') throw new Error(`unexpected tool ${name}`);
    if (Number(args.token_id) !== 1004) throw new Error(`unexpected token_id ${String(args.token_id)}`);
    return record as Record<string, unknown>;
  },
});
const stubMcpThrowing = () => ({
  callToolRaw: async () => {
    throw new Error('MCP HTTP 502 for agent_of');
  },
});
const stubMcpHanging = () => ({
  callToolRaw: async () => new Promise<never>(() => {}),
});

function validInput(overrides: Partial<ServiceRegistrationInput> = {}): ServiceRegistrationInput {
  return {
    name: 'Testnet Price Feed',
    description: 'Live CCD price ticks from Concordium Testnet.',
    category: 'data',
    endpoint: 'https://api.example.com/price',
    provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: CARD_URI },
    network: CAIP2,
    pricing: { amountMicroCcd: '10', asset: 'CCD', payTo: RECIPIENT, maxTimeoutSeconds: 300 },
    ...overrides,
  };
}

const tmpDir = () => mkdtempSync(join(tmpdir(), 'agenttrust-discovery-'));
const dbPath = (dir: string) => join(dir, 'discovery.db');

const CLI = new URL('../src/cli/discovery.ts', import.meta.url).pathname;
function runCli(args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function cliJson(args: string[]) {
  const r = runCli(args);
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) as Record<string, unknown> : null };
}

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ─── 1. Persistence after restart ─────────────────────────────────────────

test('persistence: a registered service survives close + reopen with the same id, status and verification', () => {
  const dir = tmpDir();
  try {
    const store = new SqliteServiceStore(dbPath(dir));
    const registry = createServiceRegistry(store);
    const r = registry.register(validInput({ id: 'svc_price-feed' }));
    ok(r.ok, 'register ok');
    eq(r.service.id, 'svc_price-feed', 'id');
    eq(r.service.providerVerification.status, 'registered', 'fresh verification');
    registry.close();

    const reopened = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    const got = reopened.get('svc_price-feed');
    ok(got !== undefined, 'service survives restart');
    eq(got!.name, 'Testnet Price Feed', 'name');
    eq(got!.status, 'inactive', 'status is inactive (registration always creates inactive)');
    eq(got!.providerVerification.status, 'registered', 'verification');
    eq(reopened.size(), 1, 'one service');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: active/inactive status survives a restart in both directions', async () => {
  const dir = tmpDir();
  try {
    const registry = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    registry.register(validInput({ id: 'svc_toggle' }));
    // Activation requires TRUSTED verification: verify first, then activate.
    const verified = await registry.verifyProvider('svc_toggle', async () => ({ decision: 'TRUSTED', reason: 'test stub' }));
    ok(verified.ok, 'verify runs');
    const activated = registry.setStatus('svc_toggle', 'active');
    ok(activated.ok, 'activate after verification');
    registry.close();

    const r1 = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    eq(r1.get('svc_toggle')!.status, 'active', 'active survives restart');
    const deactivated = r1.setStatus('svc_toggle', 'inactive');
    ok(deactivated.ok, 'deactivate');
    r1.close();

    const r2 = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    eq(r2.get('svc_toggle')!.status, 'inactive', 'inactive survives restart');
    // Re-activation still works: the verification is still TRUSTED.
    const reactivated = r2.setStatus('svc_toggle', 'active');
    ok(reactivated.ok, 'reactivate after verification');
    eq(r2.get('svc_toggle')!.status, 'active', 'active again');
    r2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: verification state survives a restart', async () => {
  const dir = tmpDir();
  try {
    const registry = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    registry.register(validInput({ id: 'svc_verified' }));
    const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchServing(CARD()) });
    const v = await registry.verifyProvider('svc_verified', verifier);
    ok(v.ok, 'verify ok');
    eq(v.service.providerVerification.status, 'verified', 'verified before restart');
    ok(v.service.providerVerification.checkedAt !== undefined, 'checkedAt stored');
    registry.close();

    const reopened = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    const got = reopened.get('svc_verified')!;
    eq(got.providerVerification.status, 'verified', 'verified survives restart');
    eq(got.providerVerification.decision, 'TRUSTED', 'decision survives restart');
    ok(got.providerVerification.checkedAt !== undefined, 'checkedAt survives restart');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: the audit log survives a restart', async () => {
  const dir = tmpDir();
  try {
    const registry = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    registry.register(validInput({ id: 'svc_audited' }), { actor: 'alice' });
    await registry.verifyProvider('svc_audited', async () => ({ decision: 'TRUSTED', reason: 'test stub' }), { actor: 'alice' });
    registry.setStatus('svc_audited', 'active', { actor: 'alice' });
    registry.setStatus('svc_audited', 'inactive', { actor: 'alice' });
    registry.close();

    const reopened = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    const log = reopened.auditLog('svc_audited');
    eq(log.length, 4, 'four audit rows');
    eq(log[0].action, 'deactivate', 'newest first: deactivate');
    eq(log[1].action, 'activate', 'then activate');
    eq(log[2].action, 'verify', 'then verify');
    eq(log[0].actor, 'alice', 'actor recorded');
    eq(log[3].action, 'register', 'then register');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 2. Duplicate ids ─────────────────────────────────────────────────────

test('duplicate id: identical re-registration is idempotent (same service, no second row)', () => {
  const registry = createServiceRegistry();
  const a = registry.register(validInput({ id: 'svc_dup' }));
  ok(a.ok, 'first register');
  const b = registry.register(validInput({ id: 'svc_dup' }));
  ok(b.ok, 'identical re-register is ok');
  eq(b.service.id, 'svc_dup', 'same id');
  eq(registry.size(), 1, 'still one service');
  const c = registry.register(validInput({ id: 'svc_dup' }));
  ok(c.ok, 'third identical re-register is ok');
  eq(registry.size(), 1, 'still one service');
});

test('duplicate id: same id with different content is a conflict, never a silent overwrite', () => {
  const registry = createServiceRegistry();
  ok(registry.register(validInput({ id: 'svc_conflict' })).ok, 'first register');
  const b = registry.register(validInput({ id: 'svc_conflict', pricing: { amountMicroCcd: '99', asset: 'CCD', payTo: RECIPIENT } }));
  notOk(b.ok, 'conflicting re-register is rejected');
  if (!b.ok) {
    ok(b.errors.some(e => e.includes('already exists')), 'error names the duplicate');
  }
  eq(registry.get('svc_conflict')!.pricing.amountMicroCcd, '10', 'original content untouched');
});

test('duplicate id: the same rule holds on the persistent store', () => {
  const dir = tmpDir();
  try {
    const registry = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    ok(registry.register(validInput({ id: 'svc_persist-dup' })).ok, 'first register');
    registry.close();
    const reopened = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    const b = reopened.register(validInput({ id: 'svc_persist-dup' }));
    ok(b.ok, 'identical re-register after restart is idempotent');
    eq(reopened.size(), 1, 'still one row');
    const c = reopened.register(validInput({ id: 'svc_persist-dup', name: 'Renamed' }));
    notOk(c.ok, 'conflicting re-register after restart is rejected');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit ids are validated (must look like svc_<slug>)', () => {
  const bad = ['not-a-service-id', 'svc_', 'svc_has space', 'svc_'.padEnd(70, 'x')];
  for (const id of bad) {
    const errors = validateServiceInput(validInput({ id }));
    ok(errors.length > 0, `id '${id.slice(0, 20)}' is rejected`);
  }
  eq(validateServiceInput(validInput({ id: 'svc_price-feed_2' })).length, 0, 'svc_price-feed_2 is valid');
});

// ─── 3. Production verification adapter ───────────────────────────────────

test('production verifier: TRUSTED card + record → verified', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_trusted' }));
  const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchServing(CARD()) });
  const v = await registry.verifyProvider('svc_trusted', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'verified', 'verified');
  eq(v.service.providerVerification.decision, 'TRUSTED', 'TRUSTED');
  ok(v.service.providerVerification.checkedAt !== undefined, 'checkedAt stored');
});

test('production verifier: tampered card → REJECTED (hash mismatch is a contradiction, never TRUSTED)', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_tampered' }));
  const tampered = CARD();
  tampered[100] = (tampered[100]! + 1) % 256;
  const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchServing(tampered) });
  const v = await registry.verifyProvider('svc_tampered', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'rejected', 'rejected');
  eq(v.service.providerVerification.decision, 'REJECTED', 'REJECTED');
});

test('production verifier: card fetch failing (503) → INCONCLUSIVE → unverified, never verified', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_unavailable' }));
  const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchFailing(503) });
  const v = await registry.verifyProvider('svc_unavailable', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'unverified', 'unverified');
  eq(v.service.providerVerification.decision, 'INCONCLUSIVE', 'INCONCLUSIVE');
});

test('production verifier: card fetch throwing → INCONCLUSIVE → unverified', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_throwing' }));
  const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchThrowing() });
  const v = await registry.verifyProvider('svc_throwing', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'unverified', 'unverified');
});

test('production verifier: registry lookup throwing → INCONCLUSIVE, never TRUSTED', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_mcp-down' }));
  const verifier = createProductionVerifier({ mcp: stubMcpThrowing(), fetchImpl: fetchServing(CARD()) });
  const v = await registry.verifyProvider('svc_mcp-down', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'unverified', 'unverified');
  eq(v.service.providerVerification.decision, 'INCONCLUSIVE', 'INCONCLUSIVE');
});

test('production verifier: a hung registry lookup is cut off by the deadline → INCONCLUSIVE', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_hung' }));
  const verifier = createProductionVerifier({ mcp: stubMcpHanging(), fetchImpl: fetchServing(CARD()), timeoutMs: 100 });
  const v = await registry.verifyProvider('svc_hung', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'unverified', 'unverified');
  ok((v.service.providerVerification.reason ?? '').includes('deadline'), 'reason names the deadline');
});

test('production verifier: a provider with no agentUri can never become verified', async () => {
  const registry = createServiceRegistry();
  registry.register(validInput({ id: 'svc_no-card', provider: { tokenId: 1004, ownerAccount: SENDER, agentUri: null } }));
  // Even a verifier that would return TRUSTED cannot verify a provider with no card.
  const alwaysTrusted = async () => ({ decision: 'TRUSTED' as const, reason: 'stub' });
  const v = await registry.verifyProvider('svc_no-card', alwaysTrusted);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'unverified', 'unverified');
  eq(v.service.providerVerification.decision, 'INCONCLUSIVE', 'INCONCLUSIVE, not TRUSTED');
});

test('production verifier: owner mismatch is REJECTED (the record pins the owner)', async () => {
  const registry = createServiceRegistry();
  const wrongOwner = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
  registry.register(validInput({ id: 'svc_wrong-owner', provider: { tokenId: 1004, ownerAccount: wrongOwner, agentUri: CARD_URI } }));
  const verifier = createProductionVerifier({ mcp: stubMcp(RECORD_1004), fetchImpl: fetchServing(CARD()) });
  const v = await registry.verifyProvider('svc_wrong-owner', verifier);
  ok(v.ok, 'verify ok');
  eq(v.service.providerVerification.status, 'rejected', 'rejected');
});

// ─── 4. Storage failure ───────────────────────────────────────────────────

test('storage failure: a database path in a missing directory fails loudly at open (not as an empty registry)', () => {
  const dir = tmpDir();
  try {
    let threw = false;
    try {
      new SqliteServiceStore(join(dir, 'no-such-dir', 'discovery.db'));
    } catch (e) {
      threw = true;
      ok((e as Error).message.length > 0, 'error has a message');
    }
    ok(threw, 'open throws');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage failure: a read-only database file makes registration fail closed (no phantom service)', () => {
  const dir = tmpDir();
  try {
    const path = dbPath(dir);
    const registry = createServiceRegistry(new SqliteServiceStore(path));
    ok(registry.register(validInput({ id: 'svc_before' })).ok, 'seed one service');
    registry.close();
    // Make the database (and its WAL) read-only.
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${path}${suffix}`;
      if (existsSync(p)) chmodSync(p, 0o444);
    }
    let openFailed = false;
    let registerFailed = false;
    try {
      const reopened = createServiceRegistry(new SqliteServiceStore(path));
      const r = reopened.register(validInput({ id: 'svc_after' }));
      if (!r.ok) registerFailed = r.errors.some(e => e.includes('storage failure'));
      // The pre-existing service must still be readable; the new one must not exist.
      ok(reopened.get('svc_before') !== undefined, 'existing service still readable');
      ok(reopened.get('svc_after') === undefined, 'no phantom service');
      eq(reopened.size(), 1, 'still one service');
      reopened.close();
    } catch {
      // The open itself failing is also a fail-closed outcome (the operator is
      // told, loudly, that the database cannot be used).
      openFailed = true;
    }
    ok(openFailed || registerFailed, 'the failure is reported, not swallowed');
  } finally {
    // Restore write permission so the temp dir can be removed.
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbPath(dir)}${suffix}`;
      try {
        if (existsSync(p)) chmodSync(p, 0o600);
      } catch { /* best-effort */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 5. Operator CLI ──────────────────────────────────────────────────────

test('operator CLI: register (inactive) → list (hidden) → show → activate rejected (unverified) → deactivate → audit', () => {
  const dir = tmpDir();
  const db = dbPath(dir);
  try {
    const reg = cliJson([
      'register',
      '--name', 'Testnet Price Feed',
      '--description', 'Live CCD price ticks from Concordium Testnet.',
      '--category', 'data',
      '--endpoint', 'https://api.example.com/price',
      '--token-id', '1004',
      '--owner', SENDER,
      '--agent-uri', CARD_URI,
      '--amount', '10',
      '--pay-to', RECIPIENT,
      '--id', 'svc_cli-feed',
      '--actor', 'alice',
      '--db', db,
    ]);
    eq(reg.status, 0, 'register exits 0');
    eq(reg.json?.id, 'svc_cli-feed', 'registered id');
    eq(reg.json?.status, 'inactive', 'registration always creates an inactive service');
    eq(reg.json?.providerVerification?.status, 'registered', 'fresh verification is registered');

    // The default list hides inactive services; status=all shows it.
    const list = cliJson(['list', '--db', db]);
    eq(list.status, 0, 'list exits 0');
    eq(list.json?.total, 0, 'default list hides the inactive service');
    const listAll = cliJson(['list', '--status', 'all', '--db', db]);
    eq(listAll.json?.total, 1, 'status=all shows it');

    const show = cliJson(['show', '--id', 'svc_cli-feed', '--db', db]);
    eq(show.status, 0, 'show exits 0');
    eq(show.json?.name, 'Testnet Price Feed', 'show returns the service');

    // Activation requires TRUSTED verification. The service was never
    // verified, so `activate` is refused (exit 1) and the service stays
    // inactive. (A successful activation is covered by the `onboard`
    // command and by the activation-policy suite's library tests.)
    const act = cliJson(['activate', '--id', 'svc_cli-feed', '--actor', 'alice', '--db', db]);
    eq(act.status, 1, 'activate exits 1 (not verified)');
    ok(act.stderr.includes('not TRUSTED') || act.stderr.includes('verification'), 'error names the verification guard');

    const deact = cliJson(['deactivate', '--id', 'svc_cli-feed', '--actor', 'alice', '--db', db]);
    eq(deact.status, 0, 'deactivate exits 0');
    eq(deact.json?.status, 'inactive', 'still inactive');

    const audit = cliJson(['audit', '--id', 'svc_cli-feed', '--db', db]);
    eq(audit.status, 0, 'audit exits 0');
    eq(audit.json?.total, 2, 'two audit rows (register, refused activate)');
    const actions = (audit.json?.entries as Array<{ action: string }>).map(e => e.action);
    ok(actions.includes('register') && actions.includes('activate'), 'register and the refused activate are recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator CLI: invalid registration is rejected (exit 1, no service created)', () => {
  const dir = tmpDir();
  const db = dbPath(dir);
  try {
    const bad = runCli([
      'register',
      '--name', 'Bad',
      '--description', 'Bad category.',
      '--category', 'not-a-category',
      '--endpoint', 'https://api.example.com/price',
      '--token-id', '1004',
      '--owner', SENDER,
      '--amount', '10',
      '--pay-to', RECIPIENT,
      '--db', db,
    ]);
    eq(bad.status, 1, 'invalid register exits 1');
    ok(bad.stderr.includes('category'), 'error names the category');
    const list = cliJson(['list', '--db', db]);
    eq(list.json?.total, 0, 'no service created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator CLI: unknown service and unknown command fail with exit 1', () => {
  const dir = tmpDir();
  const db = dbPath(dir);
  try {
    const show = runCli(['show', '--id', 'svc_nope', '--db', db]);
    eq(show.status, 1, 'show of an unknown service exits 1');
    const unknown = runCli(['frobnicate', '--db', db]);
    eq(unknown.status, 1, 'unknown command exits 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator CLI: a database in a missing directory fails loudly (exit 1)', () => {
  const dir = tmpDir();
  try {
    const r = runCli(['list', '--db', join(dir, 'no-such-dir', 'discovery.db')]);
    eq(r.status, 1, 'list exits 1');
    ok(r.stderr.includes('cannot open'), 'error names the database problem');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. Unauthorized registration attempts ─────────────────────────────────

test('unauthorized: the public Discovery API still has no write path (POST → 405 on the persistent registry)', async () => {
  const dir = tmpDir();
  const registry = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
  registry.register(validInput({ id: 'svc_http' }));
  try {
    // handleDiscoveryRequest only reads method + url; no body is ever read
    // (there is no write path to feed a body into).
    const req = (method: string, url: string) => ({ method, url }) as never;
    const post = handleDiscoveryRequest(registry, req('POST', '/api/services'));
    ok(post !== null, 'POST is routed');
    eq(post!.status, 405, 'POST → 405');
    eq(registry.size(), 1, 'no service created by the POST');
    const put = handleDiscoveryRequest(registry, req('PUT', '/api/services/svc_http'));
    eq(put!.status, 405, 'PUT → 405');
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unauthorized: MCP exposes no service-registration tool', () => {
  const names = TOOLS.map(t => t.name);
  const forbidden = ['register_service', 'discovery.register', 'discovery.activate', 'discovery.deactivate', 'discovery.verify'];
  for (const f of forbidden) {
    notOk(names.includes(f), `no MCP tool named ${f}`);
  }
  // No existing tool's description offers to register a service either.
  for (const t of TOOLS) {
    notOk(/register (a|an) service/i.test(t.description), `${t.name} does not offer service registration`);
  }
});

// ─── 7. Discovery + x402 regression on the persistent registry ─────────────

test('regression: Discovery list/detail + /protected 402/200 behave identically on the persistent registry', async () => {
  const dir = tmpDir();
  const store = new SqliteServiceStore(dbPath(dir));
  const registry = createServiceRegistry(store);
  registry.register(validInput({ id: 'svc_regression' }));
  // The first service must be active to appear in the default list:
  // verify it (stub TRUSTED) and activate it.
  await registry.verifyProvider('svc_regression', async () => ({ decision: 'TRUSTED', reason: 'test stub' }));
  registry.setStatus('svc_regression', 'active');
  // The second service stays inactive (registration always creates
  // inactive; there is no status field to pass anymore).
  registry.register(validInput({ id: 'svc_regression-off', name: 'Old Feed', description: 'Deprecated.', endpoint: 'https://api.example.com/old', pricing: { amountMicroCcd: '5', asset: 'CCD', payTo: RECIPIENT } }));
  try {
    const resourceUrl = 'http://127.0.0.1:4592/protected';
    const requirements = buildPaymentRequirements({
      payTo: RECIPIENT, amountMicroCcd: '1', maxTimeoutSeconds: 300, resourceUrl, feePayer: SPONSOR, network: CAIP2,
    });
    const provider = createX402Provider(
      { requirements, resourceUrl, description: 'Protected', resource: { secret: 'data' } },
      {
        facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: 'ab'.repeat(32), network: CAIP2 }) } as never,
        chain: { readTransfer: async () => ({ status: 'finalized' as const, sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: CAIP2, blockHash: 'cd'.repeat(32), failed: false }) },
      },
      { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore(), expectSender: SENDER, expectSponsor: SPONSOR },
    );
    const started = await startX402ResourceServer({ provider, resourcePath: '/protected', host: '127.0.0.1', port: 4592, discovery: registry });
    try {
      // Discovery over HTTP, served from the persistent registry.
      const listRes = await fetch('http://127.0.0.1:4592/api/services');
      eq(listRes.status, 200, 'list 200');
      const listBody = await listRes.json() as { total: number; services: Array<Record<string, unknown>> };
      eq(listBody.total, 1, 'default list shows only the active service');
      eq(listBody.services[0]!.id, 'svc_regression', 'active service listed');

      const detailRes = await fetch('http://127.0.0.1:4592/api/services/svc_regression');
      const detail = await detailRes.json() as Record<string, unknown>;
      eq(detailRes.status, 200, 'detail 200');
      eq((detail.pricing as Record<string, unknown>).amountMicroCcd, '10', 'price correct');
      ok(detail.paymentRequirements !== undefined, 'active service has paymentRequirements');
      const reqs = detail.paymentRequirements as Record<string, unknown>;
      eq(reqs.amount, '10', 'requirement amount matches pricing');
      eq(reqs.payTo, RECIPIENT, 'requirement payTo matches pricing');
      eq((reqs.extra as Record<string, unknown>).feePayer, undefined, 'no invented feePayer');

      const offRes = await fetch('http://127.0.0.1:4592/api/services/svc_regression-off');
      const off = await offRes.json() as Record<string, unknown>;
      eq(off.available, false, 'inactive service is not available');
      eq(off.paymentRequirements, undefined, 'inactive service has no paymentRequirements');

      // /protected still 402 unpaid, 200 paid (same envelope shape as the
      // MVP suite's test 33: the payload itself is the X-PAYMENT header).
      const unpaid = await fetch('http://127.0.0.1:4592/protected');
      eq(unpaid.status, 402, 'unpaid → 402');
      const payload = {
        x402Version: 2,
        accepted: requirements,
        payload: { signedTransaction: { version: 1, header: { expiry: Math.floor(Date.now() / 1000) + 200 } } },
        resource: { url: resourceUrl },
        requestId: 'req-1',
      };
      const paid = await fetch('http://127.0.0.1:4592/protected', { headers: { 'x-payment': JSON.stringify(payload) } });
      eq(paid.status, 200, 'paid → 200');
      ok(paid.headers.get('PAYMENT-RESPONSE') !== null, 'PAYMENT-RESPONSE present');
    } finally {
      await started.close();
    }

    // Restart: close the registry, reopen it, and confirm the services are
    // still there (the HTTP layer above read from the same durable rows).
    registry.close();
    const reopened = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    eq(reopened.size(), 2, 'two services after restart');
    eq(reopened.get('svc_regression')!.status, 'active', 'active survives');
    eq(reopened.get('svc_regression-off')!.status, 'inactive', 'inactive survives');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: an in-memory registry and a persistent registry return the same Discovery view', () => {
  const dir = tmpDir();
  try {
    const mem = createServiceRegistry(createMemoryServiceStore());
    const sql = createServiceRegistry(new SqliteServiceStore(dbPath(dir)));
    mem.register(validInput({ id: 'svc_same' }));
    sql.register(validInput({ id: 'svc_same' }));
    const memList = mem.list();
    const sqlList = sql.list();
    eq(sqlList.total, memList.total, 'same total');
    const memDetail = mem.get('svc_same')!;
    const sqlDetail = sql.get('svc_same')!;
    eq(sqlDetail.name, memDetail.name, 'same name');
    eq(sqlDetail.providerVerification.status, memDetail.providerVerification.status, 'same verification');
    eq(sqlDetail.pricing.amountMicroCcd, memDetail.pricing.amountMicroCcd, 'same price');
    sql.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── runner ───────────────────────────────────────────────────────────────

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
console.log(`\ndiscovery-onboarding: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
