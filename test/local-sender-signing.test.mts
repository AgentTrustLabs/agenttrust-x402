/**
 * Local sender signing + submission error distinction.
 *
 * Part A — `src/x402/localSenderSigning.ts`: the sender signs locally,
 * fail-closed, with a real Ed25519 key (generated in-test, never a real
 * wallet). Covers signature validity, serialization (BigInt-safe JSON),
 * energy (SDK-recomputed), nonce, expiry, sponsor, and the C_t rule.
 *
 * Part B — `services/facilitator/src/submissionErrors.ts` +
 * `concordiumTransactionSubmitter.ts` + `grpcConcordiumTransport.ts`:
 * a LOCAL validation failure throws `SubmissionError` kind `validation`
 * (terminal, nothing broadcast); a node/transport failure throws kind
 * `transport` (outcome unknown). The correlation id is attached.
 *
 * Part C — `services/facilitator/src/core.ts`: a validation error from
 * submit is terminal (`submission_failed`, never `outcome_unknown`); a
 * transport error stays pending (`settlement_pending`).
 *
 * No network, no chain, no real keys. All signers are in-test Ed25519
 * keypairs or deterministic fakes.
 *
 * Run: npx tsx test/local-sender-signing.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@concordium/web-sdk';
import { signSenderTransaction, validateSenderTransaction, SIMPLE_TRANSFER_BASE_COST } from '../src/x402/localSenderSigning.js';
import { SdkSenderVerifier, makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import type { ConcordiumGrpcClientLike } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { SubmissionError, isSubmissionValidationError, isSubmissionTransportError } from '../services/facilitator/src/submissionErrors.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { paymentDigest } from '../services/facilitator/src/store.js';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { createHash } from 'node:crypto';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const NOW = Math.floor(Date.now() / 1000);
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const PAY_TO = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const HASH = 'ab'.repeat(32);
const BLOCK = 'ef'.repeat(32);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ─── helpers ───────────────────────────────────────────────────────────────

/** Real in-test Ed25519 signer (AccountSigner shape) + its public key hex. */
function makeRealSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signer = {
    async sign(digest: ArrayBuffer) {
      const sig = sign(null, Buffer.from(digest), privateKey);
      return { 0: { 0: sig.toString('hex') } };
    },
    getSignatureCount() { return 1n; },
  };
  return { signer, rawPub };
}

const validTx = (over: { header?: Record<string, unknown> } = {}) => ({
  version: 1,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: NOW + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
    ...(over.header ?? {}),
  },
  payload: { type: 'transfer', toAddress: PAY_TO, amount: '1' },
  signatures: { sender: {}, sponsor: {} },
});

// ─── Part A. local sender signing ──────────────────────────────────────────

test('A01. signing produces a sender signature that verifies against the account keys', async () => {
  const { signer, rawPub } = makeRealSigner();
  const { signedTransaction, energy, digest } = await signSenderTransaction(validTx(), signer as never, { expectedSender: SENDER });
  ok(/^[0-9a-f]{64}$/.test(digest), `digest is 64-hex: ${digest.slice(0, 12)}…`);
  eq(energy, 635n, 'SDK-recomputed total energy is 635 NRG for the standard sponsored transfer');
  // Verify the sender signature with the SDK primitive (same as the facilitator).
  const accountInfo = makeFakeAccountInfo({ verifyKey: rawPub, threshold: 1, address: SENDER });
  const verifier = new SdkSenderVerifier({
    network: CAIP2,
    accountInfoProvider: { async getAccountInfo() { return accountInfo; } },
  });
  const r = await verifier.verify(signedTransaction);
  check('A01. signature verifies', r.ok === true, r.ok ? 'ok' : (r as { reason?: string }).reason ?? '');
});

