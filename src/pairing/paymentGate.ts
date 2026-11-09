/**
 * Payment gate adapter: binds the permission manager to the payment path.
 *
 * Turns the `PermissionManager` into the three callbacks `authorizePayment`
 * consumes (`permissionCheck`, `onSettleSuccess`, `onSettleFail`, `onAmbiguous`),
 * so the permission gate is wired into the real payment path rather than being
 * re-implemented per caller.
 *
 * Reservation semantics:
 *   - `permissionCheck` runs synchronously inside `authorizePayment` BEFORE any
 *     facilitator call, so concurrent requests cannot interleave between the limit
 *     check and the reservation.
 *   - success  → reservation becomes recorded spending (`finalizeReservation`)
 *   - definite failure (verify rejected, preflight, unknown error) → released
 *   - ambiguous (settle threw, timeout, success without a hash) → retained
 */

import type { PermissionManager } from './permissions.js';

export interface PaymentGateParams {
  walletAddress: string;
  agentId: string;
  network: string;
  recipient: string;
  amountMicroCcd: string;
  /** Single-use manual-approval token, required when the policy is `manual`. */
  approvalToken?: string | null;
  /** Request context bound into the approval parameter hash. */
  context?: string;
}

export interface PaymentGate {
  permissionCheck: (params: { recipient: string; amountMicroCcd: string; network: string; nowSeconds: number }) =>
    | { ok: true; reservationId?: string }
    | { ok: false; reason: string };
  onSettleSuccess: (reservationId: string) => void;
  onSettleFail: (reservationId: string) => void;
  onAmbiguous: (reservationId: string) => void;
}

/**
 * Bind a manager to one specific (wallet, agent) payment attempt.
 *
 * The gate refuses to build when the caller's stated network does not match the
 * manager's record: a mismatched gate would silently check the wrong permission.
 */
export function createPaymentGate(
  manager: PermissionManager,
  params: PaymentGateParams,
): { ok: true; gate: PaymentGate } | { ok: false; reason: string } {
  if (!manager.isAvailable()) return { ok: false, reason: 'permission_store_unavailable' };

  const key = { walletAddress: params.walletAddress, agentId: params.agentId, network: params.network };
  const gate: PaymentGate = {
    permissionCheck: (p) => {
      // Every payment in this call must be for the same recipient/amount the gate
      // was built for; a differing value means the caller changed the terms.
      if (p.network !== params.network) return { ok: false, reason: 'wrong_network' };
      if (p.recipient !== params.recipient) return { ok: false, reason: 'recipient_mismatch' };
      if (p.amountMicroCcd !== params.amountMicroCcd) return { ok: false, reason: 'amount_mismatch' };

      // Full gate (limits, allowlist, approval policy) then reserve.
      const allowed = manager.isPaymentAllowed({
        ...key,
        recipient: p.recipient,
        amountMicroCcd: p.amountMicroCcd,
        approvalToken: params.approvalToken ?? null,
        context: params.context ?? '',
      });
      if (!allowed.ok) return { ok: false, reason: allowed.reason ?? 'not_allowed' };

      const reserved = manager.checkAndReserve({
        ...key,
        recipient: p.recipient,
        amountMicroCcd: p.amountMicroCcd,
      });
      if (!reserved.ok) return { ok: false, reason: reserved.reason ?? 'reserve_failed' };
      return { ok: true, reservationId: reserved.reservationId };
    },
    onSettleSuccess: (id) => {
      manager.finalizeReservation(key.walletAddress, key.agentId, key.network, id);
    },
    onSettleFail: (id) => {
      manager.releaseReservation(key.walletAddress, key.agentId, key.network, id);
    },
    onAmbiguous: (id) => {
      manager.retainReservation(key.walletAddress, key.agentId, key.network, id);
    },
  };

  return { ok: true, gate };
}
