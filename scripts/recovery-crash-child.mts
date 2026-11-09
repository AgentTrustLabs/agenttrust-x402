import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { computeTransactionHash } from '../services/facilitator/src/signer.js';
import { paymentDigest } from '../services/facilitator/src/store.js';

const dbPath = process.argv[2]!;
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = Math.floor(Date.now() / 1000);
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

function payloadFixture() {
  return {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000',
      payTo: PAY_TO, maxTimeoutSeconds: 300,
      extra: { feePayer: SPONSOR },
    },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1,
          sponsor: { address: SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: any) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });

const transport = {
  sendTransaction: async (tx: unknown) => computeTransactionHash(tx),
  getBlockItemStatus: async () => ({ status: 'committed', outcomes: [] }) as never,
};

const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(transport as never));

const signer = {
  info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
  addSponsorSignature: async (tx: unknown) => ({
    ...(tx as Record<string, unknown>),
    signatures: {
      ...(((tx as { signatures?: unknown }).signatures as Record<string, unknown>) ?? {}),
      sponsor: { 0: { 0: 'bb'.repeat(64) } },
    },
  }),
  validateContext: () => null,
  submitTransaction: async (tx: unknown) => (await submitter.submit(tx)).hash,
  waitForFinalization: async (h: string, t?: number) => {
    const f = await submitter.awaitFinalization(h, { timeoutMs: t ?? 30_000 });
    switch (f.status) {
      case 'finalized': return { txHash: h, status: 'finalized' as const, sender: SPONSOR, simulated: true as const };
      case 'rejected': return { txHash: h, status: 'failed' as const, sender: SPONSOR, simulated: true as const };
      default: return { txHash: h, status: 'pending' as const, sender: SPONSOR, simulated: true as const };
    }
  },
  getAccountInfo: async () => ({}),
  getTokenBalance: async () => 0n,
  getTokenDecimals: async () => 6,
};

const core = new FacilitatorCore({
  network: CAIP2,
  signer: signer as never,
  dbPath,
  now: () => NOW * 1000,
  dieAt: 'after-submit',
});

const p = payloadFixture();
const res = await core.settle(envelope(p));
console.log(JSON.stringify({ digest: paymentDigest(p), result: res }));
