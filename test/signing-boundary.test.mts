/**
 * Signing-boundary regression tests (Task 10, protocol v2).
 *
 * Proves the digest ↔ transaction binding at the signing-service boundary:
 * the service recomputes the digest from the transaction it parses and validates
 * every field from the parsed form, so a request whose digest does not match
 * its transaction — or whose transaction violates the signing policy — is
 * rejected before any signing happens. Also proves the honest `simulated` flag:
 * mock/ledger signers declare simulated, the IPC signer declares real, and
 * FacilitatorCore propagates the signer's flag into its responses.
 *
 * In-process fake signer only. No real signing, no key material, no broadcast.
 *
 * Run: npx tsx test/signing-boundary.test.mts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { createSigningService, createFakeSigner, IpcAccountSigner, signingDigestOf, validateSigningRequest } from '../services/facilitator/src/signingService.js';
import type { SigningRequest } from '../services/facilitator/src/signingService.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { createMockSigner, createLedgerSigner } from '../services/facilitator/src/signer.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const OTHER = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_800_000_000; // fixed clock, seconds

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** Signable fixture transaction: sponsor pays the fee for a sender→recipient transfer. */
const fixtureTx = (over: Record<string, unknown> = {}) => {
  const tx = {
    version: 1,
    header: {
      sender: SENDER,
      nonce: 7,
      expiry: NOW + 200,
      executionEnergyAmount: 300,
      numSignatures: 1,
      sponsor: { account: SPONSOR, numSignatures: 1 },
    },
    payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
    signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
  };
  return { ...tx, ...over };
};

const makeService = (over: { maxEnergy?: bigint; maxFeeMicroCcd?: bigint } = {}) =>
  createSigningService({
    accountSigner: createFakeSigner({ signature: 'ff'.repeat(64) }),
    sponsorAddress: SPONSOR,
    network: NETWORK,
    allowedUid: 1001,
    now: () => NOW * 1000,
    ...over,
  });

const validReq = (tx: unknown, over: Partial<SigningRequest> = {}): SigningRequest => {
  // The digest defaults to the transaction's recompute — but only when the
  // caller does not supply one. A test that mutates the transaction AFTER
  // computing a valid digest must not recompute it here (it would throw).
  const { digest, ...rest } = over;
  return {
    protocolVersion: 2,
    requestId: crypto.randomUUID(),
    operation: 'sign',
    digest: digest ?? signingDigestOf(tx),
    transaction: tx,
    sponsor: SPONSOR,
    network: NETWORK,
    ...rest,
  };
};

// ── A. digest ↔ transaction binding ─────────────────────────────────────────

test('01. valid transaction signs (digest matches the transaction)', async () => {
  const svc = makeService();
  const res = await svc.sign(validReq(fixtureTx()));
  check('01. signed', res.outcome === 'signed', res.reason ?? '');
  eq(res.signature?.[0]?.[0], 'ff'.repeat(64), 'fake sig returned');
});

test('02. missing transaction → protocol_error missing_transaction', async () => {
  const svc = makeService();
  const req = validReq(fixtureTx()) as Record<string, unknown>;
  delete req['transaction'];
  const res = await svc.sign(req as unknown as SigningRequest);
  check('02. protocol_error', res.outcome === 'protocol_error', res.reason ?? '');
  eq(res.reason, 'missing_transaction', 'reason');
});

test('03. untrusted context field → malformed_request', async () => {
  const svc = makeService();
  const req = { ...validReq(fixtureTx()), context: { sender: SENDER, recipient: RECIPIENT } } as unknown as SigningRequest;
  const res = await svc.sign(req);
  check('03. protocol_error', res.outcome === 'protocol_error', res.reason ?? '');
  eq(res.reason, 'malformed_request', 'reason');
  const v = validateSigningRequest({ ...validReq(fixtureTx()), context: { sender: SENDER } });
  ok(!v.ok, 'validateSigningRequest rejects context');
});

