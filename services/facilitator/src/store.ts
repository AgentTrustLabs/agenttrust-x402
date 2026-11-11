/**
 * Replay, idempotency and pending-settlement state.
 *
 * Three distinct concerns, deliberately kept apart:
 *
 *  1. **Replay** — the same payment payload must not buy two different resources, and the same
 *     payload must not settle twice. Keyed by a stable digest of the payload.
 *  2. **Idempotency** — a duplicate `/settle` for a payload we already settled returns the
 *     *same* transaction hash rather than settling again (or failing).
 *  3. **Pending** — a submission whose outcome we could not establish is recorded as
 *     `settlement_pending` with its hash. That is **non-terminal**: it is never converted into
 *     success. Reconciliation only moves pending → settled when the chain itself reports
 *     finalization for that exact hash.
 *
 * Nothing here retries. An ambiguous outcome stays ambiguous until it is reconciled.
 */

import { createHash } from 'node:crypto';

export interface ReplayEntry {
  digest: string;
  /**
   * Digest of the *authorisation*, independent of which resource it is presented for.
   * A signed transaction pays a fixed recipient an fixed amount; it must not be redeemable
   * against a second resource just because `resource.url` differs.
   */
  paymentDigest: string;
  /** What the payload was authorised for. A second, different spend is refused. */
  requirementsKey: string;
  firstSeenAt: number;
  state: 'verified' | 'settling' | 'settled' | 'pending' | 'failed';
  transaction: string | null;
  /** Set when the payload was already consumed for a different resource. */
  consumedBy: string | null;
}

export interface PendingEntry {
  digest: string;
  transaction: string;
  requirementsKey: string;
  submittedAt: number;
  /** Resolved only by an external reconciliation that names this exact hash. */
  status: 'pending' | 'settled' | 'failed';
}

export type SettleGuard =
  | { ok: true; replay: false }
  /** Duplicate settle for a payload already settled: return the same hash, do not re-settle. */
  | { ok: true; replay: true; transaction: string }
  /** Pending: outcome unknown. Never success, never retried automatically. */
  | { ok: false; reason: 'settlement_pending'; transaction: string }
  | { ok: false; reason: string };

export interface StoreOptions {
  now?: () => number;
  replayTtlMs?: number;
  pendingTtlMs?: number;
}

