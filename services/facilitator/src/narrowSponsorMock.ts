/**
 * Mock-only NarrowSponsorSigner.
 *
 * Enforces the authorization boundary and persists a durable audit event for every decision.
 * It does NOT sign. There is no `AccountSigner` implementation here, and no code path in this
 * module can produce a signature.
 *
 * Fail-closed: if the audit write throws, `authorize()` returns `{approved:false,
 * reason:'audit_write_failed'}` — approval is never granted without a durable event.
 */

import type { SettlementRepository } from './repository.js';
import {
  decideAuthorization,
  type NarrowSponsorSigner,
  type SponsorAuthorizationRequest,
  type SponsorAuthorizationResult,
  type SponsorPolicy,
} from './narrowSponsor.js';

export class MockNarrowSponsorSigner implements NarrowSponsorSigner {
  readonly policyVersion: string;
  private readonly policy: SponsorPolicy;
  private readonly repo: SettlementRepository;
  private readonly now: () => number;

  constructor(deps: { policy: SponsorPolicy; repository: SettlementRepository; now?: () => number }) {
    this.policy = deps.policy;
    this.repo = deps.repository;
    this.now = deps.now ?? (() => Date.now());
    this.policyVersion = deps.policy.policyVersion;
  }

  async authorize(request: SponsorAuthorizationRequest): Promise<SponsorAuthorizationResult> {
    // Run the deterministic policy decision first (pure, no I/O). This never touches the DB.
    const decision = decideAuthorization(request, this.policy, Math.floor(this.now() / 1000));

    // Atomically verify durable state + persist the audit event. The DB is the
    // authoritative source — caller-supplied paymentState / tx_hash are never trusted.
    let result: ReturnType<typeof this.repo.authorizeSignEvent>;
    try {
      result = this.repo.authorizeSignEvent({
        paymentDigest: request.paymentDigest,
        decision: decision.approved ? 'approved' : 'rejected',
        reason: decision.reason ?? null,
        network: request.network,
        sender: request.sender,
        sponsor: request.sponsor,
        recipient: request.recipient,
        energy: String(request.energy),
        policyVersion: this.policyVersion,
        // Bind the full payment context into the durable record so recovery can
        // prove the context matches. A caller cannot omit these without the record being
        // unusable for recovery.
        asset: request.asset,
        amount: request.amount,
        expiry: request.expiry,
        // Task 11 — bind the exact transaction the approval covers.
        transactionDigest: request.transactionDigest,
        transactionType: request.transactionType,
        maxEnergy: String(this.policy.maxEnergy),
        maxFeeMicroCcd: request.maxFeeMicroCcd,
      });
    } catch (e) {
      // Unexpected DB error — fail closed.
      return {
        approved: false,
        reason: 'audit_write_failed',
        detail: `could not persist sign event: ${(e as Error)?.message ?? e}`,
      };
    }

    // State-based rejection (unknown payment, non-created, prepared hash, duplicate approval).
    if (!result.ok) {
      return {
        approved: false,
        reason: result.reason,
        detail: `durable-state gate: ${result.reason}`,
      };
    }

    // Policy-based rejection (audit event already recorded).
    if (!decision.approved) {
      return { approved: false, reason: decision.reason, detail: decision.detail };
    }

    // Approved: carry the authorization id so the caller (the Owner) can
    // issue the certificate under it. An approval without a transaction
    // binding cannot be certified — the caller must fail closed on a null id
    // when the request carried a transaction digest.
    return { approved: true, authorizationId: result.authorizationId };
  }
}
