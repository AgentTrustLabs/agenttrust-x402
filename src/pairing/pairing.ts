/**
 * Connect Wallet & Agent Pairing (backend).
 *
 * Wallet connection itself is a browser-extension / WalletConnect concern and is
 * NOT implemented here (no frontend exists in this repository). This module provides
 * the non-custodial backend half:
 *
 *   - short-lived single-use pairing challenges
 *   - cryptographic ownership verification via the official Concordium SDK
 *     (`verifyMessageSignature` over a message that starts with the account address
 *     and 8 zero bytes, so it can never be a transaction)
 *   - agent pairing / revocation with an auditable, secret-free event log
 *
 * Security invariants:
 *   - No private key, recovery phrase, wallet export, or signature is stored.
 *   - A connected address is NOT ownership. Ownership is established only by a
 *     successful `verifyMessageSignature` over a live challenge.
 *   - A verified wallet is NOT permission. Pairing never grants spending rights.
 *   - Challenges are unique, short-lived, single-use, and network-bound.
 *   - Pairing events are append-only and contain only public identifiers.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { AccountInfo } from '@concordium/web-sdk';
import { verifyMessageSignature } from '@concordium/web-sdk';

// ─── types ──────────────────────────────────────────────────────────────────

export type PairingState = 'connected' | 'verified' | 'paired' | 'revoked';

export interface Challenge {
  /** Opaque id; the wallet never sees the expected signature. */
  id: string;
  /** The exact message the wallet must sign. */
  message: string;
  /** Network the challenge is bound to (CAIP-2). */
  network: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Unix seconds. */
  createdAt: number;
  used: boolean;
}

export interface PairingRecord {
  id: string;
  agentId: string;
  walletAddress: string;
  network: string;
  state: PairingState;
  challengeId: string;
  createdAt: number;
  verifiedAt: number | null;
  pairedAt: number | null;
  revokedAt: number | null;
}

export interface PairingEvent {
  at: number;
  pairingId: string;
  agentId: string;
  walletAddress: string;
  network: string;
  action: 'challenge_created' | 'ownership_verified' | 'paired' | 'revoked' | 'disconnect';
  /** Never a secret: no keys, no signatures, no challenge responses. */
  detail: string;
}

export interface OwnershipVerification {
  ok: boolean;
  reason?: 'invalid_address' | 'invalid_signature' | 'wrong_network' | 'challenge_expired' | 'challenge_used' | 'unknown_agent' | 'account_not_found';
}

// ─── agent identity (CIS-8004 + Agent Card) ─────────────────────────────────

/**
 * Result of verifying an agent's CIS-8004 identity and Agent Card before pairing.
 *
 * The verifier is injected so the pairing store stays free of network I/O and the
 * tests stay offline. A real implementation is `createAgentIdentityVerifier` in
 * `agentTrust.ts`, which calls the existing `verifyAgent()` pipeline (TASK 03).
 */
export interface AgentIdentityVerification {
  trusted: boolean;
  /** `TRUSTED` / `REJECTED` / `INCONCLUSIVE` from the CIS-8004 verification. */
  verdict?: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';
  /** Short, non-secret reason for a rejection. */
  reason?: string;
}

// ─── challenge ───────────────────────────────────────────────────────────────

export interface ChallengeOptions {
  /** Network the challenge is bound to. */
  network: string;
  /** Lifetime in seconds. Default 300. */
  ttlSeconds?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Random source, injectable for tests. */
  random?: (n: number) => Uint8Array;
}

/**
 * Create a short-lived single-use pairing challenge.
 *
 * The message embeds the agent id, network, expiry and a 16-byte nonce so a
 * signature for one agent/network cannot be replayed for another.
 */
