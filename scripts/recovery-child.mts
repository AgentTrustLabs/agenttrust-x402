/**
 * Recovery child: opens a shared DB and runs `core.recoverPending()`.
 *
 * Usage: tsx scripts/recovery-child.mts <dbPath> <ledgerPath>
 * Prints one JSON line: {"scanned":N,"finalized":N,...,"submitAttempts":N}
 */
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { readFileSync, existsSync } from 'node:fs';

const [, , dbPath, ledgerPath] = process.argv;
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_800_000_000;

const signer = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
const inner = signer;
const wrapped = {
  info: () => ({ ...inner.info(), address: SPONSOR }),
  addSponsorSignature: inner.addSponsorSignature,
  submitTransaction: async (tx: unknown) => {
    // Recovery must never submit; record any attempt as evidence.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(ledgerPath!, JSON.stringify({ event: 'submit_attempt', pid: process.pid }) + '\n');
    throw new Error('recovery attempted submission — forbidden');
  },
  waitForFinalization: async (h: string) => ({ txHash: h, status: 'finalized' as const, sender: SPONSOR, simulated: true as const }),
  getAccountInfo: inner.getAccountInfo,
  getTokenBalance: inner.getTokenBalance,
  getTokenDecimals: inner.getTokenDecimals,
};

const store = new SqliteSettlementRepository(dbPath!, { now: () => NOW * 1000 });
const core = new FacilitatorCore({
  network: NETWORK,
  signer: wrapped as never,
  store,
  now: () => NOW * 1000,
});

const summary = await core.recoverPending();
let submitAttempts = 0;
if (existsSync(ledgerPath!)) {
  submitAttempts = readFileSync(ledgerPath!, 'utf8').split('\n').filter(l => l.includes('"submit_attempt"')).length;
}
console.log(JSON.stringify({ ...summary, submitAttempts }));
store.close();
