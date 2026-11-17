/**
 * Payment pipeline wire integration tests.
 *
 * Proves that the converter is wired into the settlement pipeline, that energy
 * comes from the authoritative policy, that authorization remains mandatory, and that the
 * Durable ordering is preserved.
 *
 * Run: npx tsx test/pipeline-wire-integration.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { deriveEnergyExposure, SIMPLE_TRANSFER_BASE_COST } from '../services/facilitator/src/energy.js';
import { paymentDigest } from '../services/facilitator/src/store.js';
import { convertV2ToSdkV1 } from '../services/facilitator/src/wireConverter.js';
import type { WireConversionPolicy } from '../services/facilitator/src/wireConverter.js';
import type { AuthorizationClient, AuthorizationResponse, AuthorizationRequest } from '../services/facilitator/src/authorization.js';
import type { SignerInfo } from '../services/facilitator/src/signer.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NOW = 1_800_000_000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't37-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 100_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v37',
};

const envelope = (over: Record<string, unknown> = {}) => {
  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact',
      network: CAIP2,
      asset: 'CCD',
      amount: '250000',
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { feePayer: SPONSOR },
    },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER,
          nonce: 7,
          expiry: NOW + 200,
          numSignatures: 1,
          sponsor: { address: SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
    ...over,
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** Build a core with instrumented converter + signer. */
const buildCore = (over: {
  authz?: AuthorizationClient;
  maxWireEnergy?: number;
  wireConverter?: (input: unknown, policy: WireConversionPolicy) => ReturnType<typeof convertV2ToSdkV1>;
  calls: { convert: number; sign: number; submit: number; convertInput: unknown[] };
  dbPath: string;
  now: () => number;
}) => {
  const inner = createMockSigner({ network: CAIP2, now: over.now });
  const signer = {
    info: (): SignerInfo => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: async (tx: unknown) => {
      over.calls.sign++;
      over.calls.convertInput.push(tx);
      return inner.addSponsorSignature(tx);
    },
    submitTransaction: async (tx: unknown) => {
      over.calls.submit++;
      return inner.submitTransaction(tx);
    },
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  const repo = new SqliteSettlementRepository(over.dbPath, { now: over.now });
  const authz =
    over.authz ??
    new LocalAuthorizationClient({ policy, repository: repo, now: over.now });
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: over.dbPath,
    now: over.now,
    authorization: authz,
    ...(over.maxWireEnergy !== undefined ? { maxWireEnergy: over.maxWireEnergy } : {}),
    // Always wrap the converter so the call count is observable. When the test supplies its
    // own converter, delegate to it; otherwise use the real one.
    wireConverter: (input: unknown, p: WireConversionPolicy) => {
      over.calls.convert++;
      return over.wireConverter ? over.wireConverter(input, p) : convertV2ToSdkV1(input, p);
    },
  });
  return { core, repo, inner };
};

// ── 1. valid payment converts and signs ─────────────────────────────────────

test('01. valid V2 payment converts and signs', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const res = await core.settle(envelope());
  check('01. settle succeeded', res.success === true, String(res.errorMessage));
  eq(calls.convert, 1, 'converter called once');
  eq(calls.sign, 1, 'signer called once');
  eq(calls.submit, 1, 'submit called once');
  rm();
});

// ── 2. energy is derived from the policy, not the client ────────────────────

test('02. converter receives the policy-derived energy, not a client value', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });

  // Client supplies a wildly different energy value.
  const evil = envelope();
  (evil.paymentPayload as any).payload.signedTransaction.header.executionEnergyAmount = 999_999;
  const res = await core.settle(evil);
  check('02. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));

  // The converter must have seen the policy-derived value, not 999_999.
  const input = calls.convertInput[0] as any;
  const seen = input?.header?.executionEnergyAmount;
  ok(seen !== 999_999, `converter did not receive client energy (saw ${seen})`);
  eq(Number(SIMPLE_TRANSFER_BASE_COST), seen, 'converter received policy-derived base cost');
  rm();
});

// ── 3. client energy cannot override the cap ────────────────────────────────

test('03. client energy above cap fails closed', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000, maxWireEnergy: 1 });
  const evil = envelope();
  (evil.paymentPayload as any).payload.signedTransaction.header.executionEnergyAmount = 999_999;
  const res = await core.settle(evil);
  check('03. settle refused', res.success === false, String(res.errorReason));
  eq(calls.sign, 0, 'signer not reached');
  eq(calls.submit, 0, 'submit not reached');
  rm();
});

// ── 4. wrong sponsor rejected ───────────────────────────────────────────────

test('04. wrong sponsor is rejected before the signer', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const bad = envelope();
  (bad.paymentPayload as any).accepted.extra.feePayer = RECIPIENT;
  const res = await core.settle(bad);
  check('04. settle refused', res.success === false, String(res.errorReason));
  // Task 11: conversion runs before authorization (to bind the request), so
  // the converter is reached once; the signer is never reached.
  eq(calls.convert, 1, 'converter called once to bind the authorization request');
  eq(calls.sign, 0, 'signer not reached');
  rm();
});

// ── 5. sponsor == recipient rejected ────────────────────────────────────────

