/**
 * Same-UID control.
 *
 * Runs the raw writer as the OWNER user (authowner) to show that the boundary is a
 * filesystem-ownership boundary, not an application rule. Same UID → access succeeds.
 *
 * Run: npx tsx scripts/ipc-same-uid-control.mts <db-path> <digest>
 */

import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = 'a'.repeat(64);
const dir = mkdtempSync(join(tmpdir(), 't346same-'));
const db = join(dir, 'auth.db');

const repo = new SqliteSettlementRepository(db);
repo.noteVerified(digest, 'k');
repo.claim(digest, 'k');
repo.close();

const sql = new DatabaseSync(db);
let err: string | null = null;
try {
  sql.exec(
    `INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${digest}', 1, 'approved', NULL, 'ccd:4221332d34e1694168c2a0c0b3fd0f27', 's', 'sp', 'r', '1', 'raw')`,
  );
} catch (e) {
  err = (e as Error).message;
}
const n = (
  sql.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest=? AND decision='approved'").get(digest) as {
    n: number;
  }
).n;
sql.close();
console.log(
  `same-UID raw writer (owner UID): approved rows = ${n}` +
    (err ? ` (error: ${err})` : ' — SUCCEEDED: same UID has full access'),
);
rmSync(dir, { recursive: true, force: true });
