/**
 * PoC: local sponsored signing → complete signedTransaction compatible with
 * /confirm. Offline only: generated TEST keys, no wallet, no node, no broadcast.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Transaction, buildBasicAccountSigner } from '@concordium/web-sdk';
import { eq, ok, notOk } from './helpers.mjs';
import {
  signPreparedSponsoredTransaction, headerPayloadBinding, verifySignedTransaction, stableStringify,
} from '../poc/local-sponsored-signing/sign-local.js';
import { BrowserPaymentBridge } from '../services/facilitator/src/browserBridge.js';
import { SqliteBrowserPaymentStore } from '../services/facilitator/src/browserPaymentStore.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const BLOCK = '387ae4ffed5ae328566efb30e379539cf3632714ed55564a60237420a49310a4';

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const rawPriv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  return { rawPub, rawPriv };
}
const senderKey = ed25519();
const sponsorKey = ed25519();
const wrongKey = ed25519();
const senderSigner = buildBasicAccountSigner(senderKey.rawPriv);
const sponsorSigner = buildBasicAccountSigner(sponsorKey.rawPriv);
const wrongSigner = buildBasicAccountSigner(wrongKey.rawPriv);

const accountInfoFor = (address: string, key: ReturnType<typeof ed25519>) => ({
  ...makeFakeAccountInfo({ verifyKey: key.rawPub, address }),
  accountNonce: 14n,
});
const infos = (senderPub = senderKey.rawPub, sponsorPub = sponsorKey.rawPub) => (address: string) => {
  if (address === SENDER) return accountInfoFor(SENDER, { ...senderKey, rawPub: senderPub });
  if (address === SPONSOR) return accountInfoFor(SPONSOR, { ...sponsorKey, rawPub: sponsorPub });
  throw new Error('unknown address');
};

const prepared = {
  version: 1,
  header: { sender: SENDER, nonce: 14, expiry: 1_900_000_000, executionEnergyAmount: 300, numSignatures: 1, sponsor: { account: SPONSOR, numSignatures: 1 } },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '1' },
  signatures: { sender: {}, sponsor: {} },
};

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. prepared sponsored + sender signer → complete signedTransaction', async () => {
  const r = await signPreparedSponsoredTransaction({ preparedSponsored: prepared, senderSigner, sponsorSigner });
  ok(Object.keys((r.signedTransaction.signatures as Record<string, unknown>).sender ?? {}).length > 0, 'sender sig present');
  ok(Object.keys((r.signedTransaction.signatures as Record<string, unknown>).sponsor ?? {}).length > 0, 'sponsor sig present');
  const v = await verifySignedTransaction(r.signedTransaction, infos());
  eq(v.sender, true, 'sender signature valid');
  eq(v.sponsor, true, 'sponsor signature valid');
  ok(headerPayloadBinding(prepared, r.signedTransaction), 'header/payload unchanged');
});

test('02. modified payload fails signature verification', async () => {
  const r = await signPreparedSponsoredTransaction({ preparedSponsored: prepared, senderSigner, sponsorSigner });
  const modified = structuredClone(r.signedTransaction);
  modified.payload.amount = '2';
  const v = await verifySignedTransaction(modified, infos());
  eq(v.sender, false, 'sender invalid after payload change');
  notOk(headerPayloadBinding(prepared, modified), 'binding detects change');
});

test('03. wrong sender / wrong sponsor / tampered signature rejected', async () => {
  const wrongSender = await signPreparedSponsoredTransaction({ preparedSponsored: prepared, senderSigner: wrongSigner, sponsorSigner });
  eq((await verifySignedTransaction(wrongSender.signedTransaction, infos())).sender, false, 'wrong sender');
  const wrongSponsor = await signPreparedSponsoredTransaction({ preparedSponsored: prepared, senderSigner, sponsorSigner: wrongSigner });
  eq((await verifySignedTransaction(wrongSponsor.signedTransaction, infos())).sponsor, false, 'wrong sponsor');
  const r = await signPreparedSponsoredTransaction({ preparedSponsored: prepared, senderSigner, sponsorSigner });
  const tampered = structuredClone(r.signedTransaction);
  tampered.signatures.sender['0']['0'] = '0'.repeat(128);
  eq((await verifySignedTransaction(tampered, infos())).sender, false, 'tampered sender sig');
});

test('04. module contains no network/broadcast path', () => {
  const src = readFileSync(new URL('../poc/local-sponsored-signing/sign-local.ts', import.meta.url), 'utf8');
  for (const needle of ['fetch(', 'grpc', 'sendTransaction(', 'http', 'node:net']) {
    notOk(src.includes(needle), 'no ' + needle);
  }
});

test('05. /confirm accepts PoC output without contract change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poc-confirm-'));
  try {
    const store = new SqliteBrowserPaymentStore(join(dir, 'b.db'));
    const bridge = new BrowserPaymentBridge({
      network: NETWORK, sponsorAddress: SPONSOR, maxEnergy: 10000n, maxFeeMicroCcd: '1000000',
      authorization: { authorize: async () => ({ outcome: 'approved', certificate: {} as never, reason: null }), probeDbIdentity: async () => ({ ok: true }) } as never,
      signer: {
        info: () => ({ address: SPONSOR }),
        canSign: () => true,
        addSponsorSignature: async (tx: unknown) => {
          const sponsored = await Transaction.sponsor(Transaction.signableFromJSON(tx) as never, sponsorSigner);
          return JSON.parse(JSON.stringify(Transaction.toJSON(sponsored), (_k, v) => typeof v === 'bigint' ? Number(v) : v));
        },
      } as never,
      store,
      chain: { readTransfer: async () => ({ status: 'finalized', sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, blockHash: BLOCK, failed: false }) },
      accountProvider: { getAccountInfo: async (address: string) => address === SENDER ? accountInfoFor(SENDER, senderKey) : address === SPONSOR ? accountInfoFor(SPONSOR, sponsorKey) : null },
      paymentRefFactory: () => 'f'.repeat(64),
      requestIdFactory: () => 'req-poc',
      now: () => 1_700_000_000_000,
    });
    const p = await bridge.prepare({ requirements: { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } }, resourceUrl: 'https://agenttrust.test/protected', sender: SENDER, requestId: 'req-poc' });
    ok(p.ok, 'prepare ok');
    if (!p.ok) return;
    const signed = await signPreparedSponsoredTransaction({ preparedSponsored: p.sponsoredTransaction, senderSigner });
    const c = await bridge.confirm({ paymentRef: p.paymentRef, requestId: p.requestId, signedTransaction: signed.signedTransaction, txHash: HASH });
    ok(c.ok, 'confirm ok');
    if (c.ok) eq(c.state, 'finalized', 'confirm finalized');
    const bad = structuredClone(signed.signedTransaction);
    bad.payload.amount = '2';
    const c2 = await bridge.confirm({ paymentRef: p.paymentRef, requestId: p.requestId, signedTransaction: bad, txHash: HASH });
    ok(c2.ok, 'same hash is idempotent after finalized');
    if (c2.ok) eq(c2.idempotent, true, 'idempotent flag');
    store.close();
    // Fresh payment: modified payload must be rejected by binding, not by idempotency.
    const store2 = new SqliteBrowserPaymentStore(join(dir, 'b2.db'));
    const bridge2 = new BrowserPaymentBridge({
      network: NETWORK, sponsorAddress: SPONSOR, maxEnergy: 10000n, maxFeeMicroCcd: '1000000',
      authorization: { authorize: async () => ({ outcome: 'approved', certificate: {} as never, reason: null }), probeDbIdentity: async () => ({ ok: true }) } as never,
      signer: {
        info: () => ({ address: SPONSOR }), canSign: () => true,
        addSponsorSignature: async (tx: unknown) => {
          const sponsored = await Transaction.sponsor(Transaction.signableFromJSON(tx) as never, sponsorSigner);
          return JSON.parse(JSON.stringify(Transaction.toJSON(sponsored), (_k, v) => typeof v === 'bigint' ? Number(v) : v));
        },
      } as never,
      store: store2,
      chain: { readTransfer: async () => ({ status: 'finalized', sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, blockHash: BLOCK, failed: false }) },
      accountProvider: { getAccountInfo: async (address: string) => address === SENDER ? accountInfoFor(SENDER, senderKey) : address === SPONSOR ? accountInfoFor(SPONSOR, sponsorKey) : null },
      paymentRefFactory: () => 'g'.repeat(64), requestIdFactory: () => 'req-poc2', now: () => 1_700_000_000_000,
    });
    const p2 = await bridge2.prepare({ requirements: { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } }, resourceUrl: 'https://agenttrust.test/protected', sender: SENDER, requestId: 'req-poc2' });
    ok(p2.ok, 'prepare2 ok');
    if (!p2.ok) return;
    const signed2 = await signPreparedSponsoredTransaction({ preparedSponsored: p2.sponsoredTransaction, senderSigner });
    const bad2 = structuredClone(signed2.signedTransaction);
    bad2.payload.amount = '2';
    const c3 = await bridge2.confirm({ paymentRef: p2.paymentRef, requestId: p2.requestId, signedTransaction: bad2, txHash: HASH });
    notOk(c3.ok, 'modified transaction rejected by /confirm');
    store2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nlocal-sponsored-signing: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
