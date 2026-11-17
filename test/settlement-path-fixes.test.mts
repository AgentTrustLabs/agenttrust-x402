/**
 * Regression tests for the Task 08 settlement-path fixes.
 *
 * Defect 1 — the signed transaction's recipient was never bound to the payment
 * requirement's payTo: a payload whose signed `toAddress` differed from `payTo`
 * passed agreement, was authorized for the claimed recipient, and would settle
 * to the wrong address.
 *
 * Defect 2 — configured fee/energy caps never reached FacilitatorCore: the core
 * silently used its hardcoded defaults (1_000 NRG / 1_000 / 10 CCD) no matter
 * what the operator configured.
 *
 * Defect 3 — `validateContext` was handed the SENDER (`payerOf(payload)`) as the
 * recipient, so the signer's sponsor!=recipient check compared the wrong pair
 * of parties.
 *
 * Everything runs offline against the mock signer: it cannot sign, cannot
 * submit, and contacts no chain. Fixtures are synthesised — no real payment
 * payload, no key, no wallet.
 */

import { eq, ok, notOk } from './helpers.mjs';
import { randomUUID } from 'node:crypto';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { loadConfig, ConfigurationError } from '../services/facilitator/src/config.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { SIMPLE_TRANSFER_BASE_COST } from '../services/facilitator/src/energy.js';
import { convertV2ToSdkV1 } from '../services/facilitator/src/wireConverter.js';
import { recomputedEnergyOf } from './owner-authz-helper.mjs';
import type { AuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { WireConversionPolicy, WireConversionResult, SdkV1SignableTransaction } from '../services/facilitator/src/wireConverter.js';
import { makeTestOwnerKey, issueTestCertificate } from './owner-authz-helper.mjs';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const MOCK_SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const NOW = 1_800_000_000; // fixed clock, seconds

const REAL_NOW = Math.floor(Date.now() / 1000);

/** Same structurally-valid V1 sponsored transaction fixture as facilitator.test.mts. */
function payloadFixture(over = {}) {
  const requirements = {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: MOCK_SPONSOR },
    ...(over.requirements ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: over.resourceUrl ?? 'agenttrust://resource/1004' },
    accepted: { ...requirements, ...(over.accepted ?? {}) },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER,
          nonce: 7,
          expiry: over.expiry ?? (over.nowSec ?? NOW) + 200,
          numSignatures: 1,
          sponsor: { address: MOCK_SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
}
const envelope = (paymentPayload, paymentRequirements) => ({
  x402Version: 2,
  paymentPayload,
  paymentRequirements,
});

/** The energy the core authorizes/fees on for the standard fixture: the SDK recomputation of the converted transaction (Task 11 — the certificate binds the recomputed energy, not the JSON-length estimate, which reads 596 for this fixture). */
const FIXTURE_ENERGY = (() => {
  const signed = payloadFixture().payload.signedTransaction as Record<string, unknown>;
  const withPolicyEnergy = {
    ...signed,
    header: { ...(signed['header'] as Record<string, unknown>), executionEnergyAmount: Number(SIMPLE_TRANSFER_BASE_COST) },
  };
  const conversion = convertV2ToSdkV1(withPolicyEnergy, {
    network: CAIP2,
    sponsorAddress: MOCK_SPONSOR,
    maxExecutionEnergy: 100000n,
  });
  if (!conversion.ok) throw new Error(`fixture conversion failed: ${conversion.code}: ${conversion.message}`);
  return recomputedEnergyOf(conversion.wire);
})();
/** The conservative fee estimate the core hands to the signer for the fixture. */
const FIXTURE_FEE = FIXTURE_ENERGY * 8000n;

/** A mock signer that counts how many times the signing/submission boundary is reached. */
function countingSigner() {
  const counts = { addSponsorSignature: 0, submitTransaction: 0 };
  const inner = createMockSigner({ network: CAIP2, behaviour: 'submit-ok', now: () => NOW * 1000 });
  const signer = {
    ...inner,
    addSponsorSignature: async (txJson) => {
      counts.addSponsorSignature++;
      return inner.addSponsorSignature(txJson);
    },
    submitTransaction: async (txJson) => {
      counts.submitTransaction++;
      return inner.submitTransaction(txJson);
    },
  };
  return { signer, counts };
}

/** A mock signer that records every validateContext call (and approves them). */
function recordingSigner() {
  const calls = [];
  const inner = createMockSigner({ network: CAIP2, behaviour: 'submit-ok', now: () => NOW * 1000 });
  const signer = {
    ...inner,
    validateContext: (ctx) => {
      calls.push(ctx);
      return null;
    },
  };
  return { signer, calls };
}

/**
 * A counting mock signer whose validateContext enforces the real signer's rule:
 * the sponsor must not be the recipient. Used to prove the recipient reaching
 * the signer is the payee, not the sender.
 */
function sponsorRecipientValidatingSigner() {
  const { signer: inner, counts } = countingSigner();
  const signer = {
    ...inner,
    validateContext: (ctx) => (ctx.sponsor === ctx.recipient ? 'sponsor must not equal recipient' : null),
  };
  return { signer, counts };
}

/** Test-only authorization client that approves every request (Task 11: an
 * approval must carry a certificate, so this seam issues a real one from the
 * request's own bound fields, signed by an ephemeral test key. The mock
 * signer never verifies it, so the seam still isolates the boundary under
 * test — it just no longer pretends an approval can exist without evidence. */
const alwaysApproveKey = makeTestOwnerKey();
const alwaysApprove: AuthorizationClient = {
  authorize: async (req) => ({
    outcome: 'approved',
    reason: null,
    detail: null,
    certificate: issueTestCertificate(alwaysApproveKey.privateKey, {
      version: 1,
      authorizationId: randomUUID(),
      paymentDigest: req.paymentDigest,
      transactionDigest: req.transactionDigest,
      transactionType: req.transactionType,
      network: req.network,
      sender: req.sender,
      sponsor: req.sponsor,
      recipient: req.recipient,
      asset: req.asset,
      amount: req.amount,
      expiry: req.expiry,
      energy: String(req.energy),
      maxEnergy: '10000',
      maxFeeMicroCcd: req.maxFeeMicroCcd,
      policyVersion: 'test-v1',
      issuedAt: Date.now(),
    }),
  }),
  recover: async (req) => ({
    outcome: 'approved',
    reason: null,
    detail: null,
    certificate: issueTestCertificate(alwaysApproveKey.privateKey, {
      version: 1,
      authorizationId: randomUUID(),
      paymentDigest: req.paymentDigest,
      transactionDigest: req.transactionDigest,
      transactionType: req.transactionType,
      network: req.network,
      sender: req.sender,
      sponsor: req.sponsor,
      recipient: req.recipient,
      asset: req.asset,
      amount: req.amount,
      expiry: req.expiry,
      energy: String(req.energy),
      maxEnergy: '10000',
      maxFeeMicroCcd: req.maxFeeMicroCcd,
      policyVersion: 'test-v1',
      issuedAt: Date.now(),
    }),
  }),
};

/** Test-only wire converter that passes its input through untouched. */
const passThroughConverter = (input: unknown, _policy: WireConversionPolicy): WireConversionResult => ({
  ok: true,
  wire: input as SdkV1SignableTransaction,
});

/**
 * Test-only wire converter for the sponsor-recipient test (Task 11): passes
 * its input through untouched EXCEPT for the sponsor shape — the x402
 * `{address}` form becomes the SDK `{account}` form. The core must compute
 * the transaction digest from the converted transaction before authorizing,
 * and the SDK cannot parse the `{address}` form, so a pure pass-through can
 * no longer reach the fee block. The converter's POLICY checks are still
 * bypassed (that is the point of the seam); only the structural SDK shape
 * is fixed. A mock placeholder sponsor is substituted with the same valid
 * placeholder address the real converter uses, so the wire object stays
 * SDK-compatible.
 */
const sdkFormConverter = (input: unknown, _policy: WireConversionPolicy): WireConversionResult => {
  const tx = input as Record<string, unknown>;
  const header = tx['header'] as Record<string, unknown>;
  const sponsor = header['sponsor'] as Record<string, unknown>;
  const sponsorValue = String(sponsor['address'] ?? sponsor['account']);
  const payload = tx['payload'] as Record<string, unknown>;
  // Same substitution the real converter makes for a mock placeholder.
  const validPlaceholder = (v: string) =>
    v === MOCK_SPONSOR ? '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8' : v;
  return {
    ok: true,
    wire: {
      ...tx,
      header: {
        ...header,
        sponsor: { account: validPlaceholder(sponsorValue), numSignatures: 0 },
      },
      // The recipient is substituted ONLY in this wire object, so the SDK
      // can parse it to compute the digest. The core's authorization and
      // fee validation read the recipient from the ORIGINAL envelope
      // payload (still MOCK_SPONSOR), so the boundary under test is
      // unchanged: validateContext still sees recipient == sponsor.
      payload: { ...payload, toAddress: validPlaceholder(String(payload['toAddress'] ?? '')) },
    } as SdkV1SignableTransaction,
  };
};

const coreWith = (opts = {}) => {
  const { signer } = opts.signer ? { signer: opts.signer } : countingSigner();
  return new FacilitatorCore({
    network: CAIP2,
    signer,
    now: () => NOW * 1000,
    ...(opts.maxAuthorizationEnergy !== undefined ? { maxAuthorizationEnergy: opts.maxAuthorizationEnergy } : {}),
    ...(opts.maxWireEnergy !== undefined ? { maxWireEnergy: opts.maxWireEnergy } : {}),
    ...(opts.maxFeeMicroCcd !== undefined ? { maxFeeMicroCcd: opts.maxFeeMicroCcd } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.wireConverter ? { wireConverter: opts.wireConverter } : {}),
  });
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ Defect 1 — signed recipient binding ═══════════════════════════════

test('01. a correct recipient verifies and settles', async () => {
  const { signer, counts } = countingSigner();
  const core = coreWith({ signer });
  const p = payloadFixture();
  const v = await core.verify(envelope(p, p.accepted));
  eq(v.isValid, true, 'valid');
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, true, 'settled');
  ok(/^[0-9a-f]{64}$/.test(r.transaction), 'real-shaped hash');
  eq(counts.addSponsorSignature, 1, 'signed once');
  eq(counts.submitTransaction, 1, 'submitted once');
});

test('02. a recipient mismatch is rejected before authorization or submission', async () => {
  const { signer, counts } = countingSigner();
  const core = coreWith({ signer });
  const p = payloadFixture();
  // The signed transaction pays a different address than the requirement's payTo.
  p.payload.signedTransaction.payload.toAddress = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
  const v = await core.verify(envelope(p, p.accepted));
  eq(v.isValid, false, 'verify refuses');
  eq(v.invalidReason, 'requirements_mismatch', 'reason');
  ok(/recipient mismatch/.test(v.invalidMessage), v.invalidMessage);
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'settle refuses');
  eq(r.errorReason, 'requirements_mismatch', 'reason');
  ok(/recipient mismatch/.test(r.errorMessage), r.errorMessage);
  eq(counts.addSponsorSignature, 0, 'never signed');
  eq(counts.submitTransaction, 0, 'never submitted');
});

test('03. a missing recipient is rejected', async () => {
  for (const label of ['absent', 'empty']) {
    const { signer, counts } = countingSigner();
    const core = coreWith({ signer });
    const p = payloadFixture();
    if (label === 'absent') delete p.payload.signedTransaction.payload.toAddress;
    else p.payload.signedTransaction.payload.toAddress = '';
    const v = await core.verify(envelope(p, p.accepted));
    eq(v.isValid, false, `${label}: verify refuses`);
    eq(v.invalidReason, 'requirements_mismatch', `${label}: reason`);
    ok(/no usable transfer recipient/.test(v.invalidMessage), `${label}: ${v.invalidMessage}`);
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, false, `${label}: settle refuses`);
    eq(r.errorReason, 'requirements_mismatch', `${label}: reason`);
    eq(counts.addSponsorSignature, 0, `${label}: never signed`);
    eq(counts.submitTransaction, 0, `${label}: never submitted`);
  }
});

