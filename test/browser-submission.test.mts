/** Browser submission handoff — mock transport, real signature verification. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { eq, ok } from './helpers.mjs';
import { Transaction } from '@concordium/web-sdk';
import { BrowserPaymentBridge } from '../services/facilitator/src/browserBridge.js';
import { SqliteBrowserPaymentStore } from '../services/facilitator/src/browserPaymentStore.js';
import { BrowserSubmissionService } from '../services/facilitator/src/browserSubmission.js';
import { SubmissionError } from '../services/facilitator/src/submissionErrors.js';
import { signingDigestOf } from '../services/facilitator/src/signingService.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const CERT = {} as never;
const REQUIREMENTS = { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } };

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { rawPub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
const senderKey = ed25519(); const sponsorKey = ed25519(); const wrongKey = ed25519();
function signerWith(key: ReturnType<typeof ed25519>) {
  return { async sign(digest: ArrayBuffer) { return { 0: { 0: nodeSign(null, Buffer.from(digest), key.privateKey).toString('hex') } }; }, getSignatureCount() { return 1n; } };
}
function accountInfo(key: ReturnType<typeof ed25519>, address: string) {
  return { ...makeFakeAccountInfo({ verifyKey: key.rawPub, address, threshold: 1 }), accountNonce: 14n };
}
function harness(opts: { chainStatus?: 'finalized' | 'unavailable'; submitMode?: 'ok' | 'reject' | 'timeout' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-sub-'));
  const dbPath = join(dir, 'b.db');
  const store = new SqliteBrowserPaymentStore(dbPath);
  const bridge = new BrowserPaymentBridge({
    network: NETWORK, sponsorAddress: SPONSOR, maxEnergy: 1000n, maxFeeMicroCcd: '10000000', store,
    authorization: { authorize: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: CERT }), recover: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: CERT }) },
    signer: {
      info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }),
      addSponsorSignature: async (tx: unknown) => {
        const t = tx as Record<string, unknown>;
        const sig = nodeSign(null, Buffer.from(signingDigestOf(t), 'hex'), sponsorKey.privateKey).toString('hex');
        return { ...t, signatures: { ...(t['signatures'] as object), sponsor: { 0: { 0: sig } } } };
      },
      submitTransaction: async () => { throw new Error('no submit'); },
      waitForFinalization: async () => { throw new Error('no submit'); },
    } as never,
    accountProvider: { getAccountInfo: async (address: string) => address === SENDER ? accountInfo(senderKey, SENDER) : accountInfo(sponsorKey, SPONSOR) },
    chain: { readTransfer: async () => opts.chainStatus === 'unavailable' ? null : { status: 'finalized', sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, failed: false, blockHash: 'a3'.repeat(32), blockHeight: '50652456' } as never },
    now: () => 1_800_000_000_000,
    paymentRefFactory: (() => { let i = 0; return () => (++i).toString(16).padStart(64, '0'); })(),
  });
  let calls = 0;
  const submitter = {
    async submit() {
      calls++;
      if (opts.submitMode === 'reject') throw new SubmissionError('validation', 'rejected by node');
      if (opts.submitMode === 'timeout') throw new SubmissionError('transport', 'timeout');
      return { hash: HASH, status: 'accepted' as const };
    },
    async getStatus() { return { status: 'finalized' as const, blockHash: 'a3'.repeat(32) }; },
  } as never;
  const service = new BrowserSubmissionService({
    store, submitter, accountProvider: { getAccountInfo: async (address: string) => address === SENDER ? accountInfo(senderKey, SENDER) : accountInfo(sponsorKey, SPONSOR) },
    network: NETWORK, maxEnergy: 1000n, maxFeeMicroCcd: 10_000_000n, now: () => 1_800_000_000_000,
  });
  return { store, bridge, service, calls: () => calls, dbPath, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function prepared(h = harness()) {
  const r = await h.bridge.prepare({ requirements: REQUIREMENTS, resourceUrl: 'https://api.example/protected', sender: SENDER });
  if (!r.ok) throw new Error('prepare failed: ' + r.reason);
  return r;
}
async function signSender(sponsored: unknown, key = senderKey) {
  const signed = await Transaction.sign(Transaction.signableFromJSON(sponsored as never), signerWith(key));
  return Transaction.toJSON(signed) as unknown as Record<string, unknown>;
}
const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (n: string, f: () => Promise<void> | void) => tests.push([n, f]);

test('01. valid submission returns txHash', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const r = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    if (!r.ok) console.log('DEBUG_SUBMIT', JSON.stringify(r));
    eq(r.ok, true, 'submit ok'); ok(r.ok && r.txHash === HASH, 'hash'); eq(h.calls(), 1, 'one broadcast');
  } finally { h.close(); }
});
test('02. sender signature invalid rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction, wrongKey);
    const r = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'sender_signature_invalid', 'sender invalid'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('03. sponsor signature invalid rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    (tx['signatures'] as Record<string, unknown>)['sponsor'] = { 0: { 0: '00'.repeat(32) } };
    const r = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'sponsor_signature_invalid', 'sponsor invalid'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('04. payment binding mismatch rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    (tx['payload'] as Record<string, unknown>)['amount'] = '2';
    const r = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'payment_binding_mismatch', 'binding mismatch'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('05. expired payment rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const svc = new BrowserSubmissionService({ store: h.store, submitter: { submit: async () => ({ hash: HASH, status: 'accepted' }), getStatus: async () => ({ status: 'finalized' }) } as never, accountProvider: { getAccountInfo: async (a: string) => a === SENDER ? accountInfo(senderKey, SENDER) : accountInfo(sponsorKey, SPONSOR) }, network: NETWORK, maxEnergy: 1000n, maxFeeMicroCcd: 10_000_000n, now: () => 2_000_000_000_000 });
    const r = await svc.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'payment_expired', 'expired'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('06. wrong network rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const svc = new BrowserSubmissionService({ store: h.store, submitter: { submit: async () => ({ hash: HASH, status: 'accepted' }), getStatus: async () => ({ status: 'finalized' }) } as never, accountProvider: { getAccountInfo: async () => accountInfo(senderKey, SENDER) }, network: 'ccd:wrong', maxEnergy: 1000n, maxFeeMicroCcd: 10_000_000n, now: () => 1_800_000_000_000 });
    const r = await svc.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'wrong_network', 'wrong network'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('07. duplicate paymentRef is idempotent', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const a = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    const b = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(a.ok && b.ok && b.idempotent && b.txHash === HASH, 'idempotent'); eq(h.calls(), 1, 'one broadcast');
  } finally { h.close(); }
});
test('08. RPC rejection is terminal validation', async () => {
  const h = harness({ submitMode: 'reject' }); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const r = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'submission_validation', 'validation error'); eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'failed', 'state failed');
  } finally { h.close(); }
});
test('09. RPC timeout then retry does not rebroadcast', async () => {
  const h = harness({ submitMode: 'timeout' }); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const a = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    const b = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!a.ok && a.reason === 'submission_transport', 'transport error');
    ok(!b.ok && b.reason === 'submission_outcome_unknown', 'retry refused');
    eq(h.calls(), 1, 'one broadcast attempt');
  } finally { h.close(); }
});
test('10. confirm failure is durable outcome_unknown', async () => {
  const h = harness({ chainStatus: 'unavailable' }); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const c = await h.bridge.confirm({ paymentRef: p.paymentRef, requestId: p.requestId, signedTransaction: tx, txHash: HASH });
    ok(!c.ok && c.reason === 'chain_evidence_unavailable', 'confirm failed');
    eq(h.store.getBrowserPayment(p.paymentRef)?.state, 'outcome_unknown', 'confirm state');
  } finally { h.close(); }
});
test('13. fee cap exceeded rejected', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const svc = new BrowserSubmissionService({ store: h.store, submitter: { submit: async () => ({ hash: HASH, status: 'accepted' }), getStatus: async () => ({ status: 'finalized' }) } as never, accountProvider: { getAccountInfo: async (a: string) => a === SENDER ? accountInfo(senderKey, SENDER) : accountInfo(sponsorKey, SPONSOR) }, network: NETWORK, maxEnergy: 1000n, maxFeeMicroCcd: 1n, now: () => 1_800_000_000_000 });
    const r = await svc.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    ok(!r.ok && r.reason === 'fee_exceeds_policy', 'fee cap'); eq(h.calls(), 0, 'no broadcast');
  } finally { h.close(); }
});
test('12. submitted then confirm is idempotent, no rebroadcast', async () => {
  const h = harness(); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    const s = await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    const c = await h.bridge.confirm({ paymentRef: p.paymentRef, requestId: p.requestId, signedTransaction: tx, txHash: HASH });
    ok(s.ok && c.ok && c.idempotent, 'confirm idempotent'); eq(h.calls(), 1, 'one broadcast');
  } finally { h.close(); }
});
test('11. durable claim survives store reopen', async () => {
  const h = harness({ submitMode: 'timeout' }); try {
    const p = await prepared(h); const tx = await signSender(p.sponsoredTransaction);
    await h.service.submit({ paymentRef: p.paymentRef, signedTransaction: tx });
    const reopened = new SqliteBrowserPaymentStore(h.dbPath);
    const row = reopened.getBrowserPayment(p.paymentRef);
    eq(row?.submission_claimed, 1, 'durable claim');
    reopened.close();
  } finally { h.close(); }
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name); pass++; }
  catch (e) { console.error('FAIL', name, e instanceof Error ? e.message : String(e)); }
}
console.log(`browser-submission: ${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
