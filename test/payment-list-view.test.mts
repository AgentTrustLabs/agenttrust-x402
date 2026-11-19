/**
 * Payment list view contract (frontend): the transactions page must show
 * the facilitator's live settlement records from GET /api/payments above
 * the historical archive, and never present archive rows as live.
 *
 * Asserts, on the page markup and the list code:
 *   - the live section exists above the archive section, with its own
 *     mount; the archive section is headed "Earlier Settlements —
 *     11 November 2026" and labelled HISTORICAL ARCHIVE;
 *   - the list fetches `apiUrl('/api/payments')` exactly once, with no
 *     retry, and no live payment hash is hardcoded anywhere in the list
 *     code;
 *   - archive rows (buildTxTableHTML, podium) carry HISTORICAL ARCHIVE
 *     and no LIVE - TESTNET badge;
 *   - live row status follows the stored state only: finalized shows
 *     FINALIZED — STORED STATE, any other state shows NOT FINALIZED;
 *     the list code contains no live-verification badge;
 *   - live rows that also appear in the archive are dropped from the
 *     archive (deduplication), and the loading / empty / error states
 *     exist;
 *   - block, amount and fee cells for live rows honestly read
 *     "not available" (the list response carries none of them).
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

test('02. the list fetches GET /api/payments exactly once, with no retry', () => {
  const fetches = (listBody.match(/fetch\(apiUrl\('\/api\/payments'\)\)/g) ?? []).length;
  eq(fetches, 1, 'one list fetch');
  notOk(listBody.includes('setTimeout'), 'no retry timer in the list code');
  notOk(listBody.includes('setInterval'), 'no polling in the list code');
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
  notOk(listBody.includes('v.available'), 'list never reads live verification evidence');
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

test('08. live rows honestly show not available for block, amount and fee', () => {
  const cells = (listBody.match(/not available/g) ?? []).length;
  ok(cells >= 3, `at least three "not available" cells, got ${cells}`);
  ok(listBody.includes('formatLiveTxTime(p.updatedAt)'), 'row time comes from the stored updated_at');
  ok(listBody.includes('#/transactions/'), 'rows link to the detail inspector');
  ok(listBody.includes('ccdscanTxUrl(p.transactionHash)'), 'rows link to CCDScan when a tx hash exists');
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
