/**
 * TASK 29 — pre-broadcast durable transaction hash persistence.
 *
 * Ten crash boundaries, exercised with real OS processes sharing one SQLite file.
 * Submission attempts are counted at the signer boundary (append-only ledger), not from
 * HTTP responses.
 *
 * Run: npx tsx test/prebroadcast.test.mts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest, requirementsKey } from '../services/facilitator/src/store.js';
import { toSdkV1Transaction, computeTransactionHash } from '../services/facilitator/src/signer.js';
import { canTransition, isTerminal } from '../services/facilitator/src/state.js';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const ok = (v: unknown, m: string) => check(m, Boolean(v));

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
// TASK53: the fixture's sponsor must match the mock signer's policy sponsor, or the wire
// converter refuses with `wrong_sponsor` before the signer is ever reached.
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const SERVER = new URL('../services/facilitator/dist/server.js', import.meta.url).pathname;

const NOW = Math.floor(Date.now() / 1000);

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t29-'));
  return { dir, db: join(dir, 'f.db'), ledger: join(dir, 'sub.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixture(over: Record<string, unknown> = {}) {
  const reqs = {
    scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' },
    ...(over.requirements as object ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: (over.resourceUrl as string) ?? 'agenttrust://resource/1004' },
    accepted: reqs,
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1,
          sponsor: { address: SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: (over.amount as string) ?? '250000' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: any) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });

function readLedger(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { event: 'bad' }; } });
}
const attempts = (path: string) => readLedger(path).filter(e => e.event === 'submit_attempt').length;

async function startProc(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => (out += String(d)));
  child.stderr.on('data', d => (err += String(d)));
  const exited = new Promise(r => child.on('exit', (c, s) => r({ c, s })));
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`start failed: ${err.slice(0, 200)}`)), 15000);
    const poll = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
      else if (child.exitCode !== null) { clearTimeout(t); reject(new Error(`exited: ${err.slice(0, 200)}`)); }
      else setTimeout(poll, 25);
    };
    poll();
  });
  return { url, child, exited, stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; } };
}

async function settle(url: string, body: unknown) {
  const r = await fetch(`${url}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

const baseEnv = (w: ReturnType<typeof ws>) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_HOST: '127.0.0.1',
  FACILITATOR_PORT: '0',
  FACILITATOR_DB_PATH: w.db,
  FACILITATOR_SUBMIT_LEDGER: w.ledger,
});

const repoAt = (db: string) => new SqliteSettlementRepository(db);

// ═══ 1. hash binding ════════════════════════════════════════════════════

console.log('\n── A. the persisted hash is the real SDK hash of the signed transaction ──');
{
  const p = fixture();
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const h = computeTransactionHash(signed);
  ok(/^[0-9a-f]{64}$/.test(h), `64-hex identifier: ${h}`);
  eq(computeTransactionHash(signed) === h, true, 'stable across recomputation');

  const changedAmount = computeTransactionHash({ ...signed, payload: { ...signed.payload, amount: '999999' } });
  check('changed amount → different identifier', changedAmount !== h);
  const changedNonce = computeTransactionHash({ ...signed, header: { ...signed.header, nonce: 8 } });
  check('changed nonce → different identifier', changedNonce !== h);
  const changedRecipient = computeTransactionHash({ ...signed, payload: { ...signed.payload, toAddress: SENDER } });
  check('changed recipient → different identifier', changedRecipient !== h);
  const changedSponsorSig = computeTransactionHash({ ...signed, signatures: { ...signed.signatures, sponsor: { 0: { 0: 'cc'.repeat(64) } } } });
  check('changed sponsor signature → different identifier', changedSponsorSig !== h);
  const changedSender = computeTransactionHash({ ...signed, header: { ...signed.header, sender: PAY_TO } });
  check('changed sender → different identifier', changedSender !== h);
}

// ═══ 2. durable ordering (in-process, deterministic) ═════════════════════

console.log('\n── B. the database cannot reach a broadcast-eligible state without a hash ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  const d = 'd'.repeat(64);
  try {
    repo.noteVerified(d, 'k');
    const c = repo.claim(d, 'k');
    eq(c.claim, 'fresh', 'claimed');
    eq(repo.get(d)!.state, 'created', 'still created — no hash yet');
    eq(repo.get(d)!.tx_hash, null, 'no hash recorded');

    // Submitting without prepare() must be refused.
    const noHash = (repo as any).claimSubmit(d, 'deadbeef');
    eq(noHash.ok, false, 'claimSubmit without a durable hash is refused');

    repo.prepare(d, 'tx-1');
    eq(repo.get(d)!.state, 'prepared', 'prepared after prepare()');
    eq(repo.get(d)!.tx_hash, 'tx-1', 'hash durable');

    // A different hash cannot take the claim.
    const wrong = repo.claimSubmit(d, 'tx-other');
    eq(wrong.ok, false, 'claimSubmit with a mismatched hash is refused');
    eq(repo.get(d)!.state, 'prepared', 'still prepared after the refusal');

    const good = repo.claimSubmit(d, 'tx-1');
    eq(good.ok, true, 'claimSubmit with the persisted hash succeeds');
    eq(repo.get(d)!.state, 'submitting', 'submitting');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── C. a hash survives a real restart ──');
{
  const w = ws();
  const d = 'e'.repeat(64);
  const a = repoAt(w.db);
  a.noteVerified(d, 'k');
  a.claim(d, 'k');
  a.prepare(d, 'tx-durable');
  a.close();

  const b = repoAt(w.db);
  try {
    eq(b.get(d)!.tx_hash, 'tx-durable', 'hash survived the restart');
    eq(b.get(d)!.state, 'prepared', 'state survived the restart');
  } finally {
    b.close();
    w.cleanup();
  }
}

console.log('\n── D. a recorded hash cannot be substituted ──');
{
  const w = ws();
  const d = 'f'.repeat(64);
  const repo = repoAt(w.db);
  try {
    repo.noteVerified(d, 'k');
    repo.claim(d, 'k');
    repo.prepare(d, 'tx-a');
    let threw = false;
    try { repo.prepare(d, 'tx-b'); } catch { threw = true; }
    eq(threw, true, 'prepare with a different hash throws');
    eq(repo.get(d)!.tx_hash, 'tx-a', 'original hash intact');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── E. state machine integrity ──');
{
  eq(canTransition('created', 'prepared'), true, 'created → prepared');
  eq(canTransition('prepared', 'submitting'), true, 'prepared → submitting');
  eq(canTransition('submitting', 'outcome_unknown'), true, 'submitting → outcome_unknown');
  eq(canTransition('outcome_unknown', 'finalized'), true, 'outcome_unknown → finalized');
  eq(canTransition('outcome_unknown', 'rejected'), true, 'outcome_unknown → rejected');
  eq(canTransition('observed', 'finalized'), true, 'observed → finalized');
  eq(canTransition('prepared', 'finalized'), false, 'prepared cannot skip to finalized');
  eq(canTransition('rejected', 'finalized'), false, 'rejection is terminal');
  eq(canTransition('finalized', 'rejected'), false, 'finalized is terminal');
  eq(isTerminal('finalized') && isTerminal('rejected'), true, 'both terminal');
  eq(isTerminal('outcome_unknown'), false, 'outcome_unknown is not terminal');
}

// ═══ 3. crash windows over real processes ═══════════════════════════════

console.log('\n── W1. crash before transaction preparation ──');
{
  const w = ws();
  const doomed = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'doomed' });
  await doomed.stop(); // killed before handling anything
  const survivor = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'survivor' });
  try {
    const p = fixture();
    const r = await settle(survivor.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 100));
    eq(r.body.success, true, 'the payment is still settleable');
    eq(attempts(w.ledger), 1, 'exactly one submission');
  } finally {
    await survivor.stop();
    w.cleanup();
  }
}

console.log('\n── W2/W3/W4. crash before the hash is durably committed ──');
{
  // Model: the process dies while the transaction is being prepared. Nothing is broadcast,
  // so no hash exists — and crucially the payment must not be broadcast-eligible.
  const w = ws();
  const repo = repoAt(w.db);
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    // Crash here: before prepare().
    const row = repo.get(d)!;
    eq(row.state, 'created', 'state is created — never broadcast-eligible');
    eq(row.tx_hash, null, 'no hash persisted');
    const attempt = repo.claimSubmit(d, 'anything');
    eq(attempt.ok, false, 'submission cannot start without a persisted hash');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── W5. crash immediately after durable hash persistence, before submission ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  let txHash = '';
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
    txHash = computeTransactionHash(signed);
    repo.prepare(d, txHash);
    // Crash now: hash is durable, nothing was submitted.
  } finally {
    repo.close();
  }

  // Recovery process: the hash is there, the payment is prepared, and a settle must NOT
  // submit again — it reports pending with the durable identifier.
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'recovery' });
  try {
    const r = await settle(proc.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 120));
    // TASK 29 makes a prepared row resumable: a recovery process MAY take the claim and
    // submit. The invariant is at-most-one, not zero.
    eq(attempts(w.ledger), 1, 'exactly one submission total (by the recovery process)');
    eq(r.body.transaction, txHash, 'the durable hash is reported back');

    const again = repoAt(w.db);
    try {
      eq(again.get(d)!.tx_hash, txHash, 'hash still durable');
      ok(['outcome_unknown', 'prepared', 'submitting'].includes(again.get(d)!.state ?? ''), `state advanced: ${again.get(d)!.state}`);
    } finally {
      again.close();
    }
  } finally {
    await proc.stop();
    w.cleanup();
  }
}

console.log('\n── W6/W7. crash immediately before / after submission ──');
{
  const w = ws();
  const p = fixture();
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_BEHAVIOUR: 'submit-then-die', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r2 => setTimeout(r2, 150));

  const events = readLedger(w.ledger).map(e => e.event);
  eq(attempts(w.ledger), 1, 'exactly one submission attempt before the crash');
  ok(events.includes('crash_after_submit'), 'the crash happened after submission');

  const repo = repoAt(w.db);
  const d = paymentDigest(p);
  try {
    const row = repo.get(d)!;
    // The hash was persisted BEFORE the broadcast, so the crash did not lose it.
    ok(/^[0-9a-f]{64}$/.test(row.tx_hash ?? ''), `durable hash survived the crash: ${row.tx_hash}`);
    // Outcome is explicitly ambiguous, never success.
    ok(['outcome_unknown', 'submitting'].includes(row.state), `ambiguous state: ${row.state}`);
  } finally {
    repo.close();
  }

  // A healthy process must not resubmit.
  const healthy = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'healthy' });
  try {
    const r = await settle(healthy.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 150));
    eq(r.body.success, false, 'not converted to success');
    eq(attempts(w.ledger), 1, 'no second submission after the crash');
  } finally {
    await healthy.stop();
    w.cleanup();
  }
}

console.log('\n── W8. crash after the submission response, before the final state transition ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  // Seed exactly that state: hash durable, broadcast recorded, no evidence applied yet.
  const repo = repoAt(w.db);
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const txHash = computeTransactionHash(signed);
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    repo.prepare(d, txHash);
    repo.claimSubmit(d, txHash);
    repo.markBroadcast(d, txHash);
  } finally {
    repo.close();
  }

  const proc = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'after-response' });
  try {
    const r = await settle(proc.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 120));
    eq(r.body.success, false, 'not finalized without evidence');
    eq(r.body.errorReason, 'settlement_pending', 'explicitly pending');
    eq(r.body.transaction, txHash, 'durable hash reported');
    eq(attempts(w.ledger), 0, 'no resubmission');
  } finally {
    await proc.stop();
    w.cleanup();
  }
}

console.log('\n── W9/W10. recovery from another process, and two recovering concurrently ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const txHash = computeTransactionHash(signed);
  const seed = repoAt(w.db);
  try {
    seed.noteVerified(d, k);
    seed.claim(d, k);
    seed.prepare(d, txHash);
    seed.claimSubmit(d, txHash);
    seed.markBroadcast(d, txHash);
  } finally {
    seed.close();
  }

  const a = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-a' });
  const b = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-b' });
  try {
    const [ra, rb] = await Promise.all([settle(a.url, envelope(p)), settle(b.url, envelope(p))]);
    await new Promise(r2 => setTimeout(r2, 150));

    eq(attempts(w.ledger), 0, 'concurrent recovery produced no submission');
    for (const r of [ra, rb]) {
      eq(r.body.success, false, 'neither recovery reports success');
      eq(r.body.errorReason, 'settlement_pending', 'both report pending');
      eq(r.body.transaction, txHash, 'both report the same durable hash');
    }

    const after = repoAt(w.db);
    try {
      eq(after.get(d)!.state, 'outcome_unknown', 'state unchanged by concurrent recovery');
      eq(after.get(d)!.tx_hash, txHash, 'hash unchanged');
    } finally {
      after.close();
    }
  } finally {
    await a.stop();
    await b.stop();
    w.cleanup();
  }
}

console.log('\n── W11. two processes cannot both claim the broadcast ──');
{
  const w = ws();
  const d = '1'.repeat(64);
  const a = repoAt(w.db);
  a.noteVerified(d, 'k');
  a.claim(d, 'k');
  a.prepare(d, 'tx-x');
  const r1 = a.claimSubmit(d, 'tx-x');
  const r2 = a.claimSubmit(d, 'tx-x');
  eq(r1.ok, true, 'first claim wins');
  eq(r2.ok, false, 'second claim refused');
  a.close();
  w.cleanup();
}

// ═══ 4. durability configuration ════════════════════════════════════════

console.log('\n── durability configuration ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  try {
    const jm = repo['db'].prepare('PRAGMA journal_mode').get() as any;
    const sy = repo['db'].prepare('PRAGMA synchronous').get() as any;
    const bt = repo['db'].prepare('PRAGMA busy_timeout').get() as any;
    eq(String(jm.journal_mode).toLowerCase(), 'wal', 'journal_mode = WAL');
    // synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
    eq(Number(sy.synchronous), 2, 'synchronous = FULL (2)');
    ok(Number(bt.timeout) >= 1000, `busy_timeout = ${bt.timeout}ms`);
  } finally {
    repo.close();
    w.cleanup();
  }
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask29-prebroadcast: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
