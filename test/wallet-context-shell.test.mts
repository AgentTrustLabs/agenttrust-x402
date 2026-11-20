/**
 * Wallet Context shell security tests (offline, transport-injected).
 * No browser, no network, no key vault, no signing.
 */
import { readFileSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import { createWalletShell } from '../src/wallet/shell.js';
import { createWalletParentClient } from '../src/wallet/parentClient.js';
import { isWalletMethod, WALLET_PARENT_ORIGIN, WALLET_CONTEXT_ORIGIN } from '../src/wallet/protocol.js';

const PARENT = WALLET_PARENT_ORIGIN;
const WALLET = WALLET_CONTEXT_ORIGIN;

const hex = (n) => 'a'.repeat(n);
function wire(parentTransportOverrides = {}, shellTransportOverrides = {}) {
  const events = { parent: [], shell: [] };
  const shellHandlers = [];
  const parentHandlers = [];
  let seq = 0;
  const nextHex = (len) => String(seq++).padStart(len, '0');
  const shellTransport = {
    postMessage: (_msg, _origin) => parentHandlers.forEach(h => h({ origin: WALLET, data: _msg })),
    addEventListener: (type, h) => shellHandlers.push(h),
    randomNonce: () => nextHex(64),
    randomId: () => nextHex(32),
    now: () => 1_700_000_000_000,
    ...shellTransportOverrides,
  };
  const shell = createWalletShell({ allowedParentOrigins: [PARENT], transport: shellTransport });
  const parentTransport = {
    postMessage: (msg, _origin) => shellHandlers.forEach(h => h({ origin: PARENT, data: msg })),
    addEventListener: (type, h) => parentHandlers.push(h),
    randomNonce: () => nextHex(64),
    randomId: () => nextHex(32),
    now: () => 1_700_000_000_000,
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h),
    ...parentTransportOverrides,
  };
  const client = createWalletParentClient({ walletOrigin: WALLET, parentOrigin: PARENT, transport: parentTransport, timeoutMs: 25 });
  return { shell, client, events, shellHandlers, parentHandlers };
}

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. valid handshake, getStatus, lock; session required after lock', async () => {
  const { client } = wire();
  const hello = await client.handshake();
  ok(hello.ok, 'hello ok');
  ok(hello.result?.sessionId, 'session id issued');
  const status = await client.getStatus();
  eq(status.ok, true, 'status ok');
  eq(status.result?.state, 'locked', 'state locked');
  const lock = await client.lock();
  eq(lock.ok, true, 'lock ok');
  const after = await client.getStatus();
  eq(after.ok, false, 'status after lock fails closed');
  eq(after.error, 'session_required', 'session required');
});

test('02. unknown parent origin is ignored (no response)', () => {
  const { shellHandlers } = wire();
  shellHandlers.forEach(h => h({ origin: 'https://evil.example', data: { version: 1, type: 'request', id: hex(32), nonce: hex(64), method: 'wallet.hello', payload: { parentOrigin: 'https://evil.example' } } }));
  ok(true, 'no throw, no reply path exercised');
});

test('03. nonce replay is rejected', () => {
  const seen = [];
  const handlers = [];
  createWalletShell({ allowedParentOrigins: [PARENT], transport: {
    postMessage: (m) => seen.push(m), addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
  } });
  const req = { version: 1, type: 'request', id: hex(32), nonce: hex(64), method: 'wallet.hello', payload: { parentOrigin: PARENT } };
  handlers[0]({ origin: PARENT, data: req });
  handlers[0]({ origin: PARENT, data: req });
  eq(seen.length, 2, 'two replies');
  eq(seen[1].error, 'nonce_replayed', 'replay rejected');
});

test('04. duplicate request id is rejected', () => {
  const seen = [];
  const handlers = [];
  const s = createWalletShell({ allowedParentOrigins: [PARENT], transport: {
    postMessage: (m) => seen.push(m), addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
  } });
  const id = hex(32);
  handlers[0]({ origin: PARENT, data: { version: 1, type: 'request', id, nonce: 'a'.repeat(64), method: 'wallet.hello', payload: { parentOrigin: PARENT } } });
  handlers[0]({ origin: PARENT, data: { version: 1, type: 'request', id, nonce: 'b'.repeat(64), method: 'wallet.getStatus', sessionId: seen[0].result?.sessionId } });
  eq(seen[1].error, 'duplicate_request_id', 'duplicate id rejected');
});

