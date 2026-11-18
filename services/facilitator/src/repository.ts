/**
 * Durable storage for settlement state.
 *
 * Backed by `node:sqlite` (built into Node ≥22.5; no external dependency, no native build).
 * WAL + `synchronous=FULL` gives per-transaction durability, and the schema enforces the
 * invariants so the application cannot violate them by forgetting a check:
 *
 *  - `payments.payment_digest` is PRIMARY KEY → one row per signed payment, so the same
 *    payment can never be recorded twice, whatever the process does.
 *  - `payment_claims` records *which authorisation* consumed a payment. A second claim for a
 *    different requirements key hits a UNIQUE constraint at the storage layer, not just an
 *    in-memory `if`.
 *  - `settlements` holds idempotency: UNIQUE(payment_digest) means one settlement record per
 *    payment. Re-submitting cannot create a second row.
 *  - `transitions` is an append-only audit log of every state change with evidence and time.
 *
 * The interface (`SettlementRepository`) is intentionally narrow so a shared database can
 * replace the local file without touching the facilitator core.
 *
 * this file holds SETTLEMENT state only. Owner authorization
 * state (approvals, consumption, revocation) lives in a separate,
 * Owner-private database owned by `SqliteOwnerAuthorizationRepository`
 * (`ownerAuthorizationRepository.ts`); the facilitator never opens it.
 * A legacy database file may still contain the old `sign_events` /
 * `sign_attempts` tables as inert evidence — this code no longer creates
 * or reads them.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalStringify } from './canonicalJson.js';
import { chmodSync, existsSync } from 'node:fs';
import {
  canTransition,
  isTerminal,
  interpretObservation,
  IllegalTransitionError,
  type SettlementState,
  type ObservedStatus,
} from './state.js';

/**
 * States in which a broadcast may already be in flight for the recorded hash.
 *
 * From any of these, only verified evidence (`reconcile`) may produce a terminal state.
 * `prepared` is excluded on purpose: the hash is durable but `claimSubmit()` was never
 * taken, so nothing can have reached the node and the payment stays resumable.
 */
const BROADCAST_CAPABLE: readonly SettlementState[] = ['submitting', 'outcome_unknown', 'observed', 'recovery_unavailable'];

export interface PaymentRow {
  payment_digest: string;
  requirements_key: string;
  state: SettlementState;
  tx_hash: string | null;
  created_at: number;
  updated_at: number;
  /** True once any settlement attempt has been authorised for this payment. */
  attempted: number;
  /**
   * Consecutive consistent rejection observations for this payment.
   * 0 until a rejection is observed; reset to 0 by any non-rejection observation.
   * A terminal `rejected` state requires this to reach `REJECTION_CONFIRMATIONS_REQUIRED`.
   */
  rejection_observation_count: number;
}

/** How many consistent rejection observations a terminal rejection requires. */
export const REJECTION_CONFIRMATIONS_REQUIRED = 2;

export interface TransitionRow {
  id: number;
  payment_digest: string;
  from_state: SettlementState | null;
  to_state: SettlementState;
  reason: string;
  tx_hash: string | null;
  evidence: string | null;
  at: number;
}

export type ClaimResult =
  /** First time we have seen this payment: safe to attempt. */
  | { ok: true; claim: 'fresh' }
  /**
   * The hash is durable and the broadcast claim is still available. A new process
   * may resume: it must call `claimSubmit()` with the returned hash, which is atomic.
   */
  | { ok: true; claim: 'resumable'; transaction: string }
  /** Already settled: return the recorded hash, do not submit again. */
  | { ok: true; claim: 'idempotent'; transaction: string }
  /** Another attempt is in flight for the same payment. */
  | { ok: false; reason: 'in_progress' }
  /** Previously attempted and ended terminally; needs a new payload. */
  | { ok: false; reason: 'terminal'; state: SettlementState }
  /** Attempted before, outcome unknown: must be reconciled, never retried. */
  | { ok: false; reason: 'pending'; transaction: string | null }
  /** Same payment presented for a different authorisation. */
  | { ok: false; reason: 'different_authorisation'; recorded: string };

export interface ReconcileInput {
  paymentDigest: string;
  transaction: string;
  observed: ObservedStatus;
  /** Free-form provenance of the evidence, e.g. "verifier:mock-grpc" */
  evidenceSource: string;
  /** Stable digest of the raw evidence payload, so the audit log is tamper-evident. */
  evidenceDigest: string;
}

