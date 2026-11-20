/**
 * Wallet Context entry: v2 encrypted vault UI inside the isolated iframe.
 * Seed/password/private key/signer never leave this iframe; parent protocol
 * only exposes state/public key. No network, no IDP/node calls.
 */
import { createWalletShell } from './shell.js';
import { createV2Vault } from './v2Vault.js';
import { createV2IndexedDbStorage } from './v2Storage.js';
import { signPreparedTransaction } from './txSigning.js';
import { ConcordiumHdWallet } from '@concordium/web-sdk';
import { createIssuanceBridge } from './issuanceBridge.js';

const w = globalThis as unknown as {
  __WALLET_CONFIG__?: { allowedParentOrigins?: string[] };
  __WALLET_ISSUANCE_CONFIG__?: import('./issuanceBridge.js').IssuanceBridgeOptions['params'] & { callbackOrigin: string };
  parent: { postMessage(m: unknown, o: string): void };
  addEventListener(t: string, h: (e: unknown) => void): void;
  crypto: Crypto;
  document: Document;
  setTimeout(h: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(h: ReturnType<typeof setTimeout>): void;
  setInterval(h: () => void, ms: number): number;
  clearInterval(h: number): void;
  open(url: string, target?: string): unknown | null;
};

const allowed = w.__WALLET_CONFIG__?.allowedParentOrigins ?? [];
if (!allowed.length) throw new Error('wallet context: no allowed parent origins configured');
const doc = w.document;
const vault = createV2Vault({
  storage: createV2IndexedDbStorage(),
  crypto: w.crypto,
  now: () => Date.now(),
  setTimeout: (h, ms) => w.setTimeout(h, ms),
  clearTimeout: (h) => w.clearTimeout(h),
  autoLockMs: 5 * 60_000,
});

const issuanceConfig = w.__WALLET_ISSUANCE_CONFIG__;
const issuanceBridge = issuanceConfig ? createIssuanceBridge({ vault, callbackOrigin: issuanceConfig.callbackOrigin, params: issuanceConfig, openPopup: (url) => w.open(url, 'wallet-identity-callback') }) : null;
const issuanceResult = doc.getElementById('v2-identity-result') as HTMLPreElement | null;

interface PendingApproval { resolve: (v: boolean) => void; reject: (e: Error) => void; sessionId: string }
const approvals = new Map<string, PendingApproval>();
const approvalRoot = doc.getElementById('v2-approval') as HTMLDivElement;

const invalidateApprovals = (reason = 'wallet_locked') => {
  for (const [, p] of approvals) p.reject(new Error(reason));
  approvals.clear();
  approvalRoot.replaceChildren();
};

const requestApproval = (requestId: string, sessionId: string, details: Record<string, unknown>): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    approvals.set(requestId, { resolve, reject, sessionId });
    approvalRoot.replaceChildren();
    const box = section('Approve Testnet Transaction');
    const info = doc.createElement('pre');
    info.textContent = JSON.stringify(details, null, 2);
    const approve = button('v2-approve-btn', 'Approve');
    const rejectBtn = button('v2-reject-btn', 'Reject');
    approve.onclick = () => { approvals.delete(requestId); approvalRoot.replaceChildren(); resolve(true); };
    rejectBtn.onclick = () => { approvals.delete(requestId); approvalRoot.replaceChildren(); resolve(false); };
    box.append(info, approve, rejectBtn);
    approvalRoot.appendChild(box);
  });
};

