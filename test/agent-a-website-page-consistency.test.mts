/**
 * Agent A website page consistency — recovery, wallet session,
 * transactions and dashboard (Workstream E, Testnet Activation Unblock
 * & Provisioning Preflight sprint, 2026-11-23).
 *
 * What the website shows for recovery, the owner wallet session, the
 * transactions table and the dashboard, verified against the page
 * itself: the page functions are extracted VERBATIM from
 * `web/prototype-v5-6.html` and executed in a sandbox with only the
 * helpers they need (same pattern as payment-list-view,
 * agent-website-integration, and agent-a-website-evidence), so the
 * tests assert what the page actually renders. The wallet-session
 * checks use the real `web/wallet-connect.mjs`.
 *
 * Fixture data only — no chain, no broadcast, no funding, no signing
 * with owner credentials. The fixture account address `3whdieGH…` is the
 * long-standing test identifier; it is NEVER presented as a real Agent A
 * address (it happens to exist on Testnet by coincidence, nonce 7 —
 * see the previous sprint's C §3.2). No Agent A account exists on
 * Testnet, no wallet is payment-ready, no policy is activated here.
 *
 * Scope note — this file keeps the page-only checks from the original
 * launcher-consistency suite (recovery wording, readiness reasons,
 * owner/agent separation, session authentication, transactions and
 * dashboard). The provisioning-store and persistent-permission-backend
 * checks are not included: they exercise provisioning and SQLite
 * modules that are not part of the committed tree.
 *
 * Covers:
 *   - Recovery: race-based best effort, never "guaranteed"; exact
 *     not-ready reasons in plain language, all 10 conditions in
 *     backend order; owner/agent separation.
 *   - Wallet: session authentication + ownership checks preserved
 *     (401 → reconnect state); no signing secret exposed; the owner
 *     challenge-signing label is accurate.
 *   - Transactions/Dashboard: automatic history from durable records;
 *     pending / finalized / outcome_unknown distinguished; historical
 *     payments are never counted as Agent A payments; missing
 *     attribution is labelled honestly.
 *
 * Run: node node_modules/tsx/dist/cli.mjs test/agent-a-website-page-consistency.test.mts
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';
import { AccountAddress, getAccountAddress } from '@concordium/web-sdk';
import { createWalletConnection, WalletErrors } from '../web/wallet-connect.mjs';

// Concordium Testnet CAIP-2, as in agent-a-website-evidence and agent-wallet-permissions.
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '4MyVHYbRkAU6fqQsoSDzni6mrVz1KEvhDJoMVmDmrCgPBD8b7S';
const AGENT_KEY = '11'.repeat(32);
const CRED_ID = 'aa'.repeat(48);
// Fixture account address (test identifier only — see the header note).
const ADDR_A = AccountAddress.toBase58(getAccountAddress(CRED_ID));
const DIGEST_A = 'a1'.repeat(32);
const DIGEST_B = 'b2'.repeat(32);
const BLOCK_HASH = 'a3'.repeat(32);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');
const walletConnectSrc = readFileSync(join(root, 'web', 'wallet-connect.mjs'), 'utf8');

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── HTML function extraction (verbatim, sandbox) ──────────────────────────

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

function extractConstObject(name: string): unknown {
  const start = html.indexOf(`const ${name} = {`);
  ok(start >= 0, `const ${name} exists`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let j = brace; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') {
      depth--;
      if (depth === 0) return new Function(`return ${html.slice(brace, j + 1)}`)();
    }
  }
  throw new Error(`unbalanced const ${name}`);
}

const escapeHtml = new Function(`return ${extractFunctionSource('escapeHtml')}`)() as unknown as (s: unknown) => string;
const READINESS_MISSING_PLAIN = extractConstObject('READINESS_MISSING_PLAIN') as Record<string, string>;
const TESTNET_NETWORK_LABELS = extractConstObject('TESTNET_NETWORK_LABELS') as Record<string, string>;

const detailStub = new Map<string, { status: number; body: unknown } | Error>();
const detailFetchCalls = new Map<string, number>();
async function stubApiJsonTimeout(path: string): Promise<{ status: number; body: unknown }> {
  const id = decodeURIComponent(String(path).split('/').pop() || '');
  detailFetchCalls.set(id, (detailFetchCalls.get(id) || 0) + 1);
  const entry = detailStub.get(id);
  if (entry instanceof Error) throw entry;
  if (!entry) throw new Error('api_unreachable');
  return entry;
}

// One sandbox for the page functions, so the enrichment cache
// (liveTxDetailCache) persists across calls exactly as it does on the page.
const sandboxSource = [
  'const liveTxDetailCache = new Map();',
  'async ' + extractFunctionSource('enrichLiveTxRows'),
  extractFunctionSource('shortAddr'),
  extractFunctionSource('formatLiveAmount'),
  extractFunctionSource('formatLiveFee'),
  extractFunctionSource('formatLiveBlock'),
  extractFunctionSource('formatLiveNetwork'),
  extractFunctionSource('formatLiveEnergy'),
  extractFunctionSource('liveRowStateBadge'),
  extractFunctionSource('liveProofProgress'),
  extractFunctionSource('renderLiveProofProgress'),
  extractFunctionSource('formatBlockTimeWib'),
  extractFunctionSource('formatLiveTxTime'),
  extractFunctionSource('buildLiveTxTableHTML'),
  extractFunctionSource('liveTxTableSignature'),
  extractFunctionSource('readinessStateLabel'),
  extractFunctionSource('readinessDetailHtml'),
  extractFunctionSource('confirmedAccountAddress'),
  extractFunctionSource('provisioningHtml'),
  extractFunctionSource('recoveryGuaranteeHtml'),
  extractFunctionSource('walletReadinessHtml'),
].join('\n');
const page = new Function(
  'escapeHtml', 'formatMicroCcd', 'ccdscanTxUrl', 'TESTNET_NETWORK_LABELS', 'apiJsonTimeout', 'READINESS_MISSING_PLAIN',
  `${sandboxSource}\nreturn { enrichLiveTxRows, shortAddr, formatLiveAmount, formatLiveFee, formatLiveBlock, formatLiveNetwork, formatLiveEnergy, liveRowStateBadge, liveProofProgress, renderLiveProofProgress, formatBlockTimeWib, formatLiveTxTime, buildLiveTxTableHTML, liveTxTableSignature, readinessStateLabel, readinessDetailHtml, confirmedAccountAddress, provisioningHtml, recoveryGuaranteeHtml, walletReadinessHtml };`,
)(
  escapeHtml,
  new Function(`return ${extractFunctionSource('formatMicroCcd')}`)(),
  new Function(`return ${extractFunctionSource('ccdscanTxUrl')}`)(),
  TESTNET_NETWORK_LABELS,
  stubApiJsonTimeout,
  READINESS_MISSING_PLAIN,
) as Record<string, (...args: never[]) => unknown>;

/** The API-shaped wallet object the page consumes (as `serialiseWallet` returns it). */
function pageWallet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    walletId: 'w_' + 'a1'.repeat(12),
    agentId: '1004',
    ownerWalletAddress: OWNER,
    network: CAIP2,
    accountAddress: null,
    signingPublicKeyHex: AGENT_KEY,
    status: 'active',
    fundingStatus: 'unfunded',
    deploymentStatus: 'not_deployed',
    recoveryCredentialStatus: 'not_installed',
    credentialIndex: null,
    threshold: 1,
    paymentReady: false,
    paymentReadinessMissing: ['account', 'agent_credential', 'recovery_credential', 'signing_key', 'signing_binding', 'funded', 'sponsor', 'policy', 'suspension', 'network'],
    paymentReadiness: {
      accountAddress: null, agentCredential: 'not_deployed', recoveryCredential: 'not_installed',
      signingKey: 'absent', signingBinding: 'absent', funded: false, sponsor: 'unavailable',
      policy: 'denied', suspension: 'unknown', network: 'unknown',
      recoveryGuarantee: 'none',
    },
    provisioning: { state: 'not_started', accountAddress: null, detail: 'no provisioning attempt recorded and no account on the wallet record' },
    ...over,
  };
}

