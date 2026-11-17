/**
 * Explicit migration: pre-11.1 shared database → Owner-private authorization database.
 *
 * the split Owner authorization state out of the facilitator settlement
 * database. A deployment that ran the authorization binding (PR #8) on the shared file has its
 * authorization rows (`sign_events`, `sign_attempts`) in the settlement file.
 * This script copies ONLY those rows into a NEW Owner-private database file.
 *
 * Safety rules (all enforced, fail closed):
 *   - The legacy database is opened READ-ONLY. It is never modified, and no
 *     row is ever deleted from it. The old rows stay in the settlement file
 *     as inert evidence; the facilitator code no longer reads them.
 *   - Nothing is copied except authorization rows. No private keys, wallet
 *     material, payment rows, or settlement records are touched.
 *   - Every row is validated BEFORE anything is written. An ambiguous or
 *     incomplete legacy row refuses the whole migration — the operator fixes
 *     the source data (or accepts the loss explicitly by deleting the row
 *     from a COPY) instead of the script guessing.
 *     - Approved rows must have ALL binding fields non-NULL
 *       (authorization_id, transaction_digest, transaction_type,
 *       max_energy, max_fee_microccd, asset, amount, expiry). A NULL means
 *       the approval predates the binding and cannot be certified — it is
 *       ambiguous, so the migration refuses.
 *     - Rejected rows must have consumed_at AND revoked_at NULL.
 *     - No row may have BOTH consumed_at and revoked_at non-NULL.
 *     - authorization_id must be unique.
 *     - At most one LIVE approval (approved + consumed_at NULL) per payment.
 *   - The target must not already hold authorization rows. The script never
 *     merges into existing Owner state.
 *   - Row counts are verified after the copy (source == target per table).
 *   - The target files are chmodded 0600. The operator must create the
 *     target directory beforehand, owned by the Owner UID, mode 0700 —
 *     the script refuses a target directory owned by another UID or with
 *     any group/other permission bits. The migrated files are chowned to
 *     the target directory's owner (that IS the Owner UID) and verified
 *     afterwards: a migration run as root that left root-owned files
 *     behind would lock the Owner out of its own database, so ownership
 *     is enforced here, not left to a manual step.
 *
 * Run (as root, or as the Owner UID with the target dir already prepared):
 *   npx tsx scripts/migrate-owner-authz-db.mts --legacy-db /path/to/facilitator.db --owner-db /path/to/owner/authz.db
 *
 * After a successful migration, point the Owner at the new file with
 * AUTHZ_DB_FILE and restart it; the Owner's legacy-state gate refuses to
 * start against an unmigrated settlement database, so the migration is a
 * precondition, not an afterthought.
 *
 * No deployment, no signing, no broadcast, no CCD movement in this script.
 */

import { chmodSync, chownSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_AUTHORIZATION_SCHEMA } from '../services/facilitator/src/ownerAuthorizationRepository.js';

