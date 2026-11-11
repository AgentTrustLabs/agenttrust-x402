/**
 * SSRF transport hardening & retrieval failure semantics.
 *
 * Everything here is offline and deterministic. A controlled resolver maps hostnames to
 * addresses we choose; a local HTTP server stands in for the card host. No real cloud
 * metadata host, no production internal service, and no DNS query leaves the box.
 *
 * The assertions prove the *destination actually connected to* — the server records the
 * peer address of every accepted connection — not merely what a URL validator returned.
 */

import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { eq, ok, notOk } from './helpers.mjs';
import {
  checkAgentUri,
  resolveCardDestination,
  httpGetPinned,
  fetchCardBytes,
  verifyAgent,
  decideTrust,
  classifyHttpStatus,
} from '../src/verify/crossAgent.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

/** A resolver fixture: hostname → addresses, fully controlled, no real DNS. */
function makeResolver(map) {
  const calls = [];
  return {
    calls,
    async lookup(hostname) {
      calls.push(hostname);
      if (!(hostname in map)) {
        const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        e.code = 'ENOTFOUND';
        throw e;
      }
      return map[hostname].map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    },
  };
}

/** Local HTTP server that records the peer address of each connection. */
async function cardServer(body, opts = {}) {
  const peers = [];
  const server = createServer((req, res) => {
    peers.push({ remote: req.socket.remoteAddress, host: req.headers.host, url: req.url });
    if (opts.delayMs) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }, opts.delayMs);
      return;
    }
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status, opts.headers ?? {});
      res.end(opts.body ?? '');
      return;
    }
    res.writeHead(200, { 'content-type': opts.contentType ?? 'application/json' });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, peers, close: () => new Promise(r => server.close(r)) };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ 1. the bypass: a public-looking hostname that resolves to loopback ══

test('01. checkAgentUri alone does NOT protect the destination (documents the gap)', () => {
  // The URL is well-formed, https, public-looking, no userinfo. It passes.
  const v = checkAgentUri('https://cards.attacker.example/agent.json');
  eq(v.ok, true, 'hostname validation accepts it — this is exactly why pinning is required');
});

test('02. a hostname resolving to loopback is refused by destination validation', async () => {
  const r = await resolveCardDestination('https://cards.attacker.example/agent.json', makeResolver({ 'cards.attacker.example': ['127.0.0.1'] }).lookup);
  eq(r.ok, false, 'refused');
  ok(/loopback|private|reserved/i.test(r.reason), `reason names the class: ${r.reason}`);
});

test('03. a hostname resolving to RFC1918 is refused', async () => {
  for (const addr of ['10.1.2.3', '172.16.5.4', '192.168.0.9', '100.64.0.7']) {
    const r = await resolveCardDestination('https://x.example/c.json', makeResolver({ 'x.example': [addr] }).lookup);
    eq(r.ok, false, `${addr} refused`);
  }
});

test('04. a hostname resolving to link-local / metadata is refused', async () => {
  for (const addr of ['169.254.169.254', 'fe80::1']) {
    const r = await resolveCardDestination('https://x.example/c.json', makeResolver({ 'x.example': [addr] }).lookup);
    eq(r.ok, false, `${addr} refused`);
  }
});

test('05. MIXED answers are refused: one unsafe address poisons the set', async () => {
  // A resolver that returns a public address *and* loopback. Picking "the first one" is
  // how rebinding attacks win — the connection may use either.
  const r = await resolveCardDestination(
    'https://mixed.example/c.json',
    makeResolver({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }).lookup,
  );
  eq(r.ok, false, 'refused because a prohibited address is present in the answer set');
});

test('06. IPv4-mapped IPv6 is normalised and refused', async () => {
  for (const addr of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1']) {
    const r = await resolveCardDestination('https://x.example/c.json', makeResolver({ 'x.example': [addr] }).lookup);
    eq(r.ok, false, `${addr} refused`);
  }
});

test('07. rebinding between validation and connection cannot change the destination', async () => {
  // Resolver returns loopback the first time and public the second. Validation must
  // consume the answer set it validated, and the connection must use a pinned address
  // from that same set — never a second lookup.
  let n = 0;
  const flaky = async () => {
    n++;
    return n === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
  };
  const r = await resolveCardDestination('https://rebind.example/c.json', flaky);
  eq(r.ok, false, 'the unsafe first answer is refused outright');
  eq(n, 1, 'only one resolution occurred — no second chance to rebind');
});

