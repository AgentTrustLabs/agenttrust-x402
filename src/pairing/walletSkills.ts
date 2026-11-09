/**
 * Agent Wallet Skills.
 *
 * A discoverable, versioned skills layer over the agentic wallets and the
 * permission manager. The agent never supplies a wallet id: the skill
 * resolves the assigned wallet from a trusted `SkillContext` (agent + owner +
 * network), so a caller cannot select another agent's wallet.
 *
 * Skills:
 *   wallet_get_status        — the requesting agent's assigned wallet
 *   wallet_get_permissions   — effective permission state (never another agent's)
 *   wallet_request_payment   — permission-gated payment request via the payment executor
 *   wallet_request_approval  — create/retrieve an owner-approval request
 *   wallet_get_activity      — bounded, redacted activity for the assigned wallet
 *
 * No skill signs, settles, or touches a private key. `wallet_request_payment` is a
 * *request*: it routes through the existing pipeline and returns an explicit
 * `approval_required` / `denied` / `wallet_not_funded` / `executed` state.
 */

import { AgenticWalletManager } from './agenticWallet.js';
import type { WalletRecord } from './walletStore.js';
import { PermissionManager } from './permissions.js';

export const WALLET_SKILLS_VERSION = '1.0.0';

export interface SkillManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What the caller must hold before the skill will run. */
  requires: string;
}

export const WALLET_SKILLS_MANIFEST = {
  name: 'agenttrust.wallet',
  version: WALLET_SKILLS_VERSION,
  description:
    'Agent wallet capabilities: inspect the assigned wallet, inspect effective permissions, request an owner approval, and request a payment through the controlled pipeline.',
  skills: [
    {
      name: 'wallet_get_status',
      description:
        'Return the requesting agent\'s assigned wallet: id, address (or null when only locally provisioned), network, lifecycle, and funding status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      requires: 'paired_agent_wallet',
    },
    {
      name: 'wallet_get_permissions',
      description:
        'Return the effective permission state for the requesting agent\'s wallet (limits, allowlist, policy, remaining allowance).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      requires: 'paired_agent_wallet',
    },
    {
      name: 'wallet_request_payment',
      description:
        'Request a payment from the agent wallet. Validates the agent-wallet association, permissions, and funding, then routes through the existing payment pipeline. Returns approval_required / denied / wallet_not_funded / executed.',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: { type: 'string', minLength: 1, maxLength: 64 },
          amountMicroCcd: { type: 'string', pattern: '^[0-9]+$', maxLength: 16 },
          context: { type: 'string', maxLength: 128 },
          approvalToken: { type: 'string', maxLength: 128 },
        },
        required: ['recipient', 'amountMicroCcd'],
        additionalProperties: false,
      },
      requires: 'paired_agent_wallet',
    },
    {
      name: 'wallet_request_approval',
      description:
        'Create or retrieve an approval request bound to exact payment parameters. The owner must still approve; an approval request is not payment authorization.',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: { type: 'string', minLength: 1, maxLength: 64 },
          amountMicroCcd: { type: 'string', pattern: '^[0-9]+$', maxLength: 16 },
          context: { type: 'string', maxLength: 128 },
        },
        required: ['recipient', 'amountMicroCcd'],
        additionalProperties: false,
      },
      requires: 'paired_agent_wallet',
    },
    {
      name: 'wallet_get_activity',
      description:
        'Return the requesting agent\'s wallet activity, newest first, bounded by `limit`. Secrets and signing material are never included.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      requires: 'paired_agent_wallet',
    },
  ] satisfies SkillManifestEntry[],
};

export interface SkillContext {
  /** The authenticated agent identity (CIS-8004 token id). */
  agentId: string;
  /** The verified owner wallet address. */
  ownerWalletAddress: string;
  /** CAIP-2 the invocation is bound to. */
  network: string;
}

export interface PaymentExecutorResult {
  ok: boolean;
  reason?: string;
  receipt?: unknown;
}

export interface PaymentExecutor {
  execute(args: {
    ownerWalletAddress: string;
    agentId: string;
    network: string;
    recipient: string;
    amountMicroCcd: string;
    context: string;
    approvalToken?: string | null;
  }): Promise<PaymentExecutorResult>;
}

export type SkillResult =
  | { ok: true; skill: string; data: unknown }
  | { ok: false; skill: string; error: string; code: string };

export interface WalletSkillsOptions {
  wallets: AgenticWalletManager;
  permissions?: PermissionManager;
  /** Executes a payment through the existing permission + x402 pipeline. */
  payments?: PaymentExecutor;
  now?: () => number;
}

/** Parse a bounded integer arg. */
function boundedInt(v: unknown, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) return dflt;
  return n;
}

export class WalletSkills {
  private readonly wallets: AgenticWalletManager;
  private readonly permissions?: PermissionManager;
  private readonly payments?: PaymentExecutor;

  constructor(opts: WalletSkillsOptions) {
    this.wallets = opts.wallets;
    this.permissions = opts.permissions;
    this.payments = opts.payments;
  }

