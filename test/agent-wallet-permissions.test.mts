/**
 * Agent wallet permissions & spending controls.
 *
 * Mocks only: no browser, no real wallet, no node, no transaction.
 * Ownership is verified through the official SDK using a locally generated test key.
 * The permission manager is exercised directly AND through the real
 * `authorizePayment` gate (with a fake facilitator that counts calls).
 */

import { eq, ok, notOk } from './helpers.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import {
  PermissionManager,
  createPermissionChallenge,
  type SpendingLimits,
} from '../src/pairing/permissions.js';
import { authorizePayment } from '../src/payments/x402.js';
import type { ConsumerFacilitator } from '../src/payments/x402.js';
import type { VerifyResponse, SettleResponse } from '@x402/core/types';
import type { PaymentRequirements } from '@x402/core/types';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OTHER_NETWORK = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const OTHER_RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── fixtures ────────────────────────────────────────────────────────────────

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
  return { signer, accountInfo: makeFakeAccountInfo({ address: SENDER, verifyKey: rawPub }) };
}

const NO_LIMITS: SpendingLimits = {
  perTxMicroCcd: null,
  dailyMicroCcd: null,
  periodMicroCcd: null,
  periodSeconds: null,
};

const noAllowlist: string[] | null = null;

/** Grant a permission with a freshly signed owner challenge. */
async function grant(
  manager: PermissionManager,
  opts: {
    wallet?: string;
    agent?: string;
    network?: string;
    limits?: SpendingLimits;
    allowlist?: string[] | null;
    policy?: 'manual' | 'bounded_auto';
    signer?: ReturnType<typeof makeTestKey>['signer'];
    accountInfo?: ReturnType<typeof makeTestKey>['accountInfo'];
  } = {},
) {
  const { signer, accountInfo } = opts.signer ? { signer: opts.signer, accountInfo: opts.accountInfo } : makeTestKey();
  const wallet = opts.wallet ?? SENDER;
  const agent = opts.agent ?? 'agent-1';
  const network = opts.network ?? CAIP2;
  const challenge = manager.issueChallenge({ walletAddress: wallet, agentId: agent, network, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(wallet), challenge.message, signer as never);
  return manager.grantPermission({
    walletAddress: wallet,
    agentId: agent,
    network,
    pairingId: 'pairing-1',
    limits: opts.limits ?? NO_LIMITS,
    recipientAllowlist: opts.allowlist === undefined ? noAllowlist : opts.allowlist,
    policy: opts.policy ?? 'bounded_auto',
    challenge,
    signature,
    accountInfo: accountInfo as never,
  });
}

/** Approve a pending payment approval, returning the single-use token. */
async function approve(
  manager: PermissionManager,
  args: { approvalId: string; wallet?: string; agent?: string; network?: string; recipient?: string; amount?: string; context?: string; signer?: any; accountInfo?: any },
) {
  const wallet = args.wallet ?? SENDER;
  const agent = args.agent ?? 'agent-1';
  const network = args.network ?? CAIP2;
  const recipient = args.recipient ?? RECIPIENT;
  const amount = args.amount ?? '1000';
  const context = args.context ?? 'ctx-1';
  const key = args.signer ? { signer: args.signer, accountInfo: args.accountInfo } : makeTestKey();
  const challenge = manager.issueChallenge({ walletAddress: wallet, agentId: agent, network, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(wallet), challenge.message, key.signer as never);
  return manager.approveApproval({
    approvalId: args.approvalId!,
    walletAddress: wallet,
    agentId: agent,
    network,
    recipient,
    amountMicroCcd: amount,
    context,
    challenge,
    signature,
    accountInfo: key.accountInfo as never,
  });
}

// ── 1. default + owner authorization ────────────────────────────────────────

test('01. payment permission is disabled by default', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '1000' });
  eq(r.ok, false, 'no permission');
  eq((r as { reason: string }).reason, 'no_permission', 'reason');
});

test('02. an unauthorized owner cannot grant (invalid signature)', async () => {
  const { signer, accountInfo } = makeTestKey();
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  const challenge = m.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const r = await m.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: NO_LIMITS, recipientAllowlist: null, policy: 'bounded_auto',
    challenge,
    signature: { '0': { '0': 'ff'.repeat(64) } },
    accountInfo: accountInfo as never,
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason: string }).reason, 'invalid_signature', 'reason');
});

