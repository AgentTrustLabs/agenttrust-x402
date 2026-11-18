/**
 * Standalone HTTP x402 resource server (wiring layer).
 *
 * Serves ONE protected resource over plain HTTP on loopback, closing the loop
 * the facilitator alone cannot close:
 *
 *   GET /protected              → 402 + PaymentRequired challenge
 *   GET /protected + X-PAYMENT  → facilitator /verify + /settle, then an
 *                                  independent Testnet read, then 200 +
 *                                  PAYMENT-RESPONSE — or 400/402/409/503.
 *
 * Wiring (all reused, nothing re-implemented):
 *   - facilitator: the real self-hosted facilitator over HTTP
 *     (`createHttpFacilitator` → /verify + /settle; the envelope it posts is
 *     exactly what the facilitator core's `parseEnvelope` accepts)
 *   - chain: the real `ConcordiumChainVerifier` (genesis-bound, read-only)
 *   - gate: the real `createX402Provider` (preflight → verify → settle →
 *     on-chain read → atomic replay claim)
 *   - transport: `startX402ResourceServer` (no payment logic of its own)
 *
 * The sponsor address is NOT configured here: it is read from the
 * facilitator's own `/supported` announcement (`classifyCompatibility`),
 * so the requirement can never name a sponsor the facilitator does not serve.
 *
 * This process never signs, never holds keys, never constructs a transaction.
 * It only calls facilitator /verify + /settle and reads the chain.
 *
 * Env:
 *   AGENTTRUST_X402_HOST            default 127.0.0.1 (never expose publicly)
 *   AGENTTRUST_X402_PORT            default 4590
 *   AGENTTRUST_X402_FACILITATOR_MODE  default real. 'real' = the real
 *                                   facilitator + real chain verifier (the
 *                                   behavior below). 'mock' = a mock-only
 *                                   server for testing Discovery and the HTTP
 *                                   402 challenge WITHOUT a sponsor account,
 *                                   wallet, signing service, real facilitator,
 *                                   or any Concordium transaction. In mock
 *                                   mode the server:
 *                                     - does NOT probe a facilitator at startup
 *                                     - does NOT require a feePayer (the 402
 *                                       challenge names none — no fake sponsor
 *                                       address is ever invented)
 *                                     - uses mockFacilitator('ok') + a chain
 *                                       verifier that never reports a
 *                                       finalization, so a paid request can
 *                                       never unlock: the provider fails closed
 *                                       (503) at the on-chain read even after
 *                                       the mock "settles" it
 *                                     - never signs, settles, broadcasts, or
 *                                       transfers CCD (there is nothing to
 *                                       sign with and nowhere to send it)
 *                                   The mode is explicit: an invalid value
 *                                   fails startup with a clear error, and
 *                                   there is no automatic fallback from real
 *                                   to mock. The default (unset) is 'real'.
 *                                   Mock mode additionally requires the
 *                                   production-guard opt-in
 *                                   AGENTTRUST_X402_ALLOW_MOCK=1 (see
 *                                   src/x402/mockModeGuard.ts): without it,
 *                                   mock mode refuses to start, so a single
 *                                   mistyped or leaked mode variable can
 *                                   never put a production server into mock
 *                                   mode. The guard also refuses mock mode
 *                                   when NODE_ENV=production, and requires
 *                                   the bind host to be loopback
 *                                   (127.0.0.1, ::1, or localhost) — a
 *                                   non-loopback, empty, or ambiguous host
 *                                   is rejected fail-closed, before any
 *                                   probe or network I/O.
 *   AGENTTRUST_FACILITATOR_URL      default http://127.0.0.1:8787 (real mode only)
 *   AGENTTRUST_X402_PAY_TO          default 3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB
 *                                   (recipient of both verified live payments)
 *   AGENTTRUST_X402_AMOUNT          default 1 (microCCD)
 *   AGENTTRUST_X402_RESOURCE_PATH   default /protected
 *   AGENTTRUST_X402_PUBLIC_URL      optional: the public URL of this resource,
 *                                   e.g. https://api.sabokun.my.id/agenttrust/protected.
 *                                   When set, the 402 challenge and the provider's
 *                                   resource binding use it as the canonical URL;
 *                                   the server still binds loopback
 *                                   (AGENTTRUST_X402_HOST). The URL is validated
 *                                   at startup (absolute https:, valid hostname,
 *                                   no credentials/query/fragment, path must be
 *                                   the protected route, optionally under a
 *                                   reverse-proxy prefix); a bad value fails
 *                                   startup with a clear error. It is never
 *                                   derived from request headers. When unset,
 *                                   the loopback URL is used, as before.
 *   AGENTTRUST_X402_SENDER          optional: pin the expected sender
 *   AGENTTRUST_X402_SPONSOR         optional: pin the expected sponsor
 *   AGENTTRUST_CORS_ORIGINS         optional: comma-separated exact origins
 *                                   allowed to call the API cross-origin
 *                                   (the Vercel frontend), e.g.
 *                                   https://agenttrust.vercel.app,
 *                                   https://agenttrust-git-preview-xyz.vercel.app
 *                                   No `*`, no `*.vercel.app` wildcard: a
 *                                   wildcard or malformed entry fails
 *                                   startup. Unset = CORS disabled (the
 *                                   server behaves exactly as before).
 *                                   Applies to GET /api/services (+ detail)
 *                                   and GET /protected (+ OPTIONS preflight
 *                                   for both). No credentials are shared.
 *   AGENTTRUST_NODE_HOST            default grpc.testnet.concordium.com
 *   AGENTTRUST_NODE_PORT            default 20000
 *   AGENTTRUST_DISCOVERY_DB         default /home/hatch/agenttrust-state/discovery.db
 *                                   (persistent service registry; the same file
 *                                   the agenttrust-discovery CLI writes to)
 *   AGENTTRUST_AGENT_CARD_FILE      optional: absolute path to the Agent
 *                                   Card JSON (CIS-8004 Token #1004).
 *                                   Default: the repo's
 *                                   signing-site/.well-known/agent-card.json
 *                                   (resolved relative to this launcher).
 *                                   Served at /.well-known/agent-card.json;
 *                                   the reverse proxy strips its /agenttrust
 *                                   prefix and forwards the bare path.
 *
 * Run: npx tsx scripts/x402-resource-server.mts
 * Demo (needs a payer — see scripts/x402-pay.mts, live run needs separate
 * operator authorization):
 *   curl -i http://127.0.0.1:4590/protected            # 402
 *   curl -i http://127.0.0.1:4590/protected -H 'X-PAYMENT: {...}'  # 200/402/409/503
 */