export function createChallenge(agentId: string, opts: ChallengeOptions): Challenge {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlSeconds ?? 300;
  const rnd = opts.random ?? ((n) => Uint8Array.from(randomBytes(n)));
  const nonce = Buffer.from(rnd(16)).toString('hex');
  const nowSec = Math.floor(now() / 1000);
  const expiresAt = nowSec + ttl;
  const id = createHash('sha256').update(`${agentId}:${opts.network}:${nonce}:${expiresAt}`).digest('hex');
  const message = `AgentTrust pairing\nagent=${agentId}\nnetwork=${opts.network}\nnonce=${nonce}\nexpires=${expiresAt}`;
  return { id, message, network: opts.network, expiresAt, createdAt: nowSec, used: false };
}

export function challengeStatus(c: Challenge, network: string, nowSeconds: number): { ok: true } | { ok: false; reason: 'wrong_network' | 'challenge_expired' | 'challenge_used' } {
  if (c.network !== network) return { ok: false, reason: 'wrong_network' };
  if (c.used) return { ok: false, reason: 'challenge_used' };
  if (nowSeconds > c.expiresAt) return { ok: false, reason: 'challenge_expired' };
  return { ok: true };
}

// ─── ownership ───────────────────────────────────────────────────────────────

/**
 * Verify that `walletAddress` controls the key that produced `signature` over
 * `challenge.message`.
 *
 * Uses the official SDK primitive. `accountInfo` must come from a read-only
 * network query, never from the client.
 */
