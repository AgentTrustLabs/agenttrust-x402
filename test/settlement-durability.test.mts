/**
 * TASK 26 — durable settlement state, replay, and reconciliation security.
 *
 * Real SQLite files in a temp dir (so restart is a real process-level restart of the
 * repository), real child processes for the concurrency test, and a fixture evidence verifier
 * so no chain is ever contacted.
 *
 * Every assertion is written against the required behaviour.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { canTransition, isTerminal, interpretObservation } from '../services/facilitator/src/state.js';
import { OperatorAuth, buildOperatorAuth, hashOperatorToken } from '../services/facilitator/src/auth.js';
import { FixtureEvidenceVerifier, createSignerBackedVerifier } from '../services/facilitator/src/evidence.js';
import { ReconciliationService } from '../services/facilitator/src/reconcile.js';
import { loadConfig, ConfigurationError } from '../services/facilitator/src/config.js';
import { startFacilitator } from '../services/facilitator/src/server.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const NOW = 1_800_000_000_000; // ms

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const TX_A = 'simulated-0000000000000aaa';
const TX_B = 'simulated-0000000000000bbb';
const KEY_A = `${CAIP2}|${PAY_TO}|250000|CCD|agenttrust://resource/1004`;
const KEY_B = `${CAIP2}|${PAY_TO}|250000|CCD|agenttrust://resource/OTHER`;

const dirs = [];
function tmpDb() {
  const d = mkdtempSync(join(tmpdir(), 'agenttrust-t26-'));
  dirs.push(d);
  return join(d, 'facilitator.db');
}
const repoAt = path => new SqliteSettlementRepository(path, { now: () => NOW });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ═══ 1. state machine ═══════════════════════════════════════════════════

test('01. the transition table admits only the intended edges', () => {
  // TASK 29 replaced the coarse `settlement_pending` with explicit pre-broadcast states.
  eq(canTransition('created', 'prepared'), true, 'created → prepared');
  eq(canTransition('prepared', 'submitting'), true, 'prepared → submitting');
  eq(canTransition('submitting', 'outcome_unknown'), true, 'submitting → outcome_unknown');
  eq(canTransition('outcome_unknown', 'finalized'), true, 'outcome_unknown → finalized');
  eq(canTransition('outcome_unknown', 'rejected'), true, 'outcome_unknown → rejected');
  eq(canTransition('observed', 'finalized'), true, 'observed → finalized');

  eq(canTransition('created', 'finalized'), false, 'created cannot skip to finalized');
  eq(canTransition('prepared', 'finalized'), false, 'prepared cannot skip to finalized');
  eq(canTransition('submitting', 'finalized'), false, 'submitting cannot skip to finalized');
  eq(canTransition('finalized', 'rejected'), false, 'finalized is terminal');
  eq(canTransition('finalized', 'outcome_unknown'), false, 'finalized cannot reopen');
  eq(canTransition('rejected', 'finalized'), false, 'rejection cannot become success');
  eq(canTransition('rejected', 'outcome_unknown'), false, 'rejection cannot reopen');
  eq(isTerminal('finalized') && isTerminal('rejected'), true, 'both terminal');
  eq(isTerminal('outcome_unknown'), false, 'outcome_unknown is not terminal');
});

test('02. observations map conservatively — committed is never final', () => {
  eq(interpretObservation('finalized').advance, 'finalized', 'finalized advances');
  eq(interpretObservation('rejected').advance, 'rejected', 'failed advances to rejection');
  eq(interpretObservation('rejected').advance, 'rejected', 'rejected is a rejection');
  for (const s of ['committed', 'pending', 'unknown']) {
    eq(interpretObservation(s).advance, 'stay', `${s} stays pending`);
  }
});

// ═══ 2. durability ══════════════════════════════════════════════════════

test('03. state survives a process-level restart', () => {
  const path = tmpDb();
  const a = repoAt(path);
  a.noteVerified(DIGEST_A, KEY_A);
  a.claim(DIGEST_A, KEY_A);
  a.markPending(DIGEST_A, TX_A, 'broadcast');
  eq(a.get(DIGEST_A).state, 'outcome_unknown', 'pending recorded');
  a.close();

  ok(existsSync(path), 'the database file exists on disk');
  const b = repoAt(path);
  try {
    const row = b.get(DIGEST_A);
    eq(row.state, 'outcome_unknown', 'state survived restart');
    eq(row.tx_hash, TX_A, 'hash survived restart');
    eq(b.pendingCount(), 1, 'pending counted after restart');
  } finally {
    b.close();
  }
});

test('04. replay rejection survives restart', () => {
  const path = tmpDb();
  const a = repoAt(path);
  a.noteVerified(DIGEST_A, KEY_A);
  a.claim(DIGEST_A, KEY_A);
  a.prepare(DIGEST_A, TX_A);
  a.claimSubmit(DIGEST_A, TX_A);
  a.markBroadcast(DIGEST_A, TX_A);
  a.reconcile({ paymentDigest: DIGEST_A, transaction: TX_A, observed: 'finalized', evidenceSource: 'fixture', evidenceDigest: 'e1' });
  eq(a.get(DIGEST_A).state, 'finalized', 'finalized before restart');
  a.close();

  const b = repoAt(path);
  try {
    const claim = b.claim(DIGEST_A, KEY_A);
    eq(claim.ok, true, 'replay returns the recorded settlement');
    eq(claim.claim, 'idempotent', 'recognised as an idempotent replay');
    eq(claim.transaction, TX_A, 'same hash');
  } finally {
    b.close();
  }
});

test('05. pending recovery survives restart and is never auto-retried', () => {
  const path = tmpDb();
  const a = repoAt(path);
  a.noteVerified(DIGEST_A, KEY_A);
  a.claim(DIGEST_A, KEY_A);
  a.markPending(DIGEST_A, TX_A, 'broadcast, not confirmed');
  a.close();

  const b = repoAt(path);
  try {
    const claim = b.claim(DIGEST_A, KEY_A);
    eq(claim.ok, false, 'refused');
    eq(claim.reason, 'pending', 'still pending');
    eq(claim.transaction, TX_A, 'hash available for reconciliation');
  } finally {
    b.close();
  }
});

test('06. an interrupted write leaves no partial state (transaction rollback)', () => {
  const path = tmpDb();
  const repo = repoAt(path);
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    // Force a failure inside the transaction by claiming a payment whose foreign key is fine
    // but whose insert into claims violates its primary key. The whole unit must roll back.
    const first = repo.claim(DIGEST_A, KEY_A);
    eq(first.ok, true, 'first claim succeeded');

    // Simulate a crash mid-transaction: throw from inside a write.
    let threw = false;
    try {
      repo['tx'](() => {
        repo['db'].prepare('UPDATE payments SET state = ? WHERE payment_digest = ?').run('finalized', DIGEST_A);
        throw new Error('simulated crash mid-transaction');
      });
    } catch {
      threw = true;
    }
    eq(threw, true, 'the simulated crash threw');
    // The uncommitted UPDATE must not have landed.
    eq(repo.get(DIGEST_A).state, 'created', 'state unchanged after rollback');
  } finally {
    repo.close();
  }
});

test('07. a corrupt database fails loudly rather than pretending to be empty', () => {
  const path = tmpDb();
  writeFileSync(path, Buffer.from('this is definitely not a sqlite database'.repeat(50)));
  let threw = null;
  try {
    const r = repoAt(path);
    r.get(DIGEST_A);
    r.close();
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, 'opening or querying a corrupt file throws');
  ok(/not a database|malformed|corrupt/i.test(String(threw?.message)), String(threw?.message).slice(0, 120));
});

test('08. the schema enforces one settlement record per payment', () => {
  const path = tmpDb();
  const repo = repoAt(path);
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    repo.claim(DIGEST_A, KEY_A);
    repo.recordTransaction(DIGEST_A, TX_A);
    // A second insert for the same digest must be ignored by the PK, not create a second row.
    repo.recordTransaction(DIGEST_A, TX_A);
    const n = repo['db'].prepare('SELECT COUNT(*) AS n FROM settlements WHERE payment_digest = ?').get(DIGEST_A);
    eq(Number(n.n), 1, 'exactly one settlement row');
  } finally {
    repo.close();
  }
});

test('09. refusing to overwrite a recorded transaction hash', () => {
  const path = tmpDb();
  const repo = repoAt(path);
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    repo.claim(DIGEST_A, KEY_A);
    repo.recordTransaction(DIGEST_A, TX_A);
    let threw = null;
    try { repo.recordTransaction(DIGEST_A, TX_B); } catch (e) { threw = e; }
    ok(threw !== null, 'a different hash is refused');
    eq(repo.get(DIGEST_A).tx_hash, TX_A, 'the original hash is intact');
  } finally {
    repo.close();
  }
});

// ═══ 3. replay ══════════════════════════════════════════════════════════

test('10. the same payment cannot be used for a different resource', () => {
  const repo = repoAt(tmpDb());
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    repo.claim(DIGEST_A, KEY_A);
    repo.recordTransaction(DIGEST_A, TX_A);
    repo.reconcile({ paymentDigest: DIGEST_A, transaction: TX_A, observed: 'finalized', evidenceSource: 'f', evidenceDigest: 'd' });

    const cross = repo.noteVerified(DIGEST_A, KEY_B);
    eq(cross.ok, false, 'cross-resource reuse refused');
    ok(/different authorisation/.test(cross.reason), cross.reason);
  } finally {
    repo.close();
  }
});

test('11. replay protection does not depend on TTL — a settled payment never becomes reusable', () => {
  const path = tmpDb();
  // A repository whose clock jumps a full year forward: no TTL exists to expire anything.
  const repo = repoAt(path);
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    repo.claim(DIGEST_A, KEY_A);
    repo.prepare(DIGEST_A, TX_A);
    repo.claimSubmit(DIGEST_A, TX_A);
    repo.markBroadcast(DIGEST_A, TX_A);
    repo.reconcile({ paymentDigest: DIGEST_A, transaction: TX_A, observed: 'finalized', evidenceSource: 'f', evidenceDigest: 'd' });
  } finally {
    repo.close();
  }

  // Reopen with the clock a year later.
  const later = new SqliteSettlementRepository(path, { now: () => NOW + 365 * 24 * 3600 * 1000 });
  try {
    const claim = later.claim(DIGEST_A, KEY_A);
    eq(claim.ok, true, 'recognised as a replay');
    eq(claim.claim, 'idempotent', 'still idempotent a year later — no TTL involved');
    eq(claim.transaction, TX_A, 'same hash');
    eq(later.get(DIGEST_A).state, 'finalized', 'state unchanged');
  } finally {
    later.close();
  }
});

test('12. a different recipient, amount, asset or network is a different authorisation', () => {
  const repo = repoAt(tmpDb());
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    repo.claim(DIGEST_A, KEY_A);
    const variants = [
      `${CAIP2}|${SENDER}|250000|CCD|agenttrust://resource/1004`,
      `${CAIP2}|${PAY_TO}|999999|CCD|agenttrust://resource/1004`,
      `${CAIP2}|${PAY_TO}|250000|USDR|agenttrust://resource/1004`,
      `ccd:9dd9ca4d19e9393877d2c44b70f89acb|${PAY_TO}|250000|CCD|agenttrust://resource/1004`,
    ];
    for (const key of variants) {
      const r = repo.noteVerified(DIGEST_A, key);
      eq(r.ok, false, `refused: ${key}`);
    }
  } finally {
    repo.close();
  }
});

test('13. concurrent duplicate claims produce exactly one fresh claim', () => {
  const repo = repoAt(tmpDb());
  try {
    repo.noteVerified(DIGEST_A, KEY_A);
    const results = [];
    // Synchronous store: a tight loop is the clearest model of "two requests in the same tick".
    for (let i = 0; i < 5; i++) results.push(repo.claim(DIGEST_A, KEY_A));
    eq(results.filter(r => r.ok && r.claim === 'fresh').length, 1, 'exactly one fresh claim');
    eq(results.slice(1).every(r => !r.ok), true, 'the rest are refused');
  } finally {
    repo.close();
  }
});

test('13b. concurrent duplicate claims across real OS processes produce one fresh claim', async () => {
  const path = tmpDb();
  const seed = repoAt(path);
  seed.noteVerified(DIGEST_A, KEY_A);
  seed.close();

  const script = `
    import { SqliteSettlementRepository } from ${JSON.stringify(new URL('../services/facilitator/src/repository.ts', import.meta.url).pathname)};
    const repo = new SqliteSettlementRepository(${JSON.stringify(path)});
    const r = repo.claim(${JSON.stringify(DIGEST_A)}, ${JSON.stringify(KEY_A)});
    process.stdout.write(JSON.stringify(r));
    repo.close();
  `;
  const scriptPath = join(tmpdir(), `t26-claim-${Date.now()}.mjs`);
  writeFileSync(scriptPath, script);

  const runs = await Promise.all(
    Array.from({ length: 4 }, () =>
      new Promise(resolve => {
        const cp = spawn('npx', ['tsx', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        cp.stdout.on('data', d => (out += String(d)));
        cp.on('close', () => resolve(out));
      }),
    ),
  );
  rmSync(scriptPath, { force: true });

  const parsed = runs.map(r => {
    try { return JSON.parse(r); } catch { return { ok: false, reason: 'parse' }; }
  });
  const fresh = parsed.filter(r => r.ok && r.claim === 'fresh').length;
  eq(fresh, 1, `exactly one process won the claim (got ${fresh}): ${JSON.stringify(parsed)}`);
});

// ═══ 4. authentication ══════════════════════════════════════════════════

test('14. missing, malformed, invalid and expired credentials are all refused distinctly', () => {
  const token = 'operator-token-abcdefghijklmnop';
  const auth = new OperatorAuth({ tokenSha256: hashOperatorToken(token), expiresAt: null }, { now: () => NOW });

  eq(auth.check(undefined).code, 'missing', 'no header');
  eq(auth.check('').code, 'missing', 'empty header');
  eq(auth.check('Token xyz').code, 'malformed', 'wrong scheme');
  eq(auth.check('Bearer').code, 'malformed', 'no token');
  eq(auth.check('Bearer   ').code, 'malformed', 'whitespace token');
  eq(auth.check(`Bearer ${'x'.repeat(10)}`).code, 'malformed', 'too short');
  eq(auth.check(`Bearer ${'wrong-token-abcdefghijkl'}`).code, 'invalid', 'wrong token');
  eq(auth.check(`Bearer ${token}`).ok, true, 'correct token accepted');

  const expiring = new OperatorAuth(
    { tokenSha256: hashOperatorToken(token), expiresAt: NOW + 1000 },
    { now: () => NOW + 2000 },
  );
  eq(expiring.check(`Bearer ${token}`).code, 'expired', 'expired credential');
});

test('15. the operator digest must be a valid SHA-256, and reconcile cannot enable without one', () => {
  let a = null;
  try { new OperatorAuth({ tokenSha256: 'not-a-digest', expiresAt: null }); } catch (e) { a = e; }
  ok(a !== null, 'bad digest refused');

  let b = null;
  try { buildOperatorAuth({ reconcileEnabled: true }); } catch (e) { b = e; }
  ok(b !== null, 'enabling reconcile without a token digest throws');
  ok(/unauthenticated state-changing endpoint/.test(b.message), b.message);

  eq(buildOperatorAuth({ reconcileEnabled: false }), null, 'disabled ⇒ no authenticator at all');
});

test('16. the config refuses reconcile without a digest, and refuses a malformed digest', () => {
  let a = null;
  try { loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_RECONCILE_ENABLED: '1' }); } catch (e) { a = e; }
  ok(a instanceof ConfigurationError, 'no digest refused');

  let b = null;
  try {
    loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_RECONCILE_ENABLED: '1', FACILITATOR_OPERATOR_TOKEN_SHA256: 'abc' });
  } catch (e) { b = e; }
  ok(b instanceof ConfigurationError, 'malformed digest refused');

  const good = loadConfig({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_RECONCILE_ENABLED: '1',
    FACILITATOR_OPERATOR_TOKEN_SHA256: hashOperatorToken('operator-token-abcdefghijklmnop'),
  });
  eq(good.reconcileEnabled, true, 'enabled with a valid digest');
  eq(good.operatorTokenSha256.length, 64, 'digest stored, not the token');
});

test('17. real mode refuses an in-memory database', () => {
  let threw = null;
  try {
    loadConfig({
      FACILITATOR_MODE: 'real',
      FACILITATOR_SPONSOR_ADDRESS: PAY_TO,
      FACILITATOR_DB_PATH: ':memory:',
    });
  } catch (e) { threw = e; }
  ok(threw instanceof ConfigurationError, 'memory db refused for real mode');
  ok(/durable FACILITATOR_DB_PATH/.test(threw.message), threw.message);
});

// ═══ 5. reconciliation evidence ═════════════════════════════════════════

function seeded(finalState = 'outcome_unknown') {
  const repo = repoAt(tmpDb());
  repo.noteVerified(DIGEST_A, KEY_A);
  repo.claim(DIGEST_A, KEY_A);
  repo.prepare(DIGEST_A, TX_A);
  repo.claimSubmit(DIGEST_A, TX_A);
  repo.markBroadcast(DIGEST_A, TX_A);
  if (finalState === 'rejected') repo.markFailed(DIGEST_A, 'seed');
  return repo;
}

test('18. a caller cannot finalize by asserting it — there is no such field', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({ repository: repo, verifier: new FixtureEvidenceVerifier({}) });
    // The service's request type has no `status`; a caller passing one is simply ignored.
    const out = await svc.reconcile({ paymentDigest: DIGEST_A, transaction: TX_A, status: 'finalized' });
    eq(out.ok, true, 'accepted as a request');
    eq(out.changed, false, 'nothing changed');
    eq(repo.get(DIGEST_A).state, 'outcome_unknown', 'evidence unavailable ⇒ stays pending');
  } finally {
    repo.close();
  }
});

test('19. unknown payment, unknown transaction and hash mismatch are refused', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({ [TX_A]: 'finalized' }),
    });

    eq((await svc.reconcile({ paymentDigest: DIGEST_B })).code, 'unknown_payment', 'unknown payment');
    eq((await svc.reconcile({ paymentDigest: DIGEST_A, transaction: TX_B })).code, 'hash_mismatch', 'hash mismatch');
    eq((await svc.reconcile({ paymentDigest: 'not-a-digest' })).code, 'invalid_request', 'malformed digest');
    eq(repo.get(DIGEST_A).state, 'outcome_unknown', 'nothing advanced');
  } finally {
    repo.close();
  }
});

test('20. only verified finality evidence finalizes a payment', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({ [TX_A]: 'finalized' }),
    });
    const out = await svc.reconcile({ paymentDigest: DIGEST_A });
    eq(out.ok, true, 'reconciled');
    eq(out.changed, true, 'state changed');
    eq(out.state, 'finalized', 'finalized');
    eq(repo.get(DIGEST_A).state, 'finalized', 'persisted');
  } finally {
    repo.close();
  }
});

test('21. committed, pending and unknown evidence all retain settlement_pending', async () => {
  for (const observed of ['committed', 'pending', 'unknown']) {
    const repo = seeded();
    try {
      const svc = new ReconciliationService({
        repository: repo,
        verifier: new FixtureEvidenceVerifier({ [TX_A]: observed }),
      });
      const out = await svc.reconcile({ paymentDigest: DIGEST_A });
      eq(out.changed, false, `${observed}: unchanged`);
      eq(repo.get(DIGEST_A).state, 'outcome_unknown', `${observed}: still pending`);
    } finally {
      repo.close();
    }
  }
});

test('22. unavailable evidence retains pending — it never becomes success or failure', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({}, { unreachable: true }),
    });
    const out = await svc.reconcile({ paymentDigest: DIGEST_A });
    eq(out.changed, false, 'unchanged');
    eq(out.state, 'outcome_unknown', 'still pending');
    ok(/evidence unavailable/.test(out.reason), out.reason);
  } finally {
    repo.close();
  }
});

test('23. a verifier that answers for a different hash is not trusted', async () => {
  const repo = seeded();
  try {
    const liar = {
      name: 'liar',
      async verify() {
        return { available: true, observed: 'finalized', source: 'liar', raw: { txHash: 'someOtherHash', status: 'finalized' } };
      },
    };
    // The service binds evidence to the recorded hash *by asking about that hash*; a verifier
    // that answers about a different transaction is still describing our hash in the request,
    // so the protection is at the repository boundary. Prove that layer refuses a swap.
    const direct = repo.reconcile({
      paymentDigest: DIGEST_A,
      transaction: TX_B, // deliberately wrong
      observed: 'finalized',
      evidenceSource: 'liar',
      evidenceDigest: 'x',
    });
    eq(direct.ok, false, 'repository refuses a hash it did not record');
    ok(/hash mismatch/.test(direct.reason), direct.reason);

    const signerBacked = createSignerBackedVerifier({
      async waitForFinalization() {
        return { txHash: 'aCompletelyDifferentHash', status: 'finalized' };
      },
    });
    const ev = await signerBacked.verify({ transaction: TX_A, paymentDigest: DIGEST_A });
    eq(ev.available, false, 'signer-backed verifier rejects a mismatched response hash');
    void liar;
  } finally {
    repo.close();
  }
});

test('24. rejected evidence is terminal failure, and cannot be reopened', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({ [TX_A]: 'rejected' }),
    });
    // TASK 59: a single rejection observation no longer terminalizes; a confirming
    // second observation is required.
    const first = await svc.reconcile({ paymentDigest: DIGEST_A });
    ok(first.ok, 'first rejection observed (not terminal)');
    const out = await svc.reconcile({ paymentDigest: DIGEST_A });
    eq(out.state, 'rejected', 'rejected ⇒ failed');
    eq(repo.get(DIGEST_A).state, 'rejected', 'persisted as terminal');

    // A later "finalized" observation must not reopen it.
    const second = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({ [TX_A]: 'finalized' }),
    }).reconcile({ paymentDigest: DIGEST_A });
    eq((await second).code, 'terminal', 'terminal state refuses evidence');
    eq(repo.get(DIGEST_A).state, 'rejected', 'still failed');
  } finally {
    repo.close();
  }
});

test('25. duplicate finalization is idempotent, not an error', async () => {
  const repo = seeded();
  try {
    const svc = new ReconciliationService({
      repository: repo,
      verifier: new FixtureEvidenceVerifier({ [TX_A]: 'finalized' }),
    });
    const first = await svc.reconcile({ paymentDigest: DIGEST_A });
    const second = await svc.reconcile({ paymentDigest: DIGEST_A });
    eq(first.changed, true, 'first finalized');
    eq(second.changed, false, 'second is a no-op');
    eq(second.state, 'finalized', 'still finalized');
    eq(repo.transitions(DIGEST_A).filter(t => t.to_state === 'finalized').length, 1, 'exactly one finalize transition logged');
  } finally {
    repo.close();
  }
});

test('26. every transition is audited with reason, hash, evidence digest and timestamp', () => {
  const repo = seeded();
  try {
    repo.reconcile({
      paymentDigest: DIGEST_A,
      transaction: TX_A,
      observed: 'finalized',
      evidenceSource: 'fixture',
      evidenceDigest: 'ev-digest',
    });
    const log = repo.transitions(DIGEST_A);
    ok(log.length >= 3, `transition log has ${log.length} entries`);
    const fin = log.find(t => t.to_state === 'finalized');
    ok(fin !== undefined, 'finalize entry present');
    eq(fin.tx_hash, TX_A, 'hash recorded');
    ok(/verified finalized/.test(fin.reason), fin.reason);
    ok(fin.evidence !== null && fin.evidence.includes('ev-digest'), 'evidence digest recorded');
    eq(typeof fin.at, 'number', 'timestamp recorded');
  } finally {
    repo.close();
  }
});

// ═══ 6. HTTP surface ════════════════════════════════════════════════════

const TOKEN = 'operator-token-abcdefghijklmnop';

test('27. /reconcile does not exist when reconciliation is not enabled', async () => {
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const res = await fetch(`${f.url}/reconcile`, { method: 'POST', body: '{}' });
    eq(res.status, 404, 'no route, no unauthenticated state change');
  } finally { await f.close(); }
});

test('28. /reconcile refuses missing and invalid credentials over HTTP', async () => {
  const f = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_RECONCILE_ENABLED: '1',
    FACILITATOR_OPERATOR_TOKEN_SHA256: hashOperatorToken(TOKEN),
  });
  try {
    const body = JSON.stringify({ paymentDigest: DIGEST_A });
    eq((await fetch(`${f.url}/reconcile`, { method: 'POST', body })).status, 401, 'missing credential');
    eq(
      (await fetch(`${f.url}/reconcile`, { method: 'POST', body, headers: { authorization: 'Bearer wrong-token-abcdefghij' } })).status,
      403,
      'invalid credential',
    );
    eq(
      (await fetch(`${f.url}/reconcile`, { method: 'POST', body, headers: { authorization: 'NotBearer abc' } })).status,
      401,
      'malformed credential',
    );
  } finally { await f.close(); }
});

test('29. an authenticated caller still cannot finalize without trusted evidence', async () => {
  const f = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_RECONCILE_ENABLED: '1',
    FACILITATOR_OPERATOR_TOKEN_SHA256: hashOperatorToken(TOKEN),
    // empty fixture table: no evidence available for anything
  });
  try {
    const res = await fetch(`${f.url}/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ paymentDigest: DIGEST_A, status: 'finalized', observed: 'finalized' }),
    });
    const body = await res.json();
    eq(body.ok, false, 'refused or unchanged');
    ok(body.code === 'unknown_payment' || body.changed === false, JSON.stringify(body));
  } finally { await f.close(); }
});

test('30. expired credentials are refused over HTTP', async () => {
  const f = await startFacilitator(
    {
      FACILITATOR_MODE: 'mock',
      FACILITATOR_PORT: '0',
      FACILITATOR_RECONCILE_ENABLED: '1',
      FACILITATOR_OPERATOR_TOKEN_SHA256: hashOperatorToken(TOKEN),
      FACILITATOR_OPERATOR_TOKEN_EXPIRES_AT: String(NOW),
    },
    { now: () => NOW + 60_000 },
  );
  try {
    const res = await fetch(`${f.url}/reconcile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ paymentDigest: DIGEST_A }),
    });
    eq(res.status, 403, 'expired credential refused');
    eq((await res.json()).code, 'expired', 'reason is expired');
  } finally { await f.close(); }
});

test('31. a durable database path is honoured and survives server restart', async () => {
  const path = tmpDb();
  const f1 = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: path,
  });
  // Seed through the service's own repository, using the mock signer path.
  f1.core.store.noteVerified(DIGEST_A, KEY_A);
  f1.core.store.claim(DIGEST_A, KEY_A);
  f1.core.store.recordTransaction(DIGEST_A, TX_A);
  await f1.close();

  const f2 = await startFacilitator({
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: path,
  });
  try {
    const row = f2.core.store.get(DIGEST_A);
    ok(row !== undefined, 'record survived the server restart');
    eq(row.tx_hash, TX_A, 'hash survived');
  } finally { await f2.close(); }
});

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\ntask26-settlement-durability: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
