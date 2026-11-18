/**
 * Agent Card route tests for the x402 resource server.
 *
 * Coverage:
 *   1. GET /.well-known/agent-card.json → 200 + Content-Type: application/json
 *      + body byte-identical to signing-site/.well-known/agent-card.json
 *   2. served body SHA-256 equals the on-chain card hash for Token #1004
 *      (3f614404…) and the parsed card names Token #1004 at the on-chain URI
 *   3. unknown paths still 404 (/.well-known/other.json, /agent-card.json,
 *      /.well-known/agent-card.json/extra, /nope)
 *   4. prefixed path /agenttrust/.well-known/agent-card.json → 404: the
 *      reverse proxy strips its /agenttrust prefix and forwards the bare
 *      path — the same contract as /protected
 *   5. POST /.well-known/agent-card.json → 404 (only GET is served)
 *   6. route off when no card file is configured → 404
 *   7. configured card file missing on disk → 404, not 500
 *   8. GET /protected still returns 402 (payment flow untouched)
 *
 * The facilitator and the chain are fakes, so every path is reachable with
 * no node, no signing, and no transaction. The card file is read from the
 * repo (never modified by this suite). No credentials anywhere.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, ok, TOKEN1004, ROOT, sha256Hex } from './helpers.mjs';
import { createServiceRegistry } from '../src/discovery/registry.js';
import { createX402Provider, ReplayStore, type ChainTransferSummary } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';
import { startX402ResourceServer, AGENT_CARD_PATH } from '../src/x402/resourceServer.js';

console.log('── agent-card-route ──');

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'ab'.repeat(32);
const BLOCK_HASH = 'cd'.repeat(32);
const CARD_FILE = join(ROOT, 'signing-site', '.well-known', 'agent-card.json');

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const chainFinalized = (over: Partial<ChainTransferSummary> = {}): ChainTransferSummary => ({
  status: 'finalized',
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  amount: '1',
  network: CAIP2,
  blockHash: BLOCK_HASH,
  failed: false,
  ...over,
});

const fakeFacilitator = () => ({
  verify: async () => ({ isValid: true }),
  settle: async () => ({ success: true, transaction: HASH, network: CAIP2 }),
});

interface ServerCtx {
  url: string;
  close: () => Promise<void>;
}

async function withServer(opts: {
  /** Card file to serve. Omit (undefined) = the repo card; false = no route; string = that path. */
  cardFile?: string | false;
}): Promise<ServerCtx> {
  const port = await freePort();
  const resourcePath = '/protected';
  const endpoint = `http://127.0.0.1:${port}${resourcePath}`;
  const registry = createServiceRegistry();
  const requirements = buildPaymentRequirements({
    payTo: RECIPIENT,
    amountMicroCcd: '1',
    resourceUrl: endpoint,
    network: CAIP2,
    maxTimeoutSeconds: 300,
    feePayer: SPONSOR,
  });
  const provider = createX402Provider(
    { requirements, resourceUrl: endpoint, resource: { body: 'PROTECTED-CONTENT', url: endpoint } },
    { facilitator: fakeFacilitator() as never, chain: { readTransfer: async () => chainFinalized() } },
    {
      preflight: preflightPaymentPayload,
      buildRequired: buildPaymentRequired,
      replayStore: new ReplayStore(),
      expectSender: SENDER,
      expectSponsor: SPONSOR,
    },
  );
  const cardFile = opts.cardFile === undefined ? CARD_FILE : opts.cardFile;
  const started = await startX402ResourceServer({
    provider,
    resourcePath,
    host: '127.0.0.1',
    port,
    discovery: registry,
    ...(cardFile ? { agentCardFile: cardFile } : {}),
  });
  return {
    url: started.url,
    close: async () => {
      await started.close();
      registry.close();
    },
  };
}

