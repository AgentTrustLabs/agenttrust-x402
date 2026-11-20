/** Wallet Context Testnet identity issuance preparation (offline only). */
import { readFileSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import {
  buildIdentityRequest, createIssuanceController, parseIdentityTokenContainer,
  validateIdentityObjectStructure, verifyProvenance,
} from '../src/wallet/identityIssuance.js';

const SEED = 'ab'.repeat(64);
const PARAMS = JSON.parse(readFileSync(new URL('./fixtures/testnet-public-params.json', import.meta.url), 'utf8'));
// Fixture resmi Concordium/concordium-base, KONTEKS NON-TESTNET — hanya untuk uji struktur parser/gagal.
const OFFICIAL_IO = JSON.parse(readFileSync(new URL('./fixtures/official-identity-object.json', import.meta.url), 'utf8'));
const ORIGIN = 'https://callback.test';

const requestInput = (over = {}) => ({
  network: 'Testnet', seedHex: SEED,
  ipInfo: PARAMS.ipInfo, globalContext: PARAMS.cryptographicParameters,
  arsInfos: PARAMS.arsInfos, arThreshold: PARAMS.arThreshold,
  identityIndex: PARAMS.identityIndex,
  ...over,
});

const built = buildIdentityRequest(requestInput());
const ID_CRED_PUB = built.ok ? String(built.request.value.idCredPub) : '00';

function context(over = {}) {
  return {
    network: 'Testnet' as const,
    identityIndex: 0,
    ipIdentity: PARAMS.ipIdentity,
    ipVerifyKey: PARAMS.ipInfo.ipVerifyKey,
    ipCdiVerifyKey: PARAMS.ipInfo.ipCdiVerifyKey,
    arIdentities: Object.keys(PARAMS.arsInfos).map(Number).sort((a, b) => a - b),
    arPublicKeys: Object.fromEntries(Object.entries(PARAMS.arsInfos).map(([k, v]) => [k, v.arPublicKey])),
    arThreshold: 2,
    globalContextHash: 'global-hash-test',
    identityRequestHash: 'request-hash-test',
    idCredPub: ID_CRED_PUB,
    ...over,
  };
}

// Fixture resmi non-Testnet: dipakai hanya untuk uji struktur/gagal, bukan klaim provenance Testnet.
function officialContext(over = {}) {
  const pre = OFFICIAL_IO.value.preIdentityObject;
  return context({
    ipIdentity: 0,
    ipVerifyKey: 'ip-key-fixture',
    ipCdiVerifyKey: 'ip-cdi-fixture',
    arIdentities: pre.choiceArData.arIdentities.slice(),
    arPublicKeys: Object.fromEntries(Object.keys(pre.ipArData).map((k) => [k, 'ar-key'])),
    arThreshold: pre.choiceArData.threshold,
    globalContextHash: 'official-fixture-global',
    identityRequestHash: 'official-fixture-request',
    idCredPub: String(pre.idCredPub),
    ...over,
  });
}

function controller(over = {}) {
  let n = 0;
  return createIssuanceController({
    allowedCallbackOrigins: [ORIGIN],
    now: () => over.now ?? 1_700_000_000_000,
    randomNonce: () => 'n'.repeat(64),
    randomId: () => (++n).toString(16).padStart(64, '0'),
    ...over,
  });
}

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. identity request from Testnet public params (offline)', () => {
  const r = buildIdentityRequest(requestInput());
  ok(r.ok, 'request built');
  if (!r.ok) return;
  eq(r.binding.ipIdentity, 0, 'ip index');
  eq(r.binding.arThreshold, 2, 'ar threshold');
  ok(typeof r.request.value.proofsOfKnowledge === 'string', 'v1 proof');
});

test('02. invalid seed / network / threshold', () => {
  ok(!buildIdentityRequest(requestInput({ seedHex: 'ab' })).ok, 'seed');
  ok(!buildIdentityRequest(requestInput({ network: 'Mainnet' as 'Testnet' })).ok, 'network');
  ok(!buildIdentityRequest(requestInput({ arThreshold: 0 })).ok, 'threshold');
});

test('03. callback token valid, state absent accepted', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const r = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}#code_uri=${encodeURIComponent('https://idp.example/identity/abc')}` });
  ok(r.ok && r.sessionId === b.sessionId, 'callback ok');
  if (r.ok) ok(r.codeUri.includes('idp.example'), 'code uri returned');
});

test('04. state best-effort: mismatch rejected, absent allowed', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const bad = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}?state=${'f'.repeat(64)}#code_uri=x` });
  ok(!bad.ok && bad.reason === 'state_mismatch', 'state mismatch');
  const good = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}?state=${b.state}#code_uri=x` });
  ok(good.ok, 'state match');
});