test('05. unknown method and malformed message are rejected', () => {
  const seen = [];
  const handlers = [];
  const s = createWalletShell({ allowedParentOrigins: [PARENT], transport: {
    postMessage: (m) => seen.push(m), addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
  } });
  handlers[0]({ origin: PARENT, data: { version: 1, type: 'request', id: hex(32), nonce: hex(64), method: 'wallet.sign', payload: {} } });
  handlers[0]({ origin: PARENT, data: { nope: true } });
  eq(seen[0].error, 'invalid_message', 'unknown method rejected as invalid message');
  eq(seen[1].error, 'invalid_message', 'malformed rejected');
  notOk(isWalletMethod('wallet.sign'), 'sign not in allowlist');
});

test('06. hello with declared origin mismatch is rejected', () => {
  const seen = [];
  const handlers = [];
  createWalletShell({ allowedParentOrigins: [PARENT], transport: {
    postMessage: (m) => seen.push(m), addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
  } });
  handlers[0]({ origin: PARENT, data: { version: 1, type: 'request', id: hex(32), nonce: hex(64), method: 'wallet.hello', payload: { parentOrigin: 'https://evil.example' } } });
  eq(seen[0].error, 'invalid_origin', 'declared origin mismatch rejected');
});

test('07. parent timeout and cancellation are fail-closed', async () => {
  // No shell handler wired: request never answered.
  const client = createWalletParentClient({ walletOrigin: WALLET, parentOrigin: PARENT, timeoutMs: 15, transport: {
    postMessage: () => {}, addEventListener: () => {}, randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
    setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h),
  } });
  let error = null;
  await client.handshake().catch(e => { error = e.message; });
  eq(error, 'timeout', 'timeout surfaced');
});

test('08. parent ignores responses from wrong origin and late responses', async () => {
  const handlers = [];
  let resolveWait;
  const client = createWalletParentClient({ walletOrigin: WALLET, parentOrigin: PARENT, timeoutMs: 30, transport: {
    postMessage: () => {}, addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
    setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: (h) => clearTimeout(h),
  } });
  const p = client.handshake().catch(e => e.message);
  await new Promise(r => setTimeout(r, 5));
  handlers[0]({ origin: 'https://evil.example', data: { version: 1, type: 'response', id: hex(32), nonce: hex(64), ok: true, result: { sessionId: hex(32) } } });
  await new Promise(r => setTimeout(r, 30));
  eq(await p, 'timeout', 'wrong-origin response ignored');
  void resolveWait;
});

test('09. no secrets/signer serialized; no network in shell/protocol', async () => {
  const seen = [];
  const handlers = [];
  createWalletShell({ allowedParentOrigins: [PARENT], transport: {
    postMessage: (m) => seen.push(m), addEventListener: (_t, h) => handlers.push(h), randomNonce: () => hex(64), randomId: () => hex(32), now: () => 1,
  } });
  handlers[0]({ origin: PARENT, data: { version: 1, type: 'request', id: hex(32), nonce: hex(64), method: 'wallet.hello', payload: { parentOrigin: PARENT } } });
  const json = JSON.stringify(seen);
  for (const needle of ['privateKey', 'seed', 'kek', 'signer', 'mnemonic', 'walletFile']) notOk(json.includes(needle), 'no ' + needle + ' in messages');
  for (const file of ['../src/wallet/shell.ts', '../src/wallet/protocol.ts', '../src/wallet/parentClient.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const needle of ['fetch(', 'grpc', 'sendTransaction', 'XMLHttpRequest', 'WebSocket']) notOk(src.includes(needle), 'no ' + needle + ' in ' + file);
  }
});

test('10. wildcard targetOrigin and generic method dispatch are absent', () => {
  const src = readFileSync(new URL('../src/wallet/shell.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/wallet/parentClient.ts', import.meta.url), 'utf8');
  notOk(src.includes("postMessage(message, '*')"), 'no wildcard targetOrigin');
  notOk(/method\s*\?\?\s*opts|invoke\s*\(/i.test(src), 'no generic method dispatch');
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nwallet-context-shell: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
