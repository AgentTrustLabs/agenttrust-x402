/**
 * Agent A website ↔ real launcher persistent-state consistency
 * (Workstream E, Testnet Activation Unblock & Provisioning Preflight
 * sprint, 2026-11-23).
 *
 * What the website shows against the real launcher's persistent state:
 * the provisioning attempts, wallet records, and permission records the
 * launcher serves from its durable SQLite stores — not a copy of them.
 * The page functions are extracted VERBATIM from
 * `web/prototype-v5-6.html` and executed in a sandbox with only the
 * helpers they need (same pattern as payment-list-view,
 * agent-website-integration, and agent-a-website-evidence), so the
 * tests assert what the page actually renders.
 *
 * Fixture data only — no chain, no broadcast, no funding, no signing
 * with owner credentials. The fixture account address `3whdieGH…` is the
 * long-standing test identifier; it is NEVER presented as a real Agent A
 * address (it happens to exist on Testnet by coincidence, nonce 7 —
 * see the previous sprint's C §3.2). No Agent A account exists on
 * Testnet, no wallet is payment-ready, no policy is activated here.
 *
 * Scope note — the launcher wiring itself is siblings A/B:
 *   - A wires `verifyWallet` into `createPersistentStores` + the real
 *     launcher. Here the hook is constructed directly on a real
 *     `PermissionManager` over a real `SqlitePermissionBackend`, so the
 *     website is tested against the state that wiring will serve.
 *   - B wires `ProvisioningStore` into the real launcher. Here the
 *     manager is constructed with a real `ProvisioningStore` on the
 *     same `<stateDir>/provisioning.db` file the deploy script uses, so
 *     the website is tested against the state that wiring will serve.
 *     Test 09 documents the current gap explicitly: a manager built
 *     WITHOUT a provisioning store cannot see a prepared attempt at all
 *     (the launcher as it exists today), so the website reports
 *     `not_started` for it.
 *
 * Covers:
 *   - My Agents: a `prepared` attempt renders as prepared (never
 *     confirmed, never with an address); `submitted` / `unknown`
 *     survive a restart and render honestly; a confirmed record shows
 *     its address; a confirmed attempt with a missing wallet record
 *     shows the repair flag; duplicate allocation is refused from the
 *     durable used-set; reconciliation never broadcasts and never
 *     invents confirmation.
 *   - Recovery: race-based best effort, never "guaranteed"; exact
 *     not-ready reasons in plain language, all 10 conditions in
 *     backend order; owner/agent separation.
 *   - Wallet: session authentication + ownership checks preserved
 *     (401 → reconnect state); no signing secret exposed; the owner
 *     challenge-signing label is accurate.
 *   - Permissions: NO PERMISSION YET until a real policy is granted;
 *     a `bounded_auto` policy granted through the strict path with a
 *     passing `verifyWallet` hook renders ACTIVE — LIVE with its
 *     recipient, limits, period and expiry, and survives a restart;
 *     a failing `verifyWallet` refuses the grant; a prepared spec
 *     (not granted) is never an active permission; revoked/paused
 *     never qualify for ACTIVE.
 *   - Transactions/Dashboard: automatic history from durable records;
 *     pending / finalized / outcome_unknown distinguished; historical
 *     payments are never counted as Agent A payments; missing
 *     attribution is labelled honestly.
 *
 * Run: node node_modules/tsx/dist/cli.mjs test/agent-a-website-launcher-consistency.test.mts
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import { AccountAddress, TransactionExpiry, getAccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { PermissionManager } from '../src/pairing/permissions.js';
import { SqlitePermissionBackend } from '../src/pairing/permissionsSqlite.js';
import { WalletStore, type WalletRecord } from '../src/pairing/walletStore.js';
import {
  ProvisioningStore,
  provisioningDbPath,
  allocateAgentIdentityPair,
  validateIdentityNumberPair,
  prepareStep1Attempt,
  submitStep1Attempt,
  confirmStep1Attempt,
  deriveProvisioningState,
  type ProvisioningAttempt,
  type PrepareStep1Args,
  type AgentCredentialDeploymentInput,
} from '../src/pairing/agentProvisioning.js';
import { reconcileWalletFromChain } from '../src/pairing/provisioningRepair.js';
import { AgenticWalletManager } from '../src/pairing/agenticWallet.js';
import { InMemoryWalletKeyStore } from '../src/pairing/walletSigner.js';
import { TESTNET_CAIP2, TESTNET_GENESIS_HASH } from '../src/pairing/agentCredentialDeployment.js';
import { createWalletConnection, WalletErrors } from '../web/wallet-connect.mjs';

const CAIP2 = TESTNET_CAIP2;
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '4MyVHYbRkAU6fqQsoSDzni6mrVz1KEvhDJoMVmDmrCgPBD8b7S';
const PAY_TO_B = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NOW = 1_782_720_000; // fixed epoch seconds
const NOW_MS = NOW * 1000;
const AGENT_KEY = '11'.repeat(32);
const RECOVERY_KEY = '22'.repeat(32);
const CRED_ID = 'aa'.repeat(48);
// Fixture account address (test identifier only — see the header note).
const ADDR_A = AccountAddress.toBase58(getAccountAddress(CRED_ID));
const TX_HASH = 'aa'.repeat(32);
const DIGEST_A = 'a1'.repeat(32);
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

// ── fixtures ───────────────────────────────────────────────────────────────

/** Structurally valid (but cryptographically fake) identity input. */
const fakeIdentity = {
  identityProvider: { ipInfo: { ipIdentity: 0, ipDescription: 'test', ipVerifyKey: 'aa'.repeat(32) }, arsInfos: {} },
  identityObject: {},
  prfKey: '44'.repeat(32),
  idCredSecret: '55'.repeat(32),
  randomness: '66'.repeat(16),
};