/** Stable digest of a whole payment payload (including resource). Repro­ducible. */
export function payloadDigest(payload: unknown): string {
  const canonical = canonicalise(payload);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Digest of the **payment itself**.
 *
 * This is the replay key, and it deliberately covers ONLY what the payer signed:
 * `payload` (the signed transaction) and the protocol version. Two exclusions matter:
 *
 *  - `resource` — a signature pays a fixed recipient a fixed amount once, not once per
 *    endpoint, so the resource must not segment the key.
 *  - `accepted` — this is the client's *restatement* of the requirements. Including it lets
 *    a caller present the SAME signed transaction with a rewritten `accepted` object and
 *    obtain a fresh digest, i.e. a second submission. (Altering
 *    `accepted.amount` alone produced a second submit.) `accepted` agreement is checked
 *    separately against the seller's requirements; it must never key identity.
 */
export function paymentDigest(payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  const signedPortion = {
    x402Version: p?.['x402Version'],
    payload: p?.['payload'],
  };
  return createHash('sha256').update(canonicalise(signedPortion)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/** Identity of what a payment authorises: recipient, amount, asset, network, resource. */
export function requirementsKey(requirements: {
  payTo?: string;
  amount?: string;
  asset?: string;
  network?: string;
}, resourceUrl?: string): string {
  return [requirements.network ?? '', requirements.payTo ?? '', requirements.amount ?? '', requirements.asset ?? '', resourceUrl ?? ''].join('|');
}

export class SettlementStore {
  private readonly replays = new Map<string, ReplayEntry>();
  private readonly pendings = new Map<string, PendingEntry>();
  private readonly now: () => number;
  private readonly replayTtlMs: number;
  private readonly pendingTtlMs: number;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.replayTtlMs = opts.replayTtlMs ?? 10 * 60_000;
    this.pendingTtlMs = opts.pendingTtlMs ?? 2 * 60_000;
  }

  /**
   * Record that a payment was verified. Keyed by {@link paymentDigest}, so the same signed
   * transaction cannot authorise two resources (or two recipients/amounts).
   */
  noteVerified(digest: string, reqKey: string): { ok: true } | { ok: false; reason: string } {
    this.sweep();
    const existing = this.replays.get(digest);
    if (!existing) {
      this.replays.set(digest, {
        digest,
        paymentDigest: digest,
        requirementsKey: reqKey,
        firstSeenAt: this.now(),
        state: 'verified',
        transaction: null,
        consumedBy: null,
      });
      return { ok: true };
    }
    if (existing.requirementsKey !== reqKey) {
      // Same signed payment presented for a different recipient/amount/resource.
      return {
        ok: false,
        reason: `payment already used for a different authorisation (${existing.requirementsKey})`,
      };
    }
    return { ok: true };
  }

  /**
   * Gate a settle request.
   *
   *  - never settled → `{ ok: true, replay: false }` and the caller may submit
   *  - already settled → `{ ok: true, replay: true, transaction }` (same hash, no re-settle)
   *  - pending        → `{ ok: false, reason: 'settlement_pending' }` — never success, never retried
   *  - failed         → `{ ok: false, reason: 'previous settlement failed' }`
   */
  guardSettle(digest: string, reqKey: string): SettleGuard {
    this.sweep();
    const entry = this.replays.get(digest);
    if (!entry) {
      this.replays.set(digest, {
        digest,
        paymentDigest: digest,
        requirementsKey: reqKey,
        firstSeenAt: this.now(),
        state: 'settling',
        transaction: null,
        consumedBy: null,
      });
      return { ok: true, replay: false };
    }
    if (entry.requirementsKey !== reqKey) {
      return { ok: false, reason: `payment already used for a different authorisation (${entry.requirementsKey})` };
    }
    if (entry.state === 'settled' && entry.transaction) {
      return { ok: true, replay: true, transaction: entry.transaction };
    }
    if (entry.state === 'pending' && entry.transaction) {
      return { ok: false, reason: 'settlement_pending', transaction: entry.transaction };
    }
    if (entry.state === 'failed') {
      return { ok: false, reason: 'previous settlement attempt failed; a new payload is required' };
    }
    // settling: another request is in flight for this payload right now.
    return { ok: false, reason: 'settlement already in progress for this payload' };
  }

  markSettled(digest: string, transaction: string): void {
    const entry = this.replays.get(digest);
    if (!entry) return;
    entry.state = 'settled';
    entry.transaction = transaction;
    this.pendings.delete(digest);
  }

  /**
   * Record an ambiguous submission. Non-terminal: the entry carries the hash so it can be
   * reconciled, but it is NOT a success and will not be auto-retried.
   */
  markPending(digest: string, transaction: string, reqKey: string): void {
    const entry = this.replays.get(digest);
    if (entry) {
      entry.state = 'pending';
      entry.transaction = transaction;
    }
    this.pendings.set(digest, {
      digest,
      transaction,
      requirementsKey: reqKey,
      submittedAt: this.now(),
      status: 'pending',
    });
  }

  markFailed(digest: string): void {
    const entry = this.replays.get(digest);
    if (entry) {
      entry.state = 'failed';
      entry.transaction = null;
    }
    this.pendings.delete(digest);
  }

  /**
   * Reconciliation. Only an explicit chain observation for **this exact hash** can move a
   * pending entry, and only `finalized` becomes settled. Unknown outcomes stay pending.
   */
  reconcile(digest: string, observed: { transaction: string; status: 'pending' | 'committed' | 'finalized' | 'failed' }):
    | { ok: true; status: 'settled' | 'failed' | 'pending' }
    | { ok: false; reason: string } {
    const p = this.pendings.get(digest);
    if (!p) return { ok: false, reason: 'no pending settlement for this payload' };
    if (p.transaction !== observed.transaction) {
      return { ok: false, reason: `hash mismatch: pending=${p.transaction} observed=${observed.transaction}` };
    }
    if (observed.status === 'finalized') {
      p.status = 'settled';
      this.markSettled(digest, p.transaction);
      return { ok: true, status: 'settled' };
    }
    if (observed.status === 'failed') {
      p.status = 'failed';
      this.markFailed(digest);
      return { ok: true, status: 'failed' };
    }
    // committed is not final; pending stays pending. Neither is success.
    return { ok: true, status: 'pending' };
  }

  pendingFor(digest: string): PendingEntry | undefined {
    return this.pendings.get(digest);
  }

  entryFor(digest: string): ReplayEntry | undefined {
    return this.replays.get(digest);
  }

  /** Drop entries past their TTL. Expiry never turns anything into a success. */
  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.replays) {
      if (t - v.firstSeenAt > this.replayTtlMs) this.replays.delete(k);
    }
    for (const [k, v] of this.pendings) {
      if (t - v.submittedAt > this.pendingTtlMs) this.pendings.delete(k);
    }
  }

  get size(): { replays: number; pendings: number } {
    return { replays: this.replays.size, pendings: this.pendings.size };
  }
}