import { TESTNET } from '../src/core/types.js';
import { probeFacilitator, classifyCompatibility } from '../src/payments/facilitator.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { createHttpFacilitator } from '../src/payments/x402Sdk.js';
import { createX402Provider, ReplayStore, type ChainVerifier, type ProviderFacilitatorPort } from '../src/x402/provider.js';
import { ConcordiumChainVerifier } from '../src/x402/concordiumChainVerifier.js';
import { startX402ResourceServer, resolveResourceUrl, resolveFacilitatorMode, resolveBindHost, createMockChainVerifier } from '../src/x402/resourceServer.js';
import { assertMockModeAllowed } from '../src/x402/mockModeGuard.js';
import { mockFacilitator } from '../src/commerce/simulation.js';
import type { PaymentRequirements } from '@x402/core/types';
import { createServiceRegistry, buildServicePaymentRequirements, isDiscoverable } from '../src/discovery/registry.js';
import { SqliteServiceStore } from '../src/discovery/store.js';
import { AGENTTRUST_SERVICE_ID, agenttrustServiceResource } from '../src/discovery/firstProvider.js';
import { parseCorsOrigins } from '../src/x402/cors.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = resolveBindHost(process.env.AGENTTRUST_X402_HOST);
const PORT = Number(process.env.AGENTTRUST_X402_PORT ?? 4590);
const FACILITATOR_URL = process.env.AGENTTRUST_FACILITATOR_URL ?? 'http://127.0.0.1:8787';
const PAY_TO = process.env.AGENTTRUST_X402_PAY_TO ?? '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const AMOUNT = process.env.AGENTTRUST_X402_AMOUNT ?? '1';
const RESOURCE_PATH = process.env.AGENTTRUST_X402_RESOURCE_PATH ?? '/protected';
const NODE_HOST_RAW = process.env.AGENTTRUST_NODE_HOST ?? TESTNET.grpcHost;
const NODE_HOST = NODE_HOST_RAW.replace(/^https?:\/\//, '');
const NODE_PORT = Number(process.env.AGENTTRUST_NODE_PORT ?? TESTNET.grpcPort);
const NETWORK = TESTNET.caip2;
const DISCOVERY_DB = process.env.AGENTTRUST_DISCOVERY_DB ?? '/home/hatch/agenttrust-state/discovery.db';
const STATIC_DIR = process.env.AGENTTRUST_STATIC_DIR;
// Agent Card file: explicit path wins; otherwise the repo's card,
// resolved relative to this launcher (works in the checkout and in
// /opt/agenttrust, where the recovery script syncs the whole repo).
// An empty value is treated as unset, like the other path variables.
const AGENT_CARD_FILE = process.env.AGENTTRUST_AGENT_CARD_FILE?.trim()
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'signing-site', '.well-known', 'agent-card.json');