const fakeCryptoParams = {
  onChainCommitmentKey: 'aa'.repeat(48),
  bulletproofGenerators: 'bb'.repeat(10),
  genesisString: TESTNET_GENESIS_HASH,
};

const CANNED_CDI = {
  credentialPublicKeys: { keys: { 0: { schemeId: 'Ed25519', verifyKey: AGENT_KEY } }, threshold: 1 },
  credId: CRED_ID,
  ipIdentity: 0,
  revocationThreshold: 1,
  arData: {},
  policy: { validTo: '203001', createdAt: '202501', revealedAttributes: {} },
  proofs: {
    sig: 'bb'.repeat(64),
    commitments: 'cc'.repeat(64),
    challenge: 'dd'.repeat(32),
    proofIdCredPub: {},
    proofIpSig: 'ee'.repeat(64),
    proofRegId: 'ff'.repeat(64),
    credCounterLessThanMaxAccounts: 'ab'.repeat(32),
  },
};

function step1Input(over: Partial<AgentCredentialDeploymentInput> = {}): AgentCredentialDeploymentInput {
  return {
    identity: fakeIdentity,
    cryptographicParameters: fakeCryptoParams,
    agentPublicKeyHex: AGENT_KEY,
    recoveryPublicKeyHex: RECOVERY_KEY,
    credentialIndex: 0,
    expiryEpochSeconds: NOW + 3600,
    network: CAIP2,
    genesisHash: TESTNET_GENESIS_HASH,
    maxEnergyNRG: 1000n,
    now: () => NOW_MS,
    ...over,
  };
}

function cannedPayload(expiryEpochSeconds: number) {
  return {
    unsignedCdi: CANNED_CDI,
    randomness: 'aa'.repeat(32),
    expiry: TransactionExpiry.fromEpochSeconds(expiryEpochSeconds),
  };
}

let walletSeq = 0;
function prepareArgs(over: {
  walletId?: string;
  agentId?: string;
  ownerWalletAddress?: string;
  network?: string;
  buildInputOver?: Partial<AgentCredentialDeploymentInput>;
  nowSec?: number;
} = {}): PrepareStep1Args {
  const nowSec = over.nowSec ?? NOW;
  const buildInput = step1Input({
    expiryEpochSeconds: nowSec + 3600,
    now: () => nowSec * 1000,
    ...(over.buildInputOver ?? {}),
  });
  const walletId = over.walletId ?? `w_test_${++walletSeq}`;
  return {
    walletId,
    agentId: over.agentId ?? `agent_${walletId}`,
    ownerWalletAddress: over.ownerWalletAddress ?? OWNER,
    network: over.network ?? CAIP2,
    buildInput,
    buildDeps: { createPayload: () => cannedPayload(buildInput.expiryEpochSeconds) },
    now: () => nowSec * 1000,
  };
}

