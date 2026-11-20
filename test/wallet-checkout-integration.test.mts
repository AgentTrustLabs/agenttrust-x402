/** Website checkout + Wallet Context parent client integration (offline/mock). */
import { eq, ok, notOk } from './helpers.mjs';
import { createWalletParentClient } from '../src/wallet/parentClient.js';
import { parseResponse, WALLET_PROTOCOL_VERSION } from '../src/wallet/protocol.js';
import { runCheckout, checkoutStatus, renderCheckout } from '../web/x402-checkout.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const TX = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const SEED = 'ab'.repeat(64);
const PW = 'integration-password';

const challenge = () => ({
  x402Version: 2, error: 'payment required',
  resource: { url: 'https://agenttrust.test/protected' },
  accepts: [{ scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SENDER } }],
});
const jsonRes = (status, body) => ({ status, json: async () => body });
const preparedTx = { version: 1, header: { sender: SENDER, nonce: 14 }, payload: { type: 'transfer', toAddress: RECIPIENT, amount: '1' }, signatures: { sponsor: { 0: { 0: 'aa'.repeat(32) } }, sender: {} } };
const prepared = { ok: true, paymentRef: 'pref-1', requestId: 'req-1', sponsoredTransaction: preparedTx };

function attemptStore() {
  const keys = new Set();
  return { keys, has: (k) => keys.has(k), mark: (k) => keys.add(k) };
}
function checkoutDeps(over = {}) {
  const calls = { prepare: 0, confirm: 0, sign: 0, submit: 0 };
  const wallet = {
    connect: async () => ({ ok: true }),
    getAccount: async () => SENDER,
    getChain: async () => NETWORK,
    sign: async () => { calls.sign++; return { ok: true, signedTransaction: { ...preparedTx, signatures: { ...preparedTx.signatures, sender: { 0: { 0: 'bb'.repeat(32) } } } }, senderAddress: SENDER, credentialIndex: 0 }; },
    submit: async () => { calls.submit++; return { ok: true, txHash: TX }; },
  };
  const fetchImpl = async (url) => {
    if (url === '/prepare') { calls.prepare++; return jsonRes(200, prepared); }
    if (url === '/confirm') { calls.confirm++; return jsonRes(200, { ok: true, state: 'finalized', paymentRef: 'pref-1', txHash: TX, idempotent: false }); }
    throw new Error('unexpected url');
  };
  return {
    calls, wallet, fetchImpl, fetchResource: async () => jsonRes(402, challenge()),
    prepareUrl: '/prepare', confirmUrl: '/confirm', now: () => 1_700_000_000,
    attemptStore: attemptStore(), ...over,
  };
}

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

// parentClient.signTransaction with mocked Wallet Context transport
function parentClientMock(over = {}) {
  const sent = [];
  let mode = over.mode ?? 'ok';
  const transport = {
    postMessage: (m) => sent.push(m),
    addEventListener: (_t, h) => { transport._h = h; },
    randomNonce: () => 'a'.repeat(64), randomId: () => 'b'.repeat(64), now: () => Date.now(),
    setTimeout: (fn, ms) => { if (mode === 'timeout') { queueMicrotask(fn); } return 'timer'; },
    clearTimeout: () => {},
  };
  const client = createWalletParentClient({ walletOrigin: 'http://127.0.0.1:4591', parentOrigin: 'http://127.0.0.1:4590', transport, timeoutMs: 50 });
  const respond = (request, body) => transport._h({ origin: 'http://127.0.0.1:4591', data: { version: WALLET_PROTOCOL_VERSION, type: 'response', id: request.id, nonce: request.nonce, ok: body.ok, ...(body.ok ? { result: body.result } : { error: body.error }) } });
  return { client, sent, transport, respond };
}

test('01. parent client handshake + signTransaction valid response', async () => {
  const m = parentClientMock();
  const hp = m.client.handshake();
  respondHello(m, 'session-1');
  await hp;
  const sp = m.client.signTransaction(preparedTx);
  const req = m.sent.at(-1);
  m.respond(req, { ok: true, result: { signedTransaction: preparedTx, senderAddress: SENDER, credentialIndex: 0 } });
  const r = await sp;
  eq(r.ok, true, 'sign ok');
  eq(r.senderAddress, SENDER, 'sender');
  eq(req.method, 'wallet.signTransaction', 'method');
  eq(req.payload.network, 'testnet', 'network');
  const blob = JSON.stringify(m.sent);
  ok(!blob.includes(SEED) && !blob.includes(PW) && !blob.includes('privateKey'), 'no secrets in postMessage');
});
function respondHello(m, sessionId) {
  const req = m.sent.at(-1);
  m.respond(req, { ok: true, result: { state: 'unlocked', sessionId, methods: ['wallet.hello'] } });
}

test('02. parent client user rejection propagated', async () => {
  const m = parentClientMock();
  const hp = m.client.handshake(); respondHello(m, 'sess'); await hp;
  const sp = m.client.signTransaction(preparedTx);
  m.respond(m.sent.at(-1), { ok: false, error: 'user_rejected' });
  const r = await sp;
  ok(!r.ok && r.error === 'user_rejected', 'rejected');
});

test('03. parent client wallet_locked cancels session and pending', async () => {
  const m = parentClientMock();
  const hp = m.client.handshake(); respondHello(m, 'sess'); await hp;
  const sp = m.client.signTransaction(preparedTx);
  m.respond(m.sent.at(-1), { ok: false, error: 'wallet_locked' });
  const r = await sp;
  ok(!r.ok && r.error === 'wallet_locked', 'locked');
  const r2 = await m.client.signTransaction(preparedTx);
  ok(!r2.ok && r2.error === 'session_required', 'session invalidated');
});

