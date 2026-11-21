/**
 * Payment list view contract (frontend): the transactions page must show
 * the facilitator's live settlement records from GET /api/payments above
 * the historical archive, and never present archive rows as live.
 *
 * Asserts, on the page markup and the list code:
 *   - the live section exists above the archive section, with its own
 *     mount; the archive section is headed "Earlier Settlements —
 *     11 November 2026" and labelled HISTORICAL ARCHIVE;
 *   - the list fetches `apiUrl('/api/payments')` from a single call site,
 *     with no retry-on-failure; it re-fetches on a 30-second timer and on
 *     navigation to the Transactions page, but only while that page is
 *     visible, and a refresh never replaces the table with an error and
 *     never re-renders an unchanged payload; the initial route change
 *     skips its refresh because the initial load already fetched;
 *   - archive rows (buildTxTableHTML, podium) carry HISTORICAL ARCHIVE
 *     and no LIVE - TESTNET badge;
 *   - live row status follows the stored state only: finalized shows
 *     FINALIZED — STORED STATE, any other state shows NOT FINALIZED;
 *     the list code contains no live-verification badge;
 *   - live rows that also appear in the archive are dropped from the
 *     archive (deduplication), and the loading / empty / error states
 *     exist;
 *   - block, amount, fee, sender and recipient cells render the real
 *     values from the enriched list response, and honestly read
 *     "not available" only when the evidence is absent.
 *
 * Static analysis only — no browser, no server. The inspector and its
 * F1 gate are covered by payment-detail-view.test.mts, not here.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');

// The live-list code region: from the live row-state badge (the first
// live-list function) through the loader call. Everything the list does
// lives in this slice.
const listStart = html.indexOf('function liveRowStateBadge');
ok(listStart >= 0, 'live table builder exists');
const listEnd = html.indexOf('loadLiveTxTable();', listStart);
ok(listEnd > listStart, 'live loader call found after the builder');
const listBody = html.slice(listStart, listEnd);

// The archive table builder region.
const archiveStart = html.indexOf('function buildTxTableHTML(rows)');
ok(archiveStart >= 0, 'archive table builder exists');
const archiveEnd = html.indexOf('function buildPodiumHTML', archiveStart);
ok(archiveEnd > archiveStart, 'podium builder found after the archive builder');
const archiveBody = html.slice(archiveStart, archiveEnd);

// The podium builder region.
const podiumStart = archiveEnd;
const podiumEnd = html.indexOf('function buildRibbonHTML', podiumStart);
ok(podiumEnd > podiumStart, 'ribbon builder found after the podium builder');
const podiumBody = html.slice(podiumStart, podiumEnd);

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. live section sits above the archive section, each with its own mount', () => {
  const liveMount = html.indexOf('id="live-tx-table-mount"');
  const archiveMount = html.indexOf('id="transactions-page-table-mount"');
  ok(liveMount >= 0, 'live mount exists');
  ok(archiveMount > liveMount, 'live mount comes before the archive mount');
  ok(html.includes('Live Settlements — Facilitator Records'), 'live section heading present');
  ok(html.includes('Earlier Settlements — 11 November 2026'), 'archive section heading present');
  ok(html.includes('HISTORICAL ARCHIVE'), 'archive label present');
});

test('02. the list fetches GET /api/payments from a single call site, with no retry-on-failure', () => {
  const fetches = (listBody.match(/fetch\(apiUrl\('\/api\/payments'\)\)/g) ?? []).length;
  eq(fetches, 1, 'one list fetch');
  notOk(listBody.includes('setTimeout'), 'no retry timer in the list code');
  notOk(listBody.includes('setInterval'), 'no timer inside the loader itself');
  ok(listBody.includes("await fetch(apiUrl('/api/payments'))"), 'fetch uses the configured API base');
});

test('03. no live payment hash is hardcoded in the list code', () => {
  for (const h of ['326f6598', '705ec84d', '534fa5b2', '869f11bd', 'd3cbea4f', '06c75b2c']) {
    notOk(listBody.includes(h), `no hardcoded live hash ${h}`);
  }
});

test('04. archive rows carry HISTORICAL ARCHIVE, never a LIVE badge', () => {
  ok(archiveBody.includes('HISTORICAL ARCHIVE'), 'archive table uses the archive label');
  notOk(archiveBody.includes('LIVE - TESTNET'), 'archive table has no LIVE badge');
  ok(archiveBody.includes('badge-demo'), 'archive label uses the non-live badge style');
  ok(podiumBody.includes('HISTORICAL ARCHIVE'), 'podium uses the archive label');
  notOk(podiumBody.includes('LIVE - TESTNET'), 'podium has no LIVE badge');
});

test('05. live row status follows the stored state only', () => {
  ok(listBody.includes('FINALIZED — STORED STATE'), 'finalized rows show the stored-state badge');
  ok(listBody.includes('NOT FINALIZED — '), 'non-finalized rows show NOT FINALIZED');
  ok(listBody.includes('liveRowStateBadge(p.state)'), 'badge keys off the stored state');
  notOk(listBody.includes('LIVE TESTNET VERIFICATION'), 'no live-verification badge in the list code');
  notOk(listBody.includes('badge-live'), 'no live badge class in the list code');
  ok(listBody.includes('v.available === true'), 'evidence is read only through the strict live-proof gate');
  ok(listBody.includes('renderLiveProofProgress(p)'), 'the proof cell renders through the evidence gate');
});

test('06. live rows that also appear in the archive are dropped from it', () => {
  ok(listBody.includes('applyArchiveDedup'), 'dedup runs after the live list loads');
  ok(listBody.includes('renderArchive(kept)'), 'archive re-renders from the kept rows');
  ok(listBody.includes('liveIds'), 'live identifiers are collected for the dedup');
  ok(listBody.includes('realTransactionsData.filter'), 'archive rows are filtered against the live list');
});

test('07. loading, empty and error states exist and name the archive as unaffected', () => {
  ok(listBody.includes('Loading live settlement records from the facilitator'), 'loading state');
  ok(listBody.includes('No live settlements recorded yet'), 'empty state');
  ok(listBody.includes('Live settlements unavailable — the facilitator could not be reached'), 'fetch-failure state');
  ok(listBody.includes('Live settlements unavailable (HTTP '), 'non-OK state');
  ok(listBody.includes('Live settlements unavailable — the facilitator returned an unreadable response'), 'bad-JSON state');
  ok(listBody.includes('The historical archive below is unaffected'), 'error states point at the intact archive');
});

test('08. live rows render the real block, amount, fee, sender and recipient from the enriched list', () => {
  ok(listBody.includes('formatLiveBlock(p)'), 'block cell renders the enriched block height');
  ok(listBody.includes('formatLiveAmount(p)'), 'amount cell renders the enriched amount');
  ok(listBody.includes('formatLiveFee(p)'), 'fee cell renders the enriched sponsor fee');
  ok(listBody.includes('shortAddr(p.sender)'), 'sender cell renders the enriched sender');
  ok(listBody.includes('shortAddr(p.recipient)'), 'recipient cell renders the enriched recipient');
  ok(html.includes('function formatLiveBlock'), 'block formatter exists');
  ok(html.includes('function formatLiveAmount'), 'amount formatter exists');
  ok(html.includes('function formatLiveFee'), 'fee formatter exists');
  ok(html.includes('function shortAddr'), 'address shortener exists');
  ok(listBody.includes('formatLiveTxTime(p.updatedAt)'), 'row time comes from the stored updated_at');
  ok(listBody.includes('#/transactions/'), 'rows link to the detail inspector');
  ok(listBody.includes('ccdscanTxUrl(p.transactionHash)'), 'rows link to CCDScan when a tx hash exists');
});

// ── behavioural probes: extract the live functions from the page ──────────────

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

const liveProofProgress = new Function(`return ${extractFunctionSource('liveProofProgress')}`)() as unknown as (p: unknown) => {
  percent: number | null;
  label: string;
};
const escapeHtmlForProbe = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const liveRowStateBadge = new Function('escapeHtml', `return ${extractFunctionSource('liveRowStateBadge')}`)(escapeHtmlForProbe) as unknown as (state: unknown) => string;
const renderLiveProofProgress = new Function('escapeHtml', 'liveProofProgress', `return ${extractFunctionSource('renderLiveProofProgress')}`)(escapeHtmlForProbe, liveProofProgress) as unknown as (p: unknown) => string;
const formatLiveBlock = new Function('escapeHtml', `return ${extractFunctionSource('formatLiveBlock')}`)(escapeHtmlForProbe) as unknown as (p: unknown) => string;
const formatLiveAmount = new Function('escapeHtml', `return ${extractFunctionSource('formatLiveAmount')}`)(escapeHtmlForProbe) as unknown as (p: unknown) => string;
const shortAddr = new Function('escapeHtml', `return ${extractFunctionSource('shortAddr')}`)(escapeHtmlForProbe) as unknown as (addr: unknown) => string;
const formatMicroCcdProbe = (micro: unknown): string => {
  if (micro === null || micro === undefined || micro === '') return 'not available';
  const n = Number(micro);
  if (!Number.isFinite(n)) return 'not available';
  return (n / 1000000).toFixed(6) + ' CCD';
};
const formatLiveFee = new Function('formatMicroCcd', `return ${extractFunctionSource('formatLiveFee')}`)(formatMicroCcdProbe) as unknown as (p: unknown) => string;

test('09. stored finalized without live evidence never renders 100%', () => {
  notOk(listBody.includes('width:100%'), 'no hardcoded 100% in the live list code');
  const proof = liveProofProgress({ state: 'finalized', transactionHash: 'a'.repeat(64) });
  eq(proof.percent, null, 'no percent from stored state');
  ok(String(proof.label).includes('NOT VERIFIED'), 'label says not verified');
});

test('10. stored finalized keeps the FINALIZED — STORED STATE label', () => {
  ok(liveRowStateBadge('finalized').includes('FINALIZED — STORED STATE'), 'stored-state label kept');
  ok(liveRowStateBadge('outcome_unknown').includes('NOT FINALIZED'), 'non-finalized keeps NOT FINALIZED');
  notOk(liveRowStateBadge('outcome_unknown').includes('FINALIZED — STORED STATE'), 'no stored-finalized label on non-finalized');
});

test('11. stored non-finalized gets no proof and no finality badge', () => {
  const proof = liveProofProgress({ state: 'outcome_unknown' });
  eq(proof.percent, null, 'no percent');
  const badge = liveRowStateBadge('outcome_unknown');
  notOk(badge.includes('FINALIZED — STORED STATE'), 'no finalized badge');
  notOk(badge.includes('badge-live'), 'no live badge');
});

test('12. genuine live evidence renders the actual verified progress', () => {
  const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  const proof = liveProofProgress({ state: 'finalized', verification: evidence });
  eq(proof.percent, 100, 'verified evidence renders 100%');
  ok(proof.label.includes('VERIFIED'), 'label marks verified');
});

test('13. partial or forged evidence fails closed', () => {
  const base = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  const cases: unknown[] = [
    { ...base, finalized: false },
    { ...base, available: false },
    { ...base, observed: 'rejected' },
    { ...base, source: '' },
    { ...base, blockHash: 'short' },
    { ...base, blockHash: 'z'.repeat(64) },
    null,
  ];
  for (const bad of cases) {
    eq(liveProofProgress({ state: 'finalized', verification: bad }).percent, null, 'evidence rejected');
  }
});

test('15. valid evidence renders 100% together with the VERIFIED FINALITY label', () => {
  const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  const html = renderLiveProofProgress({ state: 'finalized', verification: evidence });
  ok(html.includes('100%'), 'renders the percentage');
  ok(html.includes('VERIFIED FINALITY'), 'renders the verified label explicitly');
  notOk(html.includes('NOT VERIFIED'), 'no not-verified label on valid evidence');
});

test('16. stored state without evidence renders NOT VERIFIED and no percentage', () => {
  for (const row of [{ state: 'finalized' }, { state: 'outcome_unknown' }, {}]) {
    const html = renderLiveProofProgress(row);
    ok(html.includes('NOT VERIFIED'), 'renders the not-verified label');
    ok(html.includes('evidence unavailable'), 'states that evidence is unavailable');
    notOk(html.includes('100%'), 'no percentage without evidence');
    notOk(html.includes('VERIFIED FINALITY'), 'no verified label without evidence');
    notOk(html.includes('width:'), 'no progress bar without evidence');
  }
});

test('17. partial or forged evidence renders fail-closed, never 100%', () => {
  const base = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  const cases: unknown[] = [
    { ...base, finalized: false },
    { ...base, available: false },
    { ...base, observed: 'rejected' },
    { ...base, source: '' },
    { ...base, blockHash: 'short' },
    { ...base, blockHash: 'z'.repeat(64) },
    null,
  ];
  for (const bad of cases) {
    const html = renderLiveProofProgress({ state: 'finalized', verification: bad });
    ok(html.includes('NOT VERIFIED'), 'renders not-verified');
    notOk(html.includes('100%'), 'no percentage');
    notOk(html.includes('VERIFIED FINALITY'), 'no verified label');
  }
});

test('18. the live formatters render real enriched values and fall back to not available', () => {
  eq(formatLiveBlock({ blockHeight: '51105034' }), '#51105034', 'real block height');
  eq(formatLiveBlock({ blockHeight: null }), 'not available', 'no block without evidence');
  eq(formatLiveBlock({}), 'not available', 'no block on a bare row');
  eq(formatLiveAmount({ amount: '1', asset: 'CCD' }), '1 µCCD', 'real amount');
  eq(formatLiveAmount({ amount: null, asset: 'CCD' }), 'not available', 'no amount without evidence');
  eq(formatLiveAmount({ amount: 'abc', asset: 'CCD' }), 'not available', 'non-numeric amount rejected');
  eq(formatLiveFee({ sponsorFeeMicroCcd: '5108270' }), '5.108270 CCD', 'real sponsor fee');
  eq(formatLiveFee({ sponsorFeeMicroCcd: null }), 'not available', 'no fee without evidence');
  eq(shortAddr('abcdefghijklmnopqr'), 'abcdefgh…klmnopqr', 'long address truncated');
  eq(shortAddr('short'), 'short', 'short address kept whole');
  eq(shortAddr(null), 'not available', 'no address without evidence');
  eq(shortAddr(''), 'not available', 'empty address is not available');
});

test('19. the live table auto-refreshes on a timer, silently and only when visible', () => {
  ok(html.includes('setInterval(refreshLiveTxTable, 30000)'), '30-second refresh timer exists');
  const loader = extractFunctionSource('loadLiveTxTable');
  const refresher = extractFunctionSource('refreshLiveTxTable');
  ok(refresher.includes("document.querySelector('#page-transactions.active')"), 'refresh only while the Transactions page is visible');
  ok(refresher.includes('document.hidden'), 'refresh skips a hidden tab');
  ok(refresher.includes('loadLiveTxTable(true)'), 'refresh reuses the loader in refresh mode');
  ok(loader.includes('isRefresh'), 'loader distinguishes initial load from refresh');
  ok(loader.includes('if (isRefresh) return;'), 'a failed refresh keeps the last good render');
  ok(loader.includes('lastLiveTxSignature'), 'refresh tracks the last rendered payload');
  ok(loader.includes('signature === lastLiveTxSignature'), 'an unchanged payload is not re-rendered');
  const sig = extractFunctionSource('liveTxTableSignature');
  ok(sig.includes('p.state'), 'signature covers status changes');
  ok(sig.includes('p.updatedAt'), 'signature covers record updates');
  ok(sig.includes('p.blockHeight'), 'signature covers new block evidence');
  ok(sig.includes('p.paymentDigest'), 'signature covers new payments');
});

test('20. navigating to the Transactions page refreshes the live table', () => {
  const router = extractFunctionSource('handleRouteChange');
  ok(router.includes("if (baseRoute === 'transactions')"), 'router has a transactions hook');
  ok(router.includes('refreshLiveTxTable()'), 'router refreshes the live table');
  ok(router.indexOf('refreshLiveTxTable()') > router.indexOf("if (baseRoute === 'transactions')"), 'refresh is inside the transactions branch');
});

test('21. the initial route change does not duplicate the initial list fetch', () => {
  const router = extractFunctionSource('handleRouteChange');
  ok(html.includes('let initialRouteChangePending = true'), 'guard starts pending at load');
  ok(router.includes('initialRouteChangePending'), 'router checks the initial-route guard');
  ok(router.includes('initialRouteChangePending = false'), 'router clears the guard after the first route change');
  ok(router.includes('refreshLiveTxTable()'), 'later navigations still refresh');
  ok(router.indexOf('initialRouteChangePending = false') < router.indexOf('refreshLiveTxTable()'), 'guard is cleared before any refresh call site');
});

test('14. the historical archive never receives the live proof gate or a live badge', () => {
  ok(archiveBody.includes('HISTORICAL ARCHIVE'), 'archive keeps its label');
  notOk(archiveBody.includes('liveProofProgress'), 'archive does not call the live proof gate');
  notOk(archiveBody.includes('badge-live'), 'archive has no live badge');
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
console.log(`\npayment-list-view: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
