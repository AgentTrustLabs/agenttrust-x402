/**
 * Isolated facilitator prototype tests.
 *
 * Everything runs offline against an in-process server on an ephemeral loopback port. The
 * signer is the mock: it cannot sign, cannot submit, and contacts no chain. Fixtures are
 * synthesised — no real payment payload, no key, no wallet.
 */

import { eq, ok, notOk } from './helpers.mjs';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { loadConfig, ConfigurationError, isConcordiumAccount } from '../services/facilitator/src/config.js';
import { createSigner, createMockSigner, MOCK_TX_HASH_PREFIX } from '../services/facilitator/src/signer.js';
import { SettlementStore, payloadDigest, requirementsKey } from '../services/facilitator/src/store.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const NOW = 1_800_000_000; // fixed clock, seconds

const REAL_NOW = Math.floor(Date.now() / 1000);

/**
 * A structurally-valid V1 sponsored transaction fixture. Contains NO signature.
 *
 * `expiry` is relative to `over.nowSec`, which defaults to the injected `NOW` clock used by
 * the in-process tests. HTTP tests pass `{ nowSec: REAL_NOW }` because the server there uses
 * the real clock. Keeping the two clocks explicit avoids a fixture that is "expired" under
 * one and "too far ahead" under the other.
 */
function payloadFixture(over = {}) {
  const requirements = {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' },
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
          sponsor: { address: '3mockSponsorPlaceholderNotARealAccountAddress0000', numSignatures: 0 },
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

const coreWith = (behaviour, opts = {}) => {
  const signer = createMockSigner({ network: CAIP2, behaviour, now: () => NOW * 1000 });
  return new FacilitatorCore({
    network: CAIP2,
    signer,
    now: () => (opts.nowMs ?? NOW * 1000),
    ...(opts.store ? { store: opts.store } : {}),
  });
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ 1. configuration fails closed ══════════════════════════════════════

test('01. FACILITATOR_MODE is mandatory — no implicit mode', () => {
  let threw = null;
  try { loadConfig({}); } catch (e) { threw = e; }
  ok(threw instanceof ConfigurationError, 'refuses to guess');
  ok(/must be set explicitly/.test(threw.message), threw.message);
});

test('02. an unknown mode is refused', () => {
  for (const m of ['', 'production', 'live', 'REAL']) {
    let threw = null;
    try { loadConfig({ FACILITATOR_MODE: m }); } catch (e) { threw = e; }
    ok(threw instanceof ConfigurationError, `mode '${m}' refused`);
  }
});

test('03. real mode cannot start: no real signer exists in this prototype', () => {
  let threw = null;
  try { createSigner({ mode: 'real', network: CAIP2 }); } catch (e) { threw = e; }
  ok(threw instanceof ConfigurationError, 'fails closed');
  ok(/separately provisioned sponsor signer/.test(threw.message), threw.message);
});

test('04. mainnet and non-testnet networks are refused', () => {
  for (const net of ['ccd:9dd9ca4d19e9393877d2c44b70f89acb', 'eip155:8453', '']) {
    let threw = null;
    try { loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_NETWORK: net }); } catch (e) { threw = e; }
    ok(threw instanceof ConfigurationError, `network '${net}' refused`);
  }
});

test('05. mock mode must bind loopback and must not be given a real sponsor', () => {
  let a = null;
  try { loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_HOST: '0.0.0.0' }); } catch (e) { a = e; }
  ok(a instanceof ConfigurationError, 'non-loopback bind refused');

  let b = null;
  try {
    loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_SPONSOR_ADDRESS: PAY_TO });
  } catch (e) { b = e; }
  ok(b instanceof ConfigurationError, 'a sponsor address in mock mode is refused');
});

test('06. real mode requires a sponsor address, and a malformed one is refused', () => {
  let a = null;
  try { loadConfig({ FACILITATOR_MODE: 'real' }); } catch (e) { a = e; }
  ok(a instanceof ConfigurationError && /requires FACILITATOR_SPONSOR_ADDRESS/.test(a.message), String(a?.message));

  let b = null;
  try { loadConfig({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: 'not-an-account' }); } catch (e) { b = e; }
  ok(b instanceof ConfigurationError && /base58check/.test(b.message), String(b?.message));
});

test('07. a well-formed config loads, and the account validator is shape-only', () => {
  const c = loadConfig({ FACILITATOR_MODE: 'mock' });
  eq(c.mode, 'mock', 'mode');
  eq(c.network, CAIP2, 'network');
  eq(c.sponsorAddress, null, 'no sponsor in mock');
  eq(isConcordiumAccount(PAY_TO), true, 'a real-shaped account passes');
  eq(isConcordiumAccount('short'), false, 'a short string fails');
  eq(isConcordiumAccount(0), false, 'a non-string fails');
});

