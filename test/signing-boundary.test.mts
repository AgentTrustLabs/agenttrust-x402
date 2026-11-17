/**
 * Signing-boundary regression tests (protocol v3).
 *
 * Proves the digest ↔ transaction binding at the signing-service boundary:
 * the service recomputes the digest from the transaction it parses and validates
 * every field from the parsed form, so a request whose digest does not match
 * its transaction — or whose transaction violates the signing policy — is
 * rejected before any signing happens. Also proves the honest `simulated` flag:
 * mock/ledger signers declare simulated, the IPC signer declares real, and
 * FacilitatorCore propagates the signer's flag into its responses.
 *
 * Additional coverage:
 * - §D: TransferWithMemo gets the SAME recipient + amount validation as
 *   Transfer (both are the SDK-parseable transfer family); unsupported
 *   transfer-family kinds are rejected at parse time, never silently accepted.
 * - §E: the fee cap is an ESTIMATE-based policy (Option B): the estimate basis
 *   is pinned behaviorally, and the code documents that it is not a guaranteed
 *   maximum actual chain fee.
 * - §F: requestId replay handling is concurrency-safe — a reservation is made
 *   synchronously before any async signing, so two simultaneous identical
 *   requests sign exactly once, a same-ID different-content duplicate is
 *   rejected, and retries (after success or after failure) are deterministic.
 *   Concurrency is asserted with a gated signer + invocation counts, not sleeps.
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
import type { AccountSigner } from '@concordium/web-sdk';
import { ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG } from '../services/facilitator/src/energy.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { createMockSigner, createLedgerSigner } from '../services/facilitator/src/signer.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';
import { makeTestOwnerKey, issueTestCertificate, certFieldsForTx, fakeConsumedClient } from './owner-authz-helper.mjs';
import type { OwnerAuthorizationFields } from '../services/facilitator/src/ownerAuthorization.js';
import { randomUUID } from 'node:crypto';

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

const makeService = (over: { maxEnergy?: bigint; maxFeeMicroCcd?: bigint; signer?: AccountSigner } = {}) =>
  createSigningService({
    accountSigner: over.signer ?? createFakeSigner({ signature: 'ff'.repeat(64) }),
    sponsorAddress: SPONSOR,
    network: NETWORK,
    allowedUid: 1001,
    now: () => NOW * 1000,
    // the service cannot sign without Owner authorization evidence.
    // Tests carry a certificate issued by an ephemeral test keypair, and a
    // consume client that always reports 'consumed' — the consume semantics
    // themselves are covered by the owner-authorization-binding suite.
    ownerAuthorization: { publicKey: ownerKey.publicKeyHex, consume: fakeConsumedClient() },
    ...(over.maxEnergy !== undefined ? { maxEnergy: over.maxEnergy } : {}),
    ...(over.maxFeeMicroCcd !== undefined ? { maxFeeMicroCcd: over.maxFeeMicroCcd } : {}),
  });

/** One payment digest for the whole suite; the certificate binds to it. */
const PAYMENT_DIGEST = 'ab'.repeat(32);
/** Ephemeral Owner keypair for this suite's certificates. */
const ownerKey = makeTestOwnerKey();

/** TransferWithMemo fixture: same sender/sponsor/recipient/amount as `fixtureTx`, plus a memo. */
const memoTx = (over: Record<string, unknown> = {}) => {
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
    // Memo 'hello' as DataBlob JSON: word16 length prefix (0005) + utf8 hex.
    payload: { type: 'transferWithMemo', toAddress: RECIPIENT, amount: '250000', memo: '000568656c6c6f' },
    signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
  };
  return { ...tx, ...over };
};

/**
 * Controllable signer for concurrency tests: `sign()` blocks on a manual gate
 * and counts invocations, so a test can assert "exactly one invocation while
 * both requests are in flight" without any sleep or timing assumption.
 */