test('04. digest does not match the transaction → digest_mismatch', async () => {
  const svc = makeService();
  const res = await svc.sign(validReq(fixtureTx(), { digest: 'b'.repeat(64) }));
  check('04. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'digest_mismatch', 'reason');
});

test('05. recipient malformed → rejected (fail closed)', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  // Digest of the VALID tx: the request itself is well-formed, the transaction is not.
  const digest = signingDigestOf(tx);
  (tx.payload as Record<string, unknown>)['toAddress'] = 'not-an-address';
  const res = await svc.sign(validReq(tx, { digest }));
  check('05. rejected', res.outcome === 'rejected', res.reason ?? '');
  // The SDK's parser rejects a malformed address before the service's own
  // recipient check runs, so the observable reason is invalid_transaction.
  // `recipient_malformed` stays in the service as defense-in-depth for a
  // parsed-but-invalid recipient.
  eq(res.reason, 'invalid_transaction', 'reason');
});

test('06. recipient equals sponsor → recipient_equals_sponsor', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  (tx.payload as Record<string, unknown>)['toAddress'] = SPONSOR;
  const res = await svc.sign(validReq(tx));
  check('06. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'recipient_equals_sponsor', 'reason');
});

test('07. amount zero → amount_invalid', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  (tx.payload as Record<string, unknown>)['amount'] = '0';
  const res = await svc.sign(validReq(tx));
  check('07. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'amount_invalid', 'reason');
});

test('08. amount missing → rejected (fail closed)', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  // Digest of the VALID tx: the request itself is well-formed, the transaction is not.
  const digest = signingDigestOf(tx);
  delete (tx.payload as Record<string, unknown>)['amount'];
  const res = await svc.sign(validReq(tx, { digest }));
  check('08. rejected', res.outcome === 'rejected', res.reason ?? '');
  // A transfer without an amount cannot be finalized for signing (the SDK's
  // energy computation needs the amount), so the observable reason is
  // invalid_transaction. `amount_missing` stays in the service as
  // defense-in-depth for a parsed-but-amountless payload.
  eq(res.reason, 'invalid_transaction', 'reason');
});

