/**
 * Browser x402 checkout flow (frontend, offline).
 *
 * Exercises the real orchestration contract against a mocked wallet and mocked
 * HTTP/facilitator. No real wallet API, no node, no transaction is touched.
 */
import { eq, ok, notOk } from './helpers.mjs';
import {
  parseChallenge, runCheckout, renderCheckout, checkoutStatus,
} from '../web/x402-checkout.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const TX = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';

const challengeBody = (over = {}) => ({
  x402Version: 2,
  error: 'X-PAYMENT header is required',
  resource: { url: 'https://agenttrust.test/protected' },
  accepts: [{ scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SENDER } }],
  ...over,
});

const jsonRes = (status, body) => ({ status, json: async () => body });
const ok402 = () => jsonRes(402, challengeBody());

const prepared = { ok: true, paymentRef: 'pref-1', requestId: 'req-1', sponsoredTransaction: { version: 1, header: { sender: SENDER, nonce: '14' }, payload: { type: 'transfer' } } };

function baseDeps(over = {}) {
  const calls = { prepare: 0, confirm: 0, submit: 0 };
  const signable = { __signable: true };
  const wallet = {
    connect: async () => ({ ok: true }),
    getAccount: async () => SENDER,
    getChain: async () => NETWORK,
    submit: async () => { calls.submit++; return { ok: true, txHash: TX, signedTransaction: { version: 1, header: { sender: SENDER } } }; },
  };
  const fetchImpl = async (url, init) => {
    if (url === '/prepare') { calls.prepare++; return jsonRes(200, prepared); }
    if (url === '/confirm') { calls.confirm++; return jsonRes(200, { ok: true, state: 'finalized', paymentRef: 'pref-1', txHash: TX, idempotent: false }); }
    throw new Error('unexpected url ' + url);
  };
  return {
    calls, wallet, fetchImpl, fetchResource: ok402, prepareUrl: '/prepare', confirmUrl: '/confirm',
    sdkFromJSON: () => signable, toJSON: (s) => s, now: () => 1_700_000_000,
    ...over,
  };
}

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. happy path 402 → prepare → wallet submit → confirm finalized', async () => {
  const deps = baseDeps();
  const states = [];
  const final = await runCheckout({ ...deps, onState: s => states.push(s) });
  eq(final.status, 'finalized', 'status');
  eq(deps.calls.prepare, 1, 'prepare once');
  eq(deps.calls.confirm, 1, 'confirm once');
  eq(deps.calls.submit, 1, 'wallet submit once');
  ok(states.some(s => s.stage === 'challenge'), 'challenge stage');
  ok(states.some(s => s.stage === 'submission'), 'submission stage');
  const html = renderCheckout(final);
  ok(html.includes('FINALIZED'), 'render finalized');
  ok(html.includes('VERIFIED'), 'render verified');
  ok(html.includes(TX), 'render tx hash');
});

test('02. wallet rejection → failed wallet_rejected', async () => {
  const deps = baseDeps({ wallet: { ...baseDeps().wallet, connect: async () => ({ ok: false, reason: 'rejected' }) } });
  const final = await runCheckout(deps);
  eq(final.status, 'failed', 'status');
  eq(final.reason, 'wallet_rejected', 'reason');
  eq(deps.calls.prepare, 0, 'no prepare');
});

test('03. account/network mismatch fails before prepare', async () => {
  for (const [account, chain] of [['bad-address', NETWORK], [SENDER, 'ccd:wrong']]) {
    const deps = baseDeps({ wallet: { ...baseDeps().wallet, getAccount: async () => account, getChain: async () => chain } });
    const final = await runCheckout(deps);
    eq(final.status, 'failed', 'status');
    ok(final.reason === 'invalid_wallet_account' || final.reason === 'wallet_network_mismatch', 'reason');
    eq(deps.calls.prepare, 0, 'no prepare');
  }
});

test('04. prepare authorization refusal and sponsor signing failure', async () => {
  for (const [body, reason] of [
    [{ ok: false, status: 403, reason: 'authorization_denied' }, 'authorization_refused'],
    [{ ok: false, status: 503, reason: 'sponsor_signing_failed' }, 'sponsor_signing_failed'],
  ]) {
    const deps = baseDeps();
    const fetchImpl = async (url) => url === '/prepare' ? jsonRes(200, body) : jsonRes(200, {});
    const final = await runCheckout({ ...deps, fetchImpl });
    eq(final.status, 'failed', 'status');
    eq(final.reason, reason, 'reason');
    eq(deps.calls.submit, 0, 'wallet never called');
  }
});

test('05. wallet submission timeout/ambiguous → outcome_unknown, NO retry', async () => {
  const deps = baseDeps();
  deps.wallet.submit = async () => { deps.calls.submit++; return { ok: false, reason: 'ambiguous', message: 'timeout' }; };
  const final = await runCheckout(deps);
  eq(final.status, 'outcome_unknown', 'status');
  eq(final.reason, 'wallet_submission_ambiguous', 'reason');
  eq(deps.calls.submit, 1, 'submit exactly once');
  eq(deps.calls.confirm, 0, 'no confirm after ambiguous');
});

test('06. real wallet returns hash only → outcome_unknown, no success claim', async () => {
  const deps = baseDeps();
  deps.wallet.submit = async () => { deps.calls.submit++; return { ok: true, txHash: TX }; };
  const final = await runCheckout(deps);
  eq(final.status, 'outcome_unknown', 'status');
  eq(final.reason, 'signed_transaction_unavailable', 'reason');
  eq(deps.calls.confirm, 0, 'no confirm');
});

test('07. confirm pending and finalized map correctly', async () => {
  const pendingDeps = baseDeps();
  const fetchImpl = async (url) => url === '/prepare' ? jsonRes(200, prepared) : jsonRes(200, { ok: true, state: 'pending_confirmation', paymentRef: 'pref-1', txHash: TX, idempotent: false });
  eq((await runCheckout({ ...pendingDeps, fetchImpl })).status, 'pending_confirmation', 'pending');
  const html = renderCheckout({ status: 'pending_confirmation', stage: 'settlement', txHash: TX });
  ok(html.includes('PENDING CONFIRMATION'), 'render pending');
  notOk(html.includes('VERIFIED'), 'no verified claim');
});

test('08. no UI finalized claim without backend evidence', () => {
  for (const s of [{ status: 'submitted', txHash: TX }, { status: 'failed', txHash: TX }, { status: 'outcome_unknown', txHash: TX }, { status: 'finalized', txHash: 'nope' }]) {
    const { verified } = checkoutStatus(s);
    notOk(verified, 'not verified for ' + s.status);
    notOk(renderCheckout(s).includes('VERIFIED'), 'no VERIFIED for ' + s.status);
  }
  eq(checkoutStatus({ status: 'finalized', txHash: TX }).verified, true, 'verified with evidence');
});

test('09. challenge validation fail-closed', () => {
  eq(parseChallenge({ ...challengeBody(), accepts: [{ ...challengeBody().accepts[0], amount: '0' }] }).reason, 'invalid_amount', 'zero amount');
  eq(parseChallenge({ ...challengeBody(), accepts: [{ ...challengeBody().accepts[0], network: 'ccd:wrong' }] }).reason, 'network_mismatch', 'network');
  eq(parseChallenge({ ...challengeBody(), validUntil: 1 }).reason, 'challenge_expired', 'expired');
  eq(parseChallenge(null).reason, 'invalid_challenge', 'null');
  ok(parseChallenge(challengeBody()).ok, 'valid');
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nx402-checkout-flow: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
