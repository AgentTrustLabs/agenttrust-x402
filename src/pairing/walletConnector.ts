/**
 * Concordium wallet connector boundary.
 *
 * Thin adapter over the OFFICIAL Concordium Browser Wallet API (`window.concordium`),
 * verified against the installed `@concordium/browser-wallet-api-helpers` 3.3.0
 * type surface (`lib/wallet-api-types.d.ts`, `MainWalletApi`). No wallet API is
 * invented here: every method on `ConcordiumWalletProvider` mirrors the documented
 * surface, and the provider is always INJECTED so tests never need a browser.
 *
 * Verified API facts (browser-wallet-api-helpers 3.3.0):
 *   • `requestAccounts(): Promise<string[]>` — prompts the user; **throws** if the
 *     user rejects; may resolve with an empty list.
 *   • `connect(): Promise<string | undefined>` — deprecated alias; also **throws**
 *     on rejection. Used only as a fallback when `requestAccounts` is absent.
 *   • `getMostRecentlySelectedAccount(): Promise<string | undefined>` — resolves
 *     `undefined` when locked / no connected account. This is the only method that
 *     can resolve `undefined` without the user cancelling.
 *   • `getSelectedChain(): Promise<string | undefined>` — genesis hash of the chain
 *     selected in the wallet; `undefined` when locked or not set up. This is the
 *     network-identification primitive (CAIP-2 is the first 32 hex chars).
 *   • `signMessage(account, message): Promise<AccountTransactionSignature>` —
 *     **throws** on user rejection; the wallet prepends bytes internally so the
 *     message can never be replayed as a transaction. Returns the signature
 *     directly (credential → key → hex), NOT a `{ signature: string }` wrapper.
 *   • `sendTransaction(...)` exists but is deliberately NOT exposed: TASK 71 never
 *     constructs, signs, or broadcasts a transaction.
 *
 * Nothing here holds, requests, or transmits key material. The connector only ever
 * sees a public address, a genesis hash, and a signature over a pairing challenge.
 */

import type { AccountTransactionSignature } from '@concordium/web-sdk';

/** The subset of the official `WalletApi` this feature consumes. */
export interface ConcordiumWalletProvider {
  /** Prompt the user to connect. Throws on rejection. May resolve an empty list. */
  requestAccounts?(): Promise<string[]>;
  /** Deprecated alias for `requestAccounts`. Throws on rejection. */
  connect?(): Promise<string | undefined>;
  /** Already-authorised account, if any. Resolves `undefined` when locked. */
  getMostRecentlySelectedAccount?(): Promise<string | undefined>;
  /** Genesis hash of the chain selected in the wallet, or `undefined`. */
  getSelectedChain?(): Promise<string | undefined>;
  /** Sign a message. Throws on rejection. Returns the signature directly. */
  signMessage(account: string, message: string): Promise<AccountTransactionSignature>;
}

export type ConnectOutcome =
  | { ok: true; address: string }
  | {
      ok: false;
      reason: 'cancelled' | 'no_provider' | 'invalid_address' | 'wallet_error';
      message?: string;
    };

/** Is the official browser wallet available in this environment? */
export function detectBrowserWallet(scope: unknown = globalThis): ConcordiumWalletProvider | null {
  const s = scope as { concordium?: Partial<ConcordiumWalletProvider> } | undefined;
  const p = s?.concordium;
  if (!p || typeof p.signMessage !== 'function') return null;
  // A usable connector must offer at least one connection entry point.
  if (typeof p.requestAccounts !== 'function' && typeof p.connect !== 'function') return null;
  return p as ConcordiumWalletProvider;
}

/**
 * Normalise a connect result into an outcome.
 *
 * Cancellation is NOT an error state: the official API rejects the promise when the
 * user dismisses the prompt, so a rejection maps to `cancelled`. An empty
 * `requestAccounts()` list means the user connected no account — also `cancelled`.
 * Address shape validation is delegated to the session (`AccountAddress.fromBase58`).
 */
export async function connectWallet(provider: ConcordiumWalletProvider | null): Promise<ConnectOutcome> {
  if (!provider) return { ok: false, reason: 'no_provider' };
  try {
    if (typeof provider.requestAccounts === 'function') {
      const accounts = await provider.requestAccounts();
      if (!Array.isArray(accounts) || accounts.length === 0) return { ok: false, reason: 'cancelled' };
      const first = accounts[0];
      if (typeof first !== 'string' || first.length === 0) return { ok: false, reason: 'invalid_address' };
      return { ok: true, address: first };
    }
    const result = await provider.connect!();
    if (result === undefined || result === null || result === '') return { ok: false, reason: 'cancelled' };
    if (typeof result !== 'string') return { ok: false, reason: 'invalid_address' };
    return { ok: true, address: result };
  } catch (e) {
    // The official API rejects on user rejection; it never resolves a sentinel.
    return { ok: false, reason: 'cancelled', message: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Read the chain selected in the wallet. `undefined` (locked / not set up) is a
 * distinct outcome from a recognised or unrecognised hash.
 */
export async function getSelectedChain(
  provider: ConcordiumWalletProvider | null,
): Promise<{ ok: true; genesisHash: string | null } | { ok: false; reason: 'no_provider' | 'wallet_error'; message?: string }> {
  if (!provider || typeof provider.getSelectedChain !== 'function') return { ok: true, genesisHash: null };
  try {
    const chain = await provider.getSelectedChain();
    return { ok: true, genesisHash: typeof chain === 'string' && chain.length > 0 ? chain.toLowerCase() : null };
  } catch (e) {
    return { ok: false, reason: 'wallet_error', message: (e as Error)?.message ?? String(e) };
  }
}

/** Already-authorised account, if any. `undefined` is not an error. */
export async function getMostRecentlySelectedAccount(
  provider: ConcordiumWalletProvider | null,
): Promise<{ ok: true; address: string | null } | { ok: false; reason: 'no_provider' | 'wallet_error'; message?: string }> {
  if (!provider || typeof provider.getMostRecentlySelectedAccount !== 'function') return { ok: true, address: null };
  try {
    const address = await provider.getMostRecentlySelectedAccount();
    return { ok: true, address: typeof address === 'string' && address.length > 0 ? address : null };
  } catch (e) {
    return { ok: false, reason: 'wallet_error', message: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Sign a pairing challenge message.
 *
 * Returns the wallet's signature verbatim (the official `AccountTransactionSignature`
 * shape); verification happens against on-chain account keys in `verifyOwnership`,
 * never against wallet-supplied data. A rejection maps to `cancelled`, not to a
 * failure that could be mistaken for an invalid signature.
 */
export async function signPairingMessage(
  provider: ConcordiumWalletProvider,
  address: string,
  message: string,
): Promise<{ ok: true; signature: AccountTransactionSignature } | { ok: false; reason: 'cancelled' | 'wallet_error'; message?: string }> {
  try {
    const signature = await provider.signMessage(address, message);
    if (!signature || typeof signature !== 'object' || Object.keys(signature).length === 0) {
      return { ok: false, reason: 'cancelled' };
    }
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, reason: 'cancelled', message: (e as Error)?.message ?? String(e) };
  }
}
