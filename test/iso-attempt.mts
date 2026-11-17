/**
 * Adversarial filesystem-attempt helper for the owner-storage-isolation suite.
 *
 * Each operation tries — as the CALLER's UID — to do something only the
 * Owner UID may do to the Owner-private database or key, and reports whether
 * the attacker succeeded. The suite runs this script as the facilitator UID
 * (ubuntu) via sudo and asserts every mutating operation FAILS.
 *
 *   npx tsx test/iso-attempt.mts <op> <ownerDb> <keyFile> [paymentDigest]
 *
 * Ops: open-rw, reset-consumed, clear-revoked, insert-fabricated,
 * replace-row, write-wal, write-shm, read-key, dump (dump always succeeds
 * for a permitted reader; the suite runs it as authowner to read state back).
 *
 * Exit 0 + {"ok":true} means the ATTACKER succeeded. Exit 1 + {"ok":false}
 * means the attempt was refused (the expected outcome for all mutating ops
 * when run as the facilitator UID).
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [op, ownerDb, keyFile, digest] = process.argv.slice(2);
const out = (ok: boolean, detail: string) => {
  console.log(JSON.stringify({ op, ok, detail }));
  process.exit(ok ? 0 : 1);
};

if (!op || !ownerDb || !keyFile) {
  console.error('usage: iso-attempt.mts <op> <ownerDb> <keyFile> [paymentDigest]');
  process.exit(2);
}

const D = digest ?? 'a'.repeat(64);

try {
  switch (op) {
    case 'open-rw': {
      const db = new DatabaseSync(ownerDb);
      try {
        db.exec('CREATE TABLE IF NOT EXISTS __probe (id INTEGER)');
        db.exec('DROP TABLE IF EXISTS __probe');
        out(true, 'read-write open + write succeeded');
      } finally {
        db.close();
      }
      break;
    }
    case 'reset-consumed': {
      const db = new DatabaseSync(ownerDb);
      try {
        const r = db.prepare('UPDATE authorizations SET consumed_at = NULL WHERE payment_digest = ? AND consumed_at IS NOT NULL').run(D);
        out(r.changes > 0, r.changes > 0 ? `reset ${r.changes} row(s)` : 'no consumed row matched (or write refused)');
      } finally {
        db.close();
      }
      break;
    }
    case 'clear-revoked': {
      const db = new DatabaseSync(ownerDb);
      try {
        const r = db.prepare('UPDATE authorizations SET revoked_at = NULL WHERE payment_digest = ? AND revoked_at IS NOT NULL').run(D);
        out(r.changes > 0, r.changes > 0 ? `cleared ${r.changes} row(s)` : 'no revoked row matched (or write refused)');
      } finally {
        db.close();
      }
      break;
    }
    case 'insert-fabricated': {
      const db = new DatabaseSync(ownerDb);
      try {
        db.prepare(
          "INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, authorization_id) VALUES (?, ?, 'approved', NULL, 'ccd:4221332d34e1694168c2a0c0b3fd0f27', 's', 's', 'r', '3000', 'v', '00000000-0000-4000-8000-000000000000')",
        ).run(D, Date.now());
        out(true, 'fabricated approval inserted');
      } finally {
        db.close();
      }
      break;
    }
    case 'replace-row': {
      const db = new DatabaseSync(ownerDb);
      try {
        const r = db.prepare("UPDATE authorizations SET recipient = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8' WHERE payment_digest = ?").run(D);
        out(r.changes > 0, r.changes > 0 ? `replaced ${r.changes} row(s)` : 'no row matched (or write refused)');
      } finally {
        db.close();
      }
      break;
    }
    case 'write-wal': {
      appendFileSync(`${ownerDb}-wal`, Buffer.from('attacker'));
      out(true, 'WAL write succeeded');
      break;
    }
    case 'write-shm': {
      appendFileSync(`${ownerDb}-shm`, Buffer.from('attacker'));
      out(true, 'SHM write succeeded');
      break;
    }
    case 'read-key': {
      const data = readFileSync(keyFile, 'utf8');
      out(data.length > 0, `key readable (${data.length} chars)`);
      break;
    }
    case 'dump': {
      const db = new DatabaseSync(ownerDb, { readOnly: true });
      try {
        const rows = db
          .prepare('SELECT payment_digest, decision, authorization_id, consumed_at, revoked_at FROM authorizations ORDER BY id')
          .all() as Array<Record<string, unknown>>;
        console.log(JSON.stringify({ op, ok: true, rows }));
        process.exit(0);
      } finally {
        db.close();
      }
      break;
    }
    default:
      console.error(`unknown op: ${op}`);
      process.exit(2);
  }
} catch (e) {
  out(false, (e as Error)?.message ?? String(e));
}
