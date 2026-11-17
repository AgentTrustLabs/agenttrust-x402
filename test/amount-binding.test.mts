/**
 * F5 — amount binding: the amount recorded in a sign event must be the amount in
 * the signed transaction, not the client-supplied `accepted` value.
 *
 * `accepted` and `requirements` are both client-supplied, so their agreement proves
 * nothing about what the sender actually signed. FacilitatorCore.checkAgreement
 * now binds the accepted amount to the signed transaction's transfer amount for
 * transfer-family payloads (transfer / transferWithMemo / kind 3). A mismatch is
 * refused before any claim, authorization, or signer call.
 *
 * Offline. Mock signer only; no key material, no chain, no broadcast.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner, type SponsorSigner } from '../services/facilitator/src/signer.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from './owner-authz-helper.mts';
import { paymentDigest } from '../services/facilitator/src/store.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NOW = 1_800_000_000;

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const countedSigner = (inner: SponsorSigner, calls: { sign: number }): SponsorSigner => ({
  info: inner.info,
  addSponsorSignature: async (tx: unknown) => {
    calls.sign++;
    return inner.addSponsorSignature(tx);
  },
  submitTransaction: inner.submitTransaction,
  waitForFinalization: inner.waitForFinalization,
  getAccountInfo: inner.getAccountInfo,
  getTokenBalance: inner.getTokenBalance,
  getTokenDecimals: inner.getTokenDecimals,
});

/** Envelope builder. `signedAmount` is the amount inside the signed transaction. */
const envelope = (signedAmount: string | null, kind: string | number = 'transfer') => {
  const signedTransaction =
    signedAmount === null
      ? undefined
      : {
          version: 1,
          header: {
            sender: SENDER,
            nonce: 7,
            expiry: NOW + 200,
            numSignatures: 1,
            sponsor: { address: SPONSOR, numSignatures: 0 },
          },
          payload:
            kind === 'transferWithMemo'
              ? { type: 'transferWithMemo', toAddress: PAY_TO, amount: signedAmount, memo: 'aGVsbG8=' }
              : { type: kind, toAddress: PAY_TO, amount: signedAmount },
          signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
        };
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
    payload: signedTransaction ? { signedTransaction } : {},
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-amount-'));
  const db = join(dir, 'f.db');
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const calls = { sign: 0 };
  const core = new FacilitatorCore({
    network: CAIP2,
    // The mock signer's address must be the sponsor: the wire converter binds
    // the signed transaction's sponsor slot to the signer's address.
    signer: countedSigner(createMockSigner({ network: CAIP2, now: () => NOW * 1000, placeholderAddress: SPONSOR }), calls),
    dbPath: db,
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({
      policy: {
        network: CAIP2,
        sponsor: SPONSOR,
        maxEnergy: 100_000n,
        maxExpiryOffsetSeconds: 600,
        allowedAssets: ['CCD'],
        policyVersion: 't-amount',
      },
      repository: ownerRepo,
      now: () => NOW * 1000,
    }),
  });
  return { dir, db, repo, ownerRepo, calls, core, cleanup: () => { try { ownerRepo.close(); } catch { /* already closed */ } repo.close(); rmSync(dir, { recursive: true, force: true }); } };
};

test('01. matching amounts settle past the agreement check (signer called once)', async () => {
  const s = setup();
  try {
    const res = await s.core.settle(envelope('250000'));
    eq(s.calls.sign, 1, 'signer called once');
    // The mock submitter decides the final outcome (submit-ok here); what this
    // test proves is that the agreement check passed and signing was reached.
    ok(res.errorReason !== 'requirements_mismatch', `not an agreement failure: ${String(res.errorReason)}`);
  } finally {
    s.cleanup();
  }
});

test('02. signed amount != accepted amount is refused before any signer call', async () => {
  const s = setup();
  try {
    const res = await s.core.settle(envelope('1'));
    eq(res.success, false, 'refused');
    eq(res.errorReason, 'requirements_mismatch', 'agreement failure');
    ok(/amount mismatch/i.test(String(res.errorMessage)), `message names the mismatch: ${String(res.errorMessage)}`);
    eq(s.calls.sign, 0, 'signer never reached');
    // No sign event was recorded for the refused payment.
    const events = s.ownerRepo.signEvents(paymentDigest(envelope('1').paymentPayload));
    eq(events.length, 0, 'no sign event recorded');
  } finally {
    s.cleanup();
  }
});

test('03. transferWithMemo with a matching amount is covered by the same invariant', async () => {
  const s = setup();
  try {
    const res = await s.core.settle(envelope('250000', 'transferWithMemo'));
    eq(s.calls.sign, 1, 'signer called once');
    ok(res.errorReason !== 'requirements_mismatch', `not an agreement failure: ${String(res.errorReason)}`);
  } finally {
    s.cleanup();
  }
});

test('04. transferWithMemo with a mismatched amount is refused', async () => {
  const s = setup();
  try {
    const res = await s.core.settle(envelope('999', 'transferWithMemo'));
    eq(res.success, false, 'refused');
    eq(res.errorReason, 'requirements_mismatch', 'agreement failure');
    eq(s.calls.sign, 0, 'signer never reached');
  } finally {
    s.cleanup();
  }
});

test('05. a payload with no signed transaction is not refused for amount reasons', async () => {
  // Documented limit: with no signed transaction there is nothing to bind. The
  // check is skipped, and the payment fails later (energy cannot be derived),
  // never with an amount-mismatch refusal.
  const s = setup();
  try {
    const res = await s.core.settle(envelope(null));
    eq(res.success, false, 'refused');
    ok(res.errorReason !== 'requirements_mismatch', `not an agreement failure: ${String(res.errorReason)}`);
    eq(s.calls.sign, 0, 'signer never reached');
  } finally {
    s.cleanup();
  }
});

test('06. leading zeros in the signed amount still match numerically', async () => {
  const s = setup();
  try {
    const res = await s.core.settle(envelope('0250000'));
    eq(s.calls.sign, 1, 'signer called once');
    ok(res.errorReason !== 'requirements_mismatch', `not an agreement failure: ${String(res.errorReason)}`);
  } finally {
    s.cleanup();
  }
});

// ═══ runner ═════════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\namount-binding: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
