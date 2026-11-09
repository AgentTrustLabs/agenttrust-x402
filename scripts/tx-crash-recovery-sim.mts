/**
 * TASK 28 — crash-recovery simulation using a locally precomputed transaction hash.
 *
 * Demonstrates the state machine from docs/architecture.md:
 *
 *   prepared --record hash--> prepared --claim--> submitting --(crash)--> outcome_unknown
 *   outcome_unknown --node says finalized--> finalized
 *   outcome_unknown --node says nothing--> outcome_unknown (NEVER resubmit)
 *
 * All chain evidence comes from a deterministic offline fixture. No network, no signing.
 *
 * Run: npx tsx scripts/tx-crash-recovery-sim.mts
 */

import {
  AccountTransactionV1,
  AccountAddress,
  Energy,
  AccountTransactionType,
  Payload,
} from '@concordium/web-sdk';
import { TransactionHash } from '@concordium/web-sdk/types';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ═══ local hash computation (same as tx-prehash) ═══════════════════

const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const buildTx = (nonce: bigint, amount: bigint, sponsorSig: string) => {
  const payload = {
    type: AccountTransactionType.Transfer,
    toAddress: AccountAddress.fromBase58(SENDER),
    amount: { microCcdAmount: amount },
  } as unknown as Payload.Type;
  const payloadSize = Payload.sizeOf(payload);
  const energyAmount = AccountTransactionV1.calculateEnergyCost(
    2n,
    payload,
    Energy.create(300n),
    { sponsor: true },
  );
  return {
    version: 1 as const,
    header: {
      expiry: { expiryEpochSeconds: 1900000000n },
      sender: AccountAddress.fromBase58(SENDER),
      nonce: { value: nonce },
      payloadSize,
      energyAmount,
      sponsor: AccountAddress.fromBase58(SPONSOR),
    },
    payload,
    signatures: {
      sender: { 0: { 0: 'aa'.repeat(64) } },
      sponsor: { 0: { 0: sponsorSig } },
    },
  } as unknown as AccountTransactionV1.Type;
};

const hashOf = (tx: AccountTransactionV1.Type) =>
  Buffer.from(AccountTransactionV1.getAccountTransactionHash(tx)).toString('hex');

// ═══ a minimal durable store — in-memory here, SQLite in the real service ═══

type State =
  | 'prepared'        // signed tx exists locally, hash persisted, never submitted
  | 'submitting'      // claim taken, submission in flight
  | 'outcome_unknown' // we broadcast but never recorded the result — the TASK 27 window
  | 'finalized'
  | 'rejected'
  | 'recovery_unavailable';

interface Record_ {
  paymentId: string;
  state: State;
  txHash: string;
  attempts: number;
  evidence: string | null;
}

class Store {
  rows = new Map<string, Record_>();
  write<T>(fn: () => T): T {
    return fn(); // real service: BEGIN IMMEDIATE ... COMMIT
  }
}

// ═══ deterministic offline "node" evidence ═════════════════════════════

