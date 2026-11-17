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
 *   - `loadSponsorExportSigner` refuses to build a signer when the export's
 *     address does not match the configured sponsor — checked BEFORE the signer
 *     is built, so a mismatched export never yields a usable signer.
 *   - The facilitator / IPC client / gateway are never involved.
 */

import { readFileSync } from 'node:fs';
import { AccountAddress, parseWallet, buildAccountSigner } from '@concordium/web-sdk';
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

/** Canonical base58 of an address string, or null if malformed. */
function canonicalAddress(value: unknown): string | null {
  try {
    if (typeof value !== 'string') return null;
    return AccountAddress.toBase58(AccountAddress.fromBase58(value));
  } catch {
    return null;
  }
}

/**
 * Parse + structurally validate a wallet export. Shared by the signer loader
 * and the address reader so both see the same validated export. Throws a
 * generic `WalletExportError` on any failure; nothing from the file is logged
 * or echoed.
 */
function parseWalletExport(path: string, deps: WalletExportLoaderDeps): WalletExportFormat {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new WalletExportError('wallet export path is required');
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const parse = deps.parseWallet ?? ((raw: string) => parseWallet(raw));
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

  return exported;
}

/** Build an `AccountSigner` from an already-parsed export. */
function buildSigner(exported: WalletExportFormat, deps: WalletExportLoaderDeps): AccountSigner {
  const build = deps.buildAccountSigner ?? ((e: WalletExportFormat) => buildAccountSigner(e));
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

/**
 * Load a wallet export from `path` and return an `AccountSigner`.
 *
 * Throws `WalletExportError` on any failure. Never returns a partial signer.
 */
export function loadWalletExportSigner(path: string, deps: WalletExportLoaderDeps = {}): AccountSigner {
  return buildSigner(parseWalletExport(path, deps), deps);
}

/**
 * Read a wallet export and return its account address.
 *
 * The address is validated for shape (non-empty string) but NOT canonicalized
 * here — callers that compare addresses must canonicalize both sides. Never
 * logs the address.
 */
export function getWalletExportAddress(path: string, deps: WalletExportLoaderDeps = {}): string {
  const exported = parseWalletExport(path, deps);
  const address = (exported as { value?: { address?: unknown } }).value?.address;
  if (typeof address !== 'string' || address.length === 0) {
    throw new WalletExportError('wallet export has no address');
  }
  return address;
}

/**
 * Load a wallet export as the sponsor signer, refusing to build a signer when
 * the export's address does not match the configured sponsor.
 *
 * The check runs BEFORE the signer is built, so a mismatched export never
 * yields a usable signer. Comparison is canonical (base58 round-trip on both
 * sides). Error messages are generic and contain no address.
 *
 * Throws `WalletExportError` with one of:
 * - 'configured sponsor address is not a valid account address'
 * - 'wallet export address is not a valid account address'
 * - 'wallet export address does not match configured sponsor address'
 */
export function loadSponsorExportSigner(
  path: string,
  sponsorAddress: string,
  deps: WalletExportLoaderDeps = {},
): AccountSigner {
  const configured = canonicalAddress(sponsorAddress);
  if (configured === null) {
    throw new WalletExportError('configured sponsor address is not a valid account address');
  }
  const exported = parseWalletExport(path, deps);
  const rawAddress = (exported as { value?: { address?: unknown } }).value?.address;
  const exportAddr = canonicalAddress(rawAddress);
  if (exportAddr === null) {
    throw new WalletExportError('wallet export address is not a valid account address');
  }
  if (exportAddr !== configured) {
    throw new WalletExportError('wallet export address does not match configured sponsor address');
  }
  return buildSigner(exported, deps);
}
