/**
 * Test helper: seed a payment row directly in the owner's DB.
 * Runs as the owner user only (it needs write access).
 *
 * Run: npx tsx scripts/authz-seed.mts <db-path> <digest>
 */

import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';

const dbPath = process.argv[2];
const digest = process.argv[3];
if (!dbPath || !digest) {
  console.error('usage: authz-seed.mts <db-path> <digest>');
  process.exit(2);
}
const r = new SqliteSettlementRepository(dbPath);
r.noteVerified(digest, 'k');
r.claim(digest, 'k');
r.close();
console.log(`seeded ${digest}`);