  manifest() {
    return WALLET_SKILLS_MANIFEST;
  }

  list(): SkillManifestEntry[] {
    return WALLET_SKILLS_MANIFEST.skills;
  }

  /**
   * Resolve the assigned wallet for the context. The caller cannot choose a wallet:
   * the (owner, agent, network) tuple from the trusted context is the only lookup key.
   */
  private resolveWallet(ctx: SkillContext): { ok: true; wallet: WalletRecord } | { ok: false; error: string; code: string } {
    if (!ctx || typeof ctx.agentId !== 'string' || typeof ctx.ownerWalletAddress !== 'string' || typeof ctx.network !== 'string') {
      return { ok: false, error: 'invalid_context', code: 'invalid_context' };
    }
    const wallet = this.wallets.listByOwner(ctx.ownerWalletAddress).find(
      (w) => w.agentId === ctx.agentId && w.network === ctx.network,
    );
    if (!wallet) return { ok: false, error: 'no_wallet', code: 'no_wallet' };
    return { ok: true, wallet };
  }

  async invoke(ctx: SkillContext, name: string, args: unknown): Promise<SkillResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    // A caller must never be able to pick a wallet.
    if ('walletId' in a || 'ownerWalletAddress' in a || 'agentId' in a || 'network' in a) {
      return { ok: false, skill: name, error: 'identity arguments are not accepted; they come from the trusted context', code: 'invalid_arguments' };
    }

    if (name === 'wallet_get_status') {
      const r = this.resolveWallet(ctx);
      if (!r.ok) return { ok: false, skill: name, error: r.error, code: r.code };
      return { ok: true, skill: name, data: serialiseStatus(r.wallet) };
    }

    if (name === 'wallet_get_permissions') {
      const r = this.resolveWallet(ctx);
      if (!r.ok) return { ok: false, skill: name, error: r.error, code: r.code };
      if (!this.permissions) return { ok: false, skill: name, error: 'permission_service_unavailable', code: 'service_unavailable' };
      const p = this.permissions.getPermission(ctx.ownerWalletAddress, ctx.agentId, ctx.network);
      return { ok: true, skill: name, data: serialisePermissions(p, ctx, this.permissions) };
    }

    if (name === 'wallet_request_payment') {
      return this.requestPayment(ctx, name, a);
    }

    if (name === 'wallet_request_approval') {
      return this.requestApproval(ctx, name, a);
    }

    if (name === 'wallet_get_activity') {
      const r = this.resolveWallet(ctx);
      if (!r.ok) return { ok: false, skill: name, error: r.error, code: r.code };
      const limit = boundedInt(a['limit'], 1, 100, 25);
      const events = this.wallets.events(r.wallet.walletId, limit);
      return { ok: true, skill: name, data: { walletId: r.wallet.walletId, events: events.map(redactEvent) } };
    }