// ═══ 2. the signer provably cannot sign ═════════════════════════════════

test('08. the mock signer reports canSign false and holds no key', () => {
  const s = createMockSigner({ network: CAIP2 });
  const info = s.info();
  eq(info.canSign, false, 'cannot sign');
  eq(info.network, CAIP2, 'network');
  ok(info.address.length > 0, 'has a placeholder address');
  // The only source text of this module contains no private-key material at all.
  ok(!Object.keys(s).some(k => /key|secret|seed|mnemonic|wallet/i.test(k)), 'no key-bearing member');
});

test('09. addSponsorSignature does not produce a signature', async () => {
  const s = createMockSigner({ network: CAIP2 });
  const out = await s.addSponsorSignature({ a: 1 });
  eq(out.__simulated, true, 'marked simulated');
  eq(out.__mocked, true, 'marked mocked');
  // No signature map was added: the object still has no real signature field.
  eq(out.signatures, undefined, 'no signatures produced');
});

test('10. the mock never contacts a chain and returns a clearly fake hash', async () => {
  const s = createMockSigner({ network: CAIP2, now: () => 1234 });
  const hash = await s.submitTransaction({});
  ok(hash.startsWith(MOCK_TX_HASH_PREFIX), `hash is prefixed: ${hash}`);
  const fin = await s.waitForFinalization(hash);
  eq(fin.simulated, true, 'finalization is marked simulated');
});

// ═══ 3. /supported ↔ gateway compatibility ══════════════════════════════

test('11. /supported carries exact + ccd testnet + a feePayer', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const res = await fetch(`${f.url}/supported`);
    eq(res.status, 200, 'status');
    const body = await res.json();
    eq(body.kinds.length, 1, 'one kind');
    const k = body.kinds[0];
    eq(k.x402Version, 2, 'v2');
    eq(k.scheme, 'exact', 'exact');
    eq(k.network, CAIP2, 'testnet');
    ok(typeof k.extra.feePayer === 'string' && k.extra.feePayer.length > 0, 'feePayer present');
    ok(Array.isArray(body.signers['ccd:*']), 'signers map');
  } finally { await f.close(); }
});

test('12. the gateway probe and classifier accept it UNMODIFIED', async () => {
  const { probeFacilitator, classifyCompatibility } = await import('../src/payments/facilitator.js');
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const probe = await probeFacilitator({ url: f.url });
    eq(probe.ok, true, 'gateway probe accepted it');
    const compat = classifyCompatibility(probe.body, CAIP2);
    eq(compat.usable, true, 'classified usable');
    eq(compat.code, 'OK', 'code OK');
    ok(compat.schemesOnNetwork.includes('exact'), 'exact advertised');
  } finally { await f.close(); }
});

test('13. createHttpFacilitator reads it over real HTTP', async () => {
  const { createHttpFacilitator } = await import('../src/payments/x402Sdk.js');
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const sup = await createHttpFacilitator({ url: f.url }).getSupported();
    eq(sup.kinds.length, 1, 'one kind over HTTP');
    eq(sup.kinds[0].network, CAIP2, 'network');
  } finally { await f.close(); }
});

test('14. healthz reports mock mode and canSign false', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const h = await (await fetch(`${f.url}/healthz`)).json();
    eq(h.mode, 'mock', 'mode');
    eq(h.canSign, false, 'cannot sign');
  } finally { await f.close(); }
});

// ═══ 4. /verify ═════════════════════════════════════════════════════════

test('15. a well-formed payload verifies', async () => {
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  const r = await core.verify(envelope(p, p.accepted));
  eq(r.isValid, true, 'valid');
  eq(r.payer, SENDER, 'payer surfaced');
  eq(r.extra.simulated, true, 'marked simulated');
});

test('16. malformed envelopes are refused', async () => {
  const core = coreWith('submit-ok');
  const cases = [
    [null, 'null body'],
    ['nope', 'string body'],
    [{}, 'no version'],
    [{ x402Version: 1 }, 'wrong version'],
    [{ x402Version: 2 }, 'no payload'],
    [{ x402Version: 2, paymentPayload: {}, paymentRequirements: {} }, 'no payload body'],
  ];
  for (const [body, label] of cases) {
    const r = await core.verify(body);
    eq(r.isValid, false, label);
    eq(r.invalidReason, 'invalid_request', `${label} reason`);
  }
});