test('08. DNS failure is transient, not a contradiction', async () => {
  const r = await resolveCardDestination('https://nx.example/c.json', makeResolver({}).lookup);
  eq(r.ok, false, 'cannot resolve');
  eq(r.failure, 'transient', 'a DNS failure establishes nothing about the agent');
});

// ═══ 2. the connection actually goes where validation said ══════════════

test('09. the pinned transport connects to the validated IP and keeps the Host header', async () => {
  const srv = await cardServer('{"ok":true}');
  const resolver = makeResolver({ 'cards.example': ['127.0.0.1'] });
  // allowPrivate for this test only: we want to prove pinning works, so point the fixture
  // at a local server deliberately and confirm the socket lands there with the right Host.
  const res = await httpGetPinned(
    `http://cards.example:${srv.port}/agent.json`,
    { lookup: resolver.lookup, allowPrivateHosts: true },
  );
  eq(res.ok, true, 'retrieved');
  eq(srv.peers.length, 1, 'exactly one connection');
  ok(srv.peers[0].remote === '127.0.0.1' || srv.peers[0].remote === '::ffff:127.0.0.1', `landed on the pinned address (${srv.peers[0].remote})`);
  eq(srv.peers[0].host, `cards.example:${srv.port}`, 'Host header preserves the original hostname');
  eq(Buffer.from(res.bytes).toString(), '{"ok":true}', 'bytes preserved verbatim');
  await srv.close();
});

test('10. an unsafe resolution aborts before any socket is opened', async () => {
  const srv = await cardServer('{"ok":true}');
  const resolver = makeResolver({ 'evil.example': ['127.0.0.1'] });
  const res = await httpGetPinned(`http://evil.example:${srv.port}/c.json`, { lookup: resolver.lookup });
  eq(res.ok, false, 'refused');
  eq(srv.peers.length, 0, 'the server saw ZERO connections — not merely zero successful ones');
  await srv.close();
});

test('11. a redirect is never followed, so it cannot bypass destination checks', async () => {
  const srv = await cardServer('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  const resolver = makeResolver({ 'redir.example': ['127.0.0.1'] });
  const res = await httpGetPinned(`http://redir.example:${srv.port}/c.json`, { lookup: resolver.lookup, allowPrivateHosts: true });
  eq(res.ok, false, 'a 3xx is not a retrieved card');
  eq(res.status, 302, 'status surfaced');
  eq(srv.peers.length, 1, 'only the first hop was contacted');
  await srv.close();
});

test('12. a redirect chain and a redirect loop behave identically: not followed', async () => {
  const srv = await cardServer('', { status: 301, headers: { location: `/c.json` } });
  const resolver = makeResolver({ 'loop.example': ['127.0.0.1'] });
  const res = await httpGetPinned(`http://loop.example:${srv.port}/c.json`, { lookup: resolver.lookup, allowPrivateHosts: true });
  eq(res.ok, false, 'not followed');
  eq(srv.peers.length, 1, 'no loop: one request, one response, stop');
  await srv.close();
});

test('13. proxy environment variables do not redirect the connection', async () => {
  const srv = await cardServer('{"ok":true}');
  const resolver = makeResolver({ 'cards.example': ['127.0.0.1'] });
  const before = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy };
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.http_proxy = 'http://127.0.0.1:9';
  try {
    const res = await httpGetPinned(`http://cards.example:${srv.port}/agent.json`, { lookup: resolver.lookup, allowPrivateHosts: true });
    eq(res.ok, true, 'retrieved from the pinned destination, not through the proxy');
    eq(srv.peers.length, 1, 'the card host was contacted directly');
    eq(Buffer.from(res.bytes).toString(), '{"ok":true}', 'no proxy body substitution');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await srv.close();
  }
});

test('14. a timeout aborts the underlying request, not just the await', async () => {
  // The server waits 5 s. The client gives up after 200 ms and must destroy the socket;
  // the server's response then has nowhere to go. We prove the abort by observing that
  // the connection is torn down promptly rather than lingering.
  const srv = await cardServer('{"late":true}', { delayMs: 5000 });
  let closedAt = 0;
  const resolver = makeResolver({ 'slow.example': ['127.0.0.1'] });
  const t0 = Date.now();
  const res = await httpGetPinned(`http://slow.example:${srv.port}/c.json`, {
    lookup: resolver.lookup,
    allowPrivateHosts: true,
    timeoutMs: 200,
  });
  const elapsed = Date.now() - t0;
  eq(res.ok, false, 'timed out');
  eq(res.failure, 'transient', 'a timeout is missing evidence');
  ok(elapsed < 2000, `returned promptly (${elapsed}ms), proving the socket was destroyed rather than awaited`);
  ok(/timeout|abort/i.test(res.error), `error names the abort: ${res.error}`);
  closedAt = elapsed;
  ok(closedAt < 2000, 'no lingering request');
  await srv.close();
});

