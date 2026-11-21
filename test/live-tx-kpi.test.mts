/**
 * Live transaction KPI contract (frontend): the sidebar "x402 Proofs" beacon
 * must show the count of live facilitator settlement records from
 * GET /api/payments — the same dataset the Transactions table renders —
 * and never a hardcoded number.
 *
 * Asserts, on the page markup and the list loader code:
 *   - the beacon KPI is `<span id="live-tx-count">—</span> Live Txs`: the
 *     number is a live element, the loading state is "—" (not 0, not a
 *     stale hardcoded count), and "4 Live Txs" appears nowhere;
 *   - the KPI is updated from the same /api/payments payload the table
 *     renders, with no extra request: the list still fetches from a
 *     single call site, and the KPI updater is called on the render path
 *     and on the initial-empty path only;
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
  const beacon = html.indexOf('x402 Proofs');
  ok(beacon >= 0, 'x402 Proofs beacon row exists');
  const kpi = html.indexOf('id="live-tx-count"', beacon);
  ok(kpi > beacon, 'KPI element lives in the beacon row');
  ok(kpi - beacon < 500, 'KPI element is the beacon value, not elsewhere');
  ok(html.includes('<span id="live-tx-count">—</span> Live Txs'), 'KPI reads "— Live Txs" before the first load');
  notOk(html.includes('4 Live Txs'), 'no hardcoded "4 Live Txs" anywhere');
  notOk(html.includes('>4 Live Txs<'), 'no hardcoded count in the beacon');
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
  eq(calls, 2, 'two KPI update sites: initial-empty and render');
  ok(loader.indexOf('updateLiveTxKpi(payments)') > loader.lastIndexOf('if (isRefresh) return;'),
    'every failure guard returns before any KPI write');
  ok(loader.includes('if (isRefresh && signature === lastLiveTxSignature) return;'),
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

function makeHarness() {
  const mount = {
    _html: '',
    sets: 0,
    set innerHTML(v: string) { this._html = v; this.sets++; },
    get innerHTML() { return this._html; },
    querySelectorAll() { return [] as unknown[]; },
  };
  const kpi = { textContent: '—' };
  let pageActive = true;
  let tabHidden = false;
  const documentStub = {
    getElementById: (id: string) =>
      (id === 'live-tx-table-mount' ? mount : id === 'live-tx-count' ? kpi : null),
    querySelector: (sel: string) => (sel === '#page-transactions.active' && pageActive ? {} : null),
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
  const loaderSrc = extractFunctionSource('loadLiveTxTable');
  const asyncLoaderSrc = loaderSrc.startsWith('async ') ? loaderSrc : `async ${loaderSrc}`;
  const harness = new Function('document', 'fetch', 'apiUrl', 'buildLiveTxTableHTML', 'applyArchiveDedup', 'location',
    `let lastLiveTxSignature = null;\n${extractFunctionSource('liveTxTableSignature')}\n${extractFunctionSource('updateLiveTxKpi')}\n${asyncLoaderSrc}\n${extractFunctionSource('refreshLiveTxTable')}\nreturn { loadLiveTxTable, refreshLiveTxTable, updateLiveTxKpi };`)
    (documentStub, fetchStub, (p: string) => p, buildStub, () => {}, { hash: '' }) as unknown as {
      loadLiveTxTable: (isRefresh?: boolean) => Promise<void>;
      refreshLiveTxTable: () => Promise<void> | void;
      updateLiveTxKpi: (payments: unknown[]) => void;
    };
  const rows = () => (mount.innerHTML.match(/clickable-tx/g) ?? []).length;
  return {
    harness, mount, kpi, rows,
    setPayload: (p: unknown) => { nextPayload = p; },
    setFetchFails: (v: boolean) => { fetchFails = v; },
    setPageActive: (v: boolean) => { pageActive = v; },
    setTabHidden: (v: boolean) => { tabHidden = v; },
    fetchCalls: () => fetchCalls,
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