test('17. requirement/payload disagreement is refused per field', async () => {
  for (const field of ['scheme', 'network', 'asset', 'amount', 'payTo']) {
    // Mutate ONLY the accepted side; the requirements stay as the seller declared them.
    // (Mutating both would make them agree again — the earlier version of this test did
    // exactly that and asserted a tautology.)
    const p = payloadFixture();
    const pristine = payloadFixture().accepted;
    p.accepted[field] = field === 'amount' ? '999999' : `wrong-${field}`;
    const r = await coreWith('submit-ok').verify(envelope(p, pristine));
    eq(r.isValid, false, `${field} mismatch refused`);
    eq(r.invalidReason, 'requirements_mismatch', `${field} reason`);
  }
});

test('18. an expired payment is refused', async () => {
  const p = payloadFixture({ expiry: NOW - 10 });
  const r = await coreWith('submit-ok').verify(envelope(p, p.accepted));
  eq(r.isValid, false, 'expired');
  eq(r.invalidReason, 'expired', 'reason');
});

test('19. an over-far expiry is refused (spec rule 7)', async () => {
  const p = payloadFixture({ expiry: NOW + 5000 });
  const r = await coreWith('submit-ok').verify(envelope(p, p.accepted));
  eq(r.isValid, false, 'too far ahead');
  ok(/rule 7/.test(r.invalidMessage), r.invalidMessage);
});

// ═══ 5. /settle — mocked success ════════════════════════════════════════

test('20. a first settle succeeds and returns a (fake) transaction hash', async () => {
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, true, 'success');
  // The mock now returns the REAL SDK-computed hash of the fully signed
  // transaction, so the persisted-hash comparison is meaningful. It is still not a real
  // chain hash — the mock never contacts a chain — but it is a genuine 64-hex identifier.
  ok(/^[0-9a-f]{64}$/.test(r.transaction), `real-shaped hash: ${r.transaction}`);
  eq(r.network, CAIP2, 'network');
  eq(r.extra.simulated, true, 'marked simulated');
});

test('21. a duplicate settle is idempotent: same hash, no second submission', async () => {
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  const first = await core.settle(envelope(p, p.accepted));
  const second = await core.settle(envelope(p, p.accepted));
  eq(first.success, true, 'first settled');
  eq(second.success, true, 'second reports settled');
  eq(second.transaction, first.transaction, 'same transaction hash');
  eq(second.extra.idempotentReplay, true, 'marked as an idempotent replay');
});

test('22. the same signed payment cannot be redeemed against a second resource', async () => {
  // The real replay threat: identical signed transaction, only resource.url differs. A
  // signature pays a fixed recipient a fixed amount once — not once per endpoint.
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  const first = await core.settle(envelope(p, p.accepted));
  eq(first.success, true, 'first redemption settled');

  const samePaymentNewResource = {
    ...p,
    resource: { url: 'agenttrust://resource/a-different-resource' },
  };
  const replay = await core.verify(envelope(samePaymentNewResource, p.accepted));
  eq(replay.isValid, false, 'replay refused at verify');
  eq(replay.invalidReason, 'replay', 'reason');

  const replaySettle = await core.settle(envelope(samePaymentNewResource, p.accepted));
  eq(replaySettle.success, false, 'replay refused at settle too');
});

test('22b. the same payment presented for a different amount is refused', async () => {
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  await core.settle(envelope(p, p.accepted));
  const mutatedReq = { ...p.accepted, amount: '999999' };
  const r = await core.verify(envelope(p, mutatedReq));
  eq(r.isValid, false, 'refused');
  eq(r.invalidReason, 'requirements_mismatch', 'agreement is checked before replay');
});

// ═══ 6. /settle — ambiguous outcomes ════════════════════════════════════

test('23. a submission that throws yields settlement_pending, never success', async () => {
  const core = coreWith('submit-throws');
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'not a success');
  eq(r.errorReason, 'settlement_pending', 'pending');
  eq(r.extra.nonTerminal, true, 'non-terminal');
});

test('24. a pending settlement is NOT retried automatically', async () => {
  const core = coreWith('submit-throws');
  const p = payloadFixture();
  await core.settle(envelope(p, p.accepted));
  const second = await core.settle(envelope(p, p.accepted));
  eq(second.success, false, 'still not success');
  eq(second.errorReason, 'settlement_pending', 'still pending');
  eq(second.extra.nonTerminal, true, 'non-terminal');
});

test('25. broadcast-but-unconfirmed yields pending with a real hash to reconcile', async () => {
  const core = coreWith('finalization-throws');
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'not a success');
  eq(r.errorReason, 'settlement_pending', 'pending');
  ok(/^[0-9a-f]{64}$/.test(r.transaction), 'real hash present for reconciliation');
});

