/**
 * Discovery storage — the persistence layer for the Service Registry.
 *
 * Two implementations of one narrow `ServiceStore` interface:
 *
 *   - `createMemoryServiceStore()` — in-memory (Map + array). The default
 *     for tests and for any caller that does not need durability.
 *   - `SqliteServiceStore` — durable, backed by `node:sqlite` (built into
 *     Node ≥22.5; no external dependency, no native build). The same
 *     component the facilitator already uses (`services/facilitator/src/
 *     repository.ts`), with the same durability posture: WAL +
 *     `synchronous=FULL`, `BEGIN IMMEDIATE` write transactions, a
 *     5s busy timeout, and 0600 file permissions (best-effort).
 *
 * The registry logic (`src/discovery/registry.ts`) only ever talks to the
 * `ServiceStore` interface, so swapping the backend changes no behaviour:
 * the same validation, duplicate handling, verification mapping and audit
 * rules run on both. The HTTP Discovery layer is untouched by this change.
 *
 * Schema invariants (enforced by SQLite, not just by the application):
 *   - `services.id` is PRIMARY KEY → one row per service, so the same id
 *     can never be recorded twice, whatever the process does.
 *   - `status` and `verification_status` are CHECK-constrained to their
 *     closed value sets → a corrupt write cannot invent a new status.
 *   - `audit` is append-only: rows are inserted, never updated or deleted
 *     by this module. It records who did what, when, to which service.
 */

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, chownSync, existsSync, readFileSync } from 'node:fs';
import type { ServiceRecord } from './registry.js';

export interface AuditEntry {
  /** ISO timestamp of the action. */
  at: string;
  /** Who performed it (operator name, CLI --actor, or 'operator'). */
  actor: string;
  /** What happened. */
  action: 'register' | 'activate' | 'deactivate' | 'verify';
  /** The service the action targeted. */
  serviceId: string;
  /** Short, human-readable detail (decision, reason, field changed). */
  detail: string;
}

export interface ServiceStore {
  /**
   * Insert a new service. Fails closed on a duplicate id:
   * `{ ok: false, reason: 'duplicate_id' }`. Never overwrites.
   */
  insert(service: ServiceRecord): { ok: true } | { ok: false; reason: string };
  /** Replace the stored row for an existing service (status / verification). */
  update(service: ServiceRecord): void;
  get(id: string): ServiceRecord | undefined;
  listAll(): ServiceRecord[];
  /** Append one audit row. Never throws for a missing service (the audit is the record). */
  appendAudit(entry: AuditEntry): void;
  /** Audit rows, newest first. Filtered by service when an id is given. */
  auditLog(serviceId?: string): AuditEntry[];
  close(): void;
}

export function createMemoryServiceStore(): ServiceStore {
  const services = new Map<string, ServiceRecord>();
  const audit: AuditEntry[] = [];
  return {
    insert(service) {
      if (services.has(service.id)) return { ok: false, reason: 'duplicate_id' };
      services.set(service.id, structuredClone(service));
      return { ok: true };
    },
    update(service) {
      if (!services.has(service.id)) return;
      services.set(service.id, structuredClone(service));
    },
    get(id) {
      const s = services.get(id);
      return s ? structuredClone(s) : undefined;
    },
    listAll() {
      return [...services.values()].map(s => structuredClone(s));
    },
    appendAudit(entry) {
      audit.push({ ...entry });
    },
    auditLog(serviceId) {
      const rows = serviceId ? audit.filter(a => a.serviceId === serviceId) : [...audit];
      return rows.reverse();
    },
    close() {
      /* nothing to close */
    },
  };
}

// ─── SQLite ─────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS services (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,
  endpoint              TEXT NOT NULL,
  provider_token_id     INTEGER NOT NULL,
  provider_owner_account TEXT NOT NULL,
  provider_agent_uri    TEXT,
  network               TEXT NOT NULL,
  pricing_amount        TEXT NOT NULL,
  pricing_pay_to        TEXT NOT NULL,
  pricing_max_timeout   INTEGER,
  pricing_description   TEXT,
  status                TEXT NOT NULL CHECK (status IN ('active','inactive')),
  verification_status   TEXT NOT NULL CHECK (verification_status IN ('registered','verified','rejected','unverified')),
  verification_decision TEXT,
  verification_checked_at TEXT,
  verification_reason   TEXT,
  registered_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  detail      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_service ON audit(service_id, id);
