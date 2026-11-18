/**
 * Payment detail view contract (frontend): the transactions inspector in
 * `web/prototype-v5-6.html` must render settlement evidence from the live
 * API, never from hardcoded data.
 *
 * Asserts, on the inspector's function body:
 *   - it fetches `apiUrl('/api/payments/' + …)`,
 *   - it has distinct FINALIZED and NOT FINALIZED branches,
 *   - it uses the API's `explorerUrl` field,
 *   - it contains NONE of the old hardcoded fee strings or hardcoded
 *     account addresses, and no silent fallback to the first list entry.
 *
 * Static analysis only — no browser, no server. The list data
 * (`realTransactionsData`) is navigation data and is NOT covered by the
 * no-hardcoded-data assertions; only the inspector body is.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');

const start = html.indexOf('async function renderTxDetailInspector');
ok(start >= 0, 'inspector function exists');
const end = html.indexOf('renderTxDetailInspector(realTransactionsData[0].hash)', start);
ok(end > start, 'inspector call site found after the function');
const body = html.slice(start, end);

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. inspector fetches the live detail endpoint', () => {
  ok(body.includes("apiUrl('/api/payments/' +"), 'fetches apiUrl(/api/payments/ + …)');
  ok(body.includes('encodeURIComponent(requested)'), 'identifier is encoded');
});

test('02. inspector has distinct finalized and non-finalized branches', () => {
  ok(body.includes('FINALIZED'), 'FINALIZED branch present');
  ok(body.includes('NOT FINALIZED'), 'NOT FINALIZED branch present');
  ok(body.includes('NOT finalized'), 'non-finalized notice text present');
  ok(body.includes("d.finalized"), 'badge keys off the stored-state finalized flag');
});

test('03. inspector uses the API explorerUrl and the live verification fields', () => {
  ok(body.includes('explorerUrl'), 'uses the API explorerUrl field');
  ok(body.includes('feeMicroCcd'), 'fee comes from the API');
  ok(body.includes('blockHeight'), 'block height comes from the API');
  ok(body.includes('blockSlotTime'), 'block time comes from the API');
  ok(body.includes('verification'), 'reads the verification section');
  ok(body.includes('finalizeTransition'), 'reads the finalize-transition evidence pointer');
});

test('04. inspector body contains no hardcoded fee strings', () => {
  for (const fee of ['4.620843', '4.596853', '4.588449', '4.533534']) {
    notOk(body.includes(fee), `no hardcoded fee ${fee}`);
  }
});

test('05. inspector body contains no hardcoded account addresses', () => {
  for (const addr of [
    '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK',
    '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
  ]) {
    notOk(body.includes(addr), `no hardcoded address ${addr.slice(0, 8)}…`);
  }
});

test('06. no silent fallback to the first list entry', () => {
  notOk(body.includes('|| realTransactionsData[0]'), 'no first-entry fallback');
  notOk(body.includes('635 NRG (cap 1000 NRG)'), 'no hardcoded energy claim');
});

test('07. unknown-hash and unreachable-facilitator states render honestly', () => {
  ok(body.includes('Not in this facilitator'), 'unknown-hash message present');
  ok(body.includes('Live detail unavailable'), 'unavailable message present');
  ok(body.includes('ccdscanTxUrl(requested)'), 'fallback links point at CCDScan for the requested hash');
});

test('08. finalized branch claims a live confirmation only when the chain confirmed it live', () => {
  // A finalized payment whose live verification is unavailable (mock mode,
  // node down, hash unknown to the node) must NOT be shown as "confirmed
  // live on-chain": the stored state stands, but no fresh live check ran.
  ok(body.includes('v.available && v.finalized'), 'live-confirmation claim gated on available + finalized observation');
  ok(body.includes('stored finalized state is shown'), 'unavailable live check is stated honestly in the finalized branch');
  ok(body.includes('The chain currently reports this transaction as'), 'live-but-not-finalized observation is stated, not hidden');
});

test('09. settlement transition timeline renders the API transitions in order', () => {
  ok(body.includes('buildTransitionTimeline(d.transitions)'), 'timeline is built from the API transitions');
  ok(body.includes('Settlement Transition Timeline'), 'timeline field label present');
  ok(body.includes('tx-timeline'), 'timeline list markup present');
  ok(body.includes("Array.isArray(transitions)"), 'transition array is validated before rendering');
  ok(body.includes("escapeHtml(t.to)"), 'transition state is escaped');
  ok(body.includes("escapeHtml(t.reason)"), 'transition reason is escaped');
  ok(body.includes("escapeHtml(t.evidence.source)"), 'transition evidence source is escaped');
  ok(body.includes("escapeHtml(t.evidence.digest)"), 'transition evidence digest is escaped');
});

test('10. missing, empty, and malformed transition data are labeled, never invented', () => {
  ok(body.includes('Transition history was not included in this response.'), 'missing transitions array is labeled');
  ok(body.includes('No transitions recorded for this payment.'), 'empty transitions array is labeled');
  ok(body.includes('No readable transition history was returned.'), 'all-unreadable transitions are labeled');
  ok(body.includes('unreadable transition entry'), 'a malformed entry keeps its position and is labeled');
  ok(body.includes('reason not recorded'), 'missing reason is labeled');
  ok(body.includes('time not recorded'), 'missing timestamp is labeled');
  ok(body.includes('Evidence reference incomplete.'), 'incomplete evidence reference is labeled');
  ok(body.includes('formatBlockTimeWib'), 'timestamps use the existing WIB formatter');
});

test('11. the timeline never independently implies live on-chain confirmation', () => {
  ok(body.includes('not a live chain confirmation'), 'timeline states it is stored history, not a live confirmation');
  const tlStart = body.indexOf('function buildTransitionTimeline');
  ok(tlStart >= 0, 'timeline builder exists');
  const tlEnd = body.indexOf('</ol>', tlStart);
  ok(tlEnd > tlStart, 'timeline markup is bounded');
  const tl = body.slice(tlStart, tlEnd);
  notOk(tl.includes('confirmed live on-chain'), 'timeline builder contains no live-confirmation claim');
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
console.log(`\npayment-detail-view: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
