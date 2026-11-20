/** Wallet Context signing protocol tests (offline, synthetic fixtures). */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { Transaction, buildBasicAccountSigner } from '@concordium/web-sdk';
import { eq, ok, notOk } from './helpers.mjs';
import { signPreparedTransaction, stableStringify, canonicalHeaderKey } from '../src/wallet/txSigning.js';
import { createWalletShell } from '../src/wallet/shell.js';
import { WALLET_PROTOCOL_VERSION } from '../src/wallet/protocol.js';
import { headerPayloadBinding, verifySignedTransaction } from '../poc/local-sponsored-signing/sign-local.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';

const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    rawPub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    rawPriv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
  };
}
const senderKey = ed25519(); const sponsorKey = ed25519();
const senderSigner = buildBasicAccountSigner(senderKey.rawPriv);
const sponsorSigner = buildBasicAccountSigner(sponsorKey.rawPriv);
const infos = (address: string) => {
  const key = address === SENDER ? senderKey : sponsorKey;
  return { ...makeFakeAccountInfo({ verifyKey: key.rawPub, address }), accountNonce: 14n };
};
const rawPrepared = {
  version: 1,
  header: { sender: SENDER, nonce: 14, expiry: 1_900_000_000, executionEnergyAmount: 300, numSignatures: 1, sponsor: { account: SPONSOR, numSignatures: 1 } },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '1' },
  signatures: { sender: {}, sponsor: {} },
};
const sponsored = await Transaction.sponsor(Transaction.signableFromJSON(rawPrepared as never), sponsorSigner);
const prepared = Transaction.toJSON(sponsored) as unknown as Record<string, unknown>;

const deps = (overrides: Partial<Parameters<typeof signPreparedTransaction>[1]> = {}) => ({
  status: () => ({ state: 'unlocked' as const }),
  getSigner: () => senderSigner,
  requestApproval: async () => true,
  ...overrides,
});

const tests: [string, () => Promise<void> | void][] = [];
const test = (n: string, fn: () => Promise<void> | void) => tests.push([n, fn]);

test('01. valid signature verifies against derived public key', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps());
  ok(r.ok, 'sign ok');
  if (!r.ok) return;
  const v = await verifySignedTransaction(r.signedTransaction, infos);
  eq(v.sender, true, 'sender signature valid');
  eq(v.sponsor, true, 'sponsor signature preserved');
  ok(headerPayloadBinding(prepared, r.signedTransaction), 'header/payload binding');
});

test('02. modified payload fails verification', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps());
  ok(r.ok, 'sign ok'); if (!r.ok) return;
  const tampered = structuredClone(r.signedTransaction) as Record<string, unknown>;
  const payload = tampered.payload as Record<string, unknown>;
  payload.amount = typeof payload.amount === 'bigint' ? 2n : 2;
  const v = await verifySignedTransaction(tampered, infos);
  eq(v.sender, false, 'tampered payload rejected');
});

test('03. wallet locked rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps({ status: () => ({ state: 'locked' }) }));
  ok(!r.ok && r.reason === 'wallet_locked', 'locked');
});

test('04. mainnet network mismatch rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'mainnet' as 'testnet', prepared }, deps());
  ok(!r.ok && r.reason === 'network_mismatch', 'network mismatch');
});

test('05. user rejection rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps({ requestApproval: async () => false }));
  ok(!r.ok && r.reason === 'user_rejected', 'rejected');
});

test('06. payload changed during approval rejected', async () => {
  const req = { protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet' as const, prepared };
  const r = await signPreparedTransaction(req, deps({
    requestApproval: async () => { (prepared.payload as Record<string, unknown>).amount = '777'; return true; },
  }));
  ok(!r.ok && r.reason === 'approval_payload_tampered', 'tamper detected');
  (prepared.payload as Record<string, unknown>).amount = '1';
});

test('07. malformed transaction rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared: { header: null, payload: null } }, deps());
  ok(!r.ok, 'malformed rejected');
});

test('08. missing sponsor signature rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared: rawPrepared }, deps());
  ok(!r.ok && r.reason === 'sponsor_signature_missing', 'sponsor required');
});