`;

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  category: string;
  endpoint: string;
  provider_token_id: number;
  provider_owner_account: string;
  provider_agent_uri: string | null;
  network: string;
  pricing_amount: string;
  pricing_pay_to: string;
  pricing_max_timeout: number | null;
  pricing_description: string | null;
  status: 'active' | 'inactive';
  verification_status: 'registered' | 'verified' | 'rejected' | 'unverified';
  verification_decision: string | null;
  verification_checked_at: string | null;
  verification_reason: string | null;
  registered_at: string;
}

function rowToService(r: ServiceRow): ServiceRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category as ServiceRecord['category'],
    endpoint: r.endpoint,
    provider: {
      tokenId: r.provider_token_id,
      ownerAccount: r.provider_owner_account,
      agentUri: r.provider_agent_uri,
    },
    network: r.network,
    pricing: {
      amountMicroCcd: r.pricing_amount,
      asset: 'CCD',
      payTo: r.pricing_pay_to,
      ...(r.pricing_max_timeout !== null ? { maxTimeoutSeconds: r.pricing_max_timeout } : {}),
      ...(r.pricing_description !== null ? { description: r.pricing_description } : {}),
    },
    status: r.status,
    providerVerification: {
      status: r.verification_status,
      ...(r.verification_decision !== null
        ? { decision: r.verification_decision as 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE' }
        : {}),
      ...(r.verification_checked_at !== null ? { checkedAt: r.verification_checked_at } : {}),
      ...(r.verification_reason !== null ? { reason: r.verification_reason } : {}),
    },
    registeredAt: r.registered_at,
  };
}

/** Resolve a username to (uid, gid) by reading /etc/passwd. Null when unknown. */
function userIds(name: string): { uid: number; gid: number } | null {
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const parts = line.split(':');
      if (parts[0] === name && parts[2] !== undefined && parts[3] !== undefined) {
        const uid = Number(parts[2]);
        const gid = Number(parts[3]);
        if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
      }
    }
  } catch {
    /* no passwd access: no ownership fix */
  }
  return null;
}

export interface SqliteServiceStoreOptions {
  busyTimeoutMs?: number;
  fileMode?: number;
  /**
   * Operating-system user the database files should belong to when this
   * process runs as root (so a service running as that user can read and
   * write them). Best-effort: ignored when not root, when the user does not
   * exist, or when the chown fails. Default 'agenttrust'.
   */
  serviceUser?: string;
}

export class SqliteServiceStore implements ServiceStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private closed = false;

  constructor(path: string, opts: SqliteServiceStoreOptions = {}) {
    this.path = path;
    // Throws when the file cannot be created/opened (e.g. the directory does
    // not exist). The caller must surface that as a startup failure, not as
    // an empty registry.
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)}`);
    this.db.exec(SCHEMA);
    // Tighten permissions on every open (the -shm file is recreated per open).
    // Best-effort: a chmod failure must not break startup; the containing
    // directory is the access boundary.
    const mode = opts.fileMode ?? 0o600;
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${path}${suffix}`;
      try {
        if (existsSync(p)) chmodSync(p, mode);
      } catch { /* best-effort */ }
    }
    // When root creates the file (e.g. the operator CLI runs first), the
    // service user could not read it. Hand the files to the service user so
    // the server can use a database the operator created, and vice versa.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const ids = userIds(opts.serviceUser ?? 'agenttrust');
      if (ids) {
        for (const suffix of ['', '-wal', '-shm']) {
          const p = `${path}${suffix}`;
          try {
            if (existsSync(p)) chownSync(p, ids.uid, ids.gid);
          } catch { /* best-effort */ }
        }
      }
    }
  }

  insert(service: ServiceRecord): { ok: true } | { ok: false; reason: string } {
    try {
      return this.tx(() => {
        try {
          this.db
            .prepare(
              `INSERT INTO services (id, name, description, category, endpoint,
                provider_token_id, provider_owner_account, provider_agent_uri, network,
                pricing_amount, pricing_pay_to, pricing_max_timeout, pricing_description,
                status, verification_status, verification_decision, verification_checked_at,
                verification_reason, registered_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              service.id,
              service.name,
              service.description,
              service.category,
              service.endpoint,
              service.provider.tokenId,
              service.provider.ownerAccount,
              service.provider.agentUri,
              service.network,
              service.pricing.amountMicroCcd,
              service.pricing.payTo,
              service.pricing.maxTimeoutSeconds ?? null,
              service.pricing.description ?? null,
              service.status,
              service.providerVerification.status,
              service.providerVerification.decision ?? null,
              service.providerVerification.checkedAt ?? null,
              service.providerVerification.reason ?? null,
              service.registeredAt,
            );
          return { ok: true as const };
        } catch (e) {
          const msg = (e as Error).message;
          // A duplicate id is a caller-level outcome, not a crash: the registry
          // turns it into an idempotent hit or a duplicate error.
          if (msg.includes('UNIQUE constraint') || msg.includes('PRIMARY KEY')) {
            return { ok: false as const, reason: 'duplicate_id' };
          }
          throw e;
        }
      });
    } catch (e) {
      // A storage failure (read-only file, full disk, I/O error) must surface
      // as a failure the caller can report — never as a phantom success.
      throw new Error(`discovery storage failure: ${(e as Error).message}`);
    }
  }

  update(service: ServiceRecord): void {
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE services SET name=?, description=?, category=?, endpoint=?,
             provider_token_id=?, provider_owner_account=?, provider_agent_uri=?, network=?,
             pricing_amount=?, pricing_pay_to=?, pricing_max_timeout=?, pricing_description=?,
             status=?, verification_status=?, verification_decision=?, verification_checked_at=?,
             verification_reason=?, registered_at=? WHERE id=?`,
        )
        .run(
          service.name,
          service.description,
          service.category,
          service.endpoint,
          service.provider.tokenId,
          service.provider.ownerAccount,
          service.provider.agentUri,
          service.network,
          service.pricing.amountMicroCcd,
          service.pricing.payTo,
          service.pricing.maxTimeoutSeconds ?? null,
          service.pricing.description ?? null,
          service.status,
          service.providerVerification.status,
          service.providerVerification.decision ?? null,
          service.providerVerification.checkedAt ?? null,
          service.providerVerification.reason ?? null,
          service.registeredAt,
          service.id,
        );
    });
  }

  get(id: string): ServiceRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(id) as unknown as ServiceRow | undefined;
    return row ? rowToService(row) : undefined;
  }

  listAll(): ServiceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM services ORDER BY registered_at, id')
      .all() as unknown as ServiceRow[];
    return rows.map(rowToService);
  }

  appendAudit(entry: AuditEntry): void {
    this.tx(() => {
      this.db
        .prepare('INSERT INTO audit (at, actor, action, service_id, detail) VALUES (?,?,?,?,?)')
        .run(entry.at, entry.actor, entry.action, entry.serviceId, entry.detail);
    });
  }

  auditLog(serviceId?: string): AuditEntry[] {
    const rows = (
      serviceId
        ? this.db
            .prepare('SELECT at, actor, action, service_id, detail FROM audit WHERE service_id = ? ORDER BY id DESC')
            .all(serviceId)
        : this.db
            .prepare('SELECT at, actor, action, service_id, detail FROM audit ORDER BY id DESC')
            .all()
    ) as unknown as Array<{ at: string; actor: string; action: string; service_id: string; detail: string }>;
    return rows.map(r => ({
      at: r.at,
      actor: r.actor,
      action: r.action as AuditEntry['action'],
      serviceId: r.service_id,
      detail: r.detail,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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
