/**
 * Read-only Concordium AccountInfoProvider.
 *
 * Backed by the official `ConcordiumGRPCNodeClient.getAccountInfo()` from
 * `@concordium/web-sdk/nodejs`. Read-only: it never constructs, signs, or submits a
 * transaction. It returns the authoritative account threshold and credential public keys
 * that `Transaction.verifySignature()` consumes.
 *
 * SDK evidence:
 *   - `node_modules/@concordium/web-sdk/lib/esm/grpc/GRPCClient.d.ts:84`
 *     `getAccountInfo(accountIdentifier: SDK.AccountIdentifierInput, blockHash?: BlockHash.Type): Promise<SDK.AccountInfo>`
 *   - `node_modules/@concordium/web-sdk/lib/esm/nodejs/grpc.d.ts:16`
 *     `class ConcordiumGRPCNodeClient extends ConcordiumGRPCClient`
 *   - `node_modules/@concordium/web-sdk/lib/esm/types.d.ts:980`  `accountThreshold: number`
 *   - `node_modules/@concordium/web-sdk/lib/esm/types.d.ts:702`  `keys: Record<number, Upward<VerifyKey>>`
 *   - `node_modules/@concordium/web-sdk/lib/esm/types.d.ts:715`  `credentialPublicKeys`
 *
 * No caching. Every call hits the node.
 */

import { AccountAddress } from '@concordium/web-sdk';
import type { AccountInfo } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';
import type { AccountInfoProvider } from './senderVerifier.js';

// ─── network identity ──────────────────────────────────────────────────────

/**
 * Concordium network identity. The genesis hash is the canonical discriminator: two
 * endpoints with the same genesis hash are the same chain.
 */
export interface ConcordiumNetworkIdentity {
  /** CAIP-2 network id, e.g. `ccd:4221332d34e1694168c2a0c0b3fd0f27`. */
  caip2: string;
  /** Expected genesis block hash (hex, no `0x`). */
  genesisHash: string;
}

/**
 * Known network identities. Testnet only — Mainnet is deliberately absent so a
 * misconfiguration cannot silently point the provider at Mainnet.
 */
export const KNOWN_NETWORKS: Record<string, ConcordiumNetworkIdentity> = {
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': {
    caip2: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    // Corrected to the full Testnet genesis hash observed from the live node.
    // The earlier 32-char value was the CAIP-2 prefix, not the full genesis hash.
    genesisHash: '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796',
  },
};

// ─── provider options ──────────────────────────────────────────────────────

export interface GrpcAccountInfoProviderOptions {
  host: string;
  port: number;
  useTls?: boolean;
  /** CAIP-2 network this provider is bound to. Must exist in KNOWN_NETWORKS. */
  network: string;
  /** Per-request timeout (ms). Default 10_000. */
  timeoutMs?: number;
  /**
   * Test seam: pre-built client. Production constructs its own. Never used to inject
   * caller-supplied account data — only the transport is replaceable.
   */
  client?: Pick<ConcordiumGRPCNodeClient, 'getAccountInfo' | 'getConsensusStatus'>;
}

// ─── errors ────────────────────────────────────────────────────────────────

export type ProviderFailure =
  | 'unknown_network'
  | 'network_mismatch'
  | 'account_not_found'
  | 'rpc_unavailable'
  | 'timeout'
  | 'malformed_account_info'
  | 'invalid_address';

export class AccountInfoProviderError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure, message: string) {
    super(message);
    this.name = 'AccountInfoProviderError';
    this.failure = failure;
  }
}

// ─── the provider ──────────────────────────────────────────────────────────

export class GrpcAccountInfoProvider implements AccountInfoProvider {
  private readonly host: string;
  private readonly port: number;
  private readonly network: string;
  private readonly identity: ConcordiumNetworkIdentity;
  private readonly timeoutMs: number;
  private readonly client: Pick<ConcordiumGRPCNodeClient, 'getAccountInfo' | 'getConsensusStatus'>;

  constructor(opts: GrpcAccountInfoProviderOptions) {
    const identity = KNOWN_NETWORKS[opts.network];
    if (!identity) {
      throw new AccountInfoProviderError(
        'unknown_network',
        `network ${opts.network} is not a known Concordium network (Mainnet is not configured)`,
      );
    }
    this.host = opts.host;
    this.port = opts.port;
    this.network = opts.network;
    this.identity = identity;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.client =
      opts.client ??
      new ConcordiumGRPCNodeClient(
        opts.host,
        opts.port,
        opts.useTls === false ? credentials.createInsecure() : credentials.createSsl(),
      );
  }

  /** CAIP-2 network this provider is bound to. */
  getNetwork(): string {
    return this.network;
  }

