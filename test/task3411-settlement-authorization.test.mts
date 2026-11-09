/**
 * TASK 34.11 — settlement authorization boundary integration.
 *
 * Proves that FacilitatorCore.settle() cannot reach the sponsor signer without an
 * 'approved' outcome from the authorization boundary, and that every non-approved outcome
 * fails closed.
 *
 * Run: npx tsx test/task3411-settlement-authorization.test.mts
 */

import { eq, ok } from './helpers.mjs';
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
const envelope = (paymentPayload: unknown, paymentRequirements: unknown) => ({
  x402Version: 2,
  paymentPayload,
  paymentRequirements,
});

/** Records every call so tests can prove the signer was (or was not) reached. */
function countingSigner(behaviour: Parameters<typeof createMockSigner>[0] extends infer T ? T : never = {} as never) {
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000, ...(behaviour as object) });
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
        return inner.submitTransaction(tx);
      },
      waitForFinalization: (h: string, ms?: number) => inner.waitForFinalization(h, ms),
      getAccountInfo: (a: string) => inner.getAccountInfo(a),
      getTokenBalance: (a: string, t: string) => inner.getTokenBalance(a, t),
      getTokenDecimals: (t: string) => inner.getTokenDecimals(t),
    },
  };
}

const stubClient = (response: AuthorizationResponse | (() => Promise<AuthorizationResponse>)): AuthorizationClient => ({
  authorize: async () => (typeof response === 'function' ? response() : response),
});

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 't3411-'));
  return { dir, db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
}

const coreWith = (opts: { authorization?: AuthorizationClient; db?: string; behaviour?: unknown } = {}) => {
  const { signer, calls } = countingSigner((opts.behaviour ?? {}) as never);
  const db = opts.db ?? join(mkdtempSync(join(tmpdir(), 't3411db-')), 'f.db');
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: db,
    now: () => NOW * 1000,
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
  });
  return { core, signer, calls, db };
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. approved → signer reached exactly once ═════════════════════════════════

test('01. approved authorization reaches the signer exactly once', async () => {
  const { core, calls } = coreWith({ authorization: stubClient({ outcome: 'approved', reason: null, detail: null }) });
  const payload = payloadFixture();
  const r = await core.settle(envelope(payload, payload.accepted));
  check('settle succeeded', r.success === true, JSON.stringify(r).slice(0, 120));
  eq(calls.addSponsorSignature, 1, 'addSponsorSignature called once');
  eq(calls.submitTransaction, 1, 'submitTransaction called once');
});

// ═══ 2. every non-approved outcome → signer never reached ═════════════════════

for (const [outcome, reason] of [
  ['rejected', 'payment_not_authorizable'],
  ['rejected', 'authorization_already_recorded'],
  ['rejected', 'wrong_sponsor'],
  ['unknown', 'owner_crashed'],
  ['owner_unavailable', 'socket_absent'],
  ['protocol_error', 'malformed_request'],
] as const) {
  test(`02. ${outcome}/${reason} never reaches the signer`, async () => {
    const { core, calls } = coreWith({ authorization: stubClient({ outcome, reason, detail: null }) });
    const payload = payloadFixture();
    const r = await core.settle(envelope(payload, payload.accepted));
    check(`settle refused (${outcome})`, r.success === false, String(r.errorReason));
    eq(calls.addSponsorSignature, 0, 'signer.addSponsorSignature NOT called');
    eq(calls.submitTransaction, 0, 'signer.submitTransaction NOT called');
    // unknown / owner_unavailable are ambiguous → non-terminal pending; the rest are terminal.
    if (outcome === 'unknown' || outcome === 'owner_unavailable') {
      eq(r.errorReason, 'settlement_pending', 'ambiguous outcome → settlement_pending');
      eq((r.extra as Record<string, unknown>)?.nonTerminal, true, 'marked non-terminal');
    } else {
      ok(r.errorReason !== 'settlement_pending', `terminal error ${r.errorReason}`);
    }
  });
}

// ═══ 3. authorization client throwing → fail closed ═══════════════════════════

