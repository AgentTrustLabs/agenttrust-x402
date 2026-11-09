/**
 * TASK 22 — full-phase timeout verification & HTTP failure semantics.
 *
 * Every phase of the pinned transport is exercised with a deterministic local fixture:
 * controlled resolver, local TCP server, local TLS server with a generated self-signed
 * certificate. No real DNS, no external host, no production service.
 *
 * Assertions are written against the *required* behaviour, so a failure here is a
 * reproduced defect rather than a test needing adjustment.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createServer as createRawServer } from 'node:net';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import {
  httpGetPinned,
  fetchCardBytes,
  verifyAgent,
  classifyHttpStatus,
  decideTrust,
} from '../src/verify/crossAgent.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
// Generated once per run into a temp dir, so the suite never depends on leftover files.
const CERT_DIR = mkdtempSync(join(tmpdir(), 'agenttrust-t22-'));
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const KEY_PATH = join(CERT_DIR, 'key.pem');
{
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY_PATH, '-out', CERT_PATH, '-days', '1', '-subj', '/CN=localhost'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.log('  SKIP P7 (openssl unavailable)');
  }
}
const CERT = existsSync(CERT_PATH) ? readFileSync(CERT_PATH, 'utf8') : null;
const KEY = existsSync(KEY_PATH) ? readFileSync(KEY_PATH, 'utf8') : null;
process.on('exit', () => rmSync(CERT_DIR, { recursive: true, force: true }));

const resolver = map => async hostname => {
  if (!(hostname in map)) {
    const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    e.code = 'ENOTFOUND';
    throw e;
  }
  return map[hostname].map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Track live sockets so "no socket remains" can be asserted, not assumed. */
function trackSockets(server) {
  const live = new Set();
  server.on('connection', s => {
    live.add(s);
    s.on('close', () => live.delete(s));
  });
  return live;
}

const within = async (promise, ms) => {
  const t0 = Date.now();
  const r = await Promise.race([promise, new Promise(res => setTimeout(() => res({ __timeout: true }), ms))]);
  return { r, elapsed: Date.now() - t0 };
};

// ═══ 1. DNS phase ═══════════════════════════════════════════════════════