const makeGateSigner = () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signer: AccountSigner = {
    async sign(_digest: ArrayBuffer) {
      calls++;
      await gate;
      return { 0: { 0: 'ff'.repeat(64) } } as never;
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
  return { signer, calls: () => calls, release };
};

/** Signer that always throws, counting invocations (failure-retry test). */
const makeThrowingSigner = () => {
  let calls = 0;
  const signer: AccountSigner = {
    async sign(_digest: ArrayBuffer) {
      calls++;
      throw new Error('boom: signer refused');
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
  return { signer, calls: () => calls };
};

const validReq = (tx: unknown, over: Partial<SigningRequest> = {}): SigningRequest => {
  // The digest defaults to the transaction's recompute — but only when the
  // caller does not supply one. A test that mutates the transaction AFTER
  // computing a valid digest must not recompute it here (it would throw).
  const { digest, authorization, paymentDigest, ...rest } = over;
  // Protocol v3: every request carries an Owner authorization
  // certificate for the exact transaction it asks to sign. The certificate
  // is built from the transaction AS GIVEN, so a test that mutates the
  // transaction (bad recipient, zero amount) still carries a matching
  // certificate and the failure surfaces at the intended tx check, not at
  // the authorization check. An unparseable transaction gets a structurally
  // valid dummy certificate: the service rejects it at the binding check
  // before the certificate is examined.
  const txRec = tx as Record<string, unknown>;
  const payload = (txRec['payload'] ?? {}) as Record<string, unknown>;
  const header = (txRec['header'] ?? {}) as Record<string, unknown>;
  let fields: OwnerAuthorizationFields;
  try {
    fields = certFieldsForTx(txRec, {
      paymentDigest: paymentDigest ?? PAYMENT_DIGEST,
      recipient: String(payload['toAddress'] ?? RECIPIENT),
      amount: String(payload['amount'] ?? '250000'),
      network: NETWORK,
      issuedAt: NOW * 1000,
    });
  } catch {
    fields = {
      version: 1,
      authorizationId: randomUUID(),
      paymentDigest: paymentDigest ?? PAYMENT_DIGEST,
      transactionDigest: '00'.repeat(32),
      transactionType: String(payload['type'] ?? 'transfer'),
      network: NETWORK,
      sender: String(header['sender'] ?? SENDER),
      sponsor: SPONSOR,
      recipient: String(payload['toAddress'] ?? RECIPIENT),
      asset: 'CCD',
      amount: String(payload['amount'] ?? '250000'),
      expiry: Number(header['expiry'] ?? NOW + 200),
      energy: '635',
      maxEnergy: '10000',
      maxFeeMicroCcd: '10000000',
      policyVersion: 'test-v1',
      issuedAt: NOW * 1000,
    };
  }
  return {
    protocolVersion: 3,
    requestId: crypto.randomUUID(),
    operation: 'sign',
    digest: digest ?? signingDigestOf(tx),
    transaction: tx,
    sponsor: SPONSOR,
    network: NETWORK,
    authorization: authorization ?? issueTestCertificate(ownerKey.privateKey, fields),
    paymentDigest: paymentDigest ?? PAYMENT_DIGEST,
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
  const tx = fixtureTx();
  const client = new IpcAccountSigner({
    socketPath: '/tmp/does-not-exist.sock',
    expectedUid: 1001,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs: 300,
    transaction: tx,
    // the authorization guard runs before the digest check, so a
    // valid certificate is needed to reach the digest binding.
    authorization: issueTestCertificate(ownerKey.privateKey, certFieldsForTx(tx, {
      paymentDigest: PAYMENT_DIGEST,
      recipient: RECIPIENT,
      amount: '250000',
      network: NETWORK,
      issuedAt: NOW * 1000,
    })),
    paymentDigest: PAYMENT_DIGEST,
  });
  let msg = '';
  try {
    await client.sign(digestHexToArrayBuffer('11'.repeat(32)));
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/does not match the bound transaction/i.test(msg), `refused: "${msg}"`);
});

test('18b. client refuses without Owner authorization ', async () => {
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
    await client.sign(digestHexToArrayBuffer(signingDigestOf(fixtureTx())));
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/no Owner authorization bound/i.test(msg), `refused before any socket activity: "${msg}"`);
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

// ── D. TransferWithMemo — same validation as Transfer  ───────

test('24. valid TransferWithMemo signs (digest matches the transaction)', async () => {
  const svc = makeService();
  const res = await svc.sign(validReq(memoTx()));
  check('24. signed', res.outcome === 'signed', res.reason ?? '');
  eq(res.signature?.[0]?.[0], 'ff'.repeat(64), 'fake sig returned');
});

test('25. TransferWithMemo recipient equals sponsor → recipient_equals_sponsor', async () => {
  const svc = makeService();
  const tx = memoTx();
  (tx.payload as Record<string, unknown>)['toAddress'] = SPONSOR;
  const res = await svc.sign(validReq(tx));
  check('25. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'recipient_equals_sponsor', 'reason');
});

test('26. TransferWithMemo recipient malformed → rejected (fail closed)', async () => {
  const svc = makeService();
  const tx = memoTx();
  // Digest of the VALID tx: the request itself is well-formed, the transaction is not.
  const digest = signingDigestOf(tx);
  (tx.payload as Record<string, unknown>)['toAddress'] = 'not-an-address';
  const res = await svc.sign(validReq(tx, { digest }));
  check('26. rejected', res.outcome === 'rejected', res.reason ?? '');
  // The SDK's parser rejects a malformed address before the service's own
  // recipient check runs, so the observable reason is invalid_transaction.
  eq(res.reason, 'invalid_transaction', 'reason');
});

test('27. TransferWithMemo recipient missing → rejected (fail closed)', async () => {
  const svc = makeService();
  const tx = memoTx();
  const digest = signingDigestOf(tx);
  delete (tx.payload as Record<string, unknown>)['toAddress'];
  const res = await svc.sign(validReq(tx, { digest }));
  check('27. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'invalid_transaction', 'reason');
});

test('28. TransferWithMemo amount zero → amount_invalid', async () => {
  const svc = makeService();
  const tx = memoTx();
  (tx.payload as Record<string, unknown>)['amount'] = '0';
  const res = await svc.sign(validReq(tx));
  check('28. rejected', res.outcome === 'rejected', res.reason ?? '');
  eq(res.reason, 'amount_invalid', 'reason');
});

test('29. TransferWithMemo invalid amount → rejected (fail closed)', async () => {
  const svc = makeService();
  const tx = memoTx();
  const digest = signingDigestOf(tx);
  (tx.payload as Record<string, unknown>)['amount'] = 'abc';
  const res = await svc.sign(validReq(tx, { digest }));
  check('29. rejected', res.outcome === 'rejected', res.reason ?? '');
  // An unparseable amount fails SDK parsing before the service's amount check.
  eq(res.reason, 'invalid_transaction', 'reason');
});

test('30. unsupported transfer-family payload → rejected, never silently accepted', async () => {
  const svc = makeService();
  // The SDK's Payload.fromJSON has no case for these kinds, so signableFromJSON
  // throws and the service rejects as invalid_transaction — for BOTH variants.
  for (const kind of ['transferWithSchedule', 'encryptedAmountTransfer']) {
    const tx = memoTx();
    const digest = signingDigestOf(tx);
    (tx.payload as Record<string, unknown>)['type'] = kind;
    const res = await svc.sign(validReq(tx, { digest }));
    check(`30. ${kind} rejected`, res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'invalid_transaction', 'reason');
  }
});

// ── E. fee cap is an ESTIMATE-based policy  ─────────

test('31. fee estimate basis is pinned: 635 NRG x 8000 microCCD/NRG = 5,080,000', async () => {
  // The estimate rate is a fixed, documented ESTIMATE (see energy.ts), not a
  // guaranteed maximum actual fee. This test pins the estimate arithmetic so a
  // silent rate change cannot move the policy boundary.
  eq(ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG, 8000n, 'estimate rate');
  const atCap = makeService({ maxFeeMicroCcd: 5_080_000n });
  const r1 = await atCap.sign(validReq(fixtureTx()));
  check('31a. estimate exactly at cap signs', r1.outcome === 'signed', r1.reason ?? '');
  const belowCap = makeService({ maxFeeMicroCcd: 5_079_999n });
  const r2 = await belowCap.sign(validReq(fixtureTx()));
  check('31b. estimate one microCCD over cap rejects', r2.outcome === 'rejected', r2.reason ?? '');
  eq(r2.reason, 'fee_exceeds_cap', 'reason');
  // The rejection detail must say "estimated fee" — the service must never
  // present the estimate as the actual chain fee.
  ok((r2.detail ?? '').startsWith('estimated fee '), `detail names the estimate: "${r2.detail ?? ''}"`);
});

// ── F. requestId replay is concurrency-safe  ──────────────────

test('32. two simultaneous identical requests → exactly one signer invocation', async () => {
  const gate = makeGateSigner();
  const svc = makeService({ signer: gate.signer });
  const req = validReq(fixtureTx(), { requestId: 'conc-32' });
  const p1 = svc.sign(req);
  // Same requestId + same content, fresh object: the fingerprint is content-based.
  const p2 = svc.sign({ ...req });
  // the consume step awaits the Owner before signing, so the signer
  // invocation happens one microtask hop after the calls — flush the queue
  // before asserting. The gate is never released here, so no signer call
  // can complete; the assertion stays deterministic.
  await Promise.resolve();
  await Promise.resolve();
  // Both in flight, signer still gated: exactly one invocation, deterministically.
  eq(gate.calls(), 1, 'one signer invocation while both in flight');
  gate.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  check('32. both signed', r1.outcome === 'signed' && r2.outcome === 'signed', `${r1.outcome}/${r2.outcome}`);
  eq(gate.calls(), 1, 'still one invocation after completion');
  eq(r1.signature?.[0]?.[0], r2.signature?.[0]?.[0], 'same signature');
});

test('33. two simultaneous requests, same ID but different transaction → one proceeds, one rejected', async () => {
  const gate = makeGateSigner();
  const svc = makeService({ signer: gate.signer });
  const tx1 = fixtureTx();
  const tx2 = fixtureTx();
  (tx2.header as Record<string, unknown>)['nonce'] = 8;
  const p1 = svc.sign(validReq(tx1, { requestId: 'conc-33' }));
  const p2 = svc.sign(validReq(tx2, { requestId: 'conc-33' }));
  // the consume step awaits the Owner before signing — flush the
  // microtask queue before asserting (see test 32).
  await Promise.resolve();
  await Promise.resolve();
  // The second request sees the in-flight reservation with a different
  // fingerprint and is rejected immediately — it never waits for the signer.
  eq(gate.calls(), 1, 'one signer invocation while both in flight');
  gate.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  check('33a. first request signed', r1.outcome === 'signed', r1.reason ?? '');
  check('33b. second request rejected', r2.outcome === 'protocol_error', r2.reason ?? '');
  eq(r2.reason, 'request_id_reuse', 'reason');
  eq(gate.calls(), 1, 'still one invocation after completion');
});

test('34. retry after completed signing → original result, no second signing', async () => {
  const gate = makeGateSigner();
  const svc = makeService({ signer: gate.signer });
  const req = validReq(fixtureTx(), { requestId: 'conc-34' });
  const p1 = svc.sign(req);
  gate.release();
  const r1 = await p1;
  check('34a. first request signed', r1.outcome === 'signed', r1.reason ?? '');
  const r2 = await svc.sign({ ...req });
  check('34b. retry signed with original result', r2.outcome === 'signed', r2.reason ?? '');
  eq(r1.signature?.[0]?.[0], r2.signature?.[0]?.[0], 'same signature');
  eq(gate.calls(), 1, 'no second signer invocation on retry');
});

test('35. retry after signer failure → deterministic cached rejection, no second signing', async () => {
  const throwing = makeThrowingSigner();
  const svc = makeService({ signer: throwing.signer });
  const req = validReq(fixtureTx(), { requestId: 'conc-35' });
  const r1 = await svc.sign(req);
  check('35a. first request rejected', r1.outcome === 'rejected', r1.reason ?? '');
  eq(r1.reason, 'signer_error', 'reason');
  const r2 = await svc.sign({ ...req });
  check('35b. retry returns the same rejection', r2.outcome === 'rejected', r2.reason ?? '');
  eq(r2.reason, 'signer_error', 'reason');
  eq(r2.detail, r1.detail, 'same failure detail');
  eq(throwing.calls(), 1, 'no second signer invocation on retry');
  // Documented behavior: a failure is cached like any other outcome, so the
  // retry is deterministic. A fresh signing attempt needs a fresh requestId.
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
