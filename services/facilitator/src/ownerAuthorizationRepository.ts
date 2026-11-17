/**
 * Owner-private authorization storage .
 *
 * This is the fix for the shared-database weakness in the authorization binding (PR #8):
 * the Owner authorization process used `SqliteSettlementRepository` against
 * a database file the facilitator could also write. A compromised
 * facilitator could UPDATE `sign_events` directly — reset `consumed_at`,
 * clear `revoked_at`, or insert a fabricated approval — and the Owner's
 * durable state would be rewritten under it. The Ed25519 certificate
 * stopped FORGERY of approvals, but not TAMPERING with the durable
 * single-use / revocation state.
 *
 * Separation, enforced by the OS, not by application checks:
 *
 *   - The Owner authorization records (`authorizations`,
 *     `authorization_attempts`) live in a SEPARATE SQLite file in a
 *     directory owned by the dedicated Owner UID, mode 0700, with the
 *     database files mode 0600. The facilitator UID cannot traverse the
 *     directory, so it cannot open the database, its WAL, or its SHM —
 *     there is no path, socket, or SQL statement by which the facilitator
 *     can reach Owner authorization state.
 *   - The facilitator settlement records (`payments`, `settlements`,
 *     `transitions`) live in the facilitator's own database file
 *     (`SqliteSettlementRepository`), which the Owner NEVER opens
 *     read-write.
 *   - The Owner still needs ONE fact from settlement state — whether a
 *     payment is `created` with no persisted transaction hash — before
 *     it authorizes or consumes. That fact comes through the explicitly
 *     defined read-only interface `SettlementStateReader`. The
 *     production implementation (`ReadOnlySettlementStateReader`) opens
 *     the facilitator database with SQLite `readOnly: true`: any write
 *     attempt throws SQLITE_READONLY. The Owner holds no write handle
 *     to settlement state, and the facilitator holds no handle at all to
 *     Owner state.
 *
 * What the split does NOT do (known limitation): the read-only
 * payment-state check and the Owner's write are no longer one atomic
 * transaction — they span two databases, so a strict cross-database
 * commit. A payment could transition `created → prepared` in the
 * (small) window between the Owner's read and its write. The remaining
 * defenses are, in order: (a) `consumeAuthorization` re-checks
 * settlement state immediately before signing; (b) the facilitator's
 * own `prepare()` refuses a second hash for a payment (created →
 * prepared is a one-way transition); (c) on-chain reconciliation. A
 * facilitator that corrupts ITS OWN settlement database can mislead
 * the read-only check — that corrupts its own state, which it already
 * owned; it still cannot rewrite Owner authorization state, forge a
 * certificate, reset a consumption, or clear a revocation.
 *
 * Temp files: `PRAGMA temp_store = MEMORY` keeps SQLite from spilling
 * sort/join temporaries to disk, so no authorization data ever lands in
 * a world-readable temp file. WAL mode is kept (durability), and the
 * -wal/-shm files are chmodded 0600 on open like the database itself.
 *
 * No real signing, no key material, no broadcast in this module.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuthorizeSignResult,
  ConsumeAuthorizationInput,
  ConsumeAuthorizationResult,
  RevokeAuthorizationResult,
  SignAttemptRow,
  SignEventInput,
  SignEventRow,
} from './repository.js';

/** The one settlement fact the Owner needs: payment state + persisted hash. */
export interface SettlementState {
  state: string;
  txHash: string | null;
}

/**
 * Explicitly defined read-only interface to settlement state.
 *
 * The Owner consults this before authorizing and before consuming. It
 * never writes settlement state, and no implementation here opens the
 * settlement database read-write.
 */
export interface SettlementStateReader {
  /** Returns undefined when the payment has no settlement row (or the state is unreadable). */
  getPaymentState(paymentDigest: string): SettlementState | undefined;
}

/** In-process reader over a settlement repository (tests + mock-mode core default). */
export class RepositorySettlementStateReader implements SettlementStateReader {
  constructor(
    private readonly repo: {
      get(paymentDigest: string): { state: string; tx_hash: string | null } | undefined;
    },
  ) {}

  getPaymentState(paymentDigest: string): SettlementState | undefined {
    const row = this.repo.get(paymentDigest);
    return row === undefined ? undefined : { state: row.state, txHash: row.tx_hash };
  }
}

