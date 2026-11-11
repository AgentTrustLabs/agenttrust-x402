/**
 * Live read-only validation of the real Concordium Testnet chain verifier
 * and of the x402 provider end to end against real finalized transactions.
 *
 * Uses two ALREADY-FINALIZED transactions (the first and second sponsored transfers). No new
 * transaction is constructed, signed, broadcast, or paid for. The facilitator is
 * a local stub only because settlement is out of scope — the provider's resource
 * release is decided solely by the real on-chain read.
 *
 * Run: npx tsx scripts/verify-testnet-chain.mts
 */
import { TESTNET } from '../src/core/types.js';
import { ConcordiumChainVerifier } from '../src/x402/concordiumChainVerifier.js';
import { createX402Provider, ReplayStore } from '../src/x402/provider.js';
import { buildPaymentRequirements, buildPaymentRequired, preflightPaymentPayload } from '../src/payments/x402.js';

const NODE_HOST = process.env.AGENTTRUST_NODE_HOST ?? TESTNET.grpcHost.replace(/^https?:\/\//, '');
const NODE_PORT = Number(process.env.AGENTTRUST_NODE_PORT ?? TESTNET.grpcPort);

const TX_FIRST_SPONSORED = 'c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a'; // transaction hash (read-only evidence)
const TX_SECOND_SPONSORED = 'b472caa354f9c017cc7d6254fbe12ef8fc2bc0ee3c989a561c6cd9bf957220c2'; // transaction hash (read-only evidence)
const TX_UNKNOWN = '0000000000000000000000000000000000000000000000000000000000000000'; // transaction hash (unknown sentinel)

const PAY_TO = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RESOURCE = 'https://agenttrust.local/protected';

/** Local settlement stub: returns a preselected hash. No chain write. */
function stubFacilitator(hash: string) {
  return {
    async verify() {
      return { isValid: true };
    },
    async settle() {
      return { success: true, transaction: hash, network: TESTNET.caip2 };
    },
  };
}

function paymentHeader(txHash: string, amount: string, payTo: string): string {
  return JSON.stringify({
    x402Version: 2,
    scheme: 'exact',
    network: TESTNET.caip2,
    payload: { signedTransaction: 'stub' },
    resource: { url: RESOURCE },
    requestId: `req-${txHash.slice(0, 12)}-${amount}-${payTo.slice(0, 6)}`,
    accepted: {
      scheme: 'exact',
      network: TESTNET.caip2,
      asset: 'CCD',
      amount,
      payTo,
      maxTimeoutSeconds: 600,
      extra: { nonce: 'stub' },
    },
  });
}

function makeProvider(txHash: string, amount: string, payTo: string, chain: ConcordiumChainVerifier) {
  const requirements = buildPaymentRequirements({
    payTo,
    amountMicroCcd: amount,
    resourceUrl: RESOURCE,
    network: TESTNET.caip2,
    maxTimeoutSeconds: 600,
  });
  return createX402Provider(
    { requirements, resourceUrl: RESOURCE, resource: { body: 'PROTECTED-CONTENT' } },
    { facilitator: stubFacilitator(txHash), chain },
    { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: new ReplayStore() },
  );
}

async function main(): Promise<void> {
  console.log('=== real Concordium Testnet chain verification ===');
  console.log(`node=${NODE_HOST}:${NODE_PORT} network=${TESTNET.caip2}`);

  const verifier = new ConcordiumChainVerifier({ host: NODE_HOST, port: NODE_PORT, network: TESTNET.caip2, useTls: true });

  console.log('\n### Phase 1 — node identity');
  await verifier.verifyNode();
  console.log('PASS verifyNode(): node genesis matches configured Testnet');

  console.log('\n### Phase 2 — direct chain reads');
  for (const tx of [TX_FIRST_SPONSORED, TX_SECOND_SPONSORED]) {
    const s = await verifier.readTransfer(tx);
    console.log(`readTransfer(${tx})`);
    console.log('  ' + JSON.stringify(s));
  }
  console.log(`readTransfer(unknown) -> ${JSON.stringify(await verifier.readTransfer(TX_UNKNOWN))}`);
  console.log(`readTransfer(malformed) -> ${JSON.stringify(await verifier.readTransfer('not-a-hash'))}`);

  console.log('\n### Phase 3 — provider end to end over the REAL verifier');

  // 3a. correct payment details → 200
  {
    const p = makeProvider(TX_FIRST_SPONSORED, '1', PAY_TO, verifier);
    const r = await p.handlePayment(paymentHeader(TX_FIRST_SPONSORED, '1', PAY_TO));
    console.log(`correct recipient+amount -> ${r.status} (${r.reason})`);
  }

  // 3b. wrong recipient → chain_mismatch
  {
    const wrong = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
    const p = makeProvider(TX_FIRST_SPONSORED, '1', wrong, verifier);
    const r = await p.handlePayment(paymentHeader(TX_FIRST_SPONSORED, '1', wrong));
    console.log(`wrong recipient -> ${r.status} (${r.reason}) body=${JSON.stringify(r.body)}`);
  }

  // 3c. wrong amount → chain_mismatch
  {
    const p = makeProvider(TX_FIRST_SPONSORED, '500', PAY_TO, verifier);
    const r = await p.handlePayment(paymentHeader(TX_FIRST_SPONSORED, '500', PAY_TO));
    console.log(`wrong amount -> ${r.status} (${r.reason}) body=${JSON.stringify(r.body)}`);
  }

  // 3d. unknown transaction → no release
  {
    const p = makeProvider(TX_UNKNOWN, '1', PAY_TO, verifier);
    const r = await p.handlePayment(paymentHeader(TX_UNKNOWN, '1', PAY_TO));
    console.log(`unknown tx -> ${r.status} (${r.reason}) body=${JSON.stringify(r.body)}`);
  }

  // 3e. replay of the same (requestId, txHash) → 409
  {
    const requirements = buildPaymentRequirements({
      payTo: PAY_TO, amountMicroCcd: '1', resourceUrl: RESOURCE, network: TESTNET.caip2, maxTimeoutSeconds: 600,
    });
    const store = new ReplayStore();
    const p = createX402Provider(
      { requirements, resourceUrl: RESOURCE, resource: { body: 'PROTECTED-CONTENT' } },
      { facilitator: stubFacilitator(TX_SECOND_SPONSORED), chain: verifier },
      { preflight: preflightPaymentPayload, buildRequired: buildPaymentRequired, replayStore: store },
    );
    const h = paymentHeader(TX_SECOND_SPONSORED, '1', PAY_TO);
    const first = await p.handlePayment(h);
    const second = await p.handlePayment(h);
    console.log(`replay: first=${first.status}/${first.reason} second=${second.status}/${second.reason}`);
  }

  console.log('\n### Phase 4 — final JSON summary');
  const summary = {
    node: `${NODE_HOST}:${NODE_PORT}`,
    network: TESTNET.caip2,
    t65: await verifier.readTransfer(TX_FIRST_SPONSORED),
    t70: await verifier.readTransfer(TX_SECOND_SPONSORED),
    unknown: await verifier.readTransfer(TX_UNKNOWN),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nDONE (read-only; no transaction created, signed, or broadcast)');
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