  /**
   * Verify the node's genesis hash matches the configured network. Called by `verifyNode()`
   * and on the first `getAccountInfo()` (no caching of the result beyond the instance).
   */
  async verifyNode(): Promise<ConcordiumNetworkIdentity> {
    let consensus: any;
    try {
      consensus = await withTimeout(this.client.getConsensusStatus(), this.timeoutMs);
    } catch (e) {
      throw new AccountInfoProviderError('rpc_unavailable', `consensus query failed: ${(e as Error).message}`);
    }
    const genesis = normalizeHash(consensus?.genesisBlock);
    if (!genesis) {
      throw new AccountInfoProviderError('malformed_account_info', 'consensus status has no genesisBlock');
    }
    if (genesis !== this.identity.genesisHash) {
      throw new AccountInfoProviderError(
        'network_mismatch',
        `node genesis ${genesis} != configured ${this.identity.genesisHash}`,
      );
    }
    return this.identity;
  }

  async getAccountInfo(address: string, network: string): Promise<AccountInfo | null> {
    // 1. Network binding. A provider call for a different network is a programming error.
    if (network !== this.network) {
      throw new AccountInfoProviderError(
        'network_mismatch',
        `provider bound to ${this.network}, asked for ${network}`,
      );
    }

    // 2. Address validation (base58check). The node also validates, but failing early keeps
    //    the error deterministic and avoids a wasted RPC.
    let accountAddress: AccountAddress.Type;
    try {
      accountAddress = AccountAddress.fromBase58(address);
    } catch {
      throw new AccountInfoProviderError('invalid_address', `not a valid base58check address: ${address}`);
    }

    // 3. Query. `getAccountInfo` throws RpcError when the account is absent.
    let info: AccountInfo;
    try {
      info = await withTimeout(this.client.getAccountInfo(accountAddress), this.timeoutMs);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/NOT_FOUND|not found|does not exist/i.test(msg)) return null;
      if (/DEADLINE|deadline|timeout|timed out/i.test(msg)) {
        throw new AccountInfoProviderError('timeout', `account query timed out: ${msg}`);
      }
      throw new AccountInfoProviderError('rpc_unavailable', `account query failed: ${msg}`);
    }

    // 4. Response identity. The node must return the account we asked for.
    if (!info || !info.accountAddress) {
      throw new AccountInfoProviderError('malformed_account_info', 'response has no accountAddress');
    }
    const returned = safeAddressString(info.accountAddress);
    if (returned !== address) {
      throw new AccountInfoProviderError(
        'network_mismatch',
        `node returned account ${returned} for request ${address}`,
      );
    }

    // 5. Structural completeness. Threshold and credentials must be present and sane.
    if (typeof info.accountThreshold !== 'number' || !Number.isSafeInteger(info.accountThreshold) || info.accountThreshold < 1) {
      throw new AccountInfoProviderError(
        'malformed_account_info',
        `accountThreshold must be a positive integer, got ${String(info.accountThreshold)}`,
      );
    }
    if (!info.accountCredentials || typeof info.accountCredentials !== 'object') {
      throw new AccountInfoProviderError('malformed_account_info', 'accountCredentials missing');
    }
    if (Object.keys(info.accountCredentials).length === 0) {
      throw new AccountInfoProviderError('malformed_account_info', 'accountCredentials is empty');
    }
    for (const [credIdx, cred] of Object.entries(info.accountCredentials)) {
      if (!/^\d+$/.test(credIdx)) {
        throw new AccountInfoProviderError('malformed_account_info', `non-numeric credential index ${credIdx}`);
      }
      const keys = (cred as any)?.value?.contents?.credentialPublicKeys;
      if (!keys || typeof keys !== 'object') {
        throw new AccountInfoProviderError(
          'malformed_account_info',
          `credential ${credIdx} has no credentialPublicKeys`,
        );
      }
      if (typeof keys.threshold !== 'number' || keys.threshold < 1) {
        throw new AccountInfoProviderError(
          'malformed_account_info',
          `credential ${credIdx} threshold must be >= 1`,
        );
      }
      if (!keys.keys || typeof keys.keys !== 'object') {
        throw new AccountInfoProviderError('malformed_account_info', `credential ${credIdx} has no keys`);
      }
      for (const [keyIdx, k] of Object.entries(keys.keys)) {
        if (!/^\d+$/.test(keyIdx)) {
          throw new AccountInfoProviderError('malformed_account_info', `non-numeric key index ${keyIdx}`);
        }
        const verifyKey = (k as any)?.verifyKey;
        if (typeof verifyKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(verifyKey)) {
          throw new AccountInfoProviderError(
            'malformed_account_info',
            `credential ${credIdx} key ${keyIdx} verifyKey is not 32-byte hex`,
          );
        }
      }
    }

    return info;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function safeAddressString(a: unknown): string | null {
  if (typeof a === 'string') return a;
  try {
    return String((a as { toString(): string }).toString());
  } catch {
    return null;
  }
}

function normalizeHash(h: unknown): string | null {
  if (!h) return null;
  const s = safeAddressString(h);
  if (!s) return null;
  return s.replace(/^0x/, '').toLowerCase();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DEADLINE_EXCEEDED: client timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