/** A bare stored list row (the facilitator list carries no sender/block/fee/verification). */
function bareListRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentDigest: DIGEST_A,
    transactionHash: DIGEST_A,
    state: 'finalized',
    amount: '1',
    payTo: PAY_TO,
    network: CAIP2,
    sponsor: SPONSOR,
    updatedAt: 1795000000000,
    ...over,
  };
}

/** The facilitator detail record for a payment (flat shape, as GET /api/payments/:id returns it). */
function detailA(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    paymentDigest: DIGEST_A,
    transactionHash: DIGEST_A,
    state: 'finalized',
    finalized: true,
    amount: '1',
    payTo: PAY_TO,
    network: CAIP2,
    sponsor: SPONSOR,
    blockHeight: '50970567',
    blockHash: BLOCK_HASH,
    sender: ADDR_A,
    recipient: PAY_TO,
    verification: {
      available: true, observed: 'finalized', source: 'concordium-grpc', finalized: true,
      blockHash: BLOCK_HASH, blockHeight: '50970567', blockSlotTime: '2026-11-18T11:01:24.585Z',
      sender: ADDR_A, sponsor: SPONSOR, feeMicroCcd: '4800331', energy: '635',
      recipient: PAY_TO, transferAmount: '1', error: null,
    },
    updatedAt: 1795000000000,
    ...over,
  };
}

