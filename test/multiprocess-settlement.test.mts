/**
 * TASK 27 — multi-process settlement concurrency and exactly-once submission.
 *
 * Four real facilitator OS processes, one SQLite database, one shared submission ledger.
 * Submission attempts are counted at the signer boundary inside each process, so the numbers
 * below are actual calls to `submitTransaction`, not HTTP responses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import {
  startCluster,
  startProcess,
  workspace,
  readLedger,
  submitAttempts,
  payloadFixture,
  envelope,
  settle,
  verify,
} from './lib/facilitator-harness.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const outcomes = result => result.body?.errorReason ?? result.body?.success;

// ═══ 1. end-to-end multi-process exactly-once ═══════════════════════════

test('01. four processes, one payment, concurrent settle → exactly one submission', async () => {
  const cluster = await startCluster(4);
  try {
    const p = payloadFixture();
    const body = envelope(p, p.accepted);

    // Fire all four at once.
    const results = await Promise.all(cluster.urls.map(url => settle(url, body)));
    await new Promise(r => setTimeout(r, 150)); // let every process finish writing the ledger

    const attempts = cluster.attempts();
    const ledger = cluster.ledger();
    console.log(
      `      processes=${cluster.urls.length} concurrent_requests=${results.length} submit_attempts=${attempts}`,
    );
    console.log(`      responses: ${JSON.stringify(results.map(r => outcomes(r)))}`);
    console.log(`      ledger pids: ${JSON.stringify([...new Set(ledger.map(e => e.pid))])}`);

    eq(attempts, 1, 'exactly one submission attempt across all four processes');
    eq(results.length, 4, 'four responses');

    // Every process legitimately reports *a* result for the same payment. What must never
    // happen is a second submission or a second hash. Idempotent replay is a correct answer,
    // not a duplicate: `idempotent:true` means "this process found the existing settlement".
    const nonIdempotentSuccess = results.filter(r => r.body?.success === true && r.body?.extra?.idempotentReplay !== true);
    eq(nonIdempotentSuccess.length, 1, 'exactly one process performed the settlement itself');
    for (const r of results) {
      const settledByMe = r.body?.success === true && r.body?.extra?.idempotentReplay !== true;
      const idempotent = r.body?.success === true && r.body?.extra?.idempotentReplay === true;
      const refused = r.body?.success === false;
      ok(settledByMe || idempotent || refused, `every response is settled/idempotent/refused: ${outcomes(r)}`);
      if (refused) {
        ok(
          ['settle_in_progress', 'settlement_pending', 'settle_refused'].includes(String(r.body?.errorReason)),
          `refusal reason is legitimate: ${r.body?.errorReason}`,
        );
      }
    }
    // Exactly one distinct hash: no second submission produced a second hash.
    const hashes = new Set(results.map(r => r.body?.transaction).filter(Boolean));
    eq(hashes.size, 1, `one distinct transaction hash (got ${[...hashes].join(',')})`);
  } finally {
    await cluster.stopAll();
  }
});

test('02. all processes observe the same durable state afterwards', async () => {
  const cluster = await startCluster(4);
  try {
    const p = payloadFixture();
    const body = envelope(p, p.accepted);
    await Promise.all(cluster.urls.map(url => settle(url, body)));
    await new Promise(r => setTimeout(r, 150));

    // A repeat settle against every process must now report the same hash idempotently.
    const repeats = await Promise.all(cluster.urls.map(url => settle(url, body)));
    const hashes = new Set(repeats.map(r => r.body?.transaction).filter(Boolean));
    eq(hashes.size, 1, 'every process returns the same recorded hash');
    eq(repeats.every(r => r.body?.success === true), true, 'all report the settled result');
    eq(cluster.attempts(), 1, 'no process submitted again');
  } finally {
    await cluster.stopAll();
  }
});

// ═══ 2. distinct payment controls ═══════════════════════════════════════

test('03. different payments are processed independently', async () => {
  const cluster = await startCluster(4);
  try {
    // A genuinely different payment differs in what the payer SIGNED (the transaction body),
    // not merely in the client's restatement of it. The accepted amount must match the signed
    // amount: the facilitator binds the recorded amount to the signed transaction, so a
    // self-inconsistent fixture (signed 500000, accepted 250000) is refused, not settled.
    const a = payloadFixture();
    const b = payloadFixture({ signedOver: { amount: '500000', nonce: 8 }, accepted: { amount: '500000' } });

    const results = await Promise.all([
      settle(cluster.urls[0], envelope(a, a.accepted)),
      settle(cluster.urls[1], envelope(b, b.accepted)),
      settle(cluster.urls[2], envelope(a, a.accepted)),
      settle(cluster.urls[3], envelope(b, b.accepted)),
    ]);
    await new Promise(r => setTimeout(r, 150));

    eq(cluster.attempts(), 2, 'two distinct payments ⇒ two submissions');
    const hashes = new Set(results.map(r => r.body?.transaction).filter(Boolean));
    eq(hashes.size, 2, 'two distinct transaction hashes');
  } finally {
    await cluster.stopAll();
  }
});

test('04. the same payment for a different resource is rejected as replay', async () => {
  const cluster = await startCluster(2);
  try {
    const p = payloadFixture();
    await settle(cluster.urls[0], envelope(p, p.accepted));

    const samePaymentOtherResource = { ...p, resource: { url: 'agenttrust://resource/OTHER' } };
    const replay = await settle(cluster.urls[1], envelope(samePaymentOtherResource, p.accepted));
    eq(replay.body?.success, false, 'refused');
    ok(
      replay.body?.errorReason === 'settle_in_progress' ||
        replay.body?.errorReason === 'settlement_pending' ||
        /different authorisation/.test(String(replay.body?.errorMessage)),
      `replay refused: ${replay.body?.errorReason}`,
    );
    eq(cluster.attempts(), 1, 'no second submission');
  } finally {
    await cluster.stopAll();
  }
});

test('05. altered amount, asset, network or recipient do not pay the same payment twice', async () => {
  const variants = [
    ['amount', { amount: '999999' }],
    ['asset', { asset: 'USDR' }],
    ['recipient', { payTo: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8' }],
    ['network', { network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' }],
  ];
  for (const [label, override] of variants) {
    const cluster = await startCluster(2);
    try {
      const p = payloadFixture();
      await settle(cluster.urls[0], envelope(p, p.accepted));

      // CRITICAL CASE: the same *signed transaction*, with only the client-restated
      // `accepted` object altered. If identity were keyed on `accepted`, this would produce a
      // new digest and a second submission — the defect reproduced and fixed in TASK 27.
      const forged = { ...p, accepted: { ...p.accepted, ...override } };
      const res = await settle(cluster.urls[1], envelope(forged, forged.accepted));
      await new Promise(r => setTimeout(r, 100));
      eq(res.body?.success, false, `${label}: same signed payment with altered accepted is refused`);
      eq(cluster.attempts(), 1, `${label}: still exactly one submission`);
    } finally {
      await cluster.stopAll();
    }
  }
});

test('06. repeated requests after completion return the original idempotent result', async () => {
  const cluster = await startCluster(3);
  try {
    const p = payloadFixture();
    const first = await settle(cluster.urls[0], envelope(p, p.accepted));
    await new Promise(r => setTimeout(r, 100));
    const hash = first.body?.transaction;
    ok(hash, 'first has a hash');

    for (let i = 0; i < 3; i++) {
      const again = await settle(cluster.urls[i % 3], envelope(p, p.accepted));
      eq(again.body?.success, true, `repeat ${i}: settled`);
      eq(again.body?.transaction, hash, `repeat ${i}: same hash`);
      eq(again.body?.extra?.idempotentReplay, true, `repeat ${i}: flagged idempotent`);
    }
    eq(cluster.attempts(), 1, 'still exactly one submission');
  } finally {
    await cluster.stopAll();
  }
});

test('07. restarting a process does not permit another submission', async () => {
  const ws = workspace();
  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  // Build the payload ONCE. `payloadFixture()` derives its expiry from the current second, so
  // calling it twice can yield two different signed transactions — which are genuinely two
  // different payments. Reusing one body is what makes this a restart test rather than a
  // "two payments" test.
  const p = payloadFixture();
  const body = envelope(p, p.accepted);

  const a = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'first' });
  try {
    await settle(a.url, body);
    await new Promise(r => setTimeout(r, 100));
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'one submission before restart');
  } finally {
    await a.stop();
  }

  const b = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'second' });
  try {
    const after = await settle(b.url, body);
    await new Promise(r => setTimeout(r, 100));

    eq(after.body?.success, true, 'the restarted process sees the settlement');
    eq(after.body?.extra?.idempotentReplay, true, 'as an idempotent replay');
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'restart did not permit another submission');
  } finally {
    await b.stop();
    ws.cleanup();
  }
});

// ═══ 3. crash windows ═══════════════════════════════════════════════════

test('08. crash before claiming: no claim, payment still fresh for the next process', async () => {
  const ws = workspace();
  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  // A process that is killed before it ever handles a request.
  const doomed = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'doomed' });
  await doomed.stop(); // killed with SIGKILL while idle

  const survivor = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'survivor' });
  try {
    const p = payloadFixture();
    const res = await settle(survivor.url, envelope(p, p.accepted));
    await new Promise(r => setTimeout(r, 100));
    eq(res.body?.success, true, 'the payment is still settleable');
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'exactly one submission, by the survivor');
  } finally {
    await survivor.stop();
    ws.cleanup();
  }
});

test('09. crash after claim but before submission: payment stays pending, never resubmitted', async () => {
  // Force the window by claims-only: claim the payment, then never submit.
  const ws = workspace();
  const { SqliteSettlementRepository } = await import('../services/facilitator/src/repository.js');
  const { paymentDigest, requirementsKey } = await import('../services/facilitator/src/store.js');
  const repo = new SqliteSettlementRepository(ws.db);
  const p = payloadFixture();
  const digest = paymentDigest(p);
  const reqKey = requirementsKey(p.accepted, p.resource.url);
  repo.noteVerified(digest, reqKey);
  eq(repo.claim(digest, reqKey).claim, 'fresh', 'claimed');
  // Simulate the crash here: no submission, no state change beyond the claim.
  repo.close();

  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  const next = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'after-crash' });
  try {
    const res = await settle(next.url, envelope(p, p.accepted));
    await new Promise(r => setTimeout(r, 100));
    eq(res.body?.success, false, 'not reported as settled');
    ok(
      res.body?.errorReason === 'sellte_in_progress' ||
        res.body?.errorReason === 'settle_in_progress' ||
        res.body?.errorReason === 'settlement_pending',
      `refused: ${res.body?.errorReason}`,
    );
    eq(submitAttempts(readLedger(ws.ledger)), 0, 'the recovering process did NOT submit');
  } finally {
    await next.stop();
    ws.cleanup();
  }
});

test('10. submission adapter throws: pending recorded, no retry by another process', async () => {
  // Both processes have a THROWING submission adapter, so a retry would be visible as a
  // second ledger entry.
  const cluster = await startCluster(2, { FACILITATOR_BEHAVIOUR: 'submit-throws' });
  try {
    const p = payloadFixture();
    const body = envelope(p, p.accepted);
    const results = await Promise.all(cluster.urls.map(u => settle(u, body)));
    await new Promise(r => setTimeout(r, 200));

    console.log(`      throwing adapter: submit_attempts=${cluster.attempts()} responses=${JSON.stringify(results.map(r => r.body?.errorReason ?? r.body?.success))}`);

    eq(cluster.attempts(), 1, 'the throwing adapter was called exactly once');
    eq(results.filter(r => r.body?.success === true).length, 0, 'nothing was reported as settled');
    for (const r of results) {
      eq(r.body?.success, false, 'every response is a failure');
      // Both are correct non-success outcomes and the difference is pure timing: the losing
      // process either observes the claim still in flight (`settle_in_progress`) or observes
      // the recorded pending row. Neither may be `failed` — a throw is ambiguous, and
      // ambiguity must not be recorded as terminal failure.
      ok(
        ['settle_in_progress', 'settlement_pending'].includes(String(r.body?.errorReason)),
        `non-terminal refusal: ${r.body?.errorReason}`,
      );
    }

    // And a later, WELL-BEHAVED process on the same database must not resubmit it either.
    const healthy = await startProcess({
      FACILITATOR_MODE: 'mock',
      FACILITATOR_HOST: '127.0.0.1',
      FACILITATOR_PORT: '0',
      FACILITATOR_DB_PATH: cluster.ws.db,
      FACILITATOR_SUBMIT_LEDGER: cluster.ws.ledger,
      FACILITATOR_PROCESS_LABEL: 'healthy',
    });
    try {
      const retry = await settle(healthy.url, envelope(p, p.accepted));
      await new Promise(r => setTimeout(r, 150));
      eq(retry.body?.success, false, 'the healthy process does not settle it');
      eq(retry.body?.errorReason, 'settlement_pending', 'still pending for reconciliation');
      eq(cluster.attempts(), 1, 'no resubmission after a throwing adapter');
    } finally {
      await healthy.stop();
    }
  } finally {
    await cluster.stopAll();
  }
});

test('11. an ambiguous outcome stays pending across processes and is never resubmitted', async () => {
  const ws = workspace();
  const { SqliteSettlementRepository } = await import('../services/facilitator/src/repository.js');
  const { paymentDigest, requirementsKey } = await import('../services/facilitator/src/store.js');
  const p = payloadFixture();
  const digest = paymentDigest(p);
  const reqKey = requirementsKey(p.accepted, p.resource.url);

  // Seed an explicitly pending payment with a recorded hash, as a crash post-broadcast would.
  const repo = new SqliteSettlementRepository(ws.db);
  repo.noteVerified(digest, reqKey);
  repo.claim(digest, reqKey);
  repo.prepare(digest, 'simulated-ambiguous-hash');
  repo.claimSubmit(digest, 'simulated-ambiguous-hash');
  repo.markBroadcast(digest, 'simulated-ambiguous-hash');
  repo.close();

  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  const a = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'a' });
  const b = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'b' });
  try {
    const body = envelope(p, p.accepted);
    const results = await Promise.all([settle(a.url, body), settle(b.url, body)]);
    await new Promise(r => setTimeout(r, 150));

    eq(submitAttempts(readLedger(ws.ledger)), 0, 'no process resubmitted the ambiguous payment');
    for (const r of results) {
      eq(r.body?.success, false, 'not converted to success');
      eq(r.body?.errorReason, 'settlement_pending', 'explicitly pending');
      eq(r.body?.extra?.nonTerminal, true, 'marked non-terminal');
    }
  } finally {
    await a.stop();
    await b.stop();
    ws.cleanup();
  }
});

test('12. a killed process does not release a consumed payment identifier', async () => {
  const ws = workspace();
  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  const first = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'first' });
  const p = payloadFixture();
  const body = envelope(p, p.accepted);
  await settle(first.url, body);
  await new Promise(r => setTimeout(r, 100));
  eq(submitAttempts(readLedger(ws.ledger)), 1, 'one submission');
  await first.stop(); // hard kill

  const second = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'second' });
  try {
    const res = await settle(second.url, body);
    await new Promise(r => setTimeout(r, 100));
    eq(res.body?.success, true, 'still recognised as settled');
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'the identifier was not released by the kill');
  } finally {
    await second.stop();
    ws.cleanup();
  }
});

test('13. recovery after a crash generates no second submission', async () => {
  const ws = workspace();
  const { SqliteSettlementRepository } = await import('../services/facilitator/src/repository.js');
  const { paymentDigest, requirementsKey } = await import('../services/facilitator/src/store.js');
  const p = payloadFixture();
  const digest = paymentDigest(p);
  const reqKey = requirementsKey(p.accepted, p.resource.url);

  const repo = new SqliteSettlementRepository(ws.db);
  repo.noteVerified(digest, reqKey);
  repo.claim(digest, reqKey);
  repo.prepare(digest, 'simulated-crashed-hash');
  repo.claimSubmit(digest, 'simulated-crashed-hash');
  repo.markBroadcast(digest, 'simulated-crashed-hash');
  // Crash before the finalized evidence was applied.
  repo.close();

  // Now a recovered process reconciles with verified evidence: it must finalize WITHOUT
  // submitting, and the ledger must stay empty.
  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  const recovered = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'recovered' });
  try {
    const res = await settle(recovered.url, envelope(p, p.accepted));
    await new Promise(r => setTimeout(r, 100));
    eq(res.body?.success, false, 'still pending — settle does not finalize');
    eq(submitAttempts(readLedger(ws.ledger)), 0, 'recovery produced no submission');

    // The status is readable and still pending.
    eq(res.body?.errorReason, 'settlement_pending', 'explicitly pending for reconciliation');
  } finally {
    await recovered.stop();
    ws.cleanup();
  }
});

// ═══ 4. storage / lock review ═══════════════════════════════════════════

/**
 * TEST 13b — the true crash window: submitTransaction succeeded, process died before
 * recordTransaction. The payment is claimed but has no recorded hash.
 *
 * This is the one window that cannot be closed by a local database alone, and the test proves
 * the behaviour is still safe: the payment stays non-terminal and nobody re-submits it.
 */
