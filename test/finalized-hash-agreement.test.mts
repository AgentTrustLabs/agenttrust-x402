/**
 * Regression: the mock signer and the production path agree on the finalized
 * transaction hash.
 *
 * FacilitatorCore persists `computeFinalizedTransactionHash(sponsored)`. That helper
 * calls `AccountTransactionV1.serializeSignatures`, which throws "No signatures were provided"
 * when the sponsor signature slot is empty. The mock signer used to return the transaction with
 * an empty sponsor slot, so the B06 mock flow failed at hash computation (and the mock's
 * `submitTransaction` would have returned the `simulated-` fallback instead of the real hash).
 *
 * The mock now fills the empty sponsor slot with a deterministic fixture, exactly as the
 * production sponsor signer leaves a real signature there. These tests pin that agreement.
 *
 * Run: npx tsx test/finalized-hash-agreement.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@concordium/web-sdk';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { createHash } from 'node:crypto';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import {
  createMockSigner,
  computeFinalizedTransactionHash,
  MOCK_SPONSOR_SIGNATURE,
  type SponsorSigner,
} from '../services/facilitator/src/signer.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import type { ConcordiumGrpcClientLike } from '../services/facilitator/src/grpcConcordiumTransport.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = 1_800_000_000;
const BLOCK = 'ef'.repeat(32);

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** A minimal V1 sponsored transaction with an empty sponsor slot (what a client sends). */
const sponsoredTx = () => ({
  version: 1,
  header: {
    sender: RECIPIENT,
    nonce: 7,
    expiry: NOW + 200,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
});

const envelope = () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact',
      network: NETWORK,
      asset: 'CCD',
      amount: '250000',
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { feePayer: SPONSOR },
    },
    payload: { signedTransaction: sponsoredTx() },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted } as never;
};

const mockSigner = (): SponsorSigner => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  return {
    info: () => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: inner.addSponsorSignature,
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
};

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 't521-'));
  return { dir, db: join(dir, 'f.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const coreWith = (signer: SponsorSigner, db: string) =>
  new FacilitatorCore({
    network: NETWORK,
    signer,
    dbPath: db,
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({
      policy: {
        network: NETWORK,
        sponsor: SPONSOR,
        maxEnergy: 100_000n,
        maxExpiryOffsetSeconds: 600,
        allowedAssets: ['CCD'],
        policyVersion: 't521',
      },
      repository: new SqliteSettlementRepository(db, { now: () => NOW * 1000 }),
      now: () => NOW * 1000,
    }),
  } as never);

test('01. the mock fills an empty sponsor slot with the deterministic fixture', async () => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const signed = (await inner.addSponsorSignature(sponsoredTx())) as {
    signatures: { sponsor: Record<string, Record<string, string>> };
  };
  eq(signed.signatures.sponsor['0']['0'], MOCK_SPONSOR_SIGNATURE, 'sponsor slot filled');
  eq((signed as unknown as Record<string, unknown>)['__simulated'], true, 'still marked simulated');
});

test('02. a non-transaction input is left untouched', async () => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const out = (await inner.addSponsorSignature({ a: 1 })) as Record<string, unknown>;
  eq(out['a'], 1, 'input preserved');
  eq(out['signatures'], undefined, 'no signatures invented');
});

test('03. an already-signed sponsor slot is not overwritten', async () => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const tx = sponsoredTx() as {
    signatures: { sender: Record<string, Record<string, string>>; sponsor: Record<string, Record<string, string>> };
  };
  tx.signatures.sponsor = { 0: { 0: 'cc'.repeat(64) } };
  const signed = (await inner.addSponsorSignature(tx)) as typeof tx;
  eq(signed.signatures.sponsor['0']['0'], 'cc'.repeat(64), 'existing sponsor signature preserved');
});

test('04. computeFinalizedTransactionHash agrees with the production finalize/hash path', async () => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const signed = await inner.addSponsorSignature(sponsoredTx());
  const persisted = computeFinalizedTransactionHash(signed);
  // The production path: parse → finalize → getAccountTransactionHash (what GRPCClient.sendTransaction returns).
  const production = createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(Transaction.finalize(Transaction.signableFromJSON(signed) as never) as never))).digest('hex');
  eq(persisted, production, 'core hash == production finalized hash');
  ok(/^[0-9a-f]{64}$/.test(persisted), 'hash is 64-hex');
});

test('05. the mock submitTransaction returns the same finalized hash the core persists', async () => {
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const signed = await inner.addSponsorSignature(sponsoredTx());
  const returned = await inner.submitTransaction(signed);
  eq(returned, computeFinalizedTransactionHash(signed), 'mock return == finalized hash');
});

test('06. core persisted hash == the transport hash across the real GrpcConcordiumTransport boundary', async () => {
  const w = tempDb();
  try {
    let transportHash = '';
    let submittedTx: unknown;
    const client: ConcordiumGrpcClientLike = {
      sendTransaction: async (tx: unknown) => {
        submittedTx = tx;
        transportHash = createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(tx as never))).digest('hex');
        return transportHash;
      },
      getBlockItemStatus: async () =>
        ({ status: 'finalized', outcome: { summary: { type: 'accountTransaction', transactionType: 'transfer' }, blockHash: BLOCK } }) as never,
    };
    const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
    const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
    const signer: SponsorSigner = {
      info: () => ({ ...inner.info(), address: SPONSOR }),
      addSponsorSignature: inner.addSponsorSignature,
      submitTransaction: async (tx: unknown) => (await submitter.submit(tx)).hash,
      waitForFinalization: async (h: string, t?: number) => {
        const f = await submitter.awaitFinalization(h, { timeoutMs: t ?? 5_000, intervalMs: 5 });
        if (f.status === 'finalized') return { txHash: h, status: 'finalized' as const, sender: SPONSOR, simulated: true as const };
        if (f.status === 'rejected') return { txHash: h, status: 'failed' as const, sender: SPONSOR, simulated: true as const };
        return { txHash: h, status: 'pending' as const, sender: SPONSOR, simulated: true as const };
      },
      getAccountInfo: inner.getAccountInfo,
      getTokenBalance: inner.getTokenBalance,
      getTokenDecimals: inner.getTokenDecimals,
    };
    const core = coreWith(signer, w.db);
    const res = await core.settle(envelope());
    eq(res.success, true, 'mock signing + production transport succeeds');
    eq(res.transaction, transportHash, 'core hash == transport hash');
    // The submitted object is already finalized by the transport; its hash must match too.
    eq(createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(submittedTx as never))).digest('hex'), transportHash, 'submitted tx hash == transport hash');
  } finally {
    w.cleanup();
  }
});

test('07. B06 regression: the signer without validateContext settles successfully', async () => {
  const w = tempDb();
  try {
    const core = coreWith(mockSigner(), w.db);
    const res = await core.settle(envelope());
    eq(res.success, true, 'mock flow unaffected');
    ok(/^[0-9a-f]{64}$/.test(res.transaction), 'durable hash');
  } finally {
    w.cleanup();
  }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\nfinalized-hash-agreement: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