test('26. a non-final status (committed) stays pending', async () => {
  const core = coreWith('submit-ok');
  const p = payloadFixture();
  // Replace the signer's finalization to report committed.
  core['signer'].waitForFinalization = async txHash => ({ txHash, status: 'committed', sender: SENDER, simulated: true });
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'committed is not final');
  eq(r.errorReason, 'settlement_pending', 'pending');
});

test('27. a transaction finalized as failed is a terminal failure, not pending', async () => {
  const core = coreWith('finalization-failed');
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  eq(r.success, false, 'failed');
  eq(r.errorReason, 'transaction_failed', 'terminal');
  notOk(r.extra?.nonTerminal === true, 'not marked non-terminal');
});

test('28. reconciliation cannot turn an unknown outcome into success', async () => {
  const core = coreWith('finalization-throws');
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  const digest = r.extra.digest;
  eq(r.success, false, 'pending as expected');

  // Reconciliation is no longer callable on the core. It requires an authenticated
  // operator plus a trusted evidence verifier; the caller cannot state an outcome. The state
  // machine behaviour that used to be asserted here is covered exhaustively in
  // test/settlement-durability.test.mts.
  eq(r.success, false, 'the core cannot finalize an unresolved payment by itself');
  const row = core.store.get(digest);
  eq(row?.state, 'outcome_unknown', 'still awaiting verified evidence');
});

test('29. a payload with a previous terminal failure needs a new payload', async () => {
  const core = coreWith('finalization-failed');
  const p = payloadFixture();
  await core.settle(envelope(p, p.accepted));
  // Confirm the rejection so it becomes terminal before the second request.
  await core.recoverPending();
  const second = await core.settle(envelope(p, p.accepted));
  eq(second.success, false, 'refused');
  ok(/new payload is required/.test(second.errorMessage), second.errorMessage);
});

// ═══ 7. HTTP surface behaviour ══════════════════════════════════════════

test('30. /settle over HTTP returns x402-shaped JSON', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const p = payloadFixture({ nowSec: REAL_NOW });
    const res = await fetch(`${f.url}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope(p, p.accepted)),
    });
    eq(res.status, 200, 'status');
    const body = await res.json();
    for (const field of ['success', 'transaction', 'network']) {
      ok(field in body, `has ${field}`);
    }
    eq(body.success, true, 'mock settle succeeds');
  } finally { await f.close(); }
});

test('31. malformed JSON and oversized bodies are refused', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const bad = await fetch(`${f.url}/verify`, { method: 'POST', body: 'not json' });
    eq(bad.status, 400, 'invalid JSON');

    const huge = await fetch(`${f.url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, pad: 'x'.repeat(300 * 1024) }),
    });
    ok(huge.status === 413 || huge.status === 400, `oversized body refused (${huge.status})`);
  } finally { await f.close(); }
});

test('32. an unknown route is 404, not a 500', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    eq((await fetch(`${f.url}/nope`)).status, 404, 'not found');
  } finally { await f.close(); }
});

// ═══ 8. store semantics in isolation ════════════════════════════════════

test('33. payload digests are stable and key-order independent', () => {
  const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
  const b = { nested: { x: 1, y: 2 }, a: 1, b: 2 };
  eq(payloadDigest(a), payloadDigest(b), 'canonicalised');
  notOk(payloadDigest({ a: 1 }) === payloadDigest({ a: 2 }), 'content-sensitive');
});

test('34. requirements keys distinguish recipient, amount, asset, network and resource', () => {
  const base = { payTo: PAY_TO, amount: '1', asset: 'CCD', network: CAIP2 };
  const k = requirementsKey(base, 'r1');
  notOk(k === requirementsKey({ ...base, amount: '2' }, 'r1'), 'amount matters');
  notOk(k === requirementsKey({ ...base, payTo: SENDER }, 'r1'), 'recipient matters');
  notOk(k === requirementsKey(base, 'r2'), 'resource matters');
});

test('35. replay entries expire, and expiry never produces success', () => {
  let t = 0;
  const store = new SettlementStore({ now: () => t, replayTtlMs: 1000, pendingTtlMs: 1000 });
  const d = 'digest';
  store.noteVerified(d, 'key');
  eq(store.entryFor(d) !== undefined, true, 'recorded');

  t = 2000; // past TTL
  // Sweeping happens on the mutating entry points, not on reads.
  store.noteVerified('another', 'key');
  eq(store.entryFor(d), undefined, 'swept');

  // A swept entry permits a fresh attempt — but an attempt is never a success by itself.
  const g = store.guardSettle('freshdigest', 'key');
  eq(g.ok, true, 'fresh digest may attempt');
  eq(g.replay, false, 'not a replay');
  eq(store.entryFor('freshdigest').state, 'settling', 'attempting, not settled');
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
console.log(`\nfacilitator: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
