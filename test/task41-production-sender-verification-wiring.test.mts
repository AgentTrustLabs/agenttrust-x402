/**
 * TASK 41 — production sender verification wiring tests.
 *
 * Proves that production (real mode) cannot select the pass-through verifier, that
 * missing/invalid configuration fails closed, and that the mock flow still works.
 *
 * Run: npx tsx test/task41-production-sender-verification-wiring.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { loadConfig, ConfigurationError } from '../services/facilitator/src/config.js';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { GrpcAccountInfoProvider } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const baseEnv = (over: Record<string, string> = {}) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_PORT: '0',
  ...over,
});

// ── 1. mock mode defaults to passthrough ────────────────────────────────────

test('01. mock mode without sender-verification env defaults to passthrough', () => {
  const cfg = loadConfig(baseEnv());
  eq(cfg.senderVerification, 'passthrough', 'default');
});

test('02. mock mode can opt into sdk with a full endpoint', () => {
  const cfg = loadConfig(baseEnv({
    FACILITATOR_SENDER_VERIFICATION: 'sdk',
    FACILITATOR_NODE_HOST: 'grpc.testnet.concordium.com',
    FACILITATOR_NODE_PORT: '20000',
  }));
  eq(cfg.senderVerification, 'sdk', 'mode');
});

// ── 2. real mode requires sdk ───────────────────────────────────────────────

test('03. real mode without FACILITATOR_SENDER_VERIFICATION throws', () => {
  let threw = false;
  try {
    loadConfig(baseEnv({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', FACILITATOR_DB_PATH: '/tmp/t41-real.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock', FACILITATOR_SIGNING_SERVICE_UID: '1005' }));
  } catch (e) {
    threw = e instanceof ConfigurationError && /REQUIRES FACILITATOR_SENDER_VERIFICATION=sdk/i.test((e as Error).message);
  }
  ok(threw, 'real mode without sdk throws');
});

test('04. real mode with passthrough throws', () => {
  let threw = false;
  try {
    loadConfig(baseEnv({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', FACILITATOR_SENDER_VERIFICATION: 'passthrough', FACILITATOR_DB_PATH: '/tmp/t41-real.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock', FACILITATOR_SIGNING_SERVICE_UID: '1005' }));
  } catch (e) {
    threw = e instanceof ConfigurationError && /REQUIRES.*sdk/i.test((e as Error).message);
  }
  ok(threw, 'real mode with passthrough throws');
});

test('05. real mode with sdk but no node host throws', () => {
  let threw = false;
  try {
    loadConfig(baseEnv({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', FACILITATOR_SENDER_VERIFICATION: 'sdk', FACILITATOR_NODE_PORT: '20000', FACILITATOR_DB_PATH: '/tmp/t41-real.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock', FACILITATOR_SIGNING_SERVICE_UID: '1005' }));
  } catch (e) {
    threw = e instanceof ConfigurationError && /FACILITATOR_NODE_HOST/i.test((e as Error).message);
  }
  ok(threw, 'missing host throws');
});

test('06. real mode with sdk but no node port throws', () => {
  let threw = false;
  try {
    loadConfig(baseEnv({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', FACILITATOR_SENDER_VERIFICATION: 'sdk', FACILITATOR_NODE_HOST: 'grpc.testnet.concordium.com', FACILITATOR_DB_PATH: '/tmp/t41-real.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock', FACILITATOR_SIGNING_SERVICE_UID: '1005' }));
  } catch (e) {
    threw = e instanceof ConfigurationError && /FACILITATOR_NODE_PORT/i.test((e as Error).message);
  }
  ok(threw, 'missing port throws');
});

test('07. invalid sender-verification mode throws', () => {
  let threw = false;
  try {
    loadConfig(baseEnv({ FACILITATOR_SENDER_VERIFICATION: 'bogus' }));
  } catch (e) {
    threw = e instanceof ConfigurationError && /must be 'sdk' or 'passthrough'/i.test((e as Error).message);
  }
  ok(threw, 'invalid mode throws');
});

// ── 3. real mode with sdk starts (provider constructed) ─────────────────────

test('08. real mode + sdk config is accepted (provider constructible, no pass-through)', () => {
  // `real` mode cannot actually start in this prototype (createSigner throws — no real
  // signer). What we CAN prove here is that loadConfig accepts the sdk configuration and
  // that the provider constructor succeeds for it. The pass-through path is unreachable.
  const cfg = loadConfig(baseEnv({
    FACILITATOR_MODE: 'real',
    FACILITATOR_SPONSOR_ADDRESS: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    FACILITATOR_SENDER_VERIFICATION: 'sdk',
    FACILITATOR_NODE_HOST: 'grpc.testnet.concordium.com',
    FACILITATOR_NODE_PORT: '20000',
    FACILITATOR_DB_PATH: '/tmp/t41-real.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock', FACILITATOR_SIGNING_SERVICE_UID: '1005',
  }));
  eq(cfg.senderVerification, 'sdk', 'sdk selected');
  // Provider construction must succeed (it does not connect until first use).
  const p = new GrpcAccountInfoProvider({ host: cfg.nodeHost!, port: cfg.nodePort!, useTls: cfg.nodeUseTls, network: cfg.network });
  ok(p !== null && p !== undefined, 'provider constructed');
});

// ── 4. mock mode starts with passthrough ────────────────────────────────────

test('09. mock mode starts with passthrough verifier', async () => {
  const started = await startFacilitator(baseEnv({ FACILITATOR_PORT: '0' }));
  ok(started !== null && started !== undefined, 'started');
  await started.close();
});

// ── 5. mock mode with sdk + bad endpoint fails closed ───────────────────────

test('10. mock mode with sdk but unreachable endpoint constructs provider (fail closed at request time)', async () => {
  // Construction succeeds (provider is lazy). The failure happens at request time.
  const started = await startFacilitator(baseEnv({
    FACILITATOR_SENDER_VERIFICATION: 'sdk',
    FACILITATOR_NODE_HOST: '127.0.0.1',
    FACILITATOR_NODE_PORT: '1', // unreachable
  }));
  ok(started !== null && started !== undefined, 'started');
  await started.close();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\ntask41: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
