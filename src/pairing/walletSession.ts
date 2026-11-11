/**
 * Wallet session state machine and permission foundation.
 *
 * The five capability levels are strictly ordered and NOT implied by each other:
 *
 *   walletConnected   → an address was reported by the wallet. Proves nothing.
 *   ownershipVerified → a live challenge message signature verified against on-chain keys.
 *   agentPaired       → the verified wallet is bound to a trusted agent.
 *   permissionGranted → an explicit operator/user grant exists (never automatic).
 *   txAuthorized      → a specific transaction was explicitly authorised (never automatic).
 *
 * Connecting a wallet grants nothing. Pairing grants nothing. Only an explicit
 * `grantPermission` call moves the fourth flag, and only an explicit
 * `authorizeTransaction` call moves the fifth. The connector never sets either
 * automatically and never signs or broadcasts anything.
 */

import { AccountAddress } from '@concordium/web-sdk';

export type WalletConnectionState = 'disconnected' | 'connected' | 'verified' | 'failed';

export interface WalletSessionSnapshot {
  state: WalletConnectionState;
  address: string | null;
  network: string | null;
  /** Last failure reason, when state === 'failed'. Never contains secrets. */
  error: string | null;
  walletConnected: boolean;
  ownershipVerified: boolean;
  agentPaired: boolean;
  permissionGranted: boolean;
  txAuthorized: boolean;
  pairingId: string | null;
  agentId: string | null;
}

/**
 * Genesis hash → CAIP-2 for the chains the Concordium browser wallet can select.
 *
 * The wallet's `getSelectedChain()` returns the FULL 64-hex genesis hash; CAIP-2 is
 * the first 32 hex chars of it. The mapping is closed on purpose: an unrecognised
 * genesis hash fails closed (`wrong_network`) instead of being accepted.
 */
export const TESTNET_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
export const MAINNET_GENESIS_HASH = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';

export const GENESIS_TO_CAIP2: Record<string, string> = {
  [TESTNET_GENESIS_HASH]: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  [MAINNET_GENESIS_HASH]: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
};

export function caip2OfGenesis(genesisHash: string | null | undefined): string | null {
  if (!genesisHash) return null;
  return GENESIS_TO_CAIP2[genesisHash.toLowerCase()] ?? null;
}

export const KNOWN_CAIP2 = new Set(Object.values(GENESIS_TO_CAIP2));

export interface PermissionGrant {
  pairingId: string;
  agentId: string;
  walletAddress: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
}

export class WalletSession {
  private state: WalletConnectionState = 'disconnected';
  private address: string | null = null;
  private network: string | null = null;
  private error: string | null = null;
  private ownershipVerified = false;
  private agentPaired = false;
  private pairingId: string | null = null;
  private agentId: string | null = null;
  private permission: PermissionGrant | null = null;
  private authorized = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Reject an address that is not a well-formed Concordium account.
   * A malformed address can never reach the `connected` state.
   */
  connect(address: unknown, network: string): { ok: true } | { ok: false; reason: 'invalid_address' | 'wrong_network' } {
    if (!KNOWN_CAIP2.has(network)) {
      this.fail('wrong_network');
      return { ok: false, reason: 'wrong_network' };
    }
    if (typeof address !== 'string') {
      this.fail('invalid_address');
      return { ok: false, reason: 'invalid_address' };
    }
    try {
      AccountAddress.fromBase58(address);
    } catch {
      this.fail('invalid_address');
      return { ok: false, reason: 'invalid_address' };
    }
    this.state = 'connected';
    this.address = address;
    this.network = network;
    this.error = null;
    // A connected address is NOT ownership.
    this.resetDerived();
    return { ok: true };
  }

  /**
   * Connect using the wallet's own chain selection (`getSelectedChain()`), which is
   * the only trustworthy network signal — an address has no network component.
   *
   * `expectedNetwork` is the network this deployment is configured for. A wallet
   * pointing at another chain is `wrong_network`, never silently accepted.
   */
  connectWithChain(
    address: unknown,
    genesisHash: string | null | undefined,
    expectedNetwork?: string,
  ): { ok: true; network: string } | { ok: false; reason: 'invalid_address' | 'wrong_network' | 'network_unknown' } {
    const network = caip2OfGenesis(genesisHash);
    if (!network) {
      this.fail('network_unknown');
      return { ok: false, reason: 'network_unknown' };
    }
    if (expectedNetwork !== undefined && network !== expectedNetwork) {
      this.fail('wrong_network');
      return { ok: false, reason: 'wrong_network' };
    }
    const r = this.connect(address, network);
    if (!r.ok) return r;
    return { ok: true, network };
  }

