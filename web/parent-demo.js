import { createWalletParentClient } from './dist/wallet/parentClient.js';

const frame = document.getElementById('wallet-frame');
const log = document.getElementById('log');
const client = createWalletParentClient({
  walletOrigin: 'http://127.0.0.1:4591',
  parentOrigin: location.origin,
  transport: {
    postMessage: (message, targetOrigin) => frame.contentWindow.postMessage(message, targetOrigin),
    addEventListener: (type, handler) => window.addEventListener(type, handler),
    randomNonce: () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
    randomId: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
    now: () => Date.now(),
    setTimeout: (h, ms) => setTimeout(h, ms),
    clearTimeout: (h) => clearTimeout(h),
  },
  timeoutMs: 5000,
});

const write = (value) => { log.textContent += JSON.stringify(value) + '\n'; };
document.getElementById('hello').onclick = async () => write(await client.handshake());
document.getElementById('status').onclick = async () => write(await client.getStatus());
document.getElementById('lock').onclick = async () => write(await client.lock());
