/**
 * Pinned transport — regression tests.
 *
 * Covers the pinned transport (`src/verify/crossAgent.ts`). The environment
 * is never consulted: ambient proxy variables cannot redirect a pinned fetch.
 * Only an explicitly passed proxy is honoured, and only as a CONNECT tunnel
 * to the pinned destination IP — the proxy performs no DNS resolution, TLS
 * still verifies the original hostname, and every other security check stays
 * active. All tests are local: a real HTTPS server (with a test CA generated
 * by openssl at setup — no private keys are committed) and a minimal CONNECT
 * proxy, both on loopback.
 *
 *   1. HTTPS normal (direct, no proxy) → the real card verifies TRUSTED.
 *   2. Explicit proxy (CONNECT tunnel to the pinned IP) → TRUSTED, cert
 *      still verified; the CONNECT target is the pinned IP, not the hostname.
 *   3. Proxy + invalid certificate → still rejected (the proxy does not
 *      weaken TLS: the tunnel is end-to-end encrypted and verified).
 *   4. Invalid certificate (untrusted CA) → INCONCLUSIVE, never TRUSTED.
 *   5. Hostname mismatch (cert for another name) → INCONCLUSIVE.
 *   6. Card hash mismatch → REJECTED (a contradiction, never TRUSTED).
 *   7. Owner mismatch → REJECTED.
 *   8. Timeout (server never responds) → INCONCLUSIVE.
 *   9. Connection failure (closed port) → INCONCLUSIVE.
 *  10. Environment proxy variables are ignored by the pinned fetch.
 *  11. parseProxyUrl: explicit proxy strings parse, bad values ignored.
 *  12. httpGetPinned honours an explicit proxy: null (direct) vs a proxy URL.
 *  13. CONNECT to a pinned IPv6 address: bracketed target, TLS still verified.
 *
 * Run with: npm test  (tsx)
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as httpsMod from 'node:https';
import * as httpMod from 'node:http';
import { connect as netConnect } from 'node:net';
import {
  verifyAgent,
  httpGetPinned,
  parseProxyUrl,
} from '../src/verify/crossAgent.js';
import { eq, ok, notOk } from './helpers.mjs';

const FIX = new URL('./fixtures/discovery/', import.meta.url).pathname;
const CARD = () => new Uint8Array(readFileSync(FIX + 'agent-card.raw.json'));
const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER_OWNER = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const CARD_HASH = sha256Hex(CARD());

// ─── test certificates (openssl, generated at setup; nothing is committed) ──

const dir = mkdtempSync(join(tmpdir(), 'pinned-transport-'));
function openssl(args: string[]) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed (is openssl installed?): ${r.stderr ?? r.error}`);
  }
}
function writeExt(name: string, san: string) {
  const p = join(dir, name);
  writeFileSync(p, `subjectAltName=${san}\n`);
  return p;
}
function makeCa(name: string, cn: string) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt, '-days', '2', '-nodes', '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE']);
  return { key, crt };
}
function makeServerCert(name: string, cn: string, san: string, ca: { key: string; crt: string }) {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const crt = join(dir, `${name}.crt`);
  openssl(['req', '-newkey', 'rsa:2048', '-keyout', key, '-out', csr, '-nodes', '-subj', `/CN=${cn}`]);
  openssl(['x509', '-req', '-in', csr, '-CA', ca.crt, '-CAkey', ca.key, '-CAcreateserial', '-out', crt, '-days', '2', '-extfile', writeExt(`${name}.ext`, san)]);
  return { key, crt };
}

const ca = makeCa('ca', 'AgentTrust Test CA');
const caPem = readFileSync(ca.crt, 'utf8');
const localhostCert = makeServerCert('localhost', 'localhost', 'DNS:localhost,IP:127.0.0.1', ca);
const wrongCert = makeServerCert('wrong', 'wrong.test', 'DNS:wrong.test', ca);
const untrustedCa = makeCa('untrusted-ca', 'Untrusted Test CA');
const untrustedCert = makeServerCert('untrusted', 'localhost', 'DNS:localhost,IP:127.0.0.1', untrustedCa);

// ─── local servers ──────────────────────────────────────────────────────────

type Server = { close(): void; port: number };
function listen(srv: httpMod.Server | httpsMod.Server, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const a = srv.address();
      if (!a || typeof a === 'string') return reject(new Error('server did not bind'));
      resolve({ close: () => srv.close(), port: a.port });
    });
  });
}
const cardHandler = (bytes: Uint8Array) => (_req: httpMod.IncomingMessage, res: httpMod.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.byteLength });
  res.end(Buffer.from(bytes));
};

const good = await listen(httpsMod.createServer({ key: readFileSync(localhostCert.key), cert: readFileSync(localhostCert.crt) }, cardHandler(CARD())));
// Same card on IPv6 loopback, for the bracketed-CONNECT test.
const good6 = await listen(httpsMod.createServer({ key: readFileSync(localhostCert.key), cert: readFileSync(localhostCert.crt) }, cardHandler(CARD())), '::1');
const wrongHost = await listen(httpsMod.createServer({ key: readFileSync(wrongCert.key), cert: readFileSync(wrongCert.crt) }, cardHandler(CARD())));
const untrusted = await listen(httpsMod.createServer({ key: readFileSync(untrustedCert.key), cert: readFileSync(untrustedCert.crt) }, cardHandler(CARD())));
const hanging = await listen(httpsMod.createServer({ key: readFileSync(localhostCert.key), cert: readFileSync(localhostCert.crt) }, (_req, _res) => {
  // Never responds: the fetch must time out, not hang the suite.
}));

// A modified card (different bytes → different SHA-256) for the hash test.
const TAMPERED = (() => {
  const j = JSON.parse(Buffer.from(CARD()).toString('utf8')) as Record<string, unknown>;
  j.description = `${String(j.description)} (tampered)`;
  return new Uint8Array(Buffer.from(JSON.stringify(j), 'utf8'));
})();
const tamperedServer = await listen(httpsMod.createServer({ key: readFileSync(localhostCert.key), cert: readFileSync(localhostCert.crt) }, cardHandler(TAMPERED)));

// A closed port for the connection-failure test: bind, read the port, close.
const closedPort = await (async () => {
  const s = await listen(httpMod.createServer((_req, res) => res.end()));
  const p = s.port;
  s.close();
  return p;
})();

// Minimal CONNECT proxy, restricted to loopback targets (test safety).
// Records every CONNECT request-target so tests can prove the tunnel went
// to the pinned IP, never the hostname.
const connectTargets: string[] = [];
const proxy = await listen(
  httpMod.createServer().on('connect', (req, socket, head) => {
    const raw = req.url ?? '';
    // Bracketed IPv6 (`[::1]:443`) and plain `host:port` forms.
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(raw) ?? /^([^:]+):(\d+)$/.exec(raw);
    const host = m?.[1];
    const portStr = m?.[2];
    if ((host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') || !portStr) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    connectTargets.push(raw);
    const target = netConnect({ host, port: Number(portStr) });
    target.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.once('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.once('error', () => target.destroy());
  }),
);
const PROXY_URL = `http://127.0.0.1:${proxy.port}`;

// ─── helpers ────────────────────────────────────────────────────────────────

const cardUrl = (port: number) => `https://localhost:${port}/.well-known/agent-card.json`;
const record = (agentUri: string, hash: string = CARD_HASH, owner: string = OWNER) => ({
  network: 'testnet',
  token_address: 'JyP9YLib1wYgFmztkcKJL',
  token_id: '1004',
  token_id_u64: 1004,
  owner_account: owner,
  agent_uri: agentUri,
  metadata_hash_hex: hash,
  agent_wallet: owner,
  status: 'Active',
  registered_at: '2026-11-04T23:40:17.188+00:00',
});
const expect = (owner: string = OWNER) => ({
  network: CAIP2,
  cis8004: '12802.0',
  cis8: '12801.0',
  tokenId: 1004,
  ownerAccount: owner,
});
// A pinned lookup that answers only 127.0.0.1. The system resolver returns
// `::1` first for `localhost` on this machine, and the test card servers
// listen on 127.0.0.1 only — an explicit lookup keeps the proxy tests
// deterministic instead of depending on resolver order.
const LOOPBACK_LOOKUP = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
async function verify(
  agentUri: string,
  opts: { proxy?: string | null; cardTimeoutMs?: number; owner?: string; hash?: string; lookup?: (hostname: string) => Promise<{ address: string; family: number }[]> } = {},
) {
  return verifyAgent({
    expect: expect(opts.owner),
    discoveryPayload: { agents: [record(agentUri, opts.hash)] },
    cardTimeoutMs: opts.cardTimeoutMs ?? 5000,
    allowPrivateCardHosts: true,
    cardCa: caPem,
    ...(opts.proxy !== undefined ? { cardProxy: opts.proxy } : {}),
    ...(opts.lookup !== undefined ? { cardLookup: opts.lookup } : {}),
  });
}

// ─── tests ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('HTTPS normal (direct, no proxy): the real card verifies TRUSTED', async () => {
  const r = await verify(cardUrl(good.port), { proxy: null });
  eq(r.trust_decision, 'TRUSTED', 'decision is TRUSTED');
  eq(r.agent_discovered, 'PASS', 'agent_discovered');
  eq(r.card_retrieved, 'PASS', 'card_retrieved');
  eq(r.card_valid, 'PASS', 'card_valid');
  eq(r.hash_matches_on_chain, 'PASS', 'hash_matches_on_chain');
  eq(r.owner_matches, 'PASS', 'owner_matches');
  eq(r.status_active, 'PASS', 'status_active');
  eq(r.contract_references_match, 'PASS', 'contract_references_match');
  eq(r.failure_kind, 'none', 'no failure');
  ok((r.evidence.card as { http_status: number }).http_status === 200, 'card fetched with HTTP 200');
  eq((r.evidence.card as { byte_length: number }).byte_length, 2777, 'card is 2777 bytes');
});

test('explicit proxy (CONNECT tunnel to the pinned IP): TRUSTED, cert still verified', async () => {
  const before = connectTargets.length;
  const r = await verify(cardUrl(good.port), { proxy: PROXY_URL, lookup: LOOPBACK_LOOKUP });
  eq(r.trust_decision, 'TRUSTED', 'decision is TRUSTED through the proxy');
  eq(r.card_retrieved, 'PASS', 'card_retrieved through the proxy');
  eq(r.hash_matches_on_chain, 'PASS', 'hash still matches through the proxy');
  eq(r.failure_kind, 'none', 'no failure');
  // The proxy must have been asked to CONNECT to the pinned IP, never the
  // hostname: the proxy performs no DNS resolution, so the pin holds.
  const seen = connectTargets.slice(before);
  ok(seen.length >= 1, 'the proxy was used');
  ok(
    seen.every(t => t === `127.0.0.1:${good.port}`),
    `CONNECT went to the pinned IP, not the hostname: ${seen.join(', ')}`,
  );
});

test('proxy + invalid certificate: still rejected (the proxy does not weaken TLS)', async () => {
  const r = await verify(cardUrl(untrusted.port), { proxy: PROXY_URL, lookup: LOOPBACK_LOOKUP });
  eq(r.trust_decision, 'INCONCLUSIVE', 'untrusted cert through the proxy is INCONCLUSIVE');
  eq(r.card_retrieved, 'INCONCLUSIVE', 'card_retrieved is INCONCLUSIVE');
  notOk(r.trust_decision === 'TRUSTED', 'never TRUSTED with a bad cert');
  ok(
    String((r.evidence.card as { error: string }).error ?? '').toLowerCase().includes('certificate'),
    `error names the certificate: ${String((r.evidence.card as { error: string }).error)}`,
  );
});

test('invalid certificate (untrusted CA): INCONCLUSIVE, never TRUSTED', async () => {
  const r = await verify(cardUrl(untrusted.port), { proxy: null });
  eq(r.trust_decision, 'INCONCLUSIVE', 'decision is INCONCLUSIVE');
  eq(r.card_retrieved, 'INCONCLUSIVE', 'card_retrieved is INCONCLUSIVE');
  notOk(r.trust_decision === 'TRUSTED', 'never TRUSTED with a bad cert');
  const err = String((r.evidence.card as { error: string }).error ?? '');
  ok(err.toLowerCase().includes('certificate'), `error names the certificate: ${err}`);
});

test('hostname mismatch (cert for another name): INCONCLUSIVE, never TRUSTED', async () => {
  const r = await verify(cardUrl(wrongHost.port), { proxy: null });
  eq(r.trust_decision, 'INCONCLUSIVE', 'decision is INCONCLUSIVE');
  eq(r.card_retrieved, 'INCONCLUSIVE', 'card_retrieved is INCONCLUSIVE');
  notOk(r.trust_decision === 'TRUSTED', 'never TRUSTED on a hostname mismatch');
  const err = String((r.evidence.card as { error: string }).error ?? '');
  ok(
    err.toLowerCase().includes('certificate') || err.toLowerCase().includes('hostname') || err.toLowerCase().includes('localhost'),
    `error names the certificate/hostname: ${err}`,
  );
});

test('card hash mismatch: REJECTED (a contradiction, never TRUSTED)', async () => {
  // The record carries the hash of the REAL card; the server serves a tampered one.
  const r = await verify(cardUrl(tamperedServer.port), { proxy: null });
  eq(r.trust_decision, 'REJECTED', 'decision is REJECTED');
  eq(r.card_retrieved, 'PASS', 'the card was retrieved');
  eq(r.hash_matches_on_chain, 'FAIL', 'hash_matches_on_chain is FAIL');
  eq((r.evidence.hash as { on_chain_sha256: string }).on_chain_sha256, CARD_HASH, 'on-chain hash is the real card hash');
  notOk((r.evidence.hash as { local_sha256: string }).local_sha256 === CARD_HASH, 'local hash differs');
});

test('owner mismatch: REJECTED (the record pins the owner)', async () => {
  const r = await verify(cardUrl(good.port), { proxy: null, owner: OTHER_OWNER });
  eq(r.trust_decision, 'REJECTED', 'decision is REJECTED');
  eq(r.card_retrieved, 'PASS', 'the card was retrieved');
  eq(r.hash_matches_on_chain, 'PASS', 'the hash still matches');
  eq(r.owner_matches, 'FAIL', 'owner_matches is FAIL');
});

test('timeout (server never responds): INCONCLUSIVE, never TRUSTED', async () => {
  const r = await verify(cardUrl(hanging.port), { proxy: null, cardTimeoutMs: 600 });
  eq(r.trust_decision, 'INCONCLUSIVE', 'decision is INCONCLUSIVE');
  eq(r.card_retrieved, 'INCONCLUSIVE', 'card_retrieved is INCONCLUSIVE');
  notOk(r.trust_decision === 'TRUSTED', 'never TRUSTED on a timeout');
});

test('connection failure (closed port): INCONCLUSIVE, never TRUSTED', async () => {
  const r = await verify(cardUrl(closedPort), { proxy: null, cardTimeoutMs: 3000 });
  eq(r.trust_decision, 'INCONCLUSIVE', 'decision is INCONCLUSIVE');
  eq(r.card_retrieved, 'INCONCLUSIVE', 'card_retrieved is INCONCLUSIVE');
  notOk(r.trust_decision === 'TRUSTED', 'never TRUSTED on a connection failure');
});

test('environment proxy variables are ignored: a dead env proxy cannot redirect the pinned fetch', async () => {
  // All four variables point at a closed port. The pinned fetch must ignore
  // them and go direct — the https: counterpart of ssrf-transport #13.
  const before = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
  };
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.https_proxy = 'http://127.0.0.1:9';
  try {
    const r = await verify(cardUrl(good.port), { proxy: null });
    eq(r.trust_decision, 'TRUSTED', 'TRUSTED with proxy: null despite dead proxy env vars');
    const r2 = await verify(cardUrl(good.port), {});
    eq(r2.trust_decision, 'TRUSTED', 'TRUSTED with proxy unset despite dead proxy env vars');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('parseProxyUrl: explicit proxy strings parse, bad values are ignored', () => {
  const p = parseProxyUrl('http://user:pass@proxy.example:3128');
  ok(p !== null && p.host === 'proxy.example' && p.port === 3128 && p.auth === 'user:pass', 'proxy URL with auth parses');
  eq(parseProxyUrl('https://proxy.example:3128'), null, 'an https: proxy is not accepted (CONNECT needs a plain-HTTP proxy)');
  eq(parseProxyUrl('not a url'), null, 'an invalid proxy URL is ignored, not fatal');
  eq(parseProxyUrl(undefined), null, 'undefined → null');
  eq(parseProxyUrl(null), null, 'null → null');
});

test('httpGetPinned honours an explicit proxy: null (direct) vs a proxy URL', async () => {
  // Direct (proxy: null): the pinned transport fetches the card straight from the server.
  const direct = await httpGetPinned(cardUrl(good.port), {
    lookup: LOOPBACK_LOOKUP,
    timeoutMs: 5000,
    maxBytes: 1_000_000,
    allowPrivateHosts: true,
    proxy: null,
    ca: caPem,
  });
  ok(direct.ok && direct.bytes !== null, 'direct fetch succeeds');
  eq(direct.bytes!.byteLength, 2777, 'direct fetch returns the 2777-byte card');
  // Via the local proxy: the same bytes arrive through the CONNECT tunnel to the pinned IP.
  const before = connectTargets.length;
  const viaProxy = await httpGetPinned(cardUrl(good.port), {
    lookup: LOOPBACK_LOOKUP,
    timeoutMs: 5000,
    maxBytes: 1_000_000,
    allowPrivateHosts: true,
    proxy: PROXY_URL,
    ca: caPem,
  });
  ok(viaProxy.ok && viaProxy.bytes !== null, 'proxied fetch succeeds');
  eq(viaProxy.bytes!.byteLength, 2777, 'proxied fetch returns the 2777-byte card');
  eq(sha256Hex(viaProxy.bytes!), CARD_HASH, 'proxied bytes hash to the on-chain hash');
  const seen = connectTargets.slice(before);
  ok(seen.length >= 1, 'the proxy was used');
  ok(
    seen.every(t => t === `127.0.0.1:${good.port}`),
    `CONNECT went to the pinned IP, not the hostname: ${seen.join(', ')}`,
  );
});

test('CONNECT to a pinned IPv6 address: bracketed target, TLS still verified', async () => {
  const before = connectTargets.length;
  const r = await verify(cardUrl(good6.port), {
    proxy: PROXY_URL,
    lookup: () => Promise.resolve([{ address: '::1', family: 6 }]),
  });
  eq(r.trust_decision, 'TRUSTED', 'TRUSTED through the proxy to the IPv6 address');
  eq(r.card_retrieved, 'PASS', 'card_retrieved through the proxy');
  const seen = connectTargets.slice(before);
  ok(seen.length >= 1, 'the proxy was used');
  ok(
    seen.every(t => t === `[::1]:${good6.port}`),
    `CONNECT used the bracketed IPv6 literal: ${seen.join(', ')}`,
  );
});

// ─── runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${e instanceof Error ? e.message : e}`);
  }
}
good.close();
good6.close();
wrongHost.close();
untrusted.close();
hanging.close();
tamperedServer.close();
proxy.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\npinned-transport: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