// ═══ B. My Agents — recovery, readiness reasons, owner/agent separation ═

test('10. recovery is shown as race-based best effort when verified, and as none when not — never guaranteed', () => {
  // Primary path: the backend's paymentReadiness carries the guarantee.
  const verified = pageWallet({
    recoveryCredentialStatus: 'verified',
    threshold: 1,
    paymentReadiness: { recoveryGuarantee: 'race_based_best_effort' },
  });
  const g1 = page.recoveryGuaranteeHtml(verified) as string;
  ok(g1.includes('best effort (race)'), 'race wording shown when verified');
  ok(g1.includes('not a guarantee'), 'explicitly not a guarantee');
  notOk(g1.toLowerCase().includes('guaranteed'), 'never "guaranteed" when verified');
  // Fallback derivation: verified recovery + threshold 1 without the backend field still renders best effort.
  const derived = page.recoveryGuaranteeHtml(pageWallet({
    recoveryCredentialStatus: 'verified',
    threshold: 1,
    paymentReadiness: { recoveryGuarantee: undefined },
  })) as string;
  ok(derived.includes('best effort (race)'), 'derived best effort without the backend field');
  const none = page.recoveryGuaranteeHtml(pageWallet({ recoveryCredentialStatus: 'not_installed', threshold: 1 })) as string;
  ok(none.includes('RECOVERY GUARANTEE:</span> none'), 'no recovery credential → none');
  notOk(none.toLowerCase().includes('guaranteed'), 'never "guaranteed" when absent');
  notOk(/guaranteed/i.test(html), 'the word guaranteed never appears on the page at all');
  const recStart = html.indexOf('function recoveryGuaranteeHtml');
  const recEnd = html.indexOf('function walletReadinessHtml', recStart);
  notOk(html.slice(recStart, recEnd).toLowerCase().includes('guaranteed'), 'recovery renderer never says guaranteed');
});

test('11. a not-ready wallet lists the exact missing reasons in plain language, in backend order', () => {
  const out = page.walletReadinessHtml(pageWallet()) as string;
  ok(out.includes('<span class="badge-inconclusive">NOT PAYMENT READY</span>'), 'not ready badge');
  const labels = ['Account', 'Agent credential', 'Recovery credential', 'Signing key', 'Signing binding', 'Funded', 'Sponsor', 'Policy', 'Suspension', 'Network'];
  let prev = -1;
  for (const label of labels) {
    const at = out.indexOf(label + ':');
    ok(at > prev, label + ' present in backend order');
    prev = at;
  }
  for (const m of ['account', 'agent_credential', 'recovery_credential', 'signing_key', 'signing_binding', 'funded', 'sponsor', 'policy', 'suspension', 'network']) {
    ok(out.includes('<code>' + m + '</code>'), 'missing code listed: ' + m);
    const plain = READINESS_MISSING_PLAIN[m];
    ok(typeof plain === 'string' && plain.length > 0 && out.includes(plain), 'plain reason for ' + m + ': ' + plain);
  }
  ok(out.includes('✗ Account: no account'), 'account condition reads not met');
});