type NodeAnswer =
  | { kind: 'finalized'; txHash: string }
  | { kind: 'committed'; txHash: string }
  | { kind: 'rejected'; txHash: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

const makeNode = (answers: Map<string, NodeAnswer>) => ({
  lookup(hash: string): NodeAnswer {
    return answers.get(hash) ?? { kind: 'not_found' };
  },
});

// ═══ the state machine under test ═══════════════════════════════════════

const prepare = (store: Store, paymentId: string, txHash: string): Record_ => {
  // Hash is persisted BEFORE any broadcast. This is the whole point: if we die next,
  // the identifier is already durable.
  if (store.rows.has(paymentId)) throw new Error('duplicate prepared record');
  const rec: Record_ = { paymentId, state: 'prepared', txHash, attempts: 0, evidence: null };
  store.write(() => store.rows.set(paymentId, rec));
  return rec;
};

const claim = (store: Store, paymentId: string): { ok: boolean; reason?: string } => {
  const rec = store.rows.get(paymentId);
  if (!rec) return { ok: false, reason: 'unknown_payment' };
  if (rec.state === 'finalized' || rec.state === 'rejected') return { ok: false, reason: rec.state };
  if (rec.state === 'prepared') {
    rec.state = 'submitting';
    return { ok: true };
  }
  // submitting / outcome_unknown / recovery_unavailable are all non-resubmittable
  return { ok: false, reason: `refused_${rec.state}` };
};

const simulateCrash = (store: Store, paymentId: string) => {
  // Broadcast happened; the process died before recording a result.
  // The hash is already durable, so the state is explicitly ambiguous.
  const rec = store.rows.get(paymentId)!;
  rec.state = 'outcome_unknown';
  rec.attempts += 1;
};

const reconcile = (store: Store, paymentId: string, node: ReturnType<typeof makeNode>): State => {
  const rec = store.rows.get(paymentId);
  if (!rec) return 'recovery_unavailable';
  if (rec.state === 'finalized' || rec.state === 'rejected') return rec.state;

  const answer = node.lookup(rec.txHash);

  switch (answer.kind) {
    case 'finalized':
      // Bind evidence to the EXACT recorded hash — a mismatch is refused.
      if (answer.txHash !== rec.txHash) {
        rec.state = 'outcome_unknown';
        return rec.state;
      }
      rec.state = 'finalized';
      rec.evidence = `finalized:${answer.txHash}`;
      return rec.state;
    case 'rejected':
      if (answer.txHash !== rec.txHash) {
        rec.state = 'outcome_unknown';
        return rec.state;
      }
      rec.state = 'rejected';
      rec.evidence = `rejected:${answer.txHash}`;
      return rec.state;
    case 'committed':
      // Committed is NOT final.
      return rec.state;
    case 'not_found':
      // CRITICAL: absence of evidence is not evidence of non-broadcast.
      return rec.state;
    case 'unavailable':
      return rec.state;
  }
};

// ═══ tests ═════════════════════════════════════════════════════════════

console.log('── A. hash is durable before any submission ──');
{
  const store = new Store();
  const tx = buildTx(7n, 250000n, 'bb'.repeat(64));
  const hash = hashOf(tx);
  const rec = prepare(store, 'pay-1', hash);
  check('hash persisted while still `prepared`', rec.state === 'prepared' && rec.txHash === hash, hash.slice(0, 16) + '…');
  check('zero submission attempts recorded', rec.attempts === 0);
  check('hash survives as the durable identifier', store.rows.get('pay-1')!.txHash === hash);
}

console.log('\n── B. crash after broadcast, before recording: recover by hash ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(7n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-2', hash);
  check('claim succeeds', claim(store, 'pay-2').ok);
  simulateCrash(store, 'pay-2');
  check('state is outcome_unknown, not success', store.rows.get('pay-2')!.state === 'outcome_unknown');

  // Recovery: the node has the transaction finalized. We KNOW the hash, so we can find it.
  const node = makeNode(new Map([[hash, { kind: 'finalized', txHash: hash }]]));
  const after = reconcile(store, 'pay-2', node);
  check('recovery reaches finalized using only the persisted hash', after === 'finalized');
  check('no second submission occurred', store.rows.get('pay-2')!.attempts === 1);
  check('evidence is bound to the exact hash', store.rows.get('pay-2')!.evidence === `finalized:${hash}`);
}

console.log('\n── C. a missing transaction is NOT proof it was never broadcast ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(8n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-3', hash);
  claim(store, 'pay-3');
  simulateCrash(store, 'pay-3');

  const node = makeNode(new Map()); // node knows nothing
  const after = reconcile(store, 'pay-3', node);
  check('not_found leaves the payment ambiguous', after === 'outcome_unknown');
  check('state was NOT converted to failed', store.rows.get('pay-3')!.state !== 'rejected');
  check('state was NOT converted to success', store.rows.get('pay-3')!.state !== 'finalized');

  // And crucially: it cannot be resubmitted.
  const reclaim = claim(store, 'pay-3');
  check('resubmission is refused', !reclaim.ok, reclaim.reason);
  check('still exactly one attempt', store.rows.get('pay-3')!.attempts === 1);
}

