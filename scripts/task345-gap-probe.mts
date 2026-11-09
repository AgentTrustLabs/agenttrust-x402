/**
 * TASK 34.5 step 1 — reproduce the remaining gap.
 *
 * Creates a VALID payment (state='created', tx_hash IS NULL) in an isolated temp DB and
 * attempts a direct raw SQL INSERT of an approval. Records the actual SQLite verdict.
 *
 * Run: npx tsx scripts/task345-gap-probe.mts
 */

import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';

const dir = mkdtempSync(join(tmpdir(), 't345-'));
const db = join(dir, 'f.db');
const d = 'a'.repeat(64);

const rawInsert = (digest: string, label: string) => {
  const sql = new DatabaseSync(db);
  let err: string | null = null;
  try {
    sql.exec(
      `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version)
       VALUES ('${digest}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'raw')`,
    );
  } catch (e) {
    err = (e as Error).message;
  }
  const n = (sql.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest=? AND decision='approved'").get(digest) as { n: number }).n;
  sql.close();
  console.log(`   ${label}: approved rows now = ${n}${err ? ` | SQLite said: ${err}` : ' | SQLite ACCEPTED the insert'}`);
  return { err, n: Number(n) };
};

console.log('══ step 1: raw SQL approval for a VALID created payment ══');
{
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
  const row = repo.get(d);
  console.log(`   payment state=${row?.state} tx_hash=${row?.tx_hash === null ? 'NULL' : row?.tx_hash}`);
  repo.close();

  const r = rawInsert(d, 'raw INSERT approved (created, NULL hash)');
  console.log(
    r.n > 0
      ? '   >>> GAP CONFIRMED: raw SQL created an approval the gate never issued'
      : '   >>> gap not reproducible: SQLite refused it',
  );
}

console.log('\n══ step 1b: control — raw SQL approval for a prepared payment ══');
{
  const d2 = 'b'.repeat(64);
  const repo = new SqliteSettlementRepository(db);
  repo.noteVerified(d2, 'k');
  repo.claim(d2, 'k');
  repo.prepare(d2, 'tx-b');
  repo.close();
  rawInsert(d2, 'raw INSERT approved (prepared)');
}

rmSync(dir, { recursive: true, force: true });
