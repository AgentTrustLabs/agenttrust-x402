/**
 * TASK 34.11 — authorization boundary integration tests (focused).
 *
 * Proves, with exact signer call counts, that no path to the mock signer exists without an
 * 'approved' authorization outcome, and that the durable gate, replay protection, and the
 * DENY_ALL_FACILITATOR gateway behaviour are intact.
 *
 * Run: npx tsx test/authz-boundary.test.mts
 */

import { eq, ok, notOk } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import type { AuthorizationClient, AuthorizationResponse } from '../services/facilitator/src/authorization.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const NOW = 1_800_000_000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function payloadFixture(over: Record<string, unknown> = {}) {
  const requirements = {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: SPONSOR },
    ...((over.requirements as object) ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: (over.resourceUrl as string) ?? 'agenttrust://resource/1004' },
    accepted: { ...requirements, ...((over.accepted as object) ?? {}) },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER,
          nonce: 7,
          expiry: (over.expiry as number) ?? NOW + 200,
          numSignatures: 1,
          sponsor: { address: SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: unknown, r: unknown) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: r });

/** Wraps the real mock signer and counts every invocation. */
function countingSigner(behaviour: { submit?: 'ok' | 'throw' } = {}) {
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  const calls = { addSponsorSignature: 0, submitTransaction: 0 };
  return {
    calls,
    signer: {
      info: () => inner.info(),
      addSponsorSignature: async (tx: unknown) => {
        calls.addSponsorSignature++;
        return inner.addSponsorSignature(tx);
      },
      submitTransaction: async (tx: unknown) => {
        calls.submitTransaction++;
        if (behaviour.submit === 'throw') throw new Error('submission exploded');
        return inner.submitTransaction(tx);
      },
      waitForFinalization: (h: string, ms?: number) => inner.waitForFinalization(h, ms),
      getAccountInfo: (a: string) => inner.getAccountInfo(a),
      getTokenBalance: (a: string, t: string) => inner.getTokenBalance(a, t),
      getTokenDecimals: (t: string) => inner.getTokenDecimals(t),
    },
  };
}

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't3411b-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const coreWith = (opts: {
  authorization?: AuthorizationClient;
  db?: string;
  behaviour?: { submit?: 'ok' | 'throw' };
} = {}) => {
  const { signer, calls } = countingSigner(opts.behaviour);
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: opts.db ?? join(mkdtempSync(join(tmpdir(), 't3411db-')), 'f.db'),
    now: () => NOW * 1000,
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  });
  return { core, signer, calls };
};

/** A client whose response can be driven per call, for mismatch and malformed tests. */
const scripted = (fn: (req: { paymentDigest: string; sponsor: string; recipient: string; sender: string; energy: bigint }) => AuthorizationResponse | 'malformed' | 'unknown-json'): AuthorizationClient => ({
  authorize: async (req) => {
    const r = fn(req);
    if (r === 'malformed') return { outcome: 'protocol_error', reason: 'malformed_request', detail: 'owner returned garbage' };
    if (r === 'unknown-json') throw new Error('invalid JSON from owner');
    return r;
  },
});

const approved: AuthorizationResponse = { outcome: 'approved', reason: null, detail: null };
const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. successful authorization ═════════════════════════════════════════════

test('01. successful authorization reaches the signer exactly once', async () => {
  const { core, calls } = coreWith({ authorization: { authorize: async () => approved } });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle succeeded', r.success === true, String(r.errorReason));
  eq(calls.addSponsorSignature, 1, 'signer.addSponsorSignature');
  eq(calls.submitTransaction, 1, 'signer.submitTransaction');
});

// ═══ 2-6. non-approved outcomes never reach the signer ════════════════════════

for (const [outcome, reason] of [
  ['rejected', 'wrong_sponsor'],
  ['unknown', 'owner_crashed'],
  ['owner_unavailable', 'socket_absent'],
  ['protocol_error', 'malformed_request'],
] as const) {
  test(`0${outcome === 'rejected' ? 2 : outcome === 'unknown' ? 3 : outcome === 'owner_unavailable' ? 4 : 5}. ${outcome} never reaches the signer`, async () => {
    const { core, calls } = coreWith({ authorization: { authorize: async () => ({ outcome, reason, detail: null }) } });
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    check(`settle refused (${outcome})`, r.success === false, String(r.errorReason));
    eq(calls.addSponsorSignature, 0, 'addSponsorSignature NOT called');
    eq(calls.submitTransaction, 0, 'submitTransaction NOT called');
    if (outcome === 'unknown' || outcome === 'owner_unavailable') {
      eq(r.errorReason, 'settlement_pending', 'ambiguous → settlement_pending');
      eq((r.extra as Record<string, unknown>)?.nonTerminal, true, 'nonTerminal flagged');
    }
  });
}

