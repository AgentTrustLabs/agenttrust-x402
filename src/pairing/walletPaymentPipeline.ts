/**
 * Payment executor wiring for `wallet_request_payment`.
 *
 * This is the seam between the skills layer and the EXISTING payment pipeline. It
 * does not implement a second payment path: it builds the x402 requirements with the
 * shared `buildPaymentRequirements`, builds the client payload with the injected
 * factory, and calls the existing `authorizePayment` with the permission
 * `createPaymentGate` callbacks.
 *
 * No signing, no settlement bypass, no private keys. The facilitator is injected;
 * in tests it is the shared mock, in production it is whatever the caller wired.
 */

import { buildPaymentRequirements } from '../payments/x402.js';
import { authorizePayment, type ConsumerFacilitator } from '../payments/x402.js';
import { createPaymentGate } from './paymentGate.js';
import type { PermissionManager } from './permissions.js';
import type { PaymentExecutor } from './walletSkills.js';

export interface WalletPaymentExecutorOptions {
  permissions: PermissionManager;
  facilitator: ConsumerFacilitator;
  /** Build the client payment payload for the given requirements. */
  createPaymentPayload: (requirements: ReturnType<typeof buildPaymentRequirements>) => Promise<unknown>;
  /** Optional fee payer / timeout overrides forwarded to the requirements. */
  feePayer?: string;
  maxTimeoutSeconds?: number;
  nowSeconds?: () => number;
}

export function createWalletPaymentExecutor(opts: WalletPaymentExecutorOptions): PaymentExecutor {
  return {
    async execute(args) {
      const gate = createPaymentGate(opts.permissions, {
        walletAddress: args.ownerWalletAddress,
        agentId: args.agentId,
        network: args.network,
        recipient: args.recipient,
        amountMicroCcd: args.amountMicroCcd,
        approvalToken: args.approvalToken,
        context: args.context,
      });
      if (!gate.ok) return { ok: false, reason: gate.reason };

      let requirements: ReturnType<typeof buildPaymentRequirements>;
      try {
        requirements = buildPaymentRequirements({
          payTo: args.recipient,
          amountMicroCcd: args.amountMicroCcd,
          resourceUrl: `agenttrust://agent/${args.agentId}/payment`,
          network: args.network,
          ...(opts.feePayer ? { feePayer: opts.feePayer } : {}),
          ...(opts.maxTimeoutSeconds ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
        });
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }

      let paymentPayload: unknown;
      try {
        paymentPayload = await opts.createPaymentPayload(requirements);
      } catch (e) {
        return { ok: false, reason: `payload: ${(e as Error).message}` };
      }

      const decision = await authorizePayment({
        facilitator: opts.facilitator,
        paymentPayload,
        requirements,
        settle: true,
        audit: { agentId: args.agentId, context: args.context },
        ...(opts.nowSeconds ? { nowSeconds: opts.nowSeconds() } : {}),
        permissionCheck: gate.gate.permissionCheck,
        onSettleSuccess: gate.gate.onSettleSuccess,
        onSettleFail: gate.gate.onSettleFail,
        onAmbiguous: gate.gate.onAmbiguous,
      });

      if (!decision.granted) return { ok: false, reason: decision.reason };
      return { ok: true, receipt: decision.receipt };
    },
  };
}
