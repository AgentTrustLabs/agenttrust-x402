/**
 * Agent-wallet signing boundary.
 *
 * Private keys never leave this module. The only thing callers receive is a
 * `WalletSigner` whose `signDigest` produces an Ed25519 signature; the raw key
 * material is held in memory and (in production) on a mode-0600 file under a
 * protected directory. It is never returned, logged, or serialised.
 *
 * The digest is the caller's responsibility (typically a Concordium transaction
 * digest or a message digest). This module does NOT construct, sign, or broadcast
 * a transaction — it only signs the bytes it is given, after the caller has
 * validated the binding (wallet_id, agent, owner, network, parameters).
 */

import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface WalletSigner {
  readonly walletId: string;
  readonly publicKeyHex: string;
  /** Sign a digest. Never exposes the private key. */
  signDigest(digest: Uint8Array): { 0: { 0: string } };
}

export interface WalletKeyStore {
  /** Generate (or return existing) key material for a wallet. Idempotent. */
  ensure(walletId: string): { publicKeyHex: string; created: boolean };
  /** Load a signer. Returns null if no key exists. */
  load(walletId: string): WalletSigner | null;
  /** True if key material exists. */
  has(walletId: string): boolean;
  /** Remove key material (revocation / recovery). */
  remove(walletId: string): void;
}

// ── in-memory store (tests) ─────────────────────────────────────────────────

export class InMemoryWalletKeyStore implements WalletKeyStore {
  private readonly keys = new Map<string, { publicKeyHex: string; privateKey: Buffer }>();

  ensure(walletId: string): { publicKeyHex: string; created: boolean } {
    const existing = this.keys.get(walletId);
    if (existing) return { publicKeyHex: existing.publicKeyHex, created: false };
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const publicKeyHex = Buffer.from(rawPub).toString('hex');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    this.keys.set(walletId, { publicKeyHex, privateKey: Buffer.from(privDer) });
    return { publicKeyHex, created: true };
  }

  load(walletId: string): WalletSigner | null {
    const k = this.keys.get(walletId);
    if (!k) return null;
    return makeSigner(walletId, k.publicKeyHex, k.privateKey);
  }

  has(walletId: string): boolean {
    return this.keys.has(walletId);
  }

  remove(walletId: string): void {
    this.keys.delete(walletId);
  }
}

// ── file-backed store (production-ish) ──────────────────────────────────────

export class FileWalletKeyStore implements WalletKeyStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private path(walletId: string): string {
    // walletId is validated by the caller (hex-ish). Sanitise anyway.
    const safe = walletId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (safe !== walletId || safe.length === 0) throw new Error('invalid walletId');
    return join(this.root, `${safe}.key`);
  }

  ensure(walletId: string): { publicKeyHex: string; created: boolean } {
    const p = this.path(walletId);
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { publicKeyHex: string };
      return { publicKeyHex: parsed.publicKeyHex, created: false };
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const publicKeyHex = Buffer.from(rawPub).toString('hex');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    writeFileSync(p, JSON.stringify({ publicKeyHex, privateKeyDer: privDer }), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* best effort */
    }
    return { publicKeyHex, created: true };
  }

  load(walletId: string): WalletSigner | null {
    const p = this.path(walletId);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as { publicKeyHex: string; privateKeyDer: string };
    const privDer = Buffer.from(parsed.privateKeyDer, 'base64');
    return makeSigner(walletId, parsed.publicKeyHex, privDer);
  }

  has(walletId: string): boolean {
    return existsSync(this.path(walletId));
  }

  remove(walletId: string): void {
    const p = this.path(walletId);
    if (existsSync(p)) unlinkSync(p);
  }
}

// ── shared signer factory (private key never escapes) ───────────────────────

function makeSigner(walletId: string, publicKeyHex: string, privateKeyDer: Buffer): WalletSigner {
  return {
    walletId,
    publicKeyHex,
    signDigest(digest: Uint8Array): { 0: { 0: string } } {
      const sig = edSign(null, Buffer.from(digest), { key: privateKeyDer, format: 'der', type: 'pkcs8' });
      return { 0: { 0: sig.toString('hex') } };
    },
  };
}