test('04. sender/recipient confusion is rejected (recipient is the sender)', async () => {
  const { signer, counts } = countingSigner();
  const core = coreWith({ signer });
  const p = payloadFixture();
  // The signed transaction pays the SENDER, not the requirement's payTo.
  p.payload.signedTransaction.payload.toAddress = SENDER;
  const v = await core.verify(envelope(p, p.accepted));
  eq(v.isValid, false, 'verify refuses');
  eq(v.invalidReason, 'requirements_mismatch', 'reason');
  ok(/recipient mismatch/.test(v.invalidMessage), v.invalidMessage);
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'settle refuses');
  eq(counts.addSponsorSignature, 0, 'never signed');
  eq(counts.submitTransaction, 0, 'never submitted');
});

// ═══ Defect 2 — configured caps reach the core ═════════════════════════

test('05. a fee above the configured cap is rejected before signing', async () => {
  const { signer, counts } = countingSigner();
  // The fixture's fee estimate is FIXTURE_FEE; a cap one microCCD below it must reject.
  const core = coreWith({ signer, maxFeeMicroCcd: FIXTURE_FEE - 1n });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'refused');
  eq(r.errorReason, 'fee_validation_failed', 'reason');
  // The core response must name the ESTIMATED fee, never an actual fee: the
  // cap binds an estimate-based policy (Task 10.1, Option B), so a bare
  // "fee … exceeds cap" would wrongly imply the actual chain fee is bounded.
  ok(/estimated fee .* exceeds cap/.test(r.errorMessage), r.errorMessage);
  eq(counts.addSponsorSignature, 0, 'never signed');
  eq(counts.submitTransaction, 0, 'never submitted');
});

