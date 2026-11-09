/**
 * TASK 43 — Sponsor signing service (mock-only foundation).
 *
 * A separate service that holds an injected `AccountSigner` and exposes signing over a
 * narrow IPC contract. The facilitator never sees the signer or its key material; it
 * talks to this service through `IpcAccountSigner`, which implements the SDK's
 * `AccountSigner` interface.
 *
 * Invariants:
 *   - No private key, wallet, or credential material crosses the IPC boundary.
 *   - Only the digest (32 bytes) is sent; the full transaction is NOT transmitted.
 *   - The service validates the digest, sponsor, network, and context before signing.
 *   - SO_PEERCRED authenticates the peer UID.
 *   - Replay protection via request ID (in-memory for the process lifecycle).
 *   - Fake deterministic signer for tests (no real signing).
 */

import { createServer, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AccountSigner, AccountTransactionSignature } from '@concordium/web-sdk';

// ─── protocol ─────────────────────────────────────────────────────────────

export const SIGNING_PROTOCOL_VERSION = 1;
export const SIGNING_MAX_MSG = 64 * 1024;

export interface SigningRequest {
  protocolVersion: number;
  requestId: string;
  operation: 'sign';
  digest: string; // 64-char hex (32 bytes)
  sponsor: string; // base58check sponsor address
  network: string; // CAIP-2
  context?: {
    sender?: string;
    recipient?: string;
    amount?: string;
    asset?: string;
    expiry?: number;
    energy?: string;
  };
}

export interface SigningResponse {
  protocolVersion: number;
  requestId: string;
  outcome: 'signed' | 'rejected' | 'unknown' | 'owner_unavailable' | 'protocol_error';
  signature: AccountTransactionSignature | null;
  reason: string | null;
  detail: string | null;
}

// ─── validation ────────────────────────────────────────────────────────────

const FORBIDDEN = new Set(['decision', 'approved', 'outcome', 'reason', 'result', 'signature']);
const REQ_ALLOWED = new Set(['protocolVersion', 'requestId', 'operation', 'digest', 'sponsor', 'network', 'context']);
const CTX_ALLOWED = new Set(['sender', 'recipient', 'amount', 'asset', 'expiry', 'energy']);

export function validateSigningRequest(req: unknown): { ok: true; value: SigningRequest } | { ok: false; reason: string } {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { ok: false, reason: 'malformed_request' };
  }
  const r = req as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
    if (!REQ_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
  }
  if (typeof r.protocolVersion !== 'number' || r.protocolVersion !== SIGNING_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  if (typeof r.requestId !== 'string' || r.requestId.length < 1 || r.requestId.length > 128) {
    return { ok: false, reason: 'invalid_field' };
  }
  if (r.operation !== 'sign') return { ok: false, reason: 'unknown_operation' };
  if (typeof r.digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.digest)) {
    return { ok: false, reason: 'invalid_digest' };
  }
  if (typeof r.sponsor !== 'string' || r.sponsor.length === 0) {
    return { ok: false, reason: 'invalid_sponsor' };
  }
  if (typeof r.network !== 'string' || r.network.length === 0) {
    return { ok: false, reason: 'invalid_network' };
  }
  if (r.context !== undefined) {
    if (typeof r.context !== 'object' || r.context === null || Array.isArray(r.context)) {
      return { ok: false, reason: 'malformed_request' };
    }
    const c = r.context as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (FORBIDDEN.has(k)) return { ok: false, reason: 'forbidden_field' };
      if (!CTX_ALLOWED.has(k)) return { ok: false, reason: 'malformed_request' };
    }
  }
  return { ok: true, value: r as unknown as SigningRequest };
}

// ─── fake signer ────────────────────────────────────────────────────────────

export interface FakeSignerOptions {
  /** Fixed signature hex to return (deterministic). */
  signature?: string;
  /** Behaviour override. */
  behaviour?: 'sign-ok' | 'sign-throws' | 'sign-hangs';
}

export function createFakeSigner(opts: FakeSignerOptions = {}): AccountSigner {
  const sig = opts.signature ?? 'ff'.repeat(64);
  const behaviour = opts.behaviour ?? 'sign-ok';
  return {
    async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
      if (behaviour === 'sign-throws') throw new Error('fake signer: signing refused');
      if (behaviour === 'sign-hangs') await new Promise(() => {});
      return { 0: { 0: sig } } as AccountTransactionSignature;
    },
    getSignatureCount(): bigint {
      return 1n;
    },
  };
}

// ─── service factory ────────────────────────────────────────────────────────

