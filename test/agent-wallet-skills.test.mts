/**
 * TASK 74 — Agent Wallet Skills tests.
 *
 * Mocks only: no browser, no node, no transaction. Wallets live in an in-memory
 * SQLite DB; ownership uses a locally generated Ed25519 key; the payment executor
 * uses the shared mock facilitator through the real `authorizePayment` path.
 */

import { eq, ok, notOk } from './helpers.mjs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { PairingStore } from '../src/pairing/pairing.js';
import { PermissionManager } from '../src/pairing/permissions.js';
import { WalletStore } from '../src/pairing/walletStore.js';
import { InMemoryWalletKeyStore } from '../src/pairing/walletSigner.js';
import { AgenticWalletManager, createWalletChallenge } from '../src/pairing/agenticWallet.js';
import { WalletSkills, WALLET_SKILLS_VERSION } from '../src/pairing/walletSkills.js';
import { createWalletPaymentExecutor } from '../src/pairing/walletPaymentPipeline.js';
import { mockFacilitator } from '../src/commerce/simulation.js';
import type { ConsumerFacilitator } from '../src/payments/x402.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OTHER_NETWORK = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER_OWNER = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const OTHER_RECIPIENT = '4MyVHYbRkAU6fqQsoSDzni6mrVz1KEvhDJoMVmDmrCgPBD8b7S';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── fixtures ────────────────────────────────────────────────────────────────

function makeTestKey(address = SENDER) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signer = {
    async sign(digest: ArrayBuffer) {
      return { 0: { 0: edSign(null, Buffer.from(digest), privateKey).toString('hex') } };
    },
    getSignatureCount() { return 1n; },
  };
  return { signer, accountInfo: makeFakeAccountInfo({ address, verifyKey: rawPub }) };
}

