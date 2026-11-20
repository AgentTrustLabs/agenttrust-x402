/** Issuance bridge security tests (offline, synthetic vault seed only). */
import { readFileSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import { createV2Vault } from '../src/wallet/v2Vault.js';
import { createIssuanceBridge } from '../src/wallet/issuanceBridge.js';
import { readCallback, prepareCallbackMessage } from '../src/wallet/identityCallback.js';
import { ConcordiumHdWallet } from '@concordium/web-sdk';

const SEED = 'ab'.repeat(64);
const WALLET_ID = 'cd'.repeat(32);
const PW = 'bridge-test-password';
const ORIGIN = 'https://wallet.example';
const PARAMS = JSON.parse(readFileSync(new URL('./fixtures/testnet-public-params.json', import.meta.url), 'utf8'));

function memoryStorage() {
  const map = new Map();
  return {
    get: async (id) => map.get(id) ?? null,
    put: async (r) => { map.set(r.id, r); },
    delete: async (id) => { map.delete(id); },
    list: async () => [...map.values()],
  };
}
function vault(over = {}) {
  return createV2Vault({
    storage: memoryStorage(), crypto: globalThis.crypto,
    now: () => Date.now(), setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h),
    autoLockMs: 5000, ...over,
  });
}
async function unlockedVault(autoLockMs = 5000) {
  const v = vault({ autoLockMs });
  const pub = ConcordiumHdWallet.fromHex(SEED, 'Testnet').getAccountPublicKey(PARAMS.ipIdentity, PARAMS.identityIndex, 0).toString('hex');
  const created = await v.createWallet({ password: PW, walletId: WALLET_ID, seedHex: SEED, idpIndex: PARAMS.ipIdentity, identityIndex: PARAMS.identityIndex, credentials: [{ credIndex: 0, publicKeys: { 0: { schemeId: 'Ed25519', verifyKey: pub } }, threshold: 1 }] });
  ok(created.ok, 'create');
  const u = await v.unlock(PW, WALLET_ID);
  ok(u.ok, 'unlock');
  return v;
}
const issuanceParams = () => ({ ipInfo: PARAMS.ipInfo, globalContext: PARAMS.cryptographicParameters, arsInfos: PARAMS.arsInfos, arThreshold: 2, identityIndex: PARAMS.identityIndex });

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. withSeed is operation-scoped and never returns seed', async () => {
  const v = await unlockedVault();
  let seen = false;
  const result = await v.withSeed((seed) => { seen = seed === SEED; return 'marker'; });
  eq(result, 'marker', 'result not seed');
  ok(seen, 'operation used seed internally');
  ok(!JSON.stringify(v.status()).includes(SEED), 'status no seed');
});

test('02. withSeed fails when locked/deleted', async () => {
  const v = await unlockedVault();
  v.lock();
  let threw = false;
  try { await v.withSeed(() => 'x'); } catch (e) { threw = (e as Error).message === 'wallet_locked'; }
  ok(threw, 'locked rejected');
  const v2 = await unlockedVault();
  await v2.deleteWallet(WALLET_ID, 'DELETE');
  let threw2 = false;
  try { await v2.withSeed(() => 'x'); } catch (e) { threw2 = (e as Error).message === 'wallet_locked'; }
  ok(threw2, 'deleted rejected');
});

test('03. lock during in-flight withSeed invalidates operation', async () => {
  const v = await unlockedVault();
  let release;
  const gate = new Promise((res) => { release = res; });
  const op = v.withSeed(async () => { await gate; return 'done'; });
  v.lock();
  release();
  let threw = false;
  try { await op; } catch (e) { threw = (e as Error).message === 'wallet_locked'; }
  ok(threw, 'in-flight invalidated');
});

test('04. bridge prepares issuance session from unlocked vault (synthetic)', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance('tab-1');
  ok(r.ok, 'begin'); if (!r.ok) return;
  ok(r.redirectUri.startsWith(`${ORIGIN}/identity/callback/`), 'redirect URI');
  eq(bridge.controller.sessionCount, 1, 'one session');
});

test('05. bridge lock invalidates active issuance sessions', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  bridge.lock();
  eq(bridge.controller.sessionCount, 0, 'sessions cleared');
});

test('06. callback message validates origin and controller session', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance('tab-1');
  ok(r.ok, 'begin'); if (!r.ok) return;
  const badOrigin = bridge.handleCallbackMessage({ origin: 'https://evil.test', data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` } });
  ok(!badOrigin.ok && badOrigin.reason === 'callback_origin_not_allowed', 'origin');
  const badMsg = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'x' } });
  ok(!badMsg.ok, 'malformed message');
  const srcWindow = {};
  bridge.attachCallbackWindow(r.sessionId, srcWindow);
  const good = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=${encodeURIComponent('https://idp.example/x')}` }, source: srcWindow });
  ok(good.ok && good.sessionId === r.sessionId, 'accepted');
  const replay = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` }, source: srcWindow });
  ok(!replay.ok && replay.reason === 'callback_replayed', 'replay');
});

test('06b. callback source binding required and mismatch rejected', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  const unbound = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` }, source: {} });
  ok(!unbound.ok && unbound.reason === 'source_not_bound', 'unbound rejected');
  const expected = {};
  bridge.attachCallbackWindow(r.sessionId, expected);
  const bad = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` }, source: {} });
  ok(!bad.ok && bad.reason === 'source_mismatch', 'source mismatch');
  const good = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` }, source: expected });
  ok(good.ok, 'matching source accepted');
});

