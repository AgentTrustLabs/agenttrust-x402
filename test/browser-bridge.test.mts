/**
 * Browser bridge offline verification (no wallet, no node, no transaction).
 *
 * Every dependency is an injected fake. This file proves gate behaviour only:
 * it is NOT evidence of a Testnet settlement.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import { BrowserPaymentBridge } from '../services/facilitator/src/browserBridge.js';
import { SqliteBrowserPaymentStore } from '../services/facilitator/src/browserPaymentStore.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const OTHER_HASH = 'c1'.repeat(32);
const CERT = {} as never;

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT,
  maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR }, ...over,
});

function harness(over: {
  authOutcome?: 'approved' | 'rejected';
  signFails?: boolean;
  senderValid?: boolean;
  sponsorValid?: boolean;
  chainStatus?: 'finalized' | 'pending' | 'rejected' | 'unavailable';
  chainNull?: boolean;
  chainFields?: Record<string, unknown>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-bridge-'));
  const store = new SqliteBrowserPaymentStore(join(dir, 'b.db'));
  const calls = { auth: 0, sign: 0, chain: 0 };
  const chainSummary = {
    status: over.chainStatus ?? 'finalized',
    sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, failed: false,
    blockHash: 'a3'.repeat(32), blockHeight: '50652456', ...(over.chainFields ?? {}),
  };
  const bridge = new BrowserPaymentBridge({
    network: NETWORK,
    sponsorAddress: SPONSOR,
    maxEnergy: 1000n,
    maxFeeMicroCcd: '10000000',
    store,
    authorization: {
      authorize: async () => {
        calls.auth++;
        return over.authOutcome === 'rejected'
          ? { outcome: 'rejected' as const, reason: 'policy_refused', detail: null }
          : { outcome: 'approved' as const, reason: null, detail: null, certificate: CERT };
      },
      recover: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: CERT }),
    },
    signer: {
      info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }),
      addSponsorSignature: async (tx: unknown) => {
        calls.sign++;
        if (over.signFails) throw new Error('signing service unavailable');
        const t = tx as Record<string, unknown>;
        return { ...t, signatures: { ...(t['signatures'] as object), sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
      },
      submitTransaction: async () => { throw new Error('prepare/confirm must never submit'); },
      waitForFinalization: async () => { throw new Error('prepare/confirm must never submit'); },
    } as never,
    accountProvider: {
      getAccountInfo: async () => ({ accountNonce: 14n } as never),
    },
    chain: {
      readTransfer: async () => { calls.chain++; return over.chainNull ? null : chainSummary as never; },
    },
    senderVerifier: async () => over.senderValid === false ? { ok: false as const, reason: 'invalid_signature' } : { ok: true as const },
    sponsorVerifier: async () => over.sponsorValid !== false,
    now: () => 1_800_000_000_000,
    paymentRefFactory: (() => { let i = 0; return () => `ref-${++i}`; })(),
    requestIdFactory: (() => { let i = 0; return () => `req-${++i}`; })(),
  });
  return { bridge, store, calls, rm: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function prepared(h = harness(), req = requirements()) {
  return h.bridge.prepare({ requirements: req, resourceUrl: 'http://127.0.0.1:4590/protected', sender: SENDER });
}
function finalTx(sponsored: unknown): Record<string, unknown> {
  const t = sponsored as Record<string, unknown>;
  return { ...t, signatures: { ...(t['signatures'] as object), sender: { 0: { 0: 'cc'.repeat(32) } } } };
}
const confirmReq = (paymentRef: string, requestId: string, tx: unknown, hash = HASH) => ({
  paymentRef, requestId, signedTransaction: tx as Record<string, unknown>, txHash: hash,
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. valid prepare authorizes and sponsor-signs without submitting', async () => {
  const h = harness(); try {
    const r = await prepared(h);
    eq(r.ok, true, 'prepare ok');
    if (!r.ok) return;
    eq(h.calls.auth, 1, 'owner authorization called');
    eq(h.calls.sign, 1, 'sponsor signing called');
    eq(h.calls.chain, 0, 'no chain read at prepare');
    eq(h.store.getBrowserPayment(r.paymentRef)?.state, 'sponsor_signed', 'state sponsor_signed');
  } finally { h.rm(); }
});

test('02. invalid network is refused before authorization', async () => {
  const h = harness(); try {
    const r = await prepared(h, requirements({ network: 'ccd:wrong' }));
    eq(r.ok, false, 'refused'); if (!r.ok) eq(r.reason, 'network_mismatch', 'reason');
    eq(h.calls.auth, 0, 'owner not called');
  } finally { h.rm(); }
});

test('03. invalid amount is refused', async () => {
  const h = harness(); try {
    const r = await prepared(h, requirements({ amount: '0' }));
    eq(r.ok, false, 'refused'); if (!r.ok) eq(r.reason, 'invalid_amount', 'reason');
  } finally { h.rm(); }
});

test('04. invalid recipient is refused', async () => {
  const h = harness(); try {
    const r = await prepared(h, requirements({ payTo: 'not-an-address' }));
    eq(r.ok, false, 'refused'); if (!r.ok) eq(r.reason, 'invalid_recipient', 'reason');
  } finally { h.rm(); }
});

test('05. wrong sponsor is refused', async () => {
  const h = harness(); try {
    const r = await prepared(h, requirements({ extra: { feePayer: RECIPIENT } }));
    eq(r.ok, false, 'refused'); if (!r.ok) eq(r.reason, 'wrong_sponsor', 'reason');
    eq(h.calls.auth, 0, 'owner not called');
  } finally { h.rm(); }
});

test('06. expired / over-long window is refused', async () => {
  for (const t of [0, 601, -1]) {
    const h = harness(); try {
      const r = await prepared(h, requirements({ maxTimeoutSeconds: t }));
      eq(r.ok, false, `refused ${t}`);
    } finally { h.rm(); }
  }
});

test('07. owner authorization refusal never reaches sponsor signing', async () => {
  const h = harness({ authOutcome: 'rejected' }); try {
    const r = await prepared(h);
    eq(r.ok, false, 'refused'); if (!r.ok) ok(r.reason.startsWith('authorization_'), 'authorization reason');
    eq(h.calls.sign, 0, 'signer never called');
    const row = h.store.getBrowserPayment('ref-1');
    eq(row?.state, 'failed', 'state failed');
  } finally { h.rm(); }
});

test('08. sponsor signing failure fails closed', async () => {
  const h = harness({ signFails: true }); try {
    const r = await prepared(h);
    eq(r.ok, false, 'refused'); if (!r.ok) eq(r.reason, 'sponsor_signing_failed', 'reason');
    eq(h.store.getBrowserPayment('ref-1')?.state, 'failed', 'state failed');
  } finally { h.rm(); }
});

test('09. invalid sender signature blocks confirm', async () => {
  const h = harness({ senderValid: false }); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(c.ok, false, 'confirm refused'); if (!c.ok) ok(c.reason.includes('sender_signature_invalid'), 'reason');
    notOk(h.store.getBrowserPayment(p.paymentRef)?.state === 'finalized', 'not finalized');
  } finally { h.rm(); }
});

test('10. invalid sponsor signature blocks confirm', async () => {
  const h = harness({ sponsorValid: false }); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(c.ok, false, 'confirm refused'); if (!c.ok) eq(c.reason, 'sponsor_signature_invalid', 'reason');
  } finally { h.rm(); }
});

test('11. on-chain field mismatch blocks finality', async () => {
  const h = harness({ chainFields: { recipient: SPONSOR } }); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'chain_evidence_mismatch', 'reason');
    eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'failed', 'failed state');
  } finally { h.rm(); }
});

test('12. duplicate confirm with the same hash is idempotent', async () => {
  const h = harness(); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const req = confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction));
    const a = await h.bridge.confirm(req); eq(a.ok, true, 'first');
    const b = await h.bridge.confirm(req);
    eq(b.ok, true, 'second'); if (b.ok) eq(b.idempotent, true, 'idempotent flag');
    eq(h.calls.chain, 1, 'chain read only once');
  } finally { h.rm(); }
});

test('13. same paymentRef with a different hash is rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const first = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(first.ok, true, 'first confirm');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction), OTHER_HASH));
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'hash_mismatch_for_payment_ref', 'reason');
    eq(h.calls.chain, 1, 'no second chain read');
  } finally { h.rm(); }
});

test('14. replay / wrong requestId is rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm({ ...confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)), requestId: 'replayed' });
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'request_id_mismatch', 'reason');
  } finally { h.rm(); }
});

test('15. unavailable chain evidence → outcome_unknown, never finalized', async () => {
  const h = harness({ chainNull: true }); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(c.ok, false, 'not granted'); if (!c.ok) eq(c.reason, 'chain_evidence_unavailable', 'reason');
    eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'outcome_unknown', 'outcome_unknown');
  } finally { h.rm(); }
});

test('16. pending chain evidence → pending_confirmation, never finalized', async () => {
  const h = harness({ chainStatus: 'pending' }); try {
    const p = await prepared(h); if (!p.ok) throw new Error('prepare failed');
    const c = await h.bridge.confirm(confirmReq(p.paymentRef, p.requestId, finalTx(p.sponsoredTransaction)));
    eq(c.ok, true, 'ok'); if (c.ok) eq(c.state, 'pending_confirmation', 'state');
    eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'pending_confirmation', 'stored state');
  } finally { h.rm(); }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`); }
}
console.log(`\nbrowser-bridge: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
