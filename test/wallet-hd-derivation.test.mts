/** HD derivation session tests inside Wallet Context logic (offline, synthetic). */
import { readFileSync } from 'node:fs';
import { ConcordiumHdWallet } from '@concordium/web-sdk';
import { eq, ok, notOk } from './helpers.mjs';
import { createHdDerivationSession } from '../src/wallet/hdDerivation.js';
import { createWalletShell } from '../src/wallet/shell.js';
import { createWalletParentClient } from '../src/wallet/parentClient.js';
import { WALLET_PARENT_ORIGIN, WALLET_CONTEXT_ORIGIN } from '../src/wallet/protocol.js';

const SEED = 'ab'.repeat(64);
const WALLET_ID = 'cd'.repeat(32);
const PARENT = WALLET_PARENT_ORIGIN;
const WALLET = WALLET_CONTEXT_ORIGIN;
const expectedPub = (credIdx = 0) => ConcordiumHdWallet.fromHex(SEED, 'Testnet').getAccountPublicKey(3, 0, credIdx).toString('hex');

function session(autoLockMs = 60_000) {
  return createHdDerivationSession({
    crypto: globalThis.crypto,
    now: () => Date.now(),
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h),
    autoLockMs,
  });
}
const initInput = (credIdx = 0) => ({
  seedHex: SEED, walletId: WALLET_ID, idpIndex: 3, identityIndex: 0,
  credentials: [{ credIndex: credIdx, publicKeys: { 0: { schemeId: 'Ed25519' as const, verifyKey: expectedPub(credIdx) } }, threshold: 1 }],
});

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. HD initialize derives signer matching public key', async () => {
  const s = session();
  const r = await s.initialize(initInput(0));
  ok(r.ok, 'initialize ok');
  if (!r.ok) return;
  eq(r.credentials[0].publicKey, expectedPub(0), 'derived public key');
  eq(r.credentials[0].signerMatchesDerivedPublicKey, true, 'signer matches');
  ok(s.getSigner(0), 'signer available internally');
});

test('02. deterministic for same seed/index; different credential differs', async () => {
  const a = session(); const b = session();
  const r1 = await a.initialize(initInput(0));
  const r2 = await b.initialize(initInput(0));
  ok(r1.ok && r2.ok, 'both ok');
  if (!r1.ok || !r2.ok) return;
  eq(r1.credentials[0].publicKey, r2.credentials[0].publicKey, 'deterministic');
  const c = session();
  const r3 = await c.initialize(initInput(1));
  ok(r3.ok, 'cred 1 ok');
  if (r3.ok) notOk(r1.credentials[0].publicKey === r3.credentials[0].publicKey, 'different credential key');
});

test('03. invalid seed / descriptor fails closed without retaining material', async () => {
  const s = session();
  const bad = await s.initialize({ ...initInput(0), seedHex: 'ab'.repeat(32) });
  eq(bad.ok, false, 'short seed rejected');
  if (!bad.ok) ok(bad.reason.startsWith('descriptor_invalid'), 'validator reason');
  eq(s.status().state, 'locked', 'locked after failure');
  eq(s.getSigner(0), null, 'no signer');
  const badHex = await s.initialize({ ...initInput(0), seedHex: 'g'.repeat(128) });
  eq(badHex.ok, false, 'non-hex rejected');
});

test('04. derivation failure / unsupported threshold fail closed', async () => {
  const s = session();
  const input = initInput(0);
  input.credentials[0].threshold = 2;
  const r = await s.initialize(input);
  eq(r.ok, false, 'threshold unsupported');
  eq(s.status().state, 'locked', 'locked');
});

test('05. lock clears derived material and signer', async () => {
  const s = session();
  await s.initialize(initInput(0));
  s.lock();
  eq(s.status().state, 'locked', 'locked');
  eq(s.getSigner(0), null, 'signer cleared');
});

test('06. auto-lock clears derived material', async () => {
  const s = session(10);
  await s.initialize(initInput(0));
  eq(s.status().state, 'unlocked', 'unlocked');
  await new Promise(r => setTimeout(r, 25));
  eq(s.status().state, 'locked', 'auto-locked');
  eq(s.getSigner(0), null, 'signer cleared');
});

test('07. parent getStatus/lock exposes no seed/private key/signer', async () => {
  const s = session();
  const seen = []; const handlers = []; const parentHandlers = [];
  let seq = 0; const next = (len) => String(seq++).padStart(len, '0');
  createWalletShell({
    allowedParentOrigins: [PARENT],
    vault: { lock: () => s.lock(), status: () => ({ state: s.status().state, publicKey: null }) },
    transport: {
      postMessage: (m) => { seen.push(m); parentHandlers.forEach(h => h({ origin: WALLET, data: m })); },
      addEventListener: (_t, h) => handlers.push(h),
      randomNonce: () => next(64), randomId: () => next(32), now: () => 1,
    },
  });
  const client = createWalletParentClient({
    walletOrigin: WALLET, parentOrigin: PARENT, timeoutMs: 30,
    transport: {
      postMessage: (m) => handlers[0]({ origin: PARENT, data: m }),
      addEventListener: (_t, h) => parentHandlers.push(h),
      randomNonce: () => next(64), randomId: () => next(32), now: () => 1,
      setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h),
    },
  });
  const hello = await client.handshake();
  ok(hello.ok, 'hello ok');
  await s.initialize(initInput(0));
  const status = await client.getStatus();
  eq(status.ok, true, 'status ok');
  const lock = await client.lock();
  ok(lock.ok, 'lock ok');
  eq(s.status().state, 'locked', 'session cleared via parent lock');
  const json = JSON.stringify(seen);
  for (const needle of [SEED, 'privateKey', 'signer', 'seedHex']) notOk(json.includes(needle), 'no ' + needle);
});

test('08. module has no network/storage calls', () => {
  const src = readFileSync(new URL('../src/wallet/hdDerivation.ts', import.meta.url), 'utf8');
  for (const needle of ['fetch(', 'grpc', 'sendTransaction', 'indexedDB', 'localStorage']) {
    notOk(src.includes(needle), 'no ' + needle);
  }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nwallet-hd-derivation: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