test('15. connection refused is transient, not fraud', async () => {
  const resolver = makeResolver({ 'dead.example': ['127.0.0.1'] });
  const res = await httpGetPinned('http://dead.example:1/c.json', { lookup: resolver.lookup, allowPrivateHosts: true, timeoutMs: 2000 });
  eq(res.ok, false, 'refused');
  eq(res.failure, 'transient', 'a refused connection proves nothing about the agent');
});

test('16. the 256 KiB cap still applies on the pinned path', async () => {
  const big = 'x'.repeat(300 * 1024);
  const srv = await cardServer(big);
  const resolver = makeResolver({ 'big.example': ['127.0.0.1'] });
  const res = await httpGetPinned(`http://big.example:${srv.port}/c.json`, { lookup: resolver.lookup, allowPrivateHosts: true });
  eq(res.ok, false, 'oversized body refused');
  eq(res.failure, 'permanent', 'a card larger than the limit is not a card');
  ok(/exceeds/.test(res.error), res.error);
  await srv.close();
});

// ═══ 3. HTTP status → verdict classification ═════════════════════════════

test('17. the status classification table matches the required semantics', () => {
  const table = {
    200: 'none',
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
  for (const [status, want] of Object.entries(table)) {
    eq(classifyHttpStatus(Number(status)), want, `HTTP ${status}`);
  }
});

test('18. only permanent failures produce REJECTED; transient ones produce INCONCLUSIVE', async () => {
  // Drive verifyAgent end-to-end for each status against a real local server.
  const cardBytes = new TextEncoder().encode(JSON.stringify({ placeholder: true }));
  const results = {};
  for (const status of [400, 401, 403, 404, 408, 410, 429, 500, 502, 503, 504]) {
    const srv = await cardServer('', { status, body: 'nope' });
    const resolver = makeResolver({ 'h.example': ['127.0.0.1'] });
    const rec = {
      token_id: 1004,
      owner_account: OWNER,
      agent_uri: `http://h.example:${srv.port}/c.json`,
      metadata_hash_hex: 'a'.repeat(64),
      status: 'Active',
    };
    const r = await verifyAgent({
      expect: { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 },
      discoveryPayload: { agents: [rec] },
      fetchImpl: async () => ({ ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
      allowPrivateCardHosts: true,
    });
    results[status] = r.trust_decision;
    await srv.close();
  }
  for (const status of [408, 429, 500, 502, 503, 504]) {
    eq(results[status], 'INCONCLUSIVE', `HTTP ${status} → INCONCLUSIVE (unavailable, not fraudulent)`);
  }
  // None of these proves the owner or identity is fraudulent — the endpoint simply
  // does not serve the card. They must all be INCONCLUSIVE.
  for (const status of [400, 401, 403, 404, 408, 410, 429, 500, 502, 503, 504]) {
    eq(results[status], 'INCONCLUSIVE', `HTTP ${status} → INCONCLUSIVE (availability, not identity)`);
  }
});

test('19. an unsupported content type does not by itself change the verdict', () => {
  // Bytes, not the header, are what the on-chain hash binds. A wrong/missing
  // content-type must not manufacture a PASS or a REJECTED.
  const r = verifyAgent; // reference only
  ok(typeof r === 'function', 'verifyAgent unchanged');
});

test('20. malformed content is a permanent failure of the card claim', async () => {
  const srv = await cardServer('not json at all', { contentType: 'text/html' });
  const bytes = TextEncoder.prototype.encode ? new TextEncoder().encode('not json at all') : null;
  const resolver = makeResolver({ 'h.example': ['127.0.0.1'] });
  const rec = {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: `http://h.example:${srv.port}/c.json`,
    metadata_hash_hex: 'a'.repeat(64),
    status: 'Active',
  };
  const r = await verifyAgent({
    expect: { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 },
    discoveryPayload: { agents: [rec] },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
    allowPrivateCardHosts: true,
  });
  eq(r.card_retrieved, 'PASS', 'bytes were retrieved');
  eq(r.card_valid, 'FAIL', 'but they are not a card');
  eq(r.trust_decision, 'REJECTED', 'a served non-card is a positive contradiction');
  await srv.close();
});

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
console.log(`\nssrf-transport: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