test('12. owner wallet is separated from agent wallets and never shown as signing agent payments', () => {
  ok(html.includes('owner identity wallet'), 'owner identity wallet is named as such');
  ok(html.split('never by this wallet').length - 1 >= 2, 'owner wallet does not sign agent payments — stated in the static note and the session note');
  ok(html.includes('Session Challenge Signing'), 'signing field names the session challenge, not x402');
  notOk(html.includes('x402 Signing Engine'), 'no x402 Signing Engine label remains');
  ok(html.includes('id="agent-wallets-mount"'), 'agent wallets have their own mount');
  const walletPageStart = html.indexOf('PAGE 5: #/wallet');
  const walletPageEnd = html.indexOf('PAGE 6', walletPageStart);
  const walletPage = html.slice(walletPageStart, walletPageEnd > walletPageStart ? walletPageEnd : walletPageStart + 4000);
  ok(walletPage.includes('Concordium Account Session'), 'owner session card present');
  ok(walletPage.includes('Agent Wallets'), 'agent wallets section present');
  const ui = extractFunctionSource('updateWalletMainUI');
  ok(ui.includes("fSigning.textContent = state === 'session-active' ? 'Enabled (session active)' : 'Disabled (no session)'"), 'signing field only ever reflects the session state');
});

// ═══ C. Wallet — session authentication, ownership, secrets, labels ═══════

test('13. authenticatedJson throws session_unavailable with no request when no live session exists', async () => {
  let calls = 0;
  const conn = createWalletConnection({
    fetchFn: async () => {
      calls++;
      return new Response('{}', { status: 200 });
    },
  });
  let err: unknown = null;
  try {
    await conn.authenticatedJson('/api/wallets');
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error && err.message === WalletErrors.SESSION_UNAVAILABLE, 'session_unavailable');
  eq(err instanceof Error ? err.message : '', 'session_unavailable', 'exact error value');
  eq(calls, 0, 'no request was made without a session');
  conn.dispose();
});

test('14. a 401 from the wallet API maps to the reconnect message and shows no agent wallet data', () => {
  const errText = new Function(`return ${extractFunctionSource('errText')}`)() as (err: unknown) => string;
  const msg = errText(new Error('wallets_http_401: session_revoked'));
  ok(msg.includes('reconnect your Concordium Wallet'), 'reconnect message');
  ok(msg.includes('No agent wallet data shown'), 'no data shown on 401');
  const fetchSrc = extractFunctionSource('fetchOwnerWallets');
  ok(fetchSrc.includes("throw new Error('wallets_http_' + status"), 'fetchOwnerWallets throws wallets_http_<status> on non-200');
  ok(fetchSrc.includes("if (!owner) throw new Error('wallet_not_connected')"), 'no owner identity → wallet_not_connected, no request');
});

test('15. no signing secret is exposed by the wallet UI or the authenticated fetch', () => {
  notOk(/AGENT_SIGNING_SECRET|privateKey|private_key/.test(html), 'page carries no signing secret identifier');
  notOk(/AGENT_SIGNING_SECRET|privateKey/.test(walletConnectSrc), 'wallet-connect module carries no signing secret identifier');
  notOk(/console\.log/.test(walletConnectSrc), 'the session token is never logged');
  ok(walletConnectSrc.includes('authorization: `Bearer ${credential.token}`'), 'the token is sent only as an Authorization header');
});

test('16. the owner challenge-signing label is accurate', () => {
  ok(html.includes('Session Challenge Signing'), 'Session Challenge Signing label');
  ok(html.includes("Agent payments are signed by each agent's own key, never by this wallet."), 'signing note');
  notOk(html.includes('x402 Signing Engine'), 'old label gone');
});

// ═══ D. Transactions / Dashboard — durable history, honest attribution ════

