/**
 * TASK 38 — sender verification pipeline integration.
 *
 * Proves sender verification runs BEFORE authorization and that a rejection produces zero
 * authorization approvals, zero conversions, and zero sponsor-signer calls.
 *
 * Run: npx tsx test/task38-pipeline-integration.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { convertV2ToSdkV1 } from '../services/facilitator/src/wireConverter.js';
import type { WireConversionPolicy } from '../services/facilitator/src/wireConverter.js';
import type { SenderVerificationResult } from '../services/facilitator/src/senderVerifier.js';
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
  const dir = mkdtempSync(join(tmpdir(), 't38-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 100_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v38',
};

const envelope = () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000',
      payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR },
    },
    payload: {
      signedTransaction: {
        version: 1,
        header: { sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1, sponsor: { address: SPONSOR, numSignatures: 0 } },
        payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const buildCore = (over: {
  senderResult: SenderVerificationResult;
  calls: { verify: number; convert: number; sign: number; submit: number };
  dbPath: string;
  now: () => number;
}) => {
  const inner = createMockSigner({ network: CAIP2, now: over.now });
  const signer = {
    info: (): SignerInfo => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: async (tx: unknown) => { over.calls.sign++; return inner.addSponsorSignature(tx); },
    submitTransaction: async (tx: unknown) => { over.calls.submit++; return inner.submitTransaction(tx); },
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  const repo = new SqliteSettlementRepository(over.dbPath, { now: over.now });
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: over.dbPath,
    now: over.now,
    authorization: new LocalAuthorizationClient({ policy, repository: repo, now: over.now }),
    senderVerifier: async () => { over.calls.verify++; return over.senderResult; },
    wireConverter: (input: unknown, p: WireConversionPolicy) => {
      over.calls.convert++;
      return convertV2ToSdkV1(input, p);
    },
  });
  return { core, repo };
};

// ── 1. valid verification → full pipeline ──────────────────────────────────

test('01. valid sender verification proceeds through the pipeline', async () => {
  const { db, rm } = mk();
  const calls = { verify: 0, convert: 0, sign: 0, submit: 0 };
  const { core, repo } = buildCore({ senderResult: { ok: true }, calls, dbPath: db, now: () => NOW * 1000 });
  const res = await core.settle(envelope());
  check('01. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  eq(calls.verify, 1, 'verifier called once');
  eq(calls.convert, 1, 'converter called once');
  eq(calls.sign, 1, 'signer called once');
  repo.close();
  rm();
});

// ── 2-7. every rejection reason → zero downstream calls ────────────────────

const reasons: Array<[string, SenderVerificationResult]> = [
  ['02. invalid_signature', { ok: false, reason: 'invalid_signature' }],
  ['03. missing_signature', { ok: false, reason: 'missing_signature' }],
  ['04. insufficient_threshold', { ok: false, reason: 'insufficient_threshold' }],
  ['05. account_not_found', { ok: false, reason: 'account_not_found' }],
  ['06. node_unavailable', { ok: false, reason: 'node_unavailable' }],
  ['07. malformed_transaction', { ok: false, reason: 'malformed_transaction' }],
];

for (const [label, result] of reasons) {
  test(`${label} → zero convert, zero signer`, async () => {
    const { db, rm } = mk();
    const calls = { verify: 0, convert: 0, sign: 0, submit: 0 };
    const { core, repo } = buildCore({ senderResult: result, calls, dbPath: db, now: () => NOW * 1000 });
    const res = await core.settle(envelope());
    check(`${label}: refused`, res.success === false, String(res.errorReason));
    eq(res.errorReason, 'sender_verification_failed', 'reason');
    eq(calls.verify, 1, 'verifier called once');
    eq(calls.convert, 0, 'converter never called');
    eq(calls.sign, 0, 'signer never called');
    eq(calls.submit, 0, 'submit never called');
    repo.close();
    rm();
  });
}

// ── 8. no approval recorded on rejection ───────────────────────────────────

test('08. rejected sender verification records no approval', async () => {
  const { db, rm } = mk();
  const calls = { verify: 0, convert: 0, sign: 0, submit: 0 };
  const { core, repo } = buildCore({ senderResult: { ok: false, reason: 'invalid_signature' }, calls, dbPath: db, now: () => NOW * 1000 });
  await core.settle(envelope());
  const { paymentDigest } = await import('../services/facilitator/src/store.js');
  const digest = paymentDigest((envelope() as any).paymentPayload);
  const events = repo.signEvents(digest);
  eq(events.length, 0, 'no sign event recorded');
  repo.close();
  rm();
});

// ── 9. mock flow defaults to pass-through ──────────────────────────────────

test('09. default (no verifier injected) still works — mock flow preserved', async () => {
  const { db, rm } = mk();
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  const calls = { sign: 0 };
  const signer = {
    info: (): SignerInfo => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: async (tx: unknown) => { calls.sign++; return inner.addSponsorSignature(tx); },
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: db,
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({ policy, repository: repo, now: () => NOW * 1000 }),
  });
  const res = await core.settle(envelope());
  check('09. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  eq(calls.sign, 1, 'mock signer ran');
  repo.close();
  rm();
});

(async () => {
  let threw = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      threw++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  const failedAssertions = results.filter((r) => !r[1]).length;
  const failed = failedAssertions + threw;
  const passed = results.length - failedAssertions;
  console.log(`\ntask38 integration: ${passed}/${results.length} assertions passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
