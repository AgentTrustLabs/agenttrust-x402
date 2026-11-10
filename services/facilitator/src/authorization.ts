/**
 * TASK 34.11 — narrow authorization client for FacilitatorCore.settle().
 *
 * Two implementations:
 *   - `LocalAuthorizationClient`: test/mock only. Wraps the durable narrow-sponsor
 *     authorization boundary (MockNarrowSponsorSigner + repository). Used when no IPC
 *     socket is configured. NEVER used in production with a real signer.
 *   - `IpcAuthorizationClient`: production path. Talks to the Authorization Owner over
 *     the Unix socket using the agenttrust-authz v1 protocol. The facilitator never
 *     opens the authorization database.
 *
 * The `AuthorizationClient` interface is the seam: FacilitatorCore holds one and calls
 * `authorize()` after replay protection and before any signer invocation. A rejected,
 * unknown, unavailable, or protocol-error result never reaches the signer.
 *
 * No real signer, key, wallet, or signing is implemented here.
 */

import type { SettlementRepository } from './repository.js';
import type { SponsorPolicy } from './narrowSponsor.js';

export interface AuthorizationRequest {
  paymentDigest: string;
  network: string;
  version: number;
  sender: string;
  sponsor: string;
  recipient: string;
  asset: string;
  amount: string;
  expiry: number;
  energy: bigint;
}

export type AuthorizationOutcome =
  | 'approved'
  | 'rejected'
  | 'unknown'
  | 'owner_unavailable'
  | 'protocol_error';

export interface AuthorizationResponse {
  outcome: AuthorizationOutcome;
  reason: string | null;
  detail: string | null;
}

export interface AuthorizationClient {
  /**
   * Request authorization for a payment. The owner independently verifies durable state
   * and policy. The caller's context is advisory; the owner re-derives the decision.
   *
   * Implementations must never return 'approved' unless the durable gate passed.
   */
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;

  /**
   * TASK 34.13: owner-mediated recovery.
   *
   * Called only after a response was lost or after `authorization_already_recorded`.
   * The owner inspects durable records and reports whether a matching approval exists.
   * It must never create, modify, or delete an authorization record.
   */
  recover(request: AuthorizationRequest): Promise<AuthorizationResponse>;
}

/**
 * Test/mock-only client.
 *
 * Calls the durable atomic gate (`repository.authorizeSignEvent`) directly. This is the
 * exact boundary TASK 34.11 integrates — state must be `created`, `tx_hash` must be NULL,
 * and no prior `approved` event may exist. The audit event is written in the same
 * transaction.
 *
 * It deliberately does NOT run `decideAuthorization`'s base58 address validation: the mock
 * signer's sponsor is a placeholder string (`3mockSponsor...`) that is not a real
 * Concordium account, so the narrow policy would reject every fixture. Production uses
 * `IpcAuthorizationClient`, where the Authorization Owner runs the full policy.
 *
 * Cheap checks that do not need address parsing ARE applied here, so a fixture cannot
 * demonstrate an approval the production owner would refuse:
 *   - sponsor must equal the configured sponsor
 *   - sponsor must not equal sender or recipient
 *   - energy must be positive and ≤ the configured cap
 */
export class LocalAuthorizationClient implements AuthorizationClient {
  private readonly policy: SponsorPolicy;
  private readonly repo: SettlementRepository;
  private readonly now: () => number;

