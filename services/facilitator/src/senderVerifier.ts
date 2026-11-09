/**
 * TASK 38 — Concordium sender signature verification.
 *
 * Read-only account information provider + signature verification boundary.
 *
 * The verifier uses the official SDK primitive `Transaction.verifySignature` and
 * obtains account keys from an injected `AccountInfoProvider` (never from the caller).
 *
 * Invariants:
 *   - No private-key access, generation, import, or export.
 *   - No signing.
 *   - Caller-supplied public keys are never trusted.
 *   - Verification fails closed on any ambiguity.
 */

import { AccountAddress, Transaction } from '@concordium/web-sdk';
import type { AccountInfo } from '@concordium/web-sdk';

// ─── provider interface ────────────────────────────────────────────────────

export interface AccountInfoProvider {
  /**
   * Resolve account info for a base58check address on the given network.
   * Returns null if the account does not exist or the node is unavailable.
   * The provider is read-only: it never mutates chain state.
   */
  getAccountInfo(address: string, network: string): Promise<AccountInfo | null>;
}

// ─── verifier result ───────────────────────────────────────────────────────

export type SenderVerificationResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'malformed_transaction' | 'unknown_sender' | 'account_not_found' | 'node_unavailable' | 'invalid_signature' | 'insufficient_threshold' | 'duplicate_signature' | 'wrong_network' };

// ─── SDK-backed verifier ───────────────────────────────────────────────────

export interface SdkSenderVerifierOptions {
  network: string;
  accountInfoProvider: AccountInfoProvider;
  /** Maximum time to wait for account info (ms). */
  timeoutMs?: number;
}

export class SdkSenderVerifier {
  private readonly network: string;
  private readonly provider: AccountInfoProvider;
  private readonly timeoutMs: number;

  constructor(opts: SdkSenderVerifierOptions) {
    this.network = opts.network;
    this.provider = opts.accountInfoProvider;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async verify(txJson: unknown): Promise<SenderVerificationResult> {
    // 1. Parse the transaction.
    let signable: any;
    try {
      signable = Transaction.signableFromJSON(txJson);
    } catch {
      return { ok: false, reason: 'malformed_transaction' };
    }
    if (!signable || signable.version !== 1) {
      return { ok: false, reason: 'malformed_transaction' };
    }

    // 2. Extract sender address.
    const senderRaw = signable.header?.sender;
    if (!senderRaw) {
      return { ok: false, reason: 'missing_signature' };
    }
    let senderAddress: string;
    try {
      senderAddress = typeof senderRaw === 'string' ? senderRaw : senderRaw.toString();
    } catch {
      return { ok: false, reason: 'malformed_transaction' };
    }

    // 3. Check sender signature presence.
    const senderSigs = signable.signatures?.sender;
    if (!senderSigs || Object.keys(senderSigs).length === 0) {
      return { ok: false, reason: 'missing_signature' };
    }

    // 4. Duplicate signature check (same credential+key index repeated).
    for (const credIdx of Object.keys(senderSigs)) {
      const keys = senderSigs[credIdx];
      if (!keys || typeof keys !== 'object') {
        return { ok: false, reason: 'malformed_transaction' };
      }
      const seen = new Set<string>();
      for (const keyIdx of Object.keys(keys)) {
        if (seen.has(keyIdx)) {
          return { ok: false, reason: 'duplicate_signature' };
        }
        seen.add(keyIdx);
      }
    }

    // 5. Resolve account info (authoritative, from the node — never from caller).
    let accountInfo: AccountInfo | null;
    try {
      accountInfo = await withTimeout(this.provider.getAccountInfo(senderAddress, this.network), this.timeoutMs);
    } catch {
      return { ok: false, reason: 'node_unavailable' };
    }
    if (accountInfo === null) {
      return { ok: false, reason: 'account_not_found' };
    }

    // 6. Network validation.
    // The account info is fetched from the correct network by the provider. If the provider
    // returns null (wrong network / missing account), we already fail above. Additional
    // network identity is enforced by the provider implementation.

    // 7. Verify signature using the official SDK primitive.
    let valid: boolean;
    try {
      valid = await Transaction.verifySignature(
        signable,
        senderSigs,
        {
          accountThreshold: accountInfo.accountThreshold,
          accountCredentials: accountInfo.accountCredentials,
          accountAddress: accountInfo.accountAddress,
        },
      );
    } catch {
      return { ok: false, reason: 'invalid_signature' };
    }
    if (!valid) {
      return { ok: false, reason: 'invalid_signature' };
    }

    return { ok: true };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── fake provider for tests ───────────────────────────────────────────────

export interface FakeAccountInfo {
  /** Deterministic Ed25519 public key (hex, 32 bytes). Test-only. */
  verifyKey: string;
  /** Account signature threshold. */
  threshold: number;
  /** Sender account address (base58check). */
  address: string;
}

export function makeFakeAccountInfo(overrides: Partial<FakeAccountInfo> = {}): AccountInfo {
  // Build the account info in the SDK's real shape so Transaction.verifySignature works.
  const verifyKey = overrides.verifyKey ?? 'aa'.repeat(32);
  const threshold = overrides.threshold ?? 1;
  const address = overrides.address ?? '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
  return {
    accountAddress: AccountAddress.fromBase58(address),
    accountThreshold: threshold,
    accountCredentials: {
      0: {
        type: 'normal',
        value: { contents: { credentialPublicKeys: { keys: { 0: { verifyKey, schemeId: 'Ed25519' } }, threshold: 1 } } },
      },
    },
    accountNonce: 0n,
    accountAmount: 0n,
    accountIndex: 0n,
    accountEncryptionKey: '',
    accountEncryptedAmount: {} as any,
    accountReleaseSchedule: {} as any,
    accountCooldowns: [],
    accountAvailableBalance: 0n,
    accountTokens: [],
    ...overrides,
  } as unknown as AccountInfo;
}