test('09. energy over cap → energy_exceeds_cap', async () => {
  // The fixture recomputes to ~635 NRG, above a 100 NRG cap.
  const svc = makeService({ maxEnergy: 100n });
  const res = await svc.sign(validReq(fixtureTx()));
  check('09. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'energy_exceeds_cap', 'reason');
});

test('10. fee over cap → fee_exceeds_cap', async () => {
  // Fee estimate is ~635 NRG × 8000 = 5,080,000 microCCD, above a 1,000,000 cap.
  const svc = makeService({ maxFeeMicroCcd: 1_000_000n });
  const res = await svc.sign(validReq(fixtureTx()));
  check('10. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'fee_exceeds_cap', 'reason');
});

test('11. expired transaction → transaction_expired', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  (tx.header as Record<string, unknown>)['expiry'] = NOW - 10;
  const res = await svc.sign(validReq(tx));
  check('11. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'transaction_expired', 'reason');
});

test('12. sender equals sponsor → sender_equals_sponsor', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  (tx.header as Record<string, unknown>)['sender'] = SPONSOR;
  const res = await svc.sign(validReq(tx));
  check('12. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'sender_equals_sponsor', 'reason');
});

test('13. transaction sponsor differs from configured → wrong_sponsor', async () => {
  const svc = makeService();
  const tx = fixtureTx();
  (tx.header as Record<string, unknown>)['sponsor'] = { account: OTHER, numSignatures: 1 };
  const res = await svc.sign(validReq(tx));
  check('13. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'wrong_sponsor', 'reason');
});

test('14. requestId reuse with different content → protocol_error request_id_reuse', async () => {
  const svc = makeService();
  const requestId = crypto.randomUUID();
  const tx1 = fixtureTx();
  const r1 = await svc.sign(validReq(tx1, { requestId }));
  check('14a. first request signed', r1.outcome === 'signed', r1.reason ?? '');
  const tx2 = fixtureTx();
  (tx2.header as Record<string, unknown>)['nonce'] = 8;
  const r2 = await svc.sign(validReq(tx2, { requestId }));
  check('14b. reuse rejected', r2.outcome === 'protocol_error', r2.reason ?? '');
  eq(r2.reason, 'request_id_reuse', 'reason');
});

test('15. replayed identical request returns the original result', async () => {
  const svc = makeService();
  const req = validReq(fixtureTx());
  const r1 = await svc.sign(req);
  const r2 = await svc.sign(req);
  check('15. both signed', r1.outcome === 'signed' && r2.outcome === 'signed', `${r1.outcome}/${r2.outcome}`);
  eq(r1.signature?.[0]?.[0], r2.signature?.[0]?.[0], 'same signature');
});

test('16. protocol v1 request → unsupported_protocol', async () => {
  const svc = makeService();
  const res = await svc.sign(validReq(fixtureTx(), { protocolVersion: 1 }));
  check('16. protocol_error', res.outcome === 'protocol_error', res.reason ?? '');
  eq(res.reason, 'unsupported_protocol', 'reason');
});

// ── B. client-side binding ──────────────────────────────────────────────────

test('17. client refuses a bare digest (no transaction bound)', async () => {
  const client = new IpcAccountSigner({
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs: 300,
  });
  let msg = '';
  try {
    await client.sign(digestHexToArrayBuffer(signingDigestOf(fixtureTx())));
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/no transaction bound/i.test(msg), `refused before any socket activity: "${msg}"`);
});

test('18. client refuses a digest that does not match the bound transaction', async () => {
  const client = new IpcAccountSigner({
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs: 300,
    transaction: fixtureTx(),
  });
  let msg = '';
  try {
    await client.sign(digestHexToArrayBuffer('11'.repeat(32)));
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/does not match the bound transaction/i.test(msg), `refused: "${msg}"`);
});

// ── C. honest simulated flag ────────────────────────────────────────────────

test('19. mock and ledger signers declare simulated: true', () => {
  const mock = createMockSigner({ network: NETWORK });
  eq(mock.simulated, true, 'mock declares simulated');
  const dir = mkdtempSync(join(tmpdir(), 't-boundary-'));
  try {
    const ledger = createLedgerSigner({ ledgerPath: join(dir, 'ledger.log'), network: NETWORK });
    eq(ledger.simulated, true, 'ledger (wraps the mock) declares simulated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('20. IPC signer declares simulated: false', () => {
  const ipc = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: NETWORK,
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 10_000_000n,
  });
  eq(ipc.simulated, false, 'IPC signer declares real');
});

test('21. core.verify with an IPC signer reports simulated: false', async () => {
  const ipc = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: NETWORK,
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 10_000_000n,
  });
  const core = new FacilitatorCore({ network: NETWORK, signer: ipc, now: () => NOW * 1000 });
  const res = await core.verify(envelopeFor(SPONSOR));
  eq(res.isValid, true, 'verify passes');
  eq((res as { extra?: { simulated?: boolean } }).extra?.simulated, false, 'extra.simulated is false for the real signer');
});

test('22. core.verify with a mock signer reports simulated: true', async () => {
  const mock = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const core = new FacilitatorCore({ network: NETWORK, signer: mock, now: () => NOW * 1000 });
  const res = await core.verify(envelopeFor(mock.info().address));
  eq(res.isValid, true, 'verify passes');
  eq((res as { extra?: { simulated?: boolean } }).extra?.simulated, true, 'extra.simulated is true for the mock signer');
});

test('23. IPC waitForFinalization reports simulated: false', async () => {
  const stubSubmitter = {
    submit: async () => ({ hash: 'a'.repeat(64) }),
    awaitFinalization: async () => ({ status: 'finalized' }),
  } as never;
  const ipc = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: NETWORK,
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    maxEnergy: 1000n,
    maxFeeMicroCcd: 10_000_000n,
    submitter: stubSubmitter,
  });
  const res = await ipc.waitForFinalization('a'.repeat(64));
  eq(res.status, 'finalized', 'finalized');
  eq(res.simulated, false, 'waitForFinalization declares real');
});

/** Minimal x402 envelope whose signed transaction pays RECIPIENT via `sponsor`. */
function envelopeFor(sponsor: string) {
  const requirements = {
    scheme: 'exact',
    network: NETWORK,
    asset: 'CCD',
    amount: '250000',
    payTo: RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { feePayer: sponsor },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: 'agenttrust://resource/1004' },
      accepted: requirements,
      payload: { signedTransaction: fixtureTx() },
    },
    paymentRequirements: requirements,
  };
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\nsigning-boundary: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
