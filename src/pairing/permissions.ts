/**
 * Agent wallet permissions & spending controls.
 *
 * Builds on the wallet connection and ownership verification layer and adds:
 *   - per-agent, per-wallet permissions (disabled by default)
 *   - spending limits (per-tx, daily, period) in integer microCCD
 *   - recipient allowlist + network binding
 *   - approval policy (manual / bounded_auto)
 *   - emergency controls (pause / revoke / unlink invalidation)
 *   - owner authorization via signed short-lived single-use challenges
 *   - reservation accounting for concurrent + ambiguous payments
 *   - manual approval flow bound to exact payment parameters
 *
 * Money is always integer microCCD (BigInt). No floating point anywhere.
 * All state is in-memory; a durable adapter can be dropped in without changing
 * the public interface (same pattern as PairingStore).
 */

import { randomBytes, createHash } from 'node:crypto';
import type { AccountInfo } from '@concordium/web-sdk';
import { verifyOwnership, type OwnershipVerification } from './pairing.js';

// ─── types ──────────────────────────────────────────────────────────────────

export type ApprovalPolicy = 'manual' | 'bounded_auto';

export interface SpendingLimits {
  /** Max microCCD per single transaction. null = no per-tx cap (still gated by grant). */
  perTxMicroCcd: bigint | null;
  /** Max cumulative microCCD per UTC day. null = no daily cap. */
  dailyMicroCcd: bigint | null;
  /** Max cumulative microCCD per period. null = no period cap. */
  periodMicroCcd: bigint | null;
  /** Period length in seconds (e.g. 7*86400 weekly). null when periodMicroCcd is null. */
  periodSeconds: number | null;
}

export interface AgentPermission {
  pairingId: string;
  agentId: string;
  walletAddress: string;
  network: string;
  /** Payment permission is disabled until explicitly granted. */
  enabled: boolean;
  paused: boolean;
  revoked: boolean;
  limits: SpendingLimits;
  /** null = any recipient allowed. */
  recipientAllowlist: string[] | null;
  policy: ApprovalPolicy;
  createdAt: number;
  updatedAt: number;
  // spending accounting (integer microCCD)
  dailySpent: Map<string, bigint>; // UTC day key -> amount
  periodStart: number; // unix seconds, aligned to period boundary
  periodSpent: bigint;
  reservations: Map<string, { amount: bigint; createdAt: number; status: 'pending' | 'finalized' | 'released' | 'retained' }>;
  // approvals
  approvals: Map<string, PaymentApproval>;
}

/** Append-only, secret-free activity record (permission changes + payment events). */
export interface ActivityEvent {
  at: number;
  kind:
    | 'permission_granted'
    | 'permission_revoked'
    | 'permission_paused'
    | 'permission_resumed'
    | 'wallet_invalidated'
    | 'approval_requested'
    | 'approval_approved'
    | 'approval_rejected'
    | 'payment_reserved'
    | 'payment_released'
    | 'payment_retained'
    | 'payment_finalized'
    | 'payment_denied';
  walletAddress: string;
  agentId: string;
  network: string;
  /** Public identifiers and amounts only — never keys, signatures, or tokens. */
  detail: string;
}

export interface PaymentApproval {
  id: string;
  walletAddress: string;
  agentId: string;
  network: string;
  recipient: string;
  amountMicroCcd: string;
  context: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
  token: string | null;
  /** The exact parameter hash the approval is bound to. */
  paramHash: string;
}

export interface Challenge {
  id: string;
  message: string;
  network: string;
  expiresAt: number;
  createdAt: number;
  used: boolean;
}

export type PermissionResult =
  | { ok: true }
  | { ok: false; reason: string };

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: string };

// ─── helpers ────────────────────────────────────────────────────────────────

