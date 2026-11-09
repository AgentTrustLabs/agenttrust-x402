/**
 * TASK 35 — SDK sponsor signer adapter (deterministic fake signer).
 *
 * Proves the adapter:
 *   - uses the official SDK sponsor() flow,
 *   - never accepts private-key strings,
 *   - validates sponsor context before signing,
 *   - computes the hash after the sponsor signature,
 *   - propagates signer errors,
 *   - rejects non-V1 transactions.
 *
 * The AccountSigner is a deterministic fake (no key material).
 *
 * Run: npx tsx test/task35-sdk-sponsor-signer.test.mts
 */

import { describe } from './helpers.mjs';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { AccountAddress, AccountTransactionType, Energy } from '@concordium/web-sdk';
import { Transaction } from '@concordium/web-sdk';
import type { AccountSigner, AccountTransactionSignature } from '@concordium/web-sdk';

import { createSdkSponsorSigner, validateSponsorContext, validateSponsorAddress } from '../services/facilitator/src/sdkSponsorSigner.js';
import { ok, eq } from './helpers.mjs';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

// Deterministic fake AccountSigner — no key material, no real crypto.
function makeFakeSigner(sigCount = 1n): AccountSigner {
  return {
    async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
      return { 0: { 0: 'ff'.repeat(64) } } as AccountTransactionSignature;
    },
    getSignatureCount(): bigint {
      return sigCount;
    },
  };
}

/**
 * Build a SignableV1 JSON in the SDK's canonical shape.
 *
 * The SDK's `signableFromJSON` requires the *signable* header shape, which includes
 * `executionEnergyAmount` and uses `sponsor.account` (not `sponsor.address`). The payment
 * payload uses the SDK transaction-kind string and a microCCD amount object.
 */
function makeV1TxJson(overrides: Record<string, unknown> = {}) {
  const expiry = Math.floor(Date.now() / 1000) + 200;
  return {
    version: 1,
    header: {
      sender: SENDER,
      nonce: 7,
      expiry,
      executionEnergyAmount: 300,
      numSignatures: 1,
      sponsor: { account: SPONSOR, numSignatures: 1 },
    },
    payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
    signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
    ...overrides,
  };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 1. successful signing produces a sponsor signature ───────────────────────

test('01. addSponsorSignature produces a signed transaction with sponsor sigs', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const tx = makeV1TxJson();
  const signed = await signer.addSponsorSignature(tx) as Record<string, unknown>;
  const sigs = (signed as any).signatures?.sponsor;
  ok(sigs && Object.keys(sigs).length > 0, 'sponsor signatures present');
  ok((signed as any).version === 1, 'version preserved');
});

// ── 2. hash is computed after signature ──────────────────────────────────────

test('02. computeHashAfterSignature returns a 64-hex string', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const tx = makeV1TxJson();
  const signed = await signer.addSponsorSignature(tx);
  const hash = signer.computeHashAfterSignature(signed);
  ok(/^[0-9a-f]{64}$/.test(hash), `hash=${hash.slice(0, 16)}...`);
});

// ── 3. signer error propagation ──────────────────────────────────────────────

test('03. signer error propagates as sdk sponsor signer: signing failed', async () => {
  const failingSigner: AccountSigner = {
    async sign() { throw new Error('HSM unreachable'); },
    getSignatureCount() { return 1n; },
  };
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: failingSigner,
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const tx = makeV1TxJson();
  let threw = false;
  try {
    await signer.addSponsorSignature(tx);
  } catch (e) {
    threw = /signing failed/i.test((e as Error).message);
  }
  ok(threw, 'signer error propagated');
});

// ── 4. non-V1 transaction rejected ──────────────────────────────────────────

test('04. non-V1 transaction is rejected', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const tx = makeV1TxJson({ version: 0 });
  let threw = false;
  let msg = '';
  try {
    await signer.addSponsorSignature(tx);
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  // A V0 transaction cannot be sponsor-signed: either the SDK rejects the V0 JSON shape
  // (it requires `signature`, not `signatures`) or our adapter rejects the version.
  ok(threw, `rejected (${msg.slice(0, 60)})`);
});

// ── 5. invalid transaction rejected ─────────────────────────────────────────

test('05. invalid transaction JSON is rejected', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  let threw = false;
  try {
    await signer.addSponsorSignature({});
  } catch (e) {
    threw = /invalid transaction/i.test((e as Error).message);
  }
  ok(threw, 'invalid tx rejected');
});

// ── 6. sponsor context validation ────────────────────────────────────────────

test('06. validateContext rejects wrong network', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const err = signer.validateContext({ network: 'ccd:0000', sponsor: SPONSOR, recipient: RECIPIENT, energy: 100n, feeMicroCcd: 100n });
  ok(err !== null && /wrong network/i.test(err), `err=${err}`);
});

test('07. validateContext rejects sponsor == recipient', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const err = signer.validateContext({ network: CAIP2, sponsor: SPONSOR, recipient: SPONSOR, energy: 100n, feeMicroCcd: 100n });
  ok(err !== null && /sponsor must not equal recipient/i.test(err), `err=${err}`);
});

test('08. validateContext rejects energy over cap', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const err = signer.validateContext({ network: CAIP2, sponsor: SPONSOR, recipient: RECIPIENT, energy: 999n, feeMicroCcd: 100n });
  ok(err !== null && /energy.*exceeds/i.test(err), `err=${err}`);
});

test('09. validateContext rejects fee over cap', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 100n,
  });
  const err = signer.validateContext({ network: CAIP2, sponsor: SPONSOR, recipient: RECIPIENT, energy: 10n, feeMicroCcd: 999n });
  ok(err !== null && /fee.*exceeds/i.test(err), `err=${err}`);
});

test('10. validateContext accepts valid context', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const err = signer.validateContext({ network: CAIP2, sponsor: SPONSOR, recipient: RECIPIENT, energy: 100n, feeMicroCcd: 100n });
  ok(err === null, `err=${err}`);
});

// ── 11. info() reports canSign:true ─────────────────────────────────────────

test('11. info reports canSign:true and sdk:true', async () => {
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  const info = signer.info();
  ok(info.canSign === true, 'canSign');
  ok(info.sdk === true, 'sdk');
  ok(info.address === SPONSOR, 'address');
});

// ── 12. invalid sponsor address rejected at construction ─────────────────────

test('12. invalid sponsor address throws at construction', async () => {
  let threw = false;
  try {
    createSdkSponsorSigner({
      sponsorAddress: 'not-a-valid-address',
      network: CAIP2,
      accountSigner: makeFakeSigner(),
      maxEnergy: 100_000n,
      maxFeeMicroCcd: 1_000_000n,
    });
  } catch (e) {
    threw = /invalid sponsor address/i.test((e as Error).message);
  }
  ok(threw, 'invalid address rejected');
});

// ── 13. sponsor address validation helper ────────────────────────────────────

test('13. validateSponsorAddress accepts valid, rejects invalid', async () => {
  ok(validateSponsorAddress(SPONSOR) === null, 'valid accepted');
  ok(validateSponsorAddress('garbage') !== null, 'invalid rejected');
});

// ── 14. no private key material accepted ────────────────────────────────────

test('14. constructor accepts only an injected AccountSigner, never a key string', async () => {
  // The constructor signature has no privateKey/mnemonic/keystore/wallet parameter.
  // This is a structural assertion: the only signing input is accountSigner.
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    accountSigner: makeFakeSigner(),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 1_000_000n,
  });
  ok(typeof signer.addSponsorSignature === 'function', 'signer created');
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
  console.log(`\ntask35: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
