/**
 * Local encrypted key vault security tests (offline, test-only fixtures).
 * No real wallet/account, no network, no signing/broadcast, no secret leakage.
 */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import { createKeyVault, type EncryptedKeyRecord, type KeyVaultStorage } from '../src/wallet/keyVault.js';
import { createWalletShell } from '../src/wallet/shell.js';
import { createWalletParentClient } from '../src/wallet/parentClient.js';
import { WALLET_PARENT_ORIGIN, WALLET_CONTEXT_ORIGIN } from '../src/wallet/protocol.js';

const PARENT = WALLET_PARENT_ORIGIN;
const WALLET = WALLET_CONTEXT_ORIGIN;
const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'wrong-password-1234';

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyHex: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
  };
}
const FIXTURE = fixture();

function memoryStorage(): KeyVaultStorage & { records: Map<string, EncryptedKeyRecord> } {
  const records = new Map<string, EncryptedKeyRecord>();
  return {
    records,
    async get(id) { return records.get(id) ?? null; },
    async put(record) { records.set(record.id, record); },
    async delete(id) { records.delete(id); },
  };
}

function vaultFor(storage: KeyVaultStorage, autoLockMs = 60_000, withFixture = true) {
  return createKeyVault({
    storage,
    crypto: globalThis.crypto,
    now: () => Date.now(),
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h),
    autoLockMs,
    ...(withFixture ? { keyFixture: FIXTURE } : {}),
  });
}

const WALLET_ID = 'a'.repeat(64);
const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. create stores ciphertext only; no plaintext key in storage', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  const created = await vault.createWallet(PASSWORD, WALLET_ID);
  ok(created.ok, 'create ok');
  const record = await storage.get(WALLET_ID);
  ok(record, 'record stored');
  const json = JSON.stringify(record);
  notOk(json.includes(FIXTURE.privateKeyHex), 'no private key plaintext');
  notOk(json.includes(PASSWORD), 'no password in storage');
  eq(record.network, 'testnet', 'testnet only');
  eq(record.kdf.iterations, 600000, 'kdf iterations');
  ok(record.ciphertext.length > 0 && record.iv.length === 24 && record.salt.length === 32, 'ciphertext/iv/salt shape');
});

test('02. correct password unlocks; wrong password fails closed', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  await vault.createWallet(PASSWORD, WALLET_ID);
  const bad = await vault.unlock(WRONG_PASSWORD, WALLET_ID);
  eq(bad.ok, false, 'wrong password rejected');
  eq(bad.reason, 'decrypt_failed', 'fail closed reason');
  eq(vault.status().state, 'locked', 'still locked');
  const good = await vault.unlock(PASSWORD, WALLET_ID);
  ok(good.ok, 'correct password unlocks');
  eq(vault.status().state, 'unlocked', 'unlocked');
  ok(vault.getSigner(), 'signer available internally');
});

test('03. modified ciphertext fails decrypt', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  await vault.createWallet(PASSWORD, WALLET_ID);
  const record = storage.records.get(WALLET_ID);
  const tampered = { ...record, ciphertext: record.ciphertext.slice(0, -2) + (record.ciphertext.slice(-2) === '00' ? 'ff' : '00') };
  storage.records.set(WALLET_ID, tampered);
  const r = await vault.unlock(PASSWORD, WALLET_ID);
  eq(r.ok, false, 'tampered ciphertext rejected');
  eq(r.reason, 'decrypt_failed', 'fail closed');
  eq(vault.status().state, 'locked', 'locked after failure');
});

test('04. lock clears active signer; restart requires unlock', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  await vault.createWallet(PASSWORD, WALLET_ID);
  await vault.unlock(PASSWORD, WALLET_ID);
  await vault.lock();
  eq(vault.status().state, 'locked', 'locked');
  eq(vault.getSigner(), null, 'signer cleared');
  const restarted = vaultFor(storage);
  eq(restarted.status().state, 'locked', 'restart locked');
  eq(restarted.getSigner(), null, 'no signer after restart');
  const r = await restarted.unlock(PASSWORD, WALLET_ID);
  ok(r.ok, 'unlock after restart');
});

test('05. auto-lock after inactivity', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage, 10);
  await vault.createWallet(PASSWORD, WALLET_ID);
  await vault.unlock(PASSWORD, WALLET_ID);
  eq(vault.status().state, 'unlocked', 'unlocked before timeout');
  await new Promise(r => setTimeout(r, 25));
  eq(vault.status().state, 'locked', 'auto-locked');
  eq(vault.getSigner(), null, 'signer cleared by auto-lock');
});

test('06. delete removes wallet', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  await vault.createWallet(PASSWORD, WALLET_ID);
  const d = await vault.deleteWallet(WALLET_ID);
  ok(d.ok, 'delete ok');
  eq(await storage.get(WALLET_ID), null, 'record gone');
  eq(vault.status().state, 'locked', 'locked');
});

test('07. parent protocol never carries secrets; shell reflects vault', async () => {
  const storage = memoryStorage();
  const vault = vaultFor(storage);
  await vault.createWallet(PASSWORD, WALLET_ID);
  const seen = [];
  const handlers = [];
  const parentHandlers = [];
  let seq = 0;
  const next = (len) => String(seq++).padStart(len, '0');
  createWalletShell({
    allowedParentOrigins: [PARENT],
    vault: { lock: () => void vault.lock(), status: () => vault.status() },
    transport: {
      postMessage: (m) => { seen.push(m); parentHandlers.forEach(h => h({ origin: WALLET, data: m })); },
      addEventListener: (_t, h) => handlers.push(h),
      randomNonce: () => next(64),
      randomId: () => next(32),
      now: () => 1,
    },
  });
  const client = createWalletParentClient({
    walletOrigin: WALLET, parentOrigin: PARENT, timeoutMs: 30,
    transport: {
      postMessage: (m) => handlers[0]({ origin: PARENT, data: m }),
      addEventListener: (_t, h) => parentHandlers.push(h),
      randomNonce: () => next(64),
      randomId: () => next(32),
      now: () => 1,
      setTimeout: (h, ms) => setTimeout(h, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
  });
  const hello = await client.handshake();
  ok(hello.ok, 'hello ok');
  await vault.unlock(PASSWORD, WALLET_ID);
  const status = await client.getStatus();
  eq(status.result?.state, 'unlocked', 'parent sees unlocked state');
  const lock = await client.lock();
  ok(lock.ok, 'parent lock ok');
  eq(vault.status().state, 'locked', 'vault locked via parent lock');
  const json = JSON.stringify(seen);
  for (const needle of [FIXTURE.privateKeyHex, PASSWORD, 'privateKey', 'seed', 'kek', 'signer']) {
    notOk(json.includes(needle), 'no ' + needle + ' in parent messages');
  }
});

test('08. no network/broadcast in vault modules', () => {
  for (const file of ['../src/wallet/keyVault.ts', '../src/wallet/indexedDbKeyVaultStorage.ts', '../src/wallet/wallet-context-entry.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const needle of ['fetch(', 'grpc', 'sendTransaction', 'XMLHttpRequest', 'WebSocket']) {
      notOk(src.includes(needle), 'no ' + needle + ' in ' + file);
    }
  }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nwallet-key-vault: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