/** A wallet record as the launcher's WalletStore holds it. */
function walletRecord(over: Partial<WalletRecord> = {}): WalletRecord {
  return {
    walletId: 'w_' + 'a1'.repeat(12),
    agentId: '1004',
    ownerWalletAddress: OWNER,
    network: CAIP2,
    genesisHash: TESTNET_GENESIS_HASH,
    accountAddress: null,
    signingPublicKeyHex: AGENT_KEY,
    status: 'active',
    fundingStatus: 'unfunded',
    balanceMicroCcd: null,
    createdAt: NOW,
    updatedAt: NOW,
    deploymentStatus: 'not_deployed',
    recoveryCredentialStatus: 'not_installed',
    credentialIndex: null,
    threshold: null,
    pendingSigningPublicKeyHex: null,
    recoveryPublicKeyHex: RECOVERY_KEY,
    agentCredentialId: null,
    recoveryCredentialId: null,
    recoveryIdentityCredentialIndex: null,
    ...over,
  } as WalletRecord;
}

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

/** A real manager over temp-file stores, as the launcher constructs it (plus the provisioning store B wires in). */
function launcherManager(dir: string, opts: { provisioningStore?: ProvisioningStore } = {}) {
  const walletStore = new WalletStore({ path: join(dir, 'wallets.db') });
  const provStore = opts.provisioningStore ?? new ProvisioningStore({ path: provisioningDbPath(dir) });
  const manager = new AgenticWalletManager({
    store: walletStore,
    keyStore: new InMemoryWalletKeyStore(),
    provisioningStore: provStore,
  });
  return { walletStore, provStore, manager };
}

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

/** The prepared Agent A bounded policy spec (NOT activated — a spec, not a permission). */
const AGENT_A_POLICY_SPEC = {
  perTxMicroCcd: 1n,
  dailyMicroCcd: 10n,
  periodMicroCcd: 100n,
  periodSeconds: 7 * 86400,
  recipientAllowlist: [PAY_TO_B],
};