function microCcd(value: string | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function utcDayKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodStart(unixSeconds: number, periodSeconds: number): number {
  return Math.floor(unixSeconds / periodSeconds) * periodSeconds;
}

function paramHash(params: { walletAddress: string; agentId: string; network: string; recipient: string; amountMicroCcd: string; context: string }): string {
  return createHash('sha256')
    .update(`${params.walletAddress}|${params.agentId}|${params.network}|${params.recipient}|${params.amountMicroCcd}|${params.context}`)
    .digest('hex');
}

function randomHex(n: number): string {
  return Buffer.from(randomBytes(n)).toString('hex');
}

// ─── permission challenge ───────────────────────────────────────────────────

export interface ChallengeOptions {
  walletAddress: string;
  agentId: string;
  network: string;
  action: string;
  ttlSeconds?: number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export function createPermissionChallenge(opts: ChallengeOptions): Challenge {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlSeconds ?? 300;
  const rnd = opts.random ?? ((n) => Uint8Array.from(randomBytes(n)));
  const nonce = Buffer.from(rnd(16)).toString('hex');
  const nowSec = Math.floor(now() / 1000);
  const expiresAt = nowSec + ttl;
  const id = createHash('sha256').update(`${opts.walletAddress}:${opts.agentId}:${opts.network}:${opts.action}:${nonce}:${expiresAt}`).digest('hex');
  const message = `AgentTrust permission\nwallet=${opts.walletAddress}\nagent=${opts.agentId}\nnetwork=${opts.network}\naction=${opts.action}\nnonce=${nonce}\nexpires=${expiresAt}`;
  return { id, message, network: opts.network, expiresAt, createdAt: nowSec, used: false };
}

export function challengeStatus(c: Challenge, network: string, nowSeconds: number): { ok: true } | { ok: false; reason: 'wrong_network' | 'challenge_expired' | 'challenge_used' } {
  if (c.network !== network) return { ok: false, reason: 'wrong_network' };
  if (c.used) return { ok: false, reason: 'challenge_used' };
  if (nowSeconds > c.expiresAt) return { ok: false, reason: 'challenge_expired' };
  return { ok: true };
}

// ─── permission manager ─────────────────────────────────────────────────────

export interface PermissionManagerOptions {
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export class PermissionManager {
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly permissions = new Map<string, AgentPermission>(); // key = wallet|agent|network
  private readonly challenges = new Map<string, Challenge>();
  private nonceCounter = 0;
  private available = true;
  private readonly activityLog: ActivityEvent[] = [];

  constructor(opts: PermissionManagerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? ((n) => Uint8Array.from(randomBytes(n)));
  }

  /** Mark the store unavailable (fail-closed). */
  setAvailable(v: boolean): void {
    this.available = v;
  }
  isAvailable(): boolean {
    return this.available;
  }

  private log(kind: ActivityEvent['kind'], walletAddress: string, agentId: string, network: string, detail: string): void {
    this.activityLog.push({ at: this.nowSec(), kind, walletAddress, agentId, network, detail });
  }

  /** Append-only activity log. Secret-free by construction. */
  activity(limit = 100): ActivityEvent[] {
    return this.activityLog.slice(-limit);
  }

  private key(walletAddress: string, agentId: string, network: string): string {
    return `${walletAddress}|${agentId}|${network}`;
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Unix seconds on the manager's clock (public; injectable in tests). */
  nowSecondsPublic(): number {
    return this.nowSec();
  }

  /** Approvals for one (wallet, agent) pair, newest last. */
  listApprovals(walletAddress: string, agentId: string, network: string): PaymentApproval[] {
    const p = this.permissions.get(this.key(walletAddress, agentId, network));
    if (p) return [...p.approvals.values()];
    return [...this.approvalsGlobal.values()].filter(
      (a) => a.walletAddress === walletAddress && a.agentId === agentId && a.network === network,
    );
  }

  // ── challenges ──────────────────────────────────────────────────────────

  issueChallenge(opts: ChallengeOptions): Challenge {
    const c = createPermissionChallenge({ ...opts, now: this.now, random: this.random });
    this.challenges.set(c.id, c);
    return c;
  }

  getChallenge(id: string): Challenge | undefined {
    return this.challenges.get(id);
  }

  consumeChallenge(id: string): boolean {
    const c = this.challenges.get(id);
    if (!c || c.used) return false;
    c.used = true;
    return true;
  }

  // ── grant / revoke / pause ──────────────────────────────────────────────

  /**
   * Grant or update a permission. Requires a verified owner: the caller must have
   * already verified ownership (pass the result). Returns the permission record.
   */
  grantPermission(args: {
    walletAddress: string;
    agentId: string;
    network: string;
    pairingId: string;
    limits: SpendingLimits;
    recipientAllowlist: string[] | null;
    policy: ApprovalPolicy;
    challenge: Challenge;
    signature: unknown;
    accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null;
  }): Promise<PermissionResult & { permission?: AgentPermission }> {
    if (!this.available) return Promise.resolve({ ok: false, reason: 'permission_store_unavailable' });

    // verify ownership first
    const status = challengeStatus(args.challenge, args.network, this.nowSec());
    if (!status.ok) return Promise.resolve({ ok: false, reason: status.reason });
    // ownership verification is async
    return (async () => {
      const ownership: OwnershipVerification = await verifyOwnership({
        walletAddress: args.walletAddress,
        challenge: args.challenge,
        signature: args.signature,
        accountInfo: args.accountInfo,
        network: args.network,
        nowSeconds: this.nowSec(),
      });
      if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'invalid_signature' };
      if (!this.consumeChallenge(args.challenge.id)) return { ok: false, reason: 'challenge_used' };

      const now = this.nowSec();
      const k = this.key(args.walletAddress, args.agentId, args.network);
      const existing = this.permissions.get(k);
      const perm: AgentPermission = {
        pairingId: args.pairingId,
        agentId: args.agentId,
        walletAddress: args.walletAddress,
        network: args.network,
        enabled: true,
        paused: false,
        revoked: false,
        limits: args.limits,
        recipientAllowlist: args.recipientAllowlist,
        policy: args.policy,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        dailySpent: existing?.dailySpent ?? new Map(),
        periodStart: existing?.periodStart ?? periodStart(now, args.limits.periodSeconds ?? 86400),
        periodSpent: existing?.periodSpent ?? 0n,
        reservations: existing?.reservations ?? new Map(),
        approvals: existing?.approvals ?? new Map(),
      };
      this.permissions.set(k, perm);
      this.log('permission_granted', args.walletAddress, args.agentId, args.network, `policy=${args.policy} perTx=${args.limits.perTxMicroCcd ?? 'none'} daily=${args.limits.dailyMicroCcd ?? 'none'} period=${args.limits.periodMicroCcd ?? 'none'}/${args.limits.periodSeconds ?? 'none'}s allowlist=${args.recipientAllowlist ? args.recipientAllowlist.length : 'any'}`);
      return { ok: true, permission: perm };
    })();
  }

  revokePermission(walletAddress: string, agentId: string, network: string): boolean {
    const k = this.key(walletAddress, agentId, network);
    const p = this.permissions.get(k);
    if (!p) return false;
    p.revoked = true;
    p.enabled = false;
    p.paused = false;
    p.updatedAt = this.nowSec();
    // invalidate outstanding approvals
    for (const a of p.approvals.values()) {
      if (a.status === 'pending' || a.status === 'approved') a.status = 'expired';
    }
    this.log('permission_revoked', p.walletAddress, p.agentId, p.network, 'explicit revocation');
    return true;
  }

  pausePermission(walletAddress: string, agentId: string, network: string): boolean {
    const k = this.key(walletAddress, agentId, network);
    const p = this.permissions.get(k);
    if (!p || p.revoked) return false;
    p.paused = true;
    p.updatedAt = this.nowSec();
    this.log('permission_paused', p.walletAddress, p.agentId, p.network, 'paused');
    return true;
  }

  resumePermission(walletAddress: string, agentId: string, network: string): boolean {
    const k = this.key(walletAddress, agentId, network);
    const p = this.permissions.get(k);
    if (!p || p.revoked) return false;
    p.paused = false;
    p.updatedAt = this.nowSec();
    this.log('permission_resumed', p.walletAddress, p.agentId, p.network, 'resumed');
    return true;
  }

  /** Unlinking a wallet invalidates all its agent permissions. */
  invalidateWallet(walletAddress: string): number {
    let count = 0;
    for (const [k, p] of this.permissions) {
      if (p.walletAddress === walletAddress) {
        p.revoked = true;
        p.enabled = false;
        p.paused = false;
        p.updatedAt = this.nowSec();
        for (const a of p.approvals.values()) {
          if (a.status === 'pending' || a.status === 'approved') a.status = 'expired';
        }
        this.log('wallet_invalidated', p.walletAddress, p.agentId, p.network, 'wallet unlinked');
        count++;
      }
    }
    return count;
  }

  getPermission(walletAddress: string, agentId: string, network: string): AgentPermission | undefined {
    return this.permissions.get(this.key(walletAddress, agentId, network));
  }

  listPermissions(walletAddress?: string): AgentPermission[] {
    return [...this.permissions.values()].filter((p) => (walletAddress === undefined ? true : p.walletAddress === walletAddress));
  }

  // ── spending check + reservation ────────────────────────────────────────

  /**
   * Synchronous check + reserve. Must be called before any await in the payment
   * path so concurrent requests cannot interleave between check and reserve.
   */
  checkAndReserve(args: {
    walletAddress: string;
    agentId: string;
    network: string;
    recipient: string;
    amountMicroCcd: string;
  }): ReserveResult {
    if (!this.available) return { ok: false, reason: 'permission_store_unavailable' };
    const p = this.permissions.get(this.key(args.walletAddress, args.agentId, args.network));
    if (!p) return { ok: false, reason: 'no_permission' };
    if (p.revoked) return { ok: false, reason: 'permission_revoked' };
    if (!p.enabled) return { ok: false, reason: 'permission_disabled' };
    if (p.paused) return { ok: false, reason: 'permission_paused' };
    if (p.network !== args.network) return { ok: false, reason: 'wrong_network' };

    let amount: bigint;
    try {
      amount = microCcd(args.amountMicroCcd);
    } catch {
      return { ok: false, reason: 'invalid_amount' };
    }
    if (amount <= 0n) return { ok: false, reason: 'invalid_amount' };

    // recipient allowlist
    if (p.recipientAllowlist && p.recipientAllowlist.length > 0) {
      if (!p.recipientAllowlist.includes(args.recipient)) return { ok: false, reason: 'recipient_not_allowed' };
    }

    // per-tx limit
    if (p.limits.perTxMicroCcd !== null && amount > p.limits.perTxMicroCcd) {
      return { ok: false, reason: 'per_tx_limit_exceeded' };
    }

    const now = this.nowSec();

    // daily limit (UTC day)
    if (p.limits.dailyMicroCcd !== null) {
      const dayKey = utcDayKey(now);
      const spent = p.dailySpent.get(dayKey) ?? 0n;
      const reserved = this.reservedInDay(p, dayKey);
      if (spent + reserved + amount > p.limits.dailyMicroCcd) {
        return { ok: false, reason: 'daily_limit_exceeded' };
      }
    }

    // period limit
    if (p.limits.periodMicroCcd !== null && p.limits.periodSeconds !== null) {
      const ps = periodStart(now, p.limits.periodSeconds);
      // reset if new period
      if (ps !== p.periodStart) {
        p.periodStart = ps;
        p.periodSpent = 0n;
      }
      const reserved = this.reservedInPeriod(p, p.periodStart, p.limits.periodSeconds);
      if (p.periodSpent + reserved + amount > p.limits.periodMicroCcd) {
        return { ok: false, reason: 'period_limit_exceeded' };
      }
    }

    // approval policy
    if (p.policy === 'manual') {
      // requires a pre-consumed approval token; checked by caller via consumeApproval.
      // Here we only record the reservation; approval gating is enforced in authorizePayment.
    }

    // reserve
    const reservationId = randomHex(16);
    p.reservations.set(reservationId, { amount, createdAt: now, status: 'pending' });
    this.log('payment_reserved', args.walletAddress, args.agentId, args.network, `amount=${args.amountMicroCcd} reservation=${reservationId}`);
    return { ok: true, reservationId };
  }

  private reservedInDay(p: AgentPermission, dayKey: string): bigint {
    let total = 0n;
    for (const r of p.reservations.values()) {
      // Only in-flight capacity counts here; finalized amounts live in dailySpent.
      if (r.status !== 'pending' && r.status !== 'retained') continue;
      if (utcDayKey(r.createdAt) === dayKey) total += r.amount;
    }
    return total;
  }

  private reservedInPeriod(p: AgentPermission, periodStartSec: number, periodSeconds: number): bigint {
    let total = 0n;
    for (const r of p.reservations.values()) {
      if (r.status !== 'pending' && r.status !== 'retained') continue;
      if (r.createdAt >= periodStartSec && r.createdAt < periodStartSec + periodSeconds) total += r.amount;
    }
    return total;
  }

  finalizeReservation(walletAddress: string, agentId: string, network: string, reservationId: string): boolean {
    if (!this.available) return false;
    const p = this.permissions.get(this.key(walletAddress, agentId, network));
    if (!p) return false;
    const r = p.reservations.get(reservationId);
    if (!r || r.status === 'released') return false;
    // record spending
    // Spend is recorded on the finalization day, so a reservation created late on
    // one UTC day and finalized the next consumes the next day's budget.
    const finalDay = utcDayKey(this.nowSec());
    p.dailySpent.set(finalDay, (p.dailySpent.get(finalDay) ?? 0n) + r.amount);
    // period
    const ps = periodStart(this.nowSec(), p.limits.periodSeconds ?? 86400);
    if (ps !== p.periodStart) { p.periodStart = ps; p.periodSpent = 0n; }
    p.periodSpent += r.amount;
    r.status = 'finalized';
    this.log('payment_finalized', walletAddress, agentId, network, `amount=${r.amount}`);
    return true;
  }

  releaseReservation(walletAddress: string, agentId: string, network: string, reservationId: string): boolean {
    if (!this.available) return false;
    const p = this.permissions.get(this.key(walletAddress, agentId, network));
    if (!p) return false;
    const r = p.reservations.get(reservationId);
    if (!r) return false;
    if (r.status === 'finalized') return false; // never release finalized
    r.status = 'released';
    this.log('payment_released', walletAddress, agentId, network, `amount=${r.amount}`);
    return true;
  }

  retainReservation(walletAddress: string, agentId: string, network: string, reservationId: string): boolean {
    if (!this.available) return false;
    const p = this.permissions.get(this.key(walletAddress, agentId, network));
    if (!p) return false;
    const r = p.reservations.get(reservationId);
    if (!r) return false;
    if (r.status === 'finalized' || r.status === 'released') return false;
    r.status = 'retained';
    this.log('payment_retained', walletAddress, agentId, network, `amount=${r.amount}`);
    return true;
  }

  // ── approval flow ───────────────────────────────────────────────────────

  requestApproval(args: {
    walletAddress: string;
    agentId: string;
    network: string;
    recipient: string;
    amountMicroCcd: string;
    context: string;
    ttlSeconds?: number;
  }): PaymentApproval {
    const now = this.nowSec();
    const ttl = args.ttlSeconds ?? 300;
    const id = randomHex(16);
    const ph = paramHash({ walletAddress: args.walletAddress, agentId: args.agentId, network: args.network, recipient: args.recipient, amountMicroCcd: args.amountMicroCcd, context: args.context });
    const approval: PaymentApproval = {
      id,
      walletAddress: args.walletAddress,
      agentId: args.agentId,
      network: args.network,
      recipient: args.recipient,
      amountMicroCcd: args.amountMicroCcd,
      context: args.context,
      createdAt: now,
      expiresAt: now + ttl,
      status: 'pending',
      token: null,
      paramHash: ph,
    };
    const p = this.permissions.get(this.key(args.walletAddress, args.agentId, args.network));
    if (p) p.approvals.set(id, approval);
    // store even without permission? keep in a global map for lookup
    this.approvalsGlobal.set(id, approval);
    this.log('approval_requested', args.walletAddress, args.agentId, args.network, `amount=${args.amountMicroCcd} recipient=${args.recipient}`);
    return approval;
  }

  private readonly approvalsGlobal = new Map<string, PaymentApproval>();

  getApproval(id: string): PaymentApproval | undefined {
    return this.approvalsGlobal.get(id);
  }

  approveApproval(args: {
    approvalId: string;
    walletAddress: string;
    agentId: string;
    network: string;
    recipient: string;
    amountMicroCcd: string;
    context: string;
    challenge: Challenge;
    signature: unknown;
    accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null;
  }): Promise<PermissionResult & { token?: string }> {
    if (!this.available) return Promise.resolve({ ok: false, reason: 'permission_store_unavailable' });
    const approval = this.approvalsGlobal.get(args.approvalId);
    if (!approval) return Promise.resolve({ ok: false, reason: 'unknown_approval' });
    if (approval.walletAddress !== args.walletAddress || approval.agentId !== args.agentId || approval.network !== args.network) {
      return Promise.resolve({ ok: false, reason: 'approval_mismatch' });
    }
    // param binding
    const ph = paramHash({ walletAddress: args.walletAddress, agentId: args.agentId, network: args.network, recipient: args.recipient, amountMicroCcd: args.amountMicroCcd, context: args.context });
    if (ph !== approval.paramHash) return Promise.resolve({ ok: false, reason: 'approval_param_mismatch' });
    if (approval.recipient !== args.recipient || approval.amountMicroCcd !== args.amountMicroCcd || approval.context !== args.context) {
      return Promise.resolve({ ok: false, reason: 'approval_param_mismatch' });
    }

    const now = this.nowSec();
    if (now > approval.expiresAt) {
      approval.status = 'expired';
      return Promise.resolve({ ok: false, reason: 'approval_expired' });
    }
    if (approval.status !== 'pending') {
      return Promise.resolve({ ok: false, reason: 'approval_not_pending' });
    }

    const status = challengeStatus(args.challenge, args.network, now);
    if (!status.ok) return Promise.resolve({ ok: false, reason: status.reason });

    return (async () => {
      const ownership: OwnershipVerification = await verifyOwnership({
        walletAddress: args.walletAddress,
        challenge: args.challenge,
        signature: args.signature,
        accountInfo: args.accountInfo,
        network: args.network,
        nowSeconds: now,
      });
      if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'invalid_signature' };
      if (!this.consumeChallenge(args.challenge.id)) return { ok: false, reason: 'challenge_used' };

      approval.status = 'approved';
      const token = randomHex(32);
      approval.token = token;
      this.log('approval_approved', args.walletAddress, args.agentId, args.network, `amount=${args.amountMicroCcd} recipient=${args.recipient}`);
      return { ok: true, token };
    })();
  }

  rejectApproval(args: { approvalId: string; walletAddress: string; agentId: string; network: string; challenge: Challenge; signature: unknown; accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null }): Promise<PermissionResult> {
    if (!this.available) return Promise.resolve({ ok: false, reason: 'permission_store_unavailable' });
    const approval = this.approvalsGlobal.get(args.approvalId);
    if (!approval) return Promise.resolve({ ok: false, reason: 'unknown_approval' });
    if (approval.walletAddress !== args.walletAddress || approval.agentId !== args.agentId || approval.network !== args.network) {
      return Promise.resolve({ ok: false, reason: 'approval_mismatch' });
    }
    const now = this.nowSec();
    if (now > approval.expiresAt) {
      approval.status = 'expired';
      return Promise.resolve({ ok: false, reason: 'approval_expired' });
    }
    const status = challengeStatus(args.challenge, args.network, now);
    if (!status.ok) return Promise.resolve({ ok: false, reason: status.reason });

    return (async () => {
      const ownership: OwnershipVerification = await verifyOwnership({
        walletAddress: args.walletAddress,
        challenge: args.challenge,
        signature: args.signature,
        accountInfo: args.accountInfo,
        network: args.network,
        nowSeconds: now,
      });
      if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'invalid_signature' };
      if (!this.consumeChallenge(args.challenge.id)) return { ok: false, reason: 'challenge_used' };
      approval.status = 'rejected';
      approval.token = null;
      this.log('approval_rejected', args.walletAddress, args.agentId, args.network, `amount=${approval.amountMicroCcd} recipient=${approval.recipient}`);
      return { ok: true };
    })();
  }

  /**
   * Consume a single-use approval token bound to exact payment params.
   * Returns ok only if the token matches and hasn't been consumed/expired.
   */
  consumeApproval(token: string, params: { walletAddress: string; agentId: string; network: string; recipient: string; amountMicroCcd: string; context: string }): PermissionResult {
    if (!this.available) return { ok: false, reason: 'permission_store_unavailable' };
    // find approval by token
    let found: PaymentApproval | undefined;
    for (const a of this.approvalsGlobal.values()) {
      if (a.token === token) { found = a; break; }
    }
    if (!found) return { ok: false, reason: 'unknown_approval_token' };
    if (found.status !== 'approved') return { ok: false, reason: 'approval_not_approved' };
    const now = this.nowSec();
    if (now > found.expiresAt) {
      found.status = 'expired';
      return { ok: false, reason: 'approval_expired' };
    }
    const ph = paramHash({ walletAddress: params.walletAddress, agentId: params.agentId, network: params.network, recipient: params.recipient, amountMicroCcd: params.amountMicroCcd, context: params.context });
    if (ph !== found.paramHash) return { ok: false, reason: 'approval_param_mismatch' };
    if (found.walletAddress !== params.walletAddress || found.agentId !== params.agentId || found.network !== params.network) {
      return { ok: false, reason: 'approval_mismatch' };
    }
    if (found.recipient !== params.recipient || found.amountMicroCcd !== params.amountMicroCcd || found.context !== params.context) {
      return { ok: false, reason: 'approval_param_mismatch' };
    }
    // single-use: status moves to consumed, token kept so a replay is detectable.
    found.status = 'consumed';
    return { ok: true };
  }

  // ── permission check for a payment (used by payment path) ────────────────

  /**
   * Full permission check for a prospective payment. Does NOT reserve capacity;
   * the caller (payment path) must call checkAndReserve separately to reserve.
   * This is the "is this allowed at all" gate.
   */
  isPaymentAllowed(args: {
    walletAddress: string;
    agentId: string;
    network: string;
    recipient: string;
    amountMicroCcd: string;
    approvalToken?: string | null;
    context?: string;
  }): PermissionResult {
    if (!this.available) return { ok: false, reason: 'permission_store_unavailable' };
    const p = this.permissions.get(this.key(args.walletAddress, args.agentId, args.network));
    if (!p) return { ok: false, reason: 'no_permission' };
    if (p.revoked) return { ok: false, reason: 'permission_revoked' };
    if (!p.enabled) return { ok: false, reason: 'permission_disabled' };
    if (p.paused) return { ok: false, reason: 'permission_paused' };
    if (p.network !== args.network) return { ok: false, reason: 'wrong_network' };

    // recipient allowlist
    if (p.recipientAllowlist && p.recipientAllowlist.length > 0) {
      if (!p.recipientAllowlist.includes(args.recipient)) return { ok: false, reason: 'recipient_not_allowed' };
    }

    // amount numeric
    let amount: bigint;
    try { amount = microCcd(args.amountMicroCcd); } catch { return { ok: false, reason: 'invalid_amount' }; }
    if (amount <= 0n) return { ok: false, reason: 'invalid_amount' };

    // per-tx
    if (p.limits.perTxMicroCcd !== null && amount > p.limits.perTxMicroCcd) {
      return { ok: false, reason: 'per_tx_limit_exceeded' };
    }

    // daily (check only, no reserve here)
    if (p.limits.dailyMicroCcd !== null) {
      const now = this.nowSec();
      const dayKey = utcDayKey(now);
      const spent = p.dailySpent.get(dayKey) ?? 0n;
      const reserved = this.reservedInDay(p, dayKey);
      if (spent + reserved + amount > p.limits.dailyMicroCcd) {
        return { ok: false, reason: 'daily_limit_exceeded' };
      }
    }

    // period
    if (p.limits.periodMicroCcd !== null && p.limits.periodSeconds !== null) {
      const now = this.nowSec();
      const ps = periodStart(now, p.limits.periodSeconds);
      const periodSpent = (ps !== p.periodStart) ? 0n : p.periodSpent;
      const reserved = this.reservedInPeriod(p, ps, p.limits.periodSeconds);
      if (periodSpent + reserved + amount > p.limits.periodMicroCcd) {
        return { ok: false, reason: 'period_limit_exceeded' };
      }
    }

    // approval policy
    if (p.policy === 'manual') {
      if (!args.approvalToken) return { ok: false, reason: 'approval_required' };
      const r = this.consumeApproval(args.approvalToken, {
        walletAddress: args.walletAddress,
        agentId: args.agentId,
        network: args.network,
        recipient: args.recipient,
        amountMicroCcd: args.amountMicroCcd,
        context: args.context ?? '',
      });
      if (!r.ok) return { ok: false, reason: r.reason ?? 'approval_invalid' };
    }

    return { ok: true };
  }

  /** Log a denial (called by the server on rejection). */
  logDenial(walletAddress: string, agentId: string, network: string, reason: string): void {
    this.log('payment_denied', walletAddress, agentId, network, reason);
  }
}