test('P1. a DNS resolution that never completes is bounded by the deadline', async () => {
  const never = () => new Promise(() => {});
  const { r, elapsed } = await within(
    httpGetPinned('https://slowdns.example/c.json', { lookup: never, timeoutMs: 300 }),
    3000,
  );
  notOk(r?.__timeout === true, `must not hang forever (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'failed');
  eq(r.failure, 'transient', 'a stuck resolver is unavailable evidence');
  ok(elapsed < 2000, `bounded (${elapsed}ms)`);
});

test('P2. a DNS resolution that exceeds the deadline is bounded', async () => {
  const slow = () => new Promise(res => setTimeout(() => res([{ address: '93.184.216.34', family: 4 }]), 5000));
  const { r, elapsed } = await within(
    httpGetPinned('https://slowdns.example/c.json', { lookup: slow, timeoutMs: 300 }),
    3000,
  );
  notOk(r?.__timeout === true, `must not wait for the 5s resolver (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'failed');
  eq(r.failure, 'transient', 'timeout on DNS is unavailable evidence');
  ok(elapsed < 2000, `bounded (${elapsed}ms)`);
});

test('P3. a late DNS answer cannot open a connection after cancellation', async () => {
  // The resolver answers only after the deadline. If the late result were allowed to
  // proceed, the server below would see a connection.
  const srv = createHttpServer((_req, res) => res.end('{}'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const live = trackSockets(srv);
  const port = srv.address().port;
  const late = () => new Promise(res => setTimeout(() => res([{ address: '127.0.0.1', family: 4 }]), 400));

  const r = await httpGetPinned(`http://late.example:${port}/c.json`, {
    lookup: late,
    timeoutMs: 50,
    allowPrivateHosts: true,
  });
  eq(r.ok, false, 'timed out');
  await new Promise(res => setTimeout(res, 800)); // well past the late answer
  eq(live.size, 0, 'no connection was opened by the late DNS answer');
  await new Promise(r => srv.close(r));
});

// ═══ 2. connection phase ════════════════════════════════════════════════

test('P4. a stalled TCP connect is bounded and the socket is destroyed', async () => {
  // 192.0.2.0/24 is TEST-NET-1: routable nowhere, so SYNs go unanswered.
  const { r, elapsed } = await within(
    httpGetPinned('http://192.0.2.1/c.json', { lookup: resolver({}), timeoutMs: 300 }),
    4000,
  );
  notOk(r?.__timeout === true, `connect must be bounded (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'failed');
  eq(r.failure, 'transient', 'a connect timeout is unavailable evidence');
  ok(elapsed < 3000, `bounded (${elapsed}ms)`);
});

test('P5. connection refused is transient', async () => {
  const srv = createHttpServer(() => {});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r)); // free the port, nothing listening
  const r = await httpGetPinned(`http://dead.example:${port}/c.json`, {
    lookup: resolver({ 'dead.example': ['127.0.0.1'] }),
    timeoutMs: 2000,
    allowPrivateHosts: true,
  });
  eq(r.ok, false, 'refused');
  eq(r.failure, 'transient', 'refusal proves nothing about the agent');
});

// ═══ 3. TLS phase ═══════════════════════════════════════════════════════

test('P6. a stalled TLS handshake is bounded and the socket is destroyed', async () => {
  // A plain TCP server that accepts and then says nothing: the client is stuck in the
  // handshake waiting for a ServerHello that never comes.
  const silent = createRawServer(sock => {
    // `resume()` matters: a raw socket that never reads never observes the peer's FIN, so
    // a client-side destroy would look like a leak. Reading makes the close observable.
    sock.resume();
    sock.on('error', () => {});
  });
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  const live = trackSockets(silent);
  const port = silent.address().port;

  const { r, elapsed } = await within(
    httpGetPinned(`https://tls.example:${port}/c.json`, {
      lookup: resolver({ 'tls.example': ['127.0.0.1'] }),
      timeoutMs: 400,
      allowPrivateHosts: true,
    }),
    4000,
  );
  notOk(r?.__timeout === true, `handshake must be bounded (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'failed');
  eq(r.failure, 'transient', 'a stalled handshake is unavailable evidence');
  ok(elapsed < 3000, `bounded (${elapsed}ms)`);
  await new Promise(res => setTimeout(res, 300));
  eq(live.size, 0, 'the socket was destroyed, not left open');
  await new Promise(r => silent.close(r));
});

test('P7. TLS certificate validation failure is transient, not fraud', async () => {
  if (!CERT || !KEY) return; // openssl unavailable on this host
  // Self-signed cert for CN=localhost, reached as tls.example → certificate reject.
  const tls = createTlsServer({ cert: CERT, key: KEY }, (_req, res) => res.end('{}'));
  await new Promise(r => tls.listen(0, '127.0.0.1', r));
  const port = tls.address().port;
  const r = await httpGetPinned(`https://tls.example:${port}/c.json`, {
    lookup: resolver({ 'tls.example': ['127.0.0.1'] }),
    timeoutMs: 2000,
    allowPrivateHosts: true,
  });
  eq(r.ok, false, 'certificate rejected');
  eq(r.failure, 'transient', 'a bad/expired/intercepted certificate is not an identity claim');
  ok(/certificate|self.signed|altnames|unable to verify/i.test(r.error), `names a TLS error: ${r.error}`);
  await new Promise(r => tls.close(r));
});

// ═══ 4. response phase ══════════════════════════════════════════════════

test('P8. a server that never sends headers is bounded', async () => {
  const srv = createHttpServer(() => {
    /* accept, never respond */
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const live = trackSockets(srv);
  const port = srv.address().port;
  const { r, elapsed } = await within(
    httpGetPinned(`http://headers.example:${port}/c.json`, {
      lookup: resolver({ 'headers.example': ['127.0.0.1'] }),
      timeoutMs: 400,
      allowPrivateHosts: true,
    }),
    4000,
  );
  notOk(r?.__timeout === true, `must be bounded (elapsed ${elapsed}ms)`);
  eq(r.failure, 'transient', 'no response is unavailable evidence');
  ok(elapsed < 3000, `bounded (${elapsed}ms)`);
  await new Promise(res => setTimeout(res, 300));
  eq(live.size, 0, 'socket destroyed');
  await new Promise(r => srv.close(r));
});

test('P9. a body that stalls mid-stream is bounded', async () => {
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    // then stall forever
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const live = trackSockets(srv);
  const port = srv.address().port;
  const { r, elapsed } = await within(
    httpGetPinned(`http://body.example:${port}/c.json`, {
      lookup: resolver({ 'body.example': ['127.0.0.1'] }),
      timeoutMs: 400,
      allowPrivateHosts: true,
    }),
    4000,
  );
  notOk(r?.__timeout === true, `must be bounded (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'incomplete body is not a card');
  eq(r.failure, 'transient', 'a stalled body is unavailable evidence');
  ok(elapsed < 3000, `bounded (${elapsed}ms)`);
  await new Promise(res => setTimeout(res, 300));
  eq(live.size, 0, 'socket destroyed');
  await new Promise(r => srv.close(r));
});

test('P10. a slow-drip body cannot extend the deadline indefinitely', async () => {
  // Idle timeouts reset on every chunk. A server dribbling one byte every 100 ms would
  // evade an idle-based timeout forever; the deadline is absolute, not per-chunk.
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const iv = setInterval(() => res.write('x'), 100);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const live = trackSockets(srv);
  const port = srv.address().port;
  const { r, elapsed } = await within(
    httpGetPinned(`http://drip.example:${port}/c.json`, {
      lookup: resolver({ 'drip.example': ['127.0.0.1'] }),
      timeoutMs: 500,
      allowPrivateHosts: true,
    }),
    5000,
  );
  notOk(r?.__timeout === true, `must not be extended by chunk activity (elapsed ${elapsed}ms)`);
  eq(r.ok, false, 'aborted');
  eq(r.failure, 'transient', 'deadline exceeded is unavailable evidence');
  ok(elapsed < 3000, `absolute deadline honoured (${elapsed}ms)`);
  await new Promise(res => setTimeout(res, 300));
  eq(live.size, 0, 'socket destroyed');
  await new Promise(r => srv.close(r));
});

test('P11. an oversized body aborts mid-stream and stops consuming', async () => {
  let written = 0;
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const pump = () => {
      while (written < 8 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const live = trackSockets(srv);
  const port = srv.address().port;
  const r = await httpGetPinned(`http://big.example:${port}/c.json`, {
    lookup: resolver({ 'big.example': ['127.0.0.1'] }),
    timeoutMs: 5000,
    allowPrivateHosts: true,
  });
  eq(r.ok, false, 'refused');
  eq(r.failure, 'permanent', 'a card over the cap is not a card');
  ok(/exceeds/.test(r.error), r.error);
  const consumed = written;
  await new Promise(res => setTimeout(res, 300));
  ok(written <= consumed + 64 * 1024, `producer stopped after abort (${written} vs ${consumed})`);
  eq(live.size, 0, 'socket destroyed');
  await new Promise(r => srv.close(r));
});

// ═══ 5. classification table ════════════════════════════════════════════

test('P12. the classification table is explicit for every required outcome', () => {
  const httpStatuses = {
    400: 'permanent',
    401: 'permanent',
    403: 'permanent',
    404: 'permanent',
    408: 'transient',
    410: 'permanent',
    429: 'transient',
    500: 'transient',
    502: 'transient',
    503: 'transient',
    504: 'transient',
  };
  for (const [s, want] of Object.entries(httpStatuses)) {
    eq(classifyHttpStatus(Number(s)), want, `HTTP ${s}`);
  }
});

test('P13. access and availability failures alone never yield REJECTED', async () => {
  const cases = [
    ['408', async () => failFetch(408)],
    ['429', async () => failFetch(429)],
    ['500', async () => failFetch(500)],
    ['502', async () => failFetch(502)],
    ['503', async () => failFetch(503)],
    ['504', async () => failFetch(504)],
    ['dns', async () => { const e = new Error('ENOTFOUND x'); e.code = 'ENOTFOUND'; throw e; }],
    ['tls', async () => { const e = new Error('unable to verify the first certificate'); throw e; }],
    ['refused', async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }],
    ['timeout', async () => { const e = new Error('card fetch aborted after 10ms'); throw e; }],
  ];
  for (const [label, impl] of cases) {
    const r = await verifyVia(impl);
    eq(r.trust_decision, 'INCONCLUSIVE', `${label} → INCONCLUSIVE`);
    eq(r.card_retrieved, 'INCONCLUSIVE', `${label} card_retrieved`);
  }
});

test('P14. positive identity contradictions still yield REJECTED', async () => {
  const rec = baseRecord();
  const good = Buffer.from(JSON.stringify(sampleCard()));
  const variants = [
    ['hash mismatch', { ...rec, metadata_hash_hex: 'f'.repeat(64) }],
    ['owner mismatch', { ...rec, owner_account: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8' }],
    ['revoked', { ...rec, status: 'Revoked' }],
  ];
  for (const [label, record] of variants) {
    const r = await verifyAgent({
      expect: { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 },
      discoveryPayload: { agents: [record] },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength),
      }),
      allowPrivateCardHosts: true,
    });
    eq(r.trust_decision, 'REJECTED', `${label} → REJECTED`);
  }
});

test('P15. a redirect is unavailable-evidence-or-policy, never fraud', async () => {
  // Deliberate policy choice: redirects are not followed, so nothing was served at the
  // claimed location. Classed permanent (the endpoint's policy is wrong), and the report
  // must not describe it as proof the owner is fraudulent.
  eq(classifyHttpStatus(301), 'permanent', '3xx is a policy failure');
  const r = await verifyVia(async () => failFetch(302));
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
  ok(
    r.trust_decision === 'REJECTED' || r.trust_decision === 'INCONCLUSIVE',
    `documented outcome: ${r.trust_decision}`,
  );
});

// ─── helpers ────────────────────────────────────────────────────────────

const failFetch = status => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

function baseRecord() {
  const bytes = Buffer.from(JSON.stringify(sampleCard()));
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: 'https://cards.example/c.json',
    metadata_hash_hex: hash,
    status: 'Active',
  };
}

function sampleCard() {
  return {
    name: 'AgentTrust',
    description: 'gateway',
    version: '1.0.0',
    url: 'https://cards.example',
    skills: [{ id: 'v', name: 'v', description: 'v' }],
    registrations: [{ agentId: 1004, agentRegistry: `${CAIP2}:12802.0` }],
    capabilities: {
      extensions: [
        {
          uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
          params: {
            tokenAddress: `${CAIP2}/cis-2:JyP9YLib1wYgFmztkcKJL`,
            owner: { account: `${CAIP2}:${OWNER}` },
            agentWallet: `${CAIP2}:${OWNER}`,
            contracts: { cis8004: `${CAIP2}:12802.0`, cis8: `${CAIP2}:12801.0` },
          },
        },
      ],
    },
  };
}

async function verifyVia(fetchImpl) {
  return verifyAgent({
    expect: { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 },
    discoveryPayload: { agents: [baseRecord()] },
    fetchImpl,
    allowPrivateCardHosts: true,
  });
}

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\ntask22-phase-timeout: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
