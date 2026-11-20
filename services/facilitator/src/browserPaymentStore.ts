/**
 * Durable store for browser-initiated sponsored payments.
 *
 * Separate from the CLI `payments` table: a browser payment is keyed by a
 * `paymentRef` issued at prepare time, because the final x402 payload digest
 * changes once the wallet adds the sender signature. The prepared digest is
 * still recorded, so the Owner authorization remains auditable.
 *
 * The table is created lazily (`IF NOT EXISTS`) and migrated column-wise, so
 * opening an existing facilitator database never rewrites CLI settlement state.
 */

import { DatabaseSync } from 'node:sqlite';
import type { BrowserPaymentRow, BrowserPaymentState, BrowserPaymentStore } from './browserBridge.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_payments (
  payment_ref               TEXT PRIMARY KEY,
  request_id                TEXT NOT NULL,
  prepared_digest           TEXT NOT NULL,
  requirements_key          TEXT NOT NULL,
  resource_url              TEXT NOT NULL,
  sender                    TEXT NOT NULL,
  sponsor                   TEXT NOT NULL,
  state                     TEXT NOT NULL,
  tx_hash                   TEXT,
  prepared_transaction      TEXT NOT NULL,
  sponsor_signed_transaction TEXT NOT NULL DEFAULT '',
  final_transaction         TEXT,
  evidence                  TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_payments_state ON browser_payments(state);
CREATE UNIQUE INDEX IF NOT EXISTS ux_browser_payments_ref_hash
  ON browser_payments(payment_ref, tx_hash) WHERE tx_hash IS NOT NULL;