test('13b. crash between submit and record: stays pending, no re-submit', async () => {
  const ws = workspace();
  const env = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_HOST: '127.0.0.1',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: ws.db,
    FACILITATOR_SUBMIT_LEDGER: ws.ledger,
  };
  const p = payloadFixture();
  const body = envelope(p, p.accepted);

  // This process is configured to submit successfully and then SIGKILL itself before the
  // hash can be durably recorded — the exact window in question.
  const first = await startProcess({
    ...env,
    FACILITATOR_BEHAVIOUR: 'submit-then-die',
    FACILITATOR_PROCESS_LABEL: 'first',
  });
  await settle(first.url, body).catch(() => ({ status: 0, body: {} }));
  await first.exited; // the process really did die mid-request
  await new Promise(r => setTimeout(r, 150));

  const events = readLedger(ws.ledger).map(e => e.event);
  eq(submitAttempts(readLedger(ws.ledger)), 1, 'one submission before the crash');
  eq(submitAttempts(readLedger(ws.ledger)), 1, 'one submission before the crash');
  ok(events.includes('crash_after_submit'), 'the crash happened after submission, before recording');

  const second = await startProcess({ ...env, FACILITATOR_PROCESS_LABEL: 'second' });
  try {
    const res = await settle(second.url, body);
    await new Promise(r => setTimeout(r, 150));
    eq(res.body?.success, false, 'not silently converted to success');
    // The row is claimed but holds NO recorded hash, so the guard reports in-progress rather
    // than pending. Both are non-terminal; neither is success. This is the documented limit:
    // the payment becomes unreconcilable because there is no hash to bind evidence to.
    ok(
      ['settle_in_progress', 'settlement_pending'].includes(String(res.body?.errorReason)),
      `non-terminal: ${res.body?.errorReason}`,
    );
    // TASK 29 CLOSES this window: the hash is now persisted BEFORE the broadcast, so after
    // the crash the payment still carries a durable identifier and can be reconciled.
    ok(/^[0-9a-f]{64}$/.test(res.body?.transaction ?? ''), `durable hash survived the crash: ${res.body?.transaction}`);
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'no second submission after the crash');

    // Repeating the request still cannot produce a submission: the identifier stays consumed.
    const again = await settle(second.url, body);
    await new Promise(r => setTimeout(r, 100));
    eq(again.body?.success, false, 'still not settled on retry');
    eq(submitAttempts(readLedger(ws.ledger)), 1, 'still exactly one attempt ever');
  } finally {
    await second.stop();
    ws.cleanup();
  }
  });

