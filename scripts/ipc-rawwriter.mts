/**
 * Raw writer probe, run as a NON-owner OS user.
 *
 * Attempts to open the owner's (Owner-private) SQLite database for writing
 * and insert an approval. Reports the exact OS/SQLite error so an OS
 * permission failure can be distinguished from an application-level
 * authorization rejection.
 *
 * the target is the Owner-private database (`authz.db`,
 * `authorizations` table). The settlement database no longer holds
 * authorization records at all; a raw write there cannot fabricate one.
 *
 * Run (as a different user): npx tsx scripts/ipc-rawwriter.mts <db-path> <digest>
 */

import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const digest = process.argv[3];
if (!dbPath || !digest) {
  console.error('usage: ipc-rawwriter.mts <db-path> <digest>');
  process.exit(2);
}

const report = (stage: string, err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';
  // Distinguish OS-level denial from an application/SQL-level rejection.
  const os = /EACCES|EPERM|SQLITE_CANTOPEN|SQLITE_READONLY|unable to open/i.test(msg) || /EACCES|EPERM/.test(code);
  console.log(JSON.stringify({ stage, layer: os ? 'OS_PERMISSION' : 'SQL_OR_APP', code, message: msg }));
};

let db: InstanceType<typeof DatabaseSync> | null = null;
try {
  db = new DatabaseSync(dbPath);
  console.log(JSON.stringify({ stage: 'open', layer: 'OK', message: 'opened for write' }));
} catch (e) {
  report('open', e);
  process.exit(0);
}

try {
  db.exec(
    `INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES ('${digest}', 1, 'approved', NULL, 'ccd:4221332d34e1694168c2a0c0b3fd0f27', 's', 'sp', 'r', '1', 'raw')`,
  );
  console.log(JSON.stringify({ stage: 'insert', layer: 'OK', message: 'APPROVAL INSERTED BY RAW WRITER' }));
} catch (e) {
  report('insert', e);
}

try {
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM authorizations WHERE payment_digest = ? AND decision = 'approved'").get(digest) as {
      n: number;
    }
  ).n;
  console.log(JSON.stringify({ stage: 'verify', approved: Number(n) }));
} catch (e) {
  report('verify', e);
}
db.close();