test('04. parent client timeout mapped, no auto retry', async () => {
  const m = parentClientMock({ mode: 'timeout' });
  const hp = m.client.handshake(); respondHello(m, 'sess'); await hp;
  const r = await m.client.signTransaction(preparedTx);
  ok(!r.ok && r.error === 'signing_timeout', 'timeout');
  eq(m.sent.filter(s => s.method === 'wallet.signTransaction').length, 1, 'no retry');
});

test('06. checkout sign-only happy path: 402 → prepare → sign → submit → confirm finalized', async () => {
  const deps = checkoutDeps();
  const states = [];
  const final = await runCheckout({ ...deps, onState: s => states.push(s) });
  eq(final.status, 'finalized', 'status');
  eq(deps.calls.prepare, 1, 'prepare once');
  eq(deps.calls.sign, 1, 'sign once');
  eq(deps.calls.submit, 1, 'submit once');
  eq(deps.calls.confirm, 1, 'confirm once');
  ok(states.some(s => s.status === 'awaiting_approval'), 'awaiting_approval');
  ok(states.some(s => s.status === 'submitting'), 'submitting');
  ok(checkoutStatus(final).verified, 'evidence verified');
  ok(renderCheckout(final).includes(TX), 'tx hash rendered');
});

test('07. user rejection stops before submit/confirm', async () => {
  const deps = checkoutDeps({ wallet: { ...checkoutDeps().wallet, sign: async () => ({ ok: false, reason: 'user_rejected' }) } });
  const final = await runCheckout(deps);
  eq(final.status, 'failed', 'status');
  eq(final.reason, 'user_rejected', 'reason');
  eq(deps.calls.submit, 0, 'no submit');
  eq(deps.calls.confirm, 0, 'no confirm');
});

test('08. wallet locked stops flow', async () => {
  const deps = checkoutDeps({ wallet: { ...checkoutDeps().wallet, sign: async () => ({ ok: false, reason: 'wallet_locked' }) } });
  const final = await runCheckout(deps);
  eq(final.reason, 'wallet_locked', 'locked');
  eq(deps.calls.confirm, 0, 'no confirm');
});

test('09. prepare failure stops before signing', async () => {
  const deps = checkoutDeps({ fetchImpl: async (url) => url === '/prepare' ? jsonRes(400, { ok: false, reason: 'invalid_amount' }) : jsonRes(200, {}) });
  const final = await runCheckout(deps);
  eq(final.status, 'failed', 'status');
  eq(final.reason, 'invalid_amount', 'reason');
  eq(deps.calls.sign, 0, 'no sign');
});

test('10. signing failure stops before confirm', async () => {
  const deps = checkoutDeps({ wallet: { ...checkoutDeps().wallet, sign: async () => { throw new Error('signing_timeout'); } } });
  const final = await runCheckout(deps);
  eq(final.status, 'failed', 'status');
  eq(deps.calls.confirm, 0, 'no confirm');
});

test('11. confirm failure → failed, no retry', async () => {
  const deps = checkoutDeps();
  deps.fetchImpl = async (url) => {
    if (url === '/prepare') { deps.calls.prepare++; return jsonRes(200, prepared); }
    deps.calls.confirm++; return jsonRes(400, { ok: false, reason: 'sender_signature_invalid' });
  };
  const final = await runCheckout(deps);
  eq(final.status, 'failed', 'status');
  eq(deps.calls.confirm, 1, 'confirm once');
});

test('12. ambiguous submission → outcome_unknown, no retry', async () => {
  const deps = checkoutDeps();
  deps.wallet.submit = async () => { deps.calls.submit++; return { ok: false, reason: 'ambiguous' }; };
  const final = await runCheckout(deps);
  eq(final.status, 'outcome_unknown', 'status');
  eq(deps.calls.submit, 1, 'no retry');
  eq(deps.calls.confirm, 0, 'no confirm');
});

test('13. pending + outcome_unknown from confirm evidence', async () => {
  for (const [state, expected] of [['pending_confirmation', 'pending_confirmation'], ['something_else', 'outcome_unknown']]) {
    const deps = checkoutDeps({ fetchImpl: async (url) => url === '/prepare' ? jsonRes(200, prepared) : jsonRes(200, { ok: true, state, txHash: TX, paymentRef: 'pref-1' }) });
    const final = await runCheckout(deps);
    eq(final.status, expected, state);
    ok(!checkoutStatus(final).verified, 'not verified');
  }
});

test('14. refresh/reload does not resubmit', async () => {
  const deps = checkoutDeps();
  await runCheckout(deps);
  const final = await runCheckout(deps);
  eq(final.status, 'outcome_unknown', 'duplicate blocked');
  eq(final.reason, 'duplicate_submit', 'reason');
  eq(deps.calls.prepare, 1, 'prepare once');
  eq(deps.calls.submit, 1, 'submit once');
});

test('15. no secret in state/render/url', async () => {
  const deps = checkoutDeps();
  const final = await runCheckout(deps);
  const blob = JSON.stringify(final) + renderCheckout(final);
  ok(!blob.includes(SEED) && !blob.includes(PW) && !blob.includes('privateKey'), 'no secrets');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, (e as Error).message); }
}
console.log(`wallet-checkout-integration: ${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