test('09. lock during approval rejects signing', async () => {
  let locked = false;
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps({
    status: () => ({ state: locked ? 'locked' : 'unlocked' }),
    requestApproval: async () => { locked = true; return true; },
  }));
  ok(!r.ok && r.reason === 'wallet_locked', 'lock during approval');
});

test('10. signer null after lock rejected', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps({ getSigner: () => null }));
  ok(!r.ok && r.reason === 'wallet_locked', 'signer unavailable');
});

// Shell protocol integration: origin/session/nonce/duplicate/replay.
function makeShell() {
  const sent: unknown[] = [];
  const origin = 'http://parent.test';
  let handler: (e: { origin: string; data: unknown }) => void = () => {};
  const shell = createWalletShell({
    allowedParentOrigins: [origin],
    transport: {
      postMessage: (m) => sent.push(m),
      addEventListener: (_t, h) => { handler = h as typeof handler; },
      randomNonce: () => 'n'.repeat(64), randomId: () => 's'.repeat(32), now: () => Date.now(),
    },
    vault: { lock: () => {}, status: () => ({ state: 'unlocked' }) },
    signing: { sign: async () => ({ ok: true, result: { signedTransaction: prepared } }), invalidate: () => {} },
  });
  return { shell, sent, handler, origin };
}
const req = (method: string, extra: Record<string, unknown> = {}) => ({
  version: WALLET_PROTOCOL_VERSION, type: 'request', id: 'a'.repeat(64), nonce: 'b'.repeat(64),
  method, sessionId: 'd'.repeat(64), payload: {}, ...extra,
});

test('11. wrong origin dropped', () => {
  const { handler, sent } = makeShell();
  handler({ origin: 'http://evil.test', data: req('wallet.signTransaction') });
  eq(sent.length, 0, 'no reply to unknown origin');
});

test('12. invalid session rejected', async () => {
  const { handler, sent } = makeShell();
  handler({ origin: 'http://parent.test', data: req('wallet.signTransaction', { sessionId: 'f'.repeat(64) }) });
  await new Promise(r => setTimeout(r, 20));
  ok(JSON.stringify(sent).includes('session_required'), 'session required: ' + JSON.stringify(sent).slice(0,120));
});

test('13. replay nonce and duplicate request id rejected', async () => {
  const { handler, sent } = makeShell();
  const r = req('wallet.signTransaction');
  handler({ origin: 'http://parent.test', data: r });
  handler({ origin: 'http://parent.test', data: { ...r, id: 'c'.repeat(64) } });
  handler({ origin: 'http://parent.test', data: { ...r, nonce: 'e'.repeat(64) } });
  await new Promise(r => setTimeout(r, 20));
  const blob = JSON.stringify(sent);
  ok(blob.includes('nonce_replayed'), 'nonce replay');
  ok(blob.includes('duplicate_request_id'), 'duplicate id');
});

test('14. response carries SDK-shaped signedTransaction only, no secrets', async () => {
  const r = await signPreparedTransaction({ protocolVersion: WALLET_PROTOCOL_VERSION, network: 'testnet', prepared }, deps());
  ok(r.ok, 'ok'); if (!r.ok) return;
  const blob = stableStringify(r);
  ok(blob.includes('signedTransaction'), 'signedTransaction present');
  ok(!blob.includes(senderKey.rawPriv), 'no private key');
  ok(!('signer' in r), 'no signer object');
  const sigs = (r.signedTransaction['signatures'] ?? {}) as Record<string, unknown>;
  ok(Object.keys(sigs['sender'] ?? {}).length > 0, 'sender sig');
  ok(Object.keys(sigs['sponsor'] ?? {}).length > 0, 'sponsor sig');
});

test('15. no network calls in signing module', () => {
  const src = readFileSync(new URL('../src/wallet/txSigning.ts', import.meta.url), 'utf8');
  ok(!/fetch\(|grpc|XMLHttpRequest|sendTransaction\(/i.test(src), 'no network');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, (e as Error).message); }
}
console.log(`wallet-signing-protocol: ${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