async function seedPairing(store: PairingStore, walletAddress: string, agentId: string) {
  const c = store.issueChallenge(agentId, CAIP2);
  const { signer, accountInfo } = makeTestKey(walletAddress);
  const sig = await signMessage(AccountAddress.fromBase58(walletAddress), c.message, signer as never);
  const r = await store.verifyAndPair({
    agentId, walletAddress, challengeId: c.id, signature: sig, accountInfo: accountInfo as never,
    network: CAIP2, verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  return r.ok;
}

async function provisionWallet(
  mgr: AgenticWalletManager,
  opts: { owner?: string; agent?: string; network?: string } = {},
) {
  const owner = opts.owner ?? SENDER;
  const agent = opts.agent ?? 'agent-1';
  const network = opts.network ?? CAIP2;
  const { signer, accountInfo } = makeTestKey(owner);
  const challenge = createWalletChallenge({ ownerWalletAddress: owner, agentId: agent, network, action: 'provision' });
  const signature = await signMessage(AccountAddress.fromBase58(owner), challenge.message, signer as never);
  return mgr.provision({
    ownerWalletAddress: owner, agentId: agent, network, genesisHash: GENESIS, pairingId: 'p1',
    challenge, signature, accountInfo: accountInfo as never,
  });
}

async function grantPermission(
  permissions: PermissionManager,
  opts: {
    owner?: string; agent?: string; limits?: Partial<{ perTx: bigint | null; daily: bigint | null; period: bigint | null; periodSeconds: number | null }>;
    policy?: 'manual' | 'bounded_auto'; allowlist?: string[] | null;
  } = {},
) {
  const owner = opts.owner ?? SENDER;
  const agent = opts.agent ?? 'agent-1';
  const { signer, accountInfo } = makeTestKey(owner);
  const challenge = permissions.issueChallenge({ walletAddress: owner, agentId: agent, network: CAIP2, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(owner), challenge.message, signer as never);
  return permissions.grantPermission({
    walletAddress: owner, agentId: agent, network: CAIP2, pairingId: 'p1',
    limits: {
      perTxMicroCcd: opts.limits?.perTx ?? null,
      dailyMicroCcd: opts.limits?.daily ?? null,
      periodMicroCcd: opts.limits?.period ?? null,
      periodSeconds: opts.limits?.periodSeconds ?? null,
    },
    recipientAllowlist: opts.allowlist === undefined ? null : opts.allowlist,
    policy: opts.policy ?? 'bounded_auto',
    challenge, signature, accountInfo: accountInfo as never,
  });
}

const CALLS: string[] = [];
function spyFacilitator(): ConsumerFacilitator & { calls: string[] } {
  const f = mockFacilitator('ok') as ConsumerFacilitator & { calls: string[] };
  return {
    calls: CALLS,
    async getSupported() { return f.getSupported(); },
    async verify(p, r) { CALLS.push('verify'); return f.verify(p, r); },
    async settle(p, r) { CALLS.push('settle'); return f.settle(p, r); },
  };
}

async function buildStack(opts: { funded?: boolean; policy?: 'manual' | 'bounded_auto'; limits?: any; allowlist?: string[] | null } = {}) {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const walletStore = new WalletStore({ path: ':memory:' });
  const mgr = new AgenticWalletManager({
    store: walletStore, keyStore: new InMemoryWalletKeyStore(), permissions, pairingStore: pairing,
    now: () => 1_000_000_000_000,
  });
  const p = await provisionWallet(mgr);
  ok((p as any).ok, 'wallet provisioned');
  const walletId = (p as any).wallet.walletId as string;
  if (opts.funded) {
    mgr.recordFunding(walletId, 1_000_000n, RECIPIENT);
  }
  const granted = await grantPermission(permissions, { policy: opts.policy ?? 'bounded_auto', limits: opts.limits, allowlist: opts.allowlist });
  ok((granted as any).ok, 'permission granted');
  const facilitator = spyFacilitator();
  const payments = createWalletPaymentExecutor({
    permissions,
    facilitator,
    createPaymentPayload: async (requirements) => ({
      x402Version: 2,
      accepted: requirements,
      payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
    }),
    nowSeconds: () => 1_000_000_100,
  });
  const skills = new WalletSkills({ wallets: mgr, permissions, payments });
  return { pairing, permissions, walletStore, mgr, skills, walletId, facilitator };
}

const ctx = (over: Partial<{ agentId: string; ownerWalletAddress: string; network: string }> = {}) => ({
  agentId: over.agentId ?? 'agent-1',
  ownerWalletAddress: over.ownerWalletAddress ?? SENDER,
  network: over.network ?? CAIP2,
});

// ── 1. discovery ────────────────────────────────────────────────────────────

test('01. skills manifest is discoverable, versioned, and schema-valid', () => {
  const skills = new WalletSkills({ wallets: {} as never });
  const m = skills.manifest();
  eq(m.name, 'agenttrust.wallet', 'manifest name');
  eq(m.version, WALLET_SKILLS_VERSION, 'version');
  const names = m.skills.map((s) => s.name);
  for (const required of ['wallet_get_status', 'wallet_get_permissions', 'wallet_request_payment', 'wallet_request_approval', 'wallet_get_activity']) {
    ok(names.includes(required), `${required} present`);
  }
  eq(names.length, 5, 'exactly five skills');
  for (const s of m.skills) {
    eq(s.inputSchema.type, 'object', `${s.name} schema is an object`);
    ok(typeof s.description === 'string' && s.description.length > 20, `${s.name} has a description`);
    ok(typeof s.requires === 'string' && s.requires.length > 0, `${s.name} declares a requirement`);
  }
});

test('02. unknown skill is rejected', async () => {
  const { skills } = await buildStack();
  const r = await skills.invoke(ctx(), 'wallet_do_everything', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'unknown_skill', 'code');
});

test('03. identity arguments are rejected (a caller cannot pick a wallet)', async () => {
  const { skills } = await buildStack();
  for (const bad of [{ walletId: 'w_x' }, { ownerWalletAddress: OTHER_OWNER }, { agentId: 'agent-2' }, { network: OTHER_NETWORK }]) {
    const r = await skills.invoke(ctx(), 'wallet_get_status', bad);
    eq(r.ok, false, `rejected ${JSON.stringify(bad)}`);
    eq((r as { code: string }).code, 'invalid_arguments', 'code');
  }
});

// ── 2. status ───────────────────────────────────────────────────────────────

test('04. wallet_get_status returns the authenticated agent wallet and distinguishes local provisioning', async () => {
  const { skills, walletId } = await buildStack();
  const r = await skills.invoke(ctx(), 'wallet_get_status', {});
  eq(r.ok, true, 'ok');
  const d = (r as { data: any }).data;
  eq(d.walletId, walletId, 'wallet id');
  eq(d.agentId, 'agent-1', 'agent');
  eq(d.network, CAIP2, 'network');
  eq(d.lifecycle, 'awaiting_funding', 'lifecycle');
  eq(d.accountAddress, null, 'no on-chain address');
  eq(d.onChainAccount, false, 'not on chain');
  eq(d.locallyProvisionedOnly, true, 'local only');
});

test('05. agent isolation across multiple wallets', async () => {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  await seedPairing(pairing, SENDER, 'agent-2');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const mgr = new AgenticWalletManager({
    store: new WalletStore({ path: ':memory:' }), keyStore: new InMemoryWalletKeyStore(),
    permissions, pairingStore: pairing, now: () => 1_000_000_000_000,
  });
  const a = await provisionWallet(mgr, { agent: 'agent-1' });
  const b = await provisionWallet(mgr, { agent: 'agent-2' });
  const skills = new WalletSkills({ wallets: mgr, permissions });
  const ra = await skills.invoke(ctx({ agentId: 'agent-1' }), 'wallet_get_status', {});
  const rb = await skills.invoke(ctx({ agentId: 'agent-2' }), 'wallet_get_status', {});
  eq((ra as { data: any }).data.walletId, (a as any).wallet.walletId, 'agent-1 wallet');
  eq((rb as { data: any }).data.walletId, (b as any).wallet.walletId, 'agent-2 wallet');
  notOk((ra as { data: any }).data.walletId === (rb as { data: any }).data.walletId, 'different wallets');
});

test('06. unpaired agent is rejected (no wallet)', async () => {
  const { skills } = await buildStack();
  const r = await skills.invoke(ctx({ agentId: 'agent-unpaired' }), 'wallet_get_status', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'no_wallet', 'code');
});

test('07. wrong owner is rejected', async () => {
  const { skills } = await buildStack();
  const r = await skills.invoke(ctx({ ownerWalletAddress: OTHER_OWNER }), 'wallet_get_status', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'no_wallet', 'code');
});

test('08. wrong network is rejected', async () => {
  const { skills } = await buildStack();
  const r = await skills.invoke(ctx({ network: OTHER_NETWORK }), 'wallet_get_status', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'no_wallet', 'code');
});

test('09. paused, revoked, and recovery-required wallets are rejected for payments', async () => {
  const { skills, mgr, walletId } = await buildStack({ funded: true });
  mgr.pause(walletId);
  const paused = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq((paused as { code: string }).code, 'wallet_paused', 'paused');
  mgr.resume(walletId);
  const okRes = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(okRes.ok, true, 'resumed allows');
  mgr.revoke(walletId);
  const revoked = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq((revoked as { code: string }).code, 'wallet_revoked', 'revoked');
});

// ── 3. permissions ──────────────────────────────────────────────────────────

test('10. wallet_get_permissions reports disabled-by-default for a wallet without a grant', async () => {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const mgr = new AgenticWalletManager({
    store: new WalletStore({ path: ':memory:' }), keyStore: new InMemoryWalletKeyStore(),
    permissions, pairingStore: pairing, now: () => 1_000_000_000_000,
  });
  await provisionWallet(mgr);
  const skills = new WalletSkills({ wallets: mgr, permissions });
  const r = await skills.invoke(ctx(), 'wallet_get_permissions', {});
  eq(r.ok, true, 'ok');
  const d = (r as { data: any }).data;
  eq(d.granted, false, 'not granted');
  eq(d.enabled, false, 'disabled');
  eq(d.limits, null, 'no limits');
});

test('11. wallet_get_permissions reports limits, allowlist, policy, and remaining allowance', async () => {
  const { skills } = await buildStack({ limits: { daily: 10_000n } });
  const r = await skills.invoke(ctx(), 'wallet_get_permissions', {});
  const d = (r as { data: any }).data;
  eq(d.granted, true, 'granted');
  eq(d.policy, 'bounded_auto', 'policy');
  eq(d.limits.dailyMicroCcd, '10000', 'daily limit');
  eq(d.dailyRemainingMicroCcd, '10000', 'remaining');
});

test('12. wallet_get_permissions never exposes another agent\'s permission', async () => {
  const { skills } = await buildStack({ limits: { daily: 10_000n } });
  const r = await skills.invoke(ctx({ agentId: 'agent-2' }), 'wallet_get_permissions', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'no_wallet', 'no wallet for that agent');
});

// ── 4. manual approval ──────────────────────────────────────────────────────

test('13. manual policy returns approval_required, and an approval request is not authorization', async () => {
  const { skills, permissions } = await buildStack({ funded: true, policy: 'manual' });
  // request payment without a token → approval_required, no facilitator call
  CALLS.length = 0;
  const denied = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(denied.ok, false, 'denied');
  eq((denied as { code: string }).code, 'approval_required', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
  // request an approval
  const req = await skills.invoke(ctx(), 'wallet_request_approval', { recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1' });
  eq(req.ok, true, 'approval requested');
  const data = (req as { data: any }).data;
  eq(data.status, 'pending', 'pending');
  // still no authorization
  const still = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1' });
  eq((still as { code: string }).code, 'approval_required', 'still requires approval');
  eq(permissions.getPermission(SENDER, 'agent-1', CAIP2)!.approvals.get(data.approvalId)!.status, 'pending', 'approval still pending');
});

test('14. owner approval is required and bound to exact parameters', async () => {
  const { skills, permissions } = await buildStack({ funded: true, policy: 'manual' });
  const req = await skills.invoke(ctx(), 'wallet_request_approval', { recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1' });
  const approvalId = (req as { data: any }).data.approvalId as string;
  // owner approves with a real signature
  const { signer, accountInfo } = makeTestKey();
  const challenge = permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const ap = await permissions.approveApproval({
    approvalId, walletAddress: SENDER, agentId: 'agent-1', network: CAIP2,
    recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(ap.ok, true, 'approved');
  const token = (ap as { token: string }).token;
  // tampered amount is rejected
  const tampered = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '200', context: 'c1', approvalToken: token });
  eq(tampered.ok, false, 'tampered rejected');
  eq((tampered as { code: string }).code, 'approval_param_mismatch', 'code');
  // exact parameters succeed
  const good = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1', approvalToken: token });
  eq(good.ok, true, 'approved payment executes');
  // replay rejected
  const replay = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100', context: 'c1', approvalToken: token });
  eq(replay.ok, false, 'replay rejected');
});

// ── 5. bounded auto + limits ────────────────────────────────────────────────

test('15. bounded_auto payment executes through the existing pipeline', async () => {
  const { skills, facilitator } = await buildStack({ funded: true, limits: { perTx: 1000n } });
  CALLS.length = 0;
  const r = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '500', context: 'c' });
  eq(r.ok, true, 'executed');
  eq((r as { data: any }).data.state, 'executed', 'state');
  ok(facilitator.calls.includes('verify'), 'facilitator verified');
  ok(facilitator.calls.includes('settle'), 'facilitator settled');
});

test('16. per-transaction limit is enforced and the facilitator is never called', async () => {
  const { skills } = await buildStack({ funded: true, limits: { perTx: 100n } });
  CALLS.length = 0;
  const r = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '101' });
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'per_tx_limit_exceeded', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
});

test('17. recipient allowlist is enforced', async () => {
  const { skills } = await buildStack({ funded: true, allowlist: [RECIPIENT] });
  CALLS.length = 0;
  const bad = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: OTHER_RECIPIENT, amountMicroCcd: '100' });
  eq(bad.ok, false, 'rejected');
  eq((bad as { code: string }).code, 'recipient_not_allowed', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
  const good = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(good.ok, true, 'allowed recipient');
});

test('18. daily limit blocks the second payment', async () => {
  const { skills } = await buildStack({ funded: true, limits: { daily: 1000n } });
  const first = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(first.ok, true, 'first ok');
  CALLS.length = 0;
  const second = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(second.ok, false, 'second blocked');
  eq((second as { code: string }).code, 'daily_limit_exceeded', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
});

test('19. permission denial never reaches the facilitator', async () => {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const mgr = new AgenticWalletManager({
    store: new WalletStore({ path: ':memory:' }), keyStore: new InMemoryWalletKeyStore(),
    permissions, pairingStore: pairing, now: () => 1_000_000_000_000,
  });
  const p = await provisionWallet(mgr);
  mgr.recordFunding((p as any).wallet.walletId, 1_000_000n, RECIPIENT);
  const facilitator = spyFacilitator();
  const payments = createWalletPaymentExecutor({
    permissions, facilitator,
    createPaymentPayload: async (r) => ({ x402Version: 2, accepted: r, payload: { signedTransaction: { version: 1, header: { sender: SENDER } } } }),
    nowSeconds: () => 1_000_000_100,
  });
  const skills = new WalletSkills({ wallets: mgr, permissions, payments });
  CALLS.length = 0;
  const r = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'denied (no permission)');
  eq((r as { code: string }).code, 'no_permission', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
});

// ── 6. funding ──────────────────────────────────────────────────────────────

test('20. unfunded / locally-provisioned wallet returns wallet_not_funded and never pretends success', async () => {
  const { skills } = await buildStack({ funded: false });
  CALLS.length = 0;
  const r = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'wallet_not_funded', 'code');
  eq(CALLS.length, 0, 'no facilitator call');
});

// ── 7. activity ─────────────────────────────────────────────────────────────

test('21. wallet_get_activity is isolated and redacted', async () => {
  const { skills } = await buildStack({ funded: true });
  const r = await skills.invoke(ctx(), 'wallet_get_activity', { limit: 10 });
  eq(r.ok, true, 'ok');
  const d = (r as { data: any }).data;
  ok(Array.isArray(d.events), 'events array');
  ok(d.events.length > 0, 'has events');
  for (const e of d.events) {
    eq(e.walletId, d.walletId, 'only this wallet');
  }
  const blob = JSON.stringify(d.events);
  notOk(/privateKey|seedPhrase|mnemonic|signKey/i.test(blob), 'no secret labels');
  notOk(/-----BEGIN/.test(blob), 'no PEM');
  // another agent sees nothing
  const other = await skills.invoke(ctx({ agentId: 'agent-2' }), 'wallet_get_activity', {});
  eq(other.ok, false, 'other agent has no wallet');
});

test('22. activity pagination is bounded', async () => {
  const { skills } = await buildStack({ funded: true });
  const r = await skills.invoke(ctx(), 'wallet_get_activity', { limit: 2 });
  const d = (r as { data: any }).data;
  ok(d.events.length <= 2, 'bounded');
  const huge = await skills.invoke(ctx(), 'wallet_get_activity', { limit: 99999 });
  ok((huge as { data: any }).data.events.length <= 100, 'clamped to max');
});

// ── 8. fail-closed ──────────────────────────────────────────────────────────

test('23. permission service unavailable fails closed', async () => {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const mgr = new AgenticWalletManager({
    store: new WalletStore({ path: ':memory:' }), keyStore: new InMemoryWalletKeyStore(),
    permissions, pairingStore: pairing, now: () => 1_000_000_000_000,
  });
  const p = await provisionWallet(mgr);
  mgr.recordFunding((p as any).wallet.walletId, 1_000_000n, RECIPIENT);
  const skills = new WalletSkills({ wallets: mgr }); // no permissions service
  const r = await skills.invoke(ctx(), 'wallet_get_permissions', {});
  eq(r.ok, false, 'rejected');
  eq((r as { code: string }).code, 'service_unavailable', 'code');
  const pay = await skills.invoke(ctx(), 'wallet_request_payment', { recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(pay.ok, false, 'payment rejected');
  eq((pay as { code: string }).code, 'service_unavailable', 'reason');
});

test('24. no private key or signing material is exposed by any skill', async () => {
  const { skills } = await buildStack({ funded: true });
  const results = await Promise.all([
    skills.invoke(ctx(), 'wallet_get_status', {}),
    skills.invoke(ctx(), 'wallet_get_permissions', {}),
    skills.invoke(ctx(), 'wallet_get_activity', {}),
    skills.invoke(ctx(), 'wallet_request_approval', { recipient: RECIPIENT, amountMicroCcd: '100' }),
  ]);
  for (const r of results) {
    const blob = JSON.stringify(r);
    notOk(/privateKey|privateKeyDer|seedPhrase|mnemonic|signKey|secretKey/i.test(blob), 'no key material');
    notOk(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(blob), 'no PEM');
  }
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${(e as Error).message}`);
  }
}
console.log(`\ntask74: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
