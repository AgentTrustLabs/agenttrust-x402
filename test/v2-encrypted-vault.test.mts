/** Wallet Vault v2 encrypted storage tests (offline, synthetic seed only). */
import { readFileSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import { createV2Vault } from '../src/wallet/v2Vault.js';
import type { V2Storage, V2EncryptedRecord } from '../src/wallet/v2Storage.js';
import { createKeyVault } from '../src/wallet/keyVault.js';
import { ConcordiumHdWallet } from '@concordium/web-sdk';

const SEED = 'ab'.repeat(64);
const WALLET_ID = 'cd'.repeat(32);
const PASSWORD = 'correct-horse-battery-staple';
const WRONG = 'wrong-password-1234';
const pub = ConcordiumHdWallet.fromHex(SEED, 'Testnet').getAccountPublicKey(3, 0, 0).toString('hex');
const creds = [{ credIndex: 0, publicKeys: { 0: { schemeId: 'Ed25519' as const, verifyKey: pub } }, threshold: 1 }];

function memStorage(): V2Storage & { records: Map<string, V2EncryptedRecord> } {
  const records = new Map<string, V2EncryptedRecord>();
  return {
    records,
    async get(id) { return records.get(id) ?? null; },
    async put(r) { records.set(r.id, r); },
    async delete(id) { records.delete(id); },
    async list() { return Array.from(records.values()); },
  };
}

function v2(storage: V2Storage, autoLockMs = 60_000) {
  return createV2Vault({
    storage, crypto: globalThis.crypto, now: () => Date.now(),
    setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h), autoLockMs,
  });
}

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. create + unlock; ciphertext-only storage', async () => {
  const st = memStorage(); const v = v2(st);
  const c = await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  ok(c.ok, 'create');
  const r = await st.get(WALLET_ID);
  ok(r, 'record');
  const json = JSON.stringify(r);
  notOk(json.includes(SEED), 'no seed plaintext');
  notOk(json.includes(PASSWORD), 'no password');
  notOk(json.includes(pub), 'no verify key plaintext?'); // public key is public; this check only ensures not in ciphertext string
  eq(r.network, 'testnet', 'network');
  eq(r.kdf.iterations, 600000, 'iterations');
  const u = await v.unlock(PASSWORD, WALLET_ID);
  ok(u.ok, 'unlock');
  if (u.ok) eq(u.view.credentials[0].publicKey, pub, 'derived public key');
});

test('02. wrong password rejected', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  const r = await v.unlock(WRONG, WALLET_ID);
  eq(r.ok, false, 'rejected');
  eq(r.reason, 'decrypt_failed', 'reason');
});

test('03. ciphertext tampering rejected', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  const rec = st.records.get(WALLET_ID)!;
  st.records.set(WALLET_ID, { ...rec, ciphertext: rec.ciphertext.slice(0, -2) + '00' });
  const r = await v.unlock(PASSWORD, WALLET_ID);
  eq(r.ok, false, 'tamper rejected');
});

test('04. network / walletId / AAD mismatch rejected', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  const rec = st.records.get(WALLET_ID)!;
  st.records.set(WALLET_ID, { ...rec, network: 'mainnet' as never });
  eq((await v.unlock(PASSWORD, WALLET_ID)).ok, false, 'network mismatch');
  st.records.set(WALLET_ID, rec);
  st.records.set(WALLET_ID, { ...rec, publicMetadata: { ...rec.publicMetadata, walletId: 'e'.repeat(64) } });
  eq((await v.unlock(PASSWORD, WALLET_ID)).ok, false, 'walletId mismatch');
  st.records.set(WALLET_ID, rec);
  st.records.set(WALLET_ID, { ...rec, id: 'e'.repeat(64) });
  eq((await v.unlock(PASSWORD, 'e'.repeat(64))).ok, false, 'AAD mismatch');
});

