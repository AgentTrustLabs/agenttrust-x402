/**
 * TASK 34.6 — test helper: migrate the owner's sign_events table.
 * Used to force an audit-write failure. Runs as the owner user only.
 *
 * Run: npx tsx scripts/ipc-migrate.mts <db-path> <rename|restore>
 */

import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const action = process.argv[3];
if (!dbPath || !action) {
  console.error('usage: ipc-migrate.mts <db-path> <rename|restore>');
  process.exit(2);
}
const db = new DatabaseSync(dbPath);
try {
  if (action === 'rename') db.exec('ALTER TABLE sign_events RENAME TO sign_events_bak');
  else db.exec('ALTER TABLE sign_events_bak RENAME TO sign_events');
  console.log(`migration ${action} ok`);
} catch (e) {
  console.error(`migration ${action} failed: ${(e as Error).message}`);
  process.exit(1);
}
db.close();