export type ReconcileResult =
  | { ok: true; changed: boolean; state: SettlementState; reason: string }
  | { ok: false; reason: string };

export interface SignEventRow {
  id: number;
  payment_digest: string;
  decided_at: number;
  decision: 'approved' | 'rejected';
  reason: string | null;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  energy: string;
  policy_version: string;
  /** Null on legacy rows; recovery must fail closed for those. */
  asset: string | null;
  amount: string | null;
  expiry: number | null;
  /** . Null on legacy rows and on rejections. */
  authorization_id: string | null;
  transaction_digest: string | null;
  transaction_type: string | null;
  max_energy: string | null;
  max_fee_microccd: string | null;
  /** ms since epoch when the authorization was consumed, or null. */
  consumed_at: number | null;
  /** ms since epoch when the authorization was revoked, or null. */
  revoked_at: number | null;
}

export type AuthorizeSignResult =
  | { ok: true; authorizationId: string | null }
  | { ok: false; reason: 'unknown_payment' | 'payment_not_authorizable' | 'transaction_hash_already_prepared' | 'authorization_already_recorded' | 'payment_digest_mismatch' };

/**
 * Audit row for an authorization attempt whose payment does not exist.
 *
 * these rows live in the Owner-private database
 * (`authorization_attempts` table, `ownerAuthorizationRepository.ts`).
 * The type is kept here because the authorization repository and the
 * Owner launcher share it; this file no longer creates or reads the table.
 */
export interface SignAttemptRow {
  id: number;
  payment_digest: string;
  decided_at: number;
  decision: 'rejected';
  reason: string;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  energy: string;
  policy_version: string;
}

export interface SignEventInput {
  paymentDigest: string;
  decision: 'approved' | 'rejected';
  reason?: string | null;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  energy: string;
  policyVersion: string;
  /**
   * Payment context that must be bound into the durable record. Omit only for
   * legacy audit paths; an approval recorded without them cannot be recovered (fail closed).
   */
  asset?: string;
  amount?: string;
  expiry?: number;
  /**
   * the exact transaction the approval covers. An approval recorded
   * without a transaction digest/type cannot be issued as a certificate and
   * cannot be consumed (fail closed). Omit only for legacy audit paths.
   */
  authorizationId?: string;
  transactionDigest?: string;
  transactionType?: string;
  maxEnergy?: string;
  maxFeeMicroCcd?: string;
}

/** Input to the atomic authorization-consumption gate. */
export interface ConsumeAuthorizationInput {
  authorizationId: string;
  transactionDigest: string;
  /** AgentTrust payment digest the authorization belongs to. */
  paymentDigest: string;
  network: string;
  sender: string;
  sponsor: string;
  recipient: string;
  asset: string;
  amount: string;
  expiry: number;
  energy: string;
  transactionType: string;
  maxEnergy: string;
  maxFeeMicroCcd: string;
}

export type ConsumeAuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'unknown_authorization'
        | 'authorization_already_consumed'
        | 'authorization_revoked'
        | 'authorization_expired'
        | 'authorization_mismatch'
        | 'payment_not_authorizable'
        | 'transaction_hash_already_prepared';
    };

export type RevokeAuthorizationResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_authorization' | 'authorization_already_consumed' };