`;

const MUTABLE = new Set(['state', 'tx_hash', 'sponsor_signed_transaction', 'final_transaction', 'evidence', 'submission_claimed', 'submission_tx_hash', 'submission_error', 'updated_at']);


/** Parse the stored requirements key: network|payTo|amount|asset|resourceUrl. */
function parseRequirementsKey(key: string): { network: string | null; payTo: string | null; amount: string | null; asset: string | null } {
  const parts = key.split('|');
  return { network: parts[0] || null, payTo: parts[1] || null, amount: parts[2] || null, asset: parts[3] || null };
}

/** Verification section for the listing/detail: only stored chain evidence. */
export function browserPaymentVerification(row: BrowserPaymentRow): Record<string, unknown> {
  let evidence: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = row.evidence ? JSON.parse(row.evidence) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) evidence = parsed as Record<string, unknown>;
  } catch { evidence = null; }
  const blockHash = evidence && typeof evidence['blockHash'] === 'string' && /^[0-9a-f]{64}$/.test((evidence['blockHash'] as string).toLowerCase())
    ? (evidence['blockHash'] as string).toLowerCase() : null;
  const verified = row.state === 'finalized' && blockHash !== null;
  return {
    available: verified,
    observed: verified ? 'finalized' : 'unknown',
    source: verified ? 'concordium-grpc' : (evidence ? 'stored' : 'none'),
    finalized: verified,
    blockHash,
    blockHeight: null,
    feeMicroCcd: null,
    energy: null,
    error: verified ? null : 'no live finality evidence recorded',
  };
}

/** Public listing row for a browser payment. */
export function browserPaymentPublic(row: BrowserPaymentRow): Record<string, unknown> {
  const req = parseRequirementsKey(row.requirements_key);
  return {
    source: 'browser',
    paymentDigest: row.payment_ref,
    state: row.state,
    transactionHash: row.tx_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempted: 0,
    resourceUrl: row.resource_url,
    sender: row.sender,
    sponsor: row.sponsor,
    recipient: req.payTo,
    amountMicroCcd: req.amount,
    network: req.network,
    verification: browserPaymentVerification(row),
  };
}

/** Public detail for a browser payment: stored evidence only, never a fresh claim. */
export function browserPaymentDetail(row: BrowserPaymentRow): Record<string, unknown> {
  const req = parseRequirementsKey(row.requirements_key);
  const verification = browserPaymentVerification(row);
  return {
    source: 'browser',
    paymentDigest: row.payment_ref,
    state: row.state,
    transactionHash: row.tx_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resource: { url: row.resource_url },
    requirements: { network: req.network, payTo: req.payTo, amount: req.amount, asset: req.asset },
    sender: row.sender,
    sponsor: row.sponsor,
    recipient: req.payTo,
    amountMicroCcd: req.amount,
    network: req.network,
    verification,
    finalized: row.state === 'finalized' && verification['finalized'] === true,
    transitions: [],
  };
}


export class SqliteBrowserPaymentStore implements BrowserPaymentStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(path: string, opts: { now?: () => number; busyTimeoutMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)}`);
    this.db.exec(SCHEMA);
    this.migrate();
  }
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(browser_payments)').all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    for (const [col, ddl] of [
      ['sponsor_signed_transaction', "TEXT NOT NULL DEFAULT ''"],
      ['final_transaction', 'TEXT'],
      ['evidence', 'TEXT'],
      ['submission_claimed', 'INTEGER NOT NULL DEFAULT 0'],
      ['submission_tx_hash', 'TEXT'],
      ['submission_error', 'TEXT'],
    ] as const) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE browser_payments ADD COLUMN ${col} ${ddl}`);
    }
  }
  createBrowserPayment(row: BrowserPaymentRow): { ok: true } | { ok: false; reason: string } {
    try {
      this.db.prepare(
        'INSERT INTO browser_payments (payment_ref, request_id, prepared_digest, requirements_key, resource_url, sender, sponsor, state, tx_hash, prepared_transaction, sponsor_signed_transaction, final_transaction, evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(row.payment_ref, row.request_id, row.prepared_digest, row.requirements_key, row.resource_url, row.sender, row.sponsor, row.state, row.tx_hash, row.prepared_transaction, row.sponsor_signed_transaction, row.final_transaction, row.evidence, row.created_at, row.updated_at);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `payment_ref already exists (${(e as Error).message})` };
    }
  }
  getBrowserPayment(paymentRef: string): BrowserPaymentRow | null {
    const row = this.db.prepare('SELECT * FROM browser_payments WHERE payment_ref = ?').get(paymentRef) as BrowserPaymentRow | undefined;
    return row ?? null;
  }
  getBrowserPaymentByTxHash(txHash: string): BrowserPaymentRow | null {
    if (!/^[0-9a-f]{64}$/.test(txHash.toLowerCase())) return null;
    const row = this.db.prepare('SELECT * FROM browser_payments WHERE tx_hash = ? LIMIT 1').get(txHash.toLowerCase()) as BrowserPaymentRow | undefined;
    return row ?? null;
  }
  listBrowserPayments(limit: number): BrowserPaymentRow[] {
    const n = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
    return this.db.prepare('SELECT * FROM browser_payments ORDER BY updated_at DESC, payment_ref DESC LIMIT ?').all(n) as unknown as BrowserPaymentRow[];
  }
  claimSubmission(paymentRef: string): { ok: true } | { ok: false; reason: string } {
    const res = this.db.prepare(
      "UPDATE browser_payments SET submission_claimed = 1, state = 'submitting', updated_at = ? WHERE payment_ref = ? AND submission_claimed = 0",
    ).run(this.now(), paymentRef);
    if (res.changes !== 1) return { ok: false, reason: 'already_claimed' };
    return { ok: true };
  }

  updateBrowserPayment(paymentRef: string, patch: Partial<BrowserPaymentRow>): { ok: true } | { ok: false; reason: string } {
    const entries = Object.entries(patch).filter(([k, v]) => MUTABLE.has(k) && v !== undefined);
    if (!entries.length) return { ok: false, reason: 'no mutable fields' };
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const res = this.db.prepare(`UPDATE browser_payments SET ${sets}, updated_at = ? WHERE payment_ref = ?`).run(...entries.map(([, v]) => v), this.now(), paymentRef);
    if (res.changes !== 1) return { ok: false, reason: 'unknown payment_ref' };
    return { ok: true };
  }
  close(): void { this.db.close(); }
}
