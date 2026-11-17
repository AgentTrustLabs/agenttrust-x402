/**
 * Owner-authorization-binding regression tests .
 *
 * Proves the transaction-specific Owner authorization boundary:
 * - A valid Owner approval for the exact transaction signs, and the
 *   approval is consumed exactly once.
 * - Any change to the bound transaction (recipient, amount, sender,
 *   sponsor, network, digest) is rejected before signing.
 * - Expired and revoked approvals cannot be used.
 * - An approval cannot be reused, concurrently consumed, or replayed
 *   after a service restart.
 * - A database failure fails closed; reopening the database recovers.
 * - Forged approval evidence (wrong key, tampered field, missing
 *   signature, unknown id) never reaches the signing operation.
 *
 * Every rejection test uses a counting signer and asserts zero signer
 * invocations: a rejected authorization never reaches the signing
 * operation. The consume path is the REAL repository
 * (`makeTestOwner` → `repositoryConsumeClient`), not a stub — so
 * single-use, revocation and restart behavior here is the production
 * code path.
 *
 * In-process only. No real signing, no key material on disk beyond the
 * temp test dir, no broadcast.
 *
 * Run: npx tsx test/owner-authorization-binding.test.mts
 */

import { randomUUID } from 'node:crypto';
import { eq, ok } from './helpers.mjs';
import { createSigningService, signingDigestOf } from '../services/facilitator/src/signingService.js';
import type { SigningRequest } from '../services/facilitator/src/signingService.js';
import type { AccountSigner } from '@concordium/web-sdk';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { RepositorySettlementStateReader, SqliteOwnerAuthorizationRepository } from '../services/facilitator/src/ownerAuthorizationRepository.js';
import { repositoryConsumeClient, makeTestOwner, makeTestOwnerKey, issueTestCertificate, certFieldsForTx, recomputedEnergyOf } from './owner-authz-helper.mjs';
import type { TestOwner } from './owner-authz-helper.mjs';
import type { OwnerAuthorizationCertificate } from '../services/facilitator/src/ownerAuthorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const OTHER = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_800_000_000; // fixed clock, seconds
const PAYMENT_DIGEST = 'aa'.repeat(32);

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

/** Counting signer: proves whether the signing operation was reached. */
const makeCountingSigner = () => {
  let calls = 0;
  const signer: AccountSigner = {
    async sign(_digest: ArrayBuffer) {
      calls++;
      return { 0: { 0: 'ff'.repeat(64) } } as never;
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
  return { signer, calls: () => calls };
};

/** Authorization request for a fixture transaction (the facilitator's shape). */
const authReqFor = (tx: Record<string, unknown>, over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  paymentDigest: PAYMENT_DIGEST,
  network: NETWORK,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  asset: 'CCD',
  amount: '250000',
  expiry: NOW + 200,
  energy: recomputedEnergyOf(tx),
  transactionDigest: signingDigestOf(tx),
  transactionType: 'transfer',
  maxFeeMicroCcd: '10000000',
  ...over,
});

/** v3 signing request carrying a certificate. */
const signReq = (tx: unknown, cert: OwnerAuthorizationCertificate, over: Partial<SigningRequest> = {}): SigningRequest => ({
  protocolVersion: 3,
  requestId: randomUUID(),
  operation: 'sign',
  digest: signingDigestOf(tx),
  transaction: tx,
  sponsor: SPONSOR,
  network: NETWORK,
  authorization: cert,
  paymentDigest: PAYMENT_DIGEST,
  ...over,
});

interface Setup {
  owner: TestOwner;
  counting: ReturnType<typeof makeCountingSigner>;
  svc: ReturnType<typeof createSigningService>;
  /** Authorize `tx` (seeds the payment first) and return its certificate. */
  authorizeTx: (tx: Record<string, unknown>, over?: Partial<AuthorizationRequest>) => Promise<OwnerAuthorizationCertificate>;
  close: () => void;
}

const setup = (over: { serviceNow?: () => number; repoNow?: () => number } = {}): Setup => {
  let repoNowMs = NOW * 1000;
  const owner = makeTestOwner({
    sponsor: SPONSOR,
    network: NETWORK,
    now: over.repoNow ?? (() => repoNowMs),
  });
  const counting = makeCountingSigner();
  const svc = createSigningService({
    accountSigner: counting.signer,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    allowedUid: 1001,
    now: over.serviceNow ?? (() => NOW * 1000),
    ownerAuthorization: owner.ownerAuthorization,
  });
  const authorizeTx = async (tx: Record<string, unknown>, reqOver: Partial<AuthorizationRequest> = {}) => {
    owner.seedPayment(PAYMENT_DIGEST);
    const auth = await owner.authorization.authorize(authReqFor(tx, reqOver));
    ok(auth.outcome === 'approved', `authorize approved (${auth.outcome}/${auth.reason ?? '-'})`);
    ok(auth.certificate !== null && auth.certificate !== undefined, 'approval carries a certificate');
    return auth.certificate as OwnerAuthorizationCertificate;
  };
  return {
    owner,
    counting,
    svc,
    authorizeTx,
    close: () => owner.close(),
  };
};

// ── 1. valid approval ───────────────────────────────────────────────────────

test('01. valid Owner approval for the exact transaction signs and is consumed once', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const res = await s.svc.sign(signReq(tx, cert));
    check('01a. signed', res.outcome === 'signed', res.reason ?? '');
    eq(s.counting.calls(), 1, 'signer invoked exactly once');
    const row = s.owner.ownerRepo.authorizationById(cert.authorizationId);
    ok(row !== undefined && row.consumed_at !== null, 'approval is consumed in the durable record');
  } finally {
    s.close();
  }
});