export interface SigningServiceOptions {
  /** The injected AccountSigner. Never constructed from key material by this service. */
  accountSigner: AccountSigner;
  /** Configured sponsor address (base58check). Must match every request's sponsor. */
  sponsorAddress: string;
  /** CAIP-2 network this service is bound to. */
  network: string;
  /** Allowed peer UID (SO_PEERCRED). */
  allowedUid: number;
  /** Peer-credential helper binary path. */
  peerCredBin?: string;
  /** Clock. */
  now?: () => number;
}

export interface SigningService {
  /** Start listening. Returns the socket path. */
  listen(socketPath: string): Promise<void>;
  /** Stop listening and clean up. */
  close(): Promise<void>;
  /** In-process sign (for tests that bypass IPC). */
  sign(request: SigningRequest): Promise<SigningResponse>;
}

export function createSigningService(opts: SigningServiceOptions): SigningService {
  const now = opts.now ?? (() => Date.now());
  const replay = new Map<string, SigningResponse>();

  const peerCredOf = (conn: Socket): { uid: number; gid: number; pid: number } | null => {
    const handle = (conn as any)._handle;
    const fd = handle?.fd;
    if (typeof fd !== 'number') return null;
    const bin = opts.peerCredBin ?? `${process.cwd()}/scripts/authz-peercred`;
    try {
      const out = execFileSync(bin, ['0'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(out.trim());
      if (typeof parsed.uid !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const doSign = async (req: SigningRequest): Promise<SigningResponse> => {
    // sponsor identity check
    if (req.sponsor !== opts.sponsorAddress) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: req.requestId, outcome: 'rejected', signature: null, reason: 'wrong_sponsor', detail: `sponsor ${req.sponsor} != configured ${opts.sponsorAddress}` };
    }
    // network check
    if (req.network !== opts.network) {
      return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: req.requestId, outcome: 'rejected', signature: null, reason: 'wrong_network', detail: `network ${req.network} != configured ${opts.network}` };
    }
    // replay protection
    const prior = replay.get(req.requestId);
    if (prior) {
      // Replayed request must return the original result.
      return { ...prior, requestId: req.requestId };
    }
    // sign
    let signature: AccountTransactionSignature;
    try {
      const digestBuffer = Buffer.from(req.digest, 'hex');
      signature = await opts.accountSigner.sign(digestBuffer);
    } catch (e) {
      const r: SigningResponse = { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: req.requestId, outcome: 'rejected', signature: null, reason: 'signer_error', detail: (e as Error).message };
      replay.set(req.requestId, r);
      return r;
    }
    const r: SigningResponse = { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: req.requestId, outcome: 'signed', signature, reason: null, detail: null };
    replay.set(req.requestId, r);
    return r;
  };

  let server: ReturnType<typeof createServer> | null = null;

  return {
    async listen(socketPath: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server = createServer((conn) => {
          let buf = '';
          let bytes = 0;
          const idleTimer = setTimeout(() => conn.destroy(), 30_000);
          conn.on('data', async (chunk) => {
            bytes += chunk.length;
            if (bytes > SIGNING_MAX_MSG) {
              conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: null, outcome: 'protocol_error', reason: 'message_too_large', signature: null, detail: null }) + '\n');
              conn.destroy();
              return;
            }
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              let req: unknown;
              try {
                req = JSON.parse(line);
              } catch {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: null, outcome: 'protocol_error', reason: 'malformed_request', signature: null, detail: null }) + '\n');
                continue;
              }
              // peer auth
              const peer = peerCredOf(conn);
              if (!peer || peer.uid !== opts.allowedUid || peer.uid === 0) {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: (req as any)?.requestId ?? null, outcome: 'protocol_error', reason: 'unauthorized_peer', signature: null, detail: null }) + '\n');
                continue;
              }
              const v = validateSigningRequest(req);
              if (!v.ok) {
                conn.write(JSON.stringify({ protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: (req as any)?.requestId ?? null, outcome: 'protocol_error', reason: v.reason, signature: null, detail: null }) + '\n');
                continue;
              }
              const r = await doSign(v.value);
              conn.write(JSON.stringify(r) + '\n');
            }
          });
          conn.on('error', () => conn.destroy());
          conn.on('close', () => clearTimeout(idleTimer));
        });
        server!.listen(socketPath, () => resolve());
        server!.on('error', reject);
      });
    },
    async close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      });
    },
    async sign(request: SigningRequest): Promise<SigningResponse> {
      // In-process path (no IPC). Reuses the same logic.
      const v = validateSigningRequest(request);
      if (!v.ok) {
        return { protocolVersion: SIGNING_PROTOCOL_VERSION, requestId: request.requestId, outcome: 'protocol_error', signature: null, reason: v.reason, detail: null };
      }
      return doSign(v.value);
    },
  };
}