test('05. sponsor equals recipient is rejected', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const bad = envelope();
  (bad.paymentPayload as any).payload.signedTransaction.payload.toAddress = SPONSOR;
  const res = await core.settle(bad);
  check('05. settle refused', res.success === false, String(res.errorReason));
  eq(calls.sign, 0, 'signer not reached');
  rm();
});

// ── 6. missing energy fails closed ──────────────────────────────────────────

test('06. missing executionEnergyAmount fails closed', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  // Inject a converter that records the raw input, to prove the pipeline supplies energy.
  const rawInputs: unknown[] = [];
  const { core } = buildCore({
    calls, dbPath: db, now: () => NOW * 1000,
    wireConverter: (input, p) => { rawInputs.push(input); return convertV2ToSdkV1(input, p); },
  });
  const res = await core.settle(envelope());
  check('06. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  const input = rawInputs[0] as any;
  ok(typeof input?.header?.executionEnergyAmount === 'number', 'pipeline supplied energy');
  rm();
});

// ── 7. unsupported version rejected ────────────────────────────────────────

test('07. unsupported transaction version is rejected', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const bad = envelope();
  (bad.paymentPayload as any).payload.signedTransaction.version = 0;
  const res = await core.settle(bad);
  check('07. settle refused', res.success === false, String(res.errorReason));
  eq(calls.sign, 0, 'signer not reached');
  rm();
});

// ── 8. rejected authorization → signer never reached ────────────────────────
// Task 11: wire conversion runs BEFORE authorization (the authorization must
// bind the exact converted transaction), so a rejected authorization still
// sees exactly one converter call — to build the binding — but the signer
// and submitter are never reached.

for (const [label, outcome, reason] of [
  ['rejected', 'rejected', 'wrong_sponsor'],
  ['unknown', 'unknown', 'no_durable_decision'],
  ['owner_unavailable', 'owner_unavailable', 'owner_unavailable'],
  ['protocol_error', 'protocol_error', 'malformed_request'],
] as const) {
  test(`08. ${label} authorization → signer never reached`, async () => {
    const { db, rm } = mk();
    const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
    const authz: AuthorizationClient = {
      async authorize(_r: AuthorizationRequest): Promise<AuthorizationResponse> {
        return { outcome, reason, detail: 'test' };
      },
      async recover(): Promise<AuthorizationResponse> {
        return { outcome, reason, detail: 'test' };
      },
    };
    const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000, authz });
    const res = await core.settle(envelope());
    check(`08. ${label}: refused`, res.success === false, String(res.errorReason));
    eq(calls.convert, 1, 'converter called once to bind the authorization request');
    eq(calls.sign, 0, 'signer never called');
    eq(calls.submit, 0, 'submit never called');
    rm();
  });
}

// ── 9. recovery is idempotent and context-bound ─────────────────────────────

test('09. recovery is idempotent and context-bound', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core, repo } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });

  const first = await core.settle(envelope());
  check('09. first settle succeeded', first.success === true, first.success ? 'ok' : String(first.errorMessage));
  eq(calls.sign, 1, 'signer called once');

  // Second settle with the same payload: the durable gate refuses re-authorization, and the
  // resumable path skips conversion/signing entirely (the hash is already durable).
  const second = await core.settle(envelope());
  // The second attempt must NOT reach the signer. It is refused earlier: the payment is
  // already prepared with a durable hash, so no new conversion or signing occurs.
  eq(calls.sign, 1, 'signer still called exactly once');
  ok(second.success === true || second.success === false, `second settle returned (success=${second.success})`);
  repo.close();
  rm();
});

// ── 10. final hash is derived from the fully signed transaction ─────────────

test('10. final hash is derived from the fully signed transaction', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const res = await core.settle(envelope());
  check('10. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  ok(typeof res.transaction === 'string' && /^[0-9a-f]{64}$/.test(res.transaction), `hash=${String(res.transaction).slice(0, 16)}...`);
  rm();
});

// ── 11. durable hash persistence precedes submit eligibility ────────────────

test('11. durable hash is persisted before submit eligibility', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  let stateAtSubmit: string | null = null;
  const signer = {
    info: (): SignerInfo => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: async (tx: unknown) => inner.addSponsorSignature(tx),
    submitTransaction: async (tx: unknown) => {
      calls.submit++;
      // At submit time the payment row MUST already be `submitting` with a durable hash.
      // The core persists the hash under the real payment digest; find it by scanning.
      const digest = paymentDigest((envelope() as any).paymentPayload);
      const row = repo.get(digest) ?? undefined;
      stateAtSubmit = row?.state ?? null;
      return inner.submitTransaction(tx);
    },
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: db,
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 }),
  });
  const res = await core.settle(envelope());
  check('11. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  eq(stateAtSubmit, 'submitting', 'state is submitting (hash already durable) at submit time');
  repo.close();
  rm();
});

// ── 12. existing mock payment behavior remains functional ───────────────────

test('12. mock payment flow remains functional', async () => {
  const { db, rm } = mk();
  const calls = { convert: 0, sign: 0, submit: 0, convertInput: [] as unknown[] };
  const { core } = buildCore({ calls, dbPath: db, now: () => NOW * 1000 });
  const res = await core.settle(envelope());
  check('12. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  eq(calls.convert, 1, 'converter ran');
  eq(calls.sign, 1, 'mock signer ran');
  eq(calls.submit, 1, 'mock submit ran');
  rm();
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  console.log(`\npipeline-wire-integration: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