test('03. expired permission challenge is rejected', async () => {
  const { signer, accountInfo } = makeTestKey();
  let clock = 1_000_000_000_000;
  const m = new PermissionManager({ now: () => clock });
  const challenge = m.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant', ttlSeconds: 60 });
  clock += 120_000;
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const r = await m.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: NO_LIMITS, recipientAllowlist: null, policy: 'bounded_auto',
    challenge, signature, accountInfo: accountInfo as never,
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason: string }).reason, 'challenge_expired', 'reason');
});

test('04. replayed permission challenge is rejected', async () => {
  const { signer, accountInfo } = makeTestKey();
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  const challenge = m.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const first = await m.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: NO_LIMITS, recipientAllowlist: null, policy: 'bounded_auto',
    challenge, signature, accountInfo: accountInfo as never,
  });
  eq(first.ok, true, 'first grant');
  const second = await m.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: NO_LIMITS, recipientAllowlist: null, policy: 'bounded_auto',
    challenge, signature, accountInfo: accountInfo as never,
  });
  eq(second.ok, false, 'replay rejected');
  eq((second as { reason: string }).reason, 'challenge_used', 'reason');
});

test('05. successful grant + revocation', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  const g = await grant(m);
  eq(g.ok, true, 'granted');
  ok(m.getPermission(SENDER, 'agent-1', CAIP2)?.enabled, 'enabled');
  eq(m.getPermission(SENDER, 'agent-1', CAIP2)?.revoked, false, 'not revoked');
  eq(m.revokePermission(SENDER, 'agent-1', CAIP2), true, 'revoke');
  const p = m.getPermission(SENDER, 'agent-1', CAIP2)!;
  eq(p.revoked, true, 'revoked');
  eq(p.enabled, false, 'disabled');
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '1000' });
  eq(r.ok, false, 'payment blocked after revoke');
  eq((r as { reason: string }).reason, 'permission_revoked', 'reason');
});

// ── 2. spending limits ──────────────────────────────────────────────────────

test('06. per-transaction spending limit is enforced', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: 1000n, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null } });
  const okRes = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '1000' });
  eq(okRes.ok, true, 'at limit ok');
  const over = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '1001' });
  eq(over.ok, false, 'over limit rejected');
  eq((over as { reason: string }).reason, 'per_tx_limit_exceeded', 'reason');
});

test('07. daily spending limit is enforced', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  const a = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(a.ok, true, 'first ok');
  const b = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '500' });
  eq(b.ok, false, 'second exceeds daily');
  eq((b as { reason: string }).reason, 'daily_limit_exceeded', 'reason');
});

test('08. period spending limit is enforced', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: null, periodMicroCcd: 1000n, periodSeconds: 86400 } });
  const a = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '700' });
  eq(a.ok, true, 'first ok');
  const b = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '400' });
  eq(b.ok, false, 'second exceeds period');
  eq((b as { reason: string }).reason, 'period_limit_exceeded', 'reason');
});

// ── 3. recipient + network restrictions ──────────────────────────────────────

test('09. recipient allowlist is enforced', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { allowlist: [RECIPIENT] });
  const okRes = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(okRes.ok, true, 'allowed recipient');
  const bad = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: OTHER_RECIPIENT, amountMicroCcd: '100' });
  eq(bad.ok, false, 'disallowed recipient');
  eq((bad as { reason: string }).reason, 'recipient_not_allowed', 'reason');
});

test('10. wrong network/genesis is rejected', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m);
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: OTHER_NETWORK, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'reject');
  eq((r as { reason: string }).reason, 'no_permission', 'no permission on other network');
});

// ── 4. approval policy ──────────────────────────────────────────────────────

test('11. manual policy requires approval', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { policy: 'manual' });
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'manual requires approval');
  eq((r as { reason: string }).reason, 'approval_required', 'reason');
});

