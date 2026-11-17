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
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
  /** Task 11. Null on legacy rows and on rejections. */
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
 * Kept in a separate table because `sign_events` has a foreign key to `payments`; inserting
 * an event for a missing payment would either violate that constraint or require inventing a
 * fake payment row. Referential integrity is preserved by not having the FK here — the
 * digest is still recorded verbatim, and the absence of a matching `payments` row is itself
 * the recorded fact.
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
   * Task 11 — the exact transaction the approval covers. An approval recorded
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
  /**
   * Read authorization attempts that could not be matched to a payment row.
   * Newest first. These events are kept in a separate table (no FK) so that referential
   * integrity on `sign_events` is never weakened.
   */
  signAttempts(paymentDigest: string): SignAttemptRow[];
  /**
   * Read the sign events for a payment (newest first).
   */
  signEvents(paymentDigest: string): SignEventRow[];
  /**
   * Atomically verify payment state + persist the authorization audit event.
   * Returns ok:false with a stable reason if the payment is not authorizable. Never throws
   * for a state-based rejection; throws only on unexpected DB errors.
   *
   * Task 11: on approval the result carries the authorization id the record
   * was issued with (generated here when the caller supplies none).
   */
  authorizeSignEvent(input: SignEventInput & { decision: 'approved' | 'rejected' }): AuthorizeSignResult;
  /**
   * Atomically consume an authorization (Task 11). Marks the approval
   * consumed in one BEGIN IMMEDIATE transaction after re-verifying every
   * bound field against the durable record, the expiry against the clock,
   * and the payment row still being `created` with NULL tx_hash. A second
   * consume of the same authorization is refused. Never throws for a
   * state-based refusal; throws only on unexpected DB errors.
   */
  consumeAuthorization(input: ConsumeAuthorizationInput): ConsumeAuthorizationResult;
  /** Revoke an unconsumed authorization (Task 11). Idempotent. */
  revokeAuthorization(authorizationId: string): RevokeAuthorizationResult;
  /** Read one approval by authorization id (Task 11). */
  authorizationById(authorizationId: string): SignEventRow | undefined;
  get(paymentDigest: string): PaymentRow | undefined;
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

CREATE TABLE IF NOT EXISTS sign_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_digest   TEXT NOT NULL,
  decided_at       INTEGER NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason           TEXT,
  network          TEXT NOT NULL,
  sender           TEXT NOT NULL,
  sponsor          TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  energy           TEXT NOT NULL,
  policy_version   TEXT NOT NULL,
  -- full payment context bound into the durable authorization record so recovery
  -- can prove the context matches. NULL = legacy row with incomplete evidence (fail closed).
  asset            TEXT,
  amount           TEXT,
  expiry           INTEGER,
  -- Task 11 — Owner authorization binding. An approval is issued with a unique
  -- authorization id and the exact transaction it covers; the signing service
  -- consumes it exactly once (consumed_at) and the Owner may revoke it
  -- (revoked_at) before consumption. NULL = legacy row / rejection (fail closed).
  authorization_id   TEXT UNIQUE,
  transaction_digest TEXT,
  transaction_type   TEXT,
  max_energy         TEXT,
  max_fee_microccd   TEXT,
  consumed_at        INTEGER,
  revoked_at         INTEGER,
  FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)
);
CREATE INDEX IF NOT EXISTS idx_sign_events_payment ON sign_events(payment_digest, id);
-- database-level exactly-once guard for LIVE approvals. Only one UNCONSUMED
-- 'approved' sign event per payment: a consumed approval no longer blocks a
-- fresh authorization (a retry after a consume-then-crash needs a new
-- approval), but two live approvals for one payment can never exist.
-- Rejected attempts are still recorded, so this is a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sign_events_approved
  ON sign_events(payment_digest) WHERE decision = 'approved' AND consumed_at IS NULL;

-- authorization attempts whose payment row does not exist.
-- No foreign key on purpose: a missing payment must be auditable without inventing a
-- payments row. Only rejections can be recorded here — there is no column or code path
-- that can produce an approval in this table.
CREATE TABLE IF NOT EXISTS sign_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_digest   TEXT NOT NULL,
  decided_at       INTEGER NOT NULL,
  decision         TEXT NOT NULL CHECK (decision = 'rejected'),
  reason           TEXT NOT NULL,
  network          TEXT NOT NULL,
  sender           TEXT NOT NULL,
  sponsor          TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  energy           TEXT NOT NULL,
  policy_version   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sign_attempts_payment ON sign_attempts(payment_digest, id);

