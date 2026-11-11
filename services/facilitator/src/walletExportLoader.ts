/**
 * Bounded local loader for a Concordium Wallet export.
 *
 * Reads a wallet-export JSON file from an explicitly configured local path and
 * constructs an SDK `AccountSigner` using the supported SDK APIs
 * (`parseWallet` + `buildAccountSigner`). The facilitator never sees the result:
 * this module is intended to run inside the signing-service process only.
 *
 * Security invariants:
 *   - The export is read from a local file path supplied by the operator.
 *   - Nothing from the file (address, credentials, keys, signatures) is logged,
 *     returned in errors, or echoed. Error messages are generic.
 *   - A missing path, missing file, malformed export, or construction failure
 *     throws a generic `WalletExportError`. There is no fallback signer.
 *   - The facilitator / IPC client / gateway are never involved.
 */

import { readFileSync } from 'node:fs';
import { parseWallet, buildAccountSigner } from '@concordium/web-sdk';
import type { AccountSigner, WalletExportFormat } from '@concordium/web-sdk';

export class WalletExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletExportError';
  }
}

export interface WalletExportLoaderDeps {
  /** Override the file reader (tests inject a stub). */
  readFile?: (path: string) => string;
  /** Override the SDK parser (tests inject a stub). */
  parseWallet?: (raw: string) => WalletExportFormat;
  /** Override the SDK signer builder (tests inject a stub). */
  buildAccountSigner?: (exported: WalletExportFormat) => AccountSigner;
  /** Override the threshold policy. Defaults to requiring account + credential threshold 1. */
  requireThresholdOne?: boolean;
}

/**
 * Load a wallet export from `path` and return an `AccountSigner`.
 *
 * Throws `WalletExportError` on any failure. Never returns a partial signer.
 */
export function loadWalletExportSigner(path: string, deps: WalletExportLoaderDeps = {}): AccountSigner {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new WalletExportError('wallet export path is required');
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const parse = deps.parseWallet ?? ((raw: string) => parseWallet(raw));
  const build = deps.buildAccountSigner ?? ((exported: WalletExportFormat) => buildAccountSigner(exported));
  const requireOne = deps.requireThresholdOne !== false;

  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    throw new WalletExportError('wallet export file could not be read');
  }

  let exported: WalletExportFormat;
  try {
    exported = parse(raw);
  } catch {
    throw new WalletExportError('wallet export could not be parsed');
  }

  if (!exported || typeof exported !== 'object') {
    throw new WalletExportError('wallet export is not an object');
  }
  const value = (exported as { value?: unknown }).value;
  if (!value || typeof value !== 'object') {
    throw new WalletExportError('wallet export has no value');
  }
  const v = value as { address?: unknown; accountKeys?: { threshold?: unknown; keys?: unknown } };
  if (typeof v.address !== 'string' || v.address.length === 0) {
    throw new WalletExportError('wallet export has no address');
  }
  if (!v.accountKeys || typeof v.accountKeys !== 'object') {
    throw new WalletExportError('wallet export has no account keys');
  }
  const ak = v.accountKeys as { threshold?: unknown; keys?: unknown };
  if (typeof ak.threshold !== 'number' || !Number.isInteger(ak.threshold) || ak.threshold < 1) {
    throw new WalletExportError('wallet export has an invalid account threshold');
  }
  if (!ak.keys || typeof ak.keys !== 'object' || Object.keys(ak.keys).length === 0) {
    throw new WalletExportError('wallet export has no credentials');
  }
  for (const [ci, cred] of Object.entries(ak.keys as Record<string, { threshold?: unknown; keys?: unknown }>)) {
    if (!/^\d+$/.test(ci)) throw new WalletExportError('wallet export has a non-numeric credential index');
    if (!cred || typeof cred !== 'object') throw new WalletExportError('wallet export has a malformed credential');
    if (typeof cred.threshold !== 'number' || !Number.isInteger(cred.threshold) || cred.threshold < 1) {
      throw new WalletExportError('wallet export has an invalid credential threshold');
    }
    if (!cred.keys || typeof cred.keys !== 'object' || Object.keys(cred.keys).length === 0) {
      throw new WalletExportError('wallet export has a credential with no keys');
    }
  }

  if (requireOne) {
    if (ak.threshold !== 1) {
      throw new WalletExportError('wallet export account threshold must be 1 for the sponsor account');
    }
    for (const cred of Object.values(ak.keys as Record<string, { threshold: number }>)) {
      if (cred.threshold !== 1) {
        throw new WalletExportError('wallet export credential threshold must be 1 for the sponsor account');
      }
    }
  }

  let signer: AccountSigner;
  try {
    signer = build(exported);
  } catch {
    throw new WalletExportError('signer construction failed');
  }
  if (!signer || typeof signer.sign !== 'function' || typeof signer.getSignatureCount !== 'function') {
    throw new WalletExportError('signer construction failed');
  }
  return signer;
}