test('A02. signed JSON is BigInt-safe: JSON.stringify works and it re-parses', async () => {
  const { signer } = makeRealSigner();
  const { signedTransaction } = await signSenderTransaction(validTx(), signer as never, { expectedSender: SENDER });
  let text: string;
  try {
    text = JSON.stringify(signedTransaction);
  } catch (e) {
    check('A02. stringify', false, `threw: ${(e as Error).message}`);
    return;
  }
  const reparsed = JSON.parse(text);
  const signable = Transaction.signableFromJSON(reparsed);
  check('A02. re-parses via signableFromJSON', signable.version === 1, `version=${(signable as { version?: unknown }).version}`);
  const header = (signedTransaction as { header?: Record<string, unknown> }).header ?? {};
  check('A02. nonce is a number (not BigInt)', typeof header['nonce'] === 'number', `typeof=${typeof header['nonce']}`);
  check('A02. executionEnergyAmount is a number (not BigInt)', typeof header['executionEnergyAmount'] === 'number', `typeof=${typeof header['executionEnergyAmount']}`);
});

test('A03. energy: C_t=300 recomputes to 635 NRG; C_t=691 would recompute to 1026 (not a valid C_t)', async () => {
  const { signer } = makeRealSigner();
  const { energy } = await signSenderTransaction(validTx(), signer as never, { expectedSender: SENDER });
  eq(energy, 635n, 'C_t=300 → 635 NRG');
  // Direct SDK check: passing a TOTAL as C_t inflates the total.
  // `getEnergyCost` returns the SDK's `Energy` class instance — unwrap `.value`.
  const asTotalRaw = Transaction.getEnergyCost(
    Transaction.signableFromJSON(validTx({ header: { executionEnergyAmount: 691 } }) as never) as never,
  );
  const asTotal = (asTotalRaw as { value?: unknown }).value;
  eq(asTotal, 1026n, 'C_t=691 → 1026 NRG (a total must never be passed as C_t)');
});