/**
 * Production reader: opens the facilitator settlement database read-only,
 * once per call, and closes it again. A missing file, an unreadable WAL /
 * SHM, or a missing `payments` table all read as "no settlement row"
 * (fail closed: the caller records `unknown_payment`). No handle is kept
 * open between calls, so a crashed or restarted facilitator cannot leave
 * the Owner holding a stale read connection.
 */
export class ReadOnlySettlementStateReader implements SettlementStateReader {
  constructor(private readonly settlementDbPath: string) {}

  getPaymentState(paymentDigest: string): SettlementState | undefined {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.settlementDbPath, { readOnly: true });
    } catch {
      return undefined;
    }
    try {
      const row = db
        .prepare('SELECT state, tx_hash FROM payments WHERE payment_digest = ?')
        .get(paymentDigest) as { state: string; tx_hash: string | null } | undefined;
      return row === undefined ? undefined : { state: row.state, txHash: row.tx_hash };
    } catch {
      return undefined;
    } finally {
      try {
        db.close();
      } catch {
        /* close of a read-only handle cannot fail the read */
      }
    }
  }

  /**
   * Legacy-state probe (startup gate). Reads the settlement database
   * read-only for authorization rows left over from the pre-11.1 shared
   * database: 'present' means the operator must run the migration script
   * first; 'absent' means no legacy authorization tables/rows; 'unreadable'
   * means the file exists but cannot be inspected — fail closed.
   */
  legacyAuthorizationState(): 'absent' | 'present' | 'unreadable' {
    if (!existsSync(this.settlementDbPath)) return 'absent';
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.settlementDbPath, { readOnly: true });
    } catch {
      return 'unreadable';
    }
    try {
      for (const table of ['sign_events', 'sign_attempts']) {
        let n: number;
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
          n = Number(row.n);
        } catch {
          // Table does not exist: no legacy state in it.
          continue;
        }
        if (n > 0) return 'present';
      }
      return 'absent';
    } catch {
      return 'unreadable';
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Owner-private authorization schema (exported for the explicit migration script). */
export const OWNER_AUTHORIZATION_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
-- No authorization data in on-disk temp files .
PRAGMA temp_store = MEMORY;

-- Owner-private authorization records. No foreign key to the facilitator's
-- payments table: the two databases are separate files owned by different
-- UIDs, and a cross-database FK cannot exist. The payment-state check is
-- enforced in code via the SettlementStateReader (see authorizeSignEvent /
-- consumeAuthorization), and the OS boundary — only the Owner UID can
-- write this file — replaces the old trigger's "even raw SQL" guarantee
-- for the facilitator: the facilitator cannot reach this file at all.
CREATE TABLE IF NOT EXISTS authorizations (
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
  -- Owner authorization binding. An approval is issued with a unique
  -- authorization id and the exact transaction it covers; the signing service
  -- consumes it exactly once (consumed_at) and the Owner may revoke it
  -- (revoked_at) before consumption. NULL = legacy row / rejection (fail closed).
  authorization_id   TEXT UNIQUE,
  transaction_digest TEXT,
  transaction_type   TEXT,
  max_energy         TEXT,
  max_fee_microccd   TEXT,
  consumed_at        INTEGER,
  revoked_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_authorizations_payment ON authorizations(payment_digest, id);
-- database-level exactly-once guard for LIVE approvals. Only one UNCONSUMED
-- 'approved' authorization per payment: a consumed approval no longer blocks a
-- fresh authorization (a retry after a consume-then-crash needs a new
-- approval), but two live approvals for one payment can never exist.
-- Rejected attempts are still recorded, so this is a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_authorizations_approved
  ON authorizations(payment_digest) WHERE decision = 'approved' AND consumed_at IS NULL;

-- authorization attempts whose payment row does not exist.
-- No foreign key on purpose: a missing payment must be auditable without inventing a
-- payments row. Only rejections can be recorded here — there is no column or code path
-- that can produce an approval in this table.
CREATE TABLE IF NOT EXISTS authorization_attempts (
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
CREATE INDEX IF NOT EXISTS idx_authorization_attempts_payment ON authorization_attempts(payment_digest, id);
`;

export interface OwnerAuthorizationRepository {
  /**
   * Atomically verify settlement state (read-only) + persist the
   * authorization audit event. Returns ok:false with a stable reason if
   * the payment is not authorizable. Never throws for a state-based
   * rejection; throws only on unexpected DB errors.
   *
   * On approval the result carries the authorization id the record was
   * issued with (generated here when the caller supplies none).
   */
  authorizeSignEvent(input: SignEventInput & { decision: 'approved' | 'rejected' }): AuthorizeSignResult;
  /**
   * Atomically consume an authorization . Marks the approval
   * consumed in one BEGIN IMMEDIATE transaction after re-verifying every
   * bound field against the durable record, the expiry against the clock,
   * and the settlement state (read-only) still being `created` with NULL
   * tx_hash. A second consume of the same authorization is refused. Never
   * throws for a state-based refusal; throws only on unexpected DB errors.
   */
  consumeAuthorization(input: ConsumeAuthorizationInput): ConsumeAuthorizationResult;
  /** Revoke an unconsumed authorization . Idempotent. */
  revokeAuthorization(authorizationId: string): RevokeAuthorizationResult;
  /** Read one approval by authorization id . */
  authorizationById(authorizationId: string): SignEventRow | undefined;
  /** Read the authorization events for a payment (newest first). */
  signEvents(paymentDigest: string): SignEventRow[];
  /**
   * Read authorization attempts that could not be matched to a payment row.
   * Newest first.
   */
  signAttempts(paymentDigest: string): SignAttemptRow[];
  close(): void;
}

export class SqliteOwnerAuthorizationRepository implements OwnerAuthorizationRepository {
  private readonly db: DatabaseSync;
  private readonly settlementState: SettlementStateReader;
  private readonly now: () => number;
  private closed = false;

  constructor(
    path: string,
    settlementState: SettlementStateReader,
    opts: { now?: () => number; busyTimeoutMs?: number; fileMode?: number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.settlementState = settlementState;
    this.db = new DatabaseSync(path);
    // Multi-process contention: without a busy timeout, a second writer's BEGIN IMMEDIATE
    // fails instantly with SQLITE_BUSY instead of waiting for the first to commit. 5s is
    // longer than any transaction here can reasonably take, and still bounded.
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)}`);
    this.db.exec(OWNER_AUTHORIZATION_SCHEMA);
    // The Owner database holds authorization certificates' durable metadata and
    // the single-use / revocation state. SQLite creates the files world-readable
    // (0644) by default, so tighten them on every open: the -shm file is
    // recreated on each open, so a one-time chmod is not enough. Default 0600
    // (Owner UID only). The containing directory (0700) is the access boundary.
    // Best-effort: a chmod failure must not break startup; the directory is the boundary.
    if (path !== ':memory:') {
      const mode = opts.fileMode ?? 0o600;
      for (const suffix of ['', '-wal', '-shm']) {
        const p = `${path}${suffix}`;
        try {
          if (existsSync(p)) chmodSync(p, mode);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Audit rows for authorization attempts with no matching payment row.
   * Newest first.
   */
  signAttempts(paymentDigest: string): SignAttemptRow[] {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version FROM authorization_attempts WHERE payment_digest = ? ORDER BY id DESC',
      )
      .all(paymentDigest) as unknown as SignAttemptRow[];
  }

  signEvents(paymentDigest: string): SignEventRow[] {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM authorizations WHERE payment_digest = ? ORDER BY id DESC',
      )
      .all(paymentDigest) as unknown as SignEventRow[];
  }

  /**
   * Atomic authorization gate.
   *
   * Everything happens inside ONE `BEGIN IMMEDIATE` transaction on the
   * Owner database; the settlement-state read happens through the
   * read-only interface just before it:
   *   1. read the durable settlement state (read-only)
   *   2. require state === 'created'
   *   3. require tx_hash IS NULL
   *   4. require no prior LIVE successful authorization (a CONSUMED
   *      approval no longer blocks a fresh authorization — a retry after a
   *      consume-then-crash needs a new approval. Two live approvals for one
   *      payment can never exist: the partial unique index enforces it.)
   *   5. append the audit event (with a fresh authorization id on approval)
   *
   * A rejected decision is still audited (so operators can see refusals) but never counts as
   * a successful authorization.
   */
  authorizeSignEvent(input: SignEventInput & { decision: 'approved' | 'rejected' }): AuthorizeSignResult {
    const t = this.now();
    return this.tx(() => {
      const payment = this.settlementState.getPaymentState(input.paymentDigest);

      // A missing payment cannot be audited in `authorizations` (it has no
      // settlement row to bind to), so it is recorded in
      // `authorization_attempts` — no payment row is invented.
      if (!payment) {
        this.insertSignAttempt(input, t, 'unknown_payment');
        return { ok: false as const, reason: 'unknown_payment' as const };
      }

      // Every state-based rejection is audited inside this same transaction.
      if (payment.txHash !== null) {
        this.insertRejectedSignEvent(input, t, 'transaction_hash_already_prepared');
        return { ok: false as const, reason: 'transaction_hash_already_prepared' as const };
      }
      if (payment.state !== 'created') {
        this.insertRejectedSignEvent(input, t, 'payment_not_authorizable');
        return { ok: false as const, reason: 'payment_not_authorizable' as const };
      }

      const prior = this.db
        .prepare("SELECT COUNT(*) AS n FROM authorizations WHERE payment_digest = ? AND decision = 'approved' AND consumed_at IS NULL")
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
   * Atomic authorization consumption .
   *
   * One `BEGIN IMMEDIATE` transaction: load the approval by authorization id,
   * re-verify every bound field against the durable record, the expiry
   * against the clock, and the settlement state (read-only) still being
   * `created` with NULL tx_hash — then mark it consumed. The conditional
   * UPDATE is defense-in-depth against a concurrent consume slipping past
   * the SELECT: exactly one caller can flip an unconsumed row.
   */
  consumeAuthorization(input: ConsumeAuthorizationInput): ConsumeAuthorizationResult {
    const t = this.now();
    const nowSec = Math.floor(t / 1000);
    return this.tx(() => {
      const ev = this.db
        .prepare(
          'SELECT id, payment_digest, decision, network, sender, sponsor, recipient, energy, asset, amount, expiry, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM authorizations WHERE authorization_id = ?',
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
      const payment = this.settlementState.getPaymentState(ev.payment_digest);
      if (!payment) {
        return { ok: false as const, reason: 'unknown_authorization' as const };
      }
      if (payment.txHash !== null) {
        return { ok: false as const, reason: 'transaction_hash_already_prepared' as const };
      }
      if (payment.state !== 'created') {
        return { ok: false as const, reason: 'payment_not_authorizable' as const };
      }
      const changed = this.db
        .prepare('UPDATE authorizations SET consumed_at = ? WHERE authorization_id = ? AND consumed_at IS NULL')
        .run(t, input.authorizationId).changes;
      if (changed !== 1) {
        return { ok: false as const, reason: 'authorization_already_consumed' as const };
      }
      return { ok: true as const };
    });
  }

  /**
   * Revoke an unconsumed authorization . Idempotent: revoking an
   * already-revoked authorization succeeds. A consumed authorization cannot
   * be revoked — it is already spent.
   */
  revokeAuthorization(authorizationId: string): RevokeAuthorizationResult {
    const t = this.now();
    return this.tx(() => {
      const ev = this.db
        .prepare('SELECT decision, consumed_at, revoked_at FROM authorizations WHERE authorization_id = ?')
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
      this.db.prepare('UPDATE authorizations SET revoked_at = ? WHERE authorization_id = ?').run(t, authorizationId);
      return { ok: true as const };
    });
  }

  authorizationById(authorizationId: string): SignEventRow | undefined {
    return this.db
      .prepare(
        'SELECT id, payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd, consumed_at, revoked_at FROM authorizations WHERE authorization_id = ?',
      )
      .get(authorizationId) as unknown as SignEventRow | undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ─── internals ───────────────────────────────────────────────────────

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
        'INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
        'INSERT INTO authorizations (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version, asset, amount, expiry, authorization_id, transaction_digest, transaction_type, max_energy, max_fee_microccd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
   * Lives in `authorization_attempts` (no FK) so a missing payment can be audited without inventing a
   * payment row. `decision` is constrained by the schema to 'rejected'.
   */
  private insertSignAttempt(input: SignEventInput, at: number, reason: string): void {
    this.db
      .prepare(
        'INSERT INTO authorization_attempts (payment_digest, decided_at, decision, reason, network, sender, sponsor, recipient, energy, policy_version) VALUES (?,?,?,?,?,?,?,?,?,?)',
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