async function main(): Promise<void> {
  // 0. Canonical resource URL + facilitator mode. Both resolved before any
  // network I/O, so a bad AGENTTRUST_X402_PUBLIC_URL or an invalid
  // AGENTTRUST_X402_FACILITATOR_MODE fails startup here with a clear error
  // instead of serving a wrong URL or silently running in the wrong mode.
  // The public URL is operator configuration only — never derived from
  // request headers. When unset, the loopback URL is used. The mode
  // defaults to 'real' (fail-closed production default); there is no
  // automatic fallback from real to mock.
  const resourceUrl = resolveResourceUrl({
    publicUrl: process.env.AGENTTRUST_X402_PUBLIC_URL,
    host: HOST,
    port: PORT,
    resourcePath: RESOURCE_PATH,
  });
  const mode = resolveFacilitatorMode(process.env.AGENTTRUST_X402_FACILITATOR_MODE);
  // CORS allowlist, resolved before any network I/O: a wildcard or
  // malformed AGENTTRUST_CORS_ORIGINS fails startup here with a clear
  // error instead of silently opening (or silently never matching).
  const corsOrigins = parseCorsOrigins(process.env.AGENTTRUST_CORS_ORIGINS);
  // Mock production guard: mock mode additionally requires the explicit
  // opt-in AGENTTRUST_X402_ALLOW_MOCK=1, a non-production NODE_ENV, and
  // a loopback bind host — so a single mistyped or leaked mode variable
  // can never put a production or network-reachable server into mock
  // mode. Throws → the main().catch below exits 1 before any probe or
  // network I/O.
  assertMockModeAllowed(mode, {
    allowMock: process.env.AGENTTRUST_X402_ALLOW_MOCK,
    host: HOST,
    nodeEnv: process.env.NODE_ENV,
  });

  // 0b. Discovery registry (persistent SQLite, same file the operator CLI
  // writes to). Opened before the provider is built so the provider's
  // requirements and resource can come from the registered first-provider
  // service when it is discoverable. When the service is absent or not
  // discoverable, the server falls back to the env-based requirements
  // and the placeholder resource below — the server still serves, it
  // just does not claim to be the registered service.
  const discovery = createServiceRegistry(new SqliteServiceStore(DISCOVERY_DB));
  const firstService = discovery.get(AGENTTRUST_SERVICE_ID);
  const firstDiscoverable = firstService !== undefined && isDiscoverable(firstService);
  if (firstService !== undefined && !firstDiscoverable) {
    console.log(`first-provider service ${AGENTTRUST_SERVICE_ID} is registered but not discoverable (status=${firstService.status}, verification=${firstService.providerVerification.status}) — using env-based requirements`);
  }

  // 1–2. Facilitator + chain, by mode. Real mode is the existing behavior,
  // verbatim: probe the facilitator, require a sponsor feePayer, verify the
  // chain node. Mock mode skips both — there is no real facilitator to
  // probe, no sponsor to announce, and no chain to read.
  let requirements: PaymentRequirements;
  let facilitator: ProviderFacilitatorPort;
  let chain: ChainVerifier;
  let feePayerLog: string;
  if (mode === 'real') {
    // 1. Facilitator capability probe — fail closed when it cannot serve us.
    const probe = await probeFacilitator({ url: FACILITATOR_URL, timeoutMs: 10_000 });
    if (!probe.ok) {
      console.error(`facilitator probe failed (${probe.kind}): ${probe.error} — ${probe.url}`);
      process.exit(2);
    }
    const compat = classifyCompatibility(probe.body, NETWORK);
    if (!compat.usable || !compat.feePayer) {
      console.error(`facilitator unusable: ${compat.code} — ${compat.reason}`);
      process.exit(2);
    }
    console.log(`facilitator ${FACILITATOR_URL} usable: ${compat.reason}`);

    // 2. Independent chain verifier — genesis-bound at startup, read-only.
    chain = new ConcordiumChainVerifier({ host: NODE_HOST, port: NODE_PORT, network: NETWORK, useTls: NODE_HOST_RAW.startsWith('https') });
    await chain.verifyNode();
    console.log(`chain verifier: node ${NODE_HOST}:${NODE_PORT} genesis matches ${NETWORK}`);

    // Requirement with the feePayer the facilitator itself announced.
    // When the first-provider service is discoverable, the requirement
    // comes from its registry record (same amount, payTo and network the
    // service advertises in Discovery); otherwise the env-based values.
    requirements = firstDiscoverable
      ? buildServicePaymentRequirements(firstService!, resourceUrl, { feePayer: compat.feePayer })
      : buildPaymentRequirements({
          payTo: PAY_TO,
          amountMicroCcd: AMOUNT,
          resourceUrl,
          network: NETWORK,
          maxTimeoutSeconds: 300,
          feePayer: compat.feePayer,
        });
    facilitator = createHttpFacilitator({ url: FACILITATOR_URL });
    feePayerLog = compat.feePayer;
  } else {
    // Mock mode. No facilitator probe, no sponsor, no signing service,
    // no chain node. The requirement names NO feePayer — a fake sponsor
    // address is never invented as a workaround. The mock facilitator
    // "settles" a structurally valid payment, but the mock chain never
    // reports a finalization, so the provider fails closed (503) for
    // every paid request and the resource can never unlock.
    console.log('facilitator mode=mock: no real facilitator, no sponsor, no signing — paid requests can never unlock');
    // Same registry-first rule as real mode, minus the feePayer: the
    // requirement names NO fee payer in mock mode — a fake sponsor
    // address is never invented as a workaround.
    requirements = firstDiscoverable
      ? buildServicePaymentRequirements(firstService!, resourceUrl)
      : buildPaymentRequirements({
          payTo: PAY_TO,
          amountMicroCcd: AMOUNT,
          resourceUrl,
          network: NETWORK,
          maxTimeoutSeconds: 300,
        });
    facilitator = mockFacilitator('ok');
    chain = createMockChainVerifier();
    feePayerLog = '(none — mock mode)';
  }

  // 3. Provider. The feePayer (real mode) comes from the facilitator's own
  // announcement, never from local configuration. `resourceUrl` was resolved
  // in step 0 (public URL when configured, loopback otherwise) and is the
  // canonical URL for both the 402 challenge and the payment binding.
  // The resource is the first-provider service descriptor when the service
  // is discoverable; otherwise the placeholder the server always served.
  const resource = firstDiscoverable
    ? agenttrustServiceResource(firstService!)
    : { body: 'PROTECTED-CONTENT', url: resourceUrl };
  const provider = createX402Provider(
    { requirements, resourceUrl, resource },
    { facilitator, chain },
    {
      preflight: preflightPaymentPayload,
      buildRequired: buildPaymentRequired,
      replayStore: new ReplayStore(),
      ...(process.env.AGENTTRUST_X402_SENDER ? { expectSender: process.env.AGENTTRUST_X402_SENDER } : {}),
      ...(process.env.AGENTTRUST_X402_SPONSOR ? { expectSponsor: process.env.AGENTTRUST_X402_SPONSOR } : {}),
    },
  );

  // 4. Serve. The Discovery registry is PERSISTENT (SQLite, same file the
  // operator CLI writes to): services registered earlier survive a restart.
  // Registration is operator-side only (agenttrust-discovery CLI), never
  // over unauthenticated HTTP. The Discovery API is read-only:
  // GET /api/services, GET /api/services/:id.
  const started = await startX402ResourceServer({ provider, resourcePath: RESOURCE_PATH, host: HOST, port: PORT, discovery, corsOrigins, agentCardFile: AGENT_CARD_FILE, ...(STATIC_DIR ? { staticDir: STATIC_DIR } : {}) });
  console.log(`AgentTrust x402 resource server on ${started.url}${RESOURCE_PATH}`);
  console.log(`  resource=${resourceUrl}  payTo=${requirements.payTo}  amount=${requirements.amount} microCCD  network=${NETWORK}`);
  console.log(`  cors: ${corsOrigins.length > 0 ? `enabled for ${corsOrigins.join(', ')}` : 'disabled (AGENTTRUST_CORS_ORIGINS unset)'}`);
  console.log(`  facilitator mode=${mode}  facilitator=${mode === 'real' ? FACILITATOR_URL : 'mock'}  feePayer=${feePayerLog}`);
  if (firstDiscoverable) {
    console.log(`  first-provider service: ${AGENTTRUST_SERVICE_ID} (verified, active) — requirements + resource from the registry record`);
  }
  console.log(`  discovery: GET ${started.url}/api/services (persistent registry: ${DISCOVERY_DB}, ${discovery.size()} service(s))`);
  console.log(`  agent card: GET ${started.url}/.well-known/agent-card.json (file: ${AGENT_CARD_FILE})`);
  if (STATIC_DIR) console.log(`  static website: GET ${started.url}/ (V5.4 prototype, dir: ${STATIC_DIR})`);
  console.log('  Ctrl-C to stop. (Replay store is in-memory: a restart forgets consumed payments.)');

  const shutdown = (): void => {
    discovery.close();
    void started.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('x402 resource server failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
