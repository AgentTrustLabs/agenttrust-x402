/**
 * Demo: verify the recorded real AgentTrust x402 Testnet payment — read-only.
 *
 * This script PROVES the payment happened; it does NOT make one. It performs only:
 *   - a read-only gRPC `getBlockItemStatus` for the recorded transaction hash, and
 *   - HTTP GETs against the local facilitator (`/healthz`, `/supported`) when it is running, and
 *   - an optional read-only SQLite count check against the facilitator DB when it is accessible.
 *
 * No signing, no POST, no settlement, no broadcast, no private keys, no wallet files.
 * Run: npx tsx scripts/demo-real-payment.mts
 *
 * Exit 0: every applicable check passed. Exit 1: at least one check failed.
 * A check reports SKIP (not failure) when its source is not available on this machine
 * (facilitator not running, DB not readable) — the on-chain checks are the authoritative ones.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { TransactionHash } from '@concordium/web-sdk/types';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE_PATH = join(ROOT, 'docs/evidence/real-payment-2026-11-11.json');
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8787';
const DB_PATH = process.env.FACILITATOR_DB_PATH ?? '/home/agenttrust/.agenttrust/facilitator.db';

type Outcome = 'ok' | 'FAIL' | 'SKIP';
const results: Array<[Outcome, string, string]> = [];
const check = (name: string, outcome: Outcome, detail = '') => {
  results.push([outcome, name, detail]);
  console.log(`${outcome === 'ok' ? 'ok  ' : outcome === 'FAIL' ? 'FAIL' : 'SKIP'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as Record<string, unknown>;
const txHash = String(evidence.transaction_hash);
const bigReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? String(v) : v);

console.log('AgentTrust x402 — real payment evidence check');
console.log(`transaction : ${txHash}`);
console.log(`network     : ${String(evidence.network_name)} (${String(evidence.network)})`);
console.log(`explorer    : ${String(evidence.explorer_url)}`);
console.log('');

// ── 1. evidence file sanity ──────────────────────────────────────────────
check('evidence hash is 64 hex chars', /^[0-9a-f]{64}$/.test(txHash) ? 'ok' : 'FAIL');
check('evidence status is finalized', evidence.status === 'finalized' ? 'ok' : 'FAIL');

// ── 2. on-chain verification (live Testnet node, read-only) ──────────────
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
let status: any = null;
try {
  status = await client.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  check('on-chain status is finalized', status.status === 'finalized' ? 'ok' : 'FAIL', `status=${String(status.status)}`);
} catch (e) {
  check('on-chain status is finalized', 'FAIL', `node query failed: ${(e as Error).message.slice(0, 120)}`);
}
if (status) {
  const s = status.outcome?.summary ?? {};
  const transfer = s.transfer ?? {};
  const sponsorObj = s.sponsor ?? {};
  // The SDK returns amounts as CcdAmount objects: String() gives CCD decimals
  // ("0.000001"), JSON gives microCCD ("1"). Normalize everything to microCCD.
  const toMicro = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'object' && (v as any).microCcdAmount !== undefined) return String((v as any).microCcdAmount);
    if (typeof v === 'string' && /^\d+$/.test(v)) return v;
    if (typeof v === 'string' && /^\d+\.\d+$/.test(v)) return String(Math.round(Number(v) * 1e6));
    if (typeof v === 'number') return String(Math.round(v * 1e6));
    return String(v);
  };
  check('on-chain block hash matches evidence', String(status.outcome?.blockHash ?? '') === String(evidence.block_hash) ? 'ok' : 'FAIL');
  check('on-chain sender matches evidence', String(s.sender ?? '') === String(evidence.sender) ? 'ok' : 'FAIL');
  check('on-chain sponsor matches evidence', String(sponsorObj.sponsor ?? '') === String(evidence.sponsor) ? 'ok' : 'FAIL');
  check('on-chain recipient matches evidence', String(transfer.to ?? '') === String(evidence.recipient) ? 'ok' : 'FAIL');
  check('on-chain amount is 1 microCCD', toMicro(transfer.amount) === String(evidence.amount_micro_ccd) ? 'ok' : 'FAIL', `amount=${toMicro(transfer.amount)} microCCD`);
  check('on-chain energy is 635 NRG', String(s.energyCost?.value ?? '') === String(evidence.energy_nrg) ? 'ok' : 'FAIL', `energy=${String(s.energyCost?.value ?? '?')}`);
  check('on-chain sponsor fee matches evidence', toMicro(sponsorObj.cost) === String(evidence.sponsor_fee_micro_ccd) ? 'ok' : 'FAIL', `fee=${toMicro(sponsorObj.cost)} microCCD`);
  console.log(`\nExplorer: ${String(evidence.explorer_url)}`);
}

// ── 3. facilitator liveness (local, read-only GETs) ──────────────────────
let health: any = null;
try {
  const res = await fetch(`${FACILITATOR_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
  health = await res.json();
  check('facilitator /healthz is healthy', res.status === 200 && health.ok === true ? 'ok' : 'FAIL', `HTTP ${res.status} ok=${String(health.ok)} mode=${String(health.mode)} canSign=${String(health.canSign)} ownerReachable=${String(health.ownerReachable)}`);
} catch {
  check('facilitator /healthz is healthy', 'SKIP', `facilitator not reachable at ${FACILITATOR_URL} (start it per docs/demo-runbook.md, or judge the on-chain evidence alone)`);
}
if (health?.ok) {
  try {
    const res = await fetch(`${FACILITATOR_URL}/supported`, { signal: AbortSignal.timeout(5000) });
    const sup: any = await res.json();
    const kind = sup.kinds?.[0] ?? {};
    const feePayerOk = String(kind.extra?.feePayer ?? '') === String(evidence.sponsor);
    const signerOk = (sup.signers?.['ccd:*'] ?? []).includes(String(evidence.sponsor));
    check('facilitator /supported names the sponsor', res.status === 200 && feePayerOk && signerOk ? 'ok' : 'FAIL', `scheme=${String(kind.scheme)} network=${String(kind.network)}`);
  } catch {
    check('facilitator /supported names the sponsor', 'SKIP', 'supported endpoint unreachable');
  }
}

// ── 4. facilitator DB (local, read-only, optional) ───────────────────────
if (existsSync(DB_PATH)) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const digest = String(evidence.payment_digest);
    const n = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
    const payments = n('SELECT COUNT(*) AS n FROM payments WHERE payment_digest = ?', digest);
    const settlements = n('SELECT COUNT(*) AS n FROM settlements WHERE payment_digest = ?', digest);
    const approved = n("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest = ? AND decision = 'approved'", digest);
    const state = (db.prepare('SELECT state AS s FROM payments WHERE payment_digest = ?').get(digest) as { s: string } | undefined)?.s;
    db.close();
    check('DB has exactly 1 finalized payment for the digest', payments === 1 && state === 'finalized' ? 'ok' : 'FAIL', `payments=${payments} state=${String(state)}`);
    check('DB has exactly 1 settlement for the digest', settlements === 1 ? 'ok' : 'FAIL', `settlements=${settlements}`);
    check('DB has exactly 1 approved sign event for the digest', approved === 1 ? 'ok' : 'FAIL', `approved=${approved}`);
  } catch (e) {
    check('DB records match the evidence', 'SKIP', `DB not readable here: ${(e as Error).message.slice(0, 100)}`);
  }
} else {
  check('DB records match the evidence', 'SKIP', `DB not present at ${DB_PATH} on this machine`);
}

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter(([o]) => o === 'FAIL').length;
const passed = results.filter(([o]) => o === 'ok').length;
const skipped = results.filter(([o]) => o === 'SKIP').length;
console.log(`\ndemo-real-payment: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('DEMO FAILED: at least one check did not match the recorded evidence.');
  process.exit(1);
}
console.log('DEMO PASSED: the recorded payment is verified against the live Testnet chain.');