// ─── IPC client (facilitator side) ─────────────────────────────────────────

export interface IpcAccountSignerOptions {
  socketPath: string;
  /** Expected signing-service UID (SO_PEERCRED). */
  expectedUid: number;
  /** Sponsor address the client expects to sign for. The SERVICE validates this against its
   *  own configured sponsor — a mismatch is rejected, so the client cannot influence policy. */
  sponsorAddress: string;
  /** CAIP-2 network the client expects. The SERVICE validates this against its own config. */
  network: string;
  /** Timeout per request (ms). */
  timeoutMs?: number;
  /** Clock. */
  now?: () => number;
}

/**
 * An `AccountSigner` that talks to the dedicated signing service over IPC.
 * Conforms to the SDK's `AccountSigner` interface so it can be injected into
 * `createSdkSponsorSigner({ accountSigner })`.
 */
export class IpcAccountSigner {
  private readonly socketPath: string;
  private readonly expectedUid: number;
  private readonly sponsorAddress: string;
  private readonly network: string;
  private readonly timeoutMs: number;

  constructor(opts: IpcAccountSignerOptions) {
    this.socketPath = opts.socketPath;
    this.expectedUid = opts.expectedUid;
    this.sponsorAddress = opts.sponsorAddress;
    this.network = opts.network;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  getSignatureCount(): bigint {
    return 1n;
  }

  async sign(digest: ArrayBuffer): Promise<AccountTransactionSignature> {
    const net = await import('node:net');
    const digestHex = Buffer.from(digest).toString('hex');
    const requestId = randomUUID();
    const request: SigningRequest = {
      protocolVersion: SIGNING_PROTOCOL_VERSION,
      requestId,
      operation: 'sign',
      digest: digestHex,
      sponsor: this.sponsorAddress,
      network: this.network,
    };
    // The service validates sponsor/network against ITS OWN configured values. A client
    // that sends a mismatched sponsor/network is rejected — the client cannot influence
    // signing policy.
    return new Promise<AccountTransactionSignature>((resolve, reject) => {
      let settled = false;
      const conn = net.createConnection(this.socketPath, () => {
        conn.write(JSON.stringify(request) + '\n');
      });
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        conn.destroy();
        reject(new Error('signing service timeout'));
      }, this.timeoutMs);
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        reject(new Error(message));
      };
      const succeed = (signature: AccountTransactionSignature): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.end();
        resolve(signature);
      };
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        let parsed: SigningResponse;
        try {
          parsed = JSON.parse(buf.slice(0, idx)) as SigningResponse;
        } catch {
          fail('malformed response from signing service');
          return;
        }
        if (parsed.requestId !== requestId) {
          fail('request ID mismatch in signing service response');
          return;
        }
        if (parsed.protocolVersion !== SIGNING_PROTOCOL_VERSION) {
          fail('unsupported protocol version in signing service response');
          return;
        }
        if (parsed.outcome !== 'signed' || !parsed.signature) {
          fail(`signing service refused: ${parsed.reason ?? parsed.outcome}`);
          return;
        }
        succeed(parsed.signature);
      });
      conn.on('error', (e) => {
        fail(`signing service unavailable: ${e.message}`);
      });
      // A service that exits mid-request closes the socket without a response. Without this
      // the caller would wait out the full timeout; either way it fails closed, but an
      // immediate, distinguishable error is what the lifecycle tests need.
      conn.on('close', () => {
        fail('signing service closed the connection before responding');
      });
    });
  }
}

/**
 * Startup reachability probe for the dedicated signing service.
 *
 * Verifies only that the Unix socket accepts a connection and can be closed again. It does
 * NOT sign, does not send a request, and does not authenticate the peer — authentication is
 * the service's job (SO_PEERCRED), and a probe that could not distinguish "listening" from
 * "accepting our UID" must not pretend to.
 *
 * Returns a reason string on failure; `null` means reachable.
 */
export async function probeSigningService(
  socketPath: string,
  timeoutMs = 5_000,
): Promise<string | null> {
  const net = await import('node:net');
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const conn = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve('signing service probe timeout');
    }, timeoutMs);
    const done = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reason);
    };
    conn.once('connect', () => done(null));
    conn.once('error', (e) => done(`signing service unreachable: ${e.message}`));
  });
}
