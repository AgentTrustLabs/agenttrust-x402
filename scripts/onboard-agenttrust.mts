/**
 * Onboard the AgentTrust first-provider service into a discovery registry.
 *
 * Operator-side only. Runs the controlled onboarding flow
 * (`onboardAgentTrustService` → register as inactive → verify through the
 * production verifier → activate only on TRUSTED) against a SQLite
 * discovery database, then prints the resulting service view as JSON.
 *
 * The production verifier reads only public data: the Concordium Agent
 * Registry MCP record for Token #1004 and the published Agent Card at
 * its `agent_uri`. It never modifies Token #1004, the card, the URI, or
 * the metadata hash, and this script never signs, settles, broadcasts,
 * or spends CCD. A verification that comes back REJECTED or
 * INCONCLUSIVE leaves the service inactive — and this script exits 1,
 * because the point is a discoverable service, not a registered row.
 *
 * Re-running the script is idempotent: an already onboarded service is
 * reported as already onboarded, nothing is rewritten.
 *
 * Env:
 *   AGENTTRUST_DISCOVERY_DB      database path. REQUIRED unless
 *                                AGENTTRUST_ALLOW_PRODUCTION_DB=1 is set:
 *                                without it the script refuses to run,
 *                                so a bare invocation can never write to
 *                                the production registry by accident.
 *                                Point it at a throwaway file to verify
 *                                locally.
 *   AGENTTRUST_ALLOW_PRODUCTION_DB  set to '1' to deliberately use the
 *                                production registry
 *                                (/home/hatch/agenttrust-state/discovery.db,
 *                                the same file the CLI and the resource
 *                                server use). Production onboarding only.
 *   AGENTTRUST_SERVICE_ENDPOINT  explicit service endpoint URL. When
 *                                unset, AGENTTRUST_X402_PUBLIC_URL is
 *                                used when set, otherwise the loopback URL
 *                                built from AGENTTRUST_X402_HOST /
 *                                AGENTTRUST_X402_PORT /
 *                                AGENTTRUST_X402_RESOURCE_PATH
 *                                (defaults 127.0.0.1 / 4590 / /protected).
 *   AGENTTRUST_VERIFY_TIMEOUT_MS optional verification deadline (ms).
 *   AGENTTRUST_VERIFY_PROXY_FETCH  set to '1' only in an environment whose
 *                                egress goes through a proxy (this VM):
 *                                the production verifier then uses the
 *                                proxy-aware global fetch as its transport.
 *                                The verification checks are unchanged —
 *                                only the transport differs, and the choice
 *                                is explicit and logged, never silent.
 *                                Default (unset): the pinned transport.
 *
 * Run: npx tsx scripts/onboard-agenttrust.mts
 */

import { createServiceRegistry, toServiceView } from '../src/discovery/registry.js';
import { SqliteServiceStore } from '../src/discovery/store.js';
import { createProductionVerifier } from '../src/discovery/verify.js';
import { onboardAgentTrustService, AGENTTRUST_SERVICE_ID } from '../src/discovery/firstProvider.js';

const DEFAULT_DB = '/home/hatch/agenttrust-state/discovery.db';

function resolveEndpoint(): string {
  const explicit = process.env.AGENTTRUST_SERVICE_ENDPOINT?.trim();
  if (explicit) return explicit;
  const publicUrl = process.env.AGENTTRUST_X402_PUBLIC_URL?.trim();
  if (publicUrl) return publicUrl;
  const host = process.env.AGENTTRUST_X402_HOST?.trim() || '127.0.0.1';
  const port = process.env.AGENTTRUST_X402_PORT?.trim() || '4590';
  const path = process.env.AGENTTRUST_X402_RESOURCE_PATH?.trim() || '/protected';
  return `http://${host}:${port}${path}`;
}

async function main(): Promise<void> {
  // Fail-safe default: the production registry is used ONLY when the
  // operator says so explicitly. A bare invocation refuses to run
  // instead of silently writing to the production database — local
  // testing must always point at a throwaway file.
  const configuredDb = process.env.AGENTTRUST_DISCOVERY_DB?.trim();
  if (!configuredDb && process.env.AGENTTRUST_ALLOW_PRODUCTION_DB !== '1') {
    console.error(
      'AGENTTRUST_DISCOVERY_DB is not set. Refusing the production registry by default.\n' +
        'Set AGENTTRUST_DISCOVERY_DB to a database path (a throwaway file for local testing),\n' +
        `or set AGENTTRUST_ALLOW_PRODUCTION_DB=1 to deliberately use the production registry at ${DEFAULT_DB}.`,
    );
    process.exit(1);
  }
  const dbPath = configuredDb ?? DEFAULT_DB;
  const endpoint = resolveEndpoint();
  const timeoutMs = process.env.AGENTTRUST_VERIFY_TIMEOUT_MS
    ? Number(process.env.AGENTTRUST_VERIFY_TIMEOUT_MS)
    : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    console.error('AGENTTRUST_VERIFY_TIMEOUT_MS must be a positive integer');
    process.exit(1);
  }

  let registry;
  try {
    registry = createServiceRegistry(new SqliteServiceStore(dbPath));
  } catch (e) {
    console.error(`cannot open discovery database at ${dbPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    console.error(`onboarding ${AGENTTRUST_SERVICE_ID} (endpoint ${endpoint}) into ${dbPath}…`);
    const proxyFetch = process.env.AGENTTRUST_VERIFY_PROXY_FETCH === '1';
    if (proxyFetch) {
      console.error('verification transport: proxy-aware fetch (explicit opt-in for proxy-egress environments); verification checks unchanged');
    }
    const verifier = createProductionVerifier({
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(proxyFetch ? { fetchImpl: fetch } : {}),
    });
    const result = await onboardAgentTrustService(registry, verifier, endpoint, {
      actor: process.env.USER ?? 'operator',
    });
    if (!result.ok) {
      console.error('onboarding failed:');
      console.error(`  - ${result.reason}`);
      for (const e of result.errors ?? []) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          ...toServiceView(result.service!),
          onboarded: result.activated,
          verification: result.verification,
        },
        null,
        2,
      ),
    );
    console.error(`onboarding: ${result.reason}`);
    if (!result.activated) {
      console.error('service is registered but NOT discoverable: verification did not return TRUSTED');
      process.exit(1);
    }
  } finally {
    registry.close();
  }
}

main().catch((e) => {
  console.error('onboard-agenttrust failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
