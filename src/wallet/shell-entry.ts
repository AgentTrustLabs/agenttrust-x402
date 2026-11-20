/** Browser entry for the isolated Wallet Context iframe. No key vault/signing. */
import { createWalletShell } from './shell.js';

declare global {
  interface Window {
    __WALLET_CONFIG__?: { allowedParentOrigins?: string[] };
  }
}

const w = globalThis as unknown as { __WALLET_CONFIG__?: { allowedParentOrigins?: string[] }; parent: { postMessage(m: unknown, o: string): void }; addEventListener(t: string, h: (e: unknown) => void): void; crypto: { getRandomValues<T extends ArrayBufferView>(a: T): T } };
const allowed = w.__WALLET_CONFIG__?.allowedParentOrigins ?? [];
if (!allowed.length) throw new Error('wallet context: no allowed parent origins configured');

createWalletShell({
  allowedParentOrigins: allowed,
  transport: {
    postMessage: (message, targetOrigin) => w.parent.postMessage(message, targetOrigin),
    addEventListener: (type, handler) => w.addEventListener(type, (e) => handler(e as { origin: string; data: unknown })),
    randomNonce: () => Array.from(w.crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
    randomId: () => Array.from(w.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
    now: () => Date.now(),
  },
});