  constructor(deps: { policy: SponsorPolicy; repository: SettlementRepository; now?: () => number }) {
    this.policy = deps.policy;
    this.repo = deps.repository;
    this.now = deps.now ?? (() => Date.now());
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    // Cheap, address-free policy checks first. The owner performs the full policy; these
    // exist so the local client cannot be laxer than the owner on the obvious cases.
    if (request.network !== this.policy.network) {
      return { outcome: 'rejected', reason: 'wrong_network', detail: `request ${request.network} != policy ${this.policy.network}` };
    }
    if (request.sponsor !== this.policy.sponsor) {
      return { outcome: 'rejected', reason: 'wrong_sponsor', detail: `sponsor ${request.sponsor} != configured ${this.policy.sponsor}` };
    }
    if (request.sponsor === request.sender) {
      return { outcome: 'rejected', reason: 'sponsor_is_sender', detail: 'sponsor must not be the sender' };
    }
    if (request.sponsor === request.recipient) {
      return { outcome: 'rejected', reason: 'sponsor_is_recipient', detail: 'sponsor must not be the payment recipient' };
    }
    if (request.energy <= 0n) {
      return { outcome: 'rejected', reason: 'energy_negative', detail: `energy ${request.energy} must be positive` };
    }
    if (request.energy > this.policy.maxEnergy) {
      return { outcome: 'rejected', reason: 'energy_exceeds_cap', detail: `energy ${request.energy} > cap ${this.policy.maxEnergy}` };
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(request.expiry) || request.expiry <= nowSec) {
      return { outcome: 'rejected', reason: 'expired', detail: `expiry ${request.expiry} <= now ${nowSec}` };
    }
    if (request.expiry > nowSec + this.policy.maxExpiryOffsetSeconds) {
      return { outcome: 'rejected', reason: 'expiry_excessive', detail: `expiry ${request.expiry} > now+${this.policy.maxExpiryOffsetSeconds}` };
    }

    // The durable gate. This is the security boundary: state, hash, and prior approval.
    let result: ReturnType<SettlementRepository['authorizeSignEvent']>;
    try {
      result = this.repo.authorizeSignEvent({
        paymentDigest: request.paymentDigest,
        decision: 'approved',
        reason: null,
        network: request.network,
        sender: request.sender,
        sponsor: request.sponsor,
        recipient: request.recipient,
        energy: String(request.energy),
        policyVersion: this.policy.policyVersion,
        // TASK 34.14: bind the full payment context into the durable record.
        asset: request.asset,
        amount: request.amount,
        expiry: request.expiry,
      });
    } catch (e) {
      return { outcome: 'rejected', reason: 'audit_write_failed', detail: (e as Error).message };
    }

    if (!result.ok) {
      return { outcome: 'rejected', reason: result.reason, detail: `durable-state gate: ${result.reason}` };
    }
    return { outcome: 'approved', reason: null, detail: null };
  }

  /**
   * TASK 34.13 — local recovery. Mirrors the owner's recovery logic against the same
   * durable records. Read-only: never writes an authorization record.
   */
  async recover(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    const events = this.repo.signEvents(request.paymentDigest);
    const approved = events.filter((e) => e.decision === 'approved');
    const rejected = events.filter((e) => e.decision === 'rejected');

    if (approved.length === 0) {
      const last = rejected[0];
      if (last !== undefined) {
        return { outcome: 'rejected', reason: last.reason ?? 'authorization_rejected', detail: 'durable rejection exists' };
      }
      // No durable record. The owner policy can still conclusively reject the request
      // without granting approval, so re-derive it (read-only, no record written).
      const nowSec = Math.floor(this.now() / 1000);
      if (request.network !== this.policy.network) {
        return { outcome: 'rejected', reason: 'wrong_network', detail: 'owner policy re-derivation' };
      }
      if (request.sponsor !== this.policy.sponsor) {
        return { outcome: 'rejected', reason: 'wrong_sponsor', detail: 'owner policy re-derivation' };
      }
      if (request.sponsor === request.sender) {
        return { outcome: 'rejected', reason: 'sponsor_is_sender', detail: 'owner policy re-derivation' };
      }
      if (request.sponsor === request.recipient) {
        return { outcome: 'rejected', reason: 'sponsor_is_recipient', detail: 'owner policy re-derivation' };
      }
      if (request.energy <= 0n) {
        return { outcome: 'rejected', reason: 'energy_negative', detail: 'owner policy re-derivation' };
      }
      if (request.energy > this.policy.maxEnergy) {
        return { outcome: 'rejected', reason: 'energy_exceeds_cap', detail: 'owner policy re-derivation' };
      }
      if (!Number.isSafeInteger(request.expiry) || request.expiry <= nowSec) {
        return { outcome: 'rejected', reason: 'expired', detail: 'owner policy re-derivation' };
      }
      if (request.expiry > nowSec + this.policy.maxExpiryOffsetSeconds) {
        return { outcome: 'rejected', reason: 'expiry_excessive', detail: 'owner policy re-derivation' };
      }
      return { outcome: 'unknown', reason: 'no_durable_decision', detail: 'no approval or rejection recorded and policy is inconclusive' };
    }
    if (approved.length > 1) {
      return { outcome: 'unknown', reason: 'conflicting_evidence', detail: `${approved.length} approvals` };
    }
    const ev = approved[0];
    if (ev === undefined) {
      return { outcome: 'unknown', reason: 'conflicting_evidence', detail: 'approval index missing' };
    }
    const mismatches: string[] = [];
    if (ev.network !== request.network) mismatches.push('network');
    if (ev.sender !== request.sender) mismatches.push('sender');
    if (ev.sponsor !== request.sponsor) mismatches.push('sponsor');
    if (ev.recipient !== request.recipient) mismatches.push('recipient');
    if (ev.energy !== String(request.energy)) mismatches.push('energy');
    if (ev.policy_version !== this.policy.policyVersion) mismatches.push('policy_version');
    // TASK 34.14/34.16: bind the full payment context. A NULL in any of these means the
    // record predates the binding → fail closed (we cannot prove the context matches).
    // TASK 34.16: legacy rows (NULL context) are reported with a distinct reason so
    // operators can distinguish "unrecoverable legacy record" from "context mismatch".
    const legacy = ev.asset === null || ev.amount === null || ev.expiry === null;
    if (ev.asset === null) mismatches.push('asset (missing durable evidence)');
    else if (ev.asset !== request.asset) mismatches.push('asset');
    if (ev.amount === null) mismatches.push('amount (missing durable evidence)');
    else if (ev.amount !== request.amount) mismatches.push('amount');
    if (ev.expiry === null) mismatches.push('expiry (missing durable evidence)');
    else if (ev.expiry !== request.expiry) mismatches.push('expiry');
    if (mismatches.length > 0) {
      const reason = legacy ? 'legacy_context_missing' : 'context_mismatch';
      return { outcome: 'unknown', reason, detail: `does not match: ${mismatches.join(', ')}` };
    }
    return { outcome: 'approved', reason: null, detail: 'durable approval verified against request context' };
  }
}