test('06. energy above the configured cap is rejected at authorization', async () => {
  const { signer, counts } = countingSigner();
  // The fixture derives FIXTURE_ENERGY; a cap one NRG below it must reject.
  const core = coreWith({ signer, maxAuthorizationEnergy: FIXTURE_ENERGY - 1n });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'refused');
  eq(r.errorReason, 'authorization_rejected', 'reason');
  ok(/energy_exceeds_cap/.test(r.errorMessage), r.errorMessage);
  eq(counts.addSponsorSignature, 0, 'never signed');
  eq(counts.submitTransaction, 0, 'never submitted');
});

test('07. exact cap boundaries pass, one unit below fails', async () => {
  // Energy cap exactly equal to the derived energy: authorization approves.
  {
    const core = coreWith({ maxAuthorizationEnergy: FIXTURE_ENERGY });
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, true, 'energy at cap settles');
  }
  // Fee cap exactly equal to the estimate: the core-level check passes.
  {
    const core = coreWith({ maxFeeMicroCcd: FIXTURE_FEE });
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, true, 'fee at cap settles');
  }
  // Wire cap exactly equal to the transfer base cost (300): conversion passes.
  {
    const core = coreWith({ maxWireEnergy: Number(SIMPLE_TRANSFER_BASE_COST) });
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, true, 'wire energy at cap settles');
  }
  // Wire cap one below the base cost: conversion fails closed.
  {
    const core = coreWith({ maxWireEnergy: Number(SIMPLE_TRANSFER_BASE_COST) - 1 });
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, false, 'wire energy below cap refused');
    eq(r.errorReason, 'wire_conversion_failed', 'reason');
    ok(/energy_exceeds_policy/.test(r.errorMessage), r.errorMessage);
  }
});