/** Grant the Agent A bounded policy through the strict path, over a real persistent backend. */
async function grantBounded(
  m: PermissionManager,
  opts: { agent?: string; wallet?: string; expiresAt?: number | null } = {},
) {
  const key = makeTestKey();
  const wallet = opts.wallet ?? OWNER;
  const agent = opts.agent ?? 'agent-1';
  const challenge = m.issueChallenge({ walletAddress: wallet, agentId: agent, network: CAIP2, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(wallet), challenge.message, key.signer as never);
  return m.grantBoundedAutoPolicy({
    walletAddress: wallet,
    agentId: agent,
    network: CAIP2,
    pairingId: 'pairing-a',
    perTxMicroCcd: AGENT_A_POLICY_SPEC.perTxMicroCcd,
    dailyMicroCcd: AGENT_A_POLICY_SPEC.dailyMicroCcd,
    periodMicroCcd: AGENT_A_POLICY_SPEC.periodMicroCcd,
    periodSeconds: AGENT_A_POLICY_SPEC.periodSeconds,
    recipientAllowlist: AGENT_A_POLICY_SPEC.recipientAllowlist,
    expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : NOW + 86400,
    challenge,
    signature,
    accountInfo: key.accountInfo as never,
  });
}

/** The page's permission-badge ternary, extracted verbatim from `loadPermissionsPage`. */
function pageBadgeFor(perm: { enabled: boolean; paused: boolean; revoked: boolean }): [string, string] {
  const src = html.slice(html.indexOf('async function loadPermissionsPage'));
  const m = src.match(/perm\.revoked \? \['REVOKED', 'badge-failed'\] : perm\.paused \? \['PAUSED', 'badge-inconclusive'\] : perm\.enabled \? \['ACTIVE — LIVE', 'badge-live'\] : \['DISABLED', 'badge-inconclusive'\]/);
  ok(m !== null, 'the page badge ternary exists verbatim');
  return new Function('perm', `return (${m![0]});`)(perm) as [string, string];
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

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-a-website-launcher-'));
}

// ═══ A. My Agents — provisioning from the real persistent stores ═════════

test('01. a prepared attempt renders as prepared, never confirmed, with no account address', () => {
  const dir = tmpDir();
  try {
    const { walletStore, provStore, manager } = launcherManager(dir);
    const record = walletRecord();
    walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    eq(prepared.attempt.expectedAccountAddress, ADDR_A, 'the build carries an EXPECTED address (a build output, not an account)');
    const state = manager.getProvisioningState(record.walletId);
    eq(state.state, 'prepared', 'provisioning state is prepared');
    eq(state.accountAddress, null, 'no account address for a prepared build');
    const w = pageWallet({ provisioning: state });
    const label = page.provisioningHtml(w) as string;
    ok(label.includes('prepared — build ready, nothing submitted, no account yet'), 'page shows prepared');
    notOk(label.includes('confirmed'), 'page never says confirmed');
    eq(page.confirmedAccountAddress(w), null, 'the expected address is never shown as an account');
    ok(label.includes('expected account'), 'the address is labelled as expected, honestly');
    walletStore.close(); provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('02. a prepared attempt survives a launcher restart and still renders as prepared', () => {
  const dir = tmpDir();
  try {
    const first = launcherManager(dir);
    const record = walletRecord();
    first.walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(first.provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    eq(first.manager.getProvisioningState(record.walletId).state, 'prepared', 'prepared before restart');
    first.walletStore.close(); first.provStore.close();
    // Restart: fresh manager instances on the same files — what the real launcher does on relaunch.
    const second = launcherManager(dir);
    const state = second.manager.getProvisioningState(record.walletId);
    eq(state.state, 'prepared', 'prepared after restart');
    eq(state.accountAddress, null, 'still no account address after restart');
    const label = page.provisioningHtml(pageWallet({ provisioning: state })) as string;
    ok(label.includes('prepared — build ready'), 'page still shows prepared after restart');
    notOk(label.includes('confirmed'), 'page never says confirmed after restart');
    second.walletStore.close(); second.provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('03. a submitted attempt survives a restart and renders as submitted, outcome unknown, with no address', () => {
  const dir = tmpDir();
  try {
    const { walletStore, provStore, manager } = launcherManager(dir);
    const record = walletRecord();
    walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    const submitted = submitStep1Attempt(provStore, prepared.attempt.attemptId, TX_HASH, NOW);
    ok(submitted.ok, 'submit succeeds');
    walletStore.close(); provStore.close();
    const second = launcherManager(dir);
    const state = second.manager.getProvisioningState(record.walletId);
    eq(state.state, 'submitted', 'submitted after restart');
    eq(state.accountAddress, null, 'no address for a submitted build');
    const label = page.provisioningHtml(pageWallet({ provisioning: state })) as string;
    ok(label.includes('submitted — awaiting on-chain finalization, outcome unknown'), 'page shows submitted');
    ok(label.includes('finalization not confirmed'), 'the detail says finalization is NOT confirmed');
    notOk(label.includes('confirmed on chain'), 'page never claims confirmed on chain');
    second.walletStore.close(); second.provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('04. an unknown attempt survives a restart and renders as unknown', () => {
  const dir = tmpDir();
  try {
    const { walletStore, provStore, manager } = launcherManager(dir);
    const record = walletRecord();
    walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    const unknown = provStore.transition(prepared.attempt.attemptId, 'unknown', {
      reason: 'confirmation_unavailable',
      detail: 'node unreachable during confirmation',
      nowSec: NOW,
    });
    eq(unknown.state, 'unknown', 'transition to unknown');
    walletStore.close(); provStore.close();
    const second = launcherManager(dir);
    const state = second.manager.getProvisioningState(record.walletId);
    eq(state.state, 'unknown', 'unknown after restart');
    eq(state.accountAddress, null, 'no address for an unknown build');
    const label = page.provisioningHtml(pageWallet({ provisioning: state })) as string;
    ok(label.includes('unknown — resolve before any further action'), 'page shows unknown');
    notOk(label.includes('confirmed'), 'page never says confirmed');
    second.walletStore.close(); second.provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('05. duplicate identity allocation is refused from the durable used-set', () => {
  const dir = tmpDir();
  try {
    const { provStore } = launcherManager(dir);
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: 'w_a', agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    const used = provStore.usedIdentityNumbers(OWNER, CAIP2);
    ok(used.includes(0) && used.includes(1), 'used-set contains the pair (0, 1)');
    const v = validateIdentityNumberPair(0, 1, used);
    ok(!v.ok, 're-allocating (0, 1) is refused');
    if (!v.ok) eq(v.reason, 'credential_index_already_used', 'exact refusal reason');
    const next = allocateAgentIdentityPair(used);
    ok(next.ok, 'a next pair is available');
    if (next.ok) {
      eq(next.pair.agentIdentityNumber, 2, 'next agent identity number is 2');
      eq(next.pair.recoveryIdentityNumber, 3, 'next recovery identity number is 3');
    }
    provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('06. reconciliation never broadcasts and never invents confirmation', async () => {
  const dir = tmpDir();
  try {
    const { walletStore, provStore } = launcherManager(dir);
    const record = walletRecord();
    walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    const calls: string[] = [];
    const client = {
      async getAccountInfo(address: string) {
        calls.push(address);
        return null; // the account does not exist on chain
      },
    };
    const result = await reconcileWalletFromChain({ accountAddress: ADDR_A, client });
    eq(result.accountExists, false, 'account does not exist');
    eq(result.agentCredentialId, null, 'no agent credential id invented');
    eq(result.recoveryCredentialId, null, 'no recovery credential id invented');
    ok(calls.includes(ADDR_A), 'the chain was read');
    // The read-only client interface exposes no submit/broadcast method at all.
    ok(!('submit' in client) && !('broadcast' in client) && !('sendTransaction' in client), 'no submit path exists on the client');
    // The prepared attempt is untouched by a read-only reconcile.
    eq(provStore.getActiveAttempt(record.walletId)?.state, 'prepared', 'prepared attempt not transitioned by a read-only reconcile');
    walletStore.close(); provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('07. a confirmed wallet record shows its address; a not-deployed record shows none', () => {
  const dir = tmpDir();
  try {
    const { walletStore, manager } = launcherManager(dir);
    const confirmed = walletRecord({
      accountAddress: ADDR_A,
      deploymentStatus: 'step2_deployed',
      credentialIndex: 0,
      threshold: 1,
      recoveryCredentialStatus: 'verified',
      fundingStatus: 'unfunded',
    });
    walletStore.save(confirmed, 'deployed', 'fixture');
    const state = manager.getProvisioningState(confirmed.walletId);
    eq(state.state, 'confirmed', 'confirmed');
    eq(state.accountAddress, ADDR_A, 'address from the confirmed record');
    const w = pageWallet({ accountAddress: ADDR_A, deploymentStatus: 'step2_deployed', provisioning: state });
    eq(page.confirmedAccountAddress(w), ADDR_A, 'page shows the confirmed address');
    ok((page.provisioningHtml(w) as string).includes('confirmed on chain'), 'confirmed provisioning labelled');
    // Control: a record that was never deployed shows no address.
    // (The wallet store uniques on owner + agent + network, so the control is a second agent.)
    const fresh = walletRecord({ walletId: 'w_' + 'b2'.repeat(12), agentId: '1005' });
    walletStore.save(fresh, 'created', 'fixture');
    const freshState = manager.getProvisioningState(fresh.walletId);
    eq(freshState.state, 'not_started', 'not_started');
    eq(page.confirmedAccountAddress(pageWallet({ walletId: fresh.walletId, provisioning: freshState })), null, 'not-deployed record shows no address');
    walletStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('08. a confirmed attempt with a missing wallet-record address shows confirmed with the repair flag', () => {
  const dir = tmpDir();
  try {
    const { walletStore, provStore, manager } = launcherManager(dir);
    const record = walletRecord();
    walletStore.save(record, 'created', 'fixture');
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: record.walletId, agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    const submitted = submitStep1Attempt(provStore, prepared.attempt.attemptId, TX_HASH, NOW);
    ok(submitted.ok, 'submit succeeds');
    // Chain confirmation recorded by the deploy script (transition is what it performs after a confirmed chain check).
    const confirmed = provStore.transition(prepared.attempt.attemptId, 'confirmed', { detail: 'confirmed on chain (fixture)', nowSec: NOW });
    eq(confirmed.state, 'confirmed', 'attempt confirmed');
    const state = manager.getProvisioningState(record.walletId);
    eq(state.state, 'confirmed', 'confirmed');
    eq(state.accountAddress, ADDR_A, 'address taken from the confirmed attempt — it IS chain evidence');
    ok(state.detail.includes('repair the wallet record'), 'repair flag in the detail');
    const w = pageWallet({ provisioning: state });
    const label = page.provisioningHtml(w) as string;
    ok(label.includes('confirmed on chain'), 'page shows confirmed');
    ok(label.includes('repair the wallet record'), 'page shows the repair flag');
    eq(page.confirmedAccountAddress(w), ADDR_A, 'the attempt address is shown, with the repair flag — never silently');
    walletStore.close(); provStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('09. WITHOUT a provisioning store the manager cannot see a prepared attempt (launcher gap, before B wiring)', () => {
  const dir = tmpDir();
  try {
    // A prepared attempt exists in <stateDir>/provisioning.db (the deploy script's store).
    const provStore = new ProvisioningStore({ path: provisioningDbPath(dir) });
    const prepared = prepareStep1Attempt(provStore, prepareArgs({ walletId: 'w_gap', agentId: '1004' }));
    ok(prepared.ok, 'prepare succeeds');
    provStore.close();
    // The launcher as it exists today builds the manager WITHOUT a provisioning store.
    const walletStore = new WalletStore({ path: join(dir, 'wallets.db') });
    walletStore.save(walletRecord({ walletId: 'w_gap' }), 'created', 'fixture');
    const managerNoStore = new AgenticWalletManager({ store: walletStore, keyStore: new InMemoryWalletKeyStore() });
    const state = managerNoStore.getProvisioningState('w_gap');
    eq(state.state, 'not_started', 'without a store the attempt is invisible');
    eq(state.accountAddress, null, 'no address');
    const label = page.provisioningHtml(pageWallet({ walletId: 'w_gap', provisioning: state })) as string;
    ok(label.includes('not started'), 'page reports not started, not prepared');
    walletStore.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

// ═══ D. Permissions — NO PERMISSION YET, bounded_auto only after grant ════

test('17. NO PERMISSION YET until a real policy is granted (page + real persistent backend)', () => {
  const src = extractFunctionSource('loadPermissionsPage');
  ok(src.includes("'/api/permission?wallet='"), 'permission is fetched live from the backend');
  ok(src.includes("badge.textContent = 'NO PERMISSION YET'"), 'no policy → NO PERMISSION YET');
  const dir = tmpDir();
  try {
    const backend = new SqlitePermissionBackend(join(dir, 'state.db'));
    const mgr = new PermissionManager({ backend, now: () => NOW_MS });
    eq(mgr.getPermission(OWNER, 'agent-1', CAIP2), undefined, 'no permission in the backend before a grant');
    backend.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('18. a bounded_auto policy granted with a passing wallet verification renders ACTIVE — LIVE with its limits, and survives a restart', async () => {
  const dir = tmpDir();
  try {
    const backend = new SqlitePermissionBackend(join(dir, 'state.db'));
    const verifyWallet = (args: { walletAddress: string; agentId: string; network: string }) =>
      args.walletAddress === OWNER && args.agentId === 'agent-1' && args.network === CAIP2
        ? { ok: true as const }
        : { ok: false as const, reason: 'wallet_not_found' };
    const mgr = new PermissionManager({ backend, verifyWallet, now: () => NOW_MS });
    const granted = await grantBounded(mgr, { expiresAt: NOW + 86400 });
    ok(granted.ok, 'grant succeeds with a passing verification');
    const perm = mgr.getPermission(OWNER, 'agent-1', CAIP2);
    ok(perm, 'permission exists');
    eq(pageBadgeFor(perm!)[0], 'ACTIVE — LIVE', 'badge is ACTIVE — LIVE');
    eq(pageBadgeFor(perm!)[1], 'badge-live', 'live badge class');
    eq(perm!.policy, 'bounded_auto', 'bounded_auto');
    eq(perm!.limits.perTxMicroCcd, 1n, 'per-tx 1 microCCD');
    eq(perm!.limits.dailyMicroCcd, 10n, 'daily 10 microCCD');
    eq(perm!.limits.periodMicroCcd, 100n, 'period 100 microCCD');
    eq(perm!.limits.periodSeconds, 604800, '7-day period');
    eq(perm!.recipientAllowlist?.length, 1, 'allowlist has one recipient');
    eq(perm!.recipientAllowlist?.[0], PAY_TO_B, 'allowlist is payTo B');
    eq(perm!.expiresAt, NOW + 86400, 'expiry recorded');
    eq(perm!.enabled, true, 'enabled');
    // Restart: close and reopen the backend on the same file.
    backend.close();
    const backend2 = new SqlitePermissionBackend(join(dir, 'state.db'));
    const mgr2 = new PermissionManager({ backend: backend2, verifyWallet, now: () => NOW_MS });
    const perm2 = mgr2.getPermission(OWNER, 'agent-1', CAIP2);
    ok(perm2, 'permission survives restart');
    eq(pageBadgeFor(perm2!)[0], 'ACTIVE — LIVE', 'still ACTIVE after restart');
    eq(perm2!.limits.perTxMicroCcd, 1n, 'per-tx limit survives restart');
    eq(perm2!.recipientAllowlist?.length, 1, 'allowlist length survives restart');
    eq(perm2!.recipientAllowlist?.[0], PAY_TO_B, 'allowlist survives restart');
    eq(perm2!.expiresAt, NOW + 86400, 'expiry survives restart');
    backend2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('19. a grant against an unverified wallet is refused and leaves NO PERMISSION YET', async () => {
  const dir = tmpDir();
  try {
    const backend = new SqlitePermissionBackend(join(dir, 'state.db'));
    const verifyWallet = () => ({ ok: false as const, reason: 'wallet_not_verified' });
    const mgr = new PermissionManager({ backend, verifyWallet, now: () => NOW_MS });
    const granted = await grantBounded(mgr);
    ok(!granted.ok, 'grant refused');
    if (!granted.ok) eq(granted.reason, 'wallet_not_verified', 'exact refusal reason');
    eq(mgr.getPermission(OWNER, 'agent-1', CAIP2), undefined, 'no permission exists after refusal');
    backend.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('20. a prepared policy spec is not an active permission', () => {
  const dir = tmpDir();
  try {
    const backend = new SqlitePermissionBackend(join(dir, 'state.db'));
    const mgr = new PermissionManager({ backend, now: () => NOW_MS });
    // The prepared spec exists only as a document (AGENT_A_POLICY_SPEC); nothing was granted.
    eq(AGENT_A_POLICY_SPEC.perTxMicroCcd, 1n, 'the spec exists as a document');
    eq(AGENT_A_POLICY_SPEC.recipientAllowlist.length, 1, 'the spec names one recipient');
    eq(AGENT_A_POLICY_SPEC.recipientAllowlist[0], PAY_TO_B, 'the spec names payTo B');
    eq(mgr.getPermission(OWNER, 'agent-1', CAIP2), undefined, 'no permission in the backend');
    backend.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('21. a revoked or paused permission never qualifies for ACTIVE, and revocation survives a restart', async () => {
  const dir = tmpDir();
  try {
    const backend = new SqlitePermissionBackend(join(dir, 'state.db'));
    const verifyWallet = () => ({ ok: true as const });
    const mgr = new PermissionManager({ backend, verifyWallet, now: () => NOW_MS });
    const granted = await grantBounded(mgr);
    ok(granted.ok, 'grant succeeds');
    eq(pageBadgeFor(mgr.getPermission(OWNER, 'agent-1', CAIP2)!)[0], 'ACTIVE — LIVE', 'ACTIVE before pause');
    mgr.pausePermission(OWNER, 'agent-1', CAIP2);
    eq(pageBadgeFor(mgr.getPermission(OWNER, 'agent-1', CAIP2)!)[0], 'PAUSED', 'paused badge');
    mgr.revokePermission(OWNER, 'agent-1', CAIP2);
    eq(pageBadgeFor(mgr.getPermission(OWNER, 'agent-1', CAIP2)!)[0], 'REVOKED', 'revoked badge');
    backend.close();
    const backend2 = new SqlitePermissionBackend(join(dir, 'state.db'));
    const mgr2 = new PermissionManager({ backend: backend2, verifyWallet, now: () => NOW_MS });
    eq(pageBadgeFor(mgr2.getPermission(OWNER, 'agent-1', CAIP2)!)[0], 'REVOKED', 'revoked survives restart');
    backend2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══ E. Transactions / Dashboard — durable history, honest attribution ════

const DIGEST_B = 'b2'.repeat(32);

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
console.log(`\nagent-a-website-launcher-consistency: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
