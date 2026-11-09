/**
 * TASK 51 — crash-window child process (real SIGKILL, mock transport only).
 *
 * Mirrors the TASK 29 / 29.1 harness pattern: a real child process performs a real
 * (fake-transport) submission and then kills itself at an injected boundary. The parent
 * inspects the durable artefacts and proves what is and is not recoverable.
 *
 * Ledger events appended here:
 *   submit_attempt  — the transport's sendTransaction was actually invoked
 *   hash_returned   — the node acknowledged a hash (fake)
 *   status_lookup   — a getBlockItemStatus call
 *
 * Never contacts RPC, never signs, never holds a key.
 *
 * Usage: tsx scripts/task51-crash-child.mts <mode> <ledger> <hashfile>
 *   mode = die-after-submit | die-during-finalization | recover
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import type { ConcordiumGrpcClientLike } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';

const [, , mode, ledgerPath, hashPath] = process.argv;
const HASH = 'ab'.repeat(32);
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

const record = (event: string, extra: Record<string, unknown> = {}) => {
  appendFileSync(ledgerPath!, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
};

const validTx = () => ({
  version: 1,
  header: {
    sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    nonce: 7,
    expiry: Math.floor(Date.now() / 1000) + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: {
    type: 'transfer',
    toAddress: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    amount: '1',
  },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } },
});

const client: ConcordiumGrpcClientLike = {
  sendTransaction: async () => {
    record('submit_attempt');
    return HASH;
  },
  getBlockItemStatus: async () => {
    record('status_lookup');
    if (mode === 'die-during-finalization') {
      // A real pending gRPC call keeps the event loop alive. A bare never-resolving
      // promise would let Node exit with code 13 (unsettled top-level await) instead of
      // modelling a submission whose finalization is never observed.
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    return { status: 'committed', outcomes: [] } as never;
  },
};

const signer = createIpcSponsorSigner({
  sponsorAddress: SPONSOR,
  network: NETWORK,
  // Never dialled: this child exercises the submission/finalization seam only.
  socketPath: '/tmp/task51-crash-unused.sock',
  expectedUid: 1000,
  maxEnergy: 100_000n,
  maxFeeMicroCcd: 100_000_000n,
  submitter: new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client)),
});

if (mode === 'recover') {
  // Recovery NEVER resubmits. It may only look the persisted hash up.
  if (!existsSync(hashPath!)) {
    record('recover_no_hash');
    process.exit(3);
  }
  const { hash } = JSON.parse(readFileSync(hashPath!, 'utf8')) as { hash: string };
  record('recover_lookup', { hash });
  const r = await signer.waitForFinalization(hash, 200);
  record('recover_result', { status: r.status });
  process.exit(0);
}

const hash = await signer.submitTransaction(validTx());
record('hash_returned', { hash });
const { writeFileSync } = await import('node:fs');
writeFileSync(hashPath!, JSON.stringify({ hash }));

if (mode === 'die-after-submit') {
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
}

// die-during-finalization: the wait never resolves, so the parent must kill us.
await signer.waitForFinalization(hash, 30_000);
record('finalization_observed');