test('22. the Transactions table renders exactly the durable rows; historical rows are never Agent A payments', async () => {
  detailStub.clear(); detailFetchCalls.clear();
  const dB = detailA();
  dB.paymentDigest = DIGEST_B;
  dB.transactionHash = DIGEST_B;
  detailStub.set(DIGEST_A, { status: 200, body: detailA() });
  detailStub.set(DIGEST_B, { status: 200, body: dB });
  const rows = [bareListRow(), bareListRow({ paymentDigest: DIGEST_B, transactionHash: DIGEST_B, agentId: '1004', walletId: 'wallet-a-1004' })];
  await page.enrichLiveTxRows(rows);
  const out = page.buildLiveTxTableHTML(rows) as string;
  // The unattributed historical row is labelled honestly.
  ok(out.includes('not recorded'), 'unattributed row says not recorded');
  // The attributed row names its agent and wallet.
  ok(out.includes('Agent #1004'), 'attributed row names Agent #1004');
  ok(out.includes('title="Agent wallet: wallet-a-1004"'), 'agent wallet id in the title');
  // Exactly the two durable rows render — both short hashes appear, once each.
  eq((out.match(/a1a1a1a1…a1a1a1a1/g) || []).length, 1, 'first row rendered once');
  eq((out.match(/b2b2b2b2…b2b2b2b2/g) || []).length, 1, 'second row rendered once');
  // No simulated payment: the table never invents a row beyond the list.
  eq(page.liveTxTableSignature(rows), page.liveTxTableSignature(rows), 'signature is deterministic for the same list');
});

test('23. pending, finalized, and outcome_unknown are distinguished and never conflated', async () => {
  detailStub.clear(); detailFetchCalls.clear();
  detailStub.set(DIGEST_A, { status: 200, body: detailA() });
  const finalized = bareListRow();
  await page.enrichLiveTxRows([finalized]);
  const outF = page.buildLiveTxTableHTML([finalized]) as string;
  ok(outF.includes('>Finalized<'), 'finalized badge');
  ok(outF.includes('Finality evidence available'), 'finality evidence available');
  // outcome_unknown is never finalized, even with genuine chain evidence.
  const outU = page.buildLiveTxTableHTML([bareListRow({ state: 'outcome_unknown', transactionHash: null })]) as string;
  ok(outU.includes('Outcome unknown · not finalized'), 'outcome_unknown badge');
  notOk(outU.includes('>Finalized<'), 'no finalized badge');
  notOk(outU.includes('Finality evidence available'), 'no evidence-available claim');
  notOk(outU.includes('100%'), 'no percentage');
  const withEvidence = bareListRow({ state: 'outcome_unknown', finalized: false, verification: detailA().verification });
  eq(page.liveProofProgress(withEvidence).percent, null, 'no percent without stored finalized');
  ok((page.buildLiveTxTableHTML([withEvidence]) as string).includes('Finality evidence unavailable'), 'proof reads Finality evidence unavailable');
  // Pending states are distinct from outcome_unknown.
  for (const state of ['observed', 'submitting']) {
    const out = page.buildLiveTxTableHTML([bareListRow({ state })]) as string;
    ok(out.includes('Not finalized — ' + state.toUpperCase()), state + ' badge');
    notOk(out.includes('>Finalized<'), 'no finalized badge for ' + state);
  }
  const pendingEvidence = { available: true, observed: 'pending', finalized: false, source: 'concordium-grpc', blockHash: BLOCK_HASH };
  eq(page.liveProofProgress({ state: 'observed', verification: pendingEvidence }).percent, null, 'pending observation is not proof');
});

test('24. dashboard metrics come from the live list only; empty and error states are honest', () => {
  const src = extractFunctionSource('loadRealStats');
  ok(src.includes('fetchPaymentList()'), 'stats read the live payment list');
  ok(src.includes('No payment records yet — the facilitator has settled nothing.'), 'empty state is honest');
  ok(src.includes('badge-inconclusive">EMPTY'), 'empty badge');
  ok(src.includes('badge-failed">UNAVAILABLE'), 'error badge');
  ok(src.includes("payments.filter(p => p.state === 'finalized')"), 'finalized counted from the list');
  ok(src.includes("payments.filter(p => p.state === 'outcome_unknown')"), 'outcome_unknown counted from the list');
  notOk(src.includes('data-target'), 'no hardcoded count-up targets in the stats loader');
  const dashStart = html.indexOf('id="page-dashboard"');
  const dashEnd = html.indexOf('id="page-providers"', dashStart);
  const dash = html.slice(dashStart, dashEnd);
  notOk(/stat-value">\d/.test(dash), 'no hardcoded stat values in the dashboard markup');
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
console.log(`\nagent-a-website-page-consistency: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
