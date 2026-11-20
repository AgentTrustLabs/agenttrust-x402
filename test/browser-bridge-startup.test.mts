/**
 * Startup wiring for the browser bridge (offline fakes only).
 * Real SDK verification runs; the node is a fake transport. NOT Testnet evidence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { eq, ok } from './helpers.mjs';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { signingDigestOf } from '../services/facilitator/src/signingService.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';

function key() { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey }; }
const senderKey = key(); const sponsorKey = key();

const requirements = { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } };

function fakeNodeClient(opts: { senderInfo?: 'ok' | 'missing'; chain?: 'finalized' | 'unavailable' } = {}) {
  const senderInfo = () => ({ ...makeFakeAccountInfo({ verifyKey: senderKey.pub, address: SENDER }), accountNonce: 14n });
  const sponsorInfo = () => ({ ...makeFakeAccountInfo({ verifyKey: sponsorKey.pub, address: SPONSOR }), accountNonce: 0n });
  return {
    async getAccountInfo(address: unknown) {
      const a = String(address);
      if (a === SENDER) return opts.senderInfo === 'missing' ? null : senderInfo();
      if (a === SPONSOR) return sponsorInfo();
      throw new Error('NOT_FOUND');
    },
    async getConsensusStatus() { return { genesisBlock: Buffer.from(GENESIS, 'hex') }; },
    async getBlockItemStatus() {
      if (opts.chain === 'unavailable') throw new Error('DEADLINE_EXCEEDED');
      return { status: 'finalized', outcome: { blockHash: Buffer.from('a3'.repeat(32), 'hex'), summary: { hash: HASH, transactionType: 'success', transfer: { sender: SENDER, to: RECIPIENT, amount: '1' }, sponsor: { sponsor: SPONSOR } } } };
    },
  } as never;
}

function sponsorSigner() {
  return {
    info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }),
    addSponsorSignature: async (tx: unknown) => {
      const t = tx as Record<string, unknown>;
      const sig = nodeSign(null, Buffer.from(signingDigestOf(t), 'hex'), sponsorKey.privateKey).toString('hex');
      return { ...t, signatures: { ...(t['signatures'] as object), sponsor: { 0: { 0: sig } } } };
    },
    submitTransaction: async () => { throw new Error('no submit'); },
    waitForFinalization: async () => { throw new Error('no submit'); },
  } as never;
}

async function start(opts: { sdk?: boolean; authOutcome?: 'approved' | 'rejected'; senderInfo?: 'ok' | 'missing'; chain?: 'finalized' | 'unavailable'; signFails?: boolean; bridge?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bb-startup-'));
  const env: Record<string, string> = {
    FACILITATOR_MODE: 'mock',
    FACILITATOR_PORT: '0',
    FACILITATOR_DB_PATH: join(dir, 'f.db'),
    FACILITATOR_MOCK_SPONSOR: SPONSOR,
    ...(opts.sdk ? { FACILITATOR_SENDER_VERIFICATION: 'sdk', FACILITATOR_NODE_HOST: '127.0.0.1', FACILITATOR_NODE_PORT: '20000' } : {}),
  };
  const f = await startFacilitator(env, {
    nodeClient: opts.sdk ? fakeNodeClient({ senderInfo: opts.senderInfo ?? 'ok', chain: opts.chain ?? 'finalized' }) : undefined,
    authorizationClient: opts.sdk ? {
      authorize: async () => opts.authOutcome === 'rejected'
        ? { outcome: 'rejected' as const, reason: 'policy', detail: null }
        : { outcome: 'approved' as const, reason: null, detail: null, certificate: {} as never },
      recover: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: {} as never }),
    } : undefined,
    sponsorSignerOverride: opts.signFails
      ? { info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }), addSponsorSignature: async () => { throw new Error('sign fail'); }, submitTransaction: async () => { throw new Error('no'); }, waitForFinalization: async () => { throw new Error('no'); } } as never
      : sponsorSigner(),
  });
  return { f, dir, rm: () => { rmSync(dir, { recursive: true, force: true }); } };
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('01. valid config initialises the bridge; /prepare and /confirm work', async () => {
  const { f, rm } = await start({ sdk: true });
  try {
    const p = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://x/protected', sender: SENDER }) });
    eq(p.status, 200, 'prepare');
    const pb = await p.json() as { ok: boolean; paymentRef: string; requestId: string; sponsoredTransaction: Record<string, unknown> };
    eq(pb.ok, true, 'prepare ok');
    const { Transaction } = await import('@concordium/web-sdk');
    const signed = await Transaction.sign(Transaction.signableFromJSON(pb.sponsoredTransaction), {
      async sign(digest: ArrayBuffer) { return { 0: { 0: nodeSign(null, Buffer.from(digest), senderKey.privateKey).toString('hex') } }; },
      getSignatureCount() { return 1n; },
    });
    const final = Transaction.toJSON(signed);
    const c = await fetch(`${f.url}/confirm`, { method: 'POST', body: JSON.stringify({ paymentRef: pb.paymentRef, requestId: pb.requestId, signedTransaction: final, txHash: HASH }, (_k, v) => typeof v === 'bigint' ? Number(v) : v) });
    eq(c.status, 200, 'confirm'); const cb = await c.json() as { ok: boolean; state: string };
    eq(cb.ok, true, 'confirm ok'); eq(cb.state, 'finalized', 'finalized from fake evidence');
  } finally { await f.close(); rm(); }
});

test('02. incomplete config → bridge inactive (404), CLI still served', async () => {
  const { f, rm } = await start({});
  try {
    eq((await fetch(`${f.url}/prepare`, { method: 'POST', body: '{}' })).status, 404, '404');
    eq((await fetch(`${f.url}/confirm`, { method: 'POST', body: '{}' })).status, 404, '404');
    eq((await fetch(`${f.url}/supported`)).status, 200, 'CLI ok');
  } finally { await f.close(); rm(); }
});

test('03. owner authorization refusal is rejected', async () => {
  const { f, rm } = await start({ sdk: true, authOutcome: 'rejected' });
  try {
    const r = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://x/protected', sender: SENDER }) });
    eq(r.status, 403, '403'); const b = await r.json() as { ok: boolean; reason: string };
    eq(b.ok, false, 'rejected'); ok(b.reason.startsWith('authorization_'), 'reason');
  } finally { await f.close(); rm(); }
});

test('04. sponsor signing failure is rejected', async () => {
  const { f, rm } = await start({ sdk: true, signFails: true });
  try {
    const r = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://x/protected', sender: SENDER }) });
    eq(r.status, 503, '503'); const b = await r.json() as { ok: boolean; reason: string };
    eq(b.ok, false, 'rejected'); eq(b.reason, 'sponsor_signing_failed', 'reason');
  } finally { await f.close(); rm(); }
});

test('05. sender AccountInfo missing cannot prepare', async () => {
  const { f, rm } = await start({ sdk: true, senderInfo: 'missing' });
  try {
    const r = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://x/protected', sender: SENDER }) });
    ok(r.status === 404 || r.status === 503, 'refused'); const b = await r.json() as { ok: boolean; reason: string };
    ok(b.ok === false && /sender_not_found|account_provider_unavailable/.test(b.reason), 'reason');
  } finally { await f.close(); rm(); }
});

test('06. chain unavailable → outcome_unknown, never finalized', async () => {
  const { f, rm } = await start({ sdk: true, chain: 'unavailable' });
  try {
    const p = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://x/protected', sender: SENDER }) });
    const pb = await p.json() as { ok: boolean; paymentRef: string; requestId: string; sponsoredTransaction: Record<string, unknown> };
    const { Transaction } = await import('@concordium/web-sdk');
    const signed = await Transaction.sign(Transaction.signableFromJSON(pb.sponsoredTransaction), {
      async sign(digest: ArrayBuffer) { return { 0: { 0: nodeSign(null, Buffer.from(digest), senderKey.privateKey).toString('hex') } }; },
      getSignatureCount() { return 1n; },
    });
    const c = await fetch(`${f.url}/confirm`, { method: 'POST', body: JSON.stringify({ paymentRef: pb.paymentRef, requestId: pb.requestId, signedTransaction: Transaction.toJSON(signed), txHash: HASH }, (_k, v) => typeof v === 'bigint' ? Number(v) : v) });
    eq(c.status, 503, '503'); const cb = await c.json() as { ok: boolean; reason: string };
    eq(cb.reason, 'chain_evidence_unavailable', 'reason');
  } finally { await f.close(); rm(); }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nbrowser-bridge-startup: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