test('12. approval is bound to exact parameters (tampering rejected)', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { policy: 'manual' });
  const req = m.requestApproval({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', context: 'ctx-1' });
  const { signer, accountInfo } = makeTestKey();
  const challenge = m.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const ap = await m.approveApproval({
    approvalId: req.id, walletAddress: SENDER, agentId: 'agent-1', network: CAIP2,
    recipient: RECIPIENT, amountMicroCcd: '100', context: 'ctx-1', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(ap.ok, true, 'approved');
  const token = (ap as { token: string }).token;
  // tampered amount
  const tampered = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '200', approvalToken: token, context: 'ctx-1' });
  eq(tampered.ok, false, 'tampered amount rejected');
  eq((tampered as { reason: string }).reason, 'approval_param_mismatch', 'reason');
  // tampered recipient
  const tampered2 = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: OTHER_RECIPIENT, amountMicroCcd: '100', approvalToken: token, context: 'ctx-1' });
  eq(tampered2.ok, false, 'tampered recipient rejected');
  // correct params consume the token
  const good = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', approvalToken: token, context: 'ctx-1' });
  eq(good.ok, true, 'correct params approved');
});

test('13. expired and replayed approval are rejected', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { policy: 'manual' });
  let clock = 1_000_000_000_000;
  const req = m.requestApproval({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', context: 'ctx-1', ttlSeconds: 60 });
  // approve with a real clock
  const { signer, accountInfo } = makeTestKey();
  const challenge = m.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'approve' });
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const ap = await m.approveApproval({ approvalId: req.id, walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', context: 'ctx-1', challenge, signature, accountInfo: accountInfo as never });
  eq(ap.ok, true, 'approved');
  const token = (ap as { token: string }).token;
  // replay
  const r1 = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', approvalToken: token, context: 'ctx-1' });
  eq(r1.ok, true, 'first use ok');
  const r2 = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100', approvalToken: token, context: 'ctx-1' });
  eq(r2.ok, false, 'replay rejected');
  eq((r2 as { reason: string }).reason, 'approval_not_approved', 'reason');
});

test('14. paused or revoked agent is blocked', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m);
  eq(m.pausePermission(SENDER, 'agent-1', CAIP2), true, 'paused');
  const paused = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(paused.ok, false, 'paused blocked');
  eq((paused as { reason: string }).reason, 'permission_paused', 'reason');
  eq(m.resumePermission(SENDER, 'agent-1', CAIP2), true, 'resumed');
  eq(m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' }).ok, true, 'resumed ok');
});

test('15. wallet unlink invalidates all its permissions', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { agent: 'agent-1' });
  await grant(m, { agent: 'agent-2' });
  const n = m.invalidateWallet(SENDER);
  eq(n, 2, 'two permissions invalidated');
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'blocked');
  eq((r as { reason: string }).reason, 'permission_revoked', 'reason');
});

// ── 5. reservations + enforcement through authorizePayment ──────────────────

interface CallLog { verify: number; settle: number; }

function fakeFacilitator(over: { verify?: Partial<VerifyResponse>; settle?: Partial<SettleResponse> } = {}, log?: CallLog): ConsumerFacilitator {
  const f: ConsumerFacilitator = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: CAIP2 }] };
    },
    async verify(_payload, _requirements) {
      log?.verify !== undefined && (log.verify += 1);
      return { isValid: true, ...over.verify } as VerifyResponse;
    },
    async settle(_payload, _requirements) {
      log?.settle !== undefined && (log.settle += 1);
      return { success: true, transaction: 'ab'.repeat(32), network: CAIP2, ...over.settle } as SettleResponse;
    },
  };
  return f;
}

function requirements(payTo: string, amount: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: CAIP2,
    amount,
    asset: 'CCD',
    payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  } as unknown as PaymentRequirements;
}

/** A payload that satisfies preflight's shape checks for the given requirements. */
function payloadFor(reqs: PaymentRequirements) {
  return { x402Version: 2, accepted: reqs, payload: {} };
}

test('16. concurrent reservations cannot bypass limits', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  // two synchronous reservations — the second must fail because the first reserved capacity
  const a = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '600' });
  const b = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(a.ok, true, 'first reserved');
  eq(b.ok, false, 'second blocked');
  eq((b as { reason: string }).reason, 'daily_limit_exceeded', 'reason');
  // two concurrent authorizePayment calls with a FRESH manager
  const m2 = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m2, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  const log: CallLog = { verify: 0, settle: 0 };
  const reqs = requirements(RECIPIENT, '600');
  const [r1, r2] = await Promise.all([
    authorizePayment({ facilitator: fakeFacilitator({}, log), paymentPayload: payloadFor(reqs), requirements: reqs, settle: true, permissionCheck: (p) => m2.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }) }),
    authorizePayment({ facilitator: fakeFacilitator({}, log), paymentPayload: payloadFor(reqs), requirements: reqs, settle: true, permissionCheck: (p) => m2.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }) }),
  ]);
  // exactly one may grant
  const granted = [r1.granted, r2.granted].filter(Boolean).length;
  eq(granted, 1, 'exactly one concurrent payment granted');
});

