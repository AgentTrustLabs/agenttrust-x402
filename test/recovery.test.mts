/**
 * Durable authorization recovery semantics.
 *
 * Proves the owner-mediated recovery operation:
 *   - verifies a matching durable approval against the canonical context,
 *   - never returns approved for a different digest/context,
 *   - never creates, modifies, or deletes an authorization record,
 *   - and that the settlement boundary recovers exactly one signer invocation.
 *
 * Run: npx tsx test/recovery.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from './owner-authz-helper.mts';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const OTHER_SPONSOR = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NOW = 1_800_000_000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't3413-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const policy = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v3413',
};

const request = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  paymentDigest: 'a'.repeat(64),
  network: CAIP2,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: PAY_TO,
  asset: 'CCD',
  amount: '250000',
  expiry: NOW + 200,
  energy: 700n,
  // the authorization binds the exact transaction and fee policy.
  transactionDigest: 'cd'.repeat(32),
  transactionType: 'transfer',
  maxFeeMicroCcd: '10000000',
  ...over,
});

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. matching approval recovers ════════════════════════════════════════════

test('01. a matching durable approval recovers as approved', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });

  const first = await client.authorize(request());
  check('first authorize approved', first.outcome === 'approved', first.outcome);

  const recovered = await client.recover(request());
  check('recovery returns approved', recovered.outcome === 'approved', `${recovered.outcome}/${recovered.reason}`);
  repo.close();
  rm();
});

// ═══ 2. no durable record → unknown ══════════════════════════════════════════

test('02. no durable decision recovers as unknown', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
  const recovered = await client.recover(request());
  check('recovery returns unknown', recovered.outcome === 'unknown', recovered.outcome);
  eq(recovered.reason, 'no_durable_decision', 'reason');
  repo.close();
  rm();
});

// ═══ 3. context mismatch → unknown, never approved ════════════════════════════

for (const [field, value] of [
  ['sponsor', OTHER_SPONSOR],
  ['recipient', SENDER],
  ['sender', PAY_TO],
  ['network', 'ccd:0000'],
] as const) {
  test(`03. recovery with mismatched ${field} is not approved`, async () => {
    const { dir, db, rm } = mk();
    const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
    repo.noteVerified('a'.repeat(64), 'k');
    repo.claim('a'.repeat(64), 'k');
    const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
    await client.authorize(request());
    const recovered = await client.recover(request({ [field]: value } as Partial<AuthorizationRequest>));
    ok(recovered.outcome !== 'approved', `${field} mismatch → ${recovered.outcome}`);
    repo.close();
    rm();
  });
}

test('03b. recovery with mismatched energy is not approved', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
  await client.authorize(request());
  const recovered = await client.recover(request({ energy: 999n }));
  ok(recovered.outcome !== 'approved', `energy mismatch → ${recovered.outcome}`);
  repo.close();
  rm();
});

// ═══ 4. different payment digest → unknown ═══════════════════════════════════

test('04. recovery for a different digest does not report the first payment approved', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
  await client.authorize(request());
  const recovered = await client.recover(request({ paymentDigest: 'b'.repeat(64) }));
  check('different digest → unknown', recovered.outcome === 'unknown', `${recovered.outcome}/${recovered.reason}`);
  repo.close();
  rm();
});

// ═══ 5. rejection recovers as rejected ════════════════════════════════════════

test('05. a durable rejection recovers as rejected', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
  // Force a policy rejection (energy over cap).
  const denied = await client.authorize(request({ energy: 99_999n }));
  check('authorization rejected', denied.outcome === 'rejected', denied.outcome);

  const recovered = await client.recover(request({ energy: 99_999n }));
  check('recovery returns rejected', recovered.outcome === 'rejected', `${recovered.outcome}/${recovered.reason}`);
  repo.close();
  rm();
});

// ═══ 6. recovery never creates a second approval ══════════════════════════════

test('06. recovery never creates, modifies, or deletes a record', async () => {
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const client = new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 });
  await client.authorize(request());
  const before = ownerRepo.signEvents('a'.repeat(64)).length;

  await client.recover(request());
  await client.recover(request());
  const after = ownerRepo.signEvents('a'.repeat(64)).length;

  eq(after, before, 'no new records after repeated recovery');
  eq(after, 1, 'exactly one authorization record');
  repo.close();
  rm();
});

// ═══ 7. authorization_already_recorded is not trusted — recovery decides ══════

test('07. settlement recovers exactly once when a prior approval matches', async () => {
  const { dir, db, rm } = mk();
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  const calls = { addSponsorSignature: 0, submitTransaction: 0 };
  const signer = {
    info: () => inner.info(),
    addSponsorSignature: async (tx: unknown) => { calls.addSponsorSignature++; return inner.addSponsorSignature(tx); },
    submitTransaction: async (tx: unknown) => { calls.submitTransaction++; return inner.submitTransaction(tx); },
    waitForFinalization: (h: string, ms?: number) => inner.waitForFinalization(h, ms),
    getAccountInfo: (a: string) => inner.getAccountInfo(a),
    getTokenBalance: (a: string, t: string) => inner.getTokenBalance(a, t),
    getTokenDecimals: (t: string) => inner.getTokenDecimals(t),
  };
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const ownerRepo = ownerRepoFor(db, repo, () => NOW * 1000);
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: db,
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({ policy, repository: ownerRepo, now: () => NOW * 1000 }),
  });

  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: { scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } },
    payload: {
      signedTransaction: {
        version: 1,
        header: { sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1, sponsor: { address: SPONSOR, numSignatures: 0 } },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
  const envelope = { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };

  const first = await core.settle(envelope);
  check('first settle succeeded', first.success === true, String(first.errorReason));
  eq(calls.addSponsorSignature, 1, 'signer invoked once');

  // Simulate a lost response: a second settle must recover, not re-authorize.
  const second = await core.settle(envelope);
  check('second settle succeeds (recovered or idempotent)', second.success === true, String(second.errorReason));
  eq(calls.addSponsorSignature, 1, 'still exactly one signer invocation');
  repo.close();
  rm();
});

// ═══ 8. caller-controlled decision cannot drive recovery ═════════════════════

test('08. a caller claiming approval does not drive recovery', async () => {
  // A client whose recover() claims approval for a payment with NO durable record.
  // The settlement boundary must still refuse: recovery is owner-mediated, and the durable
  // gate is the authority. Here we assert the local client (the real durable reader) returns
  // unknown for a payment that has no record, even though a caller would like it approved.
  const { dir, db, rm } = mk();
  const repo = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
  const local = new LocalAuthorizationClient({ policy, repository: ownerRepoFor(db, repo, () => NOW * 1000), now: () => NOW * 1000 });
  const recovered = await local.recover(request({ paymentDigest: 'c'.repeat(64) }));
  ok(recovered.outcome !== 'approved', `no durable record → ${recovered.outcome}`);
  eq(recovered.reason, 'no_durable_decision', 'reason is no_durable_decision');
  repo.close();
  rm();
});

// ═══ run ═════════════════════════════════════════════════════════════════════

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      check(name, false, `threw: ${(e as Error).message}`);
    }
  }
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\nrecovery: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
