/**
 * Agent Card validation & trust boundary.
 *
 * Every case here is offline and deterministic: the card bytes, the HTTP responses,
 * and the registry record are all injected. Nothing is fetched from the network and
 * nothing is signed or settled.
 *
 * Assertions encode the *required* semantics from the task, not the current behavior —
 * so a failing test is a reproduced defect, not a test that needs adjusting.
 */

import { createHash } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import {
  verifyAgent,
  validateCard,
  compareCardToRecord,
  compareHashes,
  decideTrust,
  localSha256,
  fetchCardBytes,
  BADGE_EXTENSION_URI,
} from '../src/verify/crossAgent.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const TOKEN_ADDRESS = `${CAIP2}/cis-2:JyP9YLib1wYgFmztkcKJL`;
const CARD_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';

const EXPECT = { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 };

function card(over = {}) {
  return {
    name: 'AgentTrust',
    description: 'Verifiable trust and x402 payments for independently operated agents',
    version: '1.0.0',
    url: 'https://api.sabokun.my.id/agenttrust',
    skills: [{ id: 'verify', name: 'verify', description: 'verify an agent' }],
    registrations: [{ agentId: 1004, agentRegistry: `${CAIP2}:12802.0` }],
    capabilities: {
      extensions: [
        {
          uri: BADGE_EXTENSION_URI,
          params: {
            tokenAddress: TOKEN_ADDRESS,
            owner: { account: `${CAIP2}:${OWNER}` },
            agentWallet: `${CAIP2}:${OWNER}`,
            contracts: { cis8004: `${CAIP2}:12802.0`, cis8: `${CAIP2}:12801.0` },
          },
        },
      ],
    },
    ...over,
  };
}

const bytesOf = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const sha = b => createHash('sha256').update(Buffer.from(b)).digest('hex');

/** Registry record whose on-chain hash matches these exact bytes. */
function record(bytes, over = {}) {
  return {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: CARD_URI,
    metadata_hash_hex: sha(bytes),
    status: 'Active',
    ...over,
  };
}

const search = rec => ({ agents: [rec] });

