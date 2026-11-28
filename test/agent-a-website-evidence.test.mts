/**
 * Agent A website evidence (Workstream E, Testnet Agent Wallet Activation
 * & First Autonomous x402 Payment sprint, 2026-11-23).
 *
 * What the website shows for Agent A today, verified against the page
 * itself: the page functions are extracted VERBATIM from
 * `web/prototype-v5-6.html` and executed in a sandbox with only the
 * helpers they need (same pattern as payment-list-view and
 * agent-website-integration), so the tests assert what the page actually
 * renders, not a copy of it. Fixture data only — no chain, no broadcast,
 * no funding, no signing with owner credentials.
 *
 * Covers:
 *   - My Agents: Agent A confirmed shows its account address; a
 *     not_started Agent A shows none. Exact not-ready reasons in plain
 *     language, all 10 readiness conditions in backend order.
 *   - Recovery: race-based best effort, never "guaranteed".
 *   - Owner wallet separated from agent wallets; the owner wallet is
 *     never shown as signing agent payments.
 *   - Permissions: ACTIVE — LIVE only when the backend permission is
 *     enabled and not revoked/paused; no policy → NO PERMISSION YET.
 *     The records themselves come from a real PermissionManager.
 *   - Transactions: per-row detail enrichment merges block, sender,
 *     sponsor fee, energy and verification evidence into the stored
 *     list rows (the list alone carries none of those fields); the
 *     table renders Sol's six columns (Agent, Amount, Outcome,
 *     Finality evidence, Transaction, Action) with the Sol badges
 *     (Finalized / Stored as finalized / Outcome unknown · not
 *     finalized); the detail fields the table no longer columns
 *     (recipient, sender, network, block, energy, sponsor fee, time)
 *     are reachable in the receipt inspector (renderTxDetailInspector,
 *     test 12b); finalized / pending / outcome_unknown are
 *     distinguished; no manual import step exists.
 *   - Dashboard: metrics come from the live list only; empty and error
 *     states are honest, never demo values.
 *
 * Run: node node_modules/tsx/dist/cli.mjs test/agent-a-website-evidence.test.mts
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { PermissionManager } from '../src/pairing/permissions.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const ADDR_A = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '4MyVHYbRkAU6fqQsoSDzni6mrVz1KEvhDJoMVmDmrCgPBD8b7S';
const DIGEST_A = 'a1'.repeat(32);
const DIGEST_B = 'b2'.repeat(32);
const BLOCK_HASH = 'a3'.repeat(32);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');

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

// Detail-fetch stub for the enrichment tests: maps a paymentDigest to the
// { status, body } apiJsonTimeout would return, or an Error to throw.
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

// One sandbox for the whole live-list + readiness block, so the
// enrichment cache (liveTxDetailCache) persists across calls exactly as
// it does on the page.
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
  `${sandboxSource}\nreturn { enrichLiveTxRows, shortAddr, formatLiveAmount, formatLiveFee, formatLiveBlock, formatLiveNetwork, formatLiveEnergy, liveRowStateBadge, liveProofProgress, renderLiveProofProgress, formatLiveTxTime, buildLiveTxTableHTML, liveTxTableSignature, readinessStateLabel, readinessDetailHtml, confirmedAccountAddress, provisioningHtml, recoveryGuaranteeHtml, walletReadinessHtml };`,
)(
  escapeHtml,
  new Function(`return ${extractFunctionSource('formatMicroCcd')}`)(),
  new Function(`return ${extractFunctionSource('ccdscanTxUrl')}`)(),
  TESTNET_NETWORK_LABELS,
  stubApiJsonTimeout,
  READINESS_MISSING_PLAIN,
) as {
  enrichLiveTxRows: (payments: unknown[]) => Promise<unknown[]>;
  shortAddr: (addr: unknown) => string;
  formatLiveAmount: (p: unknown) => string;
  formatLiveFee: (p: unknown) => string;
  formatLiveBlock: (p: unknown) => string;
  formatLiveNetwork: (p: unknown) => string;
  formatLiveEnergy: (p: unknown) => string;
  liveRowStateBadge: (state: unknown) => string;
  liveProofProgress: (p: unknown) => { percent: number | null; label: string };
  renderLiveProofProgress: (p: unknown) => string;
  formatLiveTxTime: (updatedAt: unknown) => string;
  buildLiveTxTableHTML: (payments: unknown[]) => string;
  liveTxTableSignature: (payments: unknown[]) => string;
  readinessStateLabel: (v: unknown) => string;
  readinessDetailHtml: (w: unknown) => string;
  confirmedAccountAddress: (w: unknown) => string | null;
  provisioningHtml: (w: unknown) => string;
  recoveryGuaranteeHtml: (w: unknown) => string;
  walletReadinessHtml: (w: unknown) => string;
};

// ── fixtures ─────────────────────────────────────────────────────────────

// A stored list row exactly as the facilitator's GET /payments returns
// it: digest, state, hash, agent, wallet, amount, payTo, network, asset,
// timestamps, attempted — NO block, sender, sponsor fee, energy, or
// verification evidence.
const bareListRow = (over: Record<string, unknown> = {}) => ({
  paymentDigest: DIGEST_A,
  state: 'finalized',
  transactionHash: DIGEST_A,
  agentId: '1004',
  walletId: 'wallet-a-1004',
  amount: '1',
  payTo: PAY_TO,
  network: CAIP2,
  asset: 'CCD',
  createdAt: 1795000000000,
  updatedAt: 1795000001000,
  attempted: 1,
  ...over,
});

// A detail record exactly as the resource server's GET /api/payments/:id
// returns it (values from the repo's payment-detail-api fixture).
const detailA = (over: Record<string, unknown> = {}) => ({
  paymentDigest: DIGEST_A,
  state: 'finalized',
  finalized: true,
  transactionHash: DIGEST_A,
  requirements: {
    network: CAIP2, payTo: PAY_TO, amount: '1', asset: 'CCD',
    resourceUrl: 'http://127.0.0.1:4590/protected',
    raw: `${CAIP2}|${PAY_TO}|1|CCD|http://127.0.0.1:4590/protected`,
  },
  attempted: 1,
  createdAt: 1795000000000,
  updatedAt: 1795000001000,
  transitions: [],
  verification: {
    available: true, observed: 'finalized', source: 'concordium-grpc', finalized: true,
    blockHash: BLOCK_HASH, blockHeight: '50970567', blockSlotTime: '2026-11-18T11:01:24.585Z',
    sender: ADDR_A, sponsor: SPONSOR, feeMicroCcd: '4800331', energy: '635',
    recipient: PAY_TO, transferAmount: '1', error: null,
  },
  ...over,
});

// Agent A wallet records as GET /api/wallets serialises them.
const walletAConfirmed = (over: Record<string, unknown> = {}) => ({
  walletId: 'wallet-a-1004',
  agentId: '1004',
  ownerWalletAddress: OWNER,
  network: CAIP2,
  accountAddress: ADDR_A,
  credentialIndex: 0,
  threshold: 1,
  deploymentStatus: 'step2_deployed',
  recoveryCredentialStatus: 'verified',
  paymentReady: false,
  paymentReadinessMissing: ['funded', 'sponsor', 'policy'],
  paymentReadiness: {
    accountAddress: ADDR_A, agentCredential: 'deployed', recoveryCredential: 'verified',
    signingKey: 'stored', signingBinding: 'verified', funded: false, sponsor: 'unavailable',
    policy: 'denied', suspension: 'clear', network: 'testnet',
    recoveryGuarantee: 'race_based_best_effort',
  },
  provisioning: { state: 'confirmed', accountAddress: ADDR_A, detail: 'confirmed on chain' },
  ...over,
});

const walletANotStarted = (over: Record<string, unknown> = {}) => ({
  walletId: 'wallet-a-1004',
  agentId: '1004',
  ownerWalletAddress: OWNER,
  network: CAIP2,
  accountAddress: null,
  credentialIndex: 0,
  threshold: 1,
  deploymentStatus: 'not_deployed',
  recoveryCredentialStatus: 'not_installed',
  paymentReady: false,
  paymentReadinessMissing: ['account', 'agent_credential', 'recovery_credential', 'signing_key', 'signing_binding', 'funded', 'sponsor', 'policy', 'suspension', 'network'],
  paymentReadiness: {
    accountAddress: null, agentCredential: 'not_deployed', recoveryCredential: 'not_installed',
    signingKey: 'absent', signingBinding: 'absent', funded: false, sponsor: 'unavailable',
    policy: 'denied', suspension: 'unknown', network: 'unknown',
    recoveryGuarantee: 'none',
  },
  provisioning: { state: 'not_started', accountAddress: null, detail: '' },
  ...over,
});

// ── My Agents: Agent A provisioning / account status ─────────────────────

test('01. Agent A confirmed shows its account address; not_started shows none', () => {
  eq(page.confirmedAccountAddress(walletAConfirmed()), ADDR_A, 'confirmed Agent A address shown');
  eq(page.confirmedAccountAddress(walletANotStarted()), null, 'not_started Agent A shows no address');
  // A prepared build's expected address is never shown as an account.
  eq(page.confirmedAccountAddress(walletAConfirmed({
    provisioning: { state: 'prepared', accountAddress: null, detail: '' },
    accountAddress: ADDR_A, deploymentStatus: 'not_deployed',
  })), null, 'prepared expected address is not an account');
  ok(page.provisioningHtml(walletAConfirmed()).includes('confirmed on chain'), 'confirmed provisioning labelled');
  ok(page.provisioningHtml(walletANotStarted()).includes('not started'), 'not_started provisioning labelled');
});

// ── My Agents: exact not-ready reasons ───────────────────────────────────

test('02. Agent A confirmed but not payment-ready lists the exact missing reasons in plain language', () => {
  const out = page.walletReadinessHtml(walletAConfirmed());
  ok(out.includes('<span class="badge-inconclusive">NOT PAYMENT READY</span>'), 'not ready badge');
  notOk(out.includes('<span class="badge-live">PAYMENT READY</span>'), 'no ready badge while conditions are missing');
  for (const m of ['funded', 'sponsor', 'policy']) {
    ok(out.includes(READINESS_MISSING_PLAIN[m]), 'plain reason for ' + m);
    ok(out.includes('<code>' + m + '</code>'), 'code shown for ' + m);
  }
  // Control: the same agent with every condition met renders PAYMENT READY.
  const ready = walletAConfirmed({
    paymentReady: true,
    paymentReadinessMissing: [],
    paymentReadiness: {
      accountAddress: ADDR_A, agentCredential: 'deployed', recoveryCredential: 'verified',
      signingKey: 'stored', signingBinding: 'verified', funded: true, sponsor: 'ready',
      policy: 'allowed', suspension: 'clear', network: 'testnet',
      recoveryGuarantee: 'race_based_best_effort',
    },
  });
  ok(page.walletReadinessHtml(ready).includes('<span class="badge-live">PAYMENT READY</span>'), 'fully ready agent shows PAYMENT READY');
});

test('03. Agent A not_started lists all 10 readiness conditions with live states, in backend order', () => {
  const out = page.walletReadinessHtml(walletANotStarted());
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
  }
  ok(out.includes('✗ Account: no account'), 'account condition reads not met');
});

// ── My Agents: recovery ───────────────────────────────────────────────────

test('04. recovery is shown as race-based best effort, never guaranteed', () => {
  const out = page.recoveryGuaranteeHtml(walletAConfirmed());
  ok(out.includes('best effort (race)'), 'race-based best effort wording');
  ok(out.includes('not a guarantee'), 'explicitly not a guarantee');
  notOk(out.toLowerCase().includes('guaranteed'), 'never "guaranteed"');
  // Fallback derivation: verified recovery + threshold 1 without the
  // backend field still renders best effort, never a guarantee.
  const derived = page.recoveryGuaranteeHtml(walletAConfirmed({
    paymentReadiness: { recoveryGuarantee: undefined },
  }));
  ok(derived.includes('best effort (race)'), 'derived best effort without the backend field');
  const none = page.recoveryGuaranteeHtml(walletANotStarted());
  ok(none.includes('RECOVERY GUARANTEE:</span> none'), 'no recovery credential → none');
  ok(page.walletReadinessHtml(walletAConfirmed()).includes('best effort (race)'), 'readiness render carries the race wording');
  const recStart = html.indexOf('function recoveryGuaranteeHtml');
  const recEnd = html.indexOf('function walletReadinessHtml', recStart);
  notOk(html.slice(recStart, recEnd).toLowerCase().includes('guaranteed'), 'recovery renderer never says guaranteed');
});

// ── Wallet: owner vs agent ───────────────────────────────────────────────

test('05. owner wallet is separated from agent wallets and never shown as signing agent payments', () => {
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

// ── permission fixtures (same grant pattern as agent-wallet-permissions) ──

function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signer = {
    async sign(digest: ArrayBuffer) {
      const sig = sign(null, Buffer.from(digest), privateKey);
      return { 0: { 0: sig.toString('hex') } };
    },
    getSignatureCount() {
      return 1n;
    },
  };
  return { signer, accountInfo: makeFakeAccountInfo({ address: OWNER, verifyKey: rawPub }) };
}

/** Grant a permission with a freshly signed owner challenge. */
async function grant(
  mgr: PermissionManager,
  opts: {
    agent?: string;
    limits: { perTxMicroCcd: bigint | null; dailyMicroCcd: bigint | null; periodMicroCcd: bigint | null; periodSeconds: number | null };
    allowlist?: string[] | null;
    policy?: 'manual' | 'bounded_auto';
  },
) {
  const key = makeTestKey();
  const agent = opts.agent ?? '1004';
  const challenge = mgr.issueChallenge({ walletAddress: OWNER, agentId: agent, network: CAIP2, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(OWNER), challenge.message, key.signer as never);
  return mgr.grantPermission({
    walletAddress: OWNER,
    agentId: agent,
    network: CAIP2,
    pairingId: 'p1',
    limits: opts.limits,
    recipientAllowlist: opts.allowlist ?? null,
    policy: opts.policy ?? 'bounded_auto',
    challenge,
    signature,
    accountInfo: key.accountInfo as never,
  });
}

// ── Permissions ──────────────────────────────────────────────────────────

test('06. Permissions shows ACTIVE only for an enabled, unrevoked, unpaused policy; no policy → NO PERMISSION YET', () => {
  const src = extractFunctionSource('loadPermissionsPage');
  ok(src.includes("'/api/permission?wallet='"), 'permission is fetched live from the backend');
  ok(src.includes("perm.revoked ? ['REVOKED', 'badge-failed'] : perm.paused ? ['PAUSED', 'badge-inconclusive'] : perm.enabled ? ['ACTIVE — LIVE', 'badge-live'] : ['DISABLED', 'badge-inconclusive']"), 'ACTIVE requires enabled and not revoked/paused');
  ok(src.includes("badge.textContent = 'NO PERMISSION YET'"), 'no policy → NO PERMISSION YET');
  ok(src.includes('perm.limits.perTxMicroCcd'), 'limits come from the backend record');
  ok(src.includes('perm.policy'), 'policy mode comes from the backend record');
  ok(src.includes('perm.recipientAllowlist'), 'allowlist comes from the backend record');
});

test('07. backend: Agent A holds a bounded_auto policy with limits; Agent B holds none', async () => {
  const mgr = new PermissionManager({ now: () => 1000000000000 });
  const res = await grant(mgr, {
    agent: '1004',
    limits: { perTxMicroCcd: 1n, dailyMicroCcd: 10n, periodMicroCcd: 100n, periodSeconds: 604800 },
    allowlist: [PAY_TO],
    policy: 'bounded_auto',
  });
  ok(res.ok, 'grant succeeds');
  const permA = mgr.getPermission(OWNER, '1004', CAIP2);
  ok(permA, 'Agent A permission exists');
  eq(permA!.policy, 'bounded_auto', 'bounded_auto policy');
  eq(permA!.enabled, true, 'enabled');
  eq(permA!.paused, false, 'not paused');
  eq(permA!.revoked, false, 'not revoked');
  eq(permA!.limits.perTxMicroCcd, 1n, 'per-tx limit 1 microCCD');
  eq(permA!.limits.dailyMicroCcd, 10n, 'daily limit 10 microCCD');
  eq(permA!.limits.periodMicroCcd, 100n, 'period limit 100 microCCD');
  eq(permA!.limits.periodSeconds, 604800, 'weekly period');
  eq(permA!.recipientAllowlist?.length, 1, 'one allowlisted recipient');
  eq(mgr.getPermission(OWNER, '1005', CAIP2), undefined, 'Agent B has no permission');
});

test('08. a paused or revoked permission never qualifies for the ACTIVE display', async () => {
  const mgr = new PermissionManager({ now: () => 1000000000000 });
  await grant(mgr, {
    agent: '1004',
    limits: { perTxMicroCcd: 1n, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null },
    allowlist: null,
    policy: 'bounded_auto',
  });
  mgr.pausePermission(OWNER, '1004', CAIP2);
  eq(mgr.getPermission(OWNER, '1004', CAIP2)?.paused, true, 'paused record reads back paused');
  mgr.revokePermission(OWNER, '1004', CAIP2);
  eq(mgr.getPermission(OWNER, '1004', CAIP2)?.revoked, true, 'revoked record reads back revoked');
  // The page badge ternary (test 06) maps paused → PAUSED and revoked →
  // REVOKED, never ACTIVE — LIVE.
});

// ── Transactions: detail enrichment ──────────────────────────────────────

test('09. enrichment merges the detail evidence into a finalized list row', async () => {
  detailStub.clear(); detailFetchCalls.clear();
  detailStub.set(DIGEST_A, { status: 200, body: detailA() });
  const rows = [bareListRow()];
  await page.enrichLiveTxRows(rows);
  const r = rows[0] as Record<string, unknown>;
  eq(r.blockHeight, '50970567', 'block height merged');
  eq(r.sender, ADDR_A, 'sender merged');
  eq(r.recipient, PAY_TO, 'recipient merged');
  eq(r.sponsorFeeMicroCcd, '4800331', 'sponsor fee merged');
  eq(r.energy, '635', 'energy merged');
  eq(r.finalized, true, 'stored finalized merged');
  ok((r.verification as Record<string, unknown>)?.available === true, 'verification object merged');
  eq(detailFetchCalls.get(DIGEST_A), 1, 'one detail fetch for the digest');
});

test('10. enrichment is cached per digest and refetched only on state/updatedAt change', async () => {
  detailStub.clear(); detailFetchCalls.clear();
  detailStub.set(DIGEST_B, { status: 200, body: detailA({ paymentDigest: DIGEST_B, transactionHash: DIGEST_B }) });
  const rows = [bareListRow({ paymentDigest: DIGEST_B, transactionHash: DIGEST_B })];
  await page.enrichLiveTxRows(rows);
  eq(detailFetchCalls.get(DIGEST_B), 1, 'first load fetches');
  await page.enrichLiveTxRows(rows);
  eq(detailFetchCalls.get(DIGEST_B), 1, 'unchanged row is not refetched');
  const changed = [bareListRow({ paymentDigest: DIGEST_B, transactionHash: DIGEST_B, updatedAt: 1795000002000 })];
  await page.enrichLiveTxRows(changed);
  eq(detailFetchCalls.get(DIGEST_B), 2, 'updated row refetches');
  eq((changed[0] as Record<string, unknown>).blockHeight, '50970567', 'refetched row still enriched');
});

test('11. a failed detail fetch leaves the row unenriched and never throws', async () => {
  detailStub.clear(); detailFetchCalls.clear();
  const digest = 'c3'.repeat(32);
  detailStub.set(digest, new Error('api_unreachable'));
  const rows = [bareListRow({ paymentDigest: digest, transactionHash: digest })];
  await page.enrichLiveTxRows(rows); // must not throw
  const r = rows[0] as Record<string, unknown>;
  eq(r.blockHeight, undefined, 'no block without evidence');
  eq(r.verification, undefined, 'no verification without evidence');
  eq(detailFetchCalls.get(digest), 1, 'the failed fetch was attempted');
  const out = page.buildLiveTxTableHTML(rows);
  ok(out.includes('Finality evidence unavailable'), 'evidence cell reads Finality evidence unavailable');
  ok(out.includes('Stored as finalized'), 'stored state badge without evidence');
  notOk(out.includes('Finality evidence available'), 'no evidence-available claim without evidence');
  notOk(out.includes('>Finalized<'), 'no Finalized badge without evidence');
});

// ── Transactions: table rendering ────────────────────────────────────────

test('12. a finalized enriched row renders the Sol six-column table with the Finalized badge and evidence-available label', async () => {
  const row = bareListRow();
  detailStub.clear(); detailFetchCalls.clear();
  detailStub.set(DIGEST_A, { status: 200, body: detailA() });
  await page.enrichLiveTxRows([row]);
  const out = page.buildLiveTxTableHTML([row]);
  // Sol §6 six columns: Agent, Amount, Outcome, Finality evidence,
  // Transaction, Action.
  ok(out.includes('Agent #1004'), 'Agent A attribution');
  ok(out.includes('wallet-a-1004'), 'wallet id in the agent title');
  ok(out.includes('1 µCCD'), 'amount');
  ok(out.includes('>Finalized<'), 'Finalized badge with evidence');
  ok(out.includes('Finality evidence available'), 'finality evidence available');
  ok(out.includes('a1a1a1a1…a1a1a1a1'), 'short tx hash');
  ok(out.includes('https://testnet.ccdscan.io/?dcount=1&amp;dentity=transaction&amp;dhash=' + DIGEST_A), 'CCDScan link');
  ok(out.includes('#/transactions/' + DIGEST_A), 'inspector link');
  notOk(out.includes('100%'), 'no percentage claim in the table');
  // The detail fields the table no longer columns (recipient, sender,
  // network, block, energy, sponsor fee, time) are reachable in the
  // receipt inspector (test 12b).
});

// ── Receipt inspector harness ────────────────────────────────────────────
// Sol §6 moved the detail fields (recipient, sender, network, block,
// energy, sponsor fee, time) out of the table columns into the receipt
// inspector (renderTxDetailInspector). This harness runs the verbatim
// inspector against a stubbed detail fetch so the reachability of those
// fields is still proven by a test, not by inspection alone.
const formatMicroCcdFn = new Function(`return ${extractFunctionSource('formatMicroCcd')}`)() as (v: unknown) => string;
const ccdscanTxUrlFn = new Function(`return ${extractFunctionSource('ccdscanTxUrl')}`)() as (hash: string) => string;
const formatBlockTimeWibFn = new Function(`return ${extractFunctionSource('formatBlockTimeWib')}`)() as (v: unknown) => string;
function makeInspectorHarness(detailBody: unknown, status = 200) {
  const el = { hidden: true, innerHTML: '' };
  const docStub = {
    getElementById: (id: string) => (id === 'tx-detail-inspector' ? el : null),
    querySelectorAll: () => [] as unknown[],
  };
  const fetchStub = async (url: string) => {
    void url;
    if (detailBody === null) return { status: 404, ok: false, json: async () => ({}) };
    return { status, ok: status >= 200 && status < 300, json: async () => detailBody };
  };
  const inspSrc = extractFunctionSource('renderTxDetailInspector');
  const asyncInspSrc = inspSrc.startsWith('async ') ? inspSrc : 'async ' + inspSrc;
  const render = new Function(
    'document', 'fetch', 'apiUrl', 'realTransactionsData', 'TESTNET_NETWORK_LABELS',
    'escapeHtml', 'ccdscanTxUrl', 'formatBlockTimeWib', 'formatMicroCcd',
    'renderTxDetailFallback', 'buildTransitionTimeline', 'errText',
    asyncInspSrc + '\n' + extractFunctionSource('renderTxDetailFallback') + '\n' + extractFunctionSource('buildTransitionTimeline') + '\n' + extractFunctionSource('errText') + '\nreturn renderTxDetailInspector;',
  )(docStub, fetchStub, (p: string) => p, [], TESTNET_NETWORK_LABELS, escapeHtml, ccdscanTxUrlFn, formatBlockTimeWibFn, formatMicroCcdFn) as (hash: string) => Promise<void>;
  return { render, el };
}

test('12b. the receipt inspector exposes the detail fields the table no longer columns (recipient, network, block, energy, sponsor fee, time)', async () => {
  const h = makeInspectorHarness(detailA());
  await h.render(DIGEST_A);
  const out = h.el.innerHTML;
  ok(out.includes(PAY_TO), 'recipient from the detail payTo');
  ok(out.includes(ADDR_A), 'sender from the detail verification');
  ok(out.includes('Concordium Testnet'), 'network label');
  ok(out.includes('#50970567'), 'finalized block height');
  ok(out.includes('4.800331 CCD'), 'sponsored network fee');
  ok(out.includes('635 NRG'), 'execution energy');
  ok(out.includes('Timestamp (WIB)'), 'timestamp label');
  ok(out.includes('18 Nov 2026'), 'timestamp in WIB');
  ok(out.includes(DIGEST_A), 'full transaction hash in the receipt');
  ok(out.includes('LIVE TESTNET VERIFICATION — FINALIZED'), 'live verification badge for the evidenced row');
  ok(out.includes('testnet.ccdscan.io'), 'CCDScan link in the receipt');
  // The detail record carries no agent attribution (it lives in the list
  // row, asserted in tests 12/13) — the receipt says so honestly rather
  // than inventing it.
  ok(out.includes('this payment predates agent attribution'), 'the receipt is honest about missing agent attribution in the detail record');
  // A missing detail renders an honest unavailable receipt, never invented fields.
  const h404 = makeInspectorHarness(null, 404);
  await h404.render(DIGEST_A);
  ok(h404.el.innerHTML.includes('Not in this facilitator'), 'missing detail is reported honestly');
  ok(h404.el.innerHTML.includes('testnet.ccdscan.io'), 'the fallback still links to CCDScan');
});

test('13. a bare list row renders honest not-available evidence cells and the stored-state badge', () => {
  const out = page.buildLiveTxTableHTML([bareListRow()]);
  ok(out.includes('Agent #1004'), 'agent attribution from the list');
  ok(out.includes('Stored as finalized'), 'stored state badge still from the list');
  ok(out.includes('Finality evidence unavailable'), 'missing evidence reads Finality evidence unavailable');
  notOk(out.includes('Finality evidence available'), 'no evidence-available claim without evidence');
  notOk(out.includes('100%'), 'no percentage without evidence');
  ok(out.includes('1 µCCD'), 'amount comes from the list itself');
  // The recipient and network the old table showed from the list are
  // reachable in the receipt inspector (test 12b); the table itself
  // has no recipient or network column under Sol §6.
});

test('14. outcome_unknown renders as Outcome unknown · not finalized, never finalized', () => {
  const row = bareListRow({ state: 'outcome_unknown', transactionHash: null });
  const out = page.buildLiveTxTableHTML([row]);
  ok(out.includes('Outcome unknown · not finalized'), 'outcome_unknown badge');
  notOk(out.includes('>Finalized<'), 'no finalized badge');
  notOk(out.includes('Finality evidence available'), 'no evidence-available claim');
  notOk(out.includes('100%'), 'no percentage');
  // Even genuine chain evidence cannot finalise a stored outcome_unknown row.
  const withEvidence = bareListRow({ state: 'outcome_unknown', finalized: false, verification: detailA().verification });
  eq(page.liveProofProgress(withEvidence).percent, null, 'no percent without stored finalized');
  ok(page.buildLiveTxTableHTML([withEvidence]).includes('Finality evidence unavailable'), 'proof reads Finality evidence unavailable');
});

test('15. pending (observed / submitting) renders as not finalized, distinct from outcome_unknown', () => {
  for (const state of ['observed', 'submitting']) {
    const out = page.buildLiveTxTableHTML([bareListRow({ state })]);
    ok(out.includes('Not finalized — ' + state.toUpperCase()), state + ' badge');
    notOk(out.includes('>Finalized<'), 'no finalized badge for ' + state);
  }
  const pendingEvidence = { available: true, observed: 'pending', finalized: false, source: 'concordium-grpc', blockHash: BLOCK_HASH };
  eq(page.liveProofProgress({ state: 'observed', verification: pendingEvidence }).percent, null, 'pending observation is not proof');
});

test('16. network and energy formatters read the real values and fall back honestly', () => {
  eq(page.formatLiveNetwork({ network: CAIP2 }), 'Concordium Testnet', 'testnet label');
  eq(page.formatLiveNetwork({ network: 'some:unknown-network' }), 'some:unknown-network', 'unknown network shown raw');
  eq(page.formatLiveNetwork({}), 'not available', 'no network without evidence');
  eq(page.formatLiveEnergy({ energy: '635' }), '635 NRG', 'real energy');
  eq(page.formatLiveEnergy({}), 'not available', 'no energy without evidence');
  eq(page.formatLiveEnergy({ energy: '' }), 'not available', 'empty energy is not available');
  eq(page.formatLiveBlock({ blockHeight: '51105034' }), '#51105034', 'real block height');
  eq(page.formatLiveFee({ sponsorFeeMicroCcd: '5108270' }), '5.108270 CCD', 'real sponsor fee');
});

test('17. transactions auto-populate from the live list; no manual import step exists', () => {
  const txStart = html.indexOf('id="page-transactions"');
  const txEnd = html.indexOf('id="page-analytics"', txStart);
  const txPage = html.slice(txStart, txEnd);
  notOk(/type="file"/.test(txPage), 'no file input on the Transactions page');
  notOk(/>Import</.test(txPage), 'no Import button on the Transactions page');
  notOk(/paste/i.test(txPage), 'no paste affordance on the Transactions page');
  const loader = extractFunctionSource('loadLiveTxTable');
  ok(loader.includes("fetch(apiUrl('/api/payments'))"), 'loader fetches the live list');
  ok(loader.includes('enrichLiveTxRows(payments)'), 'loader enriches rows from the detail endpoint');
  ok(html.includes('setInterval(refreshLiveTxTable, 30000)'), '30-second auto-refresh');
  const router = extractFunctionSource('handleRouteChange');
  ok(router.includes("if (baseRoute === 'transactions')"), 'router refreshes on navigation to Transactions');
  const table = page.buildLiveTxTableHTML([bareListRow()]);
  ok(table.includes('Agent #1004'), 'payment attributed to Agent A');
  ok(table.includes('title="Agent wallet: wallet-a-1004"'), 'agent wallet id in the title');
  const unattributed = page.buildLiveTxTableHTML([bareListRow({ agentId: null, walletId: null })]);
  ok(unattributed.includes('not recorded'), 'payments without attribution say so');
});

// ── Dashboard ────────────────────────────────────────────────────────────

test('18. dashboard metrics come from the live list only; empty and error states are honest', () => {
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

// ── Regression guards ────────────────────────────────────────────────────

test('19. the page no longer claims the list is enriched by the resource server', () => {
  notOk(html.includes('enriched by the resource server with each payment'), 'false enrichment claim removed');
  notOk(html.includes('Block, amount and sponsored fee now come from the enriched list response'), 'false fee/block claim removed');
  ok(html.includes('it does NOT carry'), 'page states what the list does not carry');
  ok(html.includes('enrichLiveTxRows'), 'detail enrichment is the named mechanism');
});

test('20. the list signature covers the enriched evidence fields, so new evidence re-renders', () => {
  const sig = extractFunctionSource('liveTxTableSignature');
  for (const field of ['p.verification', 'p.blockHeight', 'p.sponsorFeeMicroCcd', 'p.sender', 'p.recipient', 'p.energy', 'p.network', 'p.finalized']) {
    ok(sig.includes(field), 'signature covers ' + field);
  }
  const before = page.liveTxTableSignature([bareListRow()]);
  const after = page.liveTxTableSignature([{ ...bareListRow(), energy: '635', blockHeight: '50970567' }]);
  notOk(before === after, 'evidence change changes the signature');
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
console.log(`\nagent-a-website-evidence: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
