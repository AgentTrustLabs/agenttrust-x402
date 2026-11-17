/**
 * Test helper: migrate the owner's authorizations table.
 * Used to force an audit-write failure. Runs as the owner user only.
 *
 * the table is `authorizations` in the Owner-private database;
 * the settlement database holds no authorization table to rename.
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
  if (action === 'rename') db.exec('ALTER TABLE authorizations RENAME TO authorizations_bak');
  else db.exec('ALTER TABLE authorizations_bak RENAME TO authorizations');
  console.log(`migration ${action} ok`);
} catch (e) {
  console.error(`migration ${action} failed: ${(e as Error).message}`);
  process.exit(1);
}
db.close();