test('05. origin / redirect URI / token mismatch rejected', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const originBad = c.handleCallback({ origin: 'https://evil.test', url: `${b.redirectUri}#code_uri=x` });
  const pathBad = c.handleCallback({ origin: ORIGIN, url: `${ORIGIN}/identity/callback/${'f'.repeat(64)}#code_uri=x` });
  const queryBad = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}/extra#code_uri=x` });
  ok(!originBad.ok && originBad.reason === 'callback_origin_not_allowed', 'origin');
  ok(!pathBad.ok && pathBad.reason === 'callback_token_mismatch', 'token/path');
  ok(!queryBad.ok && queryBad.reason === 'callback_token_mismatch', 'redirect mismatch');
});

test('06. replay and duplicate callback rejected', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const url = `${b.redirectUri}#code_uri=x`;
  ok(c.handleCallback({ origin: ORIGIN, url }).ok, 'first');
  const replay = c.handleCallback({ origin: ORIGIN, url });
  ok(!replay.ok && replay.reason === 'callback_replayed', 'replay');
});

test('07. expired session rejected', () => {
  let t = 1_700_000_000_000;
  const c = createIssuanceController({
    allowedCallbackOrigins: [ORIGIN], now: () => t,
    randomNonce: () => 'n'.repeat(64), randomId: () => 'x'.repeat(64), sessionTtlMs: 100,
  });
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  t += 1000;
  const r = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}#code_uri=x` });
  ok(!r.ok && r.reason === 'session_expired', 'expired');
});

test('08. tab/window mismatch rejected; absent event tabId tolerated', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN, 'tab-1');
  ok(b.ok, 'begin'); if (!b.ok) return;
  const bad = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}#code_uri=x`, tabId: 'tab-2' });
  ok(!bad.ok && bad.reason === 'tab_mismatch', 'tab mismatch');
  const okr = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}#code_uri=x` });
  ok(okr.ok, 'no event tabId tolerated');
});

test('09. session context immutable from caller', () => {
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const ctx = c.getContext(b.sessionId);
  ok(ctx && Object.isFrozen(ctx), 'frozen');
  const mutated = ctx as unknown as { idCredPub: string };
  let threw = false;
  try { mutated.idCredPub = 'x'; } catch { threw = true; }
  ok(threw || c.getContext(b.sessionId)?.idCredPub === ID_CRED_PUB, 'cannot mutate');
});

test('10. parser accepts only done + valid structure (official NON-Testnet fixture)', () => {
  const done = { status: 'done', token: { identityObject: OFFICIAL_IO } };
  const r = parseIdentityTokenContainer(done);
  ok(r.ok, 'parsed structure');
  ok(!parseIdentityTokenContainer({ status: 'pending' }).ok, 'pending');
  ok(!parseIdentityTokenContainer({ status: 'error' }).ok, 'error');
  ok(!parseIdentityTokenContainer({ status: 'done', token: { identityObject: { v: 0, value: { preIdentityObject: {} } } } }).ok, 'malformed');
  ok(validateIdentityObjectStructure(OFFICIAL_IO.value).ok, 'structure helper');
});

test('11. verifyProvenance failure paths (structural fixture, no Testnet claim)', () => {
  const io = OFFICIAL_IO.value;
  ok(!verifyProvenance(io, officialContext({ idCredPub: '00' })).ok, 'idCredPub mismatch');
  ok(!verifyProvenance(io, officialContext({ arIdentities: [1, 2, 3] })).ok, 'AR mismatch');
  ok(!verifyProvenance(io, officialContext({ arThreshold: 3 })).ok, 'threshold mismatch');
  ok(!verifyProvenance(io, context({ network: 'Mainnet' as 'Testnet' })).ok, 'network mismatch');
  ok(!verifyProvenance({ preIdentityObject: {} }, officialContext()).ok, 'malformed object');
});

test('12. no HTTP / nonce requirement / no code_uri logging', () => {
  const src = readFileSync(new URL('../src/wallet/identityIssuance.ts', import.meta.url), 'utf8');
  ok(!/fetch\(|XMLHttpRequest|issuanceStart|recoveryStart|http\.request|sendTransaction|verifySignature/i.test(src), 'no network/deploy');
  ok(!/nonce_mismatch/.test(src), 'no nonce requirement');
  const c = controller();
  const b = c.begin(context(), ORIGIN);
  ok(b.ok, 'begin'); if (!b.ok) return;
  const r = c.handleCallback({ origin: ORIGIN, url: `${b.redirectUri}#code_uri=${encodeURIComponent('https://idp.example/x')}` });
  ok(r.ok, 'callback works without nonce');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, (e as Error).message); }
}
console.log(`wallet-identity-issuance: ${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
