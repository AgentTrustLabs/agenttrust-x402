/**
 * Wallet Vault v2: encrypted seed storage + HD derivation lifecycle.
 * Separate from v1 random-key vault. No network, no IDP, no deployment.
 *
 * Plaintext payload (only in memory during unlock):
 *   seedHex (128 hex / 64 bytes), identity indices, credentials, optional object.
 * Everything persisted is AES-256-GCM ciphertext with AAD binding
 * `agenttrust|2|testnet|<walletId>`.
 */
import { validateV2WalletDescriptor, type V2Credential } from './v2DescriptorValidator.js';
import { createHdDerivationSession } from './hdDerivation.js';
import type { V2Storage, V2EncryptedRecord } from './v2Storage.js';

export const V2_KDF_ITERATIONS = 600_000;
export const V2_SALT_BYTES = 16;
export const V2_IV_BYTES = 12;
export const V2_AAD_PREFIX = 'agenttrust|2|testnet|';

interface VaultPayload {
  seedHex: string;
  identity: { idpIndex: number; identityIndex: number };
  credentials: V2Credential[];
  identityObject?: unknown;
}

export interface V2VaultOptions {
  storage: V2Storage;
  crypto: Crypto;
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  autoLockMs?: number;
}

export interface V2CreateInput {
  password: string;
  walletId: string;
  seedHex: string;
  idpIndex: number;
  identityIndex: number;
  credentials: V2Credential[];
  identityObject?: unknown;
}

export interface V2PublicView {
  walletId: string;
  credentials: { credIndex: number; publicKey: string }[];
}

const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => new Uint8Array(h.match(/.{2}/g)?.map(x => parseInt(x, 16)) ?? []);