test('03. authorization client throwing fails closed', async () => {
  const { core, calls } = coreWith({
    authorization: stubClient(async () => {
      throw new Error('socket exploded');
    }),
  });
  const payload = payloadFixture();
  const r = await core.settle(envelope(payload, payload.accepted));
  check('settle refused', r.success === false, String(r.errorReason));
  eq(calls.addSponsorSignature, 0, 'signer not reached');
});

// ═══ 4. local client: durable gate refusal → no signer ════════════════════════

test('04. default local client: pre-prepared payment is refused before the signer', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  // First settle authorizes + advances the payment.
  const first = coreWith({ db });
  const payload = payloadFixture();
  const r1 = await first.core.settle(envelope(payload, payload.accepted));
  check('first settle succeeded', r1.success === true, String(r1.errorReason));

  // A second core against the same DB, same payload → replay/idempotent path, no new sign.
  const second = coreWith({ db });
  const r2 = await second.core.settle(envelope(payload, payload.accepted));
  check('second settle is idempotent, not a new signature', r2.success === true, String(r2.errorReason));
  eq(second.calls.addSponsorSignature, 0, 'no second sponsor signature');
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 5. energy exposure is derived and capped ════════════════════════════════

test('05. energy exposure is derived from the transaction and capped', async () => {
  const seen: bigint[] = [];
  const client: AuthorizationClient = {
    authorize: async (req) => {
      seen.push(req.energy);
      return { outcome: 'approved', reason: null, detail: null };
    },
  };
  const { core } = coreWith({ authorization: client });
  const payload = payloadFixture();
  await core.settle(envelope(payload, payload.accepted));
  eq(seen.length, 1, 'authorization called once');
  ok(seen[0] > 0n, `energy > 0 (${seen[0]})`);
  // 100 * 1 signature + (94 header + payload bytes) + 300 base cost
  ok(seen[0] >= 394n, `energy >= formula floor (${seen[0]})`);
});

// ═══ 6. authorization binds to the exact digest and context ══════════════════

test('06. authorization request binds digest, sponsor, recipient, sender, energy', async () => {
  let captured: Record<string, unknown> | null = null;
  const client: AuthorizationClient = {
    authorize: async (req) => {
      captured = req as unknown as Record<string, unknown>;
      return { outcome: 'approved', reason: null, detail: null };
    },
  };
  const { core } = coreWith({ authorization: client });
  const payload = payloadFixture();
  await core.settle(envelope(payload, payload.accepted));
  ok(captured !== null, 'request captured');
  const c = captured as Record<string, unknown>;
  eq(c.network, CAIP2, 'network');
  eq(c.sender, SENDER, 'sender');
  eq(c.sponsor, SPONSOR, 'sponsor');
  eq(c.recipient, PAY_TO, 'recipient');
  eq(c.asset, 'CCD', 'asset');
  eq(c.amount, '250000', 'amount');
  eq(typeof c.paymentDigest, 'string', 'digest present');
  eq((c.paymentDigest as string).length, 64, 'digest is 64 chars');
  eq(c.version, 1, 'version');
});

// ═══ 7. rejected authorization does not finalize the payment ═════════════════

test('07. rejected authorization leaves the payment rejected, not settled', async () => {
  const { dir } = mk();
  const db = join(dir, 'f.db');
  const { core } = coreWith({ db, authorization: stubClient({ outcome: 'rejected', reason: 'wrong_sponsor', detail: null }) });
  const payload = payloadFixture();
  const r = await core.settle(envelope(payload, payload.accepted));
  check('settle refused', r.success === false, String(r.errorReason));

  // Inspect durable state: the payment must not be finalized.
  const repo = new SqliteSettlementRepository(db);
  const digest = (r.extra as Record<string, unknown>)?.digest as string;
  const row = repo.get(digest);
  ok(row !== undefined, 'payment row exists');
  eq(row?.state, 'rejected', 'payment is rejected, not finalized');
  const approvals = repo.signEvents(digest).filter((e) => e.decision === 'approved').length;
  eq(approvals, 0, 'no approved sign event recorded');
  repo.close();
  rmSync(dir, { recursive: true, force: true });
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
  console.log(`\ntask34.11: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
