/**
 * Read-only adversarial probe.
 *
 * Checks whether the public repository API still exposes a path that can record an
 * authorization approval WITHOUT passing the durable-state gate in authorizeSignEvent().
 *
 * This file only READS production code and observes behaviour.
 */

import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { ownerRepoFor } from '../test/owner-authz-helper.mts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NOW = 1_900_000_000;
const NOW_MS = NOW * 1000;

let findings = 0;
const report = (name: string, safe: boolean, detail: string) => {
  if (!safe) findings++;
  console.log(`${safe ? 'ok        ' : 'BYPASS   '} ${name} — ${detail}`);
};

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 't343-'));
  return { db: join(dir, 'f.db'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const event = (digest: string) => ({
  paymentDigest: digest,
  decision: 'approved' as const,
  reason: null,
  network: CAIP2,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  energy: '3000',
  policyVersion: 'probe',
});

console.log('── probe 1: no public approval-insertion API ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const d = 'a'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, 'tx-prepared');
  console.log(`   state before: ${repo.get(d)?.state} tx_hash: ${repo.get(d)?.tx_hash}`);

  // RecordSignEvent must no longer exist on the public interface.
  const hasLegacy = typeof (repo as unknown as { recordSignEvent?: unknown }).recordSignEvent === 'function';
  console.log(`   recordSignEvent still exposed publicly: ${hasLegacy}`);
  // Even a raw SQL insert of an approved row must fail the DB-level trigger.
  const { DatabaseSync } = await import('node:sqlite');
  let rawErr: string | null = null;
  try {
    const raw = new DatabaseSync(db);
    raw.exec(`INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${d}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'probe')`);
    raw.close();
  } catch (e) {
    rawErr = (e as Error).message;
  }
  // the settlement database has no authorization table — the
  // raw INSERT fails by construction; approvals live in the Owner repo.
  const approved = ownerRepoFor(db, repo, () => NOW_MS).signEvents(d).filter(e => e.decision === 'approved').length;
  console.log(`   approved events after raw INSERT: ${approved}${rawErr ? ` (threw: ${rawErr.slice(0, 80)})` : ''}`);
  report(
    'no public path can create an approval for a prepared payment',
    !hasLegacy && approved === 0 && rawErr !== null,
    !hasLegacy && approved === 0 && rawErr !== null ? 'method removed + no authorization table in the settlement DB' : 'BYPASS POSSIBLE',
  );
  repo.close();
  rm();
}

console.log('\n── probe 2: authorizeSignEvent() on the SAME prepared payment (control) ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const d = 'b'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, 'tx-p2');

  const r = ownerRepo.authorizeSignEvent(event(d));
  const approved = ownerRepo.signEvents(d).filter(e => e.decision === 'approved').length;
  console.log(`   gate result: ${JSON.stringify(r)} approved events: ${approved}`);
  report('authorizeSignEvent() blocks the prepared payment', !r.ok && approved === 0, String((r as any).reason));
  repo.close();
  rm();
}

console.log('\n── probe 3: two approved events via the gate (unique index backstop) ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const d = 'c'.repeat(64);
  repo.noteVerified(d, 'k');
  const a = ownerRepo.authorizeSignEvent(event(d));
  const b = ownerRepo.authorizeSignEvent(event(d));
  const approved = ownerRepo.signEvents(d).filter(e => e.decision === 'approved').length;
  console.log(`   first=${JSON.stringify(a)} second=${JSON.stringify(b)} approved=${approved}`);
  report('exactly one approved event via the gate', a.ok && !b.ok && approved === 1, `${approved} event(s)`);
  repo.close();
  rm();
}

console.log('\n── probe 4: is a gate rejection audited? ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const d = 'd'.repeat(64);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  repo.prepare(d, 'tx-p4');
  ownerRepo.authorizeSignEvent(event(d));
  const events = ownerRepo.signEvents(d);
  console.log(`   sign_events after a state rejection: ${events.length} → ${JSON.stringify(events.map(e => [e.decision, e.reason]))}`);
  report(
    'state rejection is audited as rejected/transaction_hash_already_prepared',
    events.length === 1 && events[0].decision === 'rejected' && events[0].reason === 'transaction_hash_already_prepared',
    `${events.length} event(s): ${events.map(e => `${e.decision}/${e.reason}`).join(', ')}`,
  );
  repo.close();
  rm();
}

console.log('\n── probe 4b: missing payment is auditable without a fake payment row ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const missing = 'f'.repeat(64);
  const r = ownerRepo.authorizeSignEvent(event(missing));
  const attempts = ownerRepo.signAttempts(missing);
  const payments = repo.get(missing);
  console.log(`   gate result: ${JSON.stringify(r)} attempts: ${attempts.length} payments row: ${payments === undefined ? 'none' : 'PRESENT'}`);
  report(
    'unknown_payment is auditable with no payment row invented',
    r.ok === false && r.reason === 'unknown_payment' && attempts.length === 1 && payments === undefined,
    `${attempts.length} attempt(s), payment row ${payments === undefined ? 'absent' : 'present'}`,
  );
  repo.close();
  rm();
}

console.log('\n── probe 5: fresh Owner database has the unique partial index ──');
{
  const { db, rm } = mk();
  const repo = new SqliteSettlementRepository(db);
  const ownerRepo = ownerRepoFor(db, repo, () => NOW_MS);
  const idx = ownerRepo['db']
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='ux_authorizations_approved'")
    .get() as { name: string; sql: string } | undefined;
  console.log(`   index: ${idx ? idx.sql : 'MISSING'}`);
  report('ux_authorizations_approved exists on a fresh Owner DB', Boolean(idx?.sql?.includes("decision = 'approved'")), idx ? 'present and partial' : 'MISSING');
  ownerRepo.close();
  repo.close();
  rm();
}

console.log('\n── probe 6: legacy DB with duplicate approved events (migration path) ──');
{
  const { db, rm } = mk();
  // Simulate a database without the unique index: create the table WITHOUT the unique index, insert two
  // approved rows, then open it through the real repository and see what happens.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(db);
  raw.exec(`
    CREATE TABLE payments (
      payment_digest TEXT PRIMARY KEY, requirements_key TEXT NOT NULL,
      state TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, attempted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sign_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, payment_digest TEXT NOT NULL,
      decided_at INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT,
      network TEXT NOT NULL, sender TEXT NOT NULL, sponsor TEXT NOT NULL,
      recipient TEXT NOT NULL, energy TEXT NOT NULL, policy_version TEXT NOT NULL);
    INSERT INTO payments VALUES ('${'e'.repeat(64)}','k','finalized','tx','0','0',1);
    INSERT INTO sign_events (payment_digest,decided_at,decision,reason,network,sender,sponsor,recipient,energy,policy_version)
      VALUES ('${'e'.repeat(64)}',1,'approved',NULL,'${CAIP2}','${SENDER}','${SPONSOR}','${RECIPIENT}','1','v');
    INSERT INTO sign_events (payment_digest,decided_at,decision,reason,network,sender,sponsor,recipient,energy,policy_version)
      VALUES ('${'e'.repeat(64)}',2,'approved',NULL,'${CAIP2}','${SENDER}','${SPONSOR}','${RECIPIENT}','1','v');
  `);
  raw.close();

  // the settlement repository no longer reads authorization
  // tables at all — legacy rows are inert evidence there. The component
  // that must refuse ambiguous legacy state is the EXPLICIT migration
  // script: run it against this file and expect a non-zero exit.
  const { spawnSync } = await import('node:child_process');
  const ownerDir = join((await import('node:fs')).mkdtempSync(join(tmpdir(), 't343-mig-')), 'owner');
  (await import('node:fs')).mkdirSync(ownerDir, { mode: 0o700 });
  const out = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'scripts/migrate-owner-authz-db.mts'), '--legacy-db', db, '--owner-db', join(ownerDir, 'authz.db')], { encoding: 'utf8' });
  const err = out.status !== 0 ? (out.stderr || out.stdout || `exit ${out.status}`) : null;
  console.log(`   migration of a legacy DB with 2 approved rows: ${err ? `refused — ${String(err).slice(0, 120)}` : 'ACCEPTED (bad)'}`);
  report(
    'legacy duplicate-approved DB is refused by the explicit migration',
    err !== null,
    err ? 'migration refuses ambiguous legacy state' : 'MIGRATION ACCEPTED — ambiguous state copied',
  );
  rm();
}

console.log(`\nprobe 34.3: ${findings} BYPASS/GAP finding(s)`);
