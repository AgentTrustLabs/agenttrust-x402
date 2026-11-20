import { createWalletParentClient } from './wallet/parentClient.js';
/** Demo integration for embedded Wallet Context. Fail-closed and honest. */
(function () {
  const mount = document.getElementById('demo-wallet-mount');
  const status = document.getElementById('demo-wallet-status');
  const origin = window.AGENTTRUST_WALLET_ORIGIN || '';
  const set = (text) => { if (status) status.textContent = text; };
  if (!mount) return;
  if (!origin || origin.startsWith('__')) {
    set('DEMO — Wallet Context not configured. No wallet, no signing, no CCD moves. Historical settlements below are verified Testnet evidence.');
    window.__agenttrustWalletAdapter = null;
    return;
  }
  let walletOrigin;
  try { walletOrigin = new URL(origin).origin; } catch { set('DEMO — invalid Wallet Context origin.'); window.__agenttrustWalletAdapter = null; return; }
  if (walletOrigin !== origin || walletOrigin.includes('*')) { set('DEMO — invalid Wallet Context origin.'); window.__agenttrustWalletAdapter = null; return; }

  const iframe = document.createElement('iframe');
  iframe.id = 'agenttrust-wallet-context';
  iframe.title = 'AgentTrust Wallet Context';
  iframe.src = walletOrigin + '/wallet-context/';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'width:100%;height:640px;border:0;';
  mount.replaceChildren(iframe);

  const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const client = createWalletParentClient({
    walletOrigin,
    parentOrigin: location.origin,
    timeoutMs: 15000,
    transport: {
      postMessage: (message, targetOrigin) => iframe.contentWindow?.postMessage(message, targetOrigin),
      addEventListener: (type, handler) => window.addEventListener(type, handler),
      randomNonce: () => randomHex(32),
      randomId: () => randomHex(16),
      now: () => Date.now(),
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });

  const rawApiBase = window.AGENTTRUST_API_BASE_URL || '';
  const apiBase = rawApiBase.startsWith('__') ? '' : rawApiBase.replace(/\/+$/, '');
  const apiUrl = (path) => (apiBase ? apiBase + path : path);

  let pendingRef = null;
  window.__agenttrustWalletAdapter = {
    wallet: {
      sign: async (prepared) => {
        const sponsored = prepared && typeof prepared === 'object' && prepared['sponsoredTransaction']
          ? prepared['sponsoredTransaction'] : prepared;
        const r = await client.signTransaction(sponsored);
        if (!r.ok) return { ok: false, reason: r.error };
        pendingRef = prepared && typeof prepared === 'object' && typeof prepared['paymentRef'] === 'string'
          ? prepared['paymentRef'] : null;
        return { ok: true, signedTransaction: r.signedTransaction };
      },
      submit: async (_account, signedTransaction) => {
        if (!pendingRef) return { ok: false, reason: 'submission_unavailable' };
        try {
          const res = await fetch(apiUrl('/submit'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paymentRef: pendingRef, signedTransaction }),
          });
          const body = await res.json();
          if (!res.ok || !body || body.ok !== true || typeof body.txHash !== 'string') {
            return { ok: false, reason: body && body.reason ? body.reason : 'submission_failed' };
          }
          const txHash = body.txHash;
          pendingRef = null;
          return { ok: true, txHash };
        } catch { return { ok: false, reason: 'submission_unreachable' }; }
      },
    },
    resourceUrl: apiUrl('/protected'),
    prepareUrl: apiUrl('/prepare'),
    confirmUrl: apiUrl('/confirm'),
  };

  (async () => {
    try {
      if (!iframe.complete) await new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
      const hello = await client.handshake();
      const state = hello.ok ? await client.getStatus() : hello;
      set('EMBEDDED WALLET — Wallet Context loaded. Identity/signature verification status: NOT VERIFIED. Payment submission seam not available in demo; no live CCD move is claimed.');
      void state;
    } catch (e) {
      set('DEMO — Wallet Context handshake failed: ' + (e && e.message ? e.message : 'unknown'));
    }
  })();
})();
