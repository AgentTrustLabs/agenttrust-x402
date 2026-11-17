/**
 * Narrow authorization client for FacilitatorCore.settle().
 *
 * Two implementations:
 *   - `LocalAuthorizationClient`: test/mock only. Wraps the durable narrow-sponsor
 *     authorization boundary (MockNarrowSponsorSigner + Owner-private
 *     repository). Used when no IPC socket is configured. NEVER used in
 *     production with a real signer.
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

import type {
  OwnerAuthorizationRepository,
} from './ownerAuthorizationRepository.js';
import type { SponsorPolicy } from './narrowSponsor.js';
import {
  generateOwnerAuthorizationKeyPair,
  issueOwnerAuthorizationCertificate,
  ownerAuthorizationPublicKeyHex,
  type OwnerAuthorizationCertificate,
} from './ownerAuthorization.js';

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
  /** Concordium sponsor-sign digest of the exact transaction, 64-hex. */
  transactionDigest: string;
  /** raw payload type string of the transaction, e.g. 'transfer'. */
  transactionType: string;
  /** fee cap the authorization is issued under (microCCD), decimal string. */
  maxFeeMicroCcd: string;
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
  /**
   * the Owner's authorization certificate for the exact
   * transaction, present only on approval. The facilitator forwards it
   * opaquely to the signing service, which verifies it. A missing
   * certificate on an approval fails closed downstream.
   */
  certificate?: OwnerAuthorizationCertificate | null;
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
   * Owner-mediated recovery.
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
 * exact boundary integrates — state must be `created`, `tx_hash` must be NULL,
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
  private readonly repo: OwnerAuthorizationRepository;
  private readonly now: () => number;
  /**
   * ephemeral Owner authorization keypair, generated per client.
   * The mock client IS the Owner in tests, so it issues real certificates;
   * the test configures the signing service with `authorizationPublicKeyHex()`.
   * Production never uses this client.
   */
  private readonly keyPair = generateOwnerAuthorizationKeyPair();

  constructor(deps: { policy: SponsorPolicy; repository: OwnerAuthorizationRepository; now?: () => number }) {
    this.policy = deps.policy;
    this.repo = deps.repository;
    this.now = deps.now ?? (() => Date.now());
  }

  /** SPKI DER hex of this client's Owner public key (for the signing service). */
  authorizationPublicKeyHex(): string {
    return ownerAuthorizationPublicKeyHex(this.keyPair.publicKey);
  }

  /** Issue the certificate for an approved authorization record. */
  private issueCertificate(input: {
    authorizationId: string;
    paymentDigest: string;
    transactionDigest: string;
    transactionType: string;
    network: string;
    sender: string;
    sponsor: string;
    recipient: string;
    asset: string;
    amount: string;
    expiry: number;
    energy: bigint;
    maxFeeMicroCcd: string;
  }): OwnerAuthorizationCertificate {
    return issueOwnerAuthorizationCertificate(
      {
        version: 1,
        authorizationId: input.authorizationId,
        paymentDigest: input.paymentDigest,
        transactionDigest: input.transactionDigest,
        transactionType: input.transactionType,
        network: input.network,
        sender: input.sender,
        sponsor: input.sponsor,
        recipient: input.recipient,
        asset: input.asset,
        amount: input.amount,
        expiry: input.expiry,
        energy: String(input.energy),
        maxEnergy: String(this.policy.maxEnergy),
        maxFeeMicroCcd: input.maxFeeMicroCcd,
        policyVersion: this.policy.policyVersion,
        issuedAt: this.now(),
      },
      this.keyPair.privateKey,
    );
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
    // the transaction binding must be well-formed before any
    // certificate can be issued for it.
    if (!/^[0-9a-fA-F]{64}$/.test(request.transactionDigest)) {
      return { outcome: 'rejected', reason: 'invalid_field', detail: 'transactionDigest is not 64-hex' };
    }
    if (typeof request.transactionType !== 'string' || request.transactionType.length === 0) {
      return { outcome: 'rejected', reason: 'invalid_field', detail: 'transactionType is empty' };
    }
    if (!/^[0-9]+$/.test(request.maxFeeMicroCcd)) {
      return { outcome: 'rejected', reason: 'invalid_field', detail: 'maxFeeMicroCcd is not a decimal string' };
    }

    // The durable gate. This is the security boundary: state, hash, and prior approval.
    let result: ReturnType<OwnerAuthorizationRepository['authorizeSignEvent']>;
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
        // Bind the full payment context into the durable record.
        asset: request.asset,
        amount: request.amount,
        expiry: request.expiry,
        // bind the exact transaction the approval covers.
        transactionDigest: request.transactionDigest,
        transactionType: request.transactionType,
        maxEnergy: String(this.policy.maxEnergy),
        maxFeeMicroCcd: request.maxFeeMicroCcd,
      });
    } catch (e) {
      return { outcome: 'rejected', reason: 'audit_write_failed', detail: (e as Error).message };
    }

    if (!result.ok) {
      return { outcome: 'rejected', reason: result.reason, detail: `durable-state gate: ${result.reason}` };
    }
    if (result.authorizationId === null) {
      // The gate approved but issued no id — the approval cannot be
      // certified, so it cannot authorize a signing. Fail closed.
      return { outcome: 'rejected', reason: 'audit_write_failed', detail: 'approval recorded without an authorization id' };
    }
    const certificate = this.issueCertificate({
      authorizationId: result.authorizationId,
      paymentDigest: request.paymentDigest,
      transactionDigest: request.transactionDigest,
      transactionType: request.transactionType,
      network: request.network,
      sender: request.sender,
      sponsor: request.sponsor,
      recipient: request.recipient,
      asset: request.asset,
      amount: request.amount,
      expiry: request.expiry,
      energy: request.energy,
      maxFeeMicroCcd: request.maxFeeMicroCcd,
    });
    return { outcome: 'approved', reason: null, detail: null, certificate };
  }

  /**
   * Local recovery. Mirrors the owner's recovery logic against the same
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
    // a consumed approval is spent: recovery must NOT re-issue a
    // usable certificate for it. The caller fails closed and a fresh
    // authorization can issue a new approval. A revoked approval is refused.
    if (ev.consumed_at !== null) {
      return { outcome: 'unknown', reason: 'authorization_consumed', detail: 'the durable approval was already consumed' };
    }
    if (ev.revoked_at !== null) {
      return { outcome: 'rejected', reason: 'authorization_revoked', detail: 'the durable approval was revoked' };
    }
    const mismatches: string[] = [];
    if (ev.network !== request.network) mismatches.push('network');
    if (ev.sender !== request.sender) mismatches.push('sender');
    if (ev.sponsor !== request.sponsor) mismatches.push('sponsor');
    if (ev.recipient !== request.recipient) mismatches.push('recipient');
    if (ev.energy !== String(request.energy)) mismatches.push('energy');
    if (ev.policy_version !== this.policy.policyVersion) mismatches.push('policy_version');
    // Bind the full payment context. A NULL in any of these means the
    // record predates the binding → fail closed (we cannot prove the context matches).
    // Legacy rows (NULL context) are reported with a distinct reason so
    // operators can distinguish "unrecoverable legacy record" from "context mismatch".
    const legacy = ev.asset === null || ev.amount === null || ev.expiry === null;
    if (ev.asset === null) mismatches.push('asset (missing durable evidence)');
    else if (ev.asset !== request.asset) mismatches.push('asset');
    if (ev.amount === null) mismatches.push('amount (missing durable evidence)');
    else if (ev.amount !== request.amount) mismatches.push('amount');
    if (ev.expiry === null) mismatches.push('expiry (missing durable evidence)');
    else if (ev.expiry !== request.expiry) mismatches.push('expiry');
    // the exact transaction binding. A NULL means the approval
    // predates the binding and cannot be certified.
    const legacyBinding =
      ev.authorization_id === null ||
      ev.transaction_digest === null ||
      ev.transaction_type === null ||
      ev.max_energy === null ||
      ev.max_fee_microccd === null;
    if (ev.authorization_id === null) mismatches.push('authorization_id (missing durable evidence)');
    if (ev.transaction_digest === null) mismatches.push('transaction_digest (missing durable evidence)');
    else if (ev.transaction_digest !== request.transactionDigest) mismatches.push('transaction_digest');
    if (ev.transaction_type === null) mismatches.push('transaction_type (missing durable evidence)');
    else if (ev.transaction_type !== request.transactionType) mismatches.push('transaction_type');
    if (ev.max_energy === null) mismatches.push('max_energy (missing durable evidence)');
    else if (ev.max_energy !== String(this.policy.maxEnergy)) mismatches.push('max_energy');
    if (ev.max_fee_microccd === null) mismatches.push('max_fee_microccd (missing durable evidence)');
    else if (ev.max_fee_microccd !== request.maxFeeMicroCcd) mismatches.push('max_fee_microccd');
    if (mismatches.length > 0) {
      const reason = legacy || legacyBinding ? 'legacy_context_missing' : 'context_mismatch';
      return { outcome: 'unknown', reason, detail: `does not match: ${mismatches.join(', ')}` };
    }
    // The approval matches and is live: re-issue its certificate (same
    // authorization id — Ed25519 is deterministic, so the bytes are identical
    // to the original issuance).
    const certificate = this.issueCertificate({
      authorizationId: ev.authorization_id as string,
      paymentDigest: request.paymentDigest,
      transactionDigest: ev.transaction_digest as string,
      transactionType: ev.transaction_type as string,
      network: ev.network,
      sender: ev.sender,
      sponsor: ev.sponsor,
      recipient: ev.recipient,
      asset: ev.asset as string,
      amount: ev.amount as string,
      expiry: ev.expiry as number,
      energy: BigInt(ev.energy),
      maxFeeMicroCcd: ev.max_fee_microccd as string,
    });
    return { outcome: 'approved', reason: null, detail: 'durable approval verified against request context', certificate };
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
            // the exact transaction the approval must cover.
            transactionDigest: request.transactionDigest,
            transactionType: request.transactionType,
            maxFeeMicroCcd: request.maxFeeMicroCcd,
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
        // an approval without a certificate is unusable: the
        // signing service cannot verify what the Owner approved. Fail closed
        // here instead of letting the core reach the signer without evidence.
        // A certificate on a non-approval is dropped, never forwarded.
        if (outcome === 'approved') {
          const cert = parsed.certificate as OwnerAuthorizationCertificate | null;
          if (typeof cert !== 'object' || cert === null || Array.isArray(cert)) {
            resolve({ outcome: 'protocol_error', reason: 'missing_certificate', detail: 'Owner approved without an authorization certificate' });
            return;
          }
          resolve({
            outcome,
            reason: (parsed.reason as string | null) ?? null,
            detail: (parsed.detail as string | null) ?? null,
            certificate: cert,
          });
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

  /** Owner-mediated recovery over IPC. Read-only on the owner side. */
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
            // recovery must prove the same exact transaction.
            transactionDigest: request.transactionDigest,
            transactionType: request.transactionType,
            maxFeeMicroCcd: request.maxFeeMicroCcd,
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
        // same certificate rule as authorize: a recovered approval
        // without its certificate cannot be used for signing.
        if (outcome === 'approved') {
          const cert = parsed.certificate as OwnerAuthorizationCertificate | null;
          if (typeof cert !== 'object' || cert === null || Array.isArray(cert)) {
            resolve({ outcome: 'protocol_error', reason: 'missing_certificate', detail: 'Owner recovered an approval without an authorization certificate' });
            return;
          }
          resolve({ outcome, reason: (parsed.reason as string | null) ?? null, detail: (parsed.detail as string | null) ?? null, certificate: cert });
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
   * Read-only readiness probe (F2/F6). Asks the owner for the identity of
   * the database file it is actually using (resolved path + device + inode),
   * so the facilitator can prove the owner authorizes against a SEPARATE,
   * Owner-private file (a match with the facilitator database
   * is now a configuration error, not the expected state).
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
        if (parsed.outcome !== 'ok' || typeof parsed.dbPath !== 'string' || typeof parsed.dbDev !== 'number' || typeof parsed.dbIno !== 'number' || typeof parsed.ownerUid !== 'number') {
          resolve({ reachable: false, reason: 'unexpected db_identity response' });
          return;
        }
        resolve({ reachable: true, dbPath: parsed.dbPath, dbDev: parsed.dbDev, dbIno: parsed.dbIno, ownerUid: parsed.ownerUid });
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
  /** UID of the Owner process itself (for the distinct-UID check). */
  ownerUid?: number;
  /** Why the probe failed (unreachable only). Never contains secret material. */
  reason?: string;
}
