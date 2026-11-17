/**
 * AgentTrust as its own first provider.
 *
 * The single definition of the first discoverable service:
 *
 *   - service id `svc_agenttrust_x402`
 *   - provider identity CIS-8004 Token #1004 (owner + Agent Card URI below)
 *   - Concordium Testnet, CCD, 1 microCCD per call, payTo the recipient of
 *     the verified live payments
 *
 * This module defines the service and the JSON it returns after a verified
 * payment. It never verifies anything itself: registration goes through
 * `onboardProvider` (register as inactive → verify → activate only on
 * TRUSTED), and payment goes through the x402 provider + facilitator.
 * The verifier is injected by the caller — the production verifier in the
 * operator script, a stub in tests. Nothing here fabricates a
 * verification status: a service that is not TRUSTED stays inactive and
 * undiscoverable, by the registry's own activation policy.
 *
 * Token #1004, the Agent Card URI and the metadata hash are never
 * modified here. This module only READS them.
 */

import { CCD_TESTNET_CAIP2 } from '../payments/x402.js';
import type {
  ServiceRecord,
  ServiceRegistrationInput,
  ServiceRegistry,
} from './registry.js';
import {
  onboardProvider,
  type OnboardResult,
  type OnboardVerifier,
} from './onboarding.js';

/** The first service id. Fixed: re-onboarding the same id is idempotent. */
export const AGENTTRUST_SERVICE_ID = 'svc_agenttrust_x402';

/** CIS-8004 token id of the AgentTrust provider agent. */
export const AGENTTRUST_TOKEN_ID = 1004;

/** Owner account of Token #1004 (from the live registry record). */
export const AGENTTRUST_OWNER_ACCOUNT =
  '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

/** Published Agent Card of Token #1004. */
export const AGENTTRUST_AGENT_URI =
  'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';

/** Payment recipient: the recipient of the verified live payments. */
export const AGENTTRUST_PAY_TO =
  '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';

/** Price per call, in microCCD (1 microCCD — the live payment amount). */
export const AGENTTRUST_AMOUNT_MICRO_CCD = '1';

/** Seconds a payment requirement stays valid. */
export const AGENTTRUST_MAX_TIMEOUT_SECONDS = 300;

/** Registry category for the service. */
export const AGENTTRUST_CATEGORY = 'utility';

/**
 * Build the registration input for the AgentTrust service.
 *
 * `endpoint` is the service's own URL — the URL an agent calls to reach
 * the paid endpoint (the resource server's canonical URL: the public URL
 * when the server runs behind a reverse proxy, otherwise the loopback
 * URL it binds). The caller supplies it; this module never guesses a
 * deployment URL, and the registry never fetches it.
 */
export function agenttrustServiceInput(endpoint: string): ServiceRegistrationInput {
  return {
    id: AGENTTRUST_SERVICE_ID,
    name: 'AgentTrust',
    description:
      'AgentTrust x402 service: discover, verify and pay Concordium Testnet services through the AgentTrust facilitator. One paid call returns the service descriptor with payment evidence.',
    category: AGENTTRUST_CATEGORY,
    endpoint,
    provider: {
      tokenId: AGENTTRUST_TOKEN_ID,
      ownerAccount: AGENTTRUST_OWNER_ACCOUNT,
      agentUri: AGENTTRUST_AGENT_URI,
    },
    network: CCD_TESTNET_CAIP2,
    pricing: {
      amountMicroCcd: AGENTTRUST_AMOUNT_MICRO_CCD,
      asset: 'CCD',
      payTo: AGENTTRUST_PAY_TO,
      maxTimeoutSeconds: AGENTTRUST_MAX_TIMEOUT_SECONDS,
      description: 'AgentTrust x402 service call — 1 microCCD per call',
    },
  };
}

/**
 * The JSON returned to a caller after a verified payment.
 *
 * Built only from the stored registry record: service facts, provider
 * identity, pricing, and the verification status the registry actually
 * holds. The payment proof (transaction hash, block hash, amount, asset,
 * payTo, network) is attached by the x402 provider itself, from the
 * facilitator settlement + the independent on-chain read — never from
 * this function. Nothing here is invented: a service that is not
 * verified reports its real verification status.
 */
export function agenttrustServiceResource(service: ServiceRecord): Record<string, unknown> {
  return {
    service: {
      id: service.id,
      name: service.name,
      description: service.description,
      category: service.category,
      endpoint: service.endpoint,
      network: service.network,
    },
    provider: {
      tokenId: service.provider.tokenId,
      ownerAccount: service.provider.ownerAccount,
      agentUri: service.provider.agentUri,
    },
    pricing: {
      amountMicroCcd: service.pricing.amountMicroCcd,
      asset: service.pricing.asset,
      payTo: service.pricing.payTo,
      maxTimeoutSeconds: service.pricing.maxTimeoutSeconds ?? AGENTTRUST_MAX_TIMEOUT_SECONDS,
      ...(service.pricing.description ? { description: service.pricing.description } : {}),
    },
    providerVerification: {
      status: service.providerVerification.status,
      ...(service.providerVerification.decision
        ? { decision: service.providerVerification.decision }
        : {}),
      ...(service.providerVerification.checkedAt
        ? { checkedAt: service.providerVerification.checkedAt }
        : {}),
    },
  };
}

/**
 * Onboard the AgentTrust service into a registry.
 *
 * Thin wrapper over `onboardProvider` with the first-provider input:
 * register as inactive → verify through the injected verifier → activate
 * only on TRUSTED. Re-running it for an already onboarded service is an
 * idempotent no-op success.
 */
export async function onboardAgentTrustService(
  registry: ServiceRegistry,
  verifier: OnboardVerifier,
  endpoint: string,
  opts: { actor?: string } = {},
): Promise<OnboardResult> {
  return onboardProvider(registry, agenttrustServiceInput(endpoint), verifier, opts);
}
