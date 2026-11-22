/**
 * Live registry card contract (frontend): the provider card rendered from
 * GET /api/services must describe the registry's RECORDED verification
 * decision and its checkedAt timestamp, never imply a fresh verification
 * performed by the page, and never throw when a service's verification
 * fields are absent.
 *
 * Static analysis + extracted-function probes only — no browser, no server,
 * no live API. Tests 01–04 probe the card/badge builder; tests 05–10 run
 * the production `loadLiveRegistry` through a stub-DOM/stub-fetch harness
 * (verifiedCount regression). The harness uses the production schema
 * validator by default; a permissive validator stand-in — requiring only
 * a services array — is used solely for the mixed/null/missing
 * verification scenarios in tests 06, 08, 09, and 10.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

function extractFunctionSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  ok(start >= 0, `function ${name} exists`);
  let depth = 0;
  for (let j = html.indexOf('{', start); j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const escapeHtml = new Function(`return ${extractFunctionSource('escapeHtml')}`)() as unknown as (s: unknown) => string;
const getServiceVerificationBadge = new Function(
  `return ${extractFunctionSource('getServiceVerificationBadge')}`,
)() as unknown as (s: unknown) => { badgeHtml: string; labelText: string };
const buildLiveServiceCardHTML = new Function(
  'escapeHtml', 'getServiceVerificationBadge',
  `return ${extractFunctionSource('buildLiveServiceCardHTML')}`,
)(escapeHtml, getServiceVerificationBadge) as unknown as (s: unknown) => string;

// The live registered service, shaped like the GET /api/services record.
const liveService = {
  id: 'svc_agenttrust_x402',
  name: 'AgentTrust',
  category: 'utility',
  description: 'AgentTrust x402 service.',
  endpoint: 'https://api.sabokun.my.id/agenttrust/protected',
  provider: { tokenId: 1004, ownerAccount: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', agentUri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json' },
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  pricing: { amountMicroCcd: '1', asset: 'CCD', payTo: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB', maxTimeoutSeconds: 300 },
  status: 'active',
  available: true,
  providerVerification: { status: 'verified', decision: 'TRUSTED', checkedAt: '2026-11-21T12:51:25.791Z', reason: 'provider Agent Card passed full verification (TRUSTED)' },
};

test('01. a verified service shows the recorded decision and timestamp, not a fresh check', () => {
  const card = buildLiveServiceCardHTML(liveService);
  ok(card.includes('TRUSTED'), 'card shows the recorded decision');
  ok(card.includes('2026-11-21T12:51:25.791Z'), 'card shows the recorded checkedAt');
  ok(card.includes('VERIFIED · RECORDED'), 'badge says recorded, not live');
  ok(card.includes('does not perform a fresh provider verification'), 'card states no fresh verification happens here');
  notOk(card.includes('VERIFIED · LIVE'), 'no live-verification badge');
});

test('02. a service without providerVerification renders "not recorded" instead of throwing (Sol v3 regression)', () => {
  const bare = { ...liveService, providerVerification: null };
  let card: string;
  try {
    card = buildLiveServiceCardHTML(bare);
  } catch (e) {
    throw new Error(`card render threw on a missing providerVerification: ${String(e)}`);
  }
  ok(card.includes('not recorded'), 'missing verification decision renders as not recorded');
  notOk(card.includes('undefined'), 'no raw undefined in the card');
});

test('03. a service with verification present but decision/checkedAt absent renders "not recorded"', () => {
  const partial = { ...liveService, providerVerification: { status: 'verified' } };
  const card = buildLiveServiceCardHTML(partial);
  eq((card.match(/not recorded/g) ?? []).length, 2, 'decision and checkedAt both read not recorded');
  notOk(card.includes('undefined'), 'no raw undefined in the card');
});

test('04. the verification badge never claims a live check for a verified service', () => {
  const badge = getServiceVerificationBadge(liveService);
  eq(badge.labelText, 'VERIFIED — RECORDED STATUS', 'badge label names recorded status');
  ok(badge.badgeHtml.includes('VERIFIED · RECORDED'), 'badge HTML names recorded status');
});

// ═══ loader harness (verifiedCount regression) ═══════════════════════════
// The production loader `loadLiveRegistry`, extracted verbatim and run
// against a stub document and a stub fetch — the same extraction pattern
// as the live-tx-kpi loader harness. The harness body is assembled with
// array join, not a template literal: the extracted loader source
// contains backticks and ${...}, which would terminate or interpolate an
// outer template literal.
//
// The loader's module-level state (abort controller, category filter,
// search input) is declared inside the assembled body, exactly as the
// live-tx-kpi harness declares the loader's module-level state.
//
// The schema validator is swappable. By default the real production
// `isValidLiveRegistryResponse` is extracted; `validator: 'permissive'`
// substitutes a stand-in that only requires a services array. The
// stand-in is needed for the mixed-verification scenarios: the
// production validator is strict by design and rejects a whole response
// when ANY record lacks a valid providerVerification (INVALID RESPONSE),
// so a null/missing-verification record never reaches the count
// computation through the real validator. The guard under test protects
// the count computation itself — it must never throw whatever reaches
// it — and the permissive validator is how the test drives mixed data
// to that computation through the real loader path.

type Verification = { status: string; decision: string; checkedAt: string; reason: string };
type RegistryServiceRecord = Omit<typeof liveService, 'providerVerification'> & {
  providerVerification: Verification | null;
};
type SvcOverrides = Partial<Pick<RegistryServiceRecord, 'id' | 'name' | 'status' | 'available' | 'providerVerification'>>;

let svcSeq = 0;
const svc = (overrides: SvcOverrides = {}): RegistryServiceRecord => {
  svcSeq++;
  return { ...liveService, id: `svc_test_${svcSeq}`, name: `Test Service ${svcSeq}`, ...overrides };
};
const noVerification = <T extends object>(rec: T): T => {
  delete (rec as Record<string, unknown>).providerVerification;
  return rec;
};
const verified = (decision = 'TRUSTED'): Verification => ({
  status: 'verified', decision, checkedAt: '2026-11-21T12:51:25.791Z', reason: 'ok',
});

type RegistryLoaderHarness = {
  load: () => Promise<void>;
  panelState: () => string | undefined;
  badgeHtml: () => string;
  listHtml: () => string;
  fetchCalls: () => number;
};

function makeRegistryLoaderHarness(opts: {
  response?: unknown;
  validator?: 'real' | 'permissive';
} = {}): RegistryLoaderHarness {
  const panel = {
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
  };
  const list = {
    _html: '',
    set innerHTML(v: string) { this._html = v; },
    get innerHTML() { return this._html; },
  };
  const status = { textContent: '' };
  const badgeSlot = {
    _html: '',
    set innerHTML(v: string) { this._html = v; },
    get innerHTML() { return this._html; },
  };
  const retryBtn = { addEventListener() {} };
  const documentStub = {
    getElementById: (id: string) =>
      id === 'live-registry-panel' ? panel
      : id === 'live-registry-list' ? list
      : id === 'live-registry-status' ? status
      : id === 'live-registry-badge-slot' ? badgeSlot
      : id === 'retry-live-registry-btn' ? retryBtn
      : null,
    querySelectorAll: () => [] as unknown[],
  };
  let fetchCalls = 0;
  const fetchStub = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => opts.response ?? { services: [] } };
  };
  const validatorSrc = opts.validator === 'permissive'
    ? 'function isValidLiveRegistryResponse(data) { return !!data && typeof data === "object" && Array.isArray(data.services); }'
    : extractFunctionSource('isValidLiveRegistryResponse');
  const loaderSrc = extractFunctionSource('loadLiveRegistry');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const parts = [
    'let liveRegistryAbortController = null;',
    "let activeCategoryFilter = 'All';",
    'const categoryApiMap = {};',
    'let searchInput = null;',
    "const VALID_SERVICE_CATEGORIES = new Set(['data', 'compute', 'content', 'communication', 'utility', 'other']);",
    "const VALID_VERIFICATION_STATUSES = new Set(['registered', 'verified', 'rejected', 'unverified']);",
    extractFunctionSource('escapeHtml'),
    validatorSrc,
    extractFunctionSource('getServiceVerificationBadge'),
    extractFunctionSource('buildLiveServiceCardHTML'),
    extractFunctionSource('bindModalButtons'),
    asyncLoaderSrc,
    'return { loadLiveRegistry };',
  ];
  const harness = new Function('document', 'fetch', 'apiUrl', parts.join('\n'))
    (documentStub, fetchStub, (p: string) => p) as unknown as {
      loadLiveRegistry: () => Promise<void>;
    };
  return {
    load: () => harness.loadLiveRegistry(),
    panelState: () => panel.attrs['data-registry-state'],
    badgeHtml: () => badgeSlot._html,
    listHtml: () => list._html,
    fetchCalls: () => fetchCalls,
  };
}

const cardCount = (h: RegistryLoaderHarness) => (h.listHtml().match(/vapi-provider-card/g) ?? []).length;

test('05. all records verified: the loader renders every card and counts them all', async () => {
  const records = [svc({ providerVerification: verified() }), svc({ providerVerification: verified() })];
  const h = makeRegistryLoaderHarness({ response: { services: records } });
  await h.load();
  eq(h.panelState(), 'live', 'panel is live when verified services exist');
  ok(h.badgeHtml().includes('2 ACTIVE &amp; AVAILABLE · VERIFIED (RECORDED)'), 'badge counts both verified services');
  eq(cardCount(h), 2, 'both cards render');
  for (const rec of records) ok(h.listHtml().includes(rec.name), `card for ${rec.name} renders`);
});

test('06. a mixed list (verified, null, missing verification) renders every card and counts only the verified one', async () => {
  const records = [
    svc({ providerVerification: verified() }),
    svc({ providerVerification: null }),
    noVerification(svc()),
  ];
  const h = makeRegistryLoaderHarness({ response: { services: records }, validator: 'permissive' });
  await h.load();
  eq(h.panelState(), 'live', 'panel is live: one verified service exists');
  ok(h.badgeHtml().includes('1 ACTIVE &amp; AVAILABLE · VERIFIED (RECORDED)'), 'badge counts exactly the one verified service');
  eq(cardCount(h), 3, 'all three cards render');
  for (const rec of records) ok(h.listHtml().includes(rec.name), `card for ${rec.name} renders`);
  notOk(h.listHtml().includes('registry-error-box'), 'no error box: one bad record does not fail the list');
});

test('07. no verified records: the loader renders the list and reports zero verified', async () => {
  const records = [
    svc({ providerVerification: { ...verified(), status: 'registered', decision: 'PENDING' } }),
    svc({ providerVerification: { ...verified(), status: 'unverified', decision: 'NONE' } }),
    svc({ status: 'inactive', providerVerification: verified() }),
  ];
  const h = makeRegistryLoaderHarness({ response: { services: records } });
  await h.load();
  eq(h.panelState(), 'available', 'panel is available when nothing is verified');
  ok(h.badgeHtml().includes('3 RETURNED · 0 ACTIVE, AVAILABLE &amp; VERIFIED'), 'badge reports zero verified');
  eq(cardCount(h), 3, 'all three cards render');
});

test('08. a single record without verification does not crash the loader', async () => {
  const rec = noVerification(svc());
  const h = makeRegistryLoaderHarness({ response: { services: [rec] }, validator: 'permissive' });
  let threw: unknown = null;
  try {
    await h.load();
  } catch (e) {
    threw = e;
  }
  eq(threw, null, 'loader resolves without throwing');
  eq(cardCount(h), 1, 'the record still renders');
  ok(h.badgeHtml().includes('1 RETURNED · 0 ACTIVE, AVAILABLE &amp; VERIFIED'), 'zero verified is reported');
});

test('09. verified count is exact across the verified-condition matrix', async () => {
  const records = [
    svc({ status: 'active', available: true, providerVerification: verified() }),
    svc({ status: 'active', available: true, providerVerification: { ...verified(), status: 'registered' } }),
    svc({ status: 'inactive', available: true, providerVerification: verified() }),
    svc({ status: 'active', available: false, providerVerification: verified() }),
    svc({ status: 'active', available: true, providerVerification: null }),
    noVerification(svc({ status: 'active', available: true })),
  ];
  const h = makeRegistryLoaderHarness({ response: { services: records }, validator: 'permissive' });
  await h.load();
  ok(h.badgeHtml().includes('1 ACTIVE &amp; AVAILABLE · VERIFIED (RECORDED)'), 'exactly one record counts as verified');
  eq(cardCount(h), 6, 'all six records render');
});

test('10. every valid record in a mixed list is rendered', async () => {
  const records = [
    svc({ providerVerification: verified() }),
    svc({ providerVerification: null }),
    noVerification(svc()),
    svc({ providerVerification: { ...verified(), status: 'registered', decision: 'PENDING' } }),
  ];
  const h = makeRegistryLoaderHarness({ response: { services: records }, validator: 'permissive' });
  await h.load();
  for (const rec of records) ok(h.listHtml().includes(rec.name), `card for ${rec.name} renders`);
  eq(cardCount(h), records.length, 'card count equals record count');
});

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nlive-registry-card: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