const fail = (msg: string): never => {
  console.error(`migrate-owner-authz-db: REFUSED: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const legacyPath = getArg('--legacy-db');
const ownerPath = getArg('--owner-db');
if (!legacyPath || !ownerPath) {
  console.error('usage: npx tsx scripts/migrate-owner-authz-db.mts --legacy-db <settlement-db> --owner-db <new-owner-db>');
  process.exit(2);
}
if (!legacyPath.startsWith('/') || !ownerPath.startsWith('/')) fail('both paths must be absolute');
if (legacyPath === ownerPath) fail('legacy and owner paths must differ');
if (!existsSync(legacyPath)) fail(`legacy database does not exist: ${legacyPath}`);
if (dirname(legacyPath) === dirname(ownerPath)) fail('owner database must live in a different directory from the settlement database');

// Target directory: operator-prepared, Owner-owned, 0700.
const targetDir = dirname(ownerPath);
if (!existsSync(targetDir)) fail(`target directory does not exist (create it owned by the Owner UID, mode 0700): ${targetDir}`);
const dirStat = statSync(targetDir);
if (dirStat.uid !== process.getuid() && process.getuid() !== 0) fail(`target directory ${targetDir} is owned by uid ${dirStat.uid}, not ${process.getuid()}`);
if ((dirStat.mode & 0o077) !== 0) fail(`target directory ${targetDir} has group/other permissions (mode 0o${(dirStat.mode & 0o777).toString(8)}) — must be 0700`);

// ── read legacy state (read-only) ────────────────────────────────────────
interface LegacyEvent {
  payment_digest: string;
  decided_at: number;
  decision: string;
  reason: string | null;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  energy: string;
  policy_version: string;
  asset: string | null;
  amount: string | null;
  expiry: number | null;
  authorization_id: string | null;
  transaction_digest: string | null;
  transaction_type: string | null;
  max_energy: string | null;
  max_fee_microccd: string | null;
  consumed_at: number | null;
  revoked_at: number | null;
}
interface LegacyAttempt {
  payment_digest: string;
  decided_at: number;
  decision: string;
  reason: string;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  energy: string;
  policy_version: string;
}

const legacy = new DatabaseSync(legacyPath, { readOnly: true });
let events: LegacyEvent[];
let attempts: LegacyAttempt[];
try {
  try {
    events = legacy.prepare('SELECT * FROM sign_events ORDER BY id').all() as LegacyEvent[];
  } catch {
    events = [];
  }
  try {
    attempts = legacy.prepare('SELECT * FROM sign_attempts ORDER BY id').all() as LegacyAttempt[];
  } catch {
    attempts = [];
  }
} finally {
  legacy.close();
}

// ── validate everything before writing anything ──────────────────────────
const problems: string[] = [];
const seenIds = new Set<string>();
const livePerPayment = new Map<string, number>();
for (const ev of events) {
  const label = `sign_events id=${ev.payment_digest.slice(0, 8)}… decision=${ev.decision}`;
  if (ev.decision !== 'approved' && ev.decision !== 'rejected') problems.push(`${label}: unknown decision ${ev.decision}`);
  if (ev.consumed_at !== null && ev.revoked_at !== null) problems.push(`${label}: both consumed_at and revoked_at set (ambiguous)`);
  if (ev.decision === 'rejected' && (ev.consumed_at !== null || ev.revoked_at !== null)) {
    problems.push(`${label}: rejected row carries consumed_at/revoked_at`);
  }
  if (ev.decision === 'approved') {
    const missing: string[] = [];
    for (const f of ['authorization_id', 'transaction_digest', 'transaction_type', 'max_energy', 'max_fee_microccd', 'asset', 'amount', 'expiry'] as const) {
      if (ev[f] === null) missing.push(f);
    }
    if (missing.length > 0) problems.push(`${label}: approved row is missing binding fields: ${missing.join(', ')} (legacy incomplete state — cannot be certified)`);
    if (ev.authorization_id !== null) {
      if (seenIds.has(ev.authorization_id)) problems.push(`${label}: duplicate authorization_id ${ev.authorization_id}`);
      seenIds.add(ev.authorization_id);
    }
    if (ev.consumed_at === null) {
      livePerPayment.set(ev.payment_digest, (livePerPayment.get(ev.payment_digest) ?? 0) + 1);
    }
  }
}
for (const [digest, n] of livePerPayment) {
  if (n > 1) problems.push(`payment ${digest.slice(0, 8)}…: ${n} live approvals (at most one allowed)`);
}
for (const at of attempts) {
  if (at.decision !== 'rejected') problems.push(`sign_attempts payment=${at.payment_digest.slice(0, 8)}…: decision is not 'rejected'`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`  - ${p}`);
  fail(`${problems.length} ambiguous/incomplete legacy row(s) — migration refused, nothing written`);
}

// ── target must be empty ─────────────────────────────────────────────────
if (existsSync(ownerPath)) {
  const existing = new DatabaseSync(ownerPath, { readOnly: true });
  try {
    for (const table of ['authorizations', 'authorization_attempts']) {
      let n = 0;
      try {
        n = Number((existing.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      } catch {
        n = 0; // table missing: empty
      }
      if (n > 0) fail(`target database already holds ${n} row(s) in ${table} — refusing to merge into existing Owner state`);
    }
  } finally {
    existing.close();
  }
}

// ── copy ─────────────────────────────────────────────────────────────────
const target = new DatabaseSync(ownerPath);
try {
  target.exec('PRAGMA journal_mode = WAL;');
  target.exec('PRAGMA synchronous = FULL;');
  target.exec(OWNER_AUTHORIZATION_SCHEMA);
  target.exec('BEGIN IMMEDIATE');
  try {
    const insertEvent = target.prepare(
      'INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const ev of events) {
      insertEvent.run(
        ev.payment_digest, ev.decided_at, ev.decision, ev.reason, ev.network, ev.sender, ev.sponsor,
        ev.recipient, ev.energy, ev.policy_version, ev.asset, ev.amount, ev.expiry, ev.authorization_id,
        ev.transaction_digest, ev.transaction_type, ev.max_energy, ev.max_fee_microccd, ev.consumed_at, ev.revoked_at,
      );
    }
    const insertAttempt = target.prepare(
      'INSERT INTO authorization_attempts (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    for (const at of attempts) {
      insertAttempt.run(
        at.payment_digest, at.decided_at, at.decision, at.reason, at.network, at.sender, at.sponsor,
        at.recipient, at.energy, at.policy_version,
      );
    }
    // Verify counts BEFORE commit: a mismatch rolls the whole copy back
    // instead of leaving a committed, inconsistent target behind.
    const nEvents = Number((target.prepare('SELECT COUNT(*) AS n FROM authorizations').get() as { n: number }).n);
    const nAttempts = Number((target.prepare('SELECT COUNT(*) AS n FROM authorization_attempts').get() as { n: number }).n);
    if (nEvents !== events.length || nAttempts !== attempts.length) {
      throw new Error(`count mismatch after copy (authorizations ${nEvents}/${events.length}, attempts ${nAttempts}/${attempts.length})`);
    }
    target.exec('COMMIT');
  } catch (e) {
    try { target.exec('ROLLBACK'); } catch { /* best-effort */ }
    throw e;
  }
  // Checkpoint the WAL so no un-checkpointed data is left in a sidecar
  // file the Owner would have to recover on first open.
  try { target.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best-effort */ }
} finally {
  target.close();
}
// Ownership + permissions: the target files must belong to the Owner UID
// (the target directory's owner — that IS the Owner UID by definition) at
// 0600. When run as root the files are created root-owned, so chown them
// explicitly; when run as the Owner UID the chown is a no-op. WAL/SHM/
// journal siblings are covered too — a root-owned -wal would block the
// Owner from operating the database. Verified after the fact; any failure
// here refuses the migration explicitly instead of leaving a file the
// Owner cannot use.
const ownerUid = dirStat.uid;
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const p = `${ownerPath}${suffix}`;
  if (!existsSync(p)) continue;
  try {
    chownSync(p, ownerUid, -1);
    chmodSync(p, 0o600);
  } catch (e) {
    fail(`cannot set ownership/permissions on ${p}: ${(e as Error)?.message ?? e}`);
  }
  const st = statSync(p);
  if (st.uid !== ownerUid) fail(`${p} is owned by uid ${st.uid}, not the Owner uid ${ownerUid}`);
  if ((st.mode & 0o777) !== 0o600) fail(`${p} has mode 0o${(st.mode & 0o777).toString(8)}, not 0600`);
}

console.log(`migrate-owner-authz-db: OK — copied ${events.length} authorization row(s) and ${attempts.length} attempt row(s) from ${legacyPath} to ${ownerPath}`);
console.log('migrate-owner-authz-db: legacy database was opened read-only and NOT modified; old rows remain there as inert evidence.');