  /** The user dismissed the wallet prompt. Not an error. */
  cancel(): void {
    this.state = 'disconnected';
    this.address = null;
    this.network = null;
    this.error = null;
    this.resetDerived();
  }

  /** A wallet-side failure. State becomes `failed`; nothing is granted. */
  fail(reason: string): void {
    this.state = 'failed';
    this.error = reason;
    this.resetDerived();
  }

  /** Called only after `verifyOwnership` succeeded for THIS address. */
  markOwnershipVerified(): void {
    this.ownershipVerified = true;
    this.state = 'verified';
  }

  /**
   * Called only after a successful pairing against a trusted agent.
   * A no-op unless ownership was verified first — an unverified wallet can never pair.
   * A pairing belonging to a different address is also refused.
   */
  markAgentPaired(pairingId: string, agentId: string, walletAddress: string): boolean {
    if (!this.ownershipVerified || this.address === null) return false;
    if (walletAddress !== this.address) return false;
    this.agentPaired = true;
    this.pairingId = pairingId;
    this.agentId = agentId;
    return true;
  }

  /** Explicit, separate grant. Never automatic. */
  grantPermission(scopes: string[], ttlSeconds: number | null = null): { ok: boolean; reason?: string } {
    if (!this.agentPaired || this.pairingId === null || this.agentId === null || this.address === null) {
      return { ok: false, reason: 'agent_not_paired' };
    }
    if (scopes.length === 0) return { ok: false, reason: 'no_scopes' };
    const nowSec = Math.floor(this.now() / 1000);
    this.permission = {
      pairingId: this.pairingId,
      agentId: this.agentId,
      walletAddress: this.address,
      scopes: [...scopes],
      createdAt: nowSec,
      expiresAt: ttlSeconds === null ? null : nowSec + ttlSeconds,
    };
    return { ok: true };
  }

  /**
   * Explicit per-transaction authorization. The connector does not call this for any
   * real transaction; it exists so the permission model is complete and testable.
   */
  authorizeTransaction(): { ok: boolean; reason?: string } {
    const p = this.permission;
    if (!p) return { ok: false, reason: 'no_permission' };
    if (p.expiresAt !== null && Math.floor(this.now() / 1000) > p.expiresAt) {
      return { ok: false, reason: 'permission_expired' };
    }
    this.authorized = true;
    return { ok: true };
  }

  revokePermission(): void {
    this.permission = null;
    this.authorized = false;
  }

  /**
   * Unlink the agent while the wallet stays connected and verified.
   * Only the pairing binding and everything derived from it is dropped.
   */
  unlinkAgent(): void {
    this.agentPaired = false;
    this.pairingId = null;
    this.agentId = null;
    this.permission = null;
    this.authorized = false;
  }

  /** Wallet disconnect: drops every capability, including the address. */
  disconnect(): void {
    this.state = 'disconnected';
    this.address = null;
    this.network = null;
    this.error = null;
    this.ownershipVerified = false;
    this.resetDerived();
  }

  getPermission(): PermissionGrant | null {
    return this.permission;
  }

  snapshot(): WalletSessionSnapshot {
    return {
      state: this.state,
      address: this.address,
      network: this.network,
      error: this.error,
      walletConnected: this.state === 'connected' || this.state === 'verified',
      ownershipVerified: this.ownershipVerified,
      agentPaired: this.agentPaired,
      permissionGranted: this.permission !== null,
      txAuthorized: this.authorized,
      pairingId: this.pairingId,
      agentId: this.agentId,
    };
  }

  /** Drop every capability derived from ownership. Keeps address/network/state. */
  private resetDerived(): void {
    this.ownershipVerified = false;
    this.agentPaired = false;
    this.pairingId = null;
    this.agentId = null;
    this.permission = null;
    this.authorized = false;
  }
}
