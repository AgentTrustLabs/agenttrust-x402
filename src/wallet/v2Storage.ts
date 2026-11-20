/** IndexedDB ciphertext-only storage for Wallet Vault v2 (separate from v1). */
export interface V2EncryptedRecord {
  id: string;
  schemaVersion: 2;
  kind: 'v2-hd';
  network: 'testnet';
  salt: string;
  iv: string;
  ciphertext: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  publicMetadata: { walletId: string; network: 'testnet'; schemaVersion: 2; credentialCount: number };
  createdAt: number;
  updatedAt: number;
}

export interface V2Storage {
  get(id: string): Promise<V2EncryptedRecord | null>;
  put(record: V2EncryptedRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<V2EncryptedRecord[]>;
}

const DB_NAME = 'agenttrust-wallet-v2-testnet';
const DB_VERSION = 1;
const STORE = 'v2-keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

export function createV2IndexedDbStorage(): V2Storage {
  return {
    async get(id) {
      const r = await tx<V2EncryptedRecord | undefined>('readonly', s => s.get(id));
      return r ?? null;
    },
    async put(record) { await tx('readwrite', s => s.put(record)); },
    async delete(id) { await tx('readwrite', s => s.delete(id)); },
    async list() { return tx<V2EncryptedRecord[]>('readonly', s => s.getAll()); },
  };
}