// ── 2–6. bound-field changes ────────────────────────────────────────────────

test('02. changed recipient is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const otherTx = fixtureTx();
    (otherTx.payload as Record<string, unknown>)['toAddress'] = OTHER;
    const res = await s.svc.sign(signReq(otherTx, cert));
    check('02a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_mismatch', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

test('03. changed amount is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const otherTx = fixtureTx();
    (otherTx.payload as Record<string, unknown>)['amount'] = '250001';
    const res = await s.svc.sign(signReq(otherTx, cert));
    check('03a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_mismatch', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

test('04. changed sender or sponsor is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    // Changed sender: the certificate names the original sender.
    const senderTx = fixtureTx();
    (senderTx.header as Record<string, unknown>)['sender'] = OTHER;
    const r1 = await s.svc.sign(signReq(senderTx, cert));
    check('04a. changed sender rejected', r1.outcome === 'rejected', r1.reason ?? '');
    eq(r1.reason, 'authorization_mismatch', 'reason');
    // Changed sponsor: the transaction sponsor no longer matches the
    // service's configured sponsor — rejected at the binding check, still
    // before any signing.
    const sponsorTx = fixtureTx();
    (sponsorTx.header as Record<string, unknown>)['sponsor'] = { account: OTHER, numSignatures: 1 };
    const r2 = await s.svc.sign(signReq(sponsorTx, cert));
    check('04b. changed sponsor rejected', r2.outcome === 'rejected', r2.reason ?? '');
    eq(r2.reason, 'wrong_sponsor', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

test('05. changed network is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    // A service configured for another network must not accept a
    // certificate issued for this network.
    const otherNet = createSigningService({
      accountSigner: s.counting.signer,
      sponsorAddress: SPONSOR,
      network: 'eip155:1',
      allowedUid: 1001,
      now: () => NOW * 1000,
      ownerAuthorization: s.owner.ownerAuthorization,
    });
    const res = await otherNet.sign(signReq(tx, cert, { network: 'eip155:1' }));
    check('05a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_mismatch', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

test('06. changed transaction digest is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    // A different transaction (different nonce → different digest) cannot
    // ride on the first transaction's authorization.
    const otherTx = fixtureTx();
    (otherTx.header as Record<string, unknown>)['nonce'] = 8;
    const res = await s.svc.sign(signReq(otherTx, cert));
    check('06a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_mismatch', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

// ── 7–8. expired / revoked ──────────────────────────────────────────────────

test('07. expired authorization is rejected at consumption', async () => {
  // The service clock stays at NOW (the transaction is still alive), while
  // the Owner's clock advances past the authorization expiry — the consume
  // gate re-checks expiry and refuses.
  let repoNowMs = NOW * 1000;
  const s = setup({ repoNow: () => repoNowMs });
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    repoNowMs = (NOW + 300) * 1000; // past the NOW+200 expiry
    const res = await s.svc.sign(signReq(tx, cert));
    check('07a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_expired', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

test('08. revoked authorization is rejected before signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const revoked = s.owner.ownerRepo.revokeAuthorization(cert.authorizationId);
    ok(revoked.ok, 'revoke succeeds');
    const res = await s.svc.sign(signReq(tx, cert));
    check('08a. rejected', res.outcome === 'rejected', res.reason ?? '');
    eq(res.reason, 'authorization_revoked', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked');
  } finally {
    s.close();
  }
});

// ── 9–11. reuse / concurrency / restart ─────────────────────────────────────

test('09. authorization reuse is rejected (single use)', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const r1 = await s.svc.sign(signReq(tx, cert));
    check('09a. first sign succeeds', r1.outcome === 'signed', r1.reason ?? '');
    // A fresh requestId: the replay cache must not mask the reuse — the
    // consume gate itself has to refuse the second spend.
    const r2 = await s.svc.sign(signReq(tx, cert));
    check('09b. reuse rejected', r2.outcome === 'rejected', r2.reason ?? '');
    eq(r2.reason, 'authorization_already_consumed', 'reason');
    eq(s.counting.calls(), 1, 'signer invoked exactly once in total');
  } finally {
    s.close();
  }
});

test('10. concurrent consumption signs exactly once', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const n = 8;
    const results = await Promise.all(
      Array.from({ length: n }, () => s.svc.sign(signReq(tx, cert))),
    );
    const signed = results.filter((r) => r.outcome === 'signed').length;
    const refused = results.filter((r) => r.outcome === 'rejected' && r.reason === 'authorization_already_consumed').length;
    check('10a. exactly one signed', signed === 1, `signed=${signed}/${n}`);
    check('10b. the rest refused as already consumed', refused === n - 1, `refused=${refused}/${n}`);
    eq(s.counting.calls(), 1, 'signer invoked exactly once');
  } finally {
    s.close();
  }
});

test('11. replay after service restart is rejected (consumption survives restarts)', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    const r1 = await s.svc.sign(signReq(tx, cert));
    check('11a. first sign succeeds', r1.outcome === 'signed', r1.reason ?? '');
    // "Restart": a brand-new service instance with an empty replay map,
    // same Owner repository. The durable consumption must still refuse.
    const counting2 = makeCountingSigner();
    const svc2 = createSigningService({
      accountSigner: counting2.signer,
      sponsorAddress: SPONSOR,
      network: NETWORK,
      allowedUid: 1001,
      now: () => NOW * 1000,
      ownerAuthorization: s.owner.ownerAuthorization,
    });
    const r2 = await svc2.sign(signReq(tx, cert));
    check('11b. replay after restart rejected', r2.outcome === 'rejected', r2.reason ?? '');
    eq(r2.reason, 'authorization_already_consumed', 'reason');
    eq(counting2.calls(), 0, 'restarted service never signed');
    eq(s.counting.calls(), 1, 'original service signed exactly once');
  } finally {
    s.close();
  }
});

// ── 12. database failure and recovery ───────────────────────────────────────

test('12. database failure fails closed; reopening the database recovers', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    // The Owner database dies (closed repo): consumption throws, the
    // service fails closed as owner_unavailable, the signer never runs.
    s.owner.ownerRepo.close();
    const r1 = await s.svc.sign(signReq(tx, cert));
    check('12a. closed database fails closed', r1.outcome === 'owner_unavailable', `${r1.outcome}/${r1.reason ?? '-'}`);
    eq(s.counting.calls(), 0, 'signer never invoked while the database is down');
    // Recovery: reopen the SAME Owner-private database file. The
    // approval row survived (it was never consumed), so the same
    // certificate now signs. the consume client reads the
    // Owner repository, with the settlement repo only as a state reader.
    const repo2 = new SqliteSettlementRepository(s.owner.dbPath, { now: () => NOW * 1000 });
    const ownerRepo2 = new SqliteOwnerAuthorizationRepository(
      s.owner.ownerDbPath,
      new RepositorySettlementStateReader(repo2),
      { now: () => NOW * 1000 },
    );
    try {
      const counting2 = makeCountingSigner();
      const svc2 = createSigningService({
        accountSigner: counting2.signer,
        sponsorAddress: SPONSOR,
        network: NETWORK,
        allowedUid: 1001,
        now: () => NOW * 1000,
        ownerAuthorization: {
          publicKey: s.owner.authorization.authorizationPublicKeyHex(),
          consume: repositoryConsumeClient(ownerRepo2),
        },
      });
      const r2 = await svc2.sign(signReq(tx, cert));
      check('12b. reopened database signs', r2.outcome === 'signed', r2.reason ?? '');
      eq(counting2.calls(), 1, 'recovered service signed exactly once');
    } finally {
      try { ownerRepo2.close(); } catch { /* already closed */ }
      repo2.close();
    }
  } finally {
    s.close();
  }
});

// ── 13. forged approval evidence ────────────────────────────────────────────

test('13. forged approval evidence never reaches signing', async () => {
  const s = setup();
  try {
    const tx = fixtureTx();
    const cert = await s.authorizeTx(tx);
    // (a) Certificate signed with a DIFFERENT Owner key.
    const wrongKey = makeTestOwnerKey();
    const wrongKeyCert = issueTestCertificate(
      wrongKey.privateKey,
      certFieldsForTx(tx, {
        paymentDigest: PAYMENT_DIGEST,
        recipient: RECIPIENT,
        amount: '250000',
        network: NETWORK,
        authorizationId: cert.authorizationId,
        issuedAt: NOW * 1000,
      }),
    );
    const r1 = await s.svc.sign(signReq(tx, wrongKeyCert));
    check('13a. wrong-key certificate rejected', r1.outcome === 'rejected', r1.reason ?? '');
    eq(r1.reason, 'authorization_signature_invalid', 'reason');
    // (b) Tampered field: the amount was changed after the Owner signed.
    const tampered = { ...cert, amount: '999999' };
    const r2 = await s.svc.sign(signReq(tx, tampered));
    check('13b. tampered certificate rejected', r2.outcome === 'rejected', r2.reason ?? '');
    eq(r2.reason, 'authorization_signature_invalid', 'reason');
    // (c) Missing signature entirely.
    const { signature: _sig, ...unsigned } = cert;
    const r3 = await s.svc.sign(signReq(tx, unsigned as unknown as OwnerAuthorizationCertificate));
    check('13c. unsigned certificate rejected', r3.outcome === 'rejected', r3.reason ?? '');
    eq(r3.reason, 'authorization_invalid', 'reason');
    // (d) Direct consume with a forged (unknown) authorization id.
    const consumeRes = await s.owner.consume.consume({
      authorizationId: randomUUID(),
      transactionDigest: signingDigestOf(tx),
      context: {
        paymentDigest: PAYMENT_DIGEST,
        network: NETWORK,
        sender: SENDER,
        sponsor: SPONSOR,
        recipient: RECIPIENT,
        asset: 'CCD',
        amount: '250000',
        expiry: NOW + 200,
        energy: String(recomputedEnergyOf(tx)),
        transactionType: 'transfer',
        maxEnergy: '10000',
        maxFeeMicroCcd: '10000000',
      },
    });
    check('13d. unknown authorization id is not consumed', consumeRes.outcome === 'unknown', consumeRes.outcome);
    eq(consumeRes.reason, 'unknown_authorization', 'reason');
    eq(s.counting.calls(), 0, 'signer never invoked by any forgery');
  } finally {
    s.close();
  }
});

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
  console.log(`\nowner-authorization-binding: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