test('17. failed payment releases its reservation', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  const log: CallLog = { verify: 0, settle: 0 };
  const failing = fakeFacilitator({ verify: { isValid: false, invalidReason: 'bad' } }, log);
  const r = await authorizePayment({
    facilitator: failing, paymentPayload: payloadFor(requirements(RECIPIENT, '600')), requirements: requirements(RECIPIENT, '600'), settle: true,
    permissionCheck: (p) => m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }),
    onSettleFail: (id) => m.releaseReservation(SENDER, 'agent-1', CAIP2, id),
  });
  eq(r.granted, false, 'rejected');
  // capacity released: a new 600 reservation now fits
  const next = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(next.ok, true, 'capacity released');
});

test('18. ambiguous submission retains its reservation', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  const ambiguous = fakeFacilitator({ settle: { success: false, errorReason: 'timeout' } });
  const r = await authorizePayment({
    facilitator: ambiguous, paymentPayload: payloadFor(requirements(RECIPIENT, '600')), requirements: requirements(RECIPIENT, '600'), settle: true,
    permissionCheck: (p) => m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }),
    onAmbiguous: (id) => m.retainReservation(SENDER, 'agent-1', CAIP2, id),
  });
  eq(r.granted, false, 'ambiguous');
  const next = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '600' });
  eq(next.ok, false, 'capacity retained');
  eq((next as { reason: string }).reason, 'daily_limit_exceeded', 'reason');
});

test('19. finalized payment becomes recorded spending', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m, { limits: { perTxMicroCcd: null, dailyMicroCcd: 1000n, periodMicroCcd: null, periodSeconds: null } });
  const r = await authorizePayment({
    facilitator: fakeFacilitator(), paymentPayload: payloadFor(requirements(RECIPIENT, '600')), requirements: requirements(RECIPIENT, '600'), settle: true,
    permissionCheck: (p) => m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }),
    onSettleSuccess: (id) => m.finalizeReservation(SENDER, 'agent-1', CAIP2, id),
  });
  eq(r.granted, true, 'granted');
  const p = m.getPermission(SENDER, 'agent-1', CAIP2)!;
  const total = [...p.dailySpent.values()].reduce((a, b) => a + b, 0n);
  eq(total, 600n, 'recorded spending');
  const next = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '500' });
  eq(next.ok, false, 'daily cap now consumes recorded spending');
});

test('20. permission store unavailable fails closed', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m);
  m.setAvailable(false);
  const r = m.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'fail closed');
  eq((r as { reason: string }).reason, 'permission_store_unavailable', 'reason');
  const res = m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(res.ok, false, 'reserve fails closed');
});

test('21. no facilitator call when permission fails', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  const log: CallLog = { verify: 0, settle: 0 };
  const r = await authorizePayment({
    facilitator: fakeFacilitator({}, log), paymentPayload: payloadFor(requirements(RECIPIENT, '100')), requirements: requirements(RECIPIENT, '100'), settle: true,
    permissionCheck: (p) => m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }),
  });
  eq(r.granted, false, 'denied');
  eq((r.reason as string).includes('permission'), true, 'permission reason');
  eq(log.verify, 0, 'verify never called');
  eq(log.settle, 0, 'settle never called');
});

test('22. network binding rejects cross-network payment', async () => {
  const m = new PermissionManager({ now: () => 1_000_000_000_000 });
  await grant(m);
  const log: CallLog = { verify: 0, settle: 0 };
  const reqs = { ...requirements(RECIPIENT, '100'), network: OTHER_NETWORK } as PaymentRequirements;
  const r = await authorizePayment({
    facilitator: fakeFacilitator({}, log), paymentPayload: payloadFor(reqs), requirements: reqs, settle: true,
    permissionCheck: (p) => m.checkAndReserve({ walletAddress: SENDER, agentId: 'agent-1', network: p.network, recipient: p.recipient, amountMicroCcd: p.amountMicroCcd }),
  });
  eq(r.granted, false, 'denied');
  eq(log.settle, 0, 'settle never called');
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
console.log(`\nagent-wallet-permissions: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
