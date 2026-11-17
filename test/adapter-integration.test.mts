/**
 * SDK adapter integration with the authorization boundary.
 *
 * Proves that the SDK sponsor signer is only reached after an 'approved' authorization,
 * and that the transaction hash is computed after the sponsor signature.
 *
 * Run: npx tsx test/adapter-integration.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from './owner-authz-helper.mts';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationClient, AuthorizationResponse, AuthorizationRequest } from '../services/facilitator/src/authorization.js';
import { createSdkSponsorSigner } from '../services/facilitator/src/sdkSponsorSigner.js';
import type { AccountSigner, AccountTransactionSignature } from '@concordium/web-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
// The pipeline's sponsor binding uses the mock placeholder (matching createMockSigner's
// default). The SDK adapter needs a real base58check address for its own construction and
// signature flow; these are two different concerns.
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const SDK_SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NOW = 1_800_000_000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const fakeSigner = (calls: { sign: number }): AccountSigner => ({
  async sign(): Promise<AccountTransactionSignature> {
    calls.sign++;
    return { 0: { 0: 'ff'.repeat(64) } } as AccountTransactionSignature;
  },
  getSignatureCount() { return 1n; },
});

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't35int-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 100_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v35',
};

const envelope = () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact',
      network: CAIP2,
      asset: 'CCD',
      amount: '250000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { feePayer: SPONSOR },
    },
    payload: {
      // NOTE: the SDK's signableFromJSON requires the *signable* header shape:
      //   - executionEnergyAmount (a plain integer)
      //   - sponsor.account (not sponsor.address)
      // The transaction digest still excludes resource.url, so the fixture shape change
      // does not affect the replay-key semantics being tested here.
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER,
          nonce: 7,
          expiry: NOW + 200,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: SPONSOR, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

/** Instrumented mock signer (submission only — signing comes from the SDK adapter). */
const instrumentedSigner = (calls: { addSponsor: number; submit: number }) => {
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  return {
    // Report the real sponsor address so the wire converter's sponsor binding matches the
    // payment context (the mock's default placeholder is not a valid base58check account).
    info: () => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: async (tx: unknown) => {
      calls.addSponsor++;
      return inner.addSponsorSignature(tx);
    },
    submitTransaction: async (tx: unknown) => {
      calls.submit++;
      return inner.submitTransaction(tx);
    },
    waitForFinalization: (h: string, ms?: number) => inner.waitForFinalization(h, ms),
    getAccountInfo: (a: string) => inner.getAccountInfo(a),
    getTokenBalance: (a: string, t: string) => inner.getTokenBalance(a, t),
    getTokenDecimals: (t: string) => inner.getTokenDecimals(t),
  };
};

const rejecting = (outcome: AuthorizationResponse['outcome'], reason: string): AuthorizationClient => ({
  async authorize(_r: AuthorizationRequest): Promise<AuthorizationResponse> {
    return { outcome, reason, detail: 'test override' };
  },
  async recover(): Promise<AuthorizationResponse> {
    return { outcome, reason, detail: 'test override' };
  },
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 1. rejected authorization → zero signer calls ───────────────────────────

for (const [label, outcome, reason] of [
  ['rejected', 'rejected', 'wrong_sponsor'],
  ['unknown', 'unknown', 'no_durable_decision'],
  ['owner_unavailable', 'owner_unavailable', 'owner_unavailable'],
  ['protocol_error', 'protocol_error', 'malformed_request'],
] as const) {
  test(`01. ${label} authorization → zero signer calls`, async () => {
    const { db, rm } = mk();
    const calls = { addSponsor: 0, submit: 0 };
    const core = new FacilitatorCore({
      network: CAIP2,
      signer: instrumentedSigner(calls),
      dbPath: db,
      now: () => NOW * 1000,
      authorization: rejecting(outcome, reason),
    });
    const res = await core.settle(envelope());
    check(`${label}: settle refused`, res.success === false, String(res.errorReason));
    eq(calls.addSponsor, 0, 'zero addSponsorSignature calls');
    eq(calls.submit, 0, 'zero submitTransaction calls');
    rm();
  });
}

// ── 2. SDK adapter is never invoked on a rejected authorization ──────────────

test('02. SDK adapter sign() never called when authorization is rejected', async () => {
  const { db, rm } = mk();
  const sdkCalls = { sign: 0 };
  const sdk = createSdkSponsorSigner({
    sponsorAddress: SDK_SPONSOR,
    network: CAIP2,
    accountSigner: fakeSigner(sdkCalls),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const calls = { addSponsor: 0, submit: 0 };
  const inner = instrumentedSigner(calls);
  const core = new FacilitatorCore({
    network: CAIP2,
    signer: {
      info: () => inner.info(),
      // Settle would call this; the SDK adapter is what actually signs.
      addSponsorSignature: async (tx: unknown) => {
        calls.addSponsor++;
        return sdk.addSponsorSignature(tx);
      },
      submitTransaction: inner.submitTransaction,
      waitForFinalization: inner.waitForFinalization,
      getAccountInfo: inner.getAccountInfo,
      getTokenBalance: inner.getTokenBalance,
      getTokenDecimals: inner.getTokenDecimals,
    },
    dbPath: db,
    now: () => NOW * 1000,
    authorization: rejecting('rejected', 'wrong_sponsor'),
  });
  const res = await core.settle(envelope());
  check('settle refused', res.success === false, String(res.errorReason));
  eq(sdkCalls.sign, 0, 'SDK sign() never called');
  eq(calls.addSponsor, 0, 'adapter never reached');
  rm();
});

// ── 3. approved authorization → SDK adapter signs, hash after signature ─────

test('03. approved authorization reaches the SDK adapter and hashes after signing', async () => {
  const { db, rm } = mk();
  const sdkCalls = { sign: 0 };
  const sdk = createSdkSponsorSigner({
    sponsorAddress: SDK_SPONSOR,
    network: CAIP2,
    accountSigner: fakeSigner(sdkCalls),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });

  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const authz = new LocalAuthorizationClient({ policy, repository: ownerRepoFor(db, repo, () => NOW * 1000), now: () => NOW * 1000 });

  const calls = { submit: 0 };
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  const core = new FacilitatorCore({
    network: CAIP2,
    signer: {
      info: () => inner.info(),
      addSponsorSignature: async (tx: unknown) => sdk.addSponsorSignature(tx),
      submitTransaction: async (tx: unknown) => {
        calls.submit++;
        // The submitted transaction MUST already carry the sponsor signature.
        const sigs = (tx as any)?.signatures?.sponsor;
        check('03. submitted tx carries sponsor signature', sigs !== undefined && Object.keys(sigs).length > 0, 'sponsor sig present');
        return inner.submitTransaction(tx);
      },
      waitForFinalization: inner.waitForFinalization,
      getAccountInfo: inner.getAccountInfo,
      getTokenBalance: inner.getTokenBalance,
      getTokenDecimals: inner.getTokenDecimals,
    },
    dbPath: db,
    now: () => NOW * 1000,
    authorization: authz,
  });

  const res = await core.settle(envelope());
  check('03. settle succeeded', res.success === true, res.success ? 'ok' : String(res.errorMessage));
  eq(sdkCalls.sign, 1, 'SDK sign() called exactly once');
  eq(calls.submit, 1, 'exactly one submission');
  ok(typeof res.transaction === 'string' && res.transaction.length === 64, `hash=${String(res.transaction).slice(0, 16)}...`);
  repo.close();
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
  console.log(`\nadapter-integration: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
