/**
 * CIS-8004 identity + Agent Card verifier for agent pairing.
 *
 * Thin adapter over the EXISTING `verifyAgent()` pipeline, which is the
 * independent-consumer verifier already used by the `trust.verify` MCP tool. The
 * pairing store stays free of network I/O; this module is the injected
 * `verifyAgentIdentity` implementation that a real deployment wires in.
 *
 * It deliberately fails closed: an unreadable registry, an unreachable card, or a
 * non-TRUSTED verdict is never treated as trust. No keys, no secrets, no
 * transactions.
 */

import { verifyAgent, type TrustResult, type VerifyInputs } from '../verify/crossAgent.js';
import type { AgentIdentityVerification } from './pairing.js';

/** The CIS-8004 / CIS-8 contract references a verifier must see on Testnet. */
const CIS8004 = '12802.0';
const CIS8 = '12801.0';

const CAIP2_BY_NETWORK: Record<string, string> = {
  testnet: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  mainnet: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
};

export interface AgentIdentityVerifierOptions {
  /**
   * Fetch the registry record for one agent. Production uses `AgentRegistryMcp`
   * (`agent_of`); tests inject a fixture. Must resolve the record shaped for
   * `parseDiscoveryResponse` (`{ agents: [record] }`) or throw.
   */
  discoverAgent: (network: string, tokenId: number) => Promise<unknown>;
  /** Fetch implementation for the Agent Card. Omit for the pinned production transport. */
  fetchImpl?: VerifyInputs['fetchImpl'];
  /** Require the registry owner to equal this account, when supplied. */
  expectOwner?: string;
  /** Bound on a single card fetch. */
  cardTimeoutMs?: number;
  /** Permit private/loopback agent_uri targets. Off by default. */
  allowPrivateCardHosts?: boolean;
}

/** Map a `verifyAgent` failure into a short, non-secret reason. */
function reasonOf(result: TrustResult): string {
  if (result.failure_kind === 'contradiction') {
    return `contradicted: ${result.failed_requirements.join(', ') || 'unspecified'}`;
  }
  return 'evidence_unavailable';
}

/**
 * Build the injected verifier consumed by `PairingStore.verifyAndPair`.
 * Returns `trusted: false` for anything other than a TRUSTED verdict.
 */
export function createAgentIdentityVerifier(opts: AgentIdentityVerifierOptions) {
  return async (agentId: string, network: string): Promise<AgentIdentityVerification> => {
    const tokenId = Number(agentId);
    if (!Number.isSafeInteger(tokenId) || tokenId < 1 || tokenId > 0xffffffff) {
      return { trusted: false, verdict: 'REJECTED', reason: 'agent_id is not a CIS-8004 token id' };
    }
    let result: TrustResult;
    try {
      const discoveryPayload = await opts.discoverAgent(network, tokenId);
      result = await verifyAgent({
        expect: {
          network: CAIP2_BY_NETWORK[network] ?? CAIP2_BY_NETWORK['testnet']!,
          cis8004: CIS8004,
          cis8: CIS8,
          tokenId,
          ...(opts.expectOwner ? { ownerAccount: opts.expectOwner } : {}),
        },
        discoveryPayload,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl as never } : {}),
        ...(opts.cardTimeoutMs !== undefined ? { cardTimeoutMs: opts.cardTimeoutMs } : {}),
        ...(opts.allowPrivateCardHosts ? { allowPrivateCardHosts: true } : {}),
      });
    } catch (e) {
      return { trusted: false, verdict: 'INCONCLUSIVE', reason: (e as Error)?.message ?? 'verification failed' };
    }
    if (result.trust_decision === 'TRUSTED') {
      return { trusted: true, verdict: 'TRUSTED' };
    }
    return { trusted: false, verdict: result.trust_decision, reason: reasonOf(result) };
  };
}
