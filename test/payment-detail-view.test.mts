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
 *     account addresses, and no silent fallback to the first list entry,
 *   - the LIVE TESTNET VERIFICATION — FINALIZED badge appears only when
 *     the API reports available live evidence with observed `finalized`;
 *     a stored-finalized payment without a live confirmation shows
 *     FINALIZED — STORED STATE and an honest unavailable notice,
 *   - missing or malformed optional evidence fields render
 *     "not available", never an invented value,
 *   - the inspector performs exactly one fetch and never retries,
 *   - a stored-not-finalized payment whose chain observation is already
 *     finalized is NEVER shown as live-finalized (F1 regression): the
 *     stored state is the only finalized verdict the inspector shows.
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

test('12. live evidence available + finalized shows the live-verified status', () => {
  // Required behavior A: the API reports available live evidence whose
  // observed status is finalized — the inspector must say so explicitly.
  ok(body.includes('LIVE TESTNET VERIFICATION — FINALIZED'), 'live-verified finalized label present');
  ok(body.includes("v.available && v.finalized && v.observed === 'finalized'"), 'live-finalized gate requires available + finalized + observed finalized');
  ok(body.includes('const statusBadge = liveFinalized'), 'badge is keyed off the live observation, not the stored state alone');
  ok(body.includes('The Concordium Testnet node confirms this transaction finalized'), 'live-finalized notice states the node confirmed it');
  ok(body.includes("in block #' + escapeHtml(String(v.blockHeight))"), 'live-finalized notice names the finalized block when the API reports one');
  // The live-finalized branch itself must never carry the stale
  // "unavailable" message: slice just that branch of the notice ternary.
  const liveStart = body.indexOf("? 'LIVE TESTNET VERIFICATION — FINALIZED.");
  ok(liveStart >= 0, 'live-finalized notice branch found');
  const liveEnd = body.indexOf(': d.finalized', liveStart);
  ok(liveEnd > liveStart, 'live-finalized notice branch is bounded');
  const liveBranch = body.slice(liveStart, liveEnd);
  notOk(liveBranch.includes('Live verification is unavailable'), 'live-finalized branch carries no unavailable message');
  notOk(liveBranch.includes('not a fresh live confirmation'), 'live-finalized branch carries no stored-state-only disclaimer');
});

test('13. live evidence unavailable never claims a live confirmation (badge)', () => {
  // Required behavior B: with no live check, the badge must not say LIVE.
  ok(body.includes('FINALIZED — STORED STATE'), 'stored-finalized badge label present');
  const storedStart = body.indexOf('const storedBadge');
  ok(storedStart >= 0, 'stored badge definition found');
  const storedEnd = body.indexOf('\n', storedStart);
  const storedLine = body.slice(storedStart, storedEnd);
  notOk(storedLine.includes('LIVE'), 'stored badge contains no LIVE claim');
  notOk(storedLine.includes('badge-live'), 'stored badge uses the amber style, not the live style');
  ok(body.includes('? storedBadge'), 'stored-finalized payments fall through to the stored badge');
});

test('14. live evidence not found / unknown keeps OUTCOME_UNKNOWN messaging', () => {
  // Required behavior C: a payment the chain cannot confirm is never
  // labeled live-finalized; the stored state and the reconciliation
  // safeguard stay visible.
  ok(body.includes('NOT FINALIZED — '), 'non-finalized badge label present');
  ok(body.includes("escapeHtml(String(d.state || 'unknown')).toUpperCase()"), 'non-finalized badge renders the stored state (e.g. OUTCOME_UNKNOWN)');
  ok(body.includes('This payment is not shown as finalized until reconciliation confirms it.'), 'reconciliation safeguard present');
  // The non-finalized branch of the notice must not carry the live label.
  const nfStart = body.indexOf(": 'NOT finalized. Stored state:");
  ok(nfStart >= 0, 'non-finalized notice branch found');
  const nfEnd = body.indexOf('const amountLabel', nfStart);
  ok(nfEnd > nfStart, 'non-finalized notice branch is bounded');
  const nfBranch = body.slice(nfStart, nfEnd);
  notOk(nfBranch.includes('LIVE TESTNET VERIFICATION — FINALIZED'), 'non-finalized branch never claims live finalization');
  ok(nfBranch.includes('Live verification is unavailable'), 'unavailable live check is stated in the non-finalized branch');
  ok(nfBranch.includes('The chain currently reports this transaction as'), 'available-but-not-finalized observation is stated in the non-finalized branch');
});

test('15. stored state finalized but live evidence unavailable stays honest', () => {
  // Required behavior B, stored-finalized variant: the stored state is
  // shown, the live check is reported unavailable, and the badge is the
  // stored-state badge — never the live badge.
  ok(body.includes('stored finalized state is shown, not a fresh live confirmation'), 'stored-finalized + unavailable notice is honest');
  ok(body.includes('FINALIZED — STORED STATE'), 'stored-finalized + unavailable badge is the stored badge');
  ok(body.includes('const statusBadge = liveFinalized'), 'the live badge is reachable only through the live gate');
  const badgeStart = body.indexOf('const statusBadge = liveFinalized');
  ok(badgeStart >= 0, 'badge ternary found');
  const badgeEnd = body.indexOf('const statusNotice', badgeStart);
  ok(badgeEnd > badgeStart, 'badge ternary is bounded');
  const badge = body.slice(badgeStart, badgeEnd);
  ok(badge.indexOf('LIVE TESTNET VERIFICATION — FINALIZED') < badge.indexOf('FINALIZED — STORED STATE') || badge.includes('storedBadge'), 'live label and stored label are distinct badge branches');
});

