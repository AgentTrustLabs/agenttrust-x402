/**
 * TASK 75 — Agent Wallet x402 integration tests.
 *
 * Mocks only: no browser, no node, no real transaction. The provider's chain
 * verifier is a fake that returns a finalized transfer for the mock facilitator's
 * simulated transaction hash. Replay protection is the real `ReplayStore`.
 *
 * Two executors are in play, both from existing code:
 *   - `createWalletPaymentExecutor` (TASK74) backs `wallet_request_payment`.
 *   - `createProviderPaymentExecutor` (TASK75) binds a payment to the provider's
 *     exact requirement and is what the x402 client uses.
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
import { WalletSkills } from '../src/pairing/walletSkills.js';
import { createWalletPaymentExecutor } from '../src/pairing/walletPaymentPipeline.js';
import { createProviderPaymentExecutor, parseProviderChallenge, AgentWalletX402Client } from '../src/pairing/walletX402Client.js';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { mockFacilitator } from '../src/commerce/simulation.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER_OWNER = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const OTHER_RECIPIENT = '4MyVHYbRkAU6fqQsoSDzni6mrVz1KEvhDJoMVmDmrCgPBD8b7S';
const RESOURCE_URL = 'https://example.com/protected';
const AMOUNT = '500';

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
  return (await store.verifyAndPair({
    agentId, walletAddress, challengeId: c.id, signature: sig, accountInfo: accountInfo as never,
    network: CAIP2, verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  })).ok;
}

async function provisionWallet(mgr: AgenticWalletManager, owner = SENDER, agent = 'agent-1') {
  const { signer, accountInfo } = makeTestKey(owner);
  const challenge = createWalletChallenge({ ownerWalletAddress: owner, agentId: agent, network: CAIP2, action: 'provision' });
  const signature = await signMessage(AccountAddress.fromBase58(owner), challenge.message, signer as never);
  return mgr.provision({
    ownerWalletAddress: owner, agentId: agent, network: CAIP2, genesisHash: GENESIS, pairingId: 'p1',
    challenge, signature, accountInfo: accountInfo as never,
  });
}

async function grantPermission(
  permissions: PermissionManager,
  opts: { policy?: 'manual' | 'bounded_auto'; perTx?: bigint | null } = {},
) {
  const { signer, accountInfo } = makeTestKey();
  const challenge = permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  return permissions.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: { perTxMicroCcd: opts.perTx ?? null, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null },
    recipientAllowlist: null, policy: opts.policy ?? 'bounded_auto',
    challenge, signature, accountInfo: accountInfo as never,
  });
}

const simulatedHash = (requirements: { payTo: string; amount: string; asset: string }) => {
  let h = 0n;
  for (const ch of `simulated:${requirements.payTo}:${requirements.amount}:${requirements.asset}`) {
    h = (h * 131n + BigInt(ch.codePointAt(0)!)) % (1n << 256n);
  }
  return h.toString(16).padStart(64, '0');
};

interface StackOpts {
  policy?: 'manual' | 'bounded_auto';
  funded?: boolean;
  perTx?: bigint | null;
  noPermission?: boolean;
}

async function buildStack(opts: StackOpts = {}) {
  const pairing = new PairingStore({ now: () => 1_000_000_000_000 });
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const mgr = new AgenticWalletManager({
    store: new WalletStore({ path: ':memory:' }), keyStore: new InMemoryWalletKeyStore(),
    permissions, pairingStore: pairing, now: () => 1_000_000_000_000,
  });
  const p = await provisionWallet(mgr);
  const walletId = (p as any).wallet.walletId as string;
  if (opts.funded !== false) mgr.recordFunding(walletId, 1_000_000n, RECIPIENT);
  if (!opts.noPermission) await grantPermission(permissions, { policy: opts.policy ?? 'bounded_auto', perTx: opts.perTx ?? null });

  const requirements = buildPaymentRequirements({
    payTo: RECIPIENT, amountMicroCcd: AMOUNT, resourceUrl: RESOURCE_URL,
    network: CAIP2, maxTimeoutSeconds: 60,
  });
  const txHash = simulatedHash(requirements);
  const mkChain = (summary: Record<string, unknown>) => ({
    async readTransfer(_h: string) { return summary as never; },
  });
  const goodChain = mkChain({ status: 'finalized', sender: SENDER, sponsor: RECIPIENT, recipient: RECIPIENT, amount: AMOUNT, network: CAIP2, blockHash: 'bb'.repeat(32) });

  const facilitator = mockFacilitator('ok');
  const replay = new ReplayStore();
  const provider = createX402Provider(
    { requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED-CONTENT', url: RESOURCE_URL }, now: () => 1_000_000_000_000 },
    { facilitator, chain: goodChain },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: replay },
  );

  // The wallet executor expects a complete x402 payload; the provider executor
  // wraps its factory output inside `payload`, so it needs the inner body only.
  const providerPayload = async (_reqs: unknown) => ({
    signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } },
  });
  const walletPayload = async (reqs: unknown) => ({
    x402Version: 2, accepted: reqs,
    payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
  });

  const providerExecutor = createProviderPaymentExecutor({
    permissions, facilitator,
    createPaymentPayload: providerPayload as never,
    nowSeconds: () => 1_000_000_100,
  });
  const walletExecutor = createWalletPaymentExecutor({
    permissions, facilitator,
    createPaymentPayload: walletPayload as never,
    nowSeconds: () => 1_000_000_100,
  });
  const skills = new WalletSkills({ wallets: mgr, permissions, payments: walletExecutor });
  const client = new AgentWalletX402Client({ skills, executor: providerExecutor, requestIdFactory: () => 'req-1' });

  return { pairing, permissions, mgr, skills, client, provider, replay, facilitator, txHash, requirements, mkChain };
}

const ctx = () => ({ agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2 });
const bodyOf = (o: unknown) => (o as { body: Record<string, unknown> }).body;

// ── 1. parsing + 402 ────────────────────────────────────────────────────────

test('01. provider challenge parses into requirement + resource binding', async () => {
  const s = await buildStack();
  const parsed = parseProviderChallenge(s.provider.challenge());
  ok(parsed !== null, 'parsed');
  eq(parsed!.resourceUrl, RESOURCE_URL, 'resource url');
  eq(parsed!.requirements.payTo, RECIPIENT, 'payTo');
  eq(parsed!.requirements.amount, AMOUNT, 'amount');
  eq(parsed!.requirements.network, CAIP2, 'network');
});

test('02. malformed challenge is rejected', () => {
  eq(parseProviderChallenge(null), null, 'null');
  eq(parseProviderChallenge({}), null, 'empty');
  eq(parseProviderChallenge({ x402Version: 1 }), null, 'wrong version');
  eq(parseProviderChallenge({ x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [] }), null, 'empty accepts');
  eq(parseProviderChallenge({ x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [{ scheme: 'nope' }] }), null, 'bad scheme');
});

test('03. provider returns HTTP 402 with a valid requirement', async () => {
  const s = await buildStack();
  const outcome = s.provider.handleUnpaid();
  eq(outcome.status, 402, '402');
  ok(parseProviderChallenge(outcome.body) !== null, 'parseable');
});

// ── 2. valid flows ──────────────────────────────────────────────────────────

test('04. valid bounded-auto flow returns the protected resource', async () => {
  const s = await buildStack();
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 200, '200');
  eq((bodyOf(outcome).resource as { body: string }).body, 'PROTECTED-CONTENT', 'resource returned');
  eq((outcome as { transaction: string }).transaction, s.txHash, 'tx hash');
});

test('05. manual approval-required flow returns approval_required', async () => {
  const s = await buildStack({ policy: 'manual' });
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 402, '402');
  eq(bodyOf(outcome).error, 'approval_required', 'approval required');
});

test('06. owner approval then payment succeeds', async () => {
  const s = await buildStack({ policy: 'manual' });
  const req = await s.skills.invoke(ctx(), 'wallet_request_approval', { recipient: RECIPIENT, amountMicroCcd: AMOUNT, context: 'c1' });
  eq(req.ok, true, 'approval requested');
  const approvalId = (req as { data: { approvalId: string } }).data.approvalId;

  const { signer, accountInfo } = makeTestKey();
  const challenge = s.permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const ap = await s.permissions.approveApproval({
    approvalId, walletAddress: SENDER, agentId: 'agent-1', network: CAIP2,
    recipient: RECIPIENT, amountMicroCcd: AMOUNT, context: 'c1', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(ap.ok, true, 'approved');
  const token = (ap as { token: string }).token;

  const pay = await s.skills.invoke(ctx(), 'wallet_request_payment', {
    recipient: RECIPIENT, amountMicroCcd: AMOUNT, context: 'c1', approvalToken: token,
  });
  eq(pay.ok, true, 'payment executed through the wallet executor');

  // provider verifies the same bound payload independently
  const parsed = parseProviderChallenge(s.provider.challenge())!;
  const payload = {
    x402Version: 2, accepted: parsed.requirements,
    payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
    resource: { url: parsed.resourceUrl }, requestId: 'req-manual',
  };
  const outcome = await s.provider.handlePayment(JSON.stringify(payload));
  eq(outcome.status, 200, 'provider 200 after independent verification');
});

// ── 3. binding / tampering ──────────────────────────────────────────────────

test('07. approval parameter tampering is rejected', async () => {
  const s = await buildStack({ policy: 'manual' });
  const req = await s.skills.invoke(ctx(), 'wallet_request_approval', { recipient: RECIPIENT, amountMicroCcd: AMOUNT, context: 'c1' });
  const approvalId = (req as { data: { approvalId: string } }).data.approvalId;

  const { signer, accountInfo } = makeTestKey();
  const challenge = s.permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const ap = await s.permissions.approveApproval({
    approvalId, walletAddress: SENDER, agentId: 'agent-1', network: CAIP2,
    recipient: RECIPIENT, amountMicroCcd: AMOUNT, context: 'c1', challenge, signature, accountInfo: accountInfo as never,
  });
  const token = (ap as { token: string }).token;

  const tampered = await s.skills.invoke(ctx(), 'wallet_request_payment', {
    recipient: RECIPIENT, amountMicroCcd: '999', context: 'c1', approvalToken: token,
  });
  eq(tampered.ok, false, 'tampered rejected');
  eq((tampered as { code: string }).code, 'approval_param_mismatch', 'code');
});

test('08. wrong recipient / amount / resource binding is rejected by the provider', async () => {
  const s = await buildStack();
  const parsed = parseProviderChallenge(s.provider.challenge())!;

  const badRecipient = {
    x402Version: 2, accepted: { ...parsed.requirements, payTo: OTHER_RECIPIENT },
    payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
    resource: { url: parsed.resourceUrl }, requestId: 'req-x',
  };
  const r1 = await s.provider.handlePayment(JSON.stringify(badRecipient));
  eq(r1.status, 402, 'wrong recipient rejected');

  const badResource = {
    x402Version: 2, accepted: parsed.requirements,
    payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
    resource: { url: 'https://evil.example.com/x' }, requestId: 'req-y',
  };
  const r2 = await s.provider.handlePayment(JSON.stringify(badResource));
  eq(r2.status, 400, 'binding rejected');
  eq((r2 as { reason: string }).reason, 'binding', 'reason');
});

test('09. wrong wallet / agent / owner / network is rejected', async () => {
  const s = await buildStack();
  const r1 = await s.client.requestAccess(s.provider, { agentId: 'agent-2', ownerWalletAddress: SENDER, network: CAIP2 });
  eq(r1.status, 402, 'no wallet for agent-2');
  const r2 = await s.client.requestAccess(s.provider, { agentId: 'agent-1', ownerWalletAddress: OTHER_OWNER, network: CAIP2 });
  eq(r2.status, 402, 'no wallet for other owner');
  // and the skill layer refuses the same contexts outright
  const s1 = await s.skills.invoke({ agentId: 'agent-2', ownerWalletAddress: SENDER, network: CAIP2 }, 'wallet_get_status', {});
  eq((s1 as { code: string }).code, 'no_wallet', 'skill no_wallet');
});

// ── 4. unfunded / inactive ──────────────────────────────────────────────────

test('10. unfunded (locally provisioned only) wallet is rejected', async () => {
  const s = await buildStack({ funded: false });
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 402, '402');
  eq(bodyOf(outcome).error, 'wallet_not_funded', 'code');
  eq(bodyOf(outcome).onChainAccount, false, 'on-chain flag');
});

// ── 5. permissions ──────────────────────────────────────────────────────────

test('11. disabled permissions reject and never call the facilitator', async () => {
  const s = await buildStack({ noPermission: true });
  const before = s.facilitator.calls.length;
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 402, '402');
  eq(bodyOf(outcome).error, 'no_permission', 'code');
  eq(s.facilitator.calls.length, before, 'no facilitator call');
});

test('12. revoked permission rejects and never reaches the facilitator', async () => {
  const s = await buildStack();
  s.permissions.revokePermission(SENDER, 'agent-1', CAIP2);
  const before = s.facilitator.calls.length;
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 402, '402');
  eq(bodyOf(outcome).error, 'permission_revoked', 'code');
  eq(s.facilitator.calls.length, before, 'no facilitator call');
});

test('13. spending-limit rejection never reaches the facilitator', async () => {
  const s = await buildStack({ perTx: 100n });
  const before = s.facilitator.calls.length;
  const outcome = await s.client.requestAccess(s.provider, ctx());
  eq(outcome.status, 402, '402');
  eq(bodyOf(outcome).error, 'per_tx_limit_exceeded', 'code');
  eq(s.facilitator.calls.length, before, 'no facilitator call');
});

// ── 6. replay ────────────────────────────────────────────────────────────────

const proofPayload = (requirements: unknown, url: string, requestId: string) => JSON.stringify({
  x402Version: 2, accepted: requirements,
  payload: { signedTransaction: { version: 1, header: { sender: SENDER, expiry: 1_000_000_500 } } },
  resource: { url }, requestId,
});

test('14. replay against the same request is refused', async () => {
  const s = await buildStack();
  const first = await s.client.requestAccess(s.provider, ctx());
  eq(first.status, 200, 'first 200');
  const parsed = parseProviderChallenge(s.provider.challenge())!;
  const replay = await s.provider.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-1'));
  eq(replay.status, 409, 'replay refused');
  eq((replay as { reason: string }).reason, 'replay', 'reason');
});

test('15. replay of the same transaction against a different request is refused', async () => {
  const s = await buildStack();
  await s.client.requestAccess(s.provider, ctx());
  const parsed = parseProviderChallenge(s.provider.challenge())!;
  const replay = await s.provider.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-other'));
  eq(replay.status, 409, 'same tx hash, different request refused');
});

test('16. concurrent duplicate payments: exactly one unlocks the resource', async () => {
  const s = await buildStack();
  const parsed = parseProviderChallenge(s.provider.challenge())!;
  const p = proofPayload(parsed.requirements, parsed.resourceUrl, 'req-concurrent');
  const [a, b] = await Promise.all([
    s.provider.handlePayment(p),
    s.provider.handlePayment(p),
  ]);
  const success = [a.status, b.status].filter((x) => x === 200).length;
  eq(success, 1, 'exactly one success');
  const others = [a.status, b.status].filter((x) => x !== 200);
  eq(others.length, 1, 'one rejected');
  eq(others[0], 409, 'rejected as replay');
});

// ── 7. provider verification ────────────────────────────────────────────────

test('17. finalized but failed transaction is rejected', async () => {
  const s = await buildStack();
  const badProvider = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('ok'), chain: s.mkChain({ status: 'finalized', failed: true, recipient: RECIPIENT, amount: AMOUNT, network: CAIP2 }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const parsed = parseProviderChallenge(badProvider.challenge())!;
  const outcome = await badProvider.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-bad'));
  eq(outcome.status, 402, 'rejected');
  eq((outcome as { reason: string }).reason, 'chain_mismatch', 'reason');
  notOk('resource' in bodyOf(outcome), 'no resource released');
});

test('18. unfinalized transaction is rejected', async () => {
  const s = await buildStack();
  const pendingProvider = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('ok'), chain: s.mkChain({ status: 'pending', recipient: RECIPIENT, amount: AMOUNT, network: CAIP2 }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const parsed = parseProviderChallenge(pendingProvider.challenge())!;
  const outcome = await pendingProvider.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-pending'));
  eq(outcome.status, 402, 'not finalized');
  eq((outcome as { reason: string }).reason, 'not_finalized', 'reason');
});

test('19. on-chain amount / recipient mismatch is rejected', async () => {
  const s = await buildStack();
  const wrongAmount = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('ok'), chain: s.mkChain({ status: 'finalized', recipient: RECIPIENT, amount: '999', network: CAIP2 }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const parsed = parseProviderChallenge(wrongAmount.challenge())!;
  const r1 = await wrongAmount.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-amt'));
  eq(r1.status, 402, 'amount mismatch');
  eq((r1 as { reason: string }).reason, 'chain_mismatch', 'reason');

  const wrongRecipient = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('ok'), chain: s.mkChain({ status: 'finalized', recipient: OTHER_RECIPIENT, amount: AMOUNT, network: CAIP2 }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const p2 = parseProviderChallenge(wrongRecipient.challenge())!;
  const r2 = await wrongRecipient.handlePayment(proofPayload(p2.requirements, p2.resourceUrl, 'req-rcpt'));
  eq(r2.status, 402, 'recipient mismatch');
});

test('20. chain unavailable fails closed with 503 and releases nothing', async () => {
  const s = await buildStack();
  const unavailable = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('ok'), chain: s.mkChain({ status: 'unavailable' }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const parsed = parseProviderChallenge(unavailable.challenge())!;
  const outcome = await unavailable.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-unavail'));
  eq(outcome.status, 503, 'unavailable');
  eq((outcome as { reason: string }).reason, 'verification_unavailable', 'reason');
  notOk('resource' in bodyOf(outcome), 'no resource');
});

test('21. ambiguous settlement does not unlock the resource', async () => {
  const s = await buildStack();
  // facilitator reports success but returns no hash → provider refuses to release
  const noHash = createX402Provider(
    { requirements: s.requirements, resourceUrl: RESOURCE_URL, resource: { body: 'PROTECTED' }, now: () => 1_000_000_000_000 },
    { facilitator: mockFacilitator('settle-nohash'), chain: s.mkChain({ status: 'finalized', recipient: RECIPIENT, amount: AMOUNT, network: CAIP2 }) },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const parsed = parseProviderChallenge(noHash.challenge())!;
  const outcome = await noHash.handlePayment(proofPayload(parsed.requirements, parsed.resourceUrl, 'req-nohash'));
  eq(outcome.status, 402, 'not released');
  eq((outcome as { reason: string }).reason, 'settle', 'reason');
  notOk('resource' in bodyOf(outcome), 'no resource');
});

// ── 8. resource release boundary ───────────────────────────────────────────

test('22. protected resource is never present on a non-200 outcome', async () => {
  const s = await buildStack({ funded: false });
  const failed = await s.client.requestAccess(s.provider, ctx());
  notOk(failed.status === 200, 'not 200');
  notOk('resource' in bodyOf(failed), 'no resource on failure');

  const s2 = await buildStack();
  const success = await s2.client.requestAccess(s2.provider, ctx());
  eq(success.status, 200, '200 on success');
  eq((bodyOf(success).resource as { body: string }).body, 'PROTECTED-CONTENT', 'has resource');
});

// ── 9. no leakage ──────────────────────────────────────────────────────────

test('23. no private key or signing material in any outcome or skill result', async () => {
  const s = await buildStack();
  const outcome = await s.client.requestAccess(s.provider, ctx());
  const status = await s.skills.invoke(ctx(), 'wallet_get_status', {});
  const perms = await s.skills.invoke(ctx(), 'wallet_get_permissions', {});
  for (const blob of [JSON.stringify(outcome), JSON.stringify(status), JSON.stringify(perms)]) {
    notOk(/privateKey|privateKeyDer|seedPhrase|mnemonic|signKey|-----BEGIN/i.test(blob), 'no key material');
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
console.log(`\ntask75: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
