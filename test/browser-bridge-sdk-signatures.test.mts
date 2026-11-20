/**
 * Browser bridge — REAL SDK signature verification (offline, deterministic keys).
 *
 * Exercises the bridge's DEFAULT verification path (no senderVerifier /
 * sponsorVerifier seams): @concordium/web-sdk 12.0.2 `Transaction.verifySignature`
 * against account credentials built from real Ed25519 keys. No node, no wallet,
 * no transaction.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { eq, ok } from './helpers.mjs';
import { Transaction } from '@concordium/web-sdk';
import { BrowserPaymentBridge } from '../services/facilitator/src/browserBridge.js';
import { SqliteBrowserPaymentStore } from '../services/facilitator/src/browserPaymentStore.js';
import { signingDigestOf } from '../services/facilitator/src/signingService.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const CERT = {} as never;

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { rawPub, privateKey };
}
const senderKey = ed25519();
const sponsorKey = ed25519();
const wrongKey = ed25519();

const requirements = { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } };

function signerWith(key: ReturnType<typeof ed25519>, address: string, network: string) {
  return {
    async sign(digest: ArrayBuffer) {
      return { 0: { 0: nodeSign(null, Buffer.from(digest), key.privateKey).toString('hex') } };
    },
    getSignatureCount() { return 1n; },
  };
}

function harness(opts: { senderInfo?: 'sender' | 'wrong' | 'threshold2'; sponsorInfo?: 'sponsor' | 'wrong'; chainStatus?: 'finalized' | 'unavailable' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-sdk-'));
  const store = new SqliteBrowserPaymentStore(join(dir, 'b.db'));
  const senderInfo = () => ({
    ...makeFakeAccountInfo({
      verifyKey: opts.senderInfo === 'wrong' ? wrongKey.rawPub : senderKey.rawPub,
      address: SENDER,
      threshold: opts.senderInfo === 'threshold2' ? 2 : 1,
    }),
    accountNonce: 14n,
  });
  const sponsorInfo = () => ({
    ...makeFakeAccountInfo({
      verifyKey: opts.sponsorInfo === 'wrong' ? wrongKey.rawPub : sponsorKey.rawPub,
      address: SPONSOR,
    }),
    accountNonce: 0n,
  });
  const bridge = new BrowserPaymentBridge({
    network: NETWORK, sponsorAddress: SPONSOR, maxEnergy: 1000n, maxFeeMicroCcd: '10000000', store,
    authorization: {
      authorize: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: CERT }),
      recover: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: CERT }),
    },
    signer: {
      info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }),
      addSponsorSignature: async (tx: unknown) => {
        const t = tx as Record<string, unknown>;
        const digest = signingDigestOf(t);
        const sig = nodeSign(null, Buffer.from(digest, 'hex'), sponsorKey.privateKey).toString('hex');
        return { ...t, signatures: { ...(t['signatures'] as object), sponsor: { 0: { 0: sig } } } };
      },
      submitTransaction: async () => { throw new Error('no submit'); },
      waitForFinalization: async () => { throw new Error('no submit'); },
    } as never,
    accountProvider: { getAccountInfo: async (address: string) => (address === SENDER ? senderInfo() : sponsorInfo()) },
    chain: { readTransfer: async () => (opts.chainStatus === 'unavailable' ? null : { status: 'finalized', sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, failed: false, blockHash: 'a3'.repeat(32), blockHeight: '50652456' } as never) },
    // NO senderVerifier / sponsorVerifier seams → the default SDK path runs.
    now: () => 1_800_000_000_000,
    paymentRefFactory: (() => { let i = 0; return () => `ref-${++i}`; })(),
  });
  return { bridge, store, rm: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function prepared(h = harness()) {
  const r = await h.bridge.prepare({ requirements, resourceUrl: 'http://127.0.0.1:4590/protected', sender: SENDER });
  if (!r.ok) throw new Error(`prepare failed: ${r.reason}`);
  return r;
}

/** Add a real sender signature with the sender key (as the wallet would). */
async function signSender(sponsored: unknown, key = senderKey): Promise<Record<string, unknown>> {
  const t = sponsored as Record<string, unknown>;
  const signable = Transaction.signableFromJSON(t);
  const signed = await Transaction.sign(signable, signerWith(key, SENDER, NETWORK));
  return Transaction.toJSON(signed) as unknown as Record<string, unknown>;
}

const confirm = (p: { paymentRef: string; requestId: string }, tx: unknown) =>
  ({ paymentRef: p.paymentRef, requestId: p.requestId, signedTransaction: tx as Record<string, unknown>, txHash: HASH });

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('01. valid sender + sponsor signatures verify with the real SDK', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, true, 'confirm ok'); if (c.ok) eq(c.state, 'finalized', 'finalized');
  } finally { h.rm(); }
});

test('02. adding the sender signature does not change the sponsor digest', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    eq(signingDigestOf(final), signingDigestOf(p.sponsoredTransaction), 'sponsor digest stable');
  } finally { h.rm(); }
});

test('03. tampered sender signature is invalid', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    (final['signatures'] as Record<string, unknown>)['sender'] = { 0: { 0: 'ff'.repeat(64) } };
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) ok(c.reason.includes('sender_signature_invalid'), 'reason');
  } finally { h.rm(); }
});

test('04. payload modified after signing fails the binding check', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    (final['payload'] as Record<string, unknown>)['amount'] = '2';
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'transaction_binding_mismatch', 'reason');
  } finally { h.rm(); }
});

test('05. wrong sender key (signature not from the claimed sender) is invalid', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction, wrongKey);
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) ok(c.reason.includes('sender_signature_invalid'), 'reason');
  } finally { h.rm(); }
});

test('06. wrong sponsor key (sponsor signature not from the fee payer) is invalid', async () => {
  const h = harness({ sponsorInfo: 'wrong' }); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'sponsor_signature_invalid', 'reason');
  } finally { h.rm(); }
});

test('07. insufficient account threshold is invalid (fail-closed)', async () => {
  const h = harness({ senderInfo: 'threshold2' }); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) ok(c.reason.includes('sender_signature_invalid'), 'reason');
  } finally { h.rm(); }
});

test('08. missing sponsor signature is rejected before any signature check', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    (final['signatures'] as Record<string, unknown>)['sponsor'] = {};
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) eq(c.reason, 'sponsor_signature_missing', 'reason');
  } finally { h.rm(); }
});

test('09. unknown key index in the sender signature is invalid', async () => {
  const h = harness(); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    const sig = (final['signatures'] as Record<string, Record<string, Record<string, string>>>)['sender'][0][0];
    (final['signatures'] as Record<string, unknown>)['sender'] = { 0: { 99: sig } };
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'refused'); if (!c.ok) ok(c.reason.includes('sender_signature_invalid'), 'reason');
  } finally { h.rm(); }
});

test('10. unavailable chain evidence keeps outcome_unknown despite valid signatures', async () => {
  const h = harness({ chainStatus: 'unavailable' }); try {
    const p = await prepared(h);
    const final = await signSender(p.sponsoredTransaction);
    const c = await h.bridge.confirm(confirm(p, final));
    eq(c.ok, false, 'not granted'); if (!c.ok) eq(c.reason, 'chain_evidence_unavailable', 'reason');
    eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'outcome_unknown', 'outcome_unknown');
  } finally { h.rm(); }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nbrowser-bridge-sdk-signatures: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