test('A04. energy cap is enforced', async () => {
  const { signer } = makeRealSigner();
  let msg = '';
  try {
    await signSenderTransaction(validTx(), signer as never, { expectedSender: SENDER, maxTotalEnergy: 100n });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A04. cap enforced', msg.includes('exceeds cap'), msg);
});

test('A05. nonce: negative / non-integer / missing are refused', async () => {
  const { signer } = makeRealSigner();
  for (const [label, nonce] of [['negative', -1], ['fraction', 1.5], ['missing', undefined]] as const) {
    const tx = validTx();
    if (nonce === undefined) delete (tx.header as Record<string, unknown>)['nonce'];
    else (tx.header as Record<string, unknown>)['nonce'] = nonce;
    let msg = '';
    try {
      await signSenderTransaction(tx, signer as never, { expectedSender: SENDER });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`A05. nonce ${label} refused`, msg.includes('nonce'), msg);
  }
});

test('A06. expiry: past expiry refused; too-far-future refused', async () => {
  const { signer } = makeRealSigner();
  for (const [label, expiry] of [['past', NOW - 10], ['far-future', NOW + 7200]] as const) {
    const tx = validTx({ header: { expiry } });
    let msg = '';
    try {
      await signSenderTransaction(tx, signer as never, { expectedSender: SENDER });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`A06. expiry ${label} refused`, msg.includes('expiry'), msg);
  }
});

test('A07. wrong sender: header.sender != expectedSender is refused', async () => {
  const { signer } = makeRealSigner();
  const tx = validTx({ header: { sender: PAY_TO } });
  let msg = '';
  try {
    await signSenderTransaction(tx, signer as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A07. wrong sender refused', msg.includes('does not match the expected sender'), msg);
});

test('A08. sponsor: sponsor==sender, sponsor==recipient, missing/invalid sponsor refused', async () => {
  const { signer } = makeRealSigner();
  const cases: Array<[string, unknown]> = [
    ['sponsor==sender', validTx({ header: { sponsor: { account: SENDER, numSignatures: 1 } } })],
    ['sponsor==recipient', validTx({ header: { sponsor: { account: PAY_TO, numSignatures: 1 } } })],
    ['invalid sponsor', validTx({ header: { sponsor: { account: 'not-an-address', numSignatures: 1 } } })],
  ];
  for (const [label, tx] of cases) {
    let msg = '';
    try {
      await signSenderTransaction(tx, signer as never, { expectedSender: SENDER });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`A08. ${label} refused`, msg.length > 0, msg);
  }
  // Missing sponsor object.
  const noSponsor = validTx();
  delete (noSponsor.header as Record<string, unknown>)['sponsor'];
  let msg = '';
  try {
    await signSenderTransaction(noSponsor, signer as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A08. missing sponsor refused', msg.includes('sponsor'), msg);
});

test('A09. C_t must be the transfer base cost (300): passing a total (691) is refused', async () => {
  const { signer } = makeRealSigner();
  const tx = validTx({ header: { executionEnergyAmount: 691 } });
  let msg = '';
  try {
    await signSenderTransaction(tx, signer as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A09. C_t=691 refused', msg.includes('base cost') && msg.includes('300'), msg);
  // validateSenderTransaction (pure) agrees.
  const reason = validateSenderTransaction(tx, { expectedSender: SENDER });
  check('A09. pure validator agrees', typeof reason === 'string' && reason.includes('base cost'), reason ?? '');
});

test('A10. existing signatures are never overwritten', async () => {
  const { signer } = makeRealSigner();
  const withSenderSig = validTx();
  (withSenderSig.signatures as Record<string, unknown>)['sender'] = { 0: { 0: 'aa'.repeat(64) } };
  let msg = '';
  try {
    await signSenderTransaction(withSenderSig, signer as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A10. existing sender sig refused', msg.includes('must be empty'), msg);
  const withSponsorSig = validTx();
  (withSponsorSig.signatures as Record<string, unknown>)['sponsor'] = { 0: { 0: 'bb'.repeat(64) } };
  msg = '';
  try {
    await signSenderTransaction(withSponsorSig, signer as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A10. existing sponsor sig refused', msg.includes('must be empty'), msg);
});

test('A11. the module never accepts key material (only an injected signer)', async () => {
  // Passing a string / path where a signer belongs must fail, not be treated as a key.
  let msg = '';
  try {
    await signSenderTransaction(validTx(), 'a-private-key-hex' as never, { expectedSender: SENDER });
  } catch (e) {
    msg = (e as Error).message;
  }
  check('A11. key string refused', msg.includes('a signer is required'), msg);
});

// ─── Part B. submission error distinction ──────────────────────────────────

const signedTx = () => ({
  version: 1,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: NOW + 300,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: PAY_TO, amount: '1' },
  signatures: {
    sender: { 0: { 0: 'aa'.repeat(64) } },
    sponsor: { 0: { 0: 'bb'.repeat(64) } },
  },
});

test('B01. submitter validation (missing sponsor signature) is kind=validation + correlation id', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => HASH,
    getBlockItemStatus: async () => ({ status: 'received' }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  const tx = signedTx();
  (tx.signatures as Record<string, unknown>)['sponsor'] = {};
  let err: unknown;
  try {
    await submitter.submit(tx, { correlationId: 'corr-123' });
  } catch (e) {
    err = e;
  }
  check('B01. throws SubmissionError', err instanceof SubmissionError, err instanceof Error ? err.message : String(err));
  check('B01. kind=validation', isSubmissionValidationError(err), (err as SubmissionError)?.kind ?? '');
  check('B01. correlation id attached', (err as SubmissionError)?.correlationId === 'corr-123', (err as SubmissionError)?.correlationId ?? '');
  check('B01. not a transport error', !isSubmissionTransportError(err), '');
});

test('B02. node rejection (sendTransaction throws) is kind=transport + original message preserved', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => { throw new Error('FAILED_PRECONDITION: rejected by node'); },
    getBlockItemStatus: async () => ({ status: 'received' }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  let err: unknown;
  try {
    await submitter.submit(signedTx(), { correlationId: 'corr-456' });
  } catch (e) {
    err = e;
  }
  check('B02. throws SubmissionError', err instanceof SubmissionError, err instanceof Error ? err.message : String(err));
  check('B02. kind=transport', isSubmissionTransportError(err), (err as SubmissionError)?.kind ?? '');
  check('B02. original message preserved', (err as Error).message.includes('FAILED_PRECONDITION'), (err as Error).message);
  check('B02. correlation id attached', (err as SubmissionError)?.correlationId === 'corr-456', (err as SubmissionError)?.correlationId ?? '');
  check('B02. diagnostic is safe (kind + message + correlation)', (err as SubmissionError)?.toDiagnostic().includes('transport') === true, (err as SubmissionError)?.toDiagnostic() ?? '');
});

test('B03. malformed transaction (signableFromJSON fails) is kind=validation, before any node call', async () => {
  let sendCalled = false;
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => { sendCalled = true; return HASH; },
    getBlockItemStatus: async () => ({ status: 'received' }) as never,
  };
  const transport = new GrpcConcordiumTransport(client);
  let err: unknown;
  try {
    await transport.submit({ version: 1, header: 'not-an-object' });
  } catch (e) {
    err = e;
  }
  check('B03. kind=validation', isSubmissionValidationError(err), (err as SubmissionError)?.kind ?? '');
  check('B03. node never contacted', sendCalled === false, `sendCalled=${sendCalled}`);
});

test('B04. invalid hash returned by the node is kind=transport (send happened, outcome unknown)', async () => {
  const client: ConcordiumGrpcClientLike = {
    sendTransaction: async () => 'not-a-hash',
    getBlockItemStatus: async () => ({ status: 'received' }) as never,
  };
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  let err: unknown;
  try {
    await submitter.submit(signedTx());
  } catch (e) {
    err = e;
  }
  check('B04. kind=transport', isSubmissionTransportError(err), (err as SubmissionError)?.kind ?? '');
});

// ─── Part C. core handling ─────────────────────────────────────────────────

const payloadFixture = () => ({
  x402Version: 2,
  resource: { url: 'agenttrust://resource/1004' },
  accepted: {
    scheme: 'exact',
    network: CAIP2,
    asset: 'CCD',
    amount: '250000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: SPONSOR },
  },
  payload: {
    signedTransaction: {
      version: 1,
      header: {
        sender: SENDER,
        nonce: 7,
        expiry: NOW + 200,
        numSignatures: 1,
        sponsor: { address: SPONSOR, numSignatures: 0 },
      },
      payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
      signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
    },
  },
});
const envelope = (p: unknown) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: (p as { accepted: unknown }).accepted });
const successSummary = () => ({ type: 'accountTransaction', transactionType: 'transfer' });
const finalizedStatus = (summary: unknown) => ({ status: 'finalized', outcome: { summary, blockHash: BLOCK } });

function fakeClient(over: { throwOnSend?: boolean; status?: () => unknown } = {}): ConcordiumGrpcClientLike {
  return {
    sendTransaction: async (tx: unknown) => {
      if (over.throwOnSend) throw new Error('FAILED_PRECONDITION: rejected by node');
      return createHash('sha256').update(Buffer.from(AccountTransactionV1.serializeBlockItem(tx as never))).digest('hex');
    },
    getBlockItemStatus: async () => (over.status?.() ?? { status: 'committed', outcomes: [] }) as never,
  };
}

/** Submitter-backed signer; `submitThrows` makes submitTransaction throw a typed error. */
function coreSigner(client: ConcordiumGrpcClientLike, opts: { sponsorSig?: boolean; submitThrows?: unknown } = {}) {
  const submitter = new ConcordiumTransactionSubmitter(new GrpcConcordiumTransport(client));
  return {
    info: () => ({ address: SPONSOR, network: CAIP2, canSign: true }),
    addSponsorSignature: async (tx: unknown) => {
      if (opts.sponsorSig === false) return tx; // leaves the sponsor slot EMPTY
      return {
        ...(tx as Record<string, unknown>),
        signatures: {
          ...(((tx as { signatures?: unknown }).signatures as Record<string, unknown>) ?? {}),
          sponsor: { 0: { 0: 'bb'.repeat(64) } },
        },
      };
    },
    validateContext: () => null,
    submitTransaction: async (tx: unknown, submitOpts?: { correlationId?: string }) => {
      if (opts.submitThrows !== undefined) throw opts.submitThrows;
      return (await submitter.submit(tx, { correlationId: submitOpts?.correlationId })).hash;
    },
    waitForFinalization: async (h: string, t?: number) => {
      const f = await submitter.awaitFinalization(h, { timeoutMs: t ?? 5_000, intervalMs: 5 });
      if (f.status === 'finalized') return { txHash: h, status: 'finalized' as const, sender: SPONSOR, simulated: true as const };
      if (f.status === 'rejected') return { txHash: h, status: 'failed' as const, sender: SPONSOR, simulated: true as const };
      if (f.status === 'transport_error') throw new Error(`finalization transport error: ${f.reason ?? 'unknown'}`);
      return { txHash: h, status: 'pending' as const, sender: SPONSOR, simulated: true as const };
    },
    getAccountInfo: async () => ({}),
    getTokenBalance: async () => 0n,
    getTokenDecimals: async () => 6,
  };
}

function tempDb(): { dir: string; db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-lss-'));
  return { dir, db: join(dir, 'f.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('C01. local validation failure at submit is TERMINAL (submission_failed), never outcome_unknown', async () => {
  const w = tempDb();
  try {
    // addSponsorSignature adds the sponsor signature (so the hash computation
    // succeeds and the flow reaches submit), but submitTransaction throws a
    // typed VALIDATION error — the submission pipeline's local validation
    // failed before any broadcast.
    const signer = coreSigner(fakeClient({ status: () => finalizedStatus(successSummary()) }), {
      submitThrows: new SubmissionError('validation', 'malformed transaction: a sponsor signature is required before submission', 'corr-c01'),
    });
    const core = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    check('C01. not success', res.success === false, `success=${res.success}`);
    check('C01. reason is submission_failed (terminal)', res.errorReason === 'submission_failed', res.errorReason);
    check('C01. NOT settlement_pending / outcome_unknown', res.errorReason !== 'settlement_pending', res.errorReason);
    check('C01. kind=validation in extra', (res.extra as Record<string, unknown>)?.['submissionKind'] === 'validation', JSON.stringify(res.extra));
    check('C01. original message preserved', res.errorMessage.includes('sponsor signature is required'), res.errorMessage);
    const row = core.store.get(paymentDigest(p));
    // Durable state: the broadcast claim was already taken (state=submitting)
    // when submit failed, so `markFailed` correctly refuses to terminalize
    // it — only `reconcile()` may terminalize a broadcast-capable row (the
    // repository's safety invariant; a stale path must never reject a payment
    // the chain may still finalize). The API response is terminal
    // (`submission_failed`), and the row is NOT `outcome_unknown`: recovery
    // owns it via the standard crash-recovery path (poll by hash; nothing
    // was broadcast, so it can never finalize).
    check('C01. durable state stays submitting (not outcome_unknown)', row?.state === 'submitting', `state=${row?.state}`);
    check('C01. durable state is NOT outcome_unknown', row?.state !== 'outcome_unknown', `state=${row?.state}`);
  } finally {
    w.cleanup();
  }
});

test('C02. node rejection at submit stays PENDING (settlement_pending, outcome unknown)', async () => {
  const w = tempDb();
  try {
    const signer = coreSigner(fakeClient({ throwOnSend: true, status: () => finalizedStatus(successSummary()) }), {});
    const core = new FacilitatorCore({ network: CAIP2, signer: signer as never, dbPath: w.db, now: () => NOW * 1000 });
    const p = payloadFixture();
    const res = await core.settle(envelope(p));
    check('C02. not success', res.success === false, `success=${res.success}`);
    check('C02. reason is settlement_pending', res.errorReason === 'settlement_pending', res.errorReason);
    check('C02. kind=transport in extra', (res.extra as Record<string, unknown>)?.['submissionKind'] === 'transport', JSON.stringify(res.extra));
    check('C02. original message preserved', res.errorMessage.includes('FAILED_PRECONDITION'), res.errorMessage);
    const row = core.store.get(paymentDigest(p));
    check('C02. durable state is outcome_unknown (non-terminal)', row?.state === 'outcome_unknown', `state=${row?.state}`);
  } finally {
    w.cleanup();
  }
});

(async () => {
  let threw = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      threw++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  const failed = results.filter((r) => !r[1]).length + threw;
  const passed = results.length - results.filter((r) => !r[1]).length;
  console.log(`\nlocal-sender-signing: ${passed}/${results.length} assertions passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