test('07. handleResult accepts only done + structural provenance label', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  const pending = bridge.handleResult({ status: 'pending' }, r.sessionId);
  ok(!pending.ok && pending.reason === 'issuance_pending', 'pending');
  const err = bridge.handleResult({ status: 'error' }, r.sessionId);
  ok(!err.ok, 'error');
  // No genuine Testnet IdentityObject fixture exists; success path cannot be claimed.
});

test('08. callback page helper requires HTTPS + exact origin', () => {
  const loc = { protocol: 'https:', origin: ORIGIN, pathname: '/identity/callback/tok', hash: '#code_uri=x' };
  const good = readCallback(loc, ORIGIN);
  ok(good.ok, 'https ok');
  ok(!readCallback({ ...loc, protocol: 'http:' }, ORIGIN).ok, 'http rejected');
  ok(!readCallback(loc, 'https://other.test').ok, 'origin rejected');
  const msg = prepareCallbackMessage(loc, ORIGIN);
  ok(msg.ok && msg.targetOrigin === ORIGIN, 'exact targetOrigin');
  if (msg.ok) ok(msg.message.url.includes('#code_uri='), 'fragment for controller only');
});

test('09. auto-lock invalidates operation-scoped seed access', async () => {
  const v = vault({ autoLockMs: 50 });
  const pub = ConcordiumHdWallet.fromHex(SEED, 'Testnet').getAccountPublicKey(PARAMS.ipIdentity, PARAMS.identityIndex, 0).toString('hex');
  await v.createWallet({ password: PW, walletId: WALLET_ID, seedHex: SEED, idpIndex: PARAMS.ipIdentity, identityIndex: PARAMS.identityIndex, credentials: [{ credIndex: 0, publicKeys: { 0: { schemeId: 'Ed25519', verifyKey: pub } }, threshold: 1 }] });
  await v.unlock(PW, WALLET_ID);
  await new Promise((r) => setTimeout(r, 120));
  let threw = false;
  try { await v.withSeed(() => 'x'); } catch (e) { threw = (e as Error).message === 'wallet_locked'; }
  ok(threw, 'auto-lock rejected');
});

test('10. callback page clears fragment and never targets parent', () => {
  const src = readFileSync(new URL('../web/wallet-context/callback.js', import.meta.url), 'utf8');
  ok(src.includes('history.replaceState'), 'fragment cleared');
  ok(!/window\.parent|parent\.postMessage|console\.log|analytics|telemetry/i.test(src), 'no parent/log/telemetry');
  ok(src.includes('window.opener.postMessage'), 'internal opener only');
});

test('11. no seed in bridge output or source logs', async () => {
  const v = await unlockedVault();
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  ok(!JSON.stringify(r).includes(SEED), 'no seed in output');
  const source = readFileSync(new URL('../src/wallet/issuanceBridge.ts', import.meta.url), 'utf8');
  ok(!/console\.log|fetch\(|XMLHttpRequest/i.test(source), 'no logs or network');
});

test('12. popup close and lock fail-closed', async () => {
  const v = await unlockedVault(60000);
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  const src = {};
  bridge.attachCallbackWindow(r.sessionId, src);
  bridge.markPopupClosed(r.sessionId);
  const late = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r.redirectUri}#code_uri=x` }, source: src });
  ok(!late.ok, 'late callback rejected');
  const r2 = await bridge.prepareIssuance();
  ok(r2.ok, 'second begin'); if (!r2.ok) return;
  bridge.attachCallbackWindow(r2.sessionId, src);
  bridge.lock();
  const afterLock = bridge.handleCallbackMessage({ origin: ORIGIN, data: { type: 'wallet.identity.callback', url: `${r2.redirectUri}#code_uri=x` }, source: src });
  ok(!afterLock.ok, 'after lock rejected');
});

test('13. popup opener binding and close on lock', async () => {
  const v = await unlockedVault();
  let closed = 0;
  const fakePopup = { close: () => { closed++; } };
  const bridge = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams(), openPopup: () => fakePopup });
  const noPopup = createIssuanceBridge({ vault: v, callbackOrigin: ORIGIN, params: issuanceParams() });
  const r = await bridge.prepareIssuance();
  ok(r.ok, 'begin'); if (!r.ok) return;
  const blocked = noPopup.openCallbackPopup(r.sessionId, r.redirectUri);
  ok(!blocked.ok && blocked.reason === 'popup_unavailable', 'no opener fn');
  const opened = bridge.openCallbackPopup(r.sessionId, r.redirectUri);
  ok(opened.ok, 'popup opened');
  bridge.lock();
  eq(closed, 1, 'popup closed on lock');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`); pass++; }
  catch (e) { console.error(`FAIL ${name}`, e instanceof Error ? e.message : String(e)); }
}
console.log(`wallet-issuance-bridge: ${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