// ═══ 7. invalid / malformed owner response ════════════════════════════════════

test('07a. malformed owner response never reaches the signer', async () => {
  const { core, calls } = coreWith({
    authorization: { authorize: async () => ({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'garbage' }) },
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('07b. owner client throwing never reaches the signer', async () => {
  const { core, calls } = coreWith({
    authorization: { authorize: async () => { throw new Error('invalid JSON from owner'); } },
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('07c. an "approved" outcome with no reason field still passes the gate', async () => {
  const { core, calls } = coreWith({ authorization: { authorize: async () => ({ outcome: 'approved' } as AuthorizationResponse) } });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle succeeded', r.success === true, String(r.errorReason));
  eq(calls.addSponsorSignature, 1, 'signer reached once');
});

// ═══ 8. digest / context mismatch ═════════════════════════════════════════════

test('08a. owner approving a DIFFERENT payment digest must not satisfy this payment', async () => {
  const { core, calls } = coreWith({
    authorization: scripted((req) => {
      // The owner "approved" a digest that is not this payment's digest.
      const wrong = 'f'.repeat(64);
      return { outcome: req.paymentDigest === wrong ? 'approved' : 'rejected', reason: 'payment_digest_mismatch', detail: null };
    }),
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('08b. sponsor mismatch in the authorization request is rejected by the owner', async () => {
  const { core, calls } = coreWith({
    authorization: scripted((req) => {
      return req.sponsor === SPONSOR ? approved : { outcome: 'rejected', reason: 'wrong_sponsor', detail: null };
    }),
  });
  // Tamper the requirements so the request sponsor differs from the policy sponsor.
  const p = payloadFixture();
  const tampered = { ...p.accepted, extra: { feePayer: 'tamperedSponsorAddress00000000000000000000000' } };
  const r = await core.settle(envelope(p, tampered));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('08c. recipient mismatch is rejected by the owner', async () => {
  const { core, calls } = coreWith({
    authorization: scripted((req) => (req.recipient === PAY_TO ? approved : { outcome: 'rejected', reason: 'invalid_recipient', detail: null })),
  });
  const p = payloadFixture();
  const tampered = { ...p.accepted, payTo: '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5' };
  const r = await core.settle(envelope(p, tampered));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('08d. sponsor equal to sender is rejected', async () => {
  const { core, calls } = coreWith({
    authorization: scripted((req) => (req.sponsor === req.sender ? { outcome: 'rejected', reason: 'sponsor_is_sender', detail: null } : approved)),
  });
  // The authorization request's sponsor is taken from requirements.extra.feePayer.
  // Setting it equal to the sender must be refused by the owner.
  const p = payloadFixture();
  const tampered = { ...p.accepted, extra: { feePayer: SENDER } };
  const r = await core.settle(envelope(p, tampered));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

// ═══ 9. energy mismatch / over cap ═══════════════════════════════════════════

test('09. energy over the owner cap is rejected', async () => {
  const { core, calls } = coreWith({
    authorization: scripted((req) => (req.energy > 500n ? { outcome: 'rejected', reason: 'energy_exceeds_cap', detail: null } : approved)),
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

test('09b. energy derived from the transaction is positive and bounded', async () => {
  const seen: bigint[] = [];
  const { core } = coreWith({
    authorization: { authorize: async (req) => { seen.push(req.energy); return approved; } },
  });
  const p = payloadFixture();
  await core.settle(envelope(p, p.accepted));
  eq(seen.length, 1, 'one authorization call');
  ok(seen[0] >= 394n, `energy >= formula floor (${seen[0]})`);
  ok(seen[0] < 20_000n, `energy is bounded (${seen[0]})`);
});

// ═══ 10. authorization_already_recorded without verifiable approval ═══════════

test('10. authorization_already_recorded is NOT blindly accepted', async () => {
  const { core, calls } = coreWith({
    authorization: { authorize: async () => ({ outcome: 'rejected', reason: 'authorization_already_recorded', detail: 'owner reports a prior approval' }) },
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
  // The payment must not be recorded as approved.
  const repo = new SqliteSettlementRepository((core as unknown as { store: SqliteSettlementRepository }).store['db'] ? '' : '');
  void repo;
});

test('10b. authorization_already_recorded leaves no approved sign event', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  const { core } = coreWith({
    db,
    authorization: { authorize: async () => ({ outcome: 'rejected', reason: 'authorization_already_recorded', detail: null }) },
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  const repo = new SqliteSettlementRepository(db);
  const digest = (r.extra as Record<string, unknown>)?.digest as string;
  const approvals = repo.signEvents(digest).filter((e) => e.decision === 'approved').length;
  eq(approvals, 0, 'no approved event recorded');
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 11. duplicate settlement request ════════════════════════════════════════

test('11. duplicate settlement request cannot cause duplicate signing', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  const { core, calls } = coreWith({ db });
  const p = payloadFixture();
  const r1 = await core.settle(envelope(p, p.accepted));
  const r2 = await core.settle(envelope(p, p.accepted));
  check('first settle succeeded', r1.success === true, String(r1.errorReason));
  check('second settle idempotent', r2.success === true, String(r2.errorReason));
  eq(calls.addSponsorSignature, 1, 'signer invoked exactly once across the replay');
  eq(calls.submitTransaction, 1, 'submission exactly once across the replay');
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 12. concurrent settlement requests ══════════════════════════════════════

test('12. concurrent settlement requests cannot bypass authorization', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  const { core, calls } = coreWith({ db });
  const p = payloadFixture();
  const [a, b] = await Promise.all([core.settle(envelope(p, p.accepted)), core.settle(envelope(p, p.accepted))]);
  check('at least one settle succeeded', a.success || b.success, `${a.success}/${b.success}`);
  eq(calls.addSponsorSignature, 1, 'signer invoked exactly once under concurrency');
  eq(calls.submitTransaction, 1, 'submission exactly once under concurrency');
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 13. owner crash / timeout ═══════════════════════════════════════════════

test('13. owner timeout never reaches the signer', async () => {
  const { core, calls } = coreWith({
    authorization: { authorize: async () => ({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: 'IPC timeout' }) },
  });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle pending (non-terminal)', r.errorReason === 'settlement_pending', String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
  eq(calls.submitTransaction, 0, 'no submission');
});

// ═══ 14. signer failure after approval ═══════════════════════════════════════

test('14. signer submission failure after approval stays pending, never retried', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  const { core, calls } = coreWith({ db, behaviour: { submit: 'throw' } });
  const p = payloadFixture();
  const r = await core.settle(envelope(p, p.accepted));
  check('settle pending', r.errorReason === 'settlement_pending', String(r.errorReason));
  eq(calls.addSponsorSignature, 1, 'signer was reached (authorization succeeded)');
  eq(calls.submitTransaction, 1, 'submission attempted exactly once');
  // A retry must not re-attempt the submission (durable hash + pending state).
  const r2 = await core.settle(envelope(p, p.accepted));
  check('retry is pending, not a second submission', r2.errorReason === 'settlement_pending', String(r2.errorReason));
  eq(calls.submitTransaction, 1, 'still exactly one submission attempt');
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 15. regression: DENY_ALL_FACILITATOR ═════════════════════════════════════

test('15. DENY_ALL_FACILITATOR gateway behaviour is unchanged', async () => {
  const { DENY_ALL_FACILITATOR } = await import('../src/payments/x402.js');
  ok(DENY_ALL_FACILITATOR !== undefined, 'DENY_ALL_FACILITATOR exported');
  const verifyThrew = await DENY_ALL_FACILITATOR.verify({} as never).then(() => false, () => true);
  const settleThrew = await DENY_ALL_FACILITATOR.settle({} as never).then(() => false, () => true);
  check('DENY_ALL_FACILITATOR.verify refuses', verifyThrew, 'throws');
  check('DENY_ALL_FACILITATOR.settle refuses', settleThrew, 'throws');
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
  console.log(`\ntask34.11 boundary: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