console.log('\n── D. committed is not final ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(9n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-4', hash);
  claim(store, 'pay-4');
  simulateCrash(store, 'pay-4');

  const node = makeNode(new Map([[hash, { kind: 'committed', txHash: hash }]]));
  const after = reconcile(store, 'pay-4', node);
  check('committed does not finalize', after === 'outcome_unknown');
  check('no evidence recorded for a non-final outcome', store.rows.get('pay-4')!.evidence === null);
}

console.log('\n── E. evidence bound to the wrong hash is refused ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(10n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-5', hash);
  claim(store, 'pay-5');
  simulateCrash(store, 'pay-5');

  // The verifier claims finalized but names a different transaction.
  const otherHash = hashOf(buildTx(11n, 250000n, 'bb'.repeat(64)));
  const node = makeNode(new Map([[hash, { kind: 'finalized', txHash: otherHash }]]));
  const after = reconcile(store, 'pay-5', node);
  check('hash mismatch refuses to finalize', after === 'outcome_unknown');
  check('the recorded hash was not overwritten', store.rows.get('pay-5')!.txHash === hash);
}

console.log('\n── F. restart does not enable a second submission ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(12n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-6', hash);
  claim(store, 'pay-6');
  simulateCrash(store, 'pay-6');

  // "Restart": a fresh claim attempt against the same durable row.
  const after1 = claim(store, 'pay-6');
  check('recovery-process claim is refused', !after1.ok, after1.reason);
  const after2 = claim(store, 'pay-6');
  check('repeated claims stay refused', !after2.ok, after2.reason);
  check('attempts never increased beyond the single broadcast', store.rows.get('pay-6')!.attempts === 1);
}

console.log('\n── G. finalized is terminal ──');
{
  const store = new Store();
  const hash = hashOf(buildTx(13n, 250000n, 'bb'.repeat(64)));
  prepare(store, 'pay-7', hash);
  claim(store, 'pay-7');
  simulateCrash(store, 'pay-7');
  const node = makeNode(new Map([[hash, { kind: 'finalized', txHash: hash }]]));
  reconcile(store, 'pay-7', node);

  check('terminal after finalization', store.rows.get('pay-7')!.state === 'finalized');
  check('cannot be claimed again', !claim(store, 'pay-7').ok);
  check('reconciling again is a no-op', reconcile(store, 'pay-7', node) === 'finalized');
  check('evidence unchanged by the repeat', store.rows.get('pay-7')!.evidence === `finalized:${hash}`);
}

console.log('\n── H. distinct payments have distinct hashes and independent state ──');
{
  const store = new Store();
  const h1 = hashOf(buildTx(14n, 250000n, 'bb'.repeat(64)));
  const h2 = hashOf(buildTx(14n, 250001n, 'bb'.repeat(64)));
  check('different amounts give different hashes', h1 !== h2);
  prepare(store, 'pay-a', h1);
  prepare(store, 'pay-b', h2);

  const node = makeNode(new Map([
    [h1, { kind: 'finalized', txHash: h1 }],
    [h2, { kind: 'not_found' }],
  ]));
  claim(store, 'pay-a');
  simulateCrash(store, 'pay-a');
  claim(store, 'pay-b');
  simulateCrash(store, 'pay-b');

  check('pay-a finalizes', reconcile(store, 'pay-a', node) === 'finalized');
  check('pay-b stays ambiguous', reconcile(store, 'pay-b', node) === 'outcome_unknown');
  check('independent attempt counts', store.rows.get('pay-a')!.attempts === 1 && store.rows.get('pay-b')!.attempts === 1);
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask28-recovery-sim: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
