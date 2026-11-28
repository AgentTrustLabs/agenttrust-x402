/**
 * Payment list view contract (frontend): the transactions page must show
 * the facilitator's live settlement records from GET /api/payments above
 * the historical archive, and never present archive rows as live.
 *
 * Contract as of the Sol §6 redesign (e92172f) and the fetch-timeout work
 * (ca35dc6). The expectations below were re-based on that contract after
 * the suite drifted from it: the file was last green at 9e4340f (25/25)
 * and unchanged since, while the page moved on. The Sol §6 behaviour is
 * the verified spec — it is pinned by the green suites
 * agent-a-website-evidence (tests 11–15, 12b), agent-a-website-page-
 * consistency (test 23) and live-tx-kpi (tests 13, 17, 18), all green in
 * CI on the same head — not by this file alone:
 *   - the live section exists above the archive section, with its own
 *     mount; the archive section is headed "Earlier Settlements —
 *     11 November 2026" and labelled HISTORICAL ARCHIVE;
 *   - the list fetches `apiUrl('/api/payments')` from a single call site,
 *     with no retry-on-failure; the single fetch races a 10-second
 *     timeout (T1.2) that rejects with TimeoutError and never re-fetches.
 *     It re-fetches on a 30-second timer and on navigation to the
 *     Transactions page, but only while that page is visible, and a
 *     refresh never replaces the table with an error and never re-renders
 *     an unchanged payload; the initial route change skips its refresh
 *     because the initial load already fetched;
 *   - archive rows (buildTxTableHTML, podium) carry HISTORICAL ARCHIVE
 *     and no LIVE - TESTNET badge;
 *   - live row status (Sol §6 outcome mapping): stored finalized without
 *     evidence shows "Stored as finalized"; the same row with genuine
 *     evidence shows the green "Finalized" badge; outcome_unknown shows
 *     "Outcome unknown · not finalized"; any other state shows
 *     "Not finalized — <STATE>". The badge keys off the whole row —
 *     liveRowStateBadge(p) — because the Finalized badge needs the proof
 *     gate, not just the stored state;
 *   - the table is exactly six columns (Agent, Amount, Outcome, Finality
 *     evidence, Transaction, Action). Block, sponsored fee, sender,
 *     recipient and time are NOT table columns: the receipt inspector
 *     exposes them (agent-a-website-evidence 12b);
 *   - the proof cell reads "Finality evidence available" only when the
 *     proof gate passes (stored finalized plus genuine evidence) and
 *     "Finality evidence unavailable" otherwise; the table makes no
 *     percentage claim. The 100% itself lives at the gate
 *     (liveProofProgress), never in the rendered table;
 *   - live rows that also appear in the archive are dropped from the
 *     archive (deduplication), and the loading / empty / error states
 *     exist;
 *   - amount cells render the real value from the enriched list response;
 *     the formatters honestly read "not available" only when the
 *     evidence is absent.
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
  // The loader races the single fetch against a 10 s timeout (T1.2,
  // ca35dc6): that setTimeout rejects with TimeoutError and never
  // re-invokes the loader, so it is a timeout, not a retry. A blanket ban
  // on setTimeout predates the timeout race; what the contract forbids is
  // a retry timer, and the only timer in the list code is the race.
  eq((listBody.match(/setTimeout/g) ?? []).length, 1, 'the only timer in the list code is the fetch timeout');
  ok(listBody.includes('const txTimeout = new Promise'), 'the timer is the fetch-timeout race');
  ok(listBody.includes("timeoutErr.name = 'TimeoutError'"), 'the timer rejects as a timeout, never retries');
  notOk(listBody.includes('setInterval'), 'no timer inside the loader itself');
  ok(listBody.includes("fetch(apiUrl('/api/payments'))"), 'fetch uses the configured API base, one argument');
  ok(listBody.includes("Promise.race([fetch(apiUrl('/api/payments')), txTimeout])"), 'fetch races the 10 s timeout');
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

test('05. live row status distinguishes stored-finalized from evidence-backed finalized (Sol §6)', () => {
  // Sol §6 outcome mapping, pinned by live-tx-kpi 17/18 and
  // agent-a-website-evidence 11–15: stored finalized without evidence
  // shows 'Stored as finalized'; with genuine evidence the same row
  // shows the green 'Finalized' badge; outcome_unknown shows
  // 'Outcome unknown · not finalized'; any other state shows
  // 'Not finalized — <STATE>'. The badge keys off the whole row —
  // liveRowStateBadge(p) — because the Finalized badge needs the proof
  // gate, not just the stored state.
  ok(listBody.includes('Stored as finalized'), 'stored-only rows show the stored-finalized badge');
  ok(listBody.includes('>Finalized<'), 'evidenced rows show the Finalized badge');
  ok(listBody.includes('Outcome unknown · not finalized'), 'outcome_unknown rows show the unknown badge');
  ok(listBody.includes('Not finalized — '), 'other states show NOT FINALIZED');
  ok(listBody.includes('liveRowStateBadge(p)'), 'badge keys off the row (state + proof gate)');
  notOk(listBody.includes('LIVE TESTNET VERIFICATION'), 'no live-verification badge text in the list code');
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

test('08. live rows render the Sol six-column table; detail fields live in the receipt inspector', () => {
  // Sol §6 (pinned by agent-a-website-evidence 12/12b/13): the table
  // columns are exactly Agent, Amount, Outcome, Finality evidence,
  // Transaction, Action. Block, sponsored fee, sender, recipient and
  // time are NOT table columns — the receipt inspector exposes them.
  // The row still renders the real enriched amount and links to the
  // inspector and CCDScan.
  ok(listBody.includes('<th>Agent</th>'), 'agent column');
  ok(listBody.includes('<th>Amount</th>'), 'amount column');
  ok(listBody.includes('<th>Outcome</th>'), 'outcome column');
  ok(listBody.includes('<th>Finality evidence</th>'), 'finality evidence column');
  ok(listBody.includes('<th>Transaction</th>'), 'transaction column');
  ok(listBody.includes('<th>Action</th>'), 'action column');
  ok(listBody.includes('formatLiveAmount(p)'), 'amount cell renders the enriched amount');
  ok(listBody.includes('liveRowStateBadge(p)'), 'outcome cell renders the state badge');
  ok(listBody.includes('renderLiveProofProgress(p)'), 'evidence cell renders through the proof gate');
  notOk(listBody.includes('formatLiveBlock(p)'), 'no block column under Sol §6');
  notOk(listBody.includes('formatLiveFee(p)'), 'no sponsored-fee column under Sol §6');
  notOk(listBody.includes('shortAddr(p.sender)'), 'no sender column under Sol §6');
  notOk(listBody.includes('shortAddr(p.recipient)'), 'no recipient column under Sol §6');
  notOk(listBody.includes('formatLiveTxTime(p.updatedAt)'), 'no time column under Sol §6');
  ok(html.includes('function formatLiveBlock'), 'block formatter exists');
  ok(html.includes('function formatLiveAmount'), 'amount formatter exists');
  ok(html.includes('function formatLiveFee'), 'fee formatter exists');
  ok(html.includes('function shortAddr'), 'address shortener exists');
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
const liveRowStateBadge = new Function('escapeHtml', 'liveProofProgress', `return ${extractFunctionSource('liveRowStateBadge')}`)(escapeHtmlForProbe, liveProofProgress) as unknown as (p: unknown) => string;
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
const formatBlockTimeWib = new Function(`return ${extractFunctionSource('formatBlockTimeWib')}`)() as unknown as (iso: string) => string;
const formatLiveTxTime = new Function('formatBlockTimeWib', `return ${extractFunctionSource('formatLiveTxTime')}`)(formatBlockTimeWib) as unknown as (updatedAt: unknown) => string;

test('09. stored finalized without live evidence never renders 100%', () => {
  notOk(listBody.includes('width:100%'), 'no hardcoded 100% in the live list code');
  const proof = liveProofProgress({ state: 'finalized', transactionHash: 'a'.repeat(64) });
  eq(proof.percent, null, 'no percent from stored state');
  ok(String(proof.label).includes('NOT VERIFIED'), 'label says not verified');
});

test('10. stored finalized keeps the Stored as finalized label (Sol §6)', () => {
  // Sol §6: the badge keys off the whole row, so the probe passes rows,
  // not bare state strings. Stored finalized without evidence keeps the
  // stored-only label; the same row with genuine evidence shows
  // 'Finalized'; outcome_unknown never shows either finalized label.
  const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  ok(liveRowStateBadge({ state: 'finalized' }).includes('Stored as finalized'), 'stored-only label kept');
  ok(liveRowStateBadge({ state: 'finalized', finalized: true, verification: evidence }).includes('>Finalized<'), 'evidenced row shows Finalized');
  ok(liveRowStateBadge({ state: 'outcome_unknown' }).includes('Outcome unknown · not finalized'), 'non-finalized keeps the unknown label');
  notOk(liveRowStateBadge({ state: 'outcome_unknown' }).includes('Stored as finalized'), 'no stored-finalized label on non-finalized');
  notOk(liveRowStateBadge({ state: 'outcome_unknown' }).includes('>Finalized<'), 'no Finalized badge on non-finalized');
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

test('15. valid evidence renders the Finality evidence available label, with no percentage claim in the table', () => {
  // Sol §6: the table makes no percentage claim (agent-a-website-evidence
  // 12: 'no percentage claim in the table'). The 100% itself is pinned at
  // the gate by test 12 (liveProofProgress percent 100); the table cell
  // renders the evidence-available label.
  const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  const html = renderLiveProofProgress({ state: 'finalized', verification: evidence });
  ok(html.includes('Finality evidence available'), 'renders the evidence-available label');
  notOk(html.includes('Finality evidence unavailable'), 'no unavailable label on valid evidence');
  notOk(html.includes('NOT VERIFIED'), 'no not-verified label on valid evidence');
  notOk(html.includes('100%'), 'no percentage claim in the table');
  notOk(html.includes('VERIFIED FINALITY'), 'no verified-finality label in the table cell');
});

test('16. stored state without evidence renders Finality evidence unavailable and no verified claim', () => {
  for (const row of [{ state: 'finalized' }, { state: 'outcome_unknown' }, {}]) {
    const html = renderLiveProofProgress(row);
    ok(html.includes('Finality evidence unavailable'), 'renders the unavailable label');
    ok(html.includes('evidence unavailable'), 'states that evidence is unavailable');
    notOk(html.includes('Finality evidence available'), 'no available claim without evidence');
    notOk(html.includes('100%'), 'no percentage without evidence');
    notOk(html.includes('VERIFIED FINALITY'), 'no verified label without evidence');
    notOk(html.includes('width:'), 'no progress bar without evidence');
  }
});

test('17. partial or forged evidence renders fail-closed, never an available claim', () => {
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
    ok(html.includes('Finality evidence unavailable'), 'renders the unavailable label');
    notOk(html.includes('Finality evidence available'), 'no available claim');
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
  ok(sig.includes('p.verification'), 'signature covers finality evidence changes');
  ok(sig.includes('p.finalized'), 'signature covers stored finalized changes');
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

test('22. a null or missing payment never throws the proof gate (Sol v3 regression)', () => {
  for (const row of [null, undefined]) {
    const proof = liveProofProgress(row);
    eq(proof.percent, null, 'no percent from a missing row');
    ok(String(proof.label).includes('NOT VERIFIED'), 'label says not verified');
    const html = renderLiveProofProgress(row);
    ok(html.includes('Finality evidence unavailable'), 'renders the unavailable label');
    notOk(html.includes('Finality evidence available'), 'no available claim from a missing row');
    notOk(html.includes('100%'), 'no percentage from a missing row');
  }
});

test('23. genuine evidence without a stored finalized state never renders an available claim (Sol v3 regression)', () => {
  const evidence = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  // Evidence alone must not imply finality: the stored state has to agree,
  // matching the detail inspector's stored-finalized-plus-live-evidence rule.
  for (const row of [
    { state: 'outcome_unknown', finalized: false, verification: evidence },
    { state: 'pending', verification: evidence },
    { state: 'finalized', finalized: false, verification: evidence },
  ]) {
    eq(liveProofProgress(row).percent, null, 'no percent without stored finalized state');
    const html = renderLiveProofProgress(row);
    ok(html.includes('Finality evidence unavailable'), 'renders the unavailable label');
    notOk(html.includes('Finality evidence available'), 'no available claim');
    notOk(html.includes('100%'), 'no percentage');
  }
  // Control: stored finalized plus the same evidence still passes the gate
  // and renders the available claim (no percentage claim in the table).
  eq(liveProofProgress({ state: 'finalized', finalized: true, verification: evidence }).percent, 100, 'stored finalized plus evidence renders 100%');
  const html = renderLiveProofProgress({ state: 'finalized', finalized: true, verification: evidence });
  ok(html.includes('Finality evidence available'), 'stored finalized plus evidence renders the available label');
  notOk(html.includes('100%'), 'no percentage claim in the table');
});

test('24. a whitespace-only evidence source is rejected (audit B1 regression)', () => {
  const base = { available: true, observed: 'finalized', finalized: true, source: 'concordium-grpc', blockHash: 'a'.repeat(64) };
  // Blank sources ('   ', tab/newline mix, empty — empty already covered by
  // tests 13/17, repeated here so the B1 case list is self-contained) must
  // fail closed at the gate and at the renderer, exactly like forged evidence.
  for (const source of ['   ', ' \t\n ', '']) {
    const proof = liveProofProgress({ state: 'finalized', verification: { ...base, source } });
    eq(proof.percent, null, 'blank source never passes the gate');
    const html = renderLiveProofProgress({ state: 'finalized', verification: { ...base, source } });
    ok(html.includes('Finality evidence unavailable'), 'blank source renders the unavailable label');
    notOk(html.includes('Finality evidence available'), 'blank source renders no available claim');
    notOk(html.includes('100%'), 'blank source renders no percentage');
    notOk(html.includes('VERIFIED FINALITY'), 'blank source renders no verified label');
  }
  // Control: the same evidence with a real source still passes the gate
  // and renders the available claim (no percentage claim in the table).
  eq(liveProofProgress({ state: 'finalized', verification: base }).percent, 100, 'valid source still passes the gate');
  const html = renderLiveProofProgress({ state: 'finalized', verification: base });
  ok(html.includes('Finality evidence available'), 'valid source renders the available label');
  notOk(html.includes('100%'), 'no percentage claim in the table');
});

test('25. a finite out-of-range timestamp formats as not available (INT-02 regression)', () => {
  // The production formatter, extracted from the page: new Date(1e20) is
  // Invalid and toISOString() throws, so the formatter must validate the
  // constructed date instead of letting the exception break the table.
  eq(formatLiveTxTime(1e20), 'not available', 'out-of-range finite timestamp is not available');
  eq(formatLiveTxTime(-1e20), 'not available', 'negative out-of-range timestamp is not available');
  eq(formatLiveTxTime(NaN), 'not available', 'NaN is not available');
  eq(formatLiveTxTime('garbage'), 'not available', 'non-numeric timestamp is not available');
  ok(formatLiveTxTime(1000).includes('WIB'), 'a valid timestamp still renders a WIB time');
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