test('05. restart requires unlock again', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  await v.unlock(PASSWORD, WALLET_ID);
  const restarted = v2(st);
  eq(restarted.status().state, 'locked', 'restart locked');
  ok((await restarted.unlock(PASSWORD, WALLET_ID)).ok, 'unlock after restart');
});

test('06. lock cancels signer; old signer unusable', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  await v.unlock(PASSWORD, WALLET_ID);
  const old = v.getSigner(0);
  ok(old, 'signer before lock');
  v.lock();
  eq(v.status().state, 'locked', 'locked');
  eq(v.getSigner(0), null, 'no new signer');
  let threw = false;
  try { await old!.sign(new Uint8Array(32)); } catch { threw = true; }
  ok(threw, 'old signer rejected after lock');
});

test('07. auto-lock cancels signer', async () => {
  const st = memStorage(); const v = v2(st, 10);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  await v.unlock(PASSWORD, WALLET_ID);
  const old = v.getSigner(0);
  await new Promise(r => setTimeout(r, 25));
  eq(v.status().state, 'locked', 'auto-locked');
  let threw = false;
  try { await old!.sign(new Uint8Array(32)); } catch { threw = true; }
  ok(threw, 'old signer rejected after auto-lock');
});

test('08. password change; old password invalid', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  const newPass = 'new-password-12345';
  ok((await v.changePassword(WALLET_ID, PASSWORD, newPass)).ok, 'change ok');
  eq((await v.unlock(PASSWORD, WALLET_ID)).ok, false, 'old password rejected');
  ok((await v.unlock(newPass, WALLET_ID)).ok, 'new password works');
});

test('09. delete needs explicit confirmation; v1 untouched', async () => {
  const st = memStorage(); const v = v2(st);
  await v.createWallet({ password: PASSWORD, walletId: WALLET_ID, seedHex: SEED, idpIndex: 3, identityIndex: 0, credentials: creds });
  const v1Records = new Map();
  const v1Storage = {
    async get(id: string) { return v1Records.get(id) ?? null; },
    async put(r: any) { v1Records.set(r.id, r); },
    async delete(id: string) { v1Records.delete(id); },
  };
  const v1 = createKeyVault({ storage: v1Storage as never, crypto: globalThis.crypto, now: () => Date.now(), setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h), keyFixture: { privateKeyHex: 'ef'.repeat(32), publicKeyHex: pub } });
  await v1.createWallet(PASSWORD, 'aa'.repeat(32));
  eq((await v.deleteWallet(WALLET_ID, 'no')).ok, false, 'confirmation required');
  ok((await v.deleteWallet(WALLET_ID, 'DELETE')).ok, 'delete ok');
  eq(await st.get(WALLET_ID), null, 'v2 record removed');
  ok(await v1Storage.get('aa'.repeat(32)), 'v1 record intact');
});

test('11. pending parent requests are rejected after cancel/lock', async () => {
  const { createWalletParentClient } = await import('../src/wallet/parentClient.js');
  const client = createWalletParentClient({
    walletOrigin: 'http://127.0.0.1:4591', parentOrigin: 'http://127.0.0.1:4590', timeoutMs: 1000,
    transport: {
      postMessage: () => {}, addEventListener: () => {}, randomNonce: () => '0'.repeat(64), randomId: () => '1'.repeat(32), now: () => 1,
      setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h),
    },
  });
  const p = client.handshake().catch(e => e.message);
  client.cancelAll();
  eq(await p, 'cancelled', 'pending rejected');
  eq(client.pendingCount, 0, 'pending cleared');
});

test('10. no network/storage of secrets in v2 modules', () => {
  for (const f of ['../src/wallet/v2Vault.ts', '../src/wallet/v2Storage.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const needle of ['fetch(', 'grpc', 'sendTransaction', 'localStorage', 'sessionStorage']) {
      notOk(src.includes(needle), 'no ' + needle + ' in ' + f);
    }
  }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nv2-encrypted-vault: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
