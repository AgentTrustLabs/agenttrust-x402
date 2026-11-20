/**
 * Local encrypted key vault (Testnet only), inside the isolated Wallet Context.
 *
 * - private key is encrypted with AES-256-GCM under a KEK derived from the
 *   password with PBKDF2-SHA256 (600_000 iterations, 16-byte random salt);
 * - only ciphertext is persisted (IndexedDB in the browser, injected in tests);
 * - the active `AccountSigner` and KEK live in memory only and are cleared on
 *   lock / auto-lock / restart;
 * - no network, no broadcast, no secret in postMessage, no plaintext logging.
 *
 * LIMITATION: clearing JS variables is NOT forensic memory erasure. A memory
 * dump while unlocked can expose the key. JavaScript cannot guarantee secure
 * zeroization; use a secure element/HW wallet for higher assurance later.
 */
import { buildBasicAccountSigner, type AccountSigner } from '@concordium/web-sdk';
import { getPublicKey } from '@noble/ed25519';

export const VAULT_NETWORK = 'testnet' as const;
export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

export interface EncryptedKeyRecord {
  id: string;
  network: typeof VAULT_NETWORK;
  salt: string;
  iv: string;
  ciphertext: string;
  publicKey: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  createdAt: number;
  updatedAt: number;
}

export interface KeyVaultStorage {
  get(id: string): Promise<EncryptedKeyRecord | null>;
  put(record: EncryptedKeyRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TestKeyFixture {
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface VaultOptions {
  storage: KeyVaultStorage;
  crypto: Crypto;
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  autoLockMs?: number;
  /** TEST seam: supplies a deterministic key instead of generating one. */
  keyFixture?: TestKeyFixture;
}

export interface VaultStatus {
  state: 'locked' | 'unlocked';
  walletId: string | null;
  publicKey: string | null;
  network: typeof VAULT_NETWORK;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Uint8Array => new Uint8Array(hex.match(/.{2}/g)?.map(b => parseInt(b, 16)) ?? []);

async function deriveKek(crypto: Crypto, password: string, saltHex: string, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

function aad(walletId: string): Uint8Array {
  return new TextEncoder().encode(`${VAULT_NETWORK}|${walletId}`);
}

export function createKeyVault(opts: VaultOptions) {
  const { storage, crypto } = opts;
  const autoLockMs = opts.autoLockMs ?? 5 * 60_000;
  let record: EncryptedKeyRecord | null = null;
  let activeSigner: AccountSigner | null = null;
  let unlockedPublicKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => { if (timer) { opts.clearTimeout(timer); timer = null; } };
  const scheduleAutoLock = () => {
    clearTimer();
    timer = opts.setTimeout(() => { void lock(); }, autoLockMs);
  };

  const lock = async (): Promise<void> => {
    clearTimer();
    activeSigner = null;
    unlockedPublicKey = null;
    // KEK is a non-extractable CryptoKey held only in the local scope above;
    // after lock no code path can use it. This is NOT forensic erasure.
  };

  const status = (): VaultStatus => ({
    state: activeSigner ? 'unlocked' : 'locked',
    walletId: record?.id ?? null,
    publicKey: activeSigner ? unlockedPublicKey : null,
    network: VAULT_NETWORK,
  });

  const createWallet = async (password: string, walletId: string): Promise<{ ok: true; walletId: string } | { ok: false; reason: string }> => {
    if (typeof password !== 'string' || password.length < 10) return { ok: false, reason: 'weak_password' };
    if (!/^[0-9a-f]{32,128}$/.test(walletId)) return { ok: false, reason: 'invalid_wallet_id' };
    if (await storage.get(walletId)) return { ok: false, reason: 'wallet_exists' };
    const fixture = opts.keyFixture;
    let privateKeyHex: string; let publicKeyHex: string;
    if (fixture) {
      privateKeyHex = fixture.privateKeyHex; publicKeyHex = fixture.publicKeyHex;
    } else {
      // Local Testnet key generation. The SDK's AccountSigner is built from
      // this key; the public key is derived with the SDK's own ed25519
      // dependency (@noble/ed25519). No mnemonic backup/import in this stage.
      const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      privateKeyHex = toHex(privateKeyBytes);
      publicKeyHex = toHex(getPublicKey(privateKeyBytes));
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const kek = await deriveKek(crypto, password, toHex(salt), KDF_ITERATIONS);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(walletId) },
      kek,
      new TextEncoder().encode(privateKeyHex),
    );
    const now = opts.now();
    const created: EncryptedKeyRecord = {
      id: walletId,
      network: VAULT_NETWORK,
      salt: toHex(salt),
      iv: toHex(iv),
      ciphertext: toHex(new Uint8Array(ciphertext)),
      publicKey: publicKeyHex,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS },
      createdAt: now,
      updatedAt: now,
    };
    await storage.put(created);
    record = created;
    await lock();
    return { ok: true, walletId };
  };

  const unlock = async (password: string, walletId?: string): Promise<{ ok: true; publicKey: string } | { ok: false; reason: string }> => {
    try {
      const id = walletId ?? record?.id;
      if (!id) return { ok: false, reason: 'no_wallet' };
      const stored = await storage.get(id);
      if (!stored || stored.network !== VAULT_NETWORK) return { ok: false, reason: 'no_wallet' };
      if (stored.kdf?.name !== 'PBKDF2' || stored.kdf.hash !== 'SHA-256' || stored.kdf.iterations !== KDF_ITERATIONS) {
        return { ok: false, reason: 'unsupported_kdf' };
      }
      const kek = await deriveKek(crypto, password, stored.salt, stored.kdf.iterations);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromHex(stored.iv), additionalData: aad(stored.id) },
        kek,
        fromHex(stored.ciphertext),
      );
      const privateKeyHex = new TextDecoder().decode(plain);
      if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) return { ok: false, reason: 'decrypt_failed' };
      activeSigner = buildBasicAccountSigner(privateKeyHex);
      unlockedPublicKey = stored.publicKey;
      record = stored;
      scheduleAutoLock();
      return { ok: true, publicKey: stored.publicKey };
    } catch {
      // Always fail closed; never leak decrypt details.
      await lock();
      return { ok: false, reason: 'decrypt_failed' };
    }
  };

  const deleteWallet = async (walletId: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    await lock();
    await storage.delete(walletId);
    if (record?.id === walletId) record = null;
    return { ok: true };
  };

  /** INTERNAL ONLY: never expose through postMessage. */
  const getSigner = (): AccountSigner | null => {
    if (!activeSigner) return null;
    scheduleAutoLock(); // activity resets the inactivity timer
    return activeSigner;
  };

  return { createWallet, unlock, lock, status, deleteWallet, getSigner };
}
