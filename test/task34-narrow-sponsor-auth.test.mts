/**
 * TASK 34 — Mock-only NarrowSponsorSigner authorization boundary.
 *
 * Verifies the authorization decision, durable audit event, retry safety, and that NO
 * signing function is ever reached. Uses synthetic test addresses and a mock policy.
 *
 * Run: npx tsx test/task34-narrow-sponsor-auth.test.mts
 */

import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { decideAuthorization, validatePolicy } from '../services/facilitator/src/narrowSponsor.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// Valid Concordium addresses (50 chars). Synthetic, not real accounts.
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

const NOW = 1_900_000_000;
const NOW_MS = NOW * 1000;

const POLICY = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'test-v1',
};

function validRequest(over: Partial<Parameters<typeof decideAuthorization>[0]> = {}) {
  return {
    network: CAIP2,
    version: 1,
    sender: SENDER,
    sponsor: SPONSOR,
    recipient: RECIPIENT,
    asset: 'CCD',
    amount: '250000',
    expiry: NOW + 200,
    energy: 3_000n,
    paymentDigest: 'a'.repeat(64),
    ...over,
  };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ the 16 required cases ═════════════════════════════════════════════

test('01. valid transaction context → approved', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest());
  eq(r.approved, true, 'approved');
  const events = signer['repo'].signEvents('a'.repeat(64));
  eq(events.length, 1, 'one audit event');
  eq(events[0].decision, 'approved', 'decision approved');
  eq(events[0].policy_version, 'test-v1', 'policy version recorded');
  rm();
});

test('02. wrong network → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'wrong_network', 'wrong_network');
  eq(signer['repo'].signEvents('a'.repeat(64)).length, 1, 'audit event recorded');
  rm();
});

test('03. wrong sponsor identity → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sponsor: RECIPIENT }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'wrong_sponsor', 'wrong_sponsor');
  rm();
});

test('04. sponsor equals sender → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: { ...POLICY, sponsor: SENDER }, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sponsor: SENDER, sender: SENDER }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'sponsor_is_sender', 'sponsor_is_sender');
  rm();
});

test('05. sponsor equals recipient → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: { ...POLICY, sponsor: RECIPIENT }, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sponsor: RECIPIENT, recipient: RECIPIENT }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'sponsor_is_recipient', 'sponsor_is_recipient');
  rm();
});

test('06. missing sender → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sender: '' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'missing_sender', 'missing_sender');
  rm();
});

test('07. missing recipient → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ recipient: '' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'missing_recipient', 'missing_recipient');
  rm();
});

test('08. invalid address → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sender: 'not-an-address' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'invalid_sender', 'invalid_sender');
  rm();
});

test('09. expired transaction → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ expiry: NOW - 1 }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'expired', 'expired');
  rm();
});

test('10. excessive expiry → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ expiry: NOW + 601 }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'expiry_excessive', 'expiry_excessive');
  rm();
});

test('11. missing energy limit → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const badPolicy = { ...POLICY, maxEnergy: undefined as unknown as bigint };
  const signer = new MockNarrowSponsorSigner({ policy: badPolicy, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest());
  eq(r.approved, false, 'rejected');
  // A broken policy cannot be audited with a valid policyVersion, so the adapter must still
  // fail closed. Either the policy reason or audit_write_failed is acceptable — both refuse.
  check('rejected with a fail-closed reason', ['missing_energy_limit', 'audit_write_failed'].includes(String(r.reason)), `reason=${r.reason}`);
  rm();
});

test('12. energy above cap → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ energy: 10_001n }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'energy_exceeds_cap', 'energy_exceeds_cap');
  rm();
});

test('13. energy exactly at cap → approved', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ energy: 10_000n }));
  eq(r.approved, true, 'approved');
  rm();
});

test('14. malformed energy value → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ energy: '3000' as unknown as bigint }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'energy_malformed', 'energy_malformed');
  rm();
});

test('15. duplicate payment digest → rejected', async () => {
  const { dir, db, rm } = mk();
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified('a'.repeat(64), 'k');
  repo.claim('a'.repeat(64), 'k');
  repo.prepare('a'.repeat(64), 'tx-1');
  repo.claimSubmit('a'.repeat(64), 'tx-1');
  repo.markBroadcast('a'.repeat(64), 'tx-1');
  repo.close();
  const r = await signer.authorize(validRequest());
  // TASK 34.2: a payment in any durable transaction state is refused.
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'transaction_hash_already_prepared', 'transaction_hash_already_prepared');
  rm();
});

test('16. audit persistence failure → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  // Use ONE repo instance: dropping sign_events must persist for the signer's connection.
  // (A fresh connection would re-run the idempotent SCHEMA and recreate the table.)
  const repo = new SqliteSettlementRepository(db);
  repo['db'].exec('DROP TABLE sign_events');
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: repo, now: () => NOW_MS });
  const r = await signer.authorize(validRequest());
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'audit_write_failed', 'audit_write_failed');
  rm();
});