test('08. invalid or missing cap configuration cannot silently disable the limits', async () => {
  // Invalid values are refused at load time.
  for (const [key, value] of [
    ['FACILITATOR_MAX_ENERGY', 'abc'],
    ['FACILITATOR_MAX_ENERGY', '-5'],
    ['FACILITATOR_MAX_ENERGY', '1.5'],
    ['FACILITATOR_MAX_FEE_MICROCCD', 'abc'],
    ['FACILITATOR_MAX_FEE_MICROCCD', '-1'],
  ]) {
    let threw = null;
    try { loadConfig({ FACILITATOR_MODE: 'mock', [key]: value }); } catch (e) { threw = e; }
    ok(threw instanceof ConfigurationError, `${key}=${value} refused: ${String(threw?.message ?? 'no error')}`);
  }
  // Missing values fall back to the documented defaults — never to "no limit".
  const defaults = loadConfig({ FACILITATOR_MODE: 'mock' });
  eq(defaults.maxEnergy, 1000n, 'default energy cap 1000');
  eq(defaults.maxFeeMicroCcd, 10_000_000n, 'default fee cap 10 CCD');

  // The configured caps actually reach the core through the server: a low energy
  // cap rejects the standard fixture over HTTP, and a low fee cap does the same.
  const settleHttp = async (env) => {
    const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0', ...env });
    try {
      const p = payloadFixture({ nowSec: REAL_NOW });
      const res = await fetch(`${f.url}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope(p, p.accepted)),
      });
      return res.json();
    } finally { await f.close(); }
  };
  const lowEnergy = await settleHttp({ FACILITATOR_MAX_ENERGY: '100' });
  eq(lowEnergy.success, false, 'low energy cap rejects over HTTP');
  // Task 11: wire conversion runs BEFORE authorization (the authorization
  // must bind the exact converted transaction), and the converter enforces
  // the energy cap — so a low energy cap now surfaces at conversion, not
  // at authorization. The payment is still refused before any signing.
  eq(lowEnergy.errorReason, 'wire_conversion_failed', 'energy reason');
  const lowFee = await settleHttp({ FACILITATOR_MAX_FEE_MICROCCD: '1000000' });
  eq(lowFee.success, false, 'low fee cap rejects over HTTP');
  eq(lowFee.errorReason, 'fee_validation_failed', 'fee reason');
  const atDefault = await settleHttp({});
  eq(atDefault.success, true, 'default config settles over HTTP');
});

// ═══ 9. no submission or settlement on any validation failure ══════════

test('09. no submission or persisted settlement follows a validation failure', async () => {
  const failures = [
    ['recipient mismatch', (p) => { p.payload.signedTransaction.payload.toAddress = SENDER; }],
    ['missing recipient', (p) => { delete p.payload.signedTransaction.payload.toAddress; }],
    ['fee cap', null],
    ['energy cap', null],
  ];
  for (const [label, mutate] of failures) {
    const { signer, counts } = countingSigner();
    const core = coreWith({
      signer,
      ...(label === 'fee cap' ? { maxFeeMicroCcd: FIXTURE_FEE - 1n } : {}),
      ...(label === 'energy cap' ? { maxAuthorizationEnergy: FIXTURE_ENERGY - 1n } : {}),
    });
    const p = payloadFixture();
    if (mutate) mutate(p);
    const r = await core.settle(envelope(p, p.accepted));
    eq(r.success, false, `${label}: refused`);
    eq(counts.addSponsorSignature, 0, `${label}: never signed`);
    eq(counts.submitTransaction, 0, `${label}: never submitted`);
    // Nothing was persisted as a settlement: no transaction hash is recorded.
    const row = r.extra?.digest ? core.store.get(r.extra.digest) : undefined;
    ok(!row?.tx_hash, `${label}: no hash persisted`);
  }
});

// ═══ Defect 3 — validateContext receives the payee ═════════════════════

test('10. validateContext receives the payee, never the sender', async () => {
  const { signer, calls } = recordingSigner();
  const core = coreWith({ signer });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, true, 'settled');
  eq(calls.length, 1, 'validateContext called once');
  const ctx = calls[0];
  eq(ctx.recipient, PAY_TO, 'recipient is the payee');
  notOk(ctx.recipient === SENDER, 'recipient is not the sender');
  eq(ctx.sponsor, MOCK_SPONSOR, 'sponsor unchanged');
  eq(ctx.energy, FIXTURE_ENERGY, 'energy is the derived value');
  eq(ctx.feeMicroCcd, FIXTURE_FEE, 'fee is the conservative estimate');
});

test('11. validateContext rejects a payment whose real recipient is the sponsor', async () => {
  // The old code passed the sender here, so this payment sailed past the signer's
  // sponsor!=recipient check. The real converter and the authorization owner also
  // refuse it, so both are bypassed with test-only seams to isolate this boundary.
  const { signer, counts } = sponsorRecipientValidatingSigner();
  const core = coreWith({ signer, authorization: alwaysApprove, wireConverter: sdkFormConverter });
  const p = payloadFixture({ accepted: { payTo: MOCK_SPONSOR }, requirements: { payTo: MOCK_SPONSOR } });
  p.payload.signedTransaction.payload.toAddress = MOCK_SPONSOR;
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'refused');
  eq(r.errorReason, 'fee_validation_failed', 'reason');
  ok(/sponsor must not equal recipient/.test(r.errorMessage), r.errorMessage);
  eq(counts.addSponsorSignature, 0, 'never signed');
  eq(counts.submitTransaction, 0, 'never submitted');
});

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nsettlement-path-fixes: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
