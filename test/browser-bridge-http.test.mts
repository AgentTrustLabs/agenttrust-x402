/**
 * HTTP wiring for the browser bridge (offline fakes only).
 * Proves /prepare and /confirm exist when a bridge is injected and 404 otherwise.
 * NOT evidence of a Testnet settlement.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { BrowserPaymentBridge } from '../services/facilitator/src/browserBridge.js';
import { SqliteBrowserPaymentStore } from '../services/facilitator/src/browserPaymentStore.js';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const RECIPIENT = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';

function bridgeFor(path: string) {
  const store = new SqliteBrowserPaymentStore(path);
  return { store, bridge: new BrowserPaymentBridge({
    network: NETWORK, sponsorAddress: SPONSOR, maxEnergy: 1000n, maxFeeMicroCcd: '10000000', store,
    authorization: {
      authorize: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: {} as never }),
      recover: async () => ({ outcome: 'approved' as const, reason: null, detail: null, certificate: {} as never }),
    },
    signer: {
      info: () => ({ address: SPONSOR, network: NETWORK, canSign: true }),
      addSponsorSignature: async (tx: unknown) => {
        const t = tx as Record<string, unknown>;
        return { ...t, signatures: { ...(t['signatures'] as object), sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
      },
      submitTransaction: async () => { throw new Error('must not submit'); },
      waitForFinalization: async () => { throw new Error('must not submit'); },
    } as never,
    accountProvider: { getAccountInfo: async () => ({ accountNonce: 14n } as never) },
    chain: { readTransfer: async () => ({ status: 'finalized', sender: SENDER, sponsor: SPONSOR, recipient: RECIPIENT, amount: '1', network: NETWORK, failed: false, blockHash: 'a3'.repeat(32), blockHeight: '50652456' } as never) },
    senderVerifier: async () => ({ ok: true as const }),
    sponsorVerifier: async () => true,
  }) };
}

const requirements = { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '1', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } };

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('01. /prepare and /confirm answer when a bridge is injected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-http-'));
  const { store, bridge } = bridgeFor(join(dir, 'b.db'));
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0', FACILITATOR_DB_PATH: join(dir, 'f.db') }, { browserBridge: bridge });
  try {
    const p = await fetch(`${f.url}/prepare`, { method: 'POST', body: JSON.stringify({ requirements, resourceUrl: 'http://127.0.0.1:4590/protected', sender: SENDER }) });
    eq(p.status, 200, 'prepare status');
    const pb = await p.json() as { ok: boolean; paymentRef: string; requestId: string; sponsoredTransaction: Record<string, unknown> };
    eq(pb.ok, true, 'prepare ok');
    const final = { ...pb.sponsoredTransaction, signatures: { ...(pb.sponsoredTransaction['signatures'] as object), sender: { 0: { 0: 'cc'.repeat(32) } } } };
    const c = await fetch(`${f.url}/confirm`, { method: 'POST', body: JSON.stringify({ paymentRef: pb.paymentRef, requestId: pb.requestId, signedTransaction: final, txHash: HASH }) });
    eq(c.status, 200, 'confirm status');
    const cb = await c.json() as { ok: boolean; state: string };
    eq(cb.ok, true, 'confirm ok');
    eq(cb.state, 'finalized', 'finalized from fake evidence');
  } finally { await f.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('02. without a bridge the routes do not exist (404)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-http-none-'));
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0', FACILITATOR_DB_PATH: join(dir, 'f.db') });
  try {
    for (const path of ['/prepare', '/confirm']) {
      const r = await fetch(`${f.url}${path}`, { method: 'POST', body: '{}' });
      eq(r.status, 404, `${path} 404`);
    }
    const cli = await fetch(`${f.url}/supported`);
    ok(cli.status === 200, 'CLI routes still served');
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`); }
}
console.log(`\nbrowser-bridge-http: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
