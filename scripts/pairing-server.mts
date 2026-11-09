/**
 * TASK 71 — local Connect Wallet / Agent Pairing server (wiring layer).
 *
 * Serves the static pairing page from signing-site/ and exposes the pairing API
 * backed by the real read-only Testnet node and the hosted Agent Registry.
 *
 * Read-only by construction: this process never signs, never broadcasts, never
 * holds a key. It calls `getAccountInfo` (read) and the registry's `agent_of`
 * (read) plus the existing `verifyAgent()` pipeline (read).
 *
 * Env:
 *   AGENTTRUST_PAIRING_HOST      default 127.0.0.1   (never expose publicly)
 *   AGENTTRUST_PAIRING_PORT      default 4518
 *   AGENTTRUST_PAIRING_NETWORK   default ccd:4221332d34e1694168c2a0c0b3fd0f27
 *   AGENTTRUST_PAIRING_AGENT_ID  default 1004
 *   AGENTTRUST_NODE_HOST         default grpc.testnet.concordium.com
 *   AGENTTRUST_NODE_PORT         default 20000
 *   AGENTTRUST_REGISTRY_URL      default https://agent-registry-mcp.concordium.com/mcp
 *
 * Run: npx tsx scripts/pairing-server.mts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { TESTNET } from '../src/core/types.js';
import { PairingStore } from '../src/pairing/pairing.js';
import { TESTNET_GENESIS_HASH, WalletSession } from '../src/pairing/walletSession.js';
import { createAgentIdentityVerifier } from '../src/pairing/agentTrust.js';
import { PermissionManager } from '../src/pairing/permissions.js';
import { AgenticWalletManager } from '../src/pairing/agenticWallet.js';
import { WalletStore } from '../src/pairing/walletStore.js';
import { InMemoryWalletKeyStore } from '../src/pairing/walletSigner.js';
import { WalletSkills } from '../src/pairing/walletSkills.js';
import { createWalletPaymentExecutor } from '../src/pairing/walletPaymentPipeline.js';
import { mockFacilitator, structuralPayload } from '../src/commerce/simulation.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { createX402Provider } from '../src/x402/provider.js';
import { AgentWalletX402Client } from '../src/pairing/walletX402Client.js';
import { createProviderPaymentExecutor } from '../src/pairing/walletX402Client.js';
import { createPairingHandler } from '../src/pairing/server.js';
import { GrpcAccountInfoProvider } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { AgentRegistryMcp } from '../src/registry/mcpClient.js';

const HOST = process.env.AGENTTRUST_PAIRING_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AGENTTRUST_PAIRING_PORT ?? 4518);
const NETWORK = process.env.AGENTTRUST_PAIRING_NETWORK ?? TESTNET.caip2;
const DEFAULT_AGENT_ID = process.env.AGENTTRUST_PAIRING_AGENT_ID ?? '1004';
const NODE_HOST_RAW = process.env.AGENTTRUST_NODE_HOST ?? TESTNET.grpcHost;
// `TESTNET.grpcHost` carries a scheme for URL display; the gRPC client wants a bare host.
const NODE_HOST = NODE_HOST_RAW.replace(/^https?:\/\//, '');
const NODE_PORT = Number(process.env.AGENTTRUST_NODE_PORT ?? TESTNET.grpcPort);
const REGISTRY_URL = process.env.AGENTTRUST_REGISTRY_URL ?? TESTNET.mcpUrl;

const STATIC_ROOT = new URL('../signing-site/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Serve the pairing page. Returns true when it answered the request. */
function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  const urlPath = (req.url ?? '/').split('?')[0]!;
  if (urlPath.startsWith('/api/')) return false;
  const rel = normalize(urlPath === '/' ? 'pair.html' : urlPath.replace(/^\/+/, ''));
  const file = join(STATIC_ROOT, rel);
  if (!file.startsWith(STATIC_ROOT) || !existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

async function main(): Promise<void> {
  const store = new PairingStore();
  const session = new WalletSession();
  const permissions = new PermissionManager();
  const walletStore = new WalletStore({ path: process.env.AGENTTRUST_WALLET_DB ?? join(STATIC_ROOT, '..', 'wallets.db') });
  const walletManager = new AgenticWalletManager({
    store: walletStore,
    keyStore: new InMemoryWalletKeyStore(),
    permissions,
    pairingStore: store,
  });
  const skills = new WalletSkills({
    wallets: walletManager,
    permissions,
    payments: createWalletPaymentExecutor({
      permissions,
      facilitator: mockFacilitator('ok'),
      createPaymentPayload: async (requirements) => structuralPayload(requirements),
    }),
  });

  // TASK 75: x402 provider bound to a demo resource. The chain verifier fails closed
  // (`unavailable`) because this process performs no real on-chain read and no
  // settlement is enabled — the provider therefore never releases the resource here.
  const x402Requirements = buildPaymentRequirements({
    payTo: process.env.AGENTTRUST_X402_PAY_TO ?? '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8',
    amountMicroCcd: process.env.AGENTTRUST_X402_AMOUNT ?? '500',
    resourceUrl: process.env.AGENTTRUST_X402_RESOURCE ?? 'https://example.com/protected',
    network: NETWORK,
    maxTimeoutSeconds: 60,
  });
  const x402Provider = createX402Provider(
    {
      requirements: x402Requirements,
      resourceUrl: process.env.AGENTTRUST_X402_RESOURCE ?? 'https://example.com/protected',
      resource: { body: 'PROTECTED-CONTENT', url: process.env.AGENTTRUST_X402_RESOURCE ?? 'https://example.com/protected' },
    },
    {
      facilitator: mockFacilitator('ok'),
      chain: { async readTransfer() { return { status: 'unavailable' as const }; } },
    },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired },
  );
  const x402Client = new AgentWalletX402Client({
    skills,
    executor: createProviderPaymentExecutor({
      permissions,
      facilitator: mockFacilitator('ok'),
      createPaymentPayload: async (requirements) => structuralPayload(requirements as never),
    }),
  });

  const accountProvider = new GrpcAccountInfoProvider({ host: NODE_HOST, port: NODE_PORT, network: NETWORK });
  await accountProvider.verifyNode();

  const registry = new AgentRegistryMcp(REGISTRY_URL, NETWORK === TESTNET.caip2 ? 'testnet' : 'mainnet');
  const verifyAgentIdentity = createAgentIdentityVerifier({
    discoverAgent: async (_network, tokenId) => {
      const record = await registry.callToolRaw<Record<string, unknown>>('agent_of', { token_id: tokenId });
      return { agents: [record] };
    },
  });

  const handler = createPairingHandler(
    {
      store,
      session,
      config: { network: NETWORK, defaultAgentId: DEFAULT_AGENT_ID, host: HOST, port: PORT, genesisHash: TESTNET_GENESIS_HASH },
      getAccountInfo: (address) => accountProvider.getAccountInfo(address, NETWORK),
      verifyAgentIdentity,
      permissions,
      walletManager,
      skills,
      x402: { provider: x402Provider, client: x402Client },
    },
    { staticHandler: serveStatic },
  );

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(PORT, HOST, () => resolve()));

  console.log(`AgentTrust pairing server on http://${HOST}:${PORT}`);
  console.log(`  network=${NETWORK}  default agent=${DEFAULT_AGENT_ID}`);
  console.log(`  node=${NODE_HOST}:${NODE_PORT}  registry=${REGISTRY_URL}`);
  console.log('  Ctrl-C to stop.');

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('pairing server failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
