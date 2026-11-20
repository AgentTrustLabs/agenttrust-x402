/// <reference lib="dom" />
/**
 * IndexedDB persistence for the encrypted key vault. Ciphertext only.
 * Runs inside the isolated Wallet Context iframe; never in the parent page.
 */
import type { EncryptedKeyRecord, KeyVaultStorage } from './keyVault.js';

const DB_NAME = 'agenttrust-wallet-testnet';
const DB_VERSION = 1;
const STORE = 'encrypted-keys';

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

export function createIndexedDbKeyVaultStorage(): KeyVaultStorage {
  return {
    async get(id) {
      const record = await tx<EncryptedKeyRecord | undefined>('readonly', s => s.get(id));
      return record ?? null;
    },
    async put(record) {
      await tx('readwrite', s => s.put(record));
    },
    async delete(id) {
      await tx('readwrite', s => s.delete(id));
    },
  };
}