/** fetch stub returning a fixed body. */
const fetchReturning = (bytes, init = {}) => async () => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  headers: { get: n => (n.toLowerCase() === 'content-type' ? (init.contentType ?? 'application/json') : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const fetchFailing = (status = 404) => async () => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

const fetchThrowing = () => async () => {
  throw new Error('getaddrinfo ENOTFOUND api.example.invalid');
};

const fetchHanging = () => () => new Promise(() => {});

async function run(bytes, opts = {}) {
  const rec = opts.record ?? record(bytes, opts.recordOver ?? {});
  const discovery = 'discoveryPayload' in opts ? opts.discoveryPayload : search(rec);
  return verifyAgent({
    expect: { ...EXPECT, ...(opts.expectOver ?? {}) },
    discoveryPayload: discovery,
    fetchImpl: opts.fetchImpl ?? fetchReturning(bytes),
    badge: { consulted: false, raw: null, error: null },
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ A. Retrieval ═══════════════════════════════════════════════════════

test('A1. HTTP 4xx: the card is not served → INCONCLUSIVE, not fraud', async () => {
  // Corrected this. A 404 says the endpoint does not serve the card; it does not
  // say the owner or identity claim is false. Retrieval status is never FAIL.
  const r = await run(bytesOf(card()), { fetchImpl: fetchFailing(404) });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'retrieval status, not a contradiction');
  eq(r.failure_kind, 'unavailable', 'evidence missing');
  eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
});

test('A2. HTTP 5xx: the card cannot be established → INCONCLUSIVE, not fraud', async () => {
  const r = await run(bytesOf(card()), { fetchImpl: fetchFailing(503) });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'a server-side outage is missing evidence, not proof of misconduct');
  eq(r.trust_decision, 'INCONCLUSIVE', 'never REJECTED for an outage');
});

test('A3. transport failure: cannot establish → INCONCLUSIVE, not fraud', async () => {
  const r = await run(bytesOf(card()), { fetchImpl: fetchThrowing() });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'a DNS/TLS failure proves nothing about the agent');
  eq(r.trust_decision, 'INCONCLUSIVE', 'never REJECTED for a transport error');
});

test('A4. rate limiting (429) and request timeout (408) are unavailable-now → INCONCLUSIVE', async () => {
  for (const status of [429, 408]) {
    const r = await run(bytesOf(card()), { fetchImpl: fetchFailing(status) });
    eq(r.card_retrieved, 'INCONCLUSIVE', `HTTP ${status}`);
    eq(r.trust_decision, 'INCONCLUSIVE', `HTTP ${status} verdict`);
  }
});

test('A5. empty body → not retrieved, never parsed as a card', async () => {
  const r = await run(new TextEncoder().encode(''), { fetchImpl: fetchReturning(new TextEncoder().encode('')) });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'no bytes obtained');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('A6. oversized body is refused before it is buffered', async () => {
  // A 64 MiB "card" must not be read into memory and hashed.
  const huge = new Uint8Array(64 * 1024 * 1024);
  huge.fill(0x20);
  const r = await run(bytesOf(card()), {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: n =>
          n.toLowerCase() === 'content-type'
            ? 'application/json'
            : n.toLowerCase() === 'content-length'
              ? String(huge.byteLength)
              : null,
      },
      arrayBuffer: async () => {
        throw new Error('body must not be read when content-length exceeds the cap');
      },
    }),
  });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'oversized body not accepted as evidence');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('A7. a redirect is not silently followed to another host', async () => {
  // A registry record can point anywhere; a 302 must not be chased by the gateway.
  const r = await run(bytesOf(card()), {
    fetchImpl: async () => ({
      ok: false,
      status: 302,
      headers: {
        get: n => (n.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null),
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  });
  notOk(r.card_retrieved === 'PASS', 'a 3xx is not a retrieved card');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('A8. non-HTTP(S) URL schemes are refused', async () => {
  for (const scheme of ['file:///etc/passwd', 'ftp://example.test/card.json', 'data:application/json,{}', 'gopher://x/1']) {
    const bytes = bytesOf(card());
    const rec = record(bytes, { agent_uri: scheme });
    let fetched = false;
    const r = await verifyAgent({
      expect: EXPECT,
      discoveryPayload: search(rec),
      fetchImpl: async () => {
        fetched = true;
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => bytes.buffer };
      },
      badge: { consulted: false, raw: null, error: null },
    });
    eq(fetched, false, `${scheme} must never reach the transport`);
    notOk(r.trust_decision === 'TRUSTED', `${scheme} never trusted`);
  }
});

test('A9. URLs carrying userinfo or credentials are refused', async () => {
  const bytes = bytesOf(card());
  const rec = record(bytes, { agent_uri: 'https://user:pass@evil.test/card.json' });
  let fetched = false;
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: search(rec),
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => bytes.buffer };
    },
    badge: { consulted: false, raw: null, error: null },
  });
  eq(fetched, false, 'userinfo URL must not be fetched');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('A10. loopback and private-network literals are refused', async () => {
  const bytes = bytesOf(card());
  for (const host of ['http://127.0.0.1/card.json', 'http://localhost:8080/card.json', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/card.json', 'http://192.168.1.1/card.json']) {
    const rec = record(bytes, { agent_uri: host });
    let fetched = false;
    const r = await verifyAgent({
      expect: EXPECT,
      discoveryPayload: search(rec),
      fetchImpl: async () => {
        fetched = true;
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => bytes.buffer };
      },
      badge: { consulted: false, raw: null, error: null },
    });
    eq(fetched, false, `${host} must never be fetched`);
    notOk(r.trust_decision === 'TRUSTED', `${host} never trusted`);
  }
});

test('A11. a slow response does not hang verifyAgent forever', async () => {
  // The MCP layer bounds this with withTimeout; verifyAgent itself must not be the
  // only unbounded path. Assert the bound exists at the layer that owns it.
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: search(record(bytesOf(card()))),
    fetchImpl: fetchHanging(),
    badge: { consulted: false, raw: null, error: null },
    cardTimeoutMs: 300,
  });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'a timeout is missing evidence');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('A12. an unhelpful content-type does not by itself decide trust', async () => {
  // Bytes, not the header, are what the on-chain hash binds. A wrong content-type is
  // recorded but must not manufacture a PASS or a FAIL.
  const bytes = bytesOf(card());
  const r = await run(bytes, { fetchImpl: fetchReturning(bytes, { contentType: 'text/plain' }) });
  eq(r.card_retrieved, 'PASS', 'bytes retrieved');
  eq(r.hash_matches_on_chain, 'PASS', 'bytes still hash correctly');
  eq(r.trust_decision, 'TRUSTED', 'content-type is metadata, not evidence');
});

// ═══ B. JSON and card structure ══════════════════════════════════════════

test('B1. invalid JSON → card_valid FAIL → REJECTED', () => {
  const c = validateCard(bytesOf('{"name": "x", oops'));
  eq(c.ok, false, 'invalid');
  ok(c.errors.some(e => /not valid JSON/.test(e)), 'names the reason');
});

test('B2. invalid UTF-8 → card_valid FAIL', () => {
  const c = validateCard(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
  eq(c.ok, false, 'invalid');
  ok(c.errors.some(e => /UTF-8/.test(e)), 'names the reason');
});

test('B3. a JSON array or scalar is not a card', () => {
  for (const body of ['[]', '"a string"', '42', 'null', 'true']) {
    eq(validateCard(bytesOf(body)).ok, false, `${body} is not a card object`);
  }
});

test('B4. missing required A2A fields → FAIL', () => {
  for (const field of ['name', 'description', 'url', 'version', 'skills']) {
    const c = { ...card() };
    delete c[field];
    const r = validateCard(bytesOf(c));
    eq(r.ok, false, `${field} missing`);
    ok(r.errors.some(e => e.includes(field)), `${field} named`);
  }
});

test('B5. wrong field TYPES are rejected, not just missing values', () => {
  const cases = [
    ['name', 12345],
    ['name', { nested: true }],
    ['description', ['a']],
    ['url', 42],
    ['version', false],
    ['skills', 'not-an-array'],
  ];
  for (const [field, value] of cases) {
    const r = validateCard(bytesOf(card({ [field]: value })));
    eq(r.ok, false, `${field}=${JSON.stringify(value)} must be a type error`);
  }
});

test('B6. missing badge extension → FAIL', () => {
  const c = card();
  delete c.capabilities.extensions;
  const r = validateCard(bytesOf(c));
  eq(r.ok, false, 'badge extension is required');
  ok(r.errors.some(e => e.includes('badge extension')), 'named');
});

test('B7. malformed badge metadata → FAIL', () => {
  const variants = [
    { params: undefined },
    { params: { owner: { account: `${CAIP2}:${OWNER}` }, contracts: { cis8004: `${CAIP2}:12802.0` } } }, // no tokenAddress
    { params: { tokenAddress: TOKEN_ADDRESS, contracts: { cis8004: `${CAIP2}:12802.0` } } }, // no owner
    { params: { tokenAddress: TOKEN_ADDRESS, owner: { account: `${CAIP2}:${OWNER}` } } }, // no contracts
  ];
  for (const variant of variants) {
    const c = card();
    c.capabilities.extensions = [{ uri: BADGE_EXTENSION_URI, ...variant }];
    eq(validateCard(bytesOf(c)).ok, false, JSON.stringify(variant).slice(0, 60));
  }
});

test('B8. a structurally valid card is not automatically trusted', async () => {
  // Valid structure, valid JSON, but the bytes are not what the registry anchored.
  const bytes = bytesOf(card());
  const rec = record(bytes, { metadata_hash_hex: 'f'.repeat(64) });
  const r = await run(bytes, { record: rec });
  eq(r.card_valid, 'PASS', 'structure is fine');
  eq(r.hash_matches_on_chain, 'FAIL', 'bytes do not match the anchor');
  eq(r.trust_decision, 'REJECTED', 'never trusted');
});

test('B9. deeply nested JSON does not crash the validator', () => {
  const deep = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000);
  const c = validateCard(bytesOf(deep));
  eq(c.ok, false, 'not a card');
  eq(c.errors.length > 0, true, 'reports a reason rather than throwing');
});

test('B10. card asserting its own trust cannot influence the verdict', async () => {
  const bytes = bytesOf(
    card({
      trust_decision: 'TRUSTED',
      badge_valid: true,
      hash_matches_on_chain: 'PASS',
      owner_matches: 'PASS',
      status_active: 'PASS',
      verified: true,
    }),
  );
  const rec = record(bytes, { metadata_hash_hex: 'f'.repeat(64) });
  const r = await run(bytes, { record: rec });
  eq(r.hash_matches_on_chain, 'FAIL', 'the card cannot author its own hash verdict');
  eq(r.trust_decision, 'REJECTED', 'self-asserted trust is inert');
});

test('B11. a second, conflicting badge extension does not create a second identity', async () => {
  const c = card();
  c.capabilities.extensions = [
    ...c.capabilities.extensions,
    {
      uri: BADGE_EXTENSION_URI,
      params: {
        tokenAddress: TOKEN_ADDRESS,
        owner: { account: `${CAIP2}:${OTHER}` },
        contracts: { cis8004: `${CAIP2}:12802.0`, cis8: `${CAIP2}:12801.0` },
      },
    },
  ];
  const bytes = bytesOf(c);
  const rec = record(bytes);
  const r = await run(bytes, { record: rec });
  // Whatever the resolution order, the verdict must be deterministic and must never be
  // TRUSTED while the document carries two contradictory owners.
  notOk(r.trust_decision === 'TRUSTED', 'conflicting owner claims cannot be trusted');
});

// ═══ C. Trust consistency ════════════════════════════════════════════════

test('C1. hash mismatch → REJECTED', async () => {
  const bytes = bytesOf(card());
  const r = await run(bytes, { record: record(bytes, { metadata_hash_hex: 'a'.repeat(64) }) });
  eq(r.hash_matches_on_chain, 'FAIL', 'mismatch');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('C2. missing on-chain hash → INCONCLUSIVE, never PASS', async () => {
  const bytes = bytesOf(card());
  const r = await run(bytes, { record: record(bytes, { metadata_hash_hex: null }) });
  eq(r.hash_matches_on_chain, 'INCONCLUSIVE', 'no anchor to compare against');
  eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
});

test('C3. owner mismatch between card and registry → REJECTED', async () => {
  const c = card();
  c.capabilities.extensions[0].params.owner.account = `${CAIP2}:${OTHER}`;
  const bytes = bytesOf(c);
  const r = await run(bytes, { record: record(bytes) });
  eq(r.owner_matches, 'FAIL', 'mismatch');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('C4. contract reference mismatch → REJECTED', async () => {
  const c = card();
  c.capabilities.extensions[0].params.contracts.cis8004 = `${CAIP2}:99999.0`;
  const bytes = bytesOf(c);
  const r = await run(bytes, { record: record(bytes) });
  eq(r.contract_references_match, 'FAIL', 'mismatch');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('C5. revoked registration → REJECTED even with a perfectly matching card', async () => {
  const bytes = bytesOf(card());
  const r = await run(bytes, { record: record(bytes, { status: 'Revoked' }) });
  eq(r.status_active, 'FAIL', 'revoked');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('C6. unknown/partial registry data → INCONCLUSIVE, never REJECTED and never TRUSTED', async () => {
  const bytes = bytesOf(card());
  const r = await run(bytes, { record: record(bytes, { status: 'Pending' }) });
  eq(r.status_active, 'INCONCLUSIVE', 'status neither active nor revoked');
  eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
});

test('C7. registry says "not found" → INCONCLUSIVE, not fraud', async () => {
  const r = await run(bytesOf(card()), { discoveryPayload: { agents: [] } });
  eq(r.agent_discovered, 'INCONCLUSIVE', 'absence of a record is absence of evidence');
  eq(r.trust_decision, 'INCONCLUSIVE', 'never REJECTED');
});

test('C8. a malformed discovery payload is INCONCLUSIVE, not "not found"', async () => {
  for (const payload of [null, 'nope', { agents: 'nope' }, 42]) {
    const r = await run(bytesOf(card()), { discoveryPayload: payload });
    eq(r.agent_discovered, 'INCONCLUSIVE', `${JSON.stringify(payload)} is unreadable`);
    eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
  }
});

test('C9. a registry record for a DIFFERENT token id is not accepted', async () => {
  const bytes = bytesOf(card());
  const rec = record(bytes, { token_id: 9999 });
  const r = await run(bytes, { discoveryPayload: search(rec) });
  eq(r.agent_discovered, 'INCONCLUSIVE', 'token mismatch');
  notOk(r.trust_decision === 'TRUSTED', 'never trusted');
});

test('C10. caller-pinned owner disagreement → REJECTED', async () => {
  const bytes = bytesOf(card());
  const r = await run(bytes, { expectOver: { ownerAccount: OTHER } });
  eq(r.owner_matches, 'FAIL', 'the pin wins over the registry record');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('C11. every required check must pass for TRUSTED', () => {
  const allPass = {
    agent_discovered: 'PASS',
    card_retrieved: 'PASS',
    card_valid: 'PASS',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'PASS',
    owner_matches: 'PASS',
    status_active: 'PASS',
    contract_references_match: 'PASS',
  };
  eq(decideTrust(allPass), 'TRUSTED', 'all required checks pass');
  for (const key of Object.keys(allPass).filter(k => k !== 'badge_valid')) {
    eq(decideTrust({ ...allPass, [key]: 'NOT_TESTED' }), 'INCONCLUSIVE', `${key}=NOT_TESTED is not consent`);
    eq(decideTrust({ ...allPass, [key]: 'INCONCLUSIVE' }), 'INCONCLUSIVE', `${key}=INCONCLUSIVE`);
  }
  // Contradiction-capable checks reject; retrieval status never does.
  for (const key of Object.keys(allPass).filter(k => k !== 'badge_valid' && k !== 'card_retrieved')) {
    eq(decideTrust({ ...allPass, [key]: 'FAIL' }), 'REJECTED', `${key}=FAIL`);
  }
  eq(decideTrust({ ...allPass, card_retrieved: 'FAIL' }), 'INCONCLUSIVE', 'an unreachable card cannot be REJECTED');
  eq(decideTrust({ ...allPass, card_retrieved: 'FAIL', owner_matches: 'FAIL' }), 'INCONCLUSIVE', 'no card ⇒ nothing to contradict');
});

test('C12. badge_valid is advisory: a hosted failure cannot override local evidence either way', () => {
  const allPass = {
    agent_discovered: 'PASS',
    card_retrieved: 'PASS',
    card_valid: 'PASS',
    badge_valid: 'FAIL',
    hash_matches_on_chain: 'PASS',
    owner_matches: 'PASS',
    status_active: 'PASS',
    contract_references_match: 'PASS',
  };
  eq(decideTrust(allPass), 'TRUSTED', 'advisory check does not gate');
});

// ═══ D. Hashing ══════════════════════════════════════════════════════════

test('D1. hashing is over exact bytes — no normalization, no re-encoding', () => {
  const a = bytesOf('{"a":1}');
  const b = bytesOf('{ "a" : 1 }');
  notOk(sha(a) === sha(b), 'whitespace changes the digest');
  eq(localSha256(a).hex, sha(a), 'local digest equals an independent sha256');
  eq(localSha256(a).procedure.includes('no normalisation'), true, 'procedure is documented');
});

test('D2. a hash matches regardless of registry hex casing / 0x prefix', () => {
  const h = sha(bytesOf(card()));
  const rec = { metadata_hash_hex: '0x' + h.toUpperCase() };
  eq(compareHashes(h, rec), 'PASS', 'normalized comparison');
  eq(compareHashes('0'.repeat(64), rec), 'FAIL', 'mismatch still fails');
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
console.log(`\ncard-boundary: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
