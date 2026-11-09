/**
 * TASK 34.5 — coordinated two-statement raw attack.
 *
 * Models an attacker with direct SQLite access who forges a provenance nonce in the same
 * transaction as the approval row. Recorded as evidence of the residual limitation: SQLite
 * cannot distinguish a legitimate authorization transaction from a raw one.
 *
 * Run: npx tsx scripts/authz-coord-attack.mts
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

const dir = mkdtempSync(join(tmpdir(), 't345c-'));
const db = join(dir, 'f.db');
const d = 'a'.repeat(64);

const repo = new SqliteSettlementRepository(db);
repo.noteVerified(d, 'k');
repo.claim(d, 'k');
repo.close();

const raw = new DatabaseSync(db);
let err: string | null = null;
try {
  raw.exec('BEGIN IMMEDIATE');
  raw.exec(
    `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${d}', 1, 'approved', NULL, '${CAIP2}', '${SENDER}', '${SPONSOR}', '${RECIPIENT}', '1', 'raw')`,
  );
  raw.exec('COMMIT');
} catch (e) {
  err = (e as Error).message;
  try {
    raw.exec('ROLLBACK');
  } catch {
    /* already aborted */
  }
}

const n = (
  raw.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest=? AND decision='approved'").get(d) as {
    n: number;
  }
).n;
console.log(
  `coordinated raw attack (single tx, approved insert): approved rows = ${n}` +
    (err ? ` (error: ${err})` : ' — SUCCEEDED'),
);
raw.close();
rmSync(dir, { recursive: true, force: true });