/**
 * Production client. Talks to the Authorization Owner over a Unix domain socket using the
 * agenttrust-authz v1 protocol. The facilitator never opens the authorization database.
 * The owner is consulted by FacilitatorCore.settle() for every authorization decision
 * in real mode (loadConfig requires the socket there); the local client is only a
 * mock/test fallback.
 */
export class IpcAuthorizationClient implements AuthorizationClient {
  constructor(private readonly socketPath: string) {}

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    // Structural: open a Unix socket, send the v1 request, read one JSONL response.
    // Uses Node's net module. Peer credentials are verified by the owner, not the client.
    const net = await import('node:net');
    return new Promise<AuthorizationResponse>((resolve, reject) => {
      const conn = net.createConnection(this.socketPath, () => {
        const envelope = {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation: 'authorize',
          paymentDigest: request.paymentDigest,
          context: {
            network: request.network,
            version: request.version,
            sender: request.sender,
            sponsor: request.sponsor,
            recipient: request.recipient,
            asset: request.asset,
            amount: request.amount,
            expiry: request.expiry,
            energy: String(request.energy),
          },
        };
        conn.write(JSON.stringify(envelope) + '\n');
      });
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: 'IPC timeout' });
      }, 10_000);
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        clearTimeout(timer);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(buf.slice(0, idx)) as Record<string, unknown>;
        } catch {
          conn.destroy();
          resolve({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'invalid JSON response' });
          return;
        }
        conn.end();
        const outcome = String(parsed.outcome ?? '') as AuthorizationOutcome;
        const valid: AuthorizationOutcome[] = ['approved', 'rejected', 'unknown', 'owner_unavailable', 'protocol_error'];
        if (!valid.includes(outcome)) {
          resolve({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'unknown outcome' });
          return;
        }
        resolve({
          outcome,
          reason: (parsed.reason as string | null) ?? null,
          detail: (parsed.detail as string | null) ?? null,
        });
      });
      conn.on('error', (e) => {
        clearTimeout(timer);
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: e.message });
      });
      // F9: if the owner dies mid-request the socket closes without a response.
      // Resolve immediately instead of waiting out the 10s timeout. resolve() is
      // idempotent: a response that already arrived wins, this is a no-op.
      conn.on('close', () => {
        clearTimeout(timer);
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: 'connection closed before response' });
      });
    });
  }

  /** TASK 34.13 — owner-mediated recovery over IPC. Read-only on the owner side. */
  async recover(request: AuthorizationRequest): Promise<AuthorizationResponse> {
    const net = await import('node:net');
    return new Promise<AuthorizationResponse>((resolve) => {
      const conn = net.createConnection(this.socketPath, () => {
        const envelope = {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          operation: 'recover',
          paymentDigest: request.paymentDigest,
          context: {
            network: request.network,
            version: request.version,
            sender: request.sender,
            sponsor: request.sponsor,
            recipient: request.recipient,
            asset: request.asset,
            amount: request.amount,
            expiry: request.expiry,
            energy: String(request.energy),
          },
        };
        conn.write(JSON.stringify(envelope) + '\n');
      });
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: 'IPC timeout' });
      }, 10_000);
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        clearTimeout(timer);
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(buf.slice(0, idx)) as Record<string, unknown>; } catch {
          conn.destroy();
          resolve({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'invalid JSON response' });
          return;
        }
        conn.end();
        const outcome = String(parsed.outcome ?? '') as AuthorizationOutcome;
        const valid: AuthorizationOutcome[] = ['approved', 'rejected', 'unknown', 'owner_unavailable', 'protocol_error'];
        if (!valid.includes(outcome)) {
          resolve({ outcome: 'protocol_error', reason: 'malformed_request', detail: 'unknown outcome' });
          return;
        }
        resolve({ outcome, reason: (parsed.reason as string | null) ?? null, detail: (parsed.detail as string | null) ?? null });
      });
      conn.on('error', (e) => {
        clearTimeout(timer);
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: e.message });
      });
      // F9: same as authorize — a close without a response resolves immediately.
      conn.on('close', () => {
        clearTimeout(timer);
        resolve({ outcome: 'owner_unavailable', reason: 'owner_unavailable', detail: 'connection closed before response' });
      });
    });
  }

  /**
   * Read-only readiness probe (F2/F6). Asks the owner for the identity of the
   * shared database file it is actually using (resolved path + device + inode),
   * so the facilitator can prove the owner authorizes against the same file.
   * Creates no state on either side: no idempotency record, no sign event, no
   * approval. `reachable: false` covers a dead owner, a missing socket, a
   * timeout, and a malformed response.
   */
  async probeDbIdentity(timeoutMs = 10_000): Promise<OwnerDbIdentity> {
    const net = await import('node:net');
    return new Promise<OwnerDbIdentity>((resolve) => {
      const conn = net.createConnection(this.socketPath, () => {
        conn.write(JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: 'db_identity' }) + '\n');
      });
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        resolve({ reachable: false, reason: 'IPC timeout' });
      }, timeoutMs);
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        clearTimeout(timer);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(buf.slice(0, idx)) as Record<string, unknown>;
        } catch {
          conn.destroy();
          resolve({ reachable: false, reason: 'malformed response' });
          return;
        }
        conn.end();
        if (parsed.outcome !== 'ok' || typeof parsed.dbPath !== 'string' || typeof parsed.dbDev !== 'number' || typeof parsed.dbIno !== 'number') {
          resolve({ reachable: false, reason: 'unexpected db_identity response' });
          return;
        }
        resolve({ reachable: true, dbPath: parsed.dbPath, dbDev: parsed.dbDev, dbIno: parsed.dbIno });
      });
      conn.on('error', (e) => {
        clearTimeout(timer);
        resolve({ reachable: false, reason: e.message });
      });
      conn.on('close', () => {
        clearTimeout(timer);
        resolve({ reachable: false, reason: 'connection closed before response' });
      });
    });
  }
}

/** Identity of the database file the Authorization Owner is using (F2). */
export interface OwnerDbIdentity {
  reachable: boolean;
  /** Resolved absolute path of the database file the owner opened. */
  dbPath?: string;
  /** Device + inode of that file (after symlink resolution). */
  dbDev?: number;
  dbIno?: number;
  /** Why the probe failed (unreachable only). Never contains secret material. */
  reason?: string;
}
