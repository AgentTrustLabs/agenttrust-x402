/**
 * Agentic wallet manager.
 *
 * Provisions a dedicated, independently-controlled wallet per (owner, agent,
 * network). Owner-authorized via signed challenges. Never creates an
 * on-chain account: the wallet is provisioned with a local signing identity and
 * marked `awaiting_funding`; the on-chain account address is recorded later by
 * the owner (after credential deployment, which is out of scope for this change and
 * requires a transaction).
 *
 * Idempotent + concurrency-safe: `provision` returns the existing wallet for the
 * (owner, agent, network) tuple, and an in-flight lock prevents duplicate
 * creation under concurrent requests.
 *
 * Private keys never leave the WalletKeyStore boundary. The manager only stores
 * the public key and a reference to the signer.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { AccountInfo } from '@concordium/web-sdk';
import { verifyOwnership, type OwnershipVerification } from './pairing.js';
import { WalletStore, type WalletRecord } from './walletStore.js';
import type { WalletKeyStore, WalletSigner } from './walletSigner.js';
import { PermissionManager } from './permissions.js';
import type { PairingStore } from './pairing.js';

export interface AgenticWalletManagerOptions {
  store: WalletStore;
  keyStore: WalletKeyStore;
  permissions?: PermissionManager;
  pairingStore?: PairingStore;
  now?: () => number;
}

export interface ProvisionInput {
  ownerWalletAddress: string;
  agentId: string;
  network: string;
  genesisHash: string;
  pairingId: string; // active agent pairing that authorizes this provisioning
  challenge: { id: string; message: string; network: string; expiresAt: number; used: boolean };
  signature: unknown;
  accountInfo: Pick<AccountInfo, 'accountThreshold' | 'accountCredentials' | 'accountAddress'> | null;
}

export type ProvisionResult =
  | { ok: true; wallet: WalletRecord; created: boolean; signer: WalletSigner }
  | { ok: false; reason: string };

export class AgenticWalletManager {
  private readonly store: WalletStore;
  private readonly keyStore: WalletKeyStore;
  private readonly permissions?: PermissionManager;
  private readonly pairingStore?: PairingStore;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();

  constructor(opts: AgenticWalletManagerOptions) {
    this.store = opts.store;
    this.keyStore = opts.keyStore;
    this.permissions = opts.permissions;
    this.pairingStore = opts.pairingStore;
    this.now = opts.now ?? (() => Date.now());
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Idempotent + concurrency-safe provisioning. */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const { ownerWalletAddress, agentId, network, genesisHash } = input;
    const lockKey = `${ownerWalletAddress}|${agentId}|${network}`;
    if (this.inFlight.has(lockKey)) {
      // Concurrent request for the same tuple: wait for the in-flight one to finish,
      // then return the persisted wallet (idempotent).
      // Simple: spin until lock releases (microtask-based).
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.inFlight.has(lockKey)) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
      const existing = this.store.find(ownerWalletAddress, agentId, network);
      if (existing) {
        const signer = this.keyStore.load(existing.walletId);
        if (!signer) return { ok: false, reason: 'signing_identity_missing' };
        return { ok: true, wallet: existing, created: false, signer };
      }
      return { ok: false, reason: 'provisioning_failed' };
    }
    this.inFlight.add(lockKey);
    try {
      return await this.provisionInner(input, lockKey);
    } catch {
      return { ok: false, reason: 'storage_unavailable' };
    } finally {
      this.inFlight.delete(lockKey);
    }
  }

  private async provisionInner(input: ProvisionInput, lockKey: string): Promise<ProvisionResult> {
    const { ownerWalletAddress, agentId, network, genesisHash } = input;
    {
      // verify ownership
      if (input.challenge.network !== network) return { ok: false, reason: 'wrong_network' };
      if (input.challenge.used) return { ok: false, reason: 'challenge_used' };
      if (this.nowSec() > input.challenge.expiresAt) return { ok: false, reason: 'challenge_expired' };

      const ownership: OwnershipVerification = await verifyOwnership({
        walletAddress: ownerWalletAddress,
        challenge: input.challenge as never,
        signature: input.signature,
        accountInfo: input.accountInfo,
        network,
        nowSeconds: this.nowSec(),
      });
      if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'invalid_signature' };
      if (!this.consumeChallenge(input.challenge)) return { ok: false, reason: 'challenge_used' };

      // verify an active agent pairing exists
      if (this.pairingStore) {
        const paired = this.pairingStore.listPairings(agentId).some(
          (p) => p.walletAddress === ownerWalletAddress && p.network === network && p.state === 'paired',
        );
        if (!paired) return { ok: false, reason: 'agent_not_paired' };
      }

      // idempotency: return existing
      const existing = this.store.find(ownerWalletAddress, agentId, network);
      if (existing) {
        const signer = this.keyStore.load(existing.walletId);
        if (!signer) return { ok: false, reason: 'signing_identity_missing' };
        return { ok: true, wallet: existing, created: false, signer };
      }

      // provision
      const walletId = 'w_' + createHash('sha256').update(`${ownerWalletAddress}:${agentId}:${network}:${this.nowSec()}`).digest('hex').slice(0, 24);
      const { publicKeyHex, created } = this.keyStore.ensure(walletId);
      if (!created && this.keyStore.has(walletId)) {
        // key already existed for this id — fine, idempotent
      }
      const signer = this.keyStore.load(walletId);
      if (!signer) return { ok: false, reason: 'signing_identity_missing' };

      const now = this.nowSec();
      const wallet: WalletRecord = {
        walletId,
        agentId,
        ownerWalletAddress,
        network,
        genesisHash,
        accountAddress: null, // on-chain address recorded later (credential deployment)
        signingPublicKeyHex: publicKeyHex,
        status: 'awaiting_funding',
        fundingStatus: 'unknown',
        balanceMicroCcd: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.save(wallet, 'wallet_provisioned', `signingPublicKey=${publicKeyHex.slice(0, 12)}…`);
      return { ok: true, wallet, created: true, signer };
    }
  }

  private consumeChallenge(c: { used: boolean }): boolean {
    if (c.used) return false;
    c.used = true;
    return true;
  }

  get(walletId: string): WalletRecord | null {
    return this.store.get(walletId);
  }

  listByOwner(ownerWalletAddress: string): WalletRecord[] {
    return this.store.listByOwner(ownerWalletAddress);
  }

  listAll(): WalletRecord[] {
    return this.store.listAll();
  }

  /** Record funding observation. Does not perform any on-chain call. */
  recordFunding(walletId: string, balanceMicroCcd: bigint, accountAddress?: string): { ok: boolean; reason?: string } {
    const w = this.store.get(walletId);
    if (!w) return { ok: false, reason: 'wallet_not_found' };
    if (w.status === 'revoked') return { ok: false, reason: 'wallet_revoked' };
    if (accountAddress) w.accountAddress = accountAddress;
    const now = this.nowSec();
    w.balanceMicroCcd = balanceMicroCcd.toString();
    if (balanceMicroCcd > 0n) {
      w.fundingStatus = 'funded';
      if (w.status === 'awaiting_funding' || w.status === 'provisioned') w.status = 'active';
    } else {
      w.fundingStatus = 'unfunded';
    }
    w.updatedAt = now;
    this.store.save(w, 'funding_recorded', `balance=${balanceMicroCcd} status=${w.status}`);
    return { ok: true };
  }

  pause(walletId: string): { ok: boolean; reason?: string } {
    const w = this.store.get(walletId);
    if (!w) return { ok: false, reason: 'wallet_not_found' };
    if (w.status === 'revoked') return { ok: false, reason: 'wallet_revoked' };
    w.status = 'paused';
    w.updatedAt = this.nowSec();
    this.store.save(w, 'wallet_paused', 'paused');
    if (this.permissions) {
      this.permissions.pausePermission(w.ownerWalletAddress, w.agentId, w.network);
    }
    return { ok: true };
  }

  resume(walletId: string): { ok: boolean; reason?: string } {
    const w = this.store.get(walletId);
    if (!w) return { ok: false, reason: 'wallet_not_found' };
    if (w.status === 'revoked') return { ok: false, reason: 'wallet_revoked' };
    w.status = w.fundingStatus === 'funded' ? 'active' : 'awaiting_funding';
    w.updatedAt = this.nowSec();
    this.store.save(w, 'wallet_resumed', 'resumed');
    if (this.permissions) {
      this.permissions.resumePermission(w.ownerWalletAddress, w.agentId, w.network);
    }
    return { ok: true };
  }

  revoke(walletId: string): { ok: boolean; reason?: string } {
    const w = this.store.get(walletId);
    if (!w) return { ok: false, reason: 'wallet_not_found' };
    w.status = 'revoked';
    w.updatedAt = this.nowSec();
    this.store.save(w, 'wallet_revoked', 'revoked');
    this.keyStore.remove(walletId);
    if (this.permissions) {
      this.permissions.revokePermission(w.ownerWalletAddress, w.agentId, w.network);
      this.permissions.invalidateWallet(w.ownerWalletAddress);
    }
    return { ok: true };
  }

  /** Sign a digest only after binding checks pass. */
  signDigest(args: {
    walletId: string;
    agentId: string;
    ownerWalletAddress: string;
    network: string;
    digest: Uint8Array;
    /** Caller-asserted transaction/request parameters (for audit). */
    params: { recipient?: string; amountMicroCcd?: string; context?: string };
  }): { ok: true; signature: { 0: { 0: string } }; publicKeyHex: string } | { ok: false; reason: string } {
    const w = this.store.get(args.walletId);
    if (!w) return { ok: false, reason: 'wallet_not_found' };
    if (w.agentId !== args.agentId) return { ok: false, reason: 'agent_mismatch' };
    if (w.ownerWalletAddress !== args.ownerWalletAddress) return { ok: false, reason: 'owner_mismatch' };
    if (w.network !== args.network) return { ok: false, reason: 'wrong_network' };
    if (w.status === 'revoked') return { ok: false, reason: 'wallet_revoked' };
    if (w.status === 'paused') return { ok: false, reason: 'wallet_paused' };
    if (w.status === 'recovery_required') return { ok: false, reason: 'recovery_required' };

    // permission gate (if wired)
    if (this.permissions) {
      const r = this.permissions.isPaymentAllowed({
        walletAddress: w.ownerWalletAddress,
        agentId: args.agentId,
        network: args.network,
        recipient: args.params.recipient ?? '',
        amountMicroCcd: args.params.amountMicroCcd ?? '0',
        context: args.params.context ?? '',
      });
      if (!r.ok) return { ok: false, reason: r.reason ?? 'permission_denied' };
    }

    const signer = this.keyStore.load(args.walletId);
    if (!signer) return { ok: false, reason: 'signing_identity_missing' };
    const signature = signer.signDigest(args.digest);
    this.store.save(w, 'wallet_signed', `digest=${Buffer.from(args.digest).toString('hex').slice(0, 16)}… params=${JSON.stringify(args.params)}`);
    return { ok: true, signature, publicKeyHex: signer.publicKeyHex };
  }

  events(walletId: string, limit = 100): ReturnType<WalletStore['events']> {
    return this.store.events(walletId, limit);
  }
}

// ─── challenge helper (reuse pairing primitive shape) ──────────────────────

export function createWalletChallenge(opts: {
  ownerWalletAddress: string;
  agentId: string;
  network: string;
  action: string;
  ttlSeconds?: number;
  now?: () => number;
}): { id: string; message: string; network: string; expiresAt: number; createdAt: number; used: boolean } {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlSeconds ?? 300;
  const nonce = Buffer.from(randomBytes(16)).toString('hex');
  const nowSec = Math.floor(now() / 1000);
  const expiresAt = nowSec + ttl;
  const id = createHash('sha256').update(`${opts.ownerWalletAddress}:${opts.agentId}:${opts.network}:${opts.action}:${nonce}:${expiresAt}`).digest('hex');
  const message = `AgentTrust wallet\nowner=${opts.ownerWalletAddress}\nagent=${opts.agentId}\nnetwork=${opts.network}\naction=${opts.action}\nnonce=${nonce}\nexpires=${expiresAt}`;
  return { id, message, network: opts.network, expiresAt, createdAt: nowSec, used: false };
}