async function deriveKek(crypto: Crypto, password: string, saltHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: V2_KDF_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function createV2Vault(opts: V2VaultOptions) {
  const { storage, crypto } = opts;
  let session: ReturnType<typeof createHdDerivationSession> | null = null;
  let activeWalletId: string | null = null;
  let activeSeed: string | null = null;
  let seedEpoch = 0;

  const aadFor = (walletId: string): Uint8Array => new TextEncoder().encode(V2_AAD_PREFIX + walletId);

  const descriptorFor = (walletId: string, payload: VaultPayload) => ({
    schemaVersion: 2,
    kind: 'v2-hd',
    network: 'testnet',
    walletId,
    seedHex: payload.seedHex,
    aad: V2_AAD_PREFIX + walletId,
    identity: payload.identity,
    credentials: payload.credentials,
    metadata: {
      walletId, schemaVersion: 2, network: 'testnet',
      identity: payload.identity, credentials: payload.credentials,
    },
  });

  const lock = (): void => { seedEpoch++; session?.lock(); session = null; activeWalletId = null; activeSeed = null; };

  const encryptPayload = async (payload: VaultPayload, password: string, walletId: string) => {
    const salt = crypto.getRandomValues(new Uint8Array(V2_SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(V2_IV_BYTES));
    const kek = await deriveKek(crypto, password, toHex(salt));
    const bytes = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor(walletId) },
      kek,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const now = opts.now();
    return {
      id: walletId, schemaVersion: 2 as const, kind: 'v2-hd' as const, network: 'testnet' as const,
      salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(new Uint8Array(bytes)),
      kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: V2_KDF_ITERATIONS },
      publicMetadata: { walletId, network: 'testnet' as const, schemaVersion: 2 as const, credentialCount: payload.credentials.length },
      createdAt: now, updatedAt: now,
    } satisfies V2EncryptedRecord;
  };

  const decryptPayload = async (record: V2EncryptedRecord, password: string): Promise<VaultPayload | null> => {
    try {
      if (record.schemaVersion !== 2 || record.kind !== 'v2-hd' || record.network !== 'testnet') return null;
      if (record.kdf?.name !== 'PBKDF2' || record.kdf.hash !== 'SHA-256' || record.kdf.iterations !== V2_KDF_ITERATIONS) return null;
      if (record.publicMetadata?.walletId !== record.id || record.publicMetadata.network !== 'testnet') return null;
      const kek = await deriveKek(crypto, password, record.salt);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromHex(record.iv), additionalData: aadFor(record.id) },
        kek,
        fromHex(record.ciphertext),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as VaultPayload;
      const validation = validateV2WalletDescriptor(descriptorFor(record.id, parsed));
      if (!validation.ok) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const createWallet = async (input: V2CreateInput): Promise<{ ok: true; walletId: string } | { ok: false; reason: string }> => {
    if (typeof input.password !== 'string' || input.password.length < 10) return { ok: false, reason: 'weak_password' };
    const payload: VaultPayload = {
      seedHex: input.seedHex,
      identity: { idpIndex: input.idpIndex, identityIndex: input.identityIndex },
      credentials: input.credentials,
      ...(input.identityObject !== undefined ? { identityObject: input.identityObject } : {}),
    };
    const validation = validateV2WalletDescriptor(descriptorFor(input.walletId, payload));
    if (!validation.ok) return { ok: false, reason: `descriptor_invalid:${validation.errors[0]?.code ?? 'unknown'}` };
    if (await storage.get(input.walletId)) return { ok: false, reason: 'wallet_exists' };
    await storage.put(await encryptPayload(payload, input.password, input.walletId));
    lock();
    return { ok: true, walletId: input.walletId };
  };

  const unlock = async (password: string, walletId: string): Promise<{ ok: true; view: V2PublicView } | { ok: false; reason: string }> => {
    lock();
    const record = await storage.get(walletId);
    if (!record) return { ok: false, reason: 'no_wallet' };
    const payload = await decryptPayload(record, password);
    if (!payload) return { ok: false, reason: 'decrypt_failed' };
    const hd = createHdDerivationSession({
      crypto, now: opts.now, setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout, autoLockMs: opts.autoLockMs,
    });
    const r = await hd.initialize({
      seedHex: payload.seedHex, walletId,
      idpIndex: payload.identity.idpIndex, identityIndex: payload.identity.identityIndex,
      credentials: payload.credentials,
    });
    if (!r.ok) { hd.lock(); return { ok: false, reason: r.reason }; }
    session = hd;
    activeWalletId = walletId;
    activeSeed = payload.seedHex;
    return { ok: true, view: { walletId, credentials: r.credentials.map(c => ({ credIndex: c.credIndex, publicKey: c.publicKey })) } };
  };

  const status = (): { state: 'locked' | 'unlocked'; walletId: string | null; credentials: V2PublicView['credentials'] } => {
    if (!session || session.status().state !== 'unlocked' || !activeWalletId) {
      return { state: 'locked', walletId: null, credentials: [] };
    }
    return { state: 'unlocked', walletId: activeWalletId, credentials: session.status().credentials };
  };

  /**
   * Operation-scoped seed use. The seed is never returned and never stored
   * outside this closure. Lock/auto-lock/delete invalidate the epoch so an
   * in-flight operation cannot finish against a dead session.
   */
  const withSeed = async <T>(operation: (seedHex: string) => T | Promise<T>): Promise<T> => {
    if (status().state !== 'unlocked' || !activeSeed) throw new Error('wallet_locked');
    const epoch = seedEpoch;
    const result = await operation(activeSeed);
    if (epoch !== seedEpoch || status().state !== 'unlocked' || !activeSeed) throw new Error('wallet_locked');
    return result;
  };

  const getSigner = (credIndex: number) => session?.getSigner(credIndex) ?? null;
  const touch = (): boolean => { if (!session) return false; const ok = session.touch(); if (ok) return true; return false; };

  const changePassword = async (walletId: string, oldPassword: string, newPassword: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (typeof newPassword !== 'string' || newPassword.length < 10) return { ok: false, reason: 'weak_password' };
    const record = await storage.get(walletId);
    if (!record) return { ok: false, reason: 'no_wallet' };
    const payload = await decryptPayload(record, oldPassword);
    if (!payload) return { ok: false, reason: 'decrypt_failed' };
    const replacement = await encryptPayload(payload, newPassword, walletId);
    await storage.put({ ...replacement, createdAt: record.createdAt });
    lock();
    return { ok: true };
  };

  const deleteWallet = async (walletId: string, confirmation: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (confirmation !== 'DELETE') return { ok: false, reason: 'confirmation_required' };
    lock();
    await storage.delete(walletId);
    return { ok: true };
  };

  const listWallets = async () => {
    const all = await storage.list();
    return all.map(r => ({ walletId: r.publicMetadata.walletId, credentialCount: r.publicMetadata.credentialCount, createdAt: r.createdAt }));
  };

  return { createWallet, unlock, lock, status, getSigner, withSeed, touch, changePassword, deleteWallet, listWallets };
}
