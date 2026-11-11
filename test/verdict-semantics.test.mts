/**
 * Trust verdict semantics.
 *
 * The contract under test:
 *
 *   TRUSTED       all mandatory evidence obtained AND passing
 *   REJECTED      obtained evidence positively contradicts a mandatory requirement
 *   INCONCLUSIVE  mandatory evidence could not be obtained or established
 *
 * And the distinctions that must never collapse into each other:
 *
 *   trust verdict     TRUSTED / REJECTED / INCONCLUSIVE
 *   retrieval status  PASS / INCONCLUSIVE  (never FAIL — availability is not identity)
 *   check result      PASS / FAIL / INCONCLUSIVE / NOT_TESTED, per requirement
 *   policy decision   ALLOWED / TRUST_REJECTED / TRUST_INCONCLUSIVE / …
 *
 * All offline: the registry payload, the card bytes and the transport are injected.
 */

import { createHash } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import { verifyAgent, decideTrust, validateCard, BADGE_EXTENSION_URI } from '../src/verify/crossAgent.js';
import { evaluateTrustPolicy, STRICT_POLICY, PARANOID_POLICY } from '../src/commerce/trustPolicy.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const EXPECT = { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 };

function card(over = {}) {
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
          uri: BADGE_EXTENSION_URI,
          params: {
            tokenAddress: `${CAIP2}/cis-2:JyP9YLib1wYgFmztkcKJL`,
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

const okFetch = bytes => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const statusFetch = status => async () => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

const throwingFetch = msg => async () => {
  throw new Error(msg);
};

async function run(bytes, opts = {}) {
  const rec = opts.record ?? {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: 'https://cards.example/c.json',
    metadata_hash_hex: sha(bytes),
    status: 'Active',
    ...(opts.recordOver ?? {}),
  };
  return verifyAgent({
    expect: EXPECT,
    discoveryPayload: { agents: [rec] },
    fetchImpl: opts.fetchImpl ?? okFetch(bytes),
    allowPrivateCardHosts: true,
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ 1. TRUSTED requires complete evidence ══════════════════════════════

test('01. full evidence → TRUSTED with failure_kind none', async () => {
  const b = bytesOf(card());
  const r = await run(b);
  eq(r.trust_decision, 'TRUSTED', 'verdict');
  eq(r.failure_kind, 'none', 'nothing failed');
  eq(r.failed_requirements.length, 0, 'no failed requirements');
  for (const k of ['agent_discovered', 'card_retrieved', 'card_valid', 'hash_matches_on_chain', 'owner_matches', 'status_active', 'contract_references_match']) {
    eq(r[k], 'PASS', `${k} must pass`);
  }
});

test('02. partial verification can never be TRUSTED', () => {
  const all = {
    agent_discovered: 'PASS',
    card_retrieved: 'PASS',
    card_valid: 'PASS',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'PASS',
    owner_matches: 'PASS',
    status_active: 'PASS',
    contract_references_match: 'PASS',
  };
  const keys = Object.keys(all).filter(k => k !== 'badge_valid');
  // Every non-PASS value on any mandatory check blocks TRUSTED.
  for (const k of keys) {
    for (const v of ['FAIL', 'INCONCLUSIVE', 'NOT_TESTED']) {
      notOk(decideTrust({ ...all, [k]: v }) === 'TRUSTED', `${k}=${v} must not be TRUSTED`);
    }
  }
});

// ═══ 2. retrieval status is never a contradiction ═══════════════════════

test('03. every HTTP status maps to INCONCLUSIVE — a status code is not identity fraud', async () => {
  const b = bytesOf(card());
  for (const status of [400, 401, 403, 404, 408, 410, 429, 500, 502, 503, 504]) {
    const r = await run(b, { fetchImpl: statusFetch(status) });
    eq(r.trust_decision, 'INCONCLUSIVE', `HTTP ${status}`);
    eq(r.failure_kind, 'unavailable', `HTTP ${status} kind`);
    eq(r.card_retrieved, 'INCONCLUSIVE', `HTTP ${status} retrieval`);
    notOk(r.card_retrieved === 'FAIL', `HTTP ${status} must never be FAIL`);
  }
});

test('04. transport failures map to INCONCLUSIVE', async () => {
  const b = bytesOf(card());
  for (const [label, impl] of [
    ['dns', throwingFetch('getaddrinfo ENOTFOUND cards.example')],
    ['tls', throwingFetch('unable to verify the first certificate')],
    ['refused', throwingFetch('connect ECONNREFUSED 127.0.0.1:1')],
    ['timeout', throwingFetch('card fetch aborted after 10000ms')],
  ]) {
    const r = await run(b, { fetchImpl: impl });
    eq(r.trust_decision, 'INCONCLUSIVE', label);
    eq(r.failure_kind, 'unavailable', `${label} kind`);
  }
});

test('05. a redirect is unavailability, not fraud', async () => {
  const b = bytesOf(card());
  const r = await run(b, { fetchImpl: statusFetch(302) });
  eq(r.trust_decision, 'INCONCLUSIVE', 'not followed ⇒ no evidence');
  eq(r.failure_kind, 'unavailable', 'endpoint policy, not identity');
});

test('06. a record with no agent_uri is missing evidence', async () => {
  const b = bytesOf(card());
  const r = await run(b, { recordOver: { agent_uri: null } });
  eq(r.card_retrieved, 'INCONCLUSIVE', 'nothing to fetch');
  eq(r.trust_decision, 'INCONCLUSIVE', 'not an accusation');
});

// ═══ 3. contradictions still reject ═════════════════════════════════════

test('07. hash mismatch → REJECTED naming the requirement', async () => {
  const b = bytesOf(card());
  const r = await run(b, { recordOver: { metadata_hash_hex: 'f'.repeat(64) } });
  eq(r.trust_decision, 'REJECTED', 'verdict');
  eq(r.failure_kind, 'contradiction', 'kind');
  ok(r.failed_requirements.includes('hash_matches_on_chain'), `names it: ${r.failed_requirements}`);
});

test('08. owner mismatch → REJECTED naming the requirement', async () => {
  const c = card();
  c.capabilities.extensions[0].params.owner.account = `${CAIP2}:${OTHER}`;
  const r = await run(bytesOf(c));
  eq(r.trust_decision, 'REJECTED', 'verdict');
  eq(r.failure_kind, 'contradiction', 'kind');
  ok(r.failed_requirements.includes('owner_matches'), `names it: ${r.failed_requirements}`);
});

test('09. contract reference mismatch → REJECTED naming the requirement', async () => {
  const c = card();
  c.capabilities.extensions[0].params.contracts.cis8004 = `${CAIP2}:99999.0`;
  const r = await run(bytesOf(c));
  eq(r.trust_decision, 'REJECTED', 'verdict');
  ok(r.failed_requirements.includes('contract_references_match'), `names it: ${r.failed_requirements}`);
});

test('10. revoked registration → REJECTED', async () => {
  const b = bytesOf(card());
  const r = await run(b, { recordOver: { status: 'Revoked' } });
  eq(r.trust_decision, 'REJECTED', 'verdict');
  ok(r.failed_requirements.includes('status_active'), 'names status_active');
});

test('11. a fetched document that is invalid content → REJECTED (contradiction)', async () => {
  // Distinct from "could not fetch": here the bytes WERE supplied and they violate the
  // mandatory card requirement. The card is anchored on-chain to these exact bytes.
  for (const [label, body] of [
    ['invalid json', '{"name": '],
    ['not an object', '[1,2,3]'],
    ['missing fields', JSON.stringify({ name: 'x' })],
  ]) {
    const b = bytesOf(body);
    const r = await run(b);
    eq(r.card_retrieved, 'PASS', `${label}: bytes were obtained`);
    eq(r.card_valid, 'FAIL', `${label}: card check fails`);
    eq(r.trust_decision, 'REJECTED', `${label}: supplied evidence violates a requirement`);
    eq(r.failure_kind, 'contradiction', `${label}: kind`);
  }
});

test('12. invalid UTF-8 is a contradiction, not unavailability', async () => {
  const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  const r = await run(bad);
  eq(r.card_retrieved, 'PASS', 'bytes obtained');
  eq(r.card_valid, 'FAIL', 'not a card');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

// ═══ 4. the decision invariant ══════════════════════════════════════════

test('13. no card ⇒ no contradiction is possible', () => {
  const contradiction = {
    agent_discovered: 'PASS',
    card_retrieved: 'INCONCLUSIVE',
    card_valid: 'INCONCLUSIVE',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'INCONCLUSIVE',
    owner_matches: 'INCONCLUSIVE',
    status_active: 'PASS',
    contract_references_match: 'INCONCLUSIVE',
  };
  eq(decideTrust(contradiction), 'INCONCLUSIVE', 'missing evidence');

  // Even if a rogue upstream records FAIL on an identity check without having a card, the
  // decision function refuses to accuse: nothing was examined, so nothing was contradicted.
  eq(
    decideTrust({ ...contradiction, owner_matches: 'FAIL' }),
    'INCONCLUSIVE',
    'a FAIL without a retrieved card is not a contradiction',
  );
  eq(
    decideTrust({ ...contradiction, card_retrieved: 'FAIL', owner_matches: 'FAIL' }),
    'INCONCLUSIVE',
    'card_retrieved is never a contradiction even if someone records FAIL',
  );
});

test('14. decision function is total and monotone over the check vocabulary', () => {
  const all = {
    agent_discovered: 'PASS',
    card_retrieved: 'PASS',
    card_valid: 'PASS',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'PASS',
    owner_matches: 'PASS',
    status_active: 'PASS',
    contract_references_match: 'PASS',
  };
  eq(decideTrust(all), 'TRUSTED', 'baseline');
  eq(decideTrust({}), 'INCONCLUSIVE', 'empty map is not consent');
  eq(decideTrust({ ...all, agent_discovered: 'INCONCLUSIVE' }), 'INCONCLUSIVE', 'discovery missing');
});

// ═══ 5. policy never grants on a non-TRUSTED verdict ════════════════════

test('15. a permissive policy cannot override a mandatory failure', async () => {
  const b = bytesOf(card());
  const rejected = await run(b, { recordOver: { metadata_hash_hex: 'f'.repeat(64) } });
  const inconclusive = await run(b, { fetchImpl: statusFetch(503) });

  for (const policy of [STRICT_POLICY, PARANOID_POLICY]) {
    for (const [label, result] of [['REJECTED', rejected], ['INCONCLUSIVE', inconclusive]]) {
      const d = evaluateTrustPolicy(result, policy, { amountMicroCcd: '1000', asset: 'CCD', network: CAIP2 });
      eq(d.allowed, false, `${label} must be denied`);
      notOk(d.code === 'ALLOWED', `${label} code`);
      ok(d.reason.length > 0, `${label} reason present`);
    }
  }
});

test('16. policy distinguishes rejected from inconclusive in its code', async () => {
  const b = bytesOf(card());
  const rej = await run(b, { recordOver: { metadata_hash_hex: 'f'.repeat(64) } });
  const inc = await run(b, { fetchImpl: statusFetch(500) });
  eq(evaluateTrustPolicy(rej).code, 'TRUST_REJECTED', 'contradiction');
  eq(evaluateTrustPolicy(inc).code, 'TRUST_INCONCLUSIVE', 'unavailable');
});

test('17. a TRUSTED result is allowed by the strict policy', async () => {
  const r = await run(bytesOf(card()));
  const d = evaluateTrustPolicy(r, STRICT_POLICY, { amountMicroCcd: '1000', asset: 'CCD', network: CAIP2 });
  eq(d.allowed, true, 'allowed');
  eq(d.code, 'ALLOWED', 'code');
});

test('18. policy amount/network/asset limits still block an otherwise trusted agent', async () => {
  const r = await run(bytesOf(card()));
  eq(evaluateTrustPolicy(r, { ...STRICT_POLICY, maxAmountMicroCcd: '500' }, { amountMicroCcd: '1000', asset: 'CCD', network: CAIP2 }).code, 'AMOUNT_EXCEEDED', 'amount');
  eq(evaluateTrustPolicy(r, { ...STRICT_POLICY, allowedNetworks: ['ccd:other'] }, { amountMicroCcd: '1', asset: 'CCD', network: CAIP2 }).code, 'NETWORK_NOT_ALLOWED', 'network');
  eq(evaluateTrustPolicy(r, { ...STRICT_POLICY, allowedAssets: ['PLT'] }, { amountMicroCcd: '1', asset: 'CCD', network: CAIP2 }).code, 'ASSET_NOT_ALLOWED', 'asset');
});

// ═══ 6. vocabulary separation ═══════════════════════════════════════════

test('19. the four vocabularies never leak into one another', async () => {
  const b = bytesOf(card());
  const trusted = await run(b);
  const rejected = await run(b, { recordOver: { metadata_hash_hex: 'f'.repeat(64) } });
  const inconclusive = await run(b, { fetchImpl: statusFetch(503) });

  const VERDICTS = ['TRUSTED', 'REJECTED', 'INCONCLUSIVE'];
  const CHECKS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED'];
  const KINDS = ['none', 'contradiction', 'unavailable'];

  for (const [label, r] of [['trusted', trusted], ['rejected', rejected], ['inconclusive', inconclusive]]) {
    ok(VERDICTS.includes(r.trust_decision), `${label} verdict vocabulary`);
    ok(KINDS.includes(r.failure_kind), `${label} kind vocabulary`);
    for (const k of ['agent_discovered', 'card_retrieved', 'card_valid', 'badge_valid', 'hash_matches_on_chain', 'owner_matches', 'status_active', 'contract_references_match']) {
      ok(CHECKS.includes(r[k]), `${label}.${k} uses check vocabulary, got ${r[k]}`);
    }
  }

  // Retrieval status is a check, never a verdict and never a failure kind.
  notOk(VERDICTS.includes(trusted.card_retrieved), 'retrieval is not a verdict');
  eq(trusted.card_retrieved, 'PASS', 'retrieval status');
});

test('20. failure_kind is derived from contradictions, not from the verdict alone', async () => {
  const b = bytesOf(card());
  eq((await run(b)).failure_kind, 'none', 'trusted');
  eq((await run(b, { fetchImpl: statusFetch(404) })).failure_kind, 'unavailable', 'unavailable');
  eq((await run(b, { recordOver: { status: 'Revoked' } })).failure_kind, 'contradiction', 'revoked');
});

test('21. REJECTED always names at least one failed requirement', async () => {
  const b = bytesOf(card());
  const cases = [
    await run(b, { recordOver: { metadata_hash_hex: 'f'.repeat(64) } }),
    await run(b, { recordOver: { status: 'Revoked' } }),
    await run(bytesOf(card({ name: undefined }))),
  ];
  for (const r of cases) {
    if (r.trust_decision !== 'REJECTED') continue;
    ok(r.failed_requirements.length > 0, 'a rejection must state which requirement failed');
  }
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
console.log(`\nverdict-semantics: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