createWalletShell({
  allowedParentOrigins: allowed,
  vault: { lock: () => { invalidateApprovals(); issuanceBridge?.lock(); return vault.lock(); }, status: () => vault.status() },
  signing: {
    sign: async (request, sessionId) => {
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      const r = await signPreparedTransaction({
        protocolVersion: String(request.version),
        network: payload.network as 'testnet',
        prepared: payload.prepared as Record<string, unknown>,
        credentialIndex: typeof payload.credentialIndex === 'number' ? payload.credentialIndex : 0,
      }, {
        status: () => vault.status(),
        getSigner: (i) => vault.getSigner(i),
        requestApproval: (details) => requestApproval(request.id, sessionId, details),
      });
      return r.ok ? { ok: true, result: r } : { ok: false, error: r.reason };
    },
    invalidate: (sessionId) => {
      for (const [id, p] of approvals) if (p.sessionId === sessionId) { p.reject(new Error('wallet_locked')); approvals.delete(id); }
      approvalRoot.replaceChildren();
    },
  },
  transport: {
    postMessage: (message, targetOrigin) => w.parent.postMessage(message, targetOrigin),
    addEventListener: (type, handler) => w.addEventListener(type, (e) => handler(e as { origin: string; data: unknown })),
    randomNonce: () => Array.from(w.crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
    randomId: () => Array.from(w.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
    now: () => Date.now(),
  },
});

const root = doc.getElementById('v2-wallet') as HTMLDivElement;
const err = doc.getElementById('v2-error') as HTMLParagraphElement;
const setText = (el: HTMLElement, text: string) => { el.textContent = text; };
const input = (id: string, type: string, placeholder = ''): HTMLInputElement => {
  const el = doc.createElement('input');
  el.id = id; el.type = type; el.placeholder = placeholder; el.autocomplete = 'off';
  return el;
};
const button = (id: string, label: string): HTMLButtonElement => {
  const el = doc.createElement('button'); el.id = id; el.type = 'button'; el.textContent = label; return el;
};
const section = (title: string): HTMLDivElement => {
  const el = doc.createElement('div'); el.className = 'v2-section';
  const h = doc.createElement('h3'); h.textContent = title; el.appendChild(h); return el;
};
const show = (nodes: Node[]) => { root.replaceChildren(...nodes); };
const showErr = (code: string) => { setText(err, code); };

let currentWalletId: string | null = null;
let activeIssuance: { sessionId: string; popup: unknown; timer: number } | null = null;
function setIssuanceStatus(status: string) {
  if (issuanceResult) issuanceResult.textContent = status;
}
function cancelActiveIssuanceUi(status: string) {
  if (!activeIssuance) { setIssuanceStatus(status); return; }
  w.clearInterval(activeIssuance.timer);
  issuanceBridge?.cancelIssuance(activeIssuance.sessionId);
  activeIssuance = null;
  setIssuanceStatus(status);
}

async function renderNoWallet() {
  currentWalletId = null;
  const box = section('Create Testnet Wallet');
  const walletId = input('v2-wallet-id', 'text', 'wallet id (64 hex)');
  const seed = input('v2-seed', 'text', 'synthetic seed 128 hex (test only)');
  const pass = input('v2-create-password', 'password', 'password');
  const confirm = input('v2-create-confirm', 'password', 'confirm password');
  const create = button('v2-create-btn', 'Create Testnet Wallet');
  create.onclick = async () => {
    showErr('');
    if (pass.value !== confirm.value) { showErr('password_mismatch'); return; }
    let verifyKey: string;
    try { verifyKey = ConcordiumHdWallet.fromHex(seed.value.trim(), 'Testnet').getAccountPublicKey(3, 0, 0).toString('hex'); }
    catch { showErr('invalid_seed'); return; }
    const r = await vault.createWallet({ password: pass.value, walletId: walletId.value.trim(), seedHex: seed.value.trim(), idpIndex: 3, identityIndex: 0, credentials: [{ credIndex: 0, publicKeys: { 0: { schemeId: 'Ed25519', verifyKey } }, threshold: 1 }] });
    if (!r.ok) { showErr(r.reason); return; }
    currentWalletId = walletId.value.trim();
    const u = await vault.unlock(pass.value, currentWalletId);
    if (!u.ok) { showErr(u.reason); await renderLocked(currentWalletId); return; }
    await renderUnlocked();
  };
  box.append(walletId, seed, pass, confirm, create);
  show([box]);
}

async function renderLocked(walletId: string | null) {
  currentWalletId = walletId;
  const box = section(walletId ? 'Testnet Wallet Locked' : 'No Testnet wallet');
  if (walletId) {
    const pass = input('v2-unlock-password', 'password', 'password');
    const unlock = button('v2-unlock-btn', 'Unlock');
    unlock.onclick = async () => {
      showErr(''); vault.touch();
      const r = await vault.unlock(pass.value, walletId);
      if (!r.ok) { showErr(r.reason === 'decrypt_failed' ? 'invalid_password' : r.reason); return; }
      await renderUnlocked();
    };
    const del = button('v2-delete-btn', 'Delete Wallet');
    const confirmInput = input('v2-delete-confirm', 'text', 'type DELETE');
    del.onclick = async () => {
      const r = await vault.deleteWallet(walletId, confirmInput.value);
      if (!r.ok) { showErr(r.reason); return; }
      await renderNoWallet();
    };
    box.append(pass, unlock, confirmInput, del);
  } else {
    const create = button('v2-goto-create', 'Create Testnet Wallet');
    create.onclick = () => renderNoWallet();
    box.append(create);
  }
  show([box]);
}

async function renderUnlocked() {
  const status = vault.status();
  if (status.state !== 'unlocked') { await renderLocked(currentWalletId); return; }
  const box = section('Status Testnet Wallet: Unlocked');
  const info = doc.createElement('pre');
  info.textContent = JSON.stringify({ walletId: status.walletId, network: 'testnet', credentials: status.credentials }, null, 2);
  const lock = button('v2-lock-btn', 'Lock');
  lock.onclick = () => { invalidateApprovals(); issuanceBridge?.lock(); cancelActiveIssuanceUi('cancelled'); vault.lock(); void renderLocked(currentWalletId); };
  const oldPass = input('v2-change-old', 'password', 'current password');
  const newPass = input('v2-change-new', 'password', 'new password');
  const confirmPass = input('v2-change-confirm', 'password', 'confirm new password');
  const change = button('v2-change-btn', 'Change Password');
  change.onclick = async () => {
    showErr(''); vault.touch();
    if (newPass.value !== confirmPass.value) { showErr('password_mismatch'); return; }
    const r = await vault.changePassword(currentWalletId!, oldPass.value, newPass.value);
    if (!r.ok) { showErr(r.reason === 'decrypt_failed' ? 'invalid_password' : r.reason); return; }
    await renderLocked(currentWalletId);
  };
  if (issuanceBridge) {
    const prep = button('v2-identity-prepare-btn', 'Prepare Testnet Identity');
    prep.onclick = async () => {
      showErr(''); vault.touch();
      if (activeIssuance) { setIssuanceStatus('waiting_for_callback'); return; }
      if (vault.status().state !== 'unlocked') { setIssuanceStatus('failed'); showErr('wallet_locked'); return; }
      setIssuanceStatus('preparing');
      const r = await issuanceBridge.prepareIssuance();
      if (!r.ok) { setIssuanceStatus('failed'); showErr(r.reason); return; }
      const opened = issuanceBridge.openCallbackPopup(r.sessionId, r.redirectUri);
      if (!opened.ok) { issuanceBridge.markPopupClosed(r.sessionId); setIssuanceStatus('failed'); showErr(opened.reason); return; }
      const popup = opened.popup as { closed?: boolean };
      const timer = w.setInterval(() => {
        if (popup.closed) {
          w.clearInterval(timer);
          if (activeIssuance?.sessionId === r.sessionId) {
            issuanceBridge.markPopupClosed(r.sessionId);
            activeIssuance = null;
            setIssuanceStatus('popup_closed');
          }
        }
      }, 250);
      activeIssuance = { sessionId: r.sessionId, popup, timer };
      setIssuanceStatus('waiting_for_callback');
    };
    const cancel = button('v2-identity-cancel-btn', 'Cancel Identity');
    cancel.onclick = () => {
      if (!activeIssuance) { setIssuanceStatus('cancelled'); return; }
      cancelActiveIssuanceUi('cancelled');
    };
    box.append(prep, cancel);
  }
  const del = button('v2-delete-unlocked-btn', 'Delete Wallet');
  const confirmInput = input('v2-delete-confirm-unlocked', 'text', 'type DELETE');
  del.onclick = async () => {
    vault.touch();
    const r = await vault.deleteWallet(currentWalletId!, confirmInput.value);
    if (!r.ok) { showErr(r.reason); return; }
    await renderNoWallet();
  };
  box.append(info, lock, oldPass, newPass, confirmPass, change, confirmInput, del);
  show([box]);
}

w.setTimeout(function poll() {
  const state = vault.status().state;
  const isUnlockedView = root.querySelector('#v2-lock-btn') !== null;
  if (state === 'locked' && isUnlockedView) { invalidateApprovals(); issuanceBridge?.lock(); cancelActiveIssuanceUi('cancelled'); void renderLocked(currentWalletId); }
  w.setTimeout(poll, 1000);
}, 1000);

// Internal callback channel: only the Wallet Context callback origin is accepted.
if (issuanceBridge) {
  w.addEventListener('message', (e) => {
    const event = e as { origin: string; data: unknown; source?: unknown };
    const r = issuanceBridge.handleCallbackMessage(event);
    if (!r.ok) { setIssuanceStatus(`failed: ${r.reason}`); return; }
    if (activeIssuance?.sessionId === r.sessionId) {
      w.clearInterval(activeIssuance.timer);
      activeIssuance = null;
    }
    setIssuanceStatus('completed');
  });
}

(async () => {
  const wallets = await vault.listWallets();
  if (wallets.length === 0) await renderNoWallet();
  else if (wallets[0]) await renderLocked(wallets[0].walletId);
  else await renderNoWallet();
})();