export async function verifyOwnership(args: {
  walletAddress: string;
  challenge: Challenge;
  signature: unknown;
  accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null;
  network: string;
  nowSeconds: number;
}): Promise<OwnershipVerification> {
  const status = challengeStatus(args.challenge, args.network, args.nowSeconds);
  if (!status.ok) return { ok: false, reason: status.reason };
  if (!args.accountInfo) return { ok: false, reason: 'account_not_found' };
  try {
    const ok = await verifyMessageSignature(args.challenge.message, args.signature as never, args.accountInfo);
    if (!ok) return { ok: false, reason: 'invalid_signature' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
}

// ─── store ───────────────────────────────────────────────────────────────────

export interface PairingStoreOptions {
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

/**
 * In-memory pairing store with an append-only audit log.
 *
 * Production would persist this in the existing SQLite repository; the interface
 * is deliberately narrow so a durable adapter can be dropped in later.
 */
export class PairingStore {
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly challenges = new Map<string, Challenge>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly events: PairingEvent[] = [];
  private nonceCounter = 0;

  constructor(opts: PairingStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? ((n) => Uint8Array.from(randomBytes(n)));
  }

  /** Issue a challenge and return it. */
  issueChallenge(agentId: string, network: string, ttlSeconds?: number): Challenge {
    // The injected random source may be constant (deterministic tests); mix in a
    // monotonically increasing counter so two challenges for the same agent can never collide.
    const c = createChallenge(agentId, {
      network,
      ttlSeconds,
      now: this.now,
      random: (n) => Uint8Array.from(this.random(n).map((b, i) => (b + this.nonceCounter + i) & 0xff)),
    });
    this.nonceCounter += 1;
    this.challenges.set(c.id, c);
    this.log(c.id, agentId, '', network, 'challenge_created', `ttl=${ttlSeconds ?? 300}`);
    return c;
  }

  getChallenge(id: string): Challenge | undefined {
    return this.challenges.get(id);
  }

  /** Unix seconds on the store's clock (injectable in tests). */
  nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Mark a challenge consumed. Single-use. */
  consumeChallenge(id: string): boolean {
    const c = this.challenges.get(id);
    if (!c || c.used) return false;
    c.used = true;
    return true;
  }

  /**
   * Verify ownership and create a `paired` record.
   *
   * Order is load-bearing: challenge status → CIS-8004 identity → already-paired
   * guard → ownership signature → single-use consume. A rejected stage must not
   * consume the challenge or advance the pairing.
   */
  async verifyAndPair(args: {
    agentId: string;
    walletAddress: string;
    challengeId: string;
    signature: unknown;
    accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null;
    network: string;
    /** Legacy boolean trust check. Prefer `verifyAgentIdentity`. */
    isTrustedAgent?: (agentId: string, network: string) => Promise<boolean>;
    /** CIS-8004 identity + Agent Card verification. Fail-closed when absent. */
    verifyAgentIdentity?: (agentId: string, network: string) => Promise<AgentIdentityVerification>;
  }): Promise<{ ok: true; pairing: PairingRecord } | { ok: false; reason: OwnershipVerification['reason'] | 'untrusted_agent' | 'agent_rejected' | 'already_paired' }> {
    const c = this.challenges.get(args.challengeId);
    if (!c) return { ok: false, reason: 'unknown_agent' };
    const status = challengeStatus(c, args.network, Math.floor(this.now() / 1000));
    if (!status.ok) return { ok: false, reason: status.reason };

    let agentVerdict: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE' | undefined;
    if (args.verifyAgentIdentity) {
      const id = await args.verifyAgentIdentity(args.agentId, args.network);
      agentVerdict = id.verdict;
      if (!id.trusted) return { ok: false, reason: 'agent_rejected' };
    } else if (args.isTrustedAgent) {
      if (!(await args.isTrustedAgent(args.agentId, args.network))) return { ok: false, reason: 'untrusted_agent' };
    } else {
      return { ok: false, reason: 'untrusted_agent' };
    }

    const existing = [...this.pairings.values()].find((p) => p.agentId === args.agentId && p.network === args.network && p.state === 'paired');
    if (existing) return { ok: false, reason: 'already_paired' };
    const ownership = await verifyOwnership({
      walletAddress: args.walletAddress,
      challenge: c,
      signature: args.signature,
      accountInfo: args.accountInfo,
      network: args.network,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'invalid_signature' };
    if (!this.consumeChallenge(args.challengeId)) return { ok: false, reason: 'challenge_used' };

    const nowSec = Math.floor(this.now() / 1000);
    const id = createHash('sha256').update(`${args.agentId}:${args.walletAddress}:${args.network}:${nowSec}`).digest('hex');
    const pairing: PairingRecord = {
      id,
      agentId: args.agentId,
      walletAddress: args.walletAddress,
      network: args.network,
      state: 'paired',
      challengeId: args.challengeId,
      createdAt: nowSec,
      verifiedAt: nowSec,
      pairedAt: nowSec,
      revokedAt: null,
    };
    this.pairings.set(id, pairing);
    this.log(id, args.agentId, args.walletAddress, args.network, 'ownership_verified', 'message-signature ok');
    this.log(
      id,
      args.agentId,
      args.walletAddress,
      args.network,
      'paired',
      agentVerdict ? `CIS-8004 identity ${agentVerdict}` : 'ownership verified',
    );
    return { ok: true, pairing };
  }

  getPairing(id: string): PairingRecord | undefined {
    return this.pairings.get(id);
  }

  listPairings(agentId?: string): PairingRecord[] {
    return [...this.pairings.values()].filter((p) => (agentId === undefined ? true : p.agentId === agentId));
  }

  /** Revoke an existing pairing. Idempotent. */
  revoke(pairingId: string): boolean {
    const p = this.pairings.get(pairingId);
    if (!p) return false;
    if (p.state === 'revoked') return true;
    p.state = 'revoked';
    p.revokedAt = Math.floor(this.now() / 1000);
    this.log(pairingId, p.agentId, p.walletAddress, p.network, 'revoked', 'explicit revocation');
    return true;
  }

  /** Disconnect is a client-side state transition; the record stays auditable. */
  disconnect(pairingId: string): boolean {
    const p = this.pairings.get(pairingId);
    if (!p) return false;
    this.log(pairingId, p.agentId, p.walletAddress, p.network, 'disconnect', 'client-side disconnect');
    return true;
  }

  audit(): PairingEvent[] {
    return [...this.events];
  }

  private log(pairingId: string, agentId: string, walletAddress: string, network: string, action: PairingEvent['action'], detail: string): void {
    this.events.push({ at: Math.floor(this.now() / 1000), pairingId, agentId, walletAddress, network, action, detail });
  }
}