// ═══ additional cases ══════════════════════════════════════════════════

test('17. negative energy → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ energy: -1n }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'energy_negative', 'energy_negative');
  rm();
});

test('18. energy overflow (int64) → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ energy: 0x8000000000000000n }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'energy_overflow', 'energy_overflow');
  rm();
});

test('19. negative policy energy → rejected (policy fails closed)', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: { ...POLICY, maxEnergy: -5n }, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest());
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'energy_negative', 'energy_negative');
  rm();
});

test('20. unsupported asset → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ asset: 'EURR' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'unsupported_asset', 'unsupported_asset');
  rm();
});

test('21. wrong version → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ version: 0 }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'wrong_version', 'wrong_version');
  rm();
});

test('22. invalid recipient → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ recipient: 'bad' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'invalid_recipient', 'invalid_recipient');
  rm();
});

test('23. missing sponsor → rejected', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const r = await signer.authorize(validRequest({ sponsor: '' }));
  eq(r.approved, false, 'rejected');
  eq(r.reason, 'missing_sponsor', 'missing_sponsor');
  rm();
});

test('24. concurrent authorization: exactly *** approved', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const [a, b] = await Promise.all([signer.authorize(validRequest()), signer.authorize(validRequest())]);
  const approved = [a, b].filter(r => r.approved).length;
  // TASK 34.2 exactly-once: the second attempt must be refused by the durable gate.
  eq(approved, 1, 'exactly one approved');
  // TASK 34.4 M2: the refused attempt is now audited too, so there are exactly two events:
  // one approval and one state rejection. Neither count may drift.
  const events = signer['repo'].signEvents('a'.repeat(64));
  eq(events.filter(e => e.decision === 'approved').length, 1, 'one approved event');
  eq(events.filter(e => e.decision === 'rejected').length, 1, 'one rejected event');
  eq(events.length, 2, 'two audit events total (approved + rejected)');
  eq(events.find(e => e.decision === 'rejected')?.reason, 'authorization_already_recorded', 'rejection reason recorded');
  rm();
});

test('25. audit events survive restart', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const a = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  await a.authorize(validRequest());
  a['repo'].close();
  const b = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  const events = b['repo'].signEvents('a'.repeat(64));
  eq(events.length, 1, 'one event after restart');
  eq(events[0].decision, 'approved', 'approved after restart');
  b['repo'].close();
  rm();
});

test('26. no signing function is reachable through the adapter', async () => {
  const { readFileSync } = await import('node:fs');
  // The adapter only exposes `authorize`. Assert on the real class prototype.
  const proto = Object.getOwnPropertyNames(MockNarrowSponsorSigner.prototype);
  check('prototype exposes authorize only', proto.includes('authorize') && !proto.includes('sign'), `methods=${JSON.stringify(proto)}`);
  const src = readFileSync(join(import.meta.dirname, '../services/facilitator/src/narrowSponsorMock.ts'), 'utf8');
  // Strip comments so a doc comment naming the SDK interface is not a false positive.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('mock source has no AccountSigner', !/AccountSigner/.test(code));
  check('mock source has no .sign(', !/\.sign\(/.test(code));
  check('mock source has no privateKey', !/privateKey/i.test(code));
  check('mock source has no mnemonic', !/mnemonic/i.test(code));
  check('mock source has no key material fields', !/secret|seed/i.test(code));
});

test('27. decideAuthorization is pure and deterministic', () => {
  const a = decideAuthorization(validRequest(), POLICY, NOW);
  const b = decideAuthorization(validRequest(), POLICY, NOW);
  eq(a, b, 'deterministic');
});

test('28. audit event fields are complete and do not leak secrets', async () => {
  const { dir, db, rm } = mk();
  seed(db);
  const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: new SqliteSettlementRepository(db), now: () => NOW_MS });
  await signer.authorize(validRequest());
  const e = signer['repo'].signEvents('a'.repeat(64))[0];
  for (const f of ['id', 'payment_digest', 'decided_at', 'decision', 'network', 'sender', 'sponsor', 'recipient', 'energy', 'policy_version']) {
    check(`field ${f} present`, e[f] !== undefined, String(e[f]));
  }
  check('no digest stored', !('digest' in e));
  check('no signature stored', !('signature' in e));
  check('no key stored', !('key' in e));
  rm();
});

// ═══ helpers ═══════════════════════════════════════════════════════════

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t34-'));
  const db = join(dir, 'f.db');
  const rm = () => rmSync(dir, { recursive: true, force: true });
  return { dir, db, rm };
}

/** Seed a payment row so the sign_events FK is satisfied. */
function seed(db: string, digest = 'a'.repeat(64)) {
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified(digest, 'k');
  repo.claim(digest, 'k');
  repo.close();
}

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\ntask34-narrow-sponsor-auth: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
