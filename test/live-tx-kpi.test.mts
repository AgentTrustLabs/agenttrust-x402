/**
 * Live transaction KPI contract (frontend): the sidebar "x402 Records" beacon
 * must show the count of live facilitator settlement records from
 * GET /api/payments — the same dataset the Transactions table renders —
 * and never a hardcoded number.
 *
 * Asserts, on the page markup and the list loader code:
 *   - the beacon KPI is `<span id="live-tx-count">—</span> Records`: the
 *     number is a live element, the loading state is "—" (not 0, not a
 *     stale hardcoded count), and "4 Records" appears nowhere;
 *   - the KPI is updated from the same /api/payments payload the table
 *     renders, with no extra request: the list still fetches from a
 *     single call site, and the KPI updater is called on the render path,
 *     on the initial-empty path, and on an empty refresh that finds no
 *     successful snapshot yet (INT-01);
 *   - the KPI always equals the number of rows actually shown: a failed
 *     or unchanged refresh returns before any KPI write, so the last
 *     valid count stays; an empty initial load shows 0; an initial load
 *     failure leaves "—".
 *
 * Behavioural probes run the extracted loader against stubbed DOM/fetch
 * (same harness pattern as the refresh check): no browser, no server, no
 * live API. The table HTML itself is stubbed to N rows; rendering is
 * covered by payment-list-view.test.mts and the render check.
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

// ── static: the KPI element ──────────────────────────────────────────────────

test('01. the beacon KPI is a live element, not a hardcoded count', () => {
  const beacon = html.indexOf('x402 Records');
  ok(beacon >= 0, 'x402 Records beacon row exists');
  const kpi = html.indexOf('id="live-tx-count"', beacon);
  ok(kpi > beacon, 'KPI element lives in the beacon row');
  ok(kpi - beacon < 500, 'KPI element is the beacon value, not elsewhere');
  ok(html.includes('<span id="live-tx-count">—</span> Records'), 'KPI reads "— Records" before the first load');
  notOk(html.includes('4 Records'), 'no hardcoded "4 Records" anywhere');
  notOk(html.includes('>4 Records<'), 'no hardcoded count in the beacon');
});

test('02. the KPI adds no API request', () => {
  const fetches = (html.match(/fetch\(apiUrl\('\/api\/payments'\)\)/g) ?? []).length;
  eq(fetches, 1, 'one list fetch in the whole page');
  ok(html.includes('function updateLiveTxKpi'), 'KPI updater exists');
  const updater = extractFunctionSource('updateLiveTxKpi');
  ok(updater.includes("document.getElementById('live-tx-count')"), 'updater targets the KPI element');
  ok(updater.includes('payments.length'), 'updater counts the payload records');
  notOk(updater.includes('fetch('), 'updater fetches nothing itself');
});

test('03. the loader updates the KPI exactly where the table renders', () => {
  const loader = extractFunctionSource('loadLiveTxTable');
  const calls = (loader.match(/updateLiveTxKpi\(payments\)/g) ?? []).length;
  // Three call sites, four behaviours: the empty path serves both the
  // initial-empty load and an empty refresh that finds no successful
  // snapshot yet (INT-01); the empty-repair path serves an empty refresh
  // while the display is repair-required (PM-01 follow-up); the render
  // path serves non-empty loads.
  eq(calls, 3, 'three KPI update sites: empty, empty-repair, and render');
  ok(loader.includes('hasSuccessfulLiveTxSnapshot'), 'loader tracks whether a successful snapshot exists');
  ok(loader.includes('if (isRefresh && hasSuccessfulLiveTxSnapshot)'), 'an empty refresh retains last-good only when a snapshot exists');
  ok(loader.includes('if (!liveTxDisplayRepairRequired)'), 'the unchanged shortcut is gated on content consistency');
  ok(loader.includes('if (liveTxDisplayRepairRequired)'), 'an empty refresh repairs instead of retaining when repair is required');
  ok(loader.indexOf('updateLiveTxKpi(payments)') > loader.lastIndexOf('if (isRefresh) return;'),
    'every failure guard returns before any KPI write');
  // The unchanged-signature shortcut is a block now (it recovers missing
  // listeners before returning), so check the branch exists and returns
  // before the render, not the old one-line form.
  const unchangedAt = loader.indexOf('if (isRefresh && signature === lastLiveTxSignature)');
  ok(unchangedAt >= 0, 'unchanged refresh is detected before the render');
  ok(loader.indexOf('return;', unchangedAt) < loader.indexOf('const prev = captureLiveTxSnapshot();', unchangedAt),
    'unchanged refresh returns before the render KPI write');
});

// ── behavioural probes: the loader against stubbed DOM/fetch ────────────────

type FixturePayment = {
  paymentDigest: string;
  transactionHash: string;
  state: string;
  updatedAt: number;
  blockHeight: string;
  amount: string;
  sponsorFeeMicroCcd: string;
  sender: string;
  recipient: string;
};

const pay = (digest: string, state = 'finalized', updatedAt = 1000): FixturePayment => ({
  paymentDigest: digest,
  transactionHash: digest,
  state,
  updatedAt,
  blockHeight: '51107042',
  amount: '1',
  sponsorFeeMicroCcd: '5100146',
  sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
  recipient: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
});

const base5 = (): FixturePayment[] => ['a', 'b', 'c', 'd', 'e'].map((c, i) => pay(c.repeat(64), 'finalized', 1000 + i));

// A payment carrying the full live-verification evidence the proof gate
// requires (available + finalized + observed finalized + non-empty source +
// 64-hex block hash), with the stored state finalized.
const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
const payEv = (digest: string, state = 'finalized', updatedAt = 1000) => ({
  ...pay(digest, state, updatedAt),
  finalized: true,
  verification: { ...evidence },
});

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

// A promise whose resolve/reject the test controls, for deterministic
// out-of-order request tests (INT-03): no real network, no timers.
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeHarness(opts: { fetchImpl?: FetchLike } = {}) {
  const mount = {
    _html: '',
    sets: 0,
    set innerHTML(v: string) { this._html = v; this.sets++; },
    get innerHTML() { return this._html; },
    querySelectorAll() { return [] as unknown[]; },
  };
  const kpi = { textContent: '—', title: '' };
  const summary = { textContent: '' };
  let pageActive = true;
  let tabHidden = false;
  const documentStub = {
    getElementById: (id: string) =>
      (id === 'live-tx-table-mount' ? mount : id === 'live-tx-count' ? kpi : id === 'live-payment-summary' ? summary : null),
    querySelector: (sel: string) => (sel === '#page-transactions.active' && pageActive ? {} : null),
    querySelectorAll: () => [] as unknown[],
    get hidden() { return tabHidden; },
  };
  let fetchCalls = 0;
  let nextPayload: unknown = null;
  let fetchFails = false;
  const fetchStub = async () => {
    fetchCalls++;
    if (fetchFails) throw new Error('network down');
    return { ok: true, json: async () => nextPayload };
  };
  const buildStub = (payments: unknown[]) => '<tr class="clickable-tx">'.repeat(payments.length);
  // The loader is `async function` in the page; extractFunctionSource strips
  // the `async` keyword, so restore it before executing the extracted code.
  // updateLiveTxKpi derives its summary from liveProofProgress and reports
  // through setLivePaymentStatus, which reads the module-level
  // lastLivePaymentSummary — all three must be in the harness scope, or the
  // loader throws a ReferenceError on its first update. The same holds for
  // the INT-01 snapshot flag and the INT-03 request-generation counter,
  // which the loader reads as module-level variables. The PM-01 follow-up
  // adds the archive-surface list, the listener WeakSets, and the
  // need-rebind flags, plus the archive binder and the restore-error
  // reporter — the loader, capture, and restore all read them.
  const loaderSrc = extractFunctionSource('loadLiveTxTable');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const harness = new Function('document', 'fetch', 'apiUrl', 'buildLiveTxTableHTML', 'applyArchiveDedup', 'location',
    `let lastLiveTxSignature = null;\nlet lastLivePaymentSummary = '';\nlet hasSuccessfulLiveTxSnapshot = false;\nlet liveTxRequestSeq = 0;\nlet liveTxDisplayRepairRequired = false;\nlet liveTxRestoreFailedStep = null;\nlet liveTxRestoreFailedDetail = null;\nconst ARCHIVE_SURFACE_IDS = ['dashboard-tx-table-mount', 'transactions-page-table-mount', 'wallet-tx-table-mount', 'tx-podium-grid', 'tx-block-ribbon'];\nconst boundLiveTxRows = new WeakSet();\nconst boundArchiveRows = new WeakSet();\nlet liveTxListenersNeedRebind = false;\nlet archiveListenersNeedRebind = false;\n${extractFunctionSource('liveProofProgress')}\n${extractFunctionSource('setLivePaymentStatus')}\n${extractFunctionSource('liveTxTableSignature')}\n${extractFunctionSource('updateLiveTxKpi')}\n${extractFunctionSource('bindLiveTxRowListeners')}\n${extractFunctionSource('bindArchiveRowListeners')}\n${extractFunctionSource('captureLiveTxSnapshot')}\n${extractFunctionSource('restoreLiveTxSnapshot')}\n${extractFunctionSource('reportLiveTxRenderError')}\n${extractFunctionSource('reportLiveTxRestoreError')}\n${asyncLoaderSrc}\n${extractFunctionSource('refreshLiveTxTable')}\nreturn { loadLiveTxTable, refreshLiveTxTable, updateLiveTxKpi, get lastLivePaymentSummary() { return lastLivePaymentSummary; } };`)
    (documentStub, opts.fetchImpl ?? fetchStub, (p: string) => p, buildStub, () => {}, { hash: '' }) as unknown as {
      loadLiveTxTable: (isRefresh?: boolean) => Promise<void>;
      refreshLiveTxTable: () => Promise<void> | void;
      updateLiveTxKpi: (payments: unknown[]) => void;
      readonly lastLivePaymentSummary: string;
    };
  const rows = () => (mount.innerHTML.match(/clickable-tx/g) ?? []).length;
  return {
    harness, mount, kpi, summary, rows,
    setPayload: (p: unknown) => { nextPayload = p; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setPageActive: (v: boolean) => { pageActive = v; },
    setTabHidden: (v: boolean) => { tabHidden = v; },
    fetchCalls: () => fetchCalls,
  };
}

// Same stubbed DOM/fetch as makeHarness, but the REAL production table
// renderer (buildLiveTxTableHTML) with every function it calls, extracted
// from web/prototype-v5-6.html — no stubbed rows. INT-02 tests use this
// harness so a rendering failure (or a bad timestamp) is exercised through
// the actual formatter and table builder, not a stand-in.
// The harness body is assembled with array join, not a template literal:
// the extracted renderer source contains backticks and ${...}, which
// would terminate or interpolate an outer template literal.
// applyArchiveDedup stays a no-op: the real one needs page globals
// (realTransactionsData/renderArchive) that do not exist here.
function makeRealRendererHarness(opts: { failFirstTableRender?: boolean } = {}) {
  const mount = {
    _html: '',
    sets: 0,
    _threw: false,
    set innerHTML(v: string) {
      if (opts.failFirstTableRender && !this._threw && v.includes('<table')) {
        this._threw = true;
        throw new Error('simulated render failure');
      }
      this._html = v; this.sets++;
    },
    get innerHTML() { return this._html; },
    querySelectorAll() { return [] as unknown[]; },
  };
  const kpi = { textContent: '—', title: '' };
  const summary = { textContent: '' };
  let pageActive = true;
  let tabHidden = false;
  const documentStub = {
    getElementById: (id: string) =>
      (id === 'live-tx-table-mount' ? mount : id === 'live-tx-count' ? kpi : id === 'live-payment-summary' ? summary : null),
    querySelector: (sel: string) => (sel === '#page-transactions.active' && pageActive ? {} : null),
    querySelectorAll: () => [] as unknown[],
    get hidden() { return tabHidden; },
  };
  let fetchCalls = 0;
  let nextPayload: unknown = null;
  let fetchFails = false;
  const fetchStub = async () => {
    fetchCalls++;
    if (fetchFails) throw new Error('network down');
    return { ok: true, json: async () => nextPayload };
  };
  const rendererFns = [
    'escapeHtml', 'liveProofProgress', 'liveRowStateBadge', 'shortAddr',
    'formatMicroCcd', 'formatBlockTimeWib', 'formatLiveBlock',
    'formatLiveAmount', 'formatLiveFee', 'formatLiveTxTime',
    'renderLiveProofProgress', 'ccdscanTxUrl', 'buildLiveTxTableHTML',
  ].map(extractFunctionSource);
  const loaderSrc = extractFunctionSource('loadLiveTxTable');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const parts = [
    'let lastLiveTxSignature = null;',
    "let lastLivePaymentSummary = '';",
    'let hasSuccessfulLiveTxSnapshot = false;',
    'let liveTxRequestSeq = 0;',
    'let liveTxDisplayRepairRequired = false;',
    'let liveTxRestoreFailedStep = null;',
    'let liveTxRestoreFailedDetail = null;',
    "const ARCHIVE_SURFACE_IDS = ['dashboard-tx-table-mount', 'transactions-page-table-mount', 'wallet-tx-table-mount', 'tx-podium-grid', 'tx-block-ribbon'];",
    'const boundLiveTxRows = new WeakSet();',
    'const boundArchiveRows = new WeakSet();',
    'let liveTxListenersNeedRebind = false;',
    'let archiveListenersNeedRebind = false;',
    ...rendererFns,
    extractFunctionSource('liveTxTableSignature'),
    extractFunctionSource('setLivePaymentStatus'),
    extractFunctionSource('updateLiveTxKpi'),
    extractFunctionSource('bindLiveTxRowListeners'),
    extractFunctionSource('bindArchiveRowListeners'),
    extractFunctionSource('captureLiveTxSnapshot'),
    extractFunctionSource('restoreLiveTxSnapshot'),
    extractFunctionSource('reportLiveTxRenderError'),
    extractFunctionSource('reportLiveTxRestoreError'),
    asyncLoaderSrc,
    extractFunctionSource('refreshLiveTxTable'),
    'return { loadLiveTxTable, refreshLiveTxTable, updateLiveTxKpi, formatLiveTxTime, buildLiveTxTableHTML };',
  ];
  const harness = new Function('document', 'fetch', 'apiUrl', 'applyArchiveDedup', 'location', parts.join('\n'))
    (documentStub, fetchStub, (p: string) => p, () => {}, { hash: '' }) as unknown as {
      loadLiveTxTable: (isRefresh?: boolean) => Promise<void>;
      refreshLiveTxTable: () => Promise<void> | void;
      updateLiveTxKpi: (payments: unknown[]) => void;
      formatLiveTxTime: (updatedAt: unknown) => string;
      buildLiveTxTableHTML: (payments: unknown[]) => string;
    };
  const rows = () => (mount.innerHTML.match(/clickable-tx/g) ?? []).length;
  return {
    harness, mount, kpi, summary, rows,
    setPayload: (p: unknown) => { nextPayload = p; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setPageActive: (v: boolean) => { pageActive = v; },
    setTabHidden: (v: boolean) => { tabHidden = v; },
    fetchCalls: () => fetchCalls,
  };
}

// Atomic-snapshot harness (PM-01): the real production renderer AND the
// real production applyArchiveDedup, so a late failure is a failure of
// production code at its actual call boundary — not a stubbed stand-in.
// The dedup's renderArchive dependency is the failure-injection boundary:
// the harness supplies a renderArchive that records its calls and throws
// when armed, and realTransactionsData carries archive rows whose hashes
// overlap the test payloads, so dedup genuinely runs (kept < all) and
// genuinely calls renderArchive. Listener binding is exercised through
// row stubs parsed from the rendered HTML (data-tx-hash), so a listener
// failure is also a failure inside the production bind step. The harness
// exposes the loader's committed state (signature, snapshot flag, stored
// summary) so tests can assert exactly what survived a failure.
function makeAtomicHarness() {
  const digestA = 'a'.repeat(64);
  const digestB = 'f'.repeat(64);
  const digestOther = 'z'.repeat(64);
  const state = { failDedup: false, failListeners: false, failEmptyRender: false };
  let binds = 0;
  let bindAttempts = 0;
  const dedupCalls: string[][] = [];
  const renderArchiveStub = (kept: Array<{ hash: string }>) => {
    dedupCalls.push(kept.map(t => t.hash));
    if (state.failDedup) throw new Error('simulated dedup failure');
  };
  const mount = {
    _html: '',
    sets: 0,
    // Row stubs are cached by tx hash and cleared on every innerHTML
    // assignment: an assignment destroys the old DOM nodes, so the
    // stubs of the previous render must not be reused. A fresh stub
    // records its own addEventListener attempts and successful binds,
    // which isolates what the rollback's own re-bind did (B's attempts
    // went to B's discarded stubs) — a global counter cannot prove that.
    _rows: new Map<string, { dataset: { txHash: string }; attempts: number; handlers: number; addEventListener: (ev: string, fn: unknown) => void }>(),
    set innerHTML(v: string) {
      if (state.failEmptyRender && v.includes('No live settlements recorded yet')) {
        throw new Error('simulated empty render failure');
      }
      this._html = v; this.sets++;
      this._rows.clear();
    },
    get innerHTML() { return this._html; },
    querySelectorAll() {
      // Rows parsed from the currently displayed HTML: each carries the
      // row's tx hash and a recording addEventListener that throws when
      // listener failure is armed.
      const hashes = [...this._html.matchAll(/data-tx-hash="([^"]+)"/g)].map(m => m[1]);
      return hashes.map(h => {
        let row = this._rows.get(h);
        if (!row) {
          const stub = {
            dataset: { txHash: h },
            attempts: 0,
            handlers: 0,
            addEventListener: (_ev: string, _fn: unknown) => {
              // Attempts are counted before the throw check: a rollback that
              // tries to re-bind while the failure is still armed attempts
              // the binding (and fails), which is observable and distinct
              // from a rollback that never tried.
              stub.attempts++;
              bindAttempts++;
              if (state.failListeners) throw new Error('simulated listener failure');
              binds++;
              stub.handlers++;
            },
          };
          row = stub;
          this._rows.set(h, row);
        }
        return row;
      });
    },
  };
  const kpi = { textContent: '—', title: '' };
  const summary = { textContent: '' };
  let pageActive = true;
  let tabHidden = false;
  const documentStub = {
    getElementById: (id: string) =>
      (id === 'live-tx-table-mount' ? mount : id === 'live-tx-count' ? kpi : id === 'live-payment-summary' ? summary : null),
    querySelector: (sel: string) => (sel === '#page-transactions.active' && pageActive ? {} : null),
    querySelectorAll: () => [] as unknown[],
    get hidden() { return tabHidden; },
  };
  let fetchCalls = 0;
  let nextPayload: unknown = null;
  let fetchFails = false;
  const fetchStub = async () => {
    fetchCalls++;
    if (fetchFails) throw new Error('network down');
    return { ok: true, json: async () => nextPayload };
  };
  const rendererFns = [
    'escapeHtml', 'liveProofProgress', 'liveRowStateBadge', 'shortAddr',
    'formatMicroCcd', 'formatBlockTimeWib', 'formatLiveBlock',
    'formatLiveAmount', 'formatLiveFee', 'formatLiveTxTime',
    'renderLiveProofProgress', 'ccdscanTxUrl', 'buildLiveTxTableHTML',
  ].map(extractFunctionSource);
  const loaderSrc = extractFunctionSource('loadLiveTxTable');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const parts = [
    'let lastLiveTxSignature = null;',
    "let lastLivePaymentSummary = '';",
    'let hasSuccessfulLiveTxSnapshot = false;',
    'let liveTxRequestSeq = 0;',
    'let liveTxDisplayRepairRequired = false;',
    'let liveTxRestoreFailedStep = null;',
    'let liveTxRestoreFailedDetail = null;',
    "const ARCHIVE_SURFACE_IDS = ['dashboard-tx-table-mount', 'transactions-page-table-mount', 'wallet-tx-table-mount', 'tx-podium-grid', 'tx-block-ribbon'];",
    'const boundLiveTxRows = new WeakSet();',
    'const boundArchiveRows = new WeakSet();',
    'let liveTxListenersNeedRebind = false;',
    'let archiveListenersNeedRebind = false;',
    'const realTransactionsData = [{ hash: "' + digestA + '" }, { hash: "' + digestB + '" }, { hash: "' + digestOther + '" }];',
    ...rendererFns,
    extractFunctionSource('applyArchiveDedup'),
    extractFunctionSource('liveTxTableSignature'),
    extractFunctionSource('setLivePaymentStatus'),
    extractFunctionSource('updateLiveTxKpi'),
    extractFunctionSource('bindLiveTxRowListeners'),
    extractFunctionSource('bindArchiveRowListeners'),
    extractFunctionSource('captureLiveTxSnapshot'),
    extractFunctionSource('restoreLiveTxSnapshot'),
    extractFunctionSource('reportLiveTxRenderError'),
    extractFunctionSource('reportLiveTxRestoreError'),
    asyncLoaderSrc,
    extractFunctionSource('refreshLiveTxTable'),
    'return { loadLiveTxTable, refreshLiveTxTable, updateLiveTxKpi, get lastLiveTxSignature() { return lastLiveTxSignature; }, get hasSuccessfulLiveTxSnapshot() { return hasSuccessfulLiveTxSnapshot; }, get lastLivePaymentSummary() { return lastLivePaymentSummary; }, get liveTxDisplayRepairRequired() { return liveTxDisplayRepairRequired; }, get liveTxRestoreFailedStep() { return liveTxRestoreFailedStep; } };',
  ];
  const harness = new Function('document', 'fetch', 'apiUrl', 'renderArchive', 'location', parts.join('\n'))
    (documentStub, fetchStub, (p: string) => p, renderArchiveStub, { hash: '' }) as unknown as {
      loadLiveTxTable: (isRefresh?: boolean) => Promise<void>;
      refreshLiveTxTable: () => Promise<void> | void;
      updateLiveTxKpi: (payments: unknown[]) => void;
      readonly lastLiveTxSignature: string | null;
      readonly hasSuccessfulLiveTxSnapshot: boolean;
      readonly lastLivePaymentSummary: string;
      readonly liveTxDisplayRepairRequired: boolean;
      readonly liveTxRestoreFailedStep: string | null;
    };
  const rows = () => (mount.innerHTML.match(/clickable-tx/g) ?? []).length;
  return {
    harness, mount, kpi, summary, rows,
    setPayload: (p: unknown) => { nextPayload = p; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setPageActive: (v: boolean) => { pageActive = v; },
    setTabHidden: (v: boolean) => { tabHidden = v; },
    fetchCalls: () => fetchCalls,
    setDedupFails: (v: boolean) => { state.failDedup = v; },
    setListenerFails: (v: boolean) => { state.failListeners = v; },
    setEmptyRenderFails: (v: boolean) => { state.failEmptyRender = v; },
    dedupCalls: () => dedupCalls.map(c => [...c]),
    binds: () => binds,
    bindAttempts: () => bindAttempts,
    // Per-row counts on the CURRENT row stubs (fresh objects after every
    // innerHTML replacement): attempts/handlers of the row with this hash,
    // 0 when no such row is displayed. These isolate a single bind pass
    // (e.g. the rollback's own re-bind) where a global counter cannot.
    liveRowHandlers: (hash: string) => mount._rows.get(hash)?.handlers ?? 0,
    liveRowAttempts: (hash: string) => mount._rows.get(hash)?.attempts ?? 0,
    digestA, digestB, digestOther,
  };
}

// The five archive surfaces renderArchive() mutates, in render order.
const ARCHIVE_IDS = ['dashboard-tx-table-mount', 'transactions-page-table-mount', 'wallet-tx-table-mount', 'tx-podium-grid', 'tx-block-ribbon'] as const;

type FullRowStub = {
  dataset: { txHash: string };
  attempts: number;
  handlers: number;
  addEventListener: (ev: string, fn: unknown) => void;
};

// Full-atomic harness (PM-01 follow-up): the REAL production archive
// renderer (renderArchive + its three builders + bindArchiveRowListeners)
// and all five real archive surfaces, so a late archive failure is a
// failure of production code after real DOM mutation — not a stub that
// throws before mutating. Archive rows carry the full field set the
// builders render. Failure injection is per-surface and per-operation:
//   - failArchiveAt: the archive surface index whose innerHTML set throws
//     once (disarms on throw), after earlier surfaces mutated for B;
//   - failLiveRestoreValue / failArchiveRestoreValue: an innerHTML set
//     throws once when assigned exactly this value (the restore value),
//     so the failure lands in the restoration, not the render;
//   - failLiveListenerAt: the live binder throws on the Nth
//     addEventListener call of one bind pass (the counter resets on every
//     querySelectorAll), for a partial-bind failure.
// Row stubs are cached per mount by tx hash and cleared on every
// innerHTML assignment (new nodes), so a WeakSet-based binder sees fresh
// objects after a restore and the same objects on an unchanged refresh —
// exactly like real DOM nodes.
function makeFullAtomicHarness(opts: { fetchImpl?: FetchLike } = {}) {
  const digestA = 'a'.repeat(64);
  const digestB = 'f'.repeat(64);
  const digestOther = 'z'.repeat(64);
  const state = {
    failEmptyRender: false,
    failArchiveAt: -1,
    failLiveRestoreValue: null as string | null,
    failArchiveRestoreValue: null as string | null,
    failLiveListenerAt: null as number | null,
    failLiveRender: false,
    failArchiveListenerAt: null as number | null,
    kpiMissing: false,
  };
  let liveBinds = 0;
  let archiveBinds = 0;
  let liveBindCall = 0;
  let archiveBindCall = 0;

  const makeRowStub = (hash: string, which: 'live' | 'archive'): FullRowStub => {
    const stub: FullRowStub = {
      dataset: { txHash: hash },
      attempts: 0,
      handlers: 0,
      addEventListener: (_ev: string, _fn: unknown) => {
        stub.attempts++;
        if (which === 'live') {
          liveBindCall++;
          if (state.failLiveListenerAt !== null && liveBindCall === state.failLiveListenerAt) {
            throw new Error('simulated listener failure at call ' + liveBindCall);
          }
          liveBinds++;
        } else {
          archiveBindCall++;
          if (state.failArchiveListenerAt !== null && archiveBindCall === state.failArchiveListenerAt) {
            throw new Error('simulated archive listener failure at call ' + archiveBindCall);
          }
          archiveBinds++;
        }
        stub.handlers++;
      },
    };
    return stub;
  };

  const parseRows = (html: string, which: 'live' | 'archive', cache: Map<string, FullRowStub>) => {
    const hashes = [...html.matchAll(/data-tx-hash="([^"]+)"/g)].map(m => m[1]);
    return hashes.map(h => {
      let row = cache.get(h);
      if (!row) { row = makeRowStub(h, which); cache.set(h, row); }
      return row;
    });
  };

  // One stub element per DOM surface: innerHTML with failure injection
  // and a per-mount row cache cleared on every assignment.
  const makeMount = (which: 'live' | 'archive', onSet?: (v: string) => void) => {
    const el = {
      _html: '',
      sets: 0,
      _rows: new Map<string, FullRowStub>(),
      set innerHTML(v: string) {
        if (onSet) onSet(v);
        this._html = v; this.sets++;
        this._rows.clear();
      },
      get innerHTML() { return this._html; },
      querySelectorAll() {
        if (which === 'live') liveBindCall = 0;
        return parseRows(this._html, which, this._rows);
      },
    };
    return el;
  };

  const liveMount = makeMount('live', (v: string) => {
    if (state.failEmptyRender && v.includes('No live settlements recorded yet')) {
      throw new Error('simulated empty render failure');
    }
    // One-shot: the first table assignment after arming is the render's;
    // the rollback's restore assignment must not throw, or the boundary
    // under test (render failure) would be confused with a restore failure.
    if (state.failLiveRender && v.includes('clickable-tx')) {
      state.failLiveRender = false;
      throw new Error('simulated live-table render failure');
    }
    if (state.failLiveRestoreValue !== null && v === state.failLiveRestoreValue) {
      state.failLiveRestoreValue = null;
      throw new Error('simulated live-table restore failure');
    }
  });
  const archiveMounts = ARCHIVE_IDS.map((id, idx) => makeMount('archive', (v: string) => {
    if (state.failArchiveAt === idx) {
      state.failArchiveAt = -1;
      throw new Error('simulated archive render failure at surface ' + id);
    }
    if (state.failArchiveRestoreValue !== null && v === state.failArchiveRestoreValue) {
      state.failArchiveRestoreValue = null;
      throw new Error('simulated archive restore failure at surface ' + id);
    }
  }));
  const kpi = { textContent: '—', title: '' };
  // PM-01-R1: every status publication is observable. The summary stub
  // records each textContent assignment in order, so a test can prove
  // that no success status was published during a failed attempt (not
  // merely that the final text is a warning) and that a successful
  // repair publishes success only as its last status write.
  const statusWrites: string[] = [];
  const summary = {
    _text: '',
    set textContent(v: string) { this._text = v; statusWrites.push(v); },
    get textContent() { return this._text; },
  };
  let pageActive = true;
  let tabHidden = false;
  const documentStub = {
    getElementById: (id: string) => {
      if (id === 'live-tx-table-mount') return liveMount;
      if (id === 'live-tx-count') return state.kpiMissing ? null : kpi;
      if (id === 'live-payment-summary') return summary;
      const idx = (ARCHIVE_IDS as readonly string[]).indexOf(id);
      return idx >= 0 ? archiveMounts[idx] : null;
    },
    querySelector: (sel: string) => (sel === '#page-transactions.active' && pageActive ? {} : null),
    querySelectorAll: (_sel: string) => {
      // The production archive binder queries the combined archive
      // selector; the stub returns the row stubs of every archive surface
      // (parsed from their current HTML), one stub per rendered row
      // occurrence — the same rows a real querySelectorAll would return.
      // The per-pass archive bind counter resets here, mirroring the live
      // binder's reset in the live mount's querySelectorAll.
      archiveBindCall = 0;
      const rows: FullRowStub[] = [];
      for (const m of archiveMounts) rows.push(...m.querySelectorAll());
      return rows;
    },
    get hidden() { return tabHidden; },
  };
  let fetchCalls = 0;
  let nextPayload: unknown = null;
  let fetchFails = false;
  const fetchStub = async () => {
    fetchCalls++;
    if (fetchFails) throw new Error('network down');
    return { ok: true, json: async () => nextPayload };
  };
  const archiveRow = (hash: string, rank: number, block: string) => ({
    hash,
    shortHash: hash.slice(0, 8) + '...' + hash.slice(-8),
    block,
    amount: '1 µCCD',
    fee: '4.6 CCD',
    timestamp: '11 Nov 2026 09:16 WIB',
    url: 'https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=' + hash,
    rank,
  });
  const archiveRows = [
    archiveRow(digestA, 1, '50652456'),
    archiveRow(digestB, 2, '50658601'),
    archiveRow(digestOther, 3, '50660860'),
  ];
  const rendererFns = [
    'escapeHtml', 'liveProofProgress', 'liveRowStateBadge', 'shortAddr',
    'formatMicroCcd', 'formatBlockTimeWib', 'formatLiveBlock',
    'formatLiveAmount', 'formatLiveFee', 'formatLiveTxTime',
    'renderLiveProofProgress', 'ccdscanTxUrl', 'buildLiveTxTableHTML',
  ].map(extractFunctionSource);
  const archiveFns = ['buildTxTableHTML', 'buildPodiumHTML', 'buildRibbonHTML'].map(extractFunctionSource);
  const loaderSrc = extractFunctionSource('loadLiveTxTable');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const parts = [
    'let lastLiveTxSignature = null;',
    "let lastLivePaymentSummary = '';",
    'let hasSuccessfulLiveTxSnapshot = false;',
    'let liveTxRequestSeq = 0;',
    'let liveTxDisplayRepairRequired = false;',
    'let liveTxRestoreFailedStep = null;',
    'let liveTxRestoreFailedDetail = null;',
    "const ARCHIVE_SURFACE_IDS = ['dashboard-tx-table-mount', 'transactions-page-table-mount', 'wallet-tx-table-mount', 'tx-podium-grid', 'tx-block-ribbon'];",
    'const boundLiveTxRows = new WeakSet();',
    'const boundArchiveRows = new WeakSet();',
    'let liveTxListenersNeedRebind = false;',
    'let archiveListenersNeedRebind = false;',
    'const realTransactionsData = ' + JSON.stringify(archiveRows) + ';',
    ...rendererFns,
    ...archiveFns,
    extractFunctionSource('applyArchiveDedup'),
    extractFunctionSource('renderArchive'),
    extractFunctionSource('bindArchiveRowListeners'),
    extractFunctionSource('liveTxTableSignature'),
    extractFunctionSource('setLivePaymentStatus'),
    extractFunctionSource('updateLiveTxKpi'),
    extractFunctionSource('bindLiveTxRowListeners'),
    extractFunctionSource('captureLiveTxSnapshot'),
    extractFunctionSource('restoreLiveTxSnapshot'),
    extractFunctionSource('reportLiveTxRenderError'),
    extractFunctionSource('reportLiveTxRestoreError'),
    asyncLoaderSrc,
    extractFunctionSource('refreshLiveTxTable'),
    'return { loadLiveTxTable, refreshLiveTxTable, updateLiveTxKpi, buildLiveTxTableHTML, buildTxTableHTML, buildPodiumHTML, buildRibbonHTML, get lastLiveTxSignature() { return lastLiveTxSignature; }, get hasSuccessfulLiveTxSnapshot() { return hasSuccessfulLiveTxSnapshot; }, get lastLivePaymentSummary() { return lastLivePaymentSummary; }, get liveTxDisplayRepairRequired() { return liveTxDisplayRepairRequired; }, get liveTxRestoreFailedStep() { return liveTxRestoreFailedStep; }, get liveTxRestoreFailedDetail() { return liveTxRestoreFailedDetail; } };',
  ];
  const harness = new Function('document', 'fetch', 'apiUrl', 'location', parts.join('\n'))
    (documentStub, opts.fetchImpl ?? fetchStub, (p: string) => p, { hash: '' }) as unknown as {
      loadLiveTxTable: (isRefresh?: boolean) => Promise<void>;
      refreshLiveTxTable: () => Promise<void> | void;
      updateLiveTxKpi: (payments: unknown[]) => void;
      buildLiveTxTableHTML: (payments: unknown[]) => string;
      buildTxTableHTML: (rows: unknown[]) => string;
      buildPodiumHTML: (rows: unknown[]) => string;
      buildRibbonHTML: (rows: unknown[]) => string;
      readonly lastLiveTxSignature: string | null;
      readonly hasSuccessfulLiveTxSnapshot: boolean;
      readonly lastLivePaymentSummary: string;
      readonly liveTxDisplayRepairRequired: boolean;
      readonly liveTxRestoreFailedStep: string | null;
      readonly liveTxRestoreFailedDetail: string | null;
    };
  const rows = () => (liveMount.innerHTML.match(/clickable-tx/g) ?? []).length;
  // eq() is strict equality, so archive-surface lists are compared joined.
  const archiveHtml = () => archiveMounts.map(m => m.innerHTML).join('\n');
  return {
    harness, mount: liveMount, kpi, summary, archiveMounts, archiveHtml, rows,
    setPayload: (p: unknown) => { nextPayload = p; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setPageActive: (v: boolean) => { pageActive = v; },
    setTabHidden: (v: boolean) => { tabHidden = v; },
    fetchCalls: () => fetchCalls,
    setEmptyRenderFails: (v: boolean) => { state.failEmptyRender = v; },
    setArchiveFailsAt: (i: number) => { state.failArchiveAt = i; },
    setLiveRestoreFails: (v: string | null) => { state.failLiveRestoreValue = v; },
    setArchiveRestoreFails: (v: string | null) => { state.failArchiveRestoreValue = v; },
    setLiveListenerFailsAt: (n: number | null) => { state.failLiveListenerAt = n; },
    setLiveRenderFails: (v: boolean) => { state.failLiveRender = v; },
    setArchiveListenerFailsAt: (n: number | null) => { state.failArchiveListenerAt = n; },
    setKpiMissing: (v: boolean) => { state.kpiMissing = v; },
    statusWrites: () => [...statusWrites],
    liveBinds: () => liveBinds,
    archiveBinds: () => archiveBinds,
    liveRowHandlers: (hash: string) => liveMount._rows.get(hash)?.handlers ?? 0,
    liveRowAttempts: (hash: string) => liveMount._rows.get(hash)?.attempts ?? 0,
    archiveRowHandlers: (hash: string) => archiveMounts.reduce((n, m) => n + (m._rows.get(hash)?.handlers ?? 0), 0),
    archiveRowHandlersPerMount: (hash: string) => archiveMounts.map(m => m._rows.get(hash)?.handlers ?? 0),
    archiveRows,
    digestA, digestB, digestOther,
  };
}

test('04. API returns 5 records, KPI displays 5 and the table shows 5 rows', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5');
  eq(h.rows(), 5, 'table has 5 rows');
});

test('05. a new payment appears, KPI increments automatically on refresh', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  h.setPayload({ payments: [pay('f'.repeat(64), 'finalized', 2000), ...base5()] });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the new payment');
  eq(h.rows(), 6, 'table has 6 rows');
});

test('06. a status change re-renders but the count stays correct', async () => {
  const h = makeHarness();
  const five = base5();
  five[4] = pay('e'.repeat(64), 'outcome_unknown', 1004);
  h.setPayload({ payments: five });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5 before the transition');
  const flipped = five.map((p) => (p.state === 'outcome_unknown' ? { ...p, state: 'finalized', updatedAt: 3000 } : p));
  const setsBefore = h.mount.sets;
  h.setPayload({ payments: flipped });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is still 5 after the status change');
  eq(h.rows(), 5, 'table still has 5 rows');
  ok(h.mount.sets > setsBefore, 'table re-rendered on the status change');
});

test('07. a duplicate refresh does not increase the count', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  const setsBefore = h.mount.sets;
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.mount.sets, setsBefore, 'table was not re-rendered');
  eq(h.rows(), 5, 'table still has 5 rows');
});

test('08. empty API response on initial load, KPI displays 0', async () => {
  const h = makeHarness();
  h.setPayload({ payments: [] });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '0', 'KPI is 0');
  ok(h.mount.innerHTML.includes('No live settlements recorded yet'), 'empty message shown');
});

test('09. failed refresh keeps the last valid count', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  h.setFetchFails(true);
  const kept = h.mount.innerHTML;
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is still 5 after the failed refresh');
  eq(h.mount.innerHTML, kept, 'table kept its last render');
  notOk(h.kpi.textContent === '0', 'failed refresh did not zero the KPI');
});

test('10. loading state does not falsely display 0', async () => {
  const h = makeHarness();
  eq(h.kpi.textContent, '—', 'KPI is "—" before any load');
  h.setFetchFails(true);
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI is still "—" after a failed initial load');
  notOk(h.kpi.textContent === '0', 'failed initial load did not show 0');
  ok(h.mount.innerHTML.includes('Live settlements unavailable'), 'error shown instead');
});

test('11. empty refresh keeps the last count, matching the table', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  h.setPayload({ payments: [] });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI keeps 5 on an empty refresh');
  eq(h.rows(), 5, 'table keeps its 5 rows');
});

test('12. KPI and table always use the same record set', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  eq(Number(h.kpi.textContent), h.rows(), 'KPI equals row count after load');
  h.setPayload({ payments: [pay('f'.repeat(64), 'finalized', 2000), ...base5()] });
  await h.harness.refreshLiveTxTable();
  eq(Number(h.kpi.textContent), h.rows(), 'KPI equals row count after a new payment');
  h.setFetchFails(true);
  await h.harness.refreshLiveTxTable();
  eq(Number(h.kpi.textContent), h.rows(), 'KPI equals row count after a failed refresh');
});

// ── Sol v3 regressions: the payment summary counts ───────────────────────────

test('13. summary separates total records, stored finalized, finalized-with-evidence, and outcome_unknown', async () => {
  const h = makeHarness();
  const five = ['a', 'b', 'c', 'd'].map((c, i) => payEv(c.repeat(64), 'finalized', 1000 + i));
  five.push(pay('e'.repeat(64), 'outcome_unknown', 1004));
  h.setPayload({ payments: five });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI counts all 5 records');
  eq(h.rows(), 5, 'table has 5 rows');
  ok(h.summary.textContent.includes('5 total payment records'), 'summary states the total');
  ok(h.summary.textContent.includes('4 stored finalized'), 'summary counts stored finalized separately');
  ok(h.summary.textContent.includes('4 finalized with evidence'), 'summary counts evidence-backed finalized separately');
  ok(h.summary.textContent.includes('1 outcome_unknown (not finalized)'), 'summary counts outcome_unknown separately');
  notOk(h.summary.textContent.includes('5 finalized'), 'summary never claims all 5 are finalized');
});

test('14. a malformed row rejects the whole list, never a silent partial count', async () => {
  const h = makeHarness();
  const bad = [...base5(), { paymentDigest: 'f'.repeat(64) }]; // missing state: malformed
  h.setPayload({ payments: bad });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI stays "—" on a malformed initial load');
  eq(h.rows(), 0, 'no rows render from a malformed list');
  ok(h.mount.innerHTML.includes('unexpected response shape'), 'malformed list shows the shape error');
  ok(h.summary.textContent.includes('MALFORMED RESPONSE'), 'summary reports the malformed response');

  const h2 = makeHarness();
  h2.setPayload({ payments: base5() });
  await h2.harness.loadLiveTxTable();
  const kept = h2.mount.innerHTML;
  h2.setPayload({ payments: bad });
  await h2.harness.refreshLiveTxTable();
  eq(h2.kpi.textContent, '5', 'malformed refresh keeps the last count');
  eq(h2.mount.innerHTML, kept, 'malformed refresh keeps the last render');
  ok(h2.summary.textContent.includes('STALE'), 'malformed refresh is labelled stale');
});

test('15. empty refresh labels the retained data stale', async () => {
  const h = makeHarness();
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  h.setPayload({ payments: [] });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI keeps 5 on an empty refresh');
  eq(h.rows(), 5, 'table keeps its 5 rows');
  ok(h.summary.textContent.includes('STALE'), 'empty refresh is labelled stale');
});

test('16. network failure labels the summary ERROR, then STALE on refresh', async () => {
  const h = makeHarness();
  h.setFetchFails(true);
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI stays "—" after a failed initial load');
  ok(h.summary.textContent.includes('ERROR'), 'failed initial load is labelled ERROR');

  const h2 = makeHarness();
  h2.setPayload({ payments: base5() });
  await h2.harness.loadLiveTxTable();
  h2.setFetchFails(true);
  await h2.harness.refreshLiveTxTable();
  eq(h2.kpi.textContent, '5', 'failed refresh keeps the last count');
  ok(h2.summary.textContent.includes('STALE'), 'failed refresh is labelled stale');
});

test('17. summary counts stored finalized and evidence-backed finalized separately (audit B2 regression)', async () => {
  const h = makeHarness();
  // 2 stored-finalized records, only 1 with valid evidence, plus 1 outcome_unknown.
  const evidenced = payEv('a'.repeat(64), 'finalized', 1000);
  const storedOnly = pay('b'.repeat(64), 'finalized', 1001); // stored finalized, no verification at all
  const unknown = pay('c'.repeat(64), 'outcome_unknown', 1002);
  h.setPayload({ payments: [evidenced, storedOnly, unknown] });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '3', 'KPI counts all 3 records');
  eq(h.rows(), 3, 'table has 3 rows');
  ok(h.summary.textContent.includes('3 total payment records'), 'summary states the total');
  ok(h.summary.textContent.includes('2 stored finalized'), 'summary counts stored finalized separately');
  ok(h.summary.textContent.includes('1 finalized with evidence'), 'summary counts evidence-backed finalized separately');
  ok(h.summary.textContent.includes('1 outcome_unknown (not finalized)'), 'summary counts outcome_unknown separately');
  notOk(h.summary.textContent.includes('2 finalized with evidence'), 'stored finality is never presented as evidence-backed');
});

test('18. a whitespace-only evidence source is not counted as evidence-backed finalized (audit B1 regression)', async () => {
  const h = makeHarness();
  const blank = { ...payEv('a'.repeat(64), 'finalized', 1000), verification: { ...evidence, source: '   ' } };
  const valid = payEv('b'.repeat(64), 'finalized', 1001);
  h.setPayload({ payments: [blank, valid] });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '2', 'KPI still counts both records in the total');
  ok(h.summary.textContent.includes('2 stored finalized'), 'whitespace-source record still counts as stored finalized');
  ok(h.summary.textContent.includes('1 finalized with evidence'), 'whitespace-source record contributes zero to the evidence-backed count');
  notOk(h.summary.textContent.includes('2 finalized with evidence'), 'whitespace source is never counted as evidence');
});

test('19. a null record does not throw the KPI updater and counts stay correct (re-audit latent null dereference)', () => {
  const h = makeHarness();
  // The loader rejects null rows, so the KPI function is tested directly:
  // a null entry must not throw any of the three count filters.
  // PM-01-R1: updateLiveTxKpi no longer publishes a status, so the counts
  // are asserted through the stored summary it writes, not the summary
  // element (which only a status publication updates).
  h.harness.updateLiveTxKpi([null]);
  eq(h.kpi.textContent, '1', 'KPI total follows the current behaviour (payments.length)');
  ok(h.harness.lastLivePaymentSummary.includes('1 total payment records'), 'summary states the total');
  ok(h.harness.lastLivePaymentSummary.includes('0 stored finalized'), 'null is not stored finalized');
  ok(h.harness.lastLivePaymentSummary.includes('0 finalized with evidence'), 'null is not evidence-backed finalized');
  ok(h.harness.lastLivePaymentSummary.includes('0 outcome_unknown (not finalized)'), 'null is not outcome_unknown');

  // Mixed input: null alongside one of each real record type.
  const h2 = makeHarness();
  const evidenced = payEv('a'.repeat(64), 'finalized', 1000);
  const storedOnly = pay('b'.repeat(64), 'finalized', 1001); // stored finalized, no verification at all
  const unknown = pay('c'.repeat(64), 'outcome_unknown', 1002);
  h2.harness.updateLiveTxKpi([null, evidenced, storedOnly, unknown]);
  eq(h2.kpi.textContent, '4', 'KPI counts all 4 entries');
  ok(h2.harness.lastLivePaymentSummary.includes('4 total payment records'), 'summary states the total');
  ok(h2.harness.lastLivePaymentSummary.includes('2 stored finalized'), 'stored-finalized count stays correct with a null present');
  ok(h2.harness.lastLivePaymentSummary.includes('1 finalized with evidence'), 'evidence-backed count stays correct with a null present');
  ok(h2.harness.lastLivePaymentSummary.includes('1 outcome_unknown (not finalized)'), 'outcome-unknown count stays correct with a null present');
});

// ── INT-01/INT-02/INT-03 regressions (Sol integration audit 7307515) ───────

test('20. a failed initial load followed by a successful empty refresh renders the empty state (INT-01 regression)', async () => {
  const h = makeHarness();
  h.setFetchFails(true);
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI stays "—" after the failed initial load');
  ok(h.mount.innerHTML.includes('Live settlements unavailable'), 'error shown after the failed initial load');
  h.setFetchFails(false);
  h.setPayload({ payments: [] });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '0', 'KPI is 0 after the empty refresh recovers');
  ok(h.mount.innerHTML.includes('No live settlements recorded yet'), 'empty state renders');
  notOk(h.mount.innerHTML.includes('Live settlements unavailable'), 'the previous error message is gone');
  ok(h.summary.textContent.includes('EMPTY'), 'summary reports the empty response');
  ok(h.summary.textContent.includes('0 total payment records'), 'summary states the empty total');
});

test('21. a finite out-of-range timestamp renders "not available" and the loader recovers (INT-02 regression)', async () => {
  // Real production renderer: the stubbed rows in makeHarness cannot
  // exercise formatLiveTxTime or buildLiveTxTableHTML at all.
  const h = makeRealRendererHarness();
  const bad = pay('a'.repeat(64), 'finalized', 1e20);
  h.setPayload({ payments: [bad] });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '1', 'KPI is 1');
  eq(h.rows(), 1, 'table has 1 row');
  ok(h.mount.innerHTML.includes('not available'), 'the out-of-range timestamp renders as not available');
  // The loader publishes its 'API response received' status only after
  // the complete render commits (PM-01-R1), so that is the
  // successful-render marker.
  ok(h.summary.textContent.includes('API response received'), 'the response is presented as successfully rendered');
  ok(h.summary.textContent.includes('1 total payment records'), 'the summary describes the rendered record');
  // A valid payload then re-renders normally through the same loader.
  const good = pay('a'.repeat(64), 'finalized', 1000);
  h.setPayload({ payments: [good] });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '1', 'KPI is still 1 after the valid refresh');
  eq(h.rows(), 1, 'table still has 1 row');
  ok(h.mount.innerHTML.includes('WIB'), 'the valid timestamp renders a real WIB time');
});

test('22. a rendering failure does not commit the signature, so the next identical load recovers (INT-02 regression)', async () => {
  const h = makeRealRendererHarness({ failFirstTableRender: true });
  h.setPayload({ payments: base5() });
  await h.harness.loadLiveTxTable();
  // The loader caught the rendering failure: no rejection, no KPI, no
  // signature commit, and the failure is reported, not presented as success.
  eq(h.kpi.textContent, '—', 'KPI stays "—" after the failed render');
  eq(h.rows(), 0, 'no rows render from the failed render');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  notOk(h.summary.textContent.includes('Latest API request succeeded'), 'the failed response is not presented as successfully rendered');
  const setsAfterFailure = h.mount.sets;
  // The identical payload again: the signature was never committed, so the
  // loader retries the render instead of skipping it as unchanged.
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5 after the recovery render');
  eq(h.rows(), 5, 'table has 5 rows after recovery');
  ok(h.mount.sets > setsAfterFailure, 'the recovery render actually ran');
  ok(h.summary.textContent.includes('API response received'), 'the recovered response is presented as successful');
});

test('23. an older response cannot overwrite a newer one (INT-03 regression)', async () => {
  type Resp = { ok: boolean; json: () => Promise<unknown> };
  const first = deferred<Resp>();
  const second = deferred<Resp>();
  let fetchCall = 0;
  const h = makeHarness({ fetchImpl: async () => (fetchCall++ === 0 ? first.promise : second.promise) });
  const loadA = h.harness.loadLiveTxTable();
  const loadB = h.harness.refreshLiveTxTable();
  // B (newer) resolves first with 6 records; A (older) resolves after with 5.
  second.resolve({ ok: true, json: async () => ({ payments: [pay('f'.repeat(64), 'finalized', 2000), ...base5()] }) });
  await loadB;
  eq(h.kpi.textContent, '6', 'KPI is 6 after the newer response');
  eq(h.rows(), 6, 'table has 6 rows from the newer response');
  const shown = h.mount.innerHTML;
  first.resolve({ ok: true, json: async () => ({ payments: base5() }) });
  await loadA;
  eq(h.kpi.textContent, '6', 'the older response did not change the KPI');
  eq(h.rows(), 6, 'the older response did not change the table');
  eq(h.mount.innerHTML, shown, 'the older response did not re-render the table');
  ok(h.summary.textContent.includes('6 total payment records'), 'the summary still describes the newer response');
});

test('24. an older failure cannot mark newer successful data stale (INT-03 regression)', async () => {
  type Resp = { ok: boolean; json: () => Promise<unknown> };
  const first = deferred<Resp>();
  const second = deferred<Resp>();
  let fetchCall = 0;
  const h = makeHarness({ fetchImpl: async () => (fetchCall++ === 0 ? first.promise : second.promise) });
  const loadA = h.harness.loadLiveTxTable();
  const loadB = h.harness.refreshLiveTxTable();
  second.resolve({ ok: true, json: async () => ({ payments: base5() }) });
  await loadB;
  eq(h.kpi.textContent, '5', 'KPI is 5 after the newer response');
  const shown = h.mount.innerHTML;
  const summaryShown = h.summary.textContent;
  first.reject(new Error('network down'));
  await loadA;
  eq(h.kpi.textContent, '5', 'the older failure did not change the KPI');
  eq(h.mount.innerHTML, shown, 'the older failure did not change the table');
  eq(h.summary.textContent, summaryShown, 'the older failure did not mark the newer display stale');
  notOk(h.summary.textContent.includes('STALE'), 'no stale label from the older failure');
});

// ── PM-01 atomic snapshot application (Sol re-audit 7307588) ─────────────

test('25. a late failure at archive deduplication restores the prior snapshot exactly (PM-01 Test A)', async () => {
  // Real production dedup: realTransactionsData overlaps A ('a') and B
  // ('f'), so dedup genuinely runs and genuinely calls renderArchive.
  const h = makeAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5 after snapshot A');
  eq(h.rows(), 5, 'table has 5 rows from A');
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const summaryA = h.harness.lastLivePaymentSummary;
  eq(h.dedupCalls().length, 1, 'dedup ran once for A');
  eq(h.dedupCalls()[0].join(','), [h.digestB, h.digestOther].join(','), 'dedup kept the non-live archive rows for A');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'snapshot flag is true after A');
  // B overlaps the archive too, so its dedup genuinely runs — and fails
  // after the table, KPI, and flag have already been mutated to B.
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setDedupFails(true);
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the table still shows A');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLivePaymentSummary, summaryA, 'the stored summary is restored to A');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'the snapshot flag still reflects A');
  eq(h.dedupCalls().length, 2, 'dedup ran for B before failing');
  eq(h.dedupCalls()[1].join(','), h.digestOther, 'dedup computed the kept rows for B before failing');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('STALE'), 'the error prefix reflects the displayed prior snapshot');
  ok(h.summary.textContent.includes(summaryA), 'the displayed summary still describes A');
  notOk(h.mount.innerHTML.includes(h.digestB), 'no B row leaked into the displayed table');
  // The A row stubs below are fresh objects created after the restore
  // replaced the DOM, so their handler counts isolate the rollback's own
  // re-bind (B's bindings went to B's discarded stubs): each restored A
  // row was bound exactly once.
  for (const p of payloadA) eq(h.liveRowHandlers(p.paymentDigest), 1, 'each restored A row was re-bound exactly once');
});

test('26. an identical response retries after a late failure and applies cleanly (PM-01 Test B)', async () => {
  const h = makeAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const sigA = h.harness.lastLiveTxSignature;
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setDedupFails(true);
  await h.harness.refreshLiveTxTable();
  eq(h.harness.lastLiveTxSignature, sigA, 'signature still A after the failed B');
  // Retry the exact same B payload without the injected failure.
  h.setDedupFails(false);
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the retry applies B');
  eq(h.rows(), 6, 'table has 6 rows from B');
  ok(h.mount.innerHTML.includes(h.digestB), 'the B row is displayed');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed after success');
  ok(h.summary.textContent.includes('6 total payment records'), 'summary describes B');
  notOk(h.summary.textContent.includes('RENDER ERROR'), 'no render error remains');
  eq(h.dedupCalls().length, 3, 'dedup ran for A, the failed B, and the retry');
});

test('27. returning to the prior payload after B renders A, not a stale-signature skip (PM-01 Test C)', async () => {
  const h = makeAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after B');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature is B after B applies');
  // Back to A: a different signature, so the loader must render, not skip.
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the table shows A again');
  eq(h.kpi.textContent, '5', 'KPI is 5 again');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is A again');
  ok(h.summary.textContent.includes('5 total payment records'), 'summary describes A');
});

test('28. a failed first-ever empty render commits no success state, and the retry applies it (PM-01 Test D)', async () => {
  const h = makeAtomicHarness();
  h.setPayload({ payments: [] });
  h.setEmptyRenderFails(true);
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI does not falsely become 0');
  ok(!h.harness.hasSuccessfulLiveTxSnapshot, 'no successful snapshot is recorded');
  eq(h.harness.lastLiveTxSignature, null, 'no signature is committed');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('ERROR'), 'the prefix is ERROR with no prior snapshot');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim without a prior snapshot');
  notOk(h.mount.innerHTML.includes('No live settlements recorded yet'), 'the empty state is not displayed');
  // Retry the identical empty response without the injected failure.
  h.setEmptyRenderFails(false);
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '0', 'KPI is 0 after the retry');
  ok(h.mount.innerHTML.includes('No live settlements recorded yet'), 'the empty state renders');
  ok(h.summary.textContent.includes('EMPTY'), 'status reports EMPTY');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'the snapshot flag is set together with the display');
});

test('29. an empty refresh with a prior snapshot retains it as stale (PM-01 Test E)', async () => {
  const h = makeAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  h.setPayload({ payments: [] });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the prior snapshot remains visible');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'the snapshot flag still reflects A');
  ok(h.summary.textContent.includes('STALE'), 'the retained snapshot is marked stale');
  ok(h.summary.textContent.includes('empty list'), 'the summary names the empty response');
});

test('30. a late failure at listener registration restores the prior snapshot (PM-01)', async () => {
  const h = makeAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const summaryA = h.harness.lastLivePaymentSummary;
  const bindsA = h.binds();
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setListenerFails(true);
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the table still shows A');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  eq(h.harness.lastLivePaymentSummary, summaryA, 'the stored summary is restored to A');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('STALE'), 'the error prefix reflects the displayed prior snapshot');
  // The rollback re-bind is attempted on the restored A rows, but it fails
  // too while the listener failure is still armed — so no new listener
  // binds, while the restored content itself is correct. The failure is
  // armed on every call, so the re-bind throws on the first row and never
  // reaches the rest: the first restored row's attempt count isolates the
  // rollback's own re-bind (B's attempts went to B's discarded stubs),
  // and every restored row has zero handlers. The next successful render
  // re-binds normally.
  eq(h.liveRowAttempts(payloadA[0].paymentDigest), 1, 'the rollback attempted to bind the first restored A row');
  for (const p of payloadA) eq(h.liveRowHandlers(p.paymentDigest), 0, 'no listener bound on the restored A row while failure is armed');
  eq(h.binds(), bindsA, 'no listener bound while listener failure is armed');
  // Retry without the injected failure: B applies cleanly.
  h.setListenerFails(false);
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the retry applies B');
  eq(h.rows(), 6, 'table has 6 rows from B');
});

// ── PM-01 follow-up: complete atomic payment-surface rollback ──────────
// (Sol re-audit 7307662: archive mutations survived a failed snapshot
// application). These tests run the REAL production archive renderer
// against all five real archive surfaces, with failure injected at a
// later real archive mutation boundary — after earlier surfaces mutated.

test('31. a late failure inside the real archive renderer restores every live and archive surface to A (PM-01 follow-up Test A)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5 after snapshot A');
  eq(h.rows(), 5, 'table has 5 rows from A');
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const summaryA = h.harness.lastLivePaymentSummary;
  // The real archive renderer ran for A: the kept rows are the archive
  // rows whose hashes are not live payments ([f, z]).
  const keptA = [h.archiveRows[1], h.archiveRows[2]];
  const expectedArchiveA = [
    h.harness.buildTxTableHTML(keptA),
    h.harness.buildTxTableHTML(keptA),
    h.harness.buildTxTableHTML(keptA),
    h.harness.buildPodiumHTML(keptA),
    h.harness.buildRibbonHTML(keptA),
  ].join('\n');
  eq(h.archiveHtml(), expectedArchiveA, 'all five archive surfaces show the A-filtered archive');
  // B: the real renderer mutates the first two archive surfaces for B
  // ([z] only) and then throws at the third (wallet) surface.
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the live table still shows A');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLivePaymentSummary, summaryA, 'the stored summary is restored to A');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'the snapshot flag still reflects A');
  eq(h.archiveHtml(), expectedArchiveA, 'every archive surface is restored to A — no B archive content remains');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('STALE'), 'the error prefix reflects the displayed prior snapshot');
  notOk(h.mount.innerHTML.includes(h.digestB), 'no B row leaked into the displayed table');
  // The A row stubs below are fresh objects created after the restore
  // replaced the DOM, so their handler counts isolate the rollback's own
  // re-bind (B's bindings went to B's discarded stubs): each restored A
  // row was bound exactly once.
  for (const p of payloadA) eq(h.liveRowHandlers(p.paymentDigest), 1, 'each restored A row was re-bound exactly once');
});

test('32. an identical response retries after a partial archive failure and applies B to every surface (PM-01 follow-up Test B)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const sigA = h.harness.lastLiveTxSignature;
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  await h.harness.refreshLiveTxTable();
  eq(h.harness.lastLiveTxSignature, sigA, 'signature still A after the failed B');
  // Retry the exact same B payload: the failure disarmed on its throw,
  // so the archive rendering is attempted again and completes.
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the retry applies B');
  eq(h.rows(), 6, 'table has 6 rows from B');
  ok(h.mount.innerHTML.includes(h.digestB), 'the B row is displayed');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed after complete success');
  const keptB = [h.archiveRows[2]];
  const expectedArchiveB = [
    h.harness.buildTxTableHTML(keptB),
    h.harness.buildTxTableHTML(keptB),
    h.harness.buildTxTableHTML(keptB),
    h.harness.buildPodiumHTML(keptB),
    h.harness.buildRibbonHTML(keptB),
  ].join('\n');
  eq(h.archiveHtml(), expectedArchiveB, 'all five archive surfaces consistently show the B-filtered archive');
  ok(h.summary.textContent.includes('6 total payment records'), 'summary describes B');
  notOk(h.summary.textContent.includes('RENDER ERROR'), 'no render error remains');
  for (const p of payloadB) eq(h.liveRowHandlers(p.paymentDigest), 1, 'each B row was bound exactly once');
});

test('33. returning to the prior payload after B renders A on every surface, not an unchanged-signature skip (PM-01 follow-up Test C)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const archiveA = h.archiveHtml();
  const setsA = h.mount.sets;
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after B');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature is B after B applies');
  // Back to A: a different signature, so the loader must render, not skip.
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the live table shows A again');
  eq(h.archiveHtml(), archiveA, 'every archive surface shows A again');
  eq(h.kpi.textContent, '5', 'KPI is 5 again');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is A again');
  ok(h.mount.sets > setsA, 'the return to A re-rendered the table instead of skipping');
  ok(h.summary.textContent.includes('5 total payment records'), 'summary describes A');
});

test('34. a failure inside the restoration itself is reported as RESTORE FAILED, never as a retained snapshot (PM-01 follow-up Test D)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  const archiveA = h.archiveMounts.map(m => m.innerHTML);
  // Part 1: the live-table restoration fails. The render fails late
  // (archive surface 2 throws after surfaces 0–1 mutated), then the
  // restore's live-table assignment throws on the previous A content.
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  h.setLiveRestoreFails(htmlA);
  await h.harness.refreshLiveTxTable();
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the original render error is reported');
  ok(h.summary.textContent.includes('RESTORE FAILED'), 'the rollback failure is reported distinctly');
  ok(h.summary.textContent.includes('live-table'), 'the failed restoration step is named');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim when the display may be mixed');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  // The restore continued past the failed step: the KPI was restored to
  // A and every archive surface was restored to A — only the live table
  // still shows B, which is exactly the mixed state the status reports.
  notOk(h.mount.innerHTML === htmlA, 'the live table still shows the partially applied B render');
  ok(h.mount.innerHTML.includes(h.digestB), 'the live table still shows the B row');
  eq(h.kpi.textContent, '5', 'the KPI was restored to A');
  eq(h.archiveHtml(), archiveA.join('\n'), 'every archive surface was restored to A');
  // A subsequent successful render recovers the display completely.
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the recovery render applies B');
  eq(h.rows(), 6, 'table has 6 rows from B after recovery');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed after recovery');
  notOk(h.summary.textContent.includes('RESTORE FAILED'), 'no restore failure remains after recovery');
  // Part 2: an archive-surface restoration fails. B renders, the archive
  // renderer throws at the last surface (ribbon) after mutating the
  // first four, and the restore's dashboard assignment throws on the
  // previous A content — so the dashboard keeps the B archive while the
  // other surfaces return to A.
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.harness.lastLiveTxSignature, sigA, 'signature is A again before part 2');
  const dashboardA = h.archiveMounts[0].innerHTML;
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(4);
  h.setArchiveRestoreFails(dashboardA);
  await h.harness.refreshLiveTxTable();
  ok(h.summary.textContent.includes('RESTORE FAILED'), 'the archive rollback failure is reported distinctly');
  ok(h.summary.textContent.includes('archive:dashboard-tx-table-mount'), 'the failed archive step is named');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim when the archive is mixed');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  eq(h.mount.innerHTML, htmlA, 'the live table was restored to A');
  eq(h.kpi.textContent, '5', 'the KPI was restored to A');
  eq(h.archiveMounts[0].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'the dashboard still shows the partially applied B archive');
  eq(h.archiveMounts.slice(1).map(m => m.innerHTML).join('\n'), archiveA.slice(1).join('\n'), 'the other archive surfaces were restored to A');
  // Recovery again.
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the second recovery render');
  notOk(h.summary.textContent.includes('RESTORE FAILED'), 'no restore failure remains after the second recovery');
});

test('35. missing listeners recover on an unchanged-payload refresh without duplicate handlers (PM-01 follow-up Test E)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  // Fail the live binder on its 3rd addEventListener call of a bind pass:
  // rows 1–2 bind, row 3 throws. The same happens on the rollback's
  // re-bind (the counter resets on every querySelectorAll), so the
  // restored A rows are left with rows 3–5 unbound.
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setLiveListenerFailsAt(3);
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the live table still shows A');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('STALE'), 'the content is fully restored, so the stale prefix stands');
  eq(h.liveRowHandlers(payloadA[0].paymentDigest), 1, 'restored row 1 was bound by the rollback re-bind');
  eq(h.liveRowHandlers(payloadA[1].paymentDigest), 1, 'restored row 2 was bound by the rollback re-bind');
  eq(h.liveRowHandlers(payloadA[2].paymentDigest), 0, 'restored row 3 has no handler after the failed re-bind');
  eq(h.liveRowHandlers(payloadA[3].paymentDigest), 0, 'restored row 4 was never reached by the failed re-bind');
  eq(h.liveRowHandlers(payloadA[4].paymentDigest), 0, 'restored row 5 was never reached by the failed re-bind');
  const setsAfterFailure = h.mount.sets;
  // Disarm and submit the SAME committed payload again. The signature
  // matches, so the loader takes the unchanged path — and the recovery
  // there must restore the missing listeners without a new payload and
  // without duplicating the handlers rows 1–2 already have.
  h.setLiveListenerFailsAt(null);
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the unchanged payload was not re-rendered');
  eq(h.mount.sets, setsAfterFailure, 'no table assignment happened on the unchanged refresh');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'the signature is still A');
  for (const p of payloadA) eq(h.liveRowHandlers(p.paymentDigest), 1, 'every A row has exactly one handler after recovery');
});

test('36. empty-response behavior is preserved on the full atomic harness (PM-01 follow-up Test F)', async () => {
  const h = makeFullAtomicHarness();
  // Initial empty-render failure commits no success state.
  h.setPayload({ payments: [] });
  h.setEmptyRenderFails(true);
  await h.harness.loadLiveTxTable();
  eq(h.kpi.textContent, '—', 'KPI does not falsely become 0');
  ok(!h.harness.hasSuccessfulLiveTxSnapshot, 'no successful snapshot is recorded');
  eq(h.harness.lastLiveTxSignature, null, 'no signature is committed');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the failure is reported as a render error');
  ok(h.summary.textContent.includes('ERROR'), 'the prefix is ERROR with no prior snapshot');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim without a prior snapshot');
  notOk(h.mount.innerHTML.includes('No live settlements recorded yet'), 'the empty state is not displayed');
  // Identical empty retry succeeds.
  h.setEmptyRenderFails(false);
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '0', 'KPI is 0 after the retry');
  ok(h.mount.innerHTML.includes('No live settlements recorded yet'), 'the empty state renders');
  ok(h.summary.textContent.includes('EMPTY'), 'status reports EMPTY');
  ok(h.harness.hasSuccessfulLiveTxSnapshot, 'the snapshot flag is set together with the display');
  // Empty refresh after a successful A retains A consistently as stale,
  // including its archive surfaces.
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '5', 'KPI is 5 after A');
  const htmlA = h.mount.innerHTML;
  const archiveA = h.archiveHtml();
  h.setPayload({ payments: [] });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the prior snapshot remains visible');
  eq(h.archiveHtml(), archiveA, 'the archive surfaces remain visible with it');
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  ok(h.summary.textContent.includes('STALE'), 'the retained snapshot is marked stale');
});

test('37. stale requests cannot modify payment or archive surfaces after a newer request is accepted (INT-03 regression on the full harness, PM-01 follow-up Test G)', async () => {
  type Resp = { ok: boolean; json: () => Promise<unknown> };
  const first = deferred<Resp>();
  const second = deferred<Resp>();
  let fetchCall = 0;
  const h = makeFullAtomicHarness({ fetchImpl: async () => (fetchCall++ === 0 ? first.promise : second.promise) });
  const payloadA = base5();
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  // Newer B resolves first; the older A resolves later and must not win.
  const loadA = h.harness.loadLiveTxTable();
  const loadB = h.harness.refreshLiveTxTable();
  second.resolve({ ok: true, json: async () => ({ payments: payloadB }) });
  await loadB;
  eq(h.kpi.textContent, '6', 'KPI is 6 after the newer response');
  const shown = h.mount.innerHTML;
  const archiveShown = h.archiveHtml();
  const summaryShown = h.summary.textContent;
  first.resolve({ ok: true, json: async () => ({ payments: payloadA }) });
  await loadA;
  eq(h.kpi.textContent, '6', 'the older response did not change the KPI');
  eq(h.mount.innerHTML, shown, 'the older response did not re-render the table');
  eq(h.archiveHtml(), archiveShown, 'the older response did not touch the archive surfaces');
  eq(h.summary.textContent, summaryShown, 'the older response did not change the status');
  // Older rejection cannot overwrite newer success either.
  const third = deferred<Resp>();
  const fourth = deferred<Resp>();
  let fetchCall2 = 0;
  const h2 = makeFullAtomicHarness({ fetchImpl: async () => (fetchCall2++ === 0 ? third.promise : fourth.promise) });
  const loadA2 = h2.harness.loadLiveTxTable();
  const loadB2 = h2.harness.refreshLiveTxTable();
  fourth.resolve({ ok: true, json: async () => ({ payments: payloadB }) });
  await loadB2;
  eq(h2.kpi.textContent, '6', 'KPI is 6 after the newer response');
  const shown2 = h2.mount.innerHTML;
  const archiveShown2 = h2.archiveHtml();
  third.reject(new Error('network down'));
  await loadA2;
  eq(h2.kpi.textContent, '6', 'the older failure did not change the KPI');
  eq(h2.mount.innerHTML, shown2, 'the older failure did not change the table');
  eq(h2.archiveHtml(), archiveShown2, 'the older failure did not touch the archive surfaces');
  notOk(h2.summary.textContent.includes('STALE'), 'no stale label from the older failure');
});

// ── PM-01 repair-required tests (Sol 7307960 remediation) ───────────────

// Shared setup: render A, then fail a B render whose rollback also fails
// (late archive failure at surface 2, then the live-table restore throws
// on the previous A content). The result is a mixed display — live table
// still B, KPI and archive restored to A — with a RESTORE FAILED warning,
// the A signature still committed, and repair-required state set.
const setupMixedDisplay = async (h: ReturnType<typeof makeFullAtomicHarness>) => {
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const archiveA = h.archiveMounts.map(m => m.innerHTML);
  const sigA = h.harness.lastLiveTxSignature;
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  h.setLiveRestoreFails(htmlA);
  await h.harness.refreshLiveTxTable();
  ok(h.summary.textContent.includes('RESTORE FAILED'), 'setup: the rollback failure is reported');
  ok(h.harness.liveTxDisplayRepairRequired, 'setup: the display is repair-required');
  eq(h.harness.liveTxRestoreFailedStep, 'live-table', 'setup: the failed restoration step is retained');
  eq(h.harness.lastLiveTxSignature, sigA, 'setup: the failed payload signature is not committed');
  return { payloadA, payloadB, htmlA, archiveA, sigA };
};

// The full archive (no live payments to exclude) — the expected archive
// content after a complete empty rendering or a no-overlap repair.
const fullArchiveHtml = (h: ReturnType<typeof makeFullAtomicHarness>) => [
  h.harness.buildTxTableHTML(h.archiveRows),
  h.harness.buildTxTableHTML(h.archiveRows),
  h.harness.buildTxTableHTML(h.archiveRows),
  h.harness.buildPodiumHTML(h.archiveRows),
  h.harness.buildRibbonHTML(h.archiveRows),
].join('\n');

test('38. a failed rollback followed by an identical-A response forces a full content repair, not the unchanged shortcut (PM-01 repair Test 1)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, htmlA, archiveA, sigA } = await setupMixedDisplay(h);
  const liveSetsBefore = h.mount.sets;
  const archiveSetsBefore = h.archiveMounts.map(m => m.sets);
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the live table was fully re-rendered to A');
  eq(h.mount.sets, liveSetsBefore + 1, 'the live table was assigned again (no shortcut)');
  h.archiveMounts.forEach((m, i) => ok(m.sets > archiveSetsBefore[i], 'archive surface ' + i + ' was re-rendered'));
  eq(h.archiveHtml(), archiveA.join('\n'), 'every archive surface was rebuilt to A');
  eq(h.kpi.textContent, '5', 'KPI is 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'signature A is still committed');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent again');
  eq(h.harness.liveTxRestoreFailedStep, null, 'the failed-step diagnostic is cleared');
  notOk(h.summary.textContent.includes('RESTORE FAILED'), 'the repair warning cleared after completion');
  notOk(h.summary.textContent.includes('REPAIR REQUIRED'), 'no repair warning remains');
});

test('39. a failed rollback followed by an empty response performs a complete empty rendering and clears repair state (PM-01 repair Test 2)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, htmlA, sigA } = await setupMixedDisplay(h);
  // Part 1: the empty rendering itself fails — the warning persists and
  // the mixed display is untouched.
  h.setPayload({ payments: [] });
  h.setEmptyRenderFails(true);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'repair-required survives the failed empty rendering');
  ok(h.summary.textContent.includes('REPAIR REQUIRED'), 'the repair warning persists');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim for the mixed display');
  eq(h.harness.lastLiveTxSignature, sigA, 'no signature is committed by the failed empty rendering');
  ok(h.mount.innerHTML.includes(h.digestB), 'the live table still shows the B row');
  // Part 2: the empty rendering succeeds — live empty state, KPI 0, and
  // all five archive surfaces rebuilt to the full archive.
  h.setEmptyRenderFails(false);
  await h.harness.refreshLiveTxTable();
  ok(h.mount.innerHTML.includes('No live settlements recorded yet'), 'the empty state renders');
  eq(h.kpi.textContent, '0', 'KPI is 0');
  eq(h.archiveHtml(), fullArchiveHtml(h), 'all five archive surfaces were rebuilt to the full archive');
  ok(!h.harness.liveTxDisplayRepairRequired, 'repair state cleared after the complete empty rendering');
  eq(h.harness.liveTxRestoreFailedStep, null, 'the failed-step diagnostic is cleared');
  eq(h.harness.lastLiveTxSignature, null, 'no payload signature describes the empty display');
  ok(h.summary.textContent.includes('EMPTY'), 'status reports EMPTY');
  notOk(h.summary.textContent.includes('RESTORE FAILED'), 'the repair warning cleared');
  notOk(h.summary.textContent.includes('REPAIR REQUIRED'), 'no repair warning remains');
  // A subsequent A response fully renders — the invalidated signature
  // means the unchanged shortcut cannot skip it.
  const liveSetsBefore = h.mount.sets;
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'A fully renders after the empty repair');
  eq(h.mount.sets, liveSetsBefore + 1, 'the table was assigned (no shortcut)');
  eq(h.harness.lastLiveTxSignature, sigA, 'signature A is committed again');
});

test('40. repeated repair failure keeps repair-required set and never claims a retained snapshot (PM-01 repair Test 3)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, payloadB, sigA } = await setupMixedDisplay(h);
  // A second full attempt fails again; the rollback to the already-mixed
  // capture succeeds, so the display stays mixed — and the status must
  // still say REPAIR REQUIRED, never STALE-retained.
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'repair-required survives a rollback to the mixed capture');
  eq(h.harness.liveTxRestoreFailedStep, 'live-table', 'the original failed step is retained');
  ok(h.summary.textContent.includes('RENDER ERROR'), 'the second render error is reported');
  ok(h.summary.textContent.includes('REPAIR REQUIRED'), 'the status names the repair state');
  notOk(h.summary.textContent.includes('STALE'), 'no stale claim for a mixed display');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  ok(h.mount.innerHTML.includes(h.digestB), 'the live table still shows the B row');
});

test('41. a successful repair makes every surface consistent and clears the warning only after completion (PM-01 repair Test 4)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, payloadB, sigA } = await setupMixedDisplay(h);
  const liveSetsBefore = h.mount.sets;
  h.setPayload({ payments: payloadB });
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '6', 'KPI is 6 after the repair applies B');
  eq(h.rows(), 6, 'table has 6 rows from B');
  ok(h.mount.innerHTML.includes(h.digestB), 'the live table shows B');
  // The B archive keeps only rows whose hash is not a live B hash:
  // digestOther alone (digestA and digestB are live in B).
  eq(h.archiveMounts[0].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'the dashboard archive shows the B-filtered rows');
  eq(h.archiveMounts[1].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'the transactions-page archive shows the B-filtered rows');
  eq(h.archiveMounts[2].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'the wallet archive shows the B-filtered rows');
  eq(h.archiveMounts[3].innerHTML, h.harness.buildPodiumHTML([h.archiveRows[2]]), 'the podium shows the B-filtered rows');
  eq(h.archiveMounts[4].innerHTML, h.harness.buildRibbonHTML([h.archiveRows[2]]), 'the ribbon shows the B-filtered rows');
  // PM-01-R1: the success status is the last status write, published
  // only after the complete repair — the exact summary proves it.
  eq(h.summary.textContent, h.harness.lastLivePaymentSummary + ' API response received. Counts describe the displayed list, not an all-time total. Read-only: no payment is made by this page.', 'the success status is published after the completed repair');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the completed repair');
  eq(h.harness.liveTxRestoreFailedStep, null, 'the failed-step diagnostic is cleared');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed');
  notOk(h.summary.textContent.includes('RESTORE FAILED'), 'no restore failure remains');
  notOk(h.summary.textContent.includes('REPAIR REQUIRED'), 'no repair warning remains');
  ok(h.mount.sets > liveSetsBefore, 'the repair assigned the live table');
});

test('42. a no-overlap repair rebuilds all five archive surfaces (PM-01 repair Test 5)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, htmlA, archiveA, sigA } = await setupMixedDisplay(h);
  // A payload whose hashes match no archive row: dedup keeps the full
  // archive, so without the forced render the archive would never be
  // rebuilt. The mixed display's archive is the A-filtered one (two
  // rows); the repair must rebuild it to the full three rows.
  const fresh = ['1', '2'].map((c, i) => pay(c.repeat(64), 'finalized', 3000 + i));
  h.setPayload({ payments: fresh });
  const archiveSetsBefore = h.archiveMounts.map(m => m.sets);
  await h.harness.refreshLiveTxTable();
  eq(h.kpi.textContent, '2', 'KPI is 2 after the no-overlap repair');
  eq(h.rows(), 2, 'table has 2 rows');
  h.archiveMounts.forEach((m, i) => ok(m.sets > archiveSetsBefore[i], 'archive surface ' + i + ' was rebuilt'));
  eq(h.archiveHtml(), fullArchiveHtml(h), 'all five archive surfaces show the full archive');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the no-overlap repair');
  notOk(h.harness.lastLiveTxSignature === sigA, 'the new signature is committed');
});

test('43. failed attempts never commit their payload signature, at any mutation boundary (PM-01 repair Test 6)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, payloadB, sigA } = await setupMixedDisplay(h);
  eq(h.harness.lastLiveTxSignature, sigA, 'signature A after the failed rollback (boundary 1)');
  // Boundary 2: a failed repair attempt while repair is required — the
  // render fails late again and the rollback restores the mixed capture.
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(4);
  await h.harness.refreshLiveTxTable();
  eq(h.harness.lastLiveTxSignature, sigA, 'signature A after the failed repair attempt');
  ok(h.harness.liveTxDisplayRepairRequired, 'repair still required');
  // Boundary 3: the successful repair commits B.
  await h.harness.refreshLiveTxTable();
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed only after the successful repair');
  eq(h.kpi.textContent, '6', 'KPI is 6 after the successful repair');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent');
});

test('44. listener-only recovery cannot clear content repair state, and repair re-binds without duplicates (PM-01 repair Test 7)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadA, payloadB, sigA } = await setupMixedDisplay(h);
  // The failed restore's own re-bind succeeded on the restored rows, yet
  // the display is still repair-required: listener success is not
  // content repair.
  ok(h.harness.liveTxDisplayRepairRequired, 'repair-required after the failed restore despite a successful listener re-bind');
  // Arm a live-listener failure for the repair render: the repair fails
  // at binding, the rollback restores the mixed capture, and the listener
  // failure must not mask the repair state.
  h.setPayload({ payments: payloadB });
  h.setLiveListenerFailsAt(1);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'repair-required survives a listener-failed repair attempt');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  // Disarm and repair fully: every row ends with exactly one handler.
  h.setLiveListenerFailsAt(null);
  await h.harness.refreshLiveTxTable();
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the repair');
  for (const p of payloadB) eq(h.liveRowHandlers(p.paymentDigest), 1, 'every B row has exactly one handler after repair');
  // An unchanged-payload refresh after the repair does not duplicate
  // handlers (the healthy shortcut recovers nothing extra).
  await h.harness.refreshLiveTxTable();
  for (const p of payloadB) eq(h.liveRowHandlers(p.paymentDigest), 1, 'every B row still has exactly one handler after the unchanged refresh');
});

test('45. network, HTTP, unreadable JSON, and malformed-list outcomes preserve the repair warning while repair is required (PM-01 repair Test 8)', async () => {
  type Resp = { ok: boolean; status?: number; json: () => Promise<unknown> };
  const responses: Array<() => Promise<Resp>> = [];
  const h = makeFullAtomicHarness({ fetchImpl: async () => responses.shift()!() });
  const okResp = (data: unknown): Resp => ({ ok: true, json: async () => data });
  const payloadA = base5();
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  responses.push(async () => okResp({ payments: payloadA }));
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const sigA = h.harness.lastLiveTxSignature;
  responses.push(async () => okResp({ payments: payloadB }));
  h.setArchiveFailsAt(2);
  h.setLiveRestoreFails(htmlA);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'setup: repair-required');
  ok(h.summary.textContent.includes('RESTORE FAILED'), 'setup: the repair warning is shown');
  const mixedHtml = h.mount.innerHTML;
  const mixedArchive = h.archiveHtml();
  const mixedSummary = h.summary.textContent;
  // 1. Network failure.
  responses.push(async () => { throw new Error('network down'); });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, mixedHtml, 'network failure did not change the mixed table');
  eq(h.archiveHtml(), mixedArchive, 'network failure did not change the mixed archive');
  eq(h.kpi.textContent, '5', 'network failure kept the mixed KPI');
  eq(h.summary.textContent, mixedSummary, 'network failure kept the repair warning');
  ok(h.harness.liveTxDisplayRepairRequired, 'network failure kept repair-required');
  // 2. HTTP error.
  responses.push(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, mixedHtml, 'HTTP error did not change the mixed table');
  eq(h.archiveHtml(), mixedArchive, 'HTTP error did not change the mixed archive');
  eq(h.kpi.textContent, '5', 'HTTP error kept the mixed KPI');
  eq(h.summary.textContent, mixedSummary, 'HTTP error kept the repair warning');
  ok(h.harness.liveTxDisplayRepairRequired, 'HTTP error kept repair-required');
  // 3. Unreadable JSON.
  responses.push(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }));
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, mixedHtml, 'unreadable JSON did not change the mixed table');
  eq(h.archiveHtml(), mixedArchive, 'unreadable JSON did not change the mixed archive');
  eq(h.kpi.textContent, '5', 'unreadable JSON kept the mixed KPI');
  eq(h.summary.textContent, mixedSummary, 'unreadable JSON kept the repair warning');
  ok(h.harness.liveTxDisplayRepairRequired, 'unreadable JSON kept repair-required');
  // 4. Malformed list.
  responses.push(async () => okResp({ payments: 'not-an-array' }));
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, mixedHtml, 'malformed list did not change the mixed table');
  eq(h.archiveHtml(), mixedArchive, 'malformed list did not change the mixed archive');
  eq(h.kpi.textContent, '5', 'malformed list kept the mixed KPI');
  eq(h.summary.textContent, mixedSummary, 'malformed list kept the repair warning');
  ok(h.harness.liveTxDisplayRepairRequired, 'malformed list kept repair-required');
  eq(h.harness.lastLiveTxSignature, sigA, 'no failed outcome committed a signature');
  // A later successful repair still works.
  responses.push(async () => okResp({ payments: payloadB }));
  await h.harness.refreshLiveTxTable();
  ok(!h.harness.liveTxDisplayRepairRequired, 'the repair succeeds after the failed outcomes');
  eq(h.kpi.textContent, '6', 'KPI is 6 after the repair');
});

test('46. a stale request and a deferred JSON completion cannot overwrite a newer accepted repair (PM-01 repair Test 9)', async () => {
  type Resp = { ok: boolean; json: () => Promise<unknown> };
  const responses: Array<() => Promise<Resp>> = [];
  const h = makeFullAtomicHarness({ fetchImpl: async () => responses.shift()!() });
  const okResp = (data: unknown): Resp => ({ ok: true, json: async () => data });
  const payloadA = base5();
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  responses.push(async () => okResp({ payments: payloadA }));
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  responses.push(async () => okResp({ payments: payloadB }));
  h.setArchiveFailsAt(2);
  h.setLiveRestoreFails(htmlA);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'setup: repair-required');
  // Start an older repair attempt (B) that resolves late, and a newer
  // repair attempt (B) that resolves first.
  const older = deferred<Resp>();
  const newer = deferred<Resp>();
  responses.push(async () => older.promise);
  responses.push(async () => newer.promise);
  const loadOlder = h.harness.refreshLiveTxTable();
  const loadNewer = h.harness.refreshLiveTxTable();
  newer.resolve({ ok: true, json: async () => ({ payments: payloadB }) });
  await loadNewer;
  eq(h.kpi.textContent, '6', 'KPI is 6 after the newer repair');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the newer repair cleared repair-required');
  const shown = h.mount.innerHTML;
  const archiveShown = h.archiveHtml();
  const summaryShown = h.summary.textContent;
  const sigB = h.harness.lastLiveTxSignature;
  // The older repair resolves later with the same B payload: stale, must
  // not touch anything.
  older.resolve({ ok: true, json: async () => ({ payments: payloadB }) });
  await loadOlder;
  eq(h.mount.innerHTML, shown, 'the older response did not re-render the table');
  eq(h.archiveHtml(), archiveShown, 'the older response did not touch the archive surfaces');
  eq(h.summary.textContent, summaryShown, 'the older response did not change the status');
  eq(h.harness.lastLiveTxSignature, sigB, 'the older response did not change the signature');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the older response did not re-mark repair-required');
  // A deferred JSON rejection from an older request cannot overwrite the
  // repaired state either.
  const third = deferred<Resp>();
  const fourth = deferred<Resp>();
  responses.push(async () => third.promise);
  responses.push(async () => fourth.promise);
  const loadOld2 = h.harness.refreshLiveTxTable();
  const loadNew2 = h.harness.refreshLiveTxTable();
  fourth.resolve({ ok: true, json: async () => ({ payments: payloadB }) });
  await loadNew2;
  const summaryAfterNewer = h.summary.textContent;
  third.reject(new Error('network down'));
  await loadOld2;
  eq(h.mount.innerHTML, shown, 'the older rejection did not change the table');
  eq(h.archiveHtml(), archiveShown, 'the older rejection did not touch the archive surfaces');
  eq(h.summary.textContent, summaryAfterNewer, 'the older rejection did not change the status');
  eq(h.harness.lastLiveTxSignature, sigB, 'the older rejection did not change the signature');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the older rejection did not re-mark repair-required');
});

test('47. a successful rollback to a known-good A keeps the unchanged shortcut — no unnecessary full rendering (PM-01 repair Test 10)', async () => {
  const h = makeFullAtomicHarness();
  const payloadA = base5();
  h.setPayload({ payments: payloadA });
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  const archiveA = h.archiveHtml();
  const sigA = h.harness.lastLiveTxSignature;
  // A late archive failure with a SUCCESSFUL rollback: the display is
  // fully A again and healthy (repair is NOT required).
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  h.setPayload({ payments: payloadB });
  h.setArchiveFailsAt(2);
  await h.harness.refreshLiveTxTable();
  ok(!h.harness.liveTxDisplayRepairRequired, 'a successful rollback leaves the display consistent');
  eq(h.mount.innerHTML, htmlA, 'the live table was restored to A');
  eq(h.archiveHtml(), archiveA, 'the archive surfaces were restored to A');
  ok(h.summary.textContent.includes('STALE'), 'the successful rollback reports STALE');
  const liveSetsBefore = h.mount.sets;
  const archiveSetsBefore = h.archiveMounts.map(m => m.sets);
  // An identical A response now takes the healthy unchanged shortcut:
  // no content assignment anywhere.
  h.setPayload({ payments: payloadA });
  await h.harness.refreshLiveTxTable();
  eq(h.mount.innerHTML, htmlA, 'the unchanged payload was not re-rendered');
  eq(h.mount.sets, liveSetsBefore, 'no table assignment on the unchanged refresh');
  h.archiveMounts.forEach((m, i) => eq(m.sets, archiveSetsBefore[i], 'archive surface ' + i + ' was not re-rendered'));
  eq(h.kpi.textContent, '5', 'KPI is still 5');
  eq(h.harness.lastLiveTxSignature, sigA, 'signature A is still committed');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display stays consistent');
  notOk(h.summary.textContent.includes('RENDER ERROR'), 'the shortcut replaced the error status with success');
});

// ── PM-01-R1 success-status ordering (Sol 7308340) ────────────────────────
// The loader publishes a success status only after every required
// content operation has completed and the signature and health are
// committed. These tests observe the status-write ORDER (via the
// harness's statusWrites log), not just the final text: a failed
// attempt must write exactly one status — the failure report — and
// never an intermediate success.

test('48. a live-table render failure publishes no intermediate success status (PM-01-R1 boundary)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadB, sigA } = await setupMixedDisplay(h);
  const mixedHtml = h.mount.innerHTML;
  const mixedArchive = h.archiveHtml();
  // Arm a one-shot failure at the live-table assignment of the repair render.
  h.setLiveRenderFails(true);
  h.setPayload({ payments: payloadB });
  const before = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const during = h.statusWrites().slice(before);
  eq(during.length, 1, 'exactly one status write during the failed attempt');
  ok(during[0].includes('RENDER ERROR'), 'the only status write reports the render error');
  ok(during[0].includes('REPAIR REQUIRED'), 'the repair warning survives the failed attempt');
  notOk(during.some(w => w.includes('API response received')), 'no intermediate success status was published');
  ok(h.harness.liveTxDisplayRepairRequired, 'repair still required after the failed attempt');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  eq(h.mount.innerHTML, mixedHtml, 'the mixed live table is restored');
  eq(h.archiveHtml(), mixedArchive, 'the mixed archive is restored');
  // A clean retry publishes success exactly once, as its last status write.
  h.setPayload({ payments: payloadB });
  const beforeRetry = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const retryWrites = h.statusWrites().slice(beforeRetry);
  eq(retryWrites.length, 1, 'exactly one status write during the successful repair');
  ok(retryWrites[0].includes('API response received'), 'the successful repair publishes the success status');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the repair');
  eq(h.kpi.textContent, '6', 'KPI is 6 after the repair');
});

test('49. a missing KPI mount fails the repair without an intermediate success status, and records an accurate diagnostic (PM-01-R1)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadB, sigA } = await setupMixedDisplay(h);
  const mixedHtml = h.mount.innerHTML;
  const mixedArchive = h.archiveHtml();
  // The KPI mount disappears: the repair render must fail at the KPI
  // update instead of silently skipping it and publishing success.
  h.setKpiMissing(true);
  h.setPayload({ payments: payloadB });
  const before = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const during = h.statusWrites().slice(before);
  eq(during.length, 1, 'exactly one status write during the failed attempt');
  ok(during[0].includes('RESTORE FAILED'), 'the missing KPI is reported as a restore failure');
  ok(during[0].includes('(kpi)'), 'the failed step names the KPI mount');
  notOk(during.some(w => w.includes('API response received')), 'no intermediate success status was published');
  ok(h.harness.liveTxDisplayRepairRequired, 'repair still required after the failed attempt');
  eq(h.harness.liveTxRestoreFailedStep, 'kpi', 'the failed step is the KPI mount');
  eq(h.harness.liveTxRestoreFailedDetail, 'required mount kpi is missing', 'the diagnostic names the missing mount instead of reusing an older error');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  eq(h.mount.innerHTML, mixedHtml, 'the mixed live table is restored');
  eq(h.archiveHtml(), mixedArchive, 'the mixed archive is restored');
  // Restore the mount and retry: the repair succeeds and publishes
  // success exactly once, as its last status write.
  h.setKpiMissing(false);
  h.setPayload({ payments: payloadB });
  const beforeRetry = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const retryWrites = h.statusWrites().slice(beforeRetry);
  eq(retryWrites.length, 1, 'exactly one status write during the successful repair');
  ok(retryWrites[0].includes('API response received'), 'the successful repair publishes the success status');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the repair');
  eq(h.kpi.textContent, '6', 'KPI is 6 after the repair');
});

test('50. a failure at any archive surface publishes no intermediate success status (PM-01-R1 boundary)', async () => {
  for (let idx = 0; idx < ARCHIVE_IDS.length; idx++) {
    const h = makeFullAtomicHarness();
    const { payloadB, sigA } = await setupMixedDisplay(h);
    const mixedHtml = h.mount.innerHTML;
    const mixedArchive = h.archiveHtml();
    h.setArchiveFailsAt(idx);
    h.setPayload({ payments: payloadB });
    const before = h.statusWrites().length;
    await h.harness.refreshLiveTxTable();
    const during = h.statusWrites().slice(before);
    eq(during.length, 1, 'surface ' + ARCHIVE_IDS[idx] + ': exactly one status write during the failed attempt');
    ok(during[0].includes('RENDER ERROR'), 'surface ' + ARCHIVE_IDS[idx] + ': the only status write reports the render error');
    ok(during[0].includes('REPAIR REQUIRED'), 'surface ' + ARCHIVE_IDS[idx] + ': the repair warning survives');
    notOk(during.some(w => w.includes('API response received')), 'surface ' + ARCHIVE_IDS[idx] + ': no intermediate success status was published');
    ok(h.harness.liveTxDisplayRepairRequired, 'surface ' + ARCHIVE_IDS[idx] + ': repair still required');
    eq(h.harness.lastLiveTxSignature, sigA, 'surface ' + ARCHIVE_IDS[idx] + ': the failed payload signature is not committed');
    eq(h.mount.innerHTML, mixedHtml, 'surface ' + ARCHIVE_IDS[idx] + ': the mixed live table is restored');
    eq(h.archiveHtml(), mixedArchive, 'surface ' + ARCHIVE_IDS[idx] + ': the mixed archive is restored');
    // A clean retry publishes success exactly once, as its last write.
    h.setPayload({ payments: payloadB });
    const beforeRetry = h.statusWrites().length;
    await h.harness.refreshLiveTxTable();
    const retryWrites = h.statusWrites().slice(beforeRetry);
    eq(retryWrites.length, 1, 'surface ' + ARCHIVE_IDS[idx] + ': exactly one status write during the successful repair');
    ok(retryWrites[0].includes('API response received'), 'surface ' + ARCHIVE_IDS[idx] + ': the successful repair publishes the success status');
    ok(!h.harness.liveTxDisplayRepairRequired, 'surface ' + ARCHIVE_IDS[idx] + ': the display is consistent after the repair');
  }
});

test('51. an archive-listener failure publishes no intermediate success status, and repair re-binds without duplicates (PM-01-R1 boundary)', async () => {
  const h = makeFullAtomicHarness();
  const { payloadB, sigA } = await setupMixedDisplay(h);
  // Arm a failure on the first archive-listener bind of the repair pass.
  h.setArchiveListenerFailsAt(1);
  h.setPayload({ payments: payloadB });
  const before = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const during = h.statusWrites().slice(before);
  eq(during.length, 1, 'exactly one status write during the failed attempt');
  ok(during[0].includes('RENDER ERROR'), 'the only status write reports the render error');
  ok(during[0].includes('REPAIR REQUIRED'), 'the repair warning survives the failed attempt');
  notOk(during.some(w => w.includes('API response received')), 'no intermediate success status was published');
  ok(h.harness.liveTxDisplayRepairRequired, 'repair still required after the failed attempt');
  eq(h.harness.lastLiveTxSignature, sigA, 'the failed payload signature is not committed');
  // The render's archive bind threw on its first call, and the rollback's
  // re-bind threw the same way: no archive row has a handler yet.
  eq(h.archiveRowHandlers(h.digestOther), 0, 'no archive row handler was bound while the failure was armed');
  // Disarm and repair: every archive row ends with exactly one handler.
  h.setArchiveListenerFailsAt(null);
  await h.harness.refreshLiveTxTable();
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the repair');
  eq(h.archiveRowHandlersPerMount(h.digestOther).join(','), '1,1,1,1,1', 'every archive surface binds its row exactly once after repair');
  // An unchanged-payload refresh after the repair does not duplicate handlers.
  await h.harness.refreshLiveTxTable();
  eq(h.archiveRowHandlersPerMount(h.digestOther).join(','), '1,1,1,1,1', 'every archive surface still has exactly one handler after the unchanged refresh');
});

test('52. a genuinely deferred response.json() cannot overwrite a newer accepted repair (PM-01-R1)', async () => {
  type Resp = { ok: boolean; json: () => Promise<unknown> };
  const responses: Array<() => Promise<Resp>> = [];
  const h = makeFullAtomicHarness({ fetchImpl: async () => responses.shift()!() });
  const payloadA = base5();
  const payloadB = [pay(h.digestB, 'finalized', 2000), ...base5()];
  responses.push(async () => ({ ok: true, json: async () => ({ payments: payloadA }) }));
  await h.harness.loadLiveTxTable();
  const htmlA = h.mount.innerHTML;
  responses.push(async () => ({ ok: true, json: async () => ({ payments: payloadB }) }));
  h.setArchiveFailsAt(2);
  h.setLiveRestoreFails(htmlA);
  await h.harness.refreshLiveTxTable();
  ok(h.harness.liveTxDisplayRepairRequired, 'setup: repair-required');
  // R1-T1 fix (Sol 7308541): the older request must GENUINELY enter
  // res.json() before the newer request starts. The previous version
  // started both loaders back-to-back, so the older loader exited at
  // the post-fetch stale guard (production line 5505) before ever
  // calling json(); resolving/rejecting its JSON then settled a promise
  // nobody consumed. Here the older response's json() resolves an
  // explicit signal the moment it is called, and returns a still-pending
  // promise. Every step is ordered by promise resolution — no setTimeout,
  // no sleep, no reliance on unspecified scheduling.
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // Snapshot helper: every observable the deferred-JSON guard must
    // leave untouched, including per-surface archive HTML and the
    // repair diagnostics.
    const snapshot = () => ({
      live: h.mount.innerHTML,
      kpi: h.kpi.textContent,
      summary: h.harness.lastLivePaymentSummary,
      archives: h.archiveMounts.map(m => m.innerHTML),
      status: h.summary.textContent,
      signature: h.harness.lastLiveTxSignature,
      repairRequired: h.harness.liveTxDisplayRepairRequired,
      failedStep: h.harness.liveTxRestoreFailedStep,
      failedDetail: h.harness.liveTxRestoreFailedDetail,
      statusWrites: h.statusWrites().length,
    });
    const eqSnapshot = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>, label: string) => {
      eq(a.live, b.live, label + ': live table unchanged');
      eq(a.kpi, b.kpi, label + ': KPI unchanged');
      eq(a.summary, b.summary, label + ': payment summary unchanged');
      eq(a.archives.join('\n'), b.archives.join('\n'), label + ': all five archive surfaces unchanged');
      eq(a.status, b.status, label + ': status unchanged');
      eq(a.signature, b.signature, label + ': signature unchanged');
      eq(a.repairRequired, b.repairRequired, label + ': repair-required unchanged');
      eq(a.failedStep, b.failedStep, label + ': failed step unchanged');
      eq(a.failedDetail, b.failedDetail, label + ': failed detail unchanged');
      eq(a.statusWrites, b.statusWrites, label + ': no extra status publication');
    };

    // --- Scenario 1: deferred JSON resolution. ---
    const olderJson = deferred<unknown>();
    const newerJson = deferred<unknown>();
    let olderJsonCalls = 0;
    let olderJsonCalledResolve!: () => void;
    const olderJsonCalled = new Promise<void>((res) => { olderJsonCalledResolve = res; });
    responses.push(async () => ({
      ok: true,
      json: () => { olderJsonCalls++; olderJsonCalledResolve(); return olderJson.promise; },
    }));
    responses.push(async () => ({ ok: true, json: () => newerJson.promise }));
    // 1. Start the older loader. A refresh publishes nothing and touches
    // no mount before its fetch resolves, so the display is untouched.
    const loadOlder = h.harness.refreshLiveTxTable();
    const loadOlderP = Promise.resolve(loadOlder);
    // 2-3. The older fetch has resolved and the older loader has genuinely
    // entered json(): the signal fires only inside json().
    await olderJsonCalled;
    eq(olderJsonCalls, 1, 'older json() was called exactly once');
    // 4. The older JSON is still pending: the loader is suspended on it.
    // Prove it without a timeout — the loader's promise cannot resolve
    // while the promise it awaits is unresolved.
    let olderDone = false;
    void loadOlderP.then(() => { olderDone = true; });
    await Promise.resolve();
    await Promise.resolve();
    ok(!olderDone, 'the older loader is still suspended on its pending JSON');
    // 5-7. Start the newer request and let it complete the repair.
    const loadNewer = h.harness.refreshLiveTxTable();
    newerJson.resolve({ payments: payloadB });
    await loadNewer;
    eq(h.kpi.textContent, '6', 'KPI is 6 after the newer repair');
    ok(!h.harness.liveTxDisplayRepairRequired, 'the newer repair cleared repair-required');
    ok(h.summary.textContent.includes('API response received'), 'the newer repair published success');
    const afterNewer = snapshot();
    // 8-9. Only now resolve the older JSON, and wait for the older loader.
    olderJson.resolve({ payments: payloadB });
    await loadOlderP;
    // 10. The stale post-JSON guard must leave every observable identical.
    eqSnapshot(snapshot(), afterNewer, 'older JSON resolve');
    eq(olderJsonCalls, 1, 'older json() was not called again');

    // --- Scenario 2: deferred JSON rejection. ---
    const olderJson2 = deferred<unknown>();
    const newerJson2 = deferred<unknown>();
    let olderJson2Calls = 0;
    let olderJson2CalledResolve!: () => void;
    const olderJson2Called = new Promise<void>((res) => { olderJson2CalledResolve = res; });
    responses.push(async () => ({
      ok: true,
      json: () => { olderJson2Calls++; olderJson2CalledResolve(); return olderJson2.promise; },
    }));
    responses.push(async () => ({ ok: true, json: () => newerJson2.promise }));
    // 1-3. The older loader genuinely enters json() before the newer starts.
    const loadOld2 = h.harness.refreshLiveTxTable();
    const loadOld2P = Promise.resolve(loadOld2);
    await olderJson2Called;
    eq(olderJson2Calls, 1, 'older json() was called exactly once (reject scenario)');
    let old2Done = false;
    void loadOld2P.then(() => { old2Done = true; });
    await Promise.resolve();
    await Promise.resolve();
    ok(!old2Done, 'the older loader is still suspended on its pending JSON (reject scenario)');
    // 4-5. Start and complete the newer request (identical B payload, so
    // the healthy display takes the unchanged-signature shortcut).
    const loadNew2 = h.harness.refreshLiveTxTable();
    newerJson2.resolve({ payments: payloadB });
    await loadNew2;
    ok(h.summary.textContent.includes('Latest API request succeeded'), 'the newer refresh completed via the healthy shortcut');
    eq(h.harness.lastLiveTxSignature, afterNewer.signature, 'the newer refresh kept signature B');
    const afterNewer2 = snapshot();
    // 6-7. Reject the older JSON; the loader consumes the rejection in its
    // catch path and returns at the stale guard without touching state.
    olderJson2.reject(new Error('bad json'));
    await loadOld2P;
    eqSnapshot(snapshot(), afterNewer2, 'older JSON reject');
    eq(olderJson2Calls, 1, 'older json() was not called again (reject scenario)');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  eq(unhandled.length, 0, 'no unhandled rejection during the deferred-JSON scenarios');
});

test('53. a missing KPI mount on the first load fails the render without publishing success (PM-01-R1)', async () => {
  const h = makeFullAtomicHarness();
  h.setKpiMissing(true);
  h.setPayload({ payments: base5() });
  const before = h.statusWrites().length;
  await h.harness.loadLiveTxTable();
  const during = h.statusWrites().slice(before);
  // A non-refresh first load writes Loading first, then the restore
  // failure report — and nothing else, in particular no success status.
  eq(during.length, 2, 'exactly two status writes during the failed first load');
  ok(during[0].includes('Loading'), 'the first write is the loading status');
  ok(during[1].includes('RESTORE FAILED'), 'the missing KPI is reported as a restore failure');
  ok(during[1].includes('(kpi)'), 'the failed step names the KPI mount');
  notOk(during.some(w => w.includes('API response received')), 'no intermediate success status was published');
  ok(h.harness.liveTxDisplayRepairRequired, 'repair-required after the failed first load');
  eq(h.harness.liveTxRestoreFailedStep, 'kpi', 'the failed step is the KPI mount');
  eq(h.harness.liveTxRestoreFailedDetail, 'required mount kpi is missing', 'the diagnostic names the missing mount');
  eq(h.harness.lastLiveTxSignature, null, 'no signature is committed by the failed first load');
  // Restore the mount and retry with a refresh: the load succeeds and
  // publishes success exactly once, as its last status write.
  h.setKpiMissing(false);
  const beforeRetry = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const retryWrites = h.statusWrites().slice(beforeRetry);
  eq(retryWrites.length, 1, 'exactly one status write during the successful load');
  ok(retryWrites[0].includes('API response received'), 'the successful load publishes the success status');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the load');
  eq(h.kpi.textContent, '5', 'KPI is 5 after the load');
});

test('54. successful nonempty and empty repairs render exact content on all seven surfaces (PM-01-R1)', async () => {
  // Nonempty repair: exact live table, KPI, summary, and all five
  // archive surfaces after a successful B repair.
  const h = makeFullAtomicHarness();
  const { payloadB, sigA } = await setupMixedDisplay(h);
  h.setPayload({ payments: payloadB });
  const before = h.statusWrites().length;
  await h.harness.refreshLiveTxTable();
  const during = h.statusWrites().slice(before);
  eq(during.length, 1, 'the successful repair writes exactly one status');
  eq(h.mount.innerHTML, h.harness.buildLiveTxTableHTML(payloadB), 'the live table is exactly the B render');
  eq(h.kpi.textContent, '6', 'KPI is 6 after the repair');
  eq(h.summary.textContent, h.harness.lastLivePaymentSummary + ' API response received. Counts describe the displayed list, not an all-time total. Read-only: no payment is made by this page.', 'the summary is the exact success status');
  eq(h.archiveMounts[0].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'dashboard archive is exactly the B-filtered rows');
  eq(h.archiveMounts[1].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'transactions-page archive is exactly the B-filtered rows');
  eq(h.archiveMounts[2].innerHTML, h.harness.buildTxTableHTML([h.archiveRows[2]]), 'wallet archive is exactly the B-filtered rows');
  eq(h.archiveMounts[3].innerHTML, h.harness.buildPodiumHTML([h.archiveRows[2]]), 'podium is exactly the B-filtered rows');
  eq(h.archiveMounts[4].innerHTML, h.harness.buildRibbonHTML([h.archiveRows[2]]), 'ribbon is exactly the B-filtered rows');
  ok(!h.harness.liveTxDisplayRepairRequired, 'the display is consistent after the repair');
  notOk(h.harness.lastLiveTxSignature === sigA, 'signature B is committed');

  // Empty repair: exact empty live state, KPI 0, EMPTY summary, and the
  // full archive on all five surfaces.
  const h2 = makeFullAtomicHarness();
  await setupMixedDisplay(h2);
  h2.setPayload({ payments: [] });
  const beforeEmpty = h2.statusWrites().length;
  await h2.harness.refreshLiveTxTable();
  const emptyWrites = h2.statusWrites().slice(beforeEmpty);
  eq(emptyWrites.length, 1, 'the successful empty repair writes exactly one status');
  ok(h2.mount.innerHTML.includes('No live settlements recorded yet'), 'the live table is the exact empty state');
  eq(h2.kpi.textContent, '0', 'KPI is 0 after the empty repair');
  eq(h2.summary.textContent, h2.harness.lastLivePaymentSummary + ' EMPTY — API returned no payment records. Read-only: no payment is made by this page.', 'the summary is the exact EMPTY status');
  eq(h2.archiveHtml(), fullArchiveHtml(h2), 'all five archive surfaces show the full archive');
  ok(!h2.harness.liveTxDisplayRepairRequired, 'the display is consistent after the empty repair');
  eq(h2.harness.lastLiveTxSignature, null, 'the empty repair invalidates the signature');
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
console.log(`\nlive-tx-kpi: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
