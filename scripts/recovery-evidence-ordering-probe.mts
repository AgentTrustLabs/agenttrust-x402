/**
 * Independent probe — evidence ordering between concurrent recovery workers.
 *
 * Question: if two workers poll the SAME persisted hash and the transport answers
 * inconsistently (one `failed`, one `finalized`), which terminal state wins?
 *
 * This is NOT covered by the suite (test 03 uses a consistent `finalized`
 * answer from both children), and it is not a duplicate-submission hazard — so it is
 * a limitation probe, not a fix probe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { requirementsKey } from '../services/facilitator/src/store.js';
import type { SponsorSigner } from '../services/facilitator/src/signer.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const NOW = 1_800_000_000;
const DIGEST = 'c'.repeat(64);
const HASH = 'de'.repeat(32);

const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '250000', asset: 'CCD' },
  'agenttrust://resource/1004',
);

function signerWith(answers: Array<'finalized' | 'failed'>): SponsorSigner {
  let i = 0;
  return {
    info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
    addSponsorSignature: async (tx: unknown) => tx,
    submitTransaction: async () => {
      throw new Error('probe: recovery must never submit');
    },
    waitForFinalization: async (h: string) => {
      const a = answers[Math.min(i++, answers.length - 1)]!;
      return { txHash: h, status: a, sender: SPONSOR, simulated: true as const };
    },
    getAccountInfo: async () => ({ mocked: true }),
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 6,
  };
}

const dir = mkdtempSync(join(tmpdir(), 't53-probe-'));
const db = join(dir, 'f.db');

// Seed a broadcast-capable row with a durable hash.
const seed = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
seed.claim(DIGEST, REQ_KEY);
seed.prepare(DIGEST, HASH);
seed.claimSubmit(DIGEST, HASH);
seed.markBroadcast(DIGEST, HASH);
seed.close();

// Worker A: observes `failed` first and commits it.
const a = new FacilitatorCore({ network: CAIP2, signer: signerWith(['failed']), dbPath: db, now: () => NOW * 1000 });
const ra = await a.recoverPending();

// Worker B: observes `finalized` afterwards.
const b = new FacilitatorCore({ network: CAIP2, signer: signerWith(['finalized']), dbPath: db, now: () => NOW * 1000 });
const rb = await b.recoverPending();

const check = new SqliteSettlementRepository(db, { now: () => NOW * 1000 });
const row = check.get(DIGEST)!;
check.close();

const raw = new (await import('node:sqlite')).DatabaseSync(db, { readOnly: true });
const subs = raw.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT tx_hash) AS d FROM settlements').get() as { n: number; d: number };
raw.close();

console.log('worker A (observed failed)    ->', JSON.stringify(ra));
console.log('worker B (observed finalized) ->', JSON.stringify(rb));
console.log('final state                   ->', row.state, 'tx_hash=', row.tx_hash);
console.log('settlements rows              ->', subs.n, 'distinct hashes=', subs.d);

const onlyOneTerminal = row.state === 'rejected' || row.state === 'finalized';
const wrongButConsistent = row.state === 'rejected';
console.log('\nRESULT single terminal state:', onlyOneTerminal);
console.log('RESULT first observation wins (rejected is sticky):', wrongButConsistent);
console.log('RESULT duplicate settlement rows:', subs.n > 1);
console.log('RESULT hash renamed:', row.tx_hash !== HASH);

rmSync(dir, { recursive: true, force: true });
process.exit(0);
