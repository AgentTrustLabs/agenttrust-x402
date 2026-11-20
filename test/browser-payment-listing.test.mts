/**
 * Browser payments in the dashboard: facilitator list/detail contract + UI
 * surface. Fully offline: in-process facilitator, temp SQLite, static UI audit.
 * No node, no wallet, no signing, no Testnet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { SqliteBrowserPaymentStore, browserPaymentPublic, browserPaymentVerification } from '../services/facilitator/src/browserPaymentStore.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { readFileSync } from 'node:fs';

const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const HASH = 'b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb';
const BLOCK = '387ae4ffed5ae328566efb30e379539cf3632714ed55564a60237420a49310a4';
const REQ_KEY = [NETWORK, PAY_TO, '1', 'CCD', 'https://agenttrust.test/protected'].join('|');

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

function makeRow(ref, state, txHash, evidence) {
  return {
    payment_ref: ref, request_id: 'req-' + ref.slice(0, 6), prepared_digest: 'd'.repeat(64),
    requirements_key: REQ_KEY, resource_url: 'https://agenttrust.test/protected',
    sender: SENDER, sponsor: SPONSOR, state, tx_hash: txHash,
    prepared_transaction: '{}', sponsor_signed_transaction: '{}', final_transaction: null,
    evidence: evidence ? JSON.stringify(evidence) : null,
    created_at: 1_700_000_000, updated_at: 1_700_000_100,
  };
}

test('01. browser store list + finality evidence mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-browser-list-'));
  try {
    const store = new SqliteBrowserPaymentStore(join(dir, 'payments.db'));
    const finalized = makeRow('f'.repeat(64), 'finalized', HASH, { blockHash: BLOCK, sender: SENDER, amount: '1' });
    const pending = makeRow('a'.repeat(64), 'pending_confirmation', HASH.toLowerCase(), null);
    const unknown = makeRow('b'.repeat(64), 'outcome_unknown', 'c2'.repeat(32), null);
    store.createBrowserPayment(finalized); store.createBrowserPayment(pending); store.createBrowserPayment(unknown);
    eq(store.listBrowserPayments(10).length, 3, 'three rows');
    const pub = browserPaymentPublic(finalized);
    eq(pub['source'], 'browser', 'source');
    eq(pub['state'], 'finalized', 'state');
    eq(pub['sender'], SENDER, 'sender');
    eq(pub['sponsor'], SPONSOR, 'sponsor');
    eq(pub['recipient'], PAY_TO, 'recipient');
    eq(pub['amountMicroCcd'], '1', 'amount');
    eq(pub['network'], NETWORK, 'network');
    eq((pub['verification'] as Record<string, unknown>)['blockHash'], BLOCK, 'block hash');
    eq(browserPaymentVerification(pending)['finalized'], false, 'pending not finalized');
    eq(browserPaymentVerification(unknown)['finalized'], false, 'unknown not finalized');
    notOk(browserPaymentPublic(pending)['verification'] && (browserPaymentPublic(pending)['verification'] as Record<string, unknown>)['available'], 'pending no proof');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('02. facilitator /payments merges browser rows; /payment/:ref returns browser detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-browser-http-'));
  const dbPath = join(dir, 'facilitator.db');
  let facilitator;
  try {
    facilitator = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0', FACILITATOR_DB_PATH: dbPath });
    const store = new SqliteBrowserPaymentStore(dbPath);
    store.createBrowserPayment(makeRow('f'.repeat(64), 'finalized', HASH, { blockHash: BLOCK }));
    store.createBrowserPayment(makeRow('a'.repeat(64), 'pending_confirmation', null, null));
    store.close();
    const list = await (await fetch(facilitator.url + '/payments?limit=100')).json();
    const browserRows = list.payments.filter((p) => p.source === 'browser');
    eq(browserRows.length, 2, 'two browser rows in listing');
    const finalized = browserRows.find((p) => p.paymentDigest === 'f'.repeat(64));
    ok(finalized, 'finalized browser row present');
    eq(finalized.state, 'finalized', 'state');
    eq(finalized.transactionHash, HASH, 'tx hash');
    const detailRes = await fetch(facilitator.url + '/payment/' + 'f'.repeat(64));
    eq(detailRes.status, 200, 'detail status');
    const detail = await detailRes.json();
    eq(detail.source, 'browser', 'detail source');
    eq(detail.sender, SENDER, 'detail sender');
    eq(detail.recipient, PAY_TO, 'detail recipient');
    eq(detail.sponsor, SPONSOR, 'detail sponsor');
    eq(detail.resource.url, 'https://agenttrust.test/protected', 'detail resource');
    eq(detail.verification.blockHash, BLOCK, 'detail block hash');
    const pendingDetail = await (await fetch(facilitator.url + '/payment/' + 'a'.repeat(64))).json();
    eq(pendingDetail.finalized, false, 'pending detail not finalized');
  } finally {
    if (facilitator) await facilitator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('03. CLI rows are not duplicated or overwritten by browser rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'at-browser-dedupe-'));
  const dbPath = join(dir, 'facilitator.db');
  let facilitator;
  try {
    facilitator = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0', FACILITATOR_DB_PATH: dbPath });
    const digest = 'e'.repeat(64);
    const cliStore = new SqliteSettlementRepository(dbPath);
    cliStore.noteVerified(digest, [NETWORK, PAY_TO, '1', 'CCD', 'resource'].join('|'));
    cliStore.prepare(digest, HASH);
    cliStore.claimSubmit(digest, HASH);
    cliStore.markBroadcast(digest, HASH);
    cliStore.reconcile({ paymentDigest: digest, transaction: HASH, observed: 'finalized', evidenceSource: 'test-offline', evidenceDigest: 'd'.repeat(64) });
    cliStore.close();
    const store = new SqliteBrowserPaymentStore(dbPath);
    store.createBrowserPayment(makeRow('f'.repeat(64), 'finalized', HASH, { blockHash: BLOCK }));
    store.close();
    const list = await (await fetch(facilitator.url + '/payments?limit=100')).json();
    const cli = list.payments.filter((p) => p.source !== 'browser');
    const browser = list.payments.filter((p) => p.source === 'browser');
    eq(cli.length, 1, 'CLI row preserved');
    eq(browser.length, 0, 'duplicate browser row dropped');
    const detail = await (await fetch(facilitator.url + '/payment/' + HASH)).json();
    eq(detail.source, undefined, 'CLI detail unchanged by browser mapping');
  } finally {
    if (facilitator) await facilitator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('04. UI shows browser source and receipt fields; never finalizes pending', () => {
  const html = readFileSync(new URL('../web/prototype-v5-6.html', import.meta.url), 'utf8');
  ok(html.includes("function liveSourceBadge(p)"), 'source badge exists');
  ok(html.includes('BROWSER'), 'browser source label');
  for (const label of ['Payment Reference', 'Payment Source', 'Resource / Service', 'Sender', 'Recipient', 'Sponsor']) {
    ok(html.includes(`inspector-label">${label}<`), `detail field ${label}`);
  }
  const v = html.slice(html.indexOf('function liveProofProgress(p)'), html.indexOf('function renderLiveProofProgress(p)'));
  ok(v.includes('v.available === true') && v.includes('v.finalized === true') && v.includes('v.observed === \'finalized\''), 'evidence gate strict');
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nbrowser-payment-listing: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