test('14. busy_timeout is configured so contending writers wait instead of failing instantly', async () => {
  const { SqliteSettlementRepository } = await import('../services/facilitator/src/repository.js');
  const ws = workspace();
  const repo = new SqliteSettlementRepository(ws.db);
  try {
    const row = repo['db'].prepare('PRAGMA busy_timeout').get();
    ok(Number(row.timeout) >= 1000, `busy_timeout is ${row.timeout}ms`);
  } finally {
    repo.close();
    ws.cleanup();
  }
});

test('15. eight processes contending on one payment still produce one submission', async () => {
  const cluster = await startCluster(8);
  try {
    const p = payloadFixture();
    const body = envelope(p, p.accepted);
    const results = await Promise.all(cluster.urls.map(u => settle(u, body)));
    await new Promise(r => setTimeout(r, 200));

    console.log(
      `      processes=${cluster.urls.length} concurrent_requests=${results.length} submit_attempts=${cluster.attempts()}`,
    );
    eq(cluster.attempts(), 1, 'exactly one submission across eight processes');
    eq(
      results.filter(r => r.body?.success === true && r.body?.extra?.idempotentReplay !== true).length,
      1,
      'exactly one process performed the settlement',
    );
    eq(new Set(results.map(r => r.body?.transaction).filter(Boolean)).size, 1, 'one distinct hash');
  } finally {
    await cluster.stopAll();
  }
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
console.log(`\ntask27-multiprocess-settlement: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