-- (M1): runtime enforcement, not TypeScript visibility.
-- An approved event may only exist for a payment that is still 'created' with no durable
-- transaction hash. This holds for EVERY writer, including a raw SQL insert that bypasses
-- the repository entirely, and it is enforced by the database across processes.
CREATE TRIGGER IF NOT EXISTS trg_sign_events_approved_requires_created
BEFORE INSERT ON sign_events
WHEN NEW.decision = 'approved'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM payments p
      WHERE p.payment_digest = NEW.payment_digest
        AND p.state = 'created'
        AND p.tx_hash IS NULL
    )
    THEN RAISE(ABORT, 'approved sign event requires a created payment with NULL tx_hash')
  END;
END;

`;

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
    // F7: the settlement database holds payment digests, sign events and settlement
    // state. SQLite creates the files world-readable (0644) by default, so tighten
    // them on every open: the -shm file is recreated on each open, so a one-time
    // chmod is not enough. Default 0600 (single-UID deployment). A deployment that
    // shares this file across two UIDs must pass 0660 with a shared group instead.
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
   * Add the payment-context columns to `sign_events` for databases created
   * before the binding existed. Existing rows keep NULL in the new columns, which recovery
   * treats as "cannot verify" and fails closed. No data is invented.
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(sign_events)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((c) => c.name));
    const additions: Array<[string, string]> = [
      ['asset', 'TEXT'],
      ['amount', 'TEXT'],
      ['expiry', 'INTEGER'],
      // Task 11 — Owner authorization binding columns (see SCHEMA).
      ['authorization_id', 'TEXT'],
      ['transaction_digest', 'TEXT'],
      ['transaction_type', 'TEXT'],
      ['max_energy', 'TEXT'],
      ['max_fee_microccd', 'TEXT'],
      ['consumed_at', 'INTEGER'],
      ['revoked_at', 'INTEGER'],
    ];
    let addedBindingColumn = false;
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE sign_events ADD COLUMN ${name} ${type}`);
        if (name !== 'asset' && name !== 'amount' && name !== 'expiry') addedBindingColumn = true;
      }
    }
    if (addedBindingColumn) {
      // A legacy database has the old "one approval ever" index. The Task 11
      // invariant is "one LIVE approval": drop the old index and recreate it
      // with the consumed_at predicate (fresh databases already have it from
      // SCHEMA, so this only runs when a binding column was just added).
      this.db.exec('DROP INDEX IF EXISTS ux_sign_events_approved');
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_sign_events_approved ON sign_events(payment_digest) WHERE decision = 'approved' AND consumed_at IS NULL",
      );
    }
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

  /**
   * Audit rows for authorization attempts with no matching payment row.
   * Newest first.
   */
  signAttempts(paymentDigest: string): SignAttemptRow[] {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version FROM sign_attempts WHERE payment_digest = ? ORDER BY id DESC',
      )
      .all(paymentDigest) as unknown as SignAttemptRow[];
  }

  signEvents(paymentDigest: string): SignEventRow[] {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM sign_events WHERE payment_digest = ? ORDER BY id DESC',
      )
      .all(paymentDigest) as unknown as SignEventRow[];
  }

  /**
   * Atomic authorization gate.
   *
   * Everything happens inside ONE `BEGIN IMMEDIATE` transaction:
   *   1. read the durable payment row
   *   2. require state === 'created'
   *   3. require tx_hash IS NULL
   *   4. require the digest matches (it is the PK, so this is implicit — asserted anyway)
   *   5. require no prior LIVE successful authorization (Task 11: a CONSUMED
   *      approval no longer blocks a fresh authorization — a retry after a
   *      consume-then-crash needs a new approval. Two live approvals for one
   *      payment can never exist: the partial unique index enforces it.)
   *   6. append the audit event (with a fresh authorization id on approval)
   *
   * A concurrent `prepare()`/`claim()` from another process must wait for this write
   * transaction, so it cannot slip between the check and the commit.
   *
   * A rejected decision is still audited (so operators can see refusals) but never counts as
   * a successful authorization.
   */
  authorizeSignEvent(input: SignEventInput & { decision: 'approved' | 'rejected' }): AuthorizeSignResult {
    const t = this.now();
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT payment_digest, state, tx_hash FROM payments WHERE payment_digest = ?')
        .get(input.paymentDigest) as
        | { payment_digest: string; state: SettlementState; tx_hash: string | null }
        | undefined;

      // A missing payment cannot be audited in `sign_events` (FK to payments),
      // so it is recorded in `sign_attempts` — no payment row is invented, and referential
      // integrity on `sign_events` is untouched.
      if (!row) {
        this.insertSignAttempt(input, t, 'unknown_payment');
        return { ok: false as const, reason: 'unknown_payment' as const };
      }

      // Every state-based rejection is audited inside this same transaction.
      if (row.payment_digest !== input.paymentDigest) {
        this.insertRejectedSignEvent(input, t, 'payment_digest_mismatch');
        return { ok: false as const, reason: 'payment_digest_mismatch' as const };
      }
      if (row.tx_hash !== null) {
        this.insertRejectedSignEvent(input, t, 'transaction_hash_already_prepared');
        return { ok: false as const, reason: 'transaction_hash_already_prepared' as const };
      }
      if (row.state !== 'created') {
        this.insertRejectedSignEvent(input, t, 'payment_not_authorizable');
        return { ok: false as const, reason: 'payment_not_authorizable' as const };
      }

      const prior = this.db
        .prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest = ? AND decision = 'approved' AND consumed_at IS NULL")
        .get(input.paymentDigest) as { n: number };
      if (Number(prior.n) > 0) {
        this.insertRejectedSignEvent(input, t, 'authorization_already_recorded');
        return { ok: false as const, reason: 'authorization_already_recorded' as const };
      }

      const authorizationId =
        input.decision === 'approved' ? (input.authorizationId ?? randomUUID()) : null;
      this.insertSignEvent(input, t, authorizationId);

      return { ok: true as const, authorizationId };
    });
  }

  /**
   * Atomic authorization consumption (Task 11).
   *
   * One `BEGIN IMMEDIATE` transaction: load the approval by authorization id,
   * re-verify every bound field against the durable record, the expiry
   * against the clock, and the payment row still being `created` with NULL
   * tx_hash — then mark it consumed. The conditional UPDATE is
   * defense-in-depth against a concurrent consume slipping past the SELECT:
   * exactly one caller can flip an unconsumed row.
   */
  consumeAuthorization(input: ConsumeAuthorizationInput): ConsumeAuthorizationResult {
    const t = this.now();
    const nowSec = Math.floor(t / 1000);
    return this.tx(() => {
      const ev = this.db
        .prepare(
          'SELECT id, payment_digest, decision, network, sender, sponsor, recipient, energy, asset, amount, expiry, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM sign_events WHERE authorization_id = ?',
        )
        .get(input.authorizationId) as
        | {
            id: number;
            payment_digest: string;
            decision: string;
            network: string;
            sender: string;
            sponsor: string;
            recipient: string;
            energy: string;
            asset: string | null;
            amount: string | null;
            expiry: number | null;
            transaction_digest: string | null;
            transaction_type: string | null;
            max_energy: string | null;
            max_fee_microccd: string | null;
            consumed_at: number | null;
            revoked_at: number | null;
          }
        | undefined;
      if (!ev || ev.decision !== 'approved') {
        return { ok: false as const, reason: 'unknown_authorization' as const };
      }
      if (ev.consumed_at !== null) {
        return { ok: false as const, reason: 'authorization_already_consumed' as const };
      }
      if (ev.revoked_at !== null) {
        return { ok: false as const, reason: 'authorization_revoked' as const };
      }
      // Expiry is checked against the clock here, not just at issuance: an
      // approval that expired while its certificate was in flight cannot be used.
      if (ev.expiry === null || ev.expiry <= nowSec) {
        return { ok: false as const, reason: 'authorization_expired' as const };
      }
      // Every bound field must match the durable record exactly. A NULL in the
      // record means the approval predates the binding — fail closed.
      const mismatched =
        ev.payment_digest !== input.paymentDigest ||
        ev.transaction_digest !== input.transactionDigest ||
        ev.transaction_type !== input.transactionType ||
        ev.network !== input.network ||
        ev.sender !== input.sender ||
        ev.sponsor !== input.sponsor ||
        ev.recipient !== input.recipient ||
        ev.asset !== input.asset ||
        ev.amount !== input.amount ||
        ev.expiry !== input.expiry ||
        ev.energy !== input.energy ||
        ev.max_energy !== input.maxEnergy ||
        ev.max_fee_microccd !== input.maxFeeMicroCcd;
      if (mismatched) {
        return { ok: false as const, reason: 'authorization_mismatch' as const };
      }
      const payment = this.db
        .prepare('SELECT state, tx_hash FROM payments WHERE payment_digest = ?')
        .get(ev.payment_digest) as { state: SettlementState; tx_hash: string | null } | undefined;
      if (!payment) {
        return { ok: false as const, reason: 'unknown_authorization' as const };
      }
      if (payment.tx_hash !== null) {
        return { ok: false as const, reason: 'transaction_hash_already_prepared' as const };
      }
      if (payment.state !== 'created') {
        return { ok: false as const, reason: 'payment_not_authorizable' as const };
      }
      const changed = this.db
        .prepare('UPDATE sign_events SET consumed_at = ? WHERE authorization_id = ? AND consumed_at IS NULL')
        .run(t, input.authorizationId).changes;
      if (changed !== 1) {
        return { ok: false as const, reason: 'authorization_already_consumed' as const };
      }
      return { ok: true as const };
    });
  }

  /**
   * Revoke an unconsumed authorization (Task 11). Idempotent: revoking an
   * already-revoked authorization succeeds. A consumed authorization cannot
   * be revoked — it is already spent.
   */
  revokeAuthorization(authorizationId: string): RevokeAuthorizationResult {
    const t = this.now();
    return this.tx(() => {
      const ev = this.db
        .prepare('SELECT decision, consumed_at, revoked_at FROM sign_events WHERE authorization_id = ?')
        .get(authorizationId) as
        | { decision: string; consumed_at: number | null; revoked_at: number | null }
        | undefined;
      if (!ev || ev.decision !== 'approved') {
        return { ok: false as const, reason: 'unknown_authorization' as const };
      }
      if (ev.consumed_at !== null) {
        return { ok: false as const, reason: 'authorization_already_consumed' as const };
      }
      if (ev.revoked_at !== null) return { ok: true as const };
      this.db.prepare('UPDATE sign_events SET revoked_at = ? WHERE authorization_id = ?').run(t, authorizationId);
      return { ok: true as const };
    });
  }

  authorizationById(authorizationId: string): SignEventRow | undefined {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM sign_events WHERE authorization_id = ?',
      )
      .get(authorizationId) as unknown as SignEventRow | undefined;
  }

  // ─── reads ───────────────────────────────────────────────────────────

  get(paymentDigest: string): PaymentRow | undefined {
    return this.read(paymentDigest);
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

  /**
   * Internal audit writer for the single authorized decision.
   *
   * Only called from inside `authorizeSignEvent()`, which has already passed the durable-state
   * gate. This method can never be reached from a public path, and its caller guarantees the
   * decision was produced by the gate.
   */
  private insertSignEvent(input: SignEventInput, at: number, authorizationId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.paymentDigest,
        at,
        input.decision,
        input.reason ?? null,
        input.network,
        input.sender,
        input.sponsor,
        input.recipient,
        input.energy,
        input.policyVersion,
        input.asset ?? null,
        input.amount ?? null,
        input.expiry ?? null,
        authorizationId,
        input.transactionDigest ?? null,
        input.transactionType ?? null,
        input.maxEnergy ?? null,
        input.maxFeeMicroCcd ?? null,
      );
  }

  /**
   * Internal writer for a state-based rejection.
   *
   * Hard-codes `decision = 'rejected'` and takes no decision parameter, so no caller can
   * produce an approval through this path. Must be called inside the same transaction as the
   * state check that produced the reason.
   */
  private insertRejectedSignEvent(input: SignEventInput, at: number, reason: string): void {
    this.db
      .prepare(
        'INSERT INTO sign_events (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.paymentDigest,
        at,
        'rejected',
        reason,
        input.network,
        input.sender,
        input.sponsor,
        input.recipient,
        input.energy,
        input.policyVersion,
        input.asset ?? null,
        input.amount ?? null,
        input.expiry ?? null,
        null,
        input.transactionDigest ?? null,
        input.transactionType ?? null,
        input.maxEnergy ?? null,
        input.maxFeeMicroCcd ?? null,
      );
  }

  /**
   * Internal writer for an attempt whose payment row does not exist.
   *
   * Lives in `sign_attempts` (no FK) so a missing payment can be audited without inventing a
   * payment row. `decision` is constrained by the schema to 'rejected'.
   */
  private insertSignAttempt(input: SignEventInput, at: number, reason: string): void {
    this.db
      .prepare(
        'INSERT INTO sign_attempts (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        input.paymentDigest,
        at,
        'rejected',
        reason,
        input.network,
        input.sender,
        input.sponsor,
        input.recipient,
        input.energy,
        input.policyVersion,
      );
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

/** Evidence digest helper, so the audit log records a tamper-evident pointer. */
export function evidenceDigestOf(evidence: unknown): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