export interface SettlementRepository {
  /** Record a fresh verification (no state change beyond noting the payment). */
  noteVerified(paymentDigest: string, requirementsKey: string): { ok: true } | { ok: false; reason: string };
  /** Atomically claim a payment for settlement. */
  claim(paymentDigest: string, requirementsKey: string): ClaimResult;
  /**
   * Persist the final transaction hash BEFORE any broadcast.
   *
   * Transitions `created → prepared` and writes the hash + settlement row in one
   * `BEGIN IMMEDIATE` transaction. After this returns, the identifier is durable and the
   * payment may be submitted. Nothing outside this method may make the hash durable.
   */
  prepare(paymentDigest: string, transaction: string): void;
  /**
   * Take the broadcast claim against an already-persisted hash.
   *
   * `prepared → submitting`. Refuses unless the row is `prepared` and the hash matches exactly,
   * so a process can never start a broadcast against a hash it did not persist.
   */
  claimSubmit(paymentDigest: string, transaction: string): { ok: true } | { ok: false; reason: string };
  /** Record that the broadcast has been attempted (submitting → outcome_unknown). */
  markBroadcast(paymentDigest: string, transaction: string): void;
  /** Record that the node reported the tx exists but is not final. */
  markObserved(paymentDigest: string, transaction: string, reason: string): void;
  /** Record that recovery could not obtain evidence. Non-terminal. */
  markRecoveryUnavailable(paymentDigest: string, transaction: string, reason: string): void;
  /** Record that a submission was accepted and is now awaiting confirmation. */
  markPending(paymentDigest: string, transaction: string, reason: string): void;
  /** Record the broadcast hash before evidence is applied. */
  recordTransaction(paymentDigest: string, transaction: string): void;
  /** Record a terminal failure. Never reachable from `finalized`. */
  markFailed(paymentDigest: string, reason: string, transaction?: string): void;
  /** Apply verified evidence. The ONLY path to `finalized`. */
  reconcile(input: ReconcileInput): ReconcileResult;
  get(paymentDigest: string): PaymentRow | undefined;
  /** Find a payment by its recorded transaction hash. Read-only. */
  getByTransaction(txHash: string): PaymentRow | undefined;
  transitions(paymentDigest: string): TransitionRow[];
  listRecoverable(): PaymentRow[];
  listOutcomeUnknown(): PaymentRow[];
  recoverablePayments(): PaymentRow[];
  pendingCount(): number;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS payments (
  payment_digest   TEXT PRIMARY KEY,
  requirements_key TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('created','prepared','submitting','outcome_unknown','observed','finalized','rejected','recovery_unavailable')),
  tx_hash          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  attempted        INTEGER NOT NULL DEFAULT 0,
  -- bounded confirmation gate for terminal rejection. A single 'failed'/'rejected'
  -- observation does not terminalize; the count must reach 2 consistent observations.
  rejection_observation_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_claims (
  payment_digest   TEXT NOT NULL,
  requirements_key TEXT NOT NULL,
  claimed_at       INTEGER NOT NULL,
  PRIMARY KEY (payment_digest, requirements_key),
  FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)
);

CREATE TABLE IF NOT EXISTS settlements (
  payment_digest TEXT PRIMARY KEY,
  -- "transaction" is a reserved word in SQLite, so the column is named tx_hash.
  tx_hash        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)
);

CREATE TABLE IF NOT EXISTS transitions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_digest TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  tx_hash        TEXT,
  evidence       TEXT,
  at             INTEGER NOT NULL,
  FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)
);

