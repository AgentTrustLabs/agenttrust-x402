/**
 * Agent Wallet x402 integration.
 *
 * Binds the Agent Wallet Skills to the HTTP x402 provider. The agent never
 * supplies amount, recipient, network, or resource: those come from the provider's
 * 402 challenge and are bound into the payment payload before permission authorization.
 *
 * Flow:
 *   provider.challenge() → 402 body
 *     → parse accepts[0] (requirement) + resource.url
 *     → WalletSkills.wallet_get_status (trusted context)
 *     → lifecycle + funding gates
 *     → createProviderPaymentExecutor (permission gate + authorizePayment)
 *     → provider.handlePayment(X-PAYMENT header)  ← independent on-chain verification
 *     → 200 resource | 402 | 409 replay | 503 unavailable
 *
 * The provider's verification and replay store are reused unchanged. This
 * module adds no settlement path and no signer.
 */

import { randomBytes } from 'node:crypto';
import type { PaymentRequirements } from '@x402/core/types';
import type { X402Provider, ProviderOutcome } from '../x402/provider.js';
import type { WalletSkills, SkillContext } from './walletSkills.js';
import type { PermissionManager } from './permissions.js';
import { createPaymentGate } from './paymentGate.js';
import { authorizePayment, type ConsumerFacilitator } from '../payments/x402.js';

export interface ParsedRequirement {
  resourceUrl: string;
  requirements: PaymentRequirements;
}

/** Parse the 402 challenge body into the exact requirement + resource binding. */
export function parseProviderChallenge(challenge: unknown): ParsedRequirement | null {
  if (!challenge || typeof challenge !== 'object') return null;
  const c = challenge as Record<string, unknown>;
  if (c['x402Version'] !== 2) return null;
  const resource = c['resource'] as { url?: unknown } | undefined;
  if (!resource || typeof resource.url !== 'string' || resource.url.length === 0) return null;
  const accepts = c['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const req = accepts[0] as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object') return null;
  if (req['scheme'] !== 'exact') return null;
  if (typeof req['network'] !== 'string') return null;
  if (typeof req['amount'] !== 'string' || !/^\d+$/.test(req['amount'])) return null;
  if (typeof req['payTo'] !== 'string') return null;
  if (req['asset'] !== 'CCD') return null;
  return { resourceUrl: resource.url, requirements: req as unknown as PaymentRequirements };
}

export interface ProviderPaymentResult {
  ok: boolean;
  code?: string;
  reason?: string;
  payload?: unknown;
}

export interface ProviderPaymentExecutor {
  execute(args: {
    ctx: SkillContext;
    requirement: PaymentRequirements;
    resourceUrl: string;
    requestId: string;
  }): Promise<ProviderPaymentResult>;
}

export interface ProviderPaymentExecutorOptions {
  permissions: PermissionManager;
  facilitator: ConsumerFacilitator;
  createPaymentPayload: (requirements: PaymentRequirements) => Promise<unknown>;
  nowSeconds?: () => number;
}

/**
 * Build the X-PAYMENT payload bound to the provider's exact requirement and run it
 * through the existing permission gate + authorizePayment. The amount, recipient, network,
 * and resource are taken from the requirement, never from the agent.
 */
export function createProviderPaymentExecutor(opts: ProviderPaymentExecutorOptions): ProviderPaymentExecutor {
  return {
    async execute(args) {
      const gate = createPaymentGate(opts.permissions, {
        walletAddress: args.ctx.ownerWalletAddress,
        agentId: args.ctx.agentId,
        network: args.requirement.network,
        recipient: args.requirement.payTo,
        amountMicroCcd: String(args.requirement.amount),
        context: args.resourceUrl,
      });
      if (!gate.ok) return { ok: false, code: gate.reason, reason: gate.reason };

      let innerPayload: unknown;
      try {
        innerPayload = await opts.createPaymentPayload(args.requirement);
      } catch (e) {
        return { ok: false, code: 'payload_error', reason: (e as Error).message };
      }

      const payload = {
        x402Version: 2,
        accepted: args.requirement,
        payload: innerPayload,
        resource: { url: args.resourceUrl },
        requestId: args.requestId,
      };

      const decision = await authorizePayment({
        facilitator: opts.facilitator,
        paymentPayload: payload,
        requirements: args.requirement,
        settle: true,
        audit: { agentId: args.ctx.agentId, resource: args.resourceUrl, requestId: args.requestId },
        ...(opts.nowSeconds ? { nowSeconds: opts.nowSeconds() } : {}),
        permissionCheck: gate.gate.permissionCheck,
        onSettleSuccess: gate.gate.onSettleSuccess,
        onSettleFail: gate.gate.onSettleFail,
        onAmbiguous: gate.gate.onAmbiguous,
      });
      if (!decision.granted) {
        const reason = String(decision.reason ?? 'payment_failed').replace(/^permission:\s*/, '');
        return { ok: false, code: reason, reason: decision.reason };
      }
      return { ok: true, payload };
    },
  };
}

export interface AgentWalletX402ClientOptions {
  skills: WalletSkills;
  executor: ProviderPaymentExecutor;
  requestIdFactory?: () => string;
}

/**
 * Agent-facing client: request a protected resource through the assigned wallet.
 * The agent supplies only the trusted context; every payment term comes from the
 * provider's 402 challenge.
 */
export class AgentWalletX402Client {
  private readonly skills: WalletSkills;
  private readonly executor: ProviderPaymentExecutor;
  private readonly requestIdFactory: () => string;

  constructor(opts: AgentWalletX402ClientOptions) {
    this.skills = opts.skills;
    this.executor = opts.executor;
    this.requestIdFactory = opts.requestIdFactory ?? (() => randomBytes(16).toString('hex'));
  }

  async requestAccess(provider: X402Provider, ctx: SkillContext): Promise<ProviderOutcome> {
    // 1. provider challenge
    const challenge = provider.challenge();
    const parsed = parseProviderChallenge(challenge);
    if (!parsed) {
      return { status: 400, body: { error: 'malformed_requirement' }, reason: 'malformed' };
    }

    // 2. trusted wallet resolution + lifecycle/funding gates
    const status = await this.skills.invoke(ctx, 'wallet_get_status', {});
    if (!status.ok) {
      return { status: 402, body: { error: status.code }, reason: 'unpaid' };
    }
    const wallet = status.data as {
      lifecycle: string;
      onChainAccount: boolean;
      locallyProvisionedOnly: boolean;
    };
    if (wallet.lifecycle !== 'active' || !wallet.onChainAccount || wallet.locallyProvisionedOnly) {
      return {
        status: 402,
        body: { error: 'wallet_not_funded', lifecycle: wallet.lifecycle, onChainAccount: wallet.onChainAccount },
        reason: 'unpaid',
      };
    }

    // 3. execute through the provider-bound executor (permission gate + authorizePayment)
    const requestId = this.requestIdFactory();
    const paid = await this.executor.execute({
      ctx,
      requirement: parsed.requirements,
      resourceUrl: parsed.resourceUrl,
      requestId,
    });
    if (!paid.ok) {
      return { status: 402, body: { error: paid.code, reason: paid.reason }, reason: 'unpaid' };
    }

    // 4. provider independent verification — never trust the client
    return provider.handlePayment(JSON.stringify(paid.payload));
  }
}
