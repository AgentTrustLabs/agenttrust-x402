/**
 * Production provider verification — the adapter between the Discovery
 * registry and the existing `verifyAgent` implementation.
 *
 * This module contains NO verification logic of its own. It only wires the
 * pieces that already exist:
 *
 *   1. Registry record: `agent_of` on the hosted Concordium Agent Registry
 *      MCP (`src/registry/mcpClient.ts`), by the provider's CIS-8004 token id.
 *   2. Identity verification: `verifyAgent` (`src/verify/crossAgent.ts`) —
 *      the same function the MCP `trust.verify` tool and the `agenttrust
 *      verify` CLI already use. It fetches the provider's Agent Card from
 *      the registry's `agent_uri` over the pinned transport, recomputes
 *      SHA-256 locally over the exact response bytes, and compares hash,
 *      owner, status and contract references against the on-chain record.
 *   3. Decision mapping: TRUSTED → verified, REJECTED → rejected,
 *      INCONCLUSIVE → unverified. Any error or timeout is INCONCLUSIVE.
 *
 * Invariants (the reason this adapter exists as a separate, small module):
 *   - Only a TRUSTED verdict from `verifyAgent` can produce `verified`.
 *     There is no fallback, no "close enough", no upgrade path. A failed
 *     card fetch, a timed-out MCP call, a malformed record, a missing
 *     `agent_uri` — all of them are INCONCLUSIVE, never TRUSTED.
 *   - The card is fetched from the provider's own published `agent_uri`.
 *     The adapter never substitutes a local copy of a card: that would be
 *     verifying a claim against evidence the provider did not publish.
 *   - No credential is stored or displayed. The adapter handles only public
 *     data: token ids, account addresses, card URLs, hashes.
 *   - The default transport is the pinned one (`verifyAgent` with no
 *     `fetchImpl`). Callers that need a different transport (tests, a
 *     proxy-aware environment) inject it explicitly; the default never
 *     silently downgrades.
 *
 * Token 1004, the Agent Card URI, the registry and the metadata hash are
 * never modified here. This adapter only READS them.
 */

import { AgentRegistryMcp } from '../registry/mcpClient.js';
import { verifyAgent, type TrustResult } from '../verify/crossAgent.js';
import { TESTNET } from '../core/types.js';
import type { ServiceProviderIdentity } from './registry.js';

/** The CIS-8004 / CIS-8 contract coordinates on Concordium Testnet. */
export const TESTNET_CIS8004 = '12802.0';
export const TESTNET_CIS8 = '12801.0';

/** Bound on one card fetch (the same default `verifyAgent` uses). */
export const DEFAULT_CARD_TIMEOUT_MS = 10_000;
/** Bound on the whole verification (registry lookup + card fetch + checks). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

export type VerifierDecision = 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';

export interface ProductionVerifierOptions {
  /** Registry MCP base URL. Default the Testnet registry. */
  mcpBase?: string;
  /**
   * Injected registry client (tests). Must expose `callToolRaw(name, args)`.
   * When omitted, a real `AgentRegistryMcp` is constructed.
   */
  mcp?: { callToolRaw<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> };
  /**
   * Injected fetch for the card (tests, proxy-aware environments). When
   * omitted, `verifyAgent` uses its pinned transport. Passing a fetch does
   * NOT change the verdict rules — only the transport.
   */
  fetchImpl?: Parameters<typeof verifyAgent>[0]['fetchImpl'];
  /** Bound on one card fetch, in ms. */
  cardTimeoutMs?: number;
  /** Bound on the whole verification, in ms. */
  timeoutMs?: number;
  /** Permit private/loopback `agent_uri` targets (local registries only). */
  allowPrivateCardHosts?: boolean;
}

export type ProductionVerifier = (provider: ServiceProviderIdentity) => Promise<{
  decision: VerifierDecision;
  reason?: string;
}>;

/**
 * Build the production verifier. The returned function is what the registry
 * calls as its injected verifier (`registry.verifyProvider(id, verifier)`).
 */
export function createProductionVerifier(opts: ProductionVerifierOptions = {}): ProductionVerifier {
  const mcpBase = opts.mcpBase ?? TESTNET.mcpUrl;
  const cardTimeoutMs = opts.cardTimeoutMs ?? DEFAULT_CARD_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  return async (provider) => {
    const run = (async (): Promise<{ decision: VerifierDecision; reason?: string }> => {
      let record: unknown;
      try {
        const mcp = opts.mcp ?? new AgentRegistryMcp(mcpBase, 'testnet');
        record = await mcp.callToolRaw('agent_of', { token_id: provider.tokenId });
      } catch (e) {
        // The registry could not be consulted. That is unavailability, not a
        // contradiction — and it is never a reason to trust the provider.
        return { decision: 'INCONCLUSIVE', reason: `registry lookup failed: ${(e as Error).message}` };
      }

      let result: TrustResult;
      try {
        result = await verifyAgent({
          expect: {
            network: TESTNET.caip2,
            cis8004: TESTNET_CIS8004,
            cis8: TESTNET_CIS8,
            tokenId: provider.tokenId,
            ownerAccount: provider.ownerAccount,
          },
          discoveryPayload: { agents: [record] },
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          cardTimeoutMs,
          ...(opts.allowPrivateCardHosts ? { allowPrivateCardHosts: true } : {}),
        });
      } catch (e) {
        return { decision: 'INCONCLUSIVE', reason: `verification could not run: ${(e as Error).message}` };
      }

      if (result.trust_decision === 'TRUSTED') {
        return { decision: 'TRUSTED', reason: 'provider Agent Card passed full verification (TRUSTED)' };
      }
      if (result.trust_decision === 'REJECTED') {
        const reqs = result.failed_requirements.join(', ') || 'unspecified';
        return { decision: 'REJECTED', reason: `verification contradicted the provider identity (${reqs})` };
      }
      // INCONCLUSIVE: evidence could not be established. Name the kind so an
      // operator can tell "the card was unreachable" from "the card lied".
      const kind = result.failure_kind === 'contradiction' ? 'contradiction' : 'unavailable';
      return {
        decision: 'INCONCLUSIVE',
        reason: `verification evidence could not be established (${kind}: ${result.failure_kind === 'unavailable' ? 'card or registry unavailable' : 'see failed requirements'})`,
      };
    })();

    // Total deadline. A hung registry call or a slow-drip card fetch must not
    // block the operator forever — and a timeout is unavailability, never trust.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<{ decision: 'INCONCLUSIVE'; reason: string }>((resolve) => {
          timer = setTimeout(
            () => resolve({ decision: 'INCONCLUSIVE', reason: `verification exceeded the ${timeoutMs}ms deadline` }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