CREATE INDEX IF NOT EXISTS idx_transitions_payment ON transitions(payment_digest, id);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);
`;
// the old sign_events / sign_attempts tables and the
// approved-requires-created trigger are GONE from this schema. Owner
// authorization state lives in the Owner-private database
// (ownerAuthorizationRepository.ts). A legacy file keeps its old tables
// as inert evidence; this code neither creates nor reads them.

export class SqliteSettlementRepository implements SettlementRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(path: string, opts: { now?: () => number; busyTimeoutMs?: number; fileMode?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.db = new DatabaseSync(path);
    // Multi-process contention: without a busy timeout, a second writer's BEGIN IMMEDIATE
    // fails instantly with SQLITE_BUSY instead of waiting for the first to commit. 5s is
    // longer than any transaction here can reasonably take, and still bounded.
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)}`);
    this.db.exec(SCHEMA);
    this.migrate();
    // F7: the settlement database holds payment digests and settlement
    // state. SQLite creates the files world-readable (0644) by default, so tighten
    // them on every open: the -shm file is recreated on each open, so a one-time
    // chmod is not enough. Default 0600 (single-UID deployment). A deployment that
    // shares this file across two UIDs — facilitator writes, Owner reads —
    // must pass 0644 (world-readable, owner-writable): the Owner reads
    // payment state and the WAL -shm through the world-read bit, and the
    // Owner launcher refuses startup if the file is writable by the Owner
    // UID, so the mode must never grant group or world write. 0660 with a
    // shared group does NOT work for that reason (group-write + Owner in
    // the group trips the launcher guard).
    // Best-effort: a chmod failure must not break startup; the containing
    // directory (0700) is the access boundary.
    const mode = opts.fileMode ?? 0o600;
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${path}${suffix}`;
      try {
        if (existsSync(p)) chmodSync(p, mode);
      } catch { /* best-effort */ }
    }
  }

  /**
   * Add the rejection-confirmation counter to `payments` for databases
   * created before it. Existing rows default to 0, which is the correct
   * semantics: no rejection evidence yet.
   *
   * the old sign_events column additions are gone — Owner
   * authorization columns live in the Owner-private database now
   * (ownerAuthorizationRepository.ts), and this file never touches them.
   */
  private migrate(): void {
    // The rejection confirmation counter must exist on databases created before it.
    // Existing rows default to 0, which is the correct semantics: no rejection evidence yet.
    const paymentCols = this.db.prepare('PRAGMA table_info(payments)').all() as Array<{ name: string }>;
    const paymentExisting = new Set(paymentCols.map((c) => c.name));
    if (!paymentExisting.has('rejection_observation_count')) {
      this.db.exec('ALTER TABLE payments ADD COLUMN rejection_observation_count INTEGER NOT NULL DEFAULT 0');
    }
  }

  // ─── verification note ───────────────────────────────────────────────

  noteVerified(paymentDigest: string, requirementsKey: string): { ok: true } | { ok: false; reason: string } {
    const t = this.now();
    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT requirements_key, state FROM payments WHERE payment_digest = ?')
        .get(paymentDigest) as { requirements_key: string; state: SettlementState } | undefined;

      if (!existing) {
        this.db
          .prepare(
            'INSERT INTO payments (payment_digest, requirements_key, state, tx_hash, created_at, updated_at, attempted) VALUES (?,?,?,?,?,?,0)',
          )
          .run(paymentDigest, requirementsKey, 'created', null, t, t);
        this.log(paymentDigest, null, 'created', 'verified', null, null, t);
        return { ok: true as const };
      }

      // A payment already claimed for one authorisation may not be re-presented for another.
      const priorClaim = this.db
        .prepare('SELECT requirements_key FROM payment_claims WHERE payment_digest = ?')
        .get(paymentDigest) as { requirements_key: string } | undefined;
      const recorded = priorClaim?.requirements_key ?? existing.requirements_key;
      if (recorded !== requirementsKey) {
        return { ok: false as const, reason: `payment already used for a different authorisation (${recorded})` };
      }
      return { ok: true as const };
    });
  }

  // ─── atomic claim ────────────────────────────────────────────────────

  claim(paymentDigest: string, requirementsKey: string): ClaimResult {
    const t = this.now();
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT payment_digest, requirements_key, state, tx_hash, attempted FROM payments WHERE payment_digest = ?')
        .get(paymentDigest) as
        | { payment_digest: string; requirements_key: string; state: SettlementState; tx_hash: string | null; attempted: number }
        | undefined;

      if (!row) {
        // First sight: create and claim in the same transaction. The state stays `created`
        // until `prepare()` durably records the transaction hash — a payment is never
        // broadcast-eligible without one.
        this.db
          .prepare(
            'INSERT INTO payments (payment_digest, requirements_key, state, tx_hash, created_at, updated_at, attempted) VALUES (?,?,?,?,?,?,1)',
          )
          .run(paymentDigest, requirementsKey, 'created', null, t, t);
        this.log(paymentDigest, null, 'created', 'claimed for settlement', null, null, t);
        this.db
          .prepare('INSERT INTO payment_claims (payment_digest, requirements_key, claimed_at) VALUES (?,?,?)')
          .run(paymentDigest, requirementsKey, t);
        return { ok: true as const, claim: 'fresh' as const };
      }

      if (row.requirements_key !== requirementsKey) {
        return { ok: false as const, reason: 'different_authorisation' as const, recorded: row.requirements_key };
      }
      if (row.state === 'finalized') {
        const settlement = this.db
          .prepare('SELECT tx_hash FROM settlements WHERE payment_digest = ?')
          .get(paymentDigest) as { tx_hash: string } | undefined;
        const tx = settlement?.tx_hash ?? row.tx_hash ?? '';
        return { ok: true as const, claim: 'idempotent' as const, transaction: tx };
      }
      if (row.state === 'rejected') {
        return { ok: false as const, reason: 'terminal' as const, state: 'rejected' as const };
      }
      if (row.state === 'prepared') {
        // Hash is durable but the broadcast claim was never taken (the previous process died
        // between prepare() and claimSubmit()). This IS resumable: the hash is already
        // durable, so a new process may take the claim and submit. The claim itself is still
        // atomic, so two recovering processes cannot both submit.
        return row.tx_hash
          ? { ok: true as const, claim: 'resumable' as const, transaction: row.tx_hash }
          : { ok: false as const, reason: 'in_progress' as const };
      }
      if (row.state === 'submitting' || row.state === 'outcome_unknown' || row.state === 'observed' || row.state === 'recovery_unavailable') {
        return row.tx_hash
          ? { ok: false as const, reason: 'pending' as const, transaction: row.tx_hash }
          : { ok: false as const, reason: 'in_progress' as const };
      }

      // state === 'created': verified but never attempted. This IS the first settlement
      // attempt. The state stays `created` until `prepare()` durably records the hash.
      if (row.attempted === 0) {
        this.db
          .prepare('UPDATE payments SET attempted = 1, updated_at = ? WHERE payment_digest = ?')
          .run(t, paymentDigest);
        this.db
          .prepare('INSERT OR IGNORE INTO payment_claims (payment_digest, requirements_key, claimed_at) VALUES (?,?,?)')
          .run(paymentDigest, requirementsKey, t);
        this.log(paymentDigest, 'created', 'created', 'claimed for settlement (awaiting hash)', null, null, t);
        return { ok: true as const, claim: 'fresh' as const };
      }
      // attempted but still 'created' should be unreachable; fail closed.
      return { ok: false as const, reason: 'in_progress' as const };
    });
  }

  // ─── state changes ───────────────────────────────────────────────────

  markPending(paymentDigest: string, transaction: string, reason: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      // A terminal row is never reopened or rewritten: the hash is the recovery authority.
      if (isTerminal(row.state)) return;
      // The persisted hash is the recovery authority. A pending record must name the
      // SAME hash already recorded for this payment. Silently overwriting it would
      // desynchronize `payments.tx_hash` from `settlements.tx_hash` and let recovery poll
      // the wrong hash (confirmed: `markPending(A→B)` left `payments.tx_hash=B` while
      // `reconcile(A)` still succeeded against the stale `settlements` row).
      if (row.tx_hash !== null && row.tx_hash !== transaction) {
        throw new Error(`markPending: hash mismatch recorded=${row.tx_hash} given=${transaction}`);
      }
      // Record the hash even if the state does not change: the hash is how it gets reconciled.
      this.db
        .prepare('UPDATE payments SET tx_hash = ?, updated_at = ?, attempted = 1 WHERE payment_digest = ?')
        .run(transaction, t, paymentDigest);
      this.db
        .prepare('INSERT OR IGNORE INTO settlements (payment_digest, tx_hash, created_at) VALUES (?,?,?)')
        .run(paymentDigest, transaction, t);
      if (row.state === 'created' && canTransition('created', 'outcome_unknown')) {
        this.db
          .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
          .run('outcome_unknown', t, paymentDigest);
        this.log(paymentDigest, 'created', 'outcome_unknown', reason, transaction, null, t);
      } else if (row.state === 'submitting') {
        // `prepared` is deliberately NOT advanced here: the hash is durable but the
        // broadcast was never claimed, so the payment is still resumable, not ambiguous.
        this.db
          .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
          .run('outcome_unknown', t, paymentDigest);
        this.log(paymentDigest, row.state, 'outcome_unknown', reason, transaction, null, t);
      } else if (canTransition(row.state, row.state)) {
        this.log(paymentDigest, row.state, row.state, reason, transaction, null, t);
      }
    });
  }

  // ─── Pre-broadcast persistence ──────────────────────────────

  /**
   * Persist the final transaction hash before any broadcast. `created → prepared`.
   *
   * This is the only method that makes a hash durable. The hash is written with
   * `synchronous=FULL` inside `BEGIN IMMEDIATE`, so it survives a process kill that
   * happens after this returns. No signature material is ever written.
   */
  prepare(paymentDigest: string, transaction: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) throw new Error(`prepare: unknown payment ${paymentDigest}`);
      if (row.tx_hash !== null && row.tx_hash !== transaction) {
        throw new Error(`prepare: refusing to overwrite recorded transaction ${row.tx_hash} with ${transaction}`);
      }
      if (!canTransition(row.state, 'prepared')) {
        throw new Error(`prepare: illegal transition ${row.state} → prepared`);
      }
      this.db
        .prepare('UPDATE payments SET tx_hash = ?, state = ?, attempted = 1, updated_at = ? WHERE payment_digest = ?')
        .run(transaction, 'prepared', t, paymentDigest);
      this.db
        .prepare('INSERT OR IGNORE INTO settlements (payment_digest, tx_hash, created_at) VALUES (?,?,?)')
        .run(paymentDigest, transaction, t);
      this.log(paymentDigest, row.state, 'prepared', 'transaction hash persisted pre-broadcast', transaction, null, t);
    });
  }

  /**
   * Take the broadcast claim. `prepared → submitting`.
   *
   * Refuses unless the payment is `prepared` and the hash matches the one persisted by
   * `prepare()`. This is what guarantees "no submission before a durable hash".
   */
  claimSubmit(paymentDigest: string, transaction: string): { ok: true } | { ok: false; reason: string } {
    const t = this.now();
    return this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return { ok: false as const, reason: 'unknown payment' };
      if (row.tx_hash !== transaction) {
        return { ok: false as const, reason: `hash mismatch: recorded=${row.tx_hash} requested=${transaction}` };
      }
      if (row.state !== 'prepared') {
        return { ok: false as const, reason: `not prepared (state=${row.state})` };
      }
      if (!canTransition(row.state, 'submitting')) {
        return { ok: false as const, reason: `illegal transition ${row.state} → submitting` };
      }
      this.db
        .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
        .run('submitting', t, paymentDigest);
      this.log(paymentDigest, row.state, 'submitting', 'broadcast claim taken', transaction, null, t);
      return { ok: true as const };
    });
  }

  /** `submitting → outcome_unknown`. The broadcast has been attempted. */
  markBroadcast(paymentDigest: string, transaction: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      if (row.tx_hash !== transaction) {
        throw new Error(`markBroadcast: hash mismatch recorded=${row.tx_hash} given=${transaction}`);
      }
      if (!canTransition(row.state, 'outcome_unknown')) {
        // Idempotent: already ambiguous (e.g. a concurrent recovery got here first).
        if (row.state === 'outcome_unknown') return;
        throw new Error(`markBroadcast: illegal transition ${row.state} → outcome_unknown`);
      }
      this.db
        .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
        .run('outcome_unknown', t, paymentDigest);
      this.log(paymentDigest, row.state, 'outcome_unknown', 'broadcast attempted; outcome not yet established', transaction, null, t);
    });
  }

  /** `outcome_unknown → observed`. The node has the tx but it is not final. */
  markObserved(paymentDigest: string, transaction: string, reason: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      if (row.tx_hash !== transaction) {
        throw new Error(`markObserved: hash mismatch recorded=${row.tx_hash} given=${transaction}`);
      }
      if (!canTransition(row.state, 'observed')) return;
      this.db
        .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
        .run('observed', t, paymentDigest);
      this.log(paymentDigest, row.state, 'observed', reason, transaction, null, t);
    });
  }

  /** Record that recovery could not obtain evidence. Non-terminal. */
  markRecoveryUnavailable(paymentDigest: string, transaction: string, reason: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      if (row.tx_hash !== transaction) {
        throw new Error(`markRecoveryUnavailable: hash mismatch recorded=${row.tx_hash} given=${transaction}`);
      }
      if (!canTransition(row.state, 'recovery_unavailable')) return;
      this.db
        .prepare('UPDATE payments SET state = ?, updated_at = ? WHERE payment_digest = ?')
        .run('recovery_unavailable', t, paymentDigest);
      this.log(paymentDigest, row.state, 'recovery_unavailable', reason, transaction, null, t);
    });
  }

  /**
   * Record the broadcast hash without changing state.
   *
   * Needed because evidence can only be applied to a *recorded* hash: a payment that was
   * broadcast and confirmed in one go must still have its hash committed before the evidence
   * is applied, or reconciliation has nothing to bind to.
   */
  recordTransaction(paymentDigest: string, transaction: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      if (row.tx_hash !== null && row.tx_hash !== transaction) {
        throw new Error(`refusing to overwrite recorded transaction ${row.tx_hash} with ${transaction}`);
      }
      this.db
        .prepare('UPDATE payments SET tx_hash = ?, updated_at = ?, attempted = 1 WHERE payment_digest = ?')
        .run(transaction, t, paymentDigest);
      this.db
        .prepare('INSERT OR IGNORE INTO settlements (payment_digest, tx_hash, created_at) VALUES (?,?,?)')
        .run(paymentDigest, transaction, t);
    });
  }

  markFailed(paymentDigest: string, reason: string, transaction?: string): void {
    const t = this.now();
    this.tx(() => {
      const row = this.read(paymentDigest);
      if (!row) return;
      if (isTerminal(row.state)) return; // terminal stays terminal
      // Once a broadcast may have happened, only `reconcile()` may set the terminal
      // state. A late failure from a stale path (e.g. a duplicate request that re-ran the
      // pre-broadcast checks while recovery was polling) must not reject a payment that the
      // chain may still finalize. `prepared` is exempt: the broadcast claim was never taken,
      // so nothing can be in flight (confirmed gap: `markFailed` turned `outcome_unknown`
      // into `rejected`, and the later `reconcile(finalized)` was then refused forever).
      if (row.tx_hash !== null && BROADCAST_CAPABLE.includes(row.state)) return;
      // The recorded hash is the recovery authority; a failure record may never rename it.
      if (row.tx_hash !== null && transaction !== undefined && transaction !== row.tx_hash) return;
      if (!canTransition(row.state, 'rejected')) return;
      this.db
        .prepare('UPDATE payments SET state = ?, tx_hash = ?, updated_at = ? WHERE payment_digest = ?')
        .run('rejected', transaction ?? row.tx_hash ?? null, t, paymentDigest);
      this.log(paymentDigest, row.state, 'rejected', reason, transaction ?? null, null, t);
    });
  }

  /**
   * Apply reconciliation evidence.
   *
   * The caller supplies an *observation*, not a decision — and this method does not trust it
   * as finality. It only enforces the state machine and binds the evidence to the recorded
   * hash. Authentication and evidence verification happen before this is called (see
   * `reconcile.ts`); this layer keeps the invariants.
   */
  reconcile(input: ReconcileInput): ReconcileResult {
    const t = this.now();
    return this.tx(() => {
      const row = this.read(input.paymentDigest);
      if (!row) return { ok: false as const, reason: 'unknown payment' };

      const recorded = this.db
        .prepare('SELECT tx_hash FROM settlements WHERE payment_digest = ?')
        .get(input.paymentDigest) as { tx_hash: string } | undefined;

      // Evidence must name the exact hash we recorded. Nothing else can advance the payment.
      if (!recorded?.tx_hash) {
        return { ok: false as const, reason: 'no recorded transaction for this payment' };
      }
      if (recorded.tx_hash !== input.transaction) {
        return {
          ok: false as const,
          reason: `hash mismatch: recorded=${recorded.tx_hash} observed=${input.transaction}`,
        };
      }

      if (isTerminal(row.state)) {
        // Duplicate finalization is idempotent for `finalized`, refused for `failed`.
        if (row.state === 'finalized') return { ok: true as const, changed: false, state: row.state, reason: 'already finalized' };
        return { ok: false as const, reason: `payment is terminally ${row.state}; evidence cannot reopen it` };
      }

      const decision = interpretObservation(input.observed);

      // Bounded confirmation gate for terminal rejection. A single rejection
      // observation must not terminalize the payment. The counter must reach
      // REJECTION_CONFIRMATIONS_REQUIRED (2) consistent observations before `rejected`
      // is applied. Success is never gated; pending/unknown/transport-error stay
      // non-terminal and reset the counter.
      const currentCount = row.rejection_observation_count ?? 0;

      if (decision.advance === 'stay') {
        // Reset the rejection counter on any non-rejection observation.
        if (currentCount > 0) {
          this.db
            .prepare('UPDATE payments SET rejection_observation_count = 0, updated_at = ? WHERE payment_digest = ?')
            .run(t, input.paymentDigest);
        }
        // committed / pending / unknown: record the observation, change nothing.
        this.log(
          input.paymentDigest,
          row.state,
          row.state,
          `observed ${input.observed} — retained pending`,
          input.transaction,
          JSON.stringify({ source: input.evidenceSource, digest: input.evidenceDigest }),
          t,
        );
        return { ok: true as const, changed: false, state: row.state, reason: `observed ${input.observed}; retained pending` };
      }

      if (decision.advance === 'rejected') {
        // First rejection observation: record, do not terminalize. The counter must reach
        // REJECTION_CONFIRMATIONS_REQUIRED before the state can advance to `rejected`.
        if (currentCount + 1 < REJECTION_CONFIRMATIONS_REQUIRED) {
          this.db
            .prepare('UPDATE payments SET rejection_observation_count = ?, updated_at = ? WHERE payment_digest = ?')
            .run(currentCount + 1, t, input.paymentDigest);
          this.log(
            input.paymentDigest,
            row.state,
            row.state,
            `rejection observed once (${currentCount + 1}/${REJECTION_CONFIRMATIONS_REQUIRED}); awaiting confirmation`,
            input.transaction,
            JSON.stringify({ source: input.evidenceSource, digest: input.evidenceDigest }),
            t,
          );
          return {
            ok: true as const,
            changed: false,
            state: row.state,
            reason: `rejection observed once (${currentCount + 1}/${REJECTION_CONFIRMATIONS_REQUIRED}); awaiting confirmation`,
          };
        }
        // Confirmed rejection: clear the counter and advance to terminal `rejected`.
        // (Fall through to the terminal-advance block below with target='rejected'.)
      }

      const target: SettlementState = decision.advance === 'finalized' ? 'finalized' : 'rejected';
      if (!canTransition(row.state, target)) {
        return { ok: false as const, reason: new IllegalTransitionError(row.state, target).message };
      }

      // Clear the rejection counter on any terminal advance.
      this.db
        .prepare('UPDATE payments SET state = ?, rejection_observation_count = 0, updated_at = ? WHERE payment_digest = ?')
        .run(target, t, input.paymentDigest);
      this.log(
        input.paymentDigest,
        row.state,
        target,
        `verified ${input.observed}`,
        input.transaction,
        JSON.stringify({ source: input.evidenceSource, digest: input.evidenceDigest }),
        t,
      );
      return { ok: true as const, changed: true, state: target, reason: `verified ${input.observed}` };
    });
  }

  // ─── reads ───────────────────────────────────────────────────────────

  get(paymentDigest: string): PaymentRow | undefined {
    return this.read(paymentDigest);
  }

  getByTransaction(txHash: string): PaymentRow | undefined {
    return this.db
      .prepare(
        'SELECT payment_digest, requirements_key, state, tx_hash, created_at, updated_at, attempted, rejection_observation_count FROM payments WHERE tx_hash = ? LIMIT 1',
      )
      .get(txHash) as unknown as PaymentRow | undefined;
  }

  transitions(paymentDigest: string): TransitionRow[] {
    return this.db
      .prepare(
        'SELECT id, payment_digest, from_state, to_state, reason, tx_hash, evidence, at FROM transitions WHERE payment_digest = ? ORDER BY id',
      )
      .all(paymentDigest) as unknown as TransitionRow[];
  }

  listRecoverable(): PaymentRow[] {
    return this.db
      .prepare(
        "SELECT payment_digest, requirements_key, state, tx_hash, created_at, updated_at, attempted FROM payments WHERE state IN ('submitting','outcome_unknown','observed','recovery_unavailable') AND tx_hash IS NOT NULL ORDER BY updated_at",
      )
      .all() as unknown as PaymentRow[];
  }
  listOutcomeUnknown(): PaymentRow[] {
    return this.listRecoverable();
  }
  recoverablePayments(): PaymentRow[] {
    return this.listRecoverable();
  }
  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE state = 'outcome_unknown'").get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ─── internals ───────────────────────────────────────────────────────

  private read(paymentDigest: string): PaymentRow | undefined {
    return this.db
      .prepare(
        'SELECT payment_digest, requirements_key, state, tx_hash, created_at, updated_at, attempted, rejection_observation_count FROM payments WHERE payment_digest = ?',
      )
      .get(paymentDigest) as unknown as PaymentRow | undefined;
  }

  private log(
    paymentDigest: string,
    from: SettlementState | null,
    to: SettlementState,
    reason: string,
    transaction: string | null,
    evidence: string | null,
    at: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO transitions (payment_digest, from_state, to_state, reason, tx_hash, evidence, at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(paymentDigest, from, to, reason, transaction, evidence, at);
  }

  /** Run `fn` inside a single write transaction. Rolls back on any throw. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback of an already-aborted tx is not actionable */
      }
      throw e;
    }
  }
}

/** Evidence digest helper, so the audit log records a tamper-evident pointer.
 * Canonical serialization (see `canonicalJson.ts`): the digest is a function
 * of the evidence's CONTENT alone — same logical evidence, same digest —
 * including live SDK responses that carry BigInt and rich types (BlockHash,
 * AccountAddress, CcdAmount), which plain `JSON.stringify` cannot hash at
 * all. Historical digests are untouched (they are stored audit pointers,
 * never recomputed); only future rows use this scheme. */
export function evidenceDigestOf(evidence: unknown): string {
  return createHash('sha256').update(canonicalStringify(evidence)).digest('hex');
}
