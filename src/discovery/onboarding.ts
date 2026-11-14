/**
 * Internal provider onboarding — the single, controlled path that takes a
 * provider submission from input to a discoverable service.
 *
 * This is the ONLY path a new provider should enter Discovery through.
 * It composes the pieces that already exist (registry, validation,
 * provider verification) in the one safe order:
 *
 *   1. Validate the submission. An incomplete or malformed input is
 *      rejected and nothing is registered.
 *   2. Register the service as INACTIVE. It is not discoverable and not
 *      payable while its identity is unverified — registration always
 *      creates an 'inactive' service (the activation policy removed
 *      the status field, so there is no value that could smuggle an
 *      active service in), and activation happens only through
 *      `setStatus` after a TRUSTED verification.
 *   3. Verify the provider identity (CIS-8004 Agent Card, via the
 *      injected verifier — the production verifier in the CLI, a stub in
 *      tests). A provider with no Agent Card is never verified.
 *   4. Activate ONLY when verification returns TRUSTED. A REJECTED or
 *      INCONCLUSIVE (unverified) outcome leaves the service inactive,
 *      and if it was somehow active before (e.g. verified and activated
 *      by an earlier onboarding run, then re-verified and no longer
 *      TRUSTED), onboarding deactivates it — fail-closed.
 *
 * Re-running onboarding for the same provider is idempotent: an already
 * verified + active service is returned as already onboarded, and an
 * inactive service with identical content is verified again. A service
 * id that already exists with DIFFERENT content is a conflict, never a
 * silent overwrite.
 *
 * Registration is operator-side only. There is no public registration
 * endpoint, no MCP registration tool, and this module never touches the
 * network, keys, signing, settlement, or payments. It only reads the
 * provider's public Agent Card (through the verifier) and writes to the
 * operator's registry.
 */

import type {
  ProviderVerification,
  ServiceProviderIdentity,
  ServiceRecord,
  ServiceRegistrationInput,
  ServiceRegistry,
} from './registry.js';

/** The verifier shape `ServiceRegistry.verifyProvider` accepts. */
export type OnboardVerifier = (
  provider: ServiceProviderIdentity,
) => Promise<{ decision: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE'; reason?: string }>;

export interface OnboardResult {
  /** True when the flow completed (register + a verification attempt ran). */
  ok: boolean;
  service: ServiceRecord | null;
  verification: ProviderVerification | null;
  /** True only when the service is verified AND active after onboarding. */
  activated: boolean;
  /** One-line outcome, safe to show to the operator. */
  reason: string;
  /** Validation / conflict errors, when ok is false. */
  errors?: string[];
}

export interface OnboardOptions {
  actor?: string;
}

/**
 * Run the onboarding flow for one provider submission.
 *
 * `input` is the same shape the operator CLI `register` accepts. The
 * registry always registers as 'inactive' (there is no status field to
 * smuggle an active service past verification), so onboarding activates
 * only through `setStatus` after a TRUSTED verification.
 */
export async function onboardProvider(
  registry: ServiceRegistry,
  input: ServiceRegistrationInput,
  verifier: OnboardVerifier,
  opts: OnboardOptions = {},
): Promise<OnboardResult> {
  const actor = opts.actor ?? 'operator';

  // 1–2. Register as INACTIVE. `register` validates the input, always
  // creates an inactive service, and handles duplicates: identical
  // content is an idempotent no-op (the existing service is returned),
  // different content under the same id is a conflict. Nothing is
  // registered when validation fails.
  const registered = registry.register(input, { actor });
  if (!registered.ok) {
    return {
      ok: false,
      service: null,
      verification: null,
      activated: false,
      reason: 'registration failed',
      errors: registered.errors,
    };
  }
  const service = registered.service;

  // Already onboarded: verified and active. Re-running onboarding is a
  // no-op success — there is nothing left to verify or activate.
  if (service.providerVerification.status === 'verified' && service.status === 'active') {
    return {
      ok: true,
      service,
      verification: service.providerVerification,
      activated: true,
      reason: 'already onboarded: provider verified and service active',
    };
  }

  // 3. Verify the provider identity. This is the only step that consults
  // an external source (the registry MCP + the Agent Card, through the
  // injected verifier). A provider with no Agent Card returns
  // 'unverified' here without the verifier ever being called.
  const verified = await registry.verifyProvider(service.id, verifier, { actor });
  if (!verified.ok) {
    return {
      ok: false,
      service,
      verification: null,
      activated: false,
      reason: `verification could not run: ${verified.error}`,
    };
  }
  const verification = verified.service.providerVerification;

  // 4. Activate ONLY on TRUSTED. The registry guard refuses activation
  // for any other verification status, so this call succeeds exactly
  // when verification is TRUSTED. If it somehow fails, onboarding
  // reports the failure instead of claiming the service is active.
  if (verification.status === 'verified') {
    const activated = registry.setStatus(service.id, 'active', { actor });
    if (!activated.ok) {
      return {
        ok: false,
        service: registry.get(service.id) ?? null,
        verification,
        activated: false,
        reason: `activation failed after verification: ${activated.error}`,
      };
    }
    return {
      ok: true,
      service: activated.service,
      verification,
      activated: true,
      reason: 'provider verified and service activated',
    };
  }
  // Anything else leaves the service inactive. `verifyProvider` already
  // deactivated it if it was active and the verification stopped being
  // TRUSTED, so there is nothing left to do here — but the guard is
  // belt-and-braces: ensure it is inactive before reporting.
  const current = registry.get(service.id)!;
  if (current.status === 'active') {
    registry.setStatus(service.id, 'inactive', { actor });
  }
  const finalService = registry.get(service.id)!;
  return {
    ok: true,
    service: finalService,
    verification,
    activated: false,
    reason: `provider not verified (${verification.status}): ${verification.reason ?? 'no reason given'} — service left inactive`,
  };
}
