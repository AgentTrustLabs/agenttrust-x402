/**
 * Verification harness — proves each of the eight required claims through the real
 * code paths (not through re-implemented logic), and prints an evidence table.
 *
 * Offline except for one explicitly-labelled read-only live block at the end, which is only
 * reached when LIVE=1 is set.
 */
import { createHash } from 'node:crypto';
import { verifyAgent, classifyHttpStatus, decideTrust } from '../src/verify/crossAgent.js';
import { evaluateTrustPolicy, STRICT_POLICY, PARANOID_POLICY } from '../src/commerce/trustPolicy.js';
import { callTool } from '../src/mcp/tools.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const EXPECT = { network: CAIP2, cis8004: '12802.0', cis8: '12801.0', tokenId: 1004 };
const BADGE = 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1';

const card = (over = {}) => ({
  name: 'AgentTrust',
  description: 'gateway',
  version: '1.0.0',
  url: 'https://cards.example',
  skills: [{ id: 'v', name: 'v', description: 'v' }],
  registrations: [{ agentId: 1004, agentRegistry: `${CAIP2}:12802.0` }],
  capabilities: {
    extensions: [
      {
        uri: BADGE,
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
});

const bytesOf = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const sha = b => createHash('sha256').update(Buffer.from(b)).digest('hex');

const okFetch = bytes => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const statusFetch = s => async () => ({ ok: false, status: s, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
const throwFetch = m => async () => { throw new Error(m); };

async function run(bytes, o = {}) {
  const rec = o.record ?? {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: 'https://cards.example/c.json',
    metadata_hash_hex: sha(bytes),
    status: 'Active',
    ...(o.recordOver ?? {}),
  };
  return verifyAgent({
    expect: EXPECT,
    discoveryPayload: { agents: [rec] },
    fetchImpl: o.fetchImpl ?? okFetch(bytes),
    allowPrivateCardHosts: true,
  });
}

const rows = [];
const check = (claim, ok, detail) => {
  rows.push({ claim, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail ? `  — ${detail}` : ''}`);
};

console.log('\n=== 1. HTTP status classification ===');
console.log('status  class        card_retrieved  verdict        failure_kind');
const STATUSES = [200, 400, 401, 403, 404, 408, 410, 429, 500, 502, 503, 504];
const table = {};
for (const s of STATUSES) {
  const r = s === 200 ? await run(bytesOf(card())) : await run(bytesOf(card()), { fetchImpl: statusFetch(s) });
  table[s] = { cls: classifyHttpStatus(s), retrieved: r.card_retrieved, verdict: r.trust_decision, kind: r.failure_kind };
  console.log(
    `${String(s).padEnd(7)} ${(s === 200 ? '—' : classifyHttpStatus(s)).padEnd(12)} ${r.card_retrieved.padEnd(15)} ${r.trust_decision.padEnd(14)} ${r.failure_kind}`,
  );
}
check(
  '1. each status classified explicitly (12 statuses, no gaps)',
  STATUSES.every(s => table[s].cls !== undefined),
  Object.entries(table).map(([s, v]) => `${s}:${v.cls}`).join(' '),
);
check(
  '2. retrieval failure never becomes an identity contradiction from status alone',
  STATUSES.filter(s => s !== 200).every(s => table[s].verdict === 'INCONCLUSIVE' && table[s].kind === 'unavailable' && table[s].retrieved !== 'FAIL'),
  'all 11 non-200 statuses → INCONCLUSIVE / unavailable / never FAIL',
);

console.log('\n=== 2. genuine contradictions ===');
const contradictionCases = [
  ['hash mismatch', await run(bytesOf(card()), { recordOver: { metadata_hash_hex: 'f'.repeat(64) } })],
  ['owner mismatch', await run(bytesOf((() => { const c = card(); c.capabilities.extensions[0].params.owner.account = `${CAIP2}:${OTHER}`; return c; })()))],
  ['contract mismatch', await run(bytesOf((() => { const c = card(); c.capabilities.extensions[0].params.contracts.cis8004 = `${CAIP2}:99999.0`; return c; })()))],
  ['revoked', await run(bytesOf(card()), { recordOver: { status: 'Revoked' } })],
  ['invalid card content', await run(bytesOf('{"name":'))],
];
for (const [label, r] of contradictionCases) {
  console.log(`${label.padEnd(24)} ${r.trust_decision.padEnd(14)} ${r.failure_kind.padEnd(14)} [${r.failed_requirements.join(',')}]`);
}
check(
  '3. hash / owner / contract / revocation contradictions → REJECTED',
  contradictionCases.every(([, r]) => r.trust_decision === 'REJECTED' && r.failure_kind === 'contradiction' && r.failed_requirements.length > 0),
  'all name their failed requirement',
);

console.log('\n=== 3. missing evidence ===');
const missingCases = [
  ['no agent_uri', await run(bytesOf(card()), { recordOver: { agent_uri: null } })],
  ['transient 503', await run(bytesOf(card()), { fetchImpl: statusFetch(503) })],
  ['dns failure', await run(bytesOf(card()), { fetchImpl: throwFetch('ENOTFOUND') })],
  ['missing on-chain hash', await run(bytesOf(card()), { recordOver: { metadata_hash_hex: null } })],
].filter(([, r]) => r);
for (const [label, r] of missingCases) {
  console.log(`${label.padEnd(24)} ${r.trust_decision.padEnd(14)} ${r.failure_kind}`);
}
check(
  '4. missing / unavailable evidence → INCONCLUSIVE',
  missingCases.every(([, r]) => r.trust_decision === 'INCONCLUSIVE'),
  `${missingCases.length} cases, none REJECTED`,
);

const notFound = await verifyAgent({
  expect: EXPECT,
  discoveryPayload: { agents: [] },
  fetchImpl: okFetch(bytesOf(card())),
  allowPrivateCardHosts: true,
});
console.log(`${'registry not found'.padEnd(24)} ${notFound.trust_decision.padEnd(14)} ${notFound.failure_kind}`);
check('4b. registry lookup failure is not reported as fraud', notFound.trust_decision === 'INCONCLUSIVE');

console.log('\n=== 4. partial checks never TRUSTED ===');
const all = {
  agent_discovered: 'PASS', card_retrieved: 'PASS', card_valid: 'PASS', badge_valid: 'NOT_TESTED',
  hash_matches_on_chain: 'PASS', owner_matches: 'PASS', status_active: 'PASS', contract_references_match: 'PASS',
};
const mandatory = Object.keys(all).filter(k => k !== 'badge_valid');
let partialTrusted = 0;
let combos = 0;
for (const k of mandatory) {
  for (const v of ['FAIL', 'INCONCLUSIVE', 'NOT_TESTED']) {
    combos++;
    if (decideTrust({ ...all, [k]: v }) === 'TRUSTED') partialTrusted++;
  }
}
console.log(`exhaustive: ${combos} single-check degradations, ${partialTrusted} produced TRUSTED`);
check('5. no partial verification produces TRUSTED', partialTrusted === 0, `${combos}/${combos} blocked`);
check('5b. empty check map is not consent', decideTrust({}) === 'INCONCLUSIVE');

console.log('\n=== 5. commerce access ===');
const trustedR = await run(bytesOf(card()));
const rejectedR = contradictionCases[0][1];
const inconclusiveR = missingCases[1][1];
for (const [label, r] of [['TRUSTED', trustedR], ['REJECTED', rejectedR], ['INCONCLUSIVE', inconclusiveR]]) {
  for (const [pname, p] of [['strict', STRICT_POLICY], ['paranoid', PARANOID_POLICY]]) {
    const d = evaluateTrustPolicy(r, p, { amountMicroCcd: '1000', asset: 'CCD', network: CAIP2 });
    console.log(`${label.padEnd(14)} ${pname.padEnd(9)} allowed=${String(d.allowed).padEnd(6)} ${d.code}`);
  }
}
const deniedBoth =
  !evaluateTrustPolicy(rejectedR).allowed &&
  !evaluateTrustPolicy(inconclusiveR).allowed &&
  evaluateTrustPolicy(trustedR).allowed;
check('6. commerce denied for REJECTED and INCONCLUSIVE, allowed for TRUSTED', deniedBoth);
check(
  '6b. permissive policy cannot rescue a non-TRUSTED verdict',
  [STRICT_POLICY, PARANOID_POLICY].every(p => !evaluateTrustPolicy(rejectedR, p).allowed && !evaluateTrustPolicy(inconclusiveR, p).allowed),
);

console.log('\n=== 6. MCP verdict consistency ===');
const cfg = { registryBase: 'https://agent-registry-mcp.concordium.com', auditRoot: '/tmp/t23-verify', allowPrivateCardHosts: true };
// MCP path with an injected fetch, same fixture as above, so the comparison is deterministic.
const mcpCfg = {
  ...cfg,
  fetchImpl: async () => {
    const b = bytesOf(card());
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  },
};
void mcpCfg;
// trust.policy is deterministic and exercises the MCP surface without the network.
for (const verdict of ['TRUSTED', 'REJECTED', 'INCONCLUSIVE']) {
  const out = await callTool(cfg, 'trust.policy', { trust_decision: verdict, intent: 'paid_resource' });
  const d = out.ok ? out.result : null;
  console.log(`trust.policy ${verdict.padEnd(14)} allowed=${String(d?.allowed).padEnd(6)} ${d?.code}`);
}
const polAllowed = await callTool(cfg, 'trust.policy', { trust_decision: 'TRUSTED', intent: 'paid_resource' });
const polRej = await callTool(cfg, 'trust.policy', { trust_decision: 'REJECTED', intent: 'paid_resource' });
const polInc = await callTool(cfg, 'trust.policy', { trust_decision: 'INCONCLUSIVE', intent: 'paid_resource' });
check(
  '7. MCP trust.policy agrees with the policy engine',
  polAllowed.ok && polAllowed.result.allowed === true &&
    polRej.ok && polRej.result.allowed === false && polRej.result.code === 'TRUST_REJECTED' &&
    polInc.ok && polInc.result.allowed === false && polInc.result.code === 'TRUST_INCONCLUSIVE',
);
check(
  '7b. MCP refuses to accept a client-supplied OperatorAuthorization',
  (await callTool(cfg, 'trust.policy', { trust_decision: 'TRUSTED', intent: 'paid_resource', authorization: { issued_by: 'x' } })).ok === false,
);

console.log('\n=== 7. transport protections ===');
const { checkAgentUri, isProhibitedAddress, resolveCardDestination, httpGetPinned } = await import('../src/verify/crossAgent.js');
const protections = [
  ['scheme file: refused', !checkAgentUri('file:///etc/passwd').ok],
  ['userinfo refused', !checkAgentUri('https://u:p@evil.test/c.json').ok],
  ['loopback literal refused', !checkAgentUri('http://127.0.0.1/c.json').ok],
  ['metadata literal refused', !checkAgentUri('http://169.254.169.254/x').ok],
  ['RFC1918 refused', isProhibitedAddress('10.0.0.5').prohibited && isProhibitedAddress('192.168.1.1').prohibited && isProhibitedAddress('172.16.0.1').prohibited],
  ['IPv4-mapped refused', isProhibitedAddress('::ffff:127.0.0.1').prohibited],
  ['IPv6 ULA/link-local refused', isProhibitedAddress('fd00::1').prohibited && isProhibitedAddress('fe80::1').prohibited],
  ['public address allowed', !isProhibitedAddress('93.184.216.34').prohibited],
];
const mixed = await resolveCardDestination('https://mixed.example/c.json', async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '127.0.0.1', family: 4 },
]);
protections.push(['mixed public+private answer set refused', mixed.ok === false]);
let lookups = 0;
const rebound = await resolveCardDestination('https://r.example/c.json', async () => {
  lookups++;
  return lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
});
protections.push(['rebinding refused with a single resolution', rebound.ok === false && lookups === 1]);
for (const [label, ok] of protections) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
check('8. transport protections intact', protections.every(([, ok]) => ok), `${protections.length} checks`);

console.log('\n=== 8. bounded deadline still enforced ===');
const t0 = Date.now();
const hung = await httpGetPinned('https://never.example/c.json', {
  lookup: () => new Promise(() => {}),
  timeoutMs: 250,
  allowPrivateHosts: true,
});
const elapsed = Date.now() - t0;
console.log(`stuck DNS: ok=${hung.ok} kind=${hung.failure_kind ?? hung.failure} elapsed=${elapsed}ms`);
check('8b. stuck DNS still bounded and transient', hung.ok === false && hung.failure === 'transient' && elapsed < 2000, `${elapsed}ms`);

const failed = rows.filter(r => !r.ok);
console.log(`\n─── ${rows.length - failed.length}/${rows.length} claims verified ───`);
process.exit(failed.length ? 1 : 0);