    return { ok: false, skill: name, error: 'unknown_skill', code: 'unknown_skill' };
  }

  private async requestPayment(ctx: SkillContext, name: string, a: Record<string, unknown>): Promise<SkillResult> {
    const r = this.resolveWallet(ctx);
    if (!r.ok) return { ok: false, skill: name, error: r.error, code: r.code };
    const wallet = r.wallet;

    // lifecycle gate
    if (wallet.status === 'revoked') return { ok: false, skill: name, error: 'wallet_revoked', code: 'wallet_revoked' };
    if (wallet.status === 'paused') return { ok: false, skill: name, error: 'wallet_paused', code: 'wallet_paused' };
    if (wallet.status === 'recovery_required') return { ok: false, skill: name, error: 'wallet_recovery_required', code: 'wallet_recovery_required' };

    // funding gate: local provisioning is not an on-chain account
    if (wallet.accountAddress === null) {
      return { ok: false, skill: name, error: 'wallet_not_funded', code: 'wallet_not_funded', };
    }
    if (wallet.fundingStatus !== 'funded') {
      return { ok: false, skill: name, error: 'wallet_not_funded', code: 'wallet_not_funded' };
    }

    const recipient = a['recipient'];
    const amountMicroCcd = a['amountMicroCcd'];
    const context = typeof a['context'] === 'string' ? a['context'] : '';
    if (typeof recipient !== 'string' || typeof amountMicroCcd !== 'string' || !/^\d+$/.test(amountMicroCcd)) {
      return { ok: false, skill: name, error: 'invalid_arguments', code: 'invalid_arguments' };
    }
    if (BigInt(amountMicroCcd) <= 0n) return { ok: false, skill: name, error: 'invalid_amount', code: 'invalid_amount' };

    if (!this.permissions) return { ok: false, skill: name, error: 'permission_service_unavailable', code: 'service_unavailable' };
    if (!this.payments) return { ok: false, skill: name, error: 'payment_service_unavailable', code: 'service_unavailable' };

    // Route through the existing pipeline (permission gate + x402 authorizePayment).
    const result = await this.payments.execute({
      ownerWalletAddress: ctx.ownerWalletAddress,
      agentId: ctx.agentId,
      network: ctx.network,
      recipient,
      amountMicroCcd,
      context,
      approvalToken: typeof a['approvalToken'] === 'string' ? a['approvalToken'] : null,
    });
    if (!result.ok) {
      const reason = (result.reason ?? 'payment_failed').replace(/^permission:\s*/, '');
      return { ok: false, skill: name, error: reason, code: reason };
    }
    return { ok: true, skill: name, data: { state: 'executed', receipt: result.receipt ?? null } };
  }

  private requestApproval(ctx: SkillContext, name: string, a: Record<string, unknown>): Promise<SkillResult> {
    const r = this.resolveWallet(ctx);
    if (!r.ok) return Promise.resolve({ ok: false, skill: name, error: r.error, code: r.code });
    if (r.wallet.status === 'revoked') return Promise.resolve({ ok: false, skill: name, error: 'wallet_revoked', code: 'wallet_revoked' });
    if (r.wallet.status === 'paused') return Promise.resolve({ ok: false, skill: name, error: 'wallet_paused', code: 'wallet_paused' });
    if (r.wallet.status === 'recovery_required') return Promise.resolve({ ok: false, skill: name, error: 'wallet_recovery_required', code: 'wallet_recovery_required' });
    if (!this.permissions) return Promise.resolve({ ok: false, skill: name, error: 'permission_service_unavailable', code: 'service_unavailable' });

    const recipient = a['recipient'];
    const amountMicroCcd = a['amountMicroCcd'];
    const context = typeof a['context'] === 'string' ? a['context'] : '';
    if (typeof recipient !== 'string' || typeof amountMicroCcd !== 'string' || !/^\d+$/.test(amountMicroCcd)) {
      return Promise.resolve({ ok: false, skill: name, error: 'invalid_arguments', code: 'invalid_arguments' });
    }

    const approval = this.permissions.requestApproval({
      walletAddress: ctx.ownerWalletAddress,
      agentId: ctx.agentId,
      network: ctx.network,
      recipient,
      amountMicroCcd,
      context,
    });
    // An approval request is NOT payment authorization; the owner must still approve.
    return Promise.resolve({ ok: true, skill: name, data: { approvalId: approval.id, status: approval.status, expiresAt: approval.expiresAt } });
  }
}

// ── serialisers (public data only) ──────────────────────────────────────────

function serialiseStatus(w: WalletRecord) {
  return {
    walletId: w.walletId,
    agentId: w.agentId,
    ownerWalletAddress: w.ownerWalletAddress,
    network: w.network,
    genesisHash: w.genesisHash,
    accountAddress: w.accountAddress,
    lifecycle: w.status,
    fundingStatus: w.fundingStatus,
    balanceMicroCcd: w.balanceMicroCcd,
    onChainAccount: w.accountAddress !== null,
    locallyProvisionedOnly: w.accountAddress === null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function serialisePermissions(
  p: ReturnType<PermissionManager['getPermission']>,
  ctx: SkillContext,
  _manager: PermissionManager,
) {
  if (!p) {
    return {
      agentId: ctx.agentId,
      network: ctx.network,
      granted: false,
      enabled: false,
      paused: false,
      revoked: false,
      policy: null,
      limits: null,
      recipientAllowlist: null,
      note: 'payment permission is disabled until the owner explicitly grants it',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const dayKey = new Date(now * 1000).toISOString().slice(0, 10);
  const spentToday = p.dailySpent.get(dayKey) ?? 0n;
  const dailyRemaining = p.limits.dailyMicroCcd === null ? null : (p.limits.dailyMicroCcd - spentToday).toString();
  return {
    agentId: ctx.agentId,
    network: ctx.network,
    granted: p.enabled && !p.revoked,
    enabled: p.enabled,
    paused: p.paused,
    revoked: p.revoked,
    policy: p.policy,
    limits: {
      perTxMicroCcd: p.limits.perTxMicroCcd === null ? null : p.limits.perTxMicroCcd.toString(),
      dailyMicroCcd: p.limits.dailyMicroCcd === null ? null : p.limits.dailyMicroCcd.toString(),
      periodMicroCcd: p.limits.periodMicroCcd === null ? null : p.limits.periodMicroCcd.toString(),
      periodSeconds: p.limits.periodSeconds,
    },
    recipientAllowlist: p.recipientAllowlist,
    spentTodayMicroCcd: spentToday.toString(),
    dailyRemainingMicroCcd: dailyRemaining,
  };
}

/** Wallet events are already secret-free; this is a second, explicit redaction pass. */
function redactEvent(e: { at: number; walletId: string; agentId: string; ownerWalletAddress: string; network: string; event: string; detail: string }) {
  return {
    at: e.at,
    walletId: e.walletId,
    agentId: e.agentId,
    network: e.network,
    event: e.event,
    detail: /private|seed|mnemonic|signKey|secret/i.test(e.detail) ? '[redacted]' : e.detail,
  };
}