test('16. missing or malformed optional evidence fields are labeled, never invented', () => {
  // Required behavior: every optional verification field has a
  // "not available" fallback; the fee formatter rejects null, empty,
  // and non-finite input instead of rendering a bogus number.
  ok(html.includes("if (micro === null || micro === undefined || micro === '') return 'not available'"), 'fee formatter rejects null/undefined/empty');
  ok(html.includes("if (!Number.isFinite(n)) return 'not available'"), 'fee formatter rejects non-finite input');
  ok(html.includes("if (!iso) return 'not available'"), 'block-time formatter rejects a missing timestamp');
  ok(html.includes("if (Number.isNaN(d.getTime())) return 'not available'"), 'block-time formatter rejects an invalid timestamp');
  ok(body.includes('formatMicroCcd(v.feeMicroCcd)'), 'fee renders through the formatter');
  ok(body.includes("v.blockHeight ? escapeHtml(String(v.blockHeight)) : 'not available'"), 'missing block height is labeled');
  ok(body.includes("v.blockHash ? escapeHtml(String(v.blockHash)) : 'not available'"), 'missing block hash is labeled');
  ok(body.includes("v.energy ? escapeHtml(String(v.energy)) + ' NRG' : 'not available'"), 'missing energy is labeled');
  ok(body.includes("v.sender ? escapeHtml(String(v.sender)) : 'not available'"), 'missing sender is labeled');
  ok(body.includes("v.sponsor ? escapeHtml(String(v.sponsor)) : 'not available'"), 'missing sponsor is labeled');
  ok(body.includes("v.recipient ? escapeHtml(String(v.recipient)) : 'not available'"), 'missing recipient is labeled');
  ok(body.includes('formatBlockTimeWib(v.blockSlotTime)'), 'block time renders through the WIB formatter');
});

test('17. fail-closed behavior and transition timeline remain intact', () => {
  // Required behavior: one detail fetch, no automatic retry or reload,
  // no state mutation; the timeline still renders the stored transitions
  // in order and never implies a live confirmation on its own.
  const fetchCount = (body.match(/fetch\(/g) || []).length;
  eq(fetchCount, 1, `inspector performs exactly one fetch (got ${fetchCount})`);
  notOk(body.includes('setInterval'), 'no polling retry');
  notOk(body.includes('setTimeout'), 'no delayed retry');
  notOk(body.includes('location.reload'), 'no page reload');
  notOk(body.includes('retry'), 'no retry wording in the inspector');
  ok(body.includes("renderTxDetailFallback(requested, 'Settlement Detail', 'Live detail unavailable"), 'unreachable-facilitator fallback present');
  ok(body.includes('Not in this facilitator'), 'unknown-hash fallback present');
  ok(body.includes('buildTransitionTimeline(d.transitions)'), 'timeline is still built from the API transitions');
  ok(body.includes('not a live chain confirmation'), 'timeline still states it is stored history, not a live confirmation');
});

test('18. stored outcome_unknown + chain finalized is NEVER shown as live-finalized (F1 regression)', () => {
  // The combination the F1 review found: the stored state is
  // `outcome_unknown` (d.finalized === false) while the live chain
  // observation is available + finalized. The inspector must report the
  // chain observation, keep the NOT FINALIZED badge, keep the
  // reconciliation safeguard, and never claim the stored state agrees.
  // 1. The live-finalized gate includes the stored state.
  ok(body.includes("d.finalized && v.available && v.finalized && v.observed === 'finalized'"), 'live-finalized gate requires stored-finalized AND live evidence');
  ok(body.includes('const liveFinalized = d.finalized'), 'gate starts with the stored-state check');
  // 2. The LIVE badge is reachable only through that gate, so it cannot
  // be selected when d.finalized is false.
  ok(body.includes('const statusBadge = liveFinalized'), 'badge is keyed off the live-finalized gate');
  const badgeStart = body.indexOf('const statusBadge = liveFinalized');
  ok(badgeStart >= 0, 'badge ternary found');
  const badgeEnd = body.indexOf('const statusNotice', badgeStart);
  ok(badgeEnd > badgeStart, 'badge ternary is bounded');
  const badge = body.slice(badgeStart, badgeEnd);
  ok(badge.includes('? storedBadge'), 'stored-finalized payments fall through to the stored badge');
  ok(badge.includes("NOT FINALIZED — ' + escapeHtml(String(d.state || 'unknown')).toUpperCase()"), 'non-finalized payments fall through to the stored-state badge');
  // 3–6. The non-finalized notice branch is the one that renders for
  // this combination: it reports the chain observation, keeps the
  // safeguard, and claims nothing about a finalized stored state.
  const nfStart = body.indexOf(": 'NOT finalized. Stored state:");
  ok(nfStart >= 0, 'non-finalized notice branch found');
  const nfEnd = body.indexOf('const amountLabel', nfStart);
  ok(nfEnd > nfStart, 'non-finalized notice branch is bounded');
  const nfBranch = body.slice(nfStart, nfEnd);
  ok(nfBranch.includes('The chain currently reports this transaction as'), 'chain finalized observation is reported, not hidden');
  ok(nfBranch.includes('This payment is not shown as finalized until reconciliation confirms it.'), 'reconciliation safeguard remains visible');
  notOk(nfBranch.includes('LIVE TESTNET VERIFICATION — FINALIZED'), 'no live-finalized label in the non-finalized branch');
  notOk(nfBranch.includes('Stored state <code>finalized</code> agrees'), 'no false stored-finalized agreement claim');
  notOk(nfBranch.includes('the verified evidence below is from the live chain observation'), 'live-finalized notice text is absent from the non-finalized branch');
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