test('card route returns 200 + application/json + body byte-identical to the file', async () => {
  const { url, close } = await withServer({});
  try {
    const res = await fetch(`${url}${AGENT_CARD_PATH}`);
    eq(res.status, 200, 'GET /.well-known/agent-card.json returns 200');
    eq(res.headers.get('content-type'), 'application/json', 'Content-Type is application/json');
    const body = await res.text();
    const file = await readFile(CARD_FILE, 'utf8');
    eq(body, file, 'served body is byte-identical to the Agent Card file');
    // Byte length, not string length: the file contains non-ASCII characters
    // (em dashes), so its UTF-16 length (2775) differs from its byte size.
    eq(Buffer.byteLength(body, 'utf8'), TOKEN1004.cardBytes, 'served body is 2777 bytes');
    eq(sha256Hex(Buffer.from(body, 'utf8')), TOKEN1004.cardSha256, 'served body SHA-256 is the on-chain card hash');
  } finally {
    await close();
  }
});

test('served card parses and names Token #1004 at the on-chain URI', async () => {
  const { url, close } = await withServer({});
  try {
    const res = await fetch(`${url}${AGENT_CARD_PATH}`);
    const card = (await res.json()) as {
      name: string;
      url: string;
      registrations: Array<{ agentId: number; agentRegistry: string }>;
      capabilities: { extensions: Array<{ params: { tokenAddress: string; owner: { account: string } } }> };
    };
    eq(card.name, 'AgentTrust Gateway', 'card name is AgentTrust Gateway');
    eq(card.url, TOKEN1004.agentUri, 'card url is the on-chain Agent Card URI');
    eq(card.registrations[0]?.agentId, TOKEN1004.tokenId, 'card registration names Token #1004');
    ok(card.capabilities.extensions[0]?.params.tokenAddress.endsWith(TOKEN1004.tokenAddress), 'card tokenAddress is Token #1004');
    ok(card.capabilities.extensions[0]?.params.owner.account.endsWith(TOKEN1004.owner), 'card owner is the recorded owner account');
  } finally {
    await close();
  }
});

test('unknown paths still 404', async () => {
  const { url, close } = await withServer({});
  try {
    for (const path of ['/.well-known/other.json', '/agent-card.json', '/.well-known/agent-card.json/extra', '/nope']) {
      const res = await fetch(`${url}${path}`);
      eq(res.status, 404, `GET ${path} returns 404`);
    }
  } finally {
    await close();
  }
});

test('prefixed path 404s: the proxy must strip /agenttrust', async () => {
  const { url, close } = await withServer({});
  try {
    const res = await fetch(`${url}/agenttrust${AGENT_CARD_PATH}`);
    eq(res.status, 404, 'GET /agenttrust/.well-known/agent-card.json returns 404 (proxy strips the prefix)');
    const protectedRes = await fetch(`${url}/agenttrust/protected`);
    eq(protectedRes.status, 404, 'same contract as /protected: prefixed path 404s');
  } finally {
    await close();
  }
});

test('POST to the card path 404s (only GET is served)', async () => {
  const { url, close } = await withServer({});
  try {
    const res = await fetch(`${url}${AGENT_CARD_PATH}`, { method: 'POST' });
    eq(res.status, 404, 'POST /.well-known/agent-card.json returns 404');
  } finally {
    await close();
  }
});

test('route off when no card file is configured', async () => {
  const { url, close } = await withServer({ cardFile: false });
  try {
    const res = await fetch(`${url}${AGENT_CARD_PATH}`);
    eq(res.status, 404, 'GET /.well-known/agent-card.json returns 404 when no card file is configured');
  } finally {
    await close();
  }
});

test('missing card file on disk 404s, not 500', async () => {
  const { url, close } = await withServer({ cardFile: join(ROOT, 'signing-site', '.well-known', 'no-such-card.json') });
  try {
    const res = await fetch(`${url}${AGENT_CARD_PATH}`);
    eq(res.status, 404, 'GET /.well-known/agent-card.json returns 404 when the file is missing');
  } finally {
    await close();
  }
});

test('GET /protected still returns 402 (payment flow untouched)', async () => {
  const { url, close } = await withServer({});
  try {
    const res = await fetch(`${url}/protected`);
    eq(res.status, 402, 'GET /protected still returns the 402 challenge');
  } finally {
    await close();
  }
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${(e as Error).message}`);
  }
}
console.log(`\nagent-card-route: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
