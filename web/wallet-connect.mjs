/**
 * AgentTrust website — Concordium Browser Wallet connection + session.
 *
 * Real product integration, not a demo: it uses the official Concordium
 * Browser Wallet helper (`window.concordiumHelpers.detectConcordiumProvider`,
 * vendored from @concordium/browser-wallet-api-helpers 3.3.0) for provider
 * discovery and the provider's own `connect` / `requestAccounts` /
 * `getSelectedChain` / `signMessage` methods plus its `accountChanged` /
 * `accountDisconnected` / `chainChanged` events. It never reimplements the
 * wallet API, never requests private keys, and never calls `sendTransaction`
 * or any payment API.
 *
 * Flow: detect the extension → connect → selected Testnet account →
 * backend challenge → wallet signs it → the server verifies ownership
 * (`/api/verify`) → the server verifies the CIS-8004 identity and pairs
 * (`/api/pair`) → the server issues a session bearer credential → the
 * session is validated through `GET /api/session` before the UI ever shows
 * an authenticated state.
 *
 * The bearer credential lives in memory only (a closure variable). It is
 * never written to localStorage, sessionStorage, IndexedDB, a URL, a log,
 * or page markup, never persists across a page refresh, and is sent only
 * as `Authorization: Bearer …` to the configured pairing API origin.
 *
 * The pairing server binds to loopback and has no CORS, so a page hosted
 * elsewhere cannot reach it. The supported path is the local-dev workflow:
 * the pairing server serves this site at `/website/` (same origin), and
 * `apiBase` is empty there. A configured `apiBase` is an explicitly chosen
 * API origin; when it is unreachable the connection reports an honest
 * `api_unreachable` error instead of pretending to connect.
 *
 * This module is UI-agnostic: `createWalletConnection` returns the state
 * machine, and `bindWalletUI` wires it to the page's elements. Tests inject
 * a fake provider detector and a fake fetch, so no real extension is needed
 * for the unit/integration suites.
 */

// ── States ──────────────────────────────────────────────────────────────────
// unavailable: no extension detected (or the helper script is missing).
// disconnected: no wallet connected, or the connection was cleared.
// connecting: detection / connect / account / chain in progress.
// connected-unverified: wallet connected on Testnet, not yet verified.
// verifying: challenge requested, signature requested, ownership verifying.
// pairing: ownership verified, pairing + session issuance in progress.
// session-active: session validated against the server.
// session-expired / session-revoked: the server rejected the credential.
// error: a step failed; `lastError` names the reason.
export const WalletStates = Object.freeze([
  'unavailable',
  'disconnected',
  'connecting',
  'connected-unverified',
  'verifying',
  'pairing',
  'session-active',
  'session-expired',
  'session-revoked',
  'error',
]);

/** Short, secret-free error codes surfaced to the UI. */
export const WalletErrors = Object.freeze({
  HELPER_MISSING: 'helper_missing',
  WALLET_UNAVAILABLE: 'wallet_unavailable',
  CONNECTION_REJECTED: 'connection_rejected',
  NO_ACCOUNT: 'no_account',
  ACCOUNT_SELECTION_UNAVAILABLE: 'account_selection_unavailable',
  ACCOUNT_SELECTION_MISMATCH: 'account_selection_mismatch',
  WRONG_NETWORK: 'wrong_network',
  API_UNREACHABLE: 'api_unreachable',
  CHALLENGE_FAILED: 'challenge_failed',
  SIGNATURE_REJECTED: 'signature_rejected',
  OWNERSHIP_FAILED: 'ownership_failed',
  IDENTITY_NOT_TRUSTED: 'identity_not_trusted',
  PAIRING_FAILED: 'pairing_failed',
  SESSION_UNAVAILABLE: 'session_unavailable',
  SESSION_VALIDATION_FAILED: 'session_validation_failed',
  REVOKE_FAILED: 'revoke_failed',
});

function defaultDetectProvider(timeoutMs) {
  const helpers =
    typeof globalThis !== 'undefined' ? globalThis.window?.concordiumHelpers : undefined;
  if (!helpers || typeof helpers.detectConcordiumProvider !== 'function') {
    return Promise.reject(new Error(WalletErrors.HELPER_MISSING));
  }
  return helpers.detectConcordiumProvider(timeoutMs);
}


/**
 * Create a wallet connection.
 *
 * @param {object} opts
 * @param {string} [opts.apiBase=''] API origin; '' means same origin.
 * @param {function} [opts.fetchFn] fetch implementation (default: global fetch).
 * @param {function} [opts.detectProvider] provider detector (default: the official helper).
 * @param {number} [opts.timeoutMs=5000] provider-detection timeout.
 * @param {function} [opts.onStateChange] called with (state, context) on every transition.
 * @param {boolean} [opts.pairOnConnect=true] whether the full connect flow
 *        also pairs the connected account. Owner-only connections set this
 *        to false: connecting must not re-pair agent 1004 away from its
 *        provider wallet.
 */
export function createWalletConnection(opts = {}) {
  const apiBase = (opts.apiBase ?? '').replace(/\/+$/, '');
  const pairOnConnect = opts.pairOnConnect !== false;
  const fetchFn =
    opts.fetchFn ?? (typeof globalThis !== 'undefined' ? globalThis.fetch?.bind(globalThis) : undefined);
  const detectProvider =
    opts.detectProvider ?? ((timeoutMs) => defaultDetectProvider(timeoutMs));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const onStateChange = opts.onStateChange ?? (() => {});

  // ── In-memory state. The bearer credential lives ONLY here. ──────────────
  let state = 'disconnected';
  let lastError = null;
  let notice = null;
  /** @type {{ id: string; secret: string; token: string; expiresAt: number } | null} */
  let credential = null;
  /** @type {object | null} */
  let provider = null;
  /** @type {{ account: string; chain: string; agentId: string; network: string } | null} */
  let wallet = null;
  /** @type {{ id: string; walletAddress: string; agentId: string; network: string; pairingId: string; status: string; createdAt: number; expiresAt: number; remainingSeconds: number } | null} */
  let session = null;
  /**
   * Outcome of the last server-side revocation attempt for the session that
   * was just cleared: null (none attempted), 'pending', 'confirmed', or
   * 'unconfirmed'. The UI shows it so a failed revoke is never mistaken for
   * a confirmed one. It is reset when a new session is issued.
   */
  let revocation = null;
  /** @type {{ message: string; expiresAt: number } | null} */
  let challenge = null;
  const listeners = [];

  const apiUrl = (path) => (apiBase ? apiBase + path : path);

  function context() {
    return {
      state,
      lastError,
      notice,
      wallet: wallet ? { ...wallet } : null,
      session: session ? { ...session } : null,
      challenge: challenge ? { ...challenge } : null,
      revocation,
      // The credential is deliberately absent: the UI never sees it.
      hasCredential: credential !== null,
    };
  }

  function setState(next, error = null, note = null) {
    state = next;
    lastError = error;
    notice = note;
    onStateChange(state, context());
  }

  function clearCredential() {
    credential = null;
    session = null;
  }

  /** Record a revocation outcome and re-render the current state. */
  function setRevocation(value) {
    revocation = value;
    onStateChange(state, context());
  }

  /**
   * Revoke one session by its bearer token through the existing T4 endpoint.
   * The endpoint revokes only the session named by the presented credential,
   * so this can never revoke another user's session. Returns 'confirmed'
   * only when the server durably confirmed it, otherwise 'unconfirmed'.
   * Never throws; a hung request is aborted after 10 s.
   */
  async function revokeToken(token) {
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10_000)
          : undefined;
      const { status, body } = await apiJson('/api/session/revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        ...(signal ? { signal } : {}),
      });
      return status === 200 && body?.ok === true && body?.revoked === true ? 'confirmed' : 'unconfirmed';
    } catch {
      return 'unconfirmed';
    }
  }

  /**
   * Attempt the server-side revocation of a session whose local credential
   * was already cleared. Runs in the background: the caller must clear the
   * credential and set the new state first, so the UI updates immediately
   * and the wallet event is never blocked. The outcome is recorded in the
   * context (`revocation`: 'pending' → 'confirmed' | 'unconfirmed') so the
   * UI can show whether the server confirmed it.
   */
  async function revokeOldSession(token) {
    if (token === null) return;
    setRevocation('pending');
    setRevocation(await revokeToken(token));
  }

  async function api(path, init) {
    if (!fetchFn) throw new Error(WalletErrors.API_UNREACHABLE);
    let res;
    try {
      res = await fetchFn(apiUrl(path), init);
    } catch {
      throw new Error(WalletErrors.API_UNREACHABLE);
    }
    return res;
  }

  async function apiJson(path, init) {
    const res = await api(path, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  /**
   * Authenticated JSON fetch against the pairing API using the live
   * session credential. The token never leaves this closure: the caller
   * gets { status, body } and never sees the credential — the website's
   * wallet pages use this for the authenticated wallet reads
   * (GET /api/wallets, GET /api/wallet). Throws
   * Error('session_unavailable') when there is no live session, so a
   * stale page state can never silently fetch without auth. A 401 from
   * the server (expired / revoked) is returned, not thrown, so the
   * caller can render the reconnect state. The request goes to the
   * same pairing apiBase as every other session call in this module
   * (same origin in the default build).
   */
  async function authenticatedJson(path, init, timeoutMs = 10000) {
    if (!credential) throw new Error(WalletErrors.SESSION_UNAVAILABLE);
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    return apiJson(path, {
      ...(init ?? {}),
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${credential.token}` },
      ...(signal ? { signal } : {}),
    });
  }

  /** Fetch the server's public config: expected network + default agent id. */
  async function fetchConfig() {
    const { status, body } = await apiJson('/api/config');
    if (status !== 200 || !body || typeof body.network !== 'string') {
      throw new Error(WalletErrors.API_UNREACHABLE);
    }
    return body;
  }

  function expectedChainPrefix(network) {
    // The config network is a CAIP-2 id, `ccd:<first 16 bytes of the
    // genesis hash, hex>`. The wallet's `getSelectedChain()` returns the
    // full 32-byte genesis hash, so the check is a prefix match — the
    // CAIP-2 id is defined as that prefix.
    return network.startsWith('ccd:') ? network.slice(4).toLowerCase() : network.toLowerCase();
  }

  function chainMatchesExpected(chain, network) {
    if (typeof chain !== 'string' || chain.length === 0) return false;
    return chain.toLowerCase().startsWith(expectedChainPrefix(network));
  }

  /**
   * Resolve the account the wallet actually selected/authorized, NOT merely
   * the first connected account. The official Browser Wallet API exposes
   * `getMostRecentlySelectedAccount()` for exactly this; the deprecated
   * `connect()` return value is the next-best official signal. `accounts[0]`
   * is connection-list order and may be a different (e.g. provider) wallet —
   * it is never used when more than one account is connected.
   */
  async function resolveSelectedAccount(connected) {
    if (!provider) return { ok: false, reason: WalletErrors.WALLET_UNAVAILABLE };
    let accounts;
    try {
      accounts = await provider.requestAccounts();
    } catch {
      return { ok: false, reason: WalletErrors.CONNECTION_REJECTED };
    }
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') {
      return { ok: false, reason: WalletErrors.NO_ACCOUNT };
    }
    let selected = null;
    if (typeof provider.getMostRecentlySelectedAccount === 'function') {
      try {
        const s = await provider.getMostRecentlySelectedAccount();
        if (typeof s === 'string' && s.length > 0) selected = s;
      } catch {
        selected = null;
      }
    }
    if (selected === null && typeof connected === 'string' && connected.length > 0) {
      selected = connected;
    }
    if (selected === null) {
      // Unambiguous only when exactly one account is connected. Otherwise
      // fail closed rather than guessing which account the operator chose.
      if (accounts.length === 1) selected = accounts[0];
      else return { ok: false, reason: WalletErrors.ACCOUNT_SELECTION_UNAVAILABLE };
    }
    if (!accounts.includes(selected)) {
      return { ok: false, reason: WalletErrors.ACCOUNT_SELECTION_MISMATCH };
    }
    return { ok: true, account: selected, accounts };
  }

  function subscribeEvents() {
    // Idempotent: drop any listeners from a previous subscribe first.
    // A reconnect after a provider event cleared the session does not
    // unsubscribe (only disconnect()/dispose() do), so without this a
    // second connectWallet() would leave two handlers per event on the
    // same provider. Unsubscribing first keeps exactly one listener per
    // event per connection manager, and never touches the session.
    unsubscribeEvents();
    if (!provider || typeof provider.on !== 'function') return;
    const onAccountChanged = (accountAddress) => {
      void onAccountChangedAsync(accountAddress);
    };
    const onAccountDisconnected = () => {
      void onAccountDisconnectedAsync();
    };
    const onChainChanged = (chain) => {
      void onChainChangedAsync(chain);
    };
    provider.on('accountChanged', onAccountChanged);
    provider.on('accountDisconnected', onAccountDisconnected);
    provider.on('chainChanged', onChainChanged);
    listeners.push(['accountChanged', onAccountChanged]);
    listeners.push(['accountDisconnected', onAccountDisconnected]);
    listeners.push(['chainChanged', onChainChanged]);
  }

  function unsubscribeEvents() {
    // Safe to call repeatedly: with no listeners registered the loop is
    // a no-op, and a missing removeListener still clears the tracking
    // array. A throw from one removal never stops the rest.
    if (!provider || typeof provider.removeListener !== 'function') {
      listeners.length = 0;
      return;
    }
    for (const [event, fn] of listeners) {
      try {
        provider.removeListener(event, fn);
      } catch {
        /* best effort on teardown */
      }
    }
    listeners.length = 0;
  }

  async function onAccountChangedAsync(accountAddress) {
    // A new account is not the old session's account: clear it immediately,
    // require a fresh challenge and verification. Never auto-pair the new
    // account. The old session is also revoked server-side in the
    // background (revokeOldSession); the UI shows the outcome.
    const oldToken = credential?.token ?? null;
    clearCredential();
    if (typeof accountAddress === 'string' && accountAddress.length > 0) {
      wallet = wallet ? { ...wallet, account: accountAddress } : { account: accountAddress, chain: '', agentId: '', network: '' };
    }
    setState('connected-unverified', null, 'account_changed');
    void revokeOldSession(oldToken);
  }

  async function onAccountDisconnectedAsync() {
    const oldToken = credential?.token ?? null;
    clearCredential();
    setState('disconnected', null, 'wallet_disconnected');
    void revokeOldSession(oldToken);
  }

  async function onChainChangedAsync(chain) {
    // A network change invalidates the authenticated context immediately,
    // and the old session is revoked server-side in the background.
    const oldToken = credential?.token ?? null;
    clearCredential();
    if (wallet && !chainMatchesExpected(chain, wallet.network)) {
      setState('disconnected', WalletErrors.WRONG_NETWORK, 'network_changed');
      void revokeOldSession(oldToken);
      return;
    }
    setState('connected-unverified', null, 'network_changed');
    void revokeOldSession(oldToken);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Detect the extension, connect, and validate the Testnet account/chain. */
  async function connectWallet() {
    setState('connecting');
    let detected;
    try {
      detected = await detectProvider(timeoutMs);
    } catch (err) {
      if (err instanceof Error && err.message === WalletErrors.HELPER_MISSING) {
        setState('unavailable', WalletErrors.HELPER_MISSING);
      } else {
        setState('unavailable', WalletErrors.WALLET_UNAVAILABLE);
      }
      return false;
    }
    provider = detected;
    let connected;
    try {
      connected = await provider.connect();
    } catch {
      setState('disconnected', WalletErrors.CONNECTION_REJECTED);
      return false;
    }
    // `connect()` is deprecated and may return undefined even when
    // `requestAccounts()` succeeds. It is only used as a selection signal,
    // never as the sole source of truth. Do not treat undefined as rejection
    // here; resolveSelectedAccount() below requires an unambiguous account.
    const resolved = await resolveSelectedAccount(connected);
    if (!resolved.ok) {
      setState('disconnected', resolved.reason);
      return false;
    }
    const account = resolved.account;
    let chain;
    try {
      chain = await provider.getSelectedChain();
    } catch {
      setState('disconnected', WalletErrors.WALLET_UNAVAILABLE);
      return false;
    }
    let config;
    try {
      config = await fetchConfig();
    } catch (err) {
      setState('error', err instanceof Error ? err.message : WalletErrors.API_UNREACHABLE);
      return false;
    }
    if (!chainMatchesExpected(chain, config.network)) {
      setState('disconnected', WalletErrors.WRONG_NETWORK);
      return false;
    }
    wallet = {
      account,
      chain,
      agentId: typeof config.defaultAgentId === 'string' ? config.defaultAgentId : '1004',
      network: config.network,
    };
    subscribeEvents();
    setState('connected-unverified');
    return true;
  }

  /** Challenge → sign → verify ownership → pair → validate the session. */
  async function verifyAndPair() {
    if (!provider || !wallet) {
      setState('error', WalletErrors.WALLET_UNAVAILABLE);
      return false;
    }
    setState('verifying');
    let challengeRes;
    try {
      challengeRes = await apiJson('/api/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: wallet.agentId }),
      });
    } catch (err) {
      setState('error', err instanceof Error ? err.message : WalletErrors.API_UNREACHABLE);
      return false;
    }
    if (challengeRes.status !== 200 || !challengeRes.body || typeof challengeRes.body.message !== 'string') {
      setState('connected-unverified', WalletErrors.CHALLENGE_FAILED);
      return false;
    }
    challenge = { message: challengeRes.body.message, expiresAt: challengeRes.body.expiresAt };
    // The UI reads `challenge` from the context to display the purpose and
    // the wallet context while the wallet prompts for the signature.
    setState('verifying');
    let signature;
    try {
      signature = await provider.signMessage(wallet.account, challengeRes.body.message);
    } catch {
      setState('connected-unverified', WalletErrors.SIGNATURE_REJECTED);
      return false;
    }
    const verifyRes = await apiJson('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: challengeRes.body.challengeId,
        walletAddress: wallet.account,
        signature,
      }),
    });
    if (verifyRes.status !== 200 || !verifyRes.body || verifyRes.body.ok !== true) {
      setState('connected-unverified', WalletErrors.OWNERSHIP_FAILED);
      return false;
    }
    setState('pairing');
    const pairRes = await apiJson('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: wallet.agentId,
        challengeId: challengeRes.body.challengeId,
        walletAddress: wallet.account,
        signature,
      }),
    });
    if (pairRes.status !== 200 || !pairRes.body || pairRes.body.ok !== true) {
      const reason = pairRes.body?.error;
      if (reason === 'agent_rejected' || reason === 'untrusted_agent') {
        setState('connected-unverified', WalletErrors.IDENTITY_NOT_TRUSTED);
      } else {
        setState('connected-unverified', WalletErrors.PAIRING_FAILED);
      }
      return false;
    }
    if (!pairRes.body.session || typeof pairRes.body.session.secret !== 'string') {
      // Paired, but no session was issued: never show an authenticated state.
      setState('connected-unverified', WalletErrors.SESSION_UNAVAILABLE);
      return false;
    }
    credential = {
      id: pairRes.body.session.id,
      secret: pairRes.body.session.secret,
      token: `${pairRes.body.session.id}.${pairRes.body.session.secret}`,
      expiresAt: pairRes.body.session.expiresAt,
    };
    revocation = null;
    // Validate the returned session against the server before trusting it.
    const valid = await validateSession();
    if (!valid) return false;
    setState('session-active');
    return true;
  }

  /** Re-validate the current session against the server. */
  async function validateSession() {
    if (!credential) {
      setState('disconnected', WalletErrors.SESSION_UNAVAILABLE);
      return false;
    }
    const { status, body } = await apiJson('/api/session', {
      method: 'GET',
      headers: { authorization: `Bearer ${credential.token}` },
    });
    if (status === 401) {
      const err = body?.error;
      clearCredential();
      if (err === 'session_revoked') setState('session-revoked', WalletErrors.SESSION_UNAVAILABLE);
      else setState('session-expired', WalletErrors.SESSION_UNAVAILABLE);
      return false;
    }
    if (status !== 200 || !body || body.authenticated !== true || !body.session) {
      clearCredential();
      setState('error', WalletErrors.SESSION_VALIDATION_FAILED);
      return false;
    }
    const s = body.session;
    if (
      s.id !== credential.id ||
      s.walletAddress !== wallet?.account ||
      s.agentId !== wallet?.agentId ||
      s.network !== wallet?.network ||
      typeof s.expiresAt !== 'number'
    ) {
      clearCredential();
      setState('error', WalletErrors.SESSION_VALIDATION_FAILED);
      return false;
    }
    session = {
      id: s.id,
      walletAddress: s.walletAddress,
      agentId: s.agentId,
      network: s.network,
      pairingId: s.pairingId,
      status: s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      remainingSeconds: s.remainingSeconds,
    };
    return true;
  }

  /**
   * Full flow: connect the wallet, then verify and pair — unless this
   * connection is owner-only (`pairOnConnect:false`), in which case the
   * account stays `connected-unverified` and NO pairing endpoint is touched.
   */
  async function connect() {
    const okWallet = await connectWallet();
    if (!okWallet) return false;
    if (!pairOnConnect) return true;
    return verifyAndPair();
  }

  /**
   * Explicit disconnect: revoke the server session first, wait for the
   * durable response, then clear the credential and the UI state. A revoke
   * failure is reported honestly — the UI must not claim the server session
   * was revoked when it was not.
   */
  async function disconnect() {
    let revokeError = null;
    if (credential) {
      // The explicit disconnect waits for the durable server confirmation
      // before reporting success (unlike the background event revokes).
      // Show the pending revocation immediately so both buttons hide
      // while the revoke is in flight (see the button table in render).
      setRevocation('pending');
      const outcome = await revokeToken(credential.token);
      revocation = outcome;
      if (outcome !== 'confirmed') revokeError = WalletErrors.REVOKE_FAILED;
    }
    clearCredential();
    challenge = null;
    unsubscribeEvents();
    // The Browser Wallet provides no dApp disconnect method: the extension
    // itself stays connected. Only this site's session is revoked/cleared.
    if (revokeError) {
      setState('disconnected', revokeError, 'revoke_failed_local_cleared');
    } else {
      setState('disconnected');
    }
    return revokeError === null;
  }

  /** Re-check the session (expiry/revocation detection for the UI). */
  async function refreshSession() {
    if (!credential) {
      setState('disconnected', WalletErrors.SESSION_UNAVAILABLE);
      return false;
    }
    return validateSession();
  }

  /** Remove all event listeners and clear the credential. */
  function dispose() {
    unsubscribeEvents();
    clearCredential();
    provider = null;
    wallet = null;
    challenge = null;
    revocation = null;
    setState('disconnected');
  }

  function getState() {
    return state;
  }

  function getContext() {
    return context();
  }

  return {
    connect,
    connectWallet,
    verifyAndPair,
    disconnect,
    refreshSession,
    validateSession,
    authenticatedJson,
    dispose,
    getState,
    getContext,
  };
}

// ── UI binding ──────────────────────────────────────────────────────────────

/**
 * Wire a connection to the page's Connect Wallet elements.
 *
 * The state machine is the single source of truth for the whole Wallet UI:
 * every transition re-renders the status element, shows exactly one action
 * button, and calls `opts.onStateChange` so the page can sync its own
 * status/badge/fields from the same (state, context) pair. The Connect
 * button is hidden while a session is active or a flow is in progress (so
 * a second click cannot start a duplicate request); the Disconnect button
 * is shown only while a session is active (there is nothing to revoke
 * otherwise). `opts.fetchFn` / `opts.detectProvider` exist for tests.
 *
 * @param {object} els
 * @param {HTMLElement} els.connectButton the Connect Wallet button.
 * @param {HTMLElement} [els.disconnectButton] the Disconnect button.
 * @param {HTMLElement} [els.statusEl] an element that shows the state + server data.
 * @param {object} [opts]
 * @param {string} [opts.apiBase] API origin; '' means same origin.
 * @param {number} [opts.timeoutMs] provider-detection timeout.
 * @param {function} [opts.fetchFn] fetch implementation (tests).
 * @param {function} [opts.detectProvider] provider detector (tests).
 * @param {function} [opts.onStateChange] called with (state, context) on every transition.
 * @param {boolean} [opts.pairOnConnect] forwarded to createWalletConnection.
 */
/**
 * Compute the global-header wallet control view for a state + context.
 * Pure (no DOM): the page applies the returned view to the header.
 * The header is the single place for the Connect/Disconnect control; the
 * Wallet page shows session info only. The view is derived from the same
 * (state, ctx) the Wallet page reads, so the header and the page can never
 * disagree. Exactly one control is shown at a time:
 *   disconnected            'connect'   (Connect Wallet)
 *   connecting/verifying/   'loading'   (stage label, disabled)
 *   pairing
 *   session-active          'connected' (short address; Disconnect lives
 *                                        in the header popover)
 *   revocation pending      'loading'   ('Disconnecting…', disabled)
 *   revocation confirmed    'connect'   (back to Connect Wallet)
 *   revocation unconfirmed  'warning'   (warning pill; the popover offers
 *                                        a Reconnect, the only path to a
 *                                        fresh session that can be revoked)
 * The short address is the first 4 + last 4 characters, never the full
 * address, so the header fits a 390px viewport.
 */
export function headerWalletView(state, ctx) {
  const busy = state === 'connecting' || state === 'verifying' || state === 'pairing';
  const pendingRevocation = ctx.revocation === 'pending';
  const unconfirmedRevocation = state === 'disconnected' && ctx.revocation === 'unconfirmed';
  const account = ctx.wallet ? ctx.wallet.account : null;
  const network = (ctx.wallet && ctx.wallet.network) || (ctx.session && ctx.session.network) || null;
  const agentId = (ctx.wallet && ctx.wallet.agentId) || (ctx.session && ctx.session.agentId) || null;
  let control = 'connect';
  let loadingText = null;
  if (unconfirmedRevocation) {
    control = 'warning';
  } else if (pendingRevocation) {
    // A revoke in flight hides both buttons (bindWalletUI does the same),
    // even though the state is still 'session-active' until it confirms.
    control = 'loading';
    loadingText = 'Disconnecting…';
  } else if (state === 'session-active') {
    control = 'connected';
  } else if (state === 'connecting') {
    control = 'loading';
    loadingText = 'Connecting…';
  } else if (state === 'verifying') {
    control = 'loading';
    loadingText = 'Verifying…';
  } else if (state === 'pairing') {
    control = 'loading';
    loadingText = 'Pairing…';
  }
  return {
    control,
    loadingText,
    account,
    network,
    agentId,
    shortAddress: account ? `${account.slice(0, 4)}…${account.slice(-4)}` : null,
    // The popover shows the warning and the Reconnect button only in the
    // unconfirmed state. The Disconnect button itself is owned by
    // bindWalletUI (visible when session-active, visible-but-disabled
    // when unconfirmed).
    showWarning: unconfirmedRevocation,
    showReconnect: unconfirmedRevocation,
  };
}

export function bindWalletUI(els, opts = {}) {
  const { connectButton, disconnectButton, statusEl } = els;

  function render(state, ctx) {
    // Button visibility is driven by the state machine alone (one source
    // of truth). The table the page must show:
    //   disconnected            Connect visible, Disconnect hidden
    //   connecting/verifying/   both hidden (no duplicate request)
    //   pairing
    //   session-active          Connect hidden, Disconnect visible
    //   revocation pending      both hidden
    //   revocation confirmed    Connect visible, Disconnect hidden
    //   revocation unconfirmed  Connect hidden, Disconnect visible but
    //                           disabled (the credential is already
    //                           cleared, so there is nothing left to
    //                           revoke; the warning is in the status).
    // The `hidden` attribute only works because the page CSS has a
    // `[hidden] { display: none !important; }` rule — the button classes
    // set `display: inline-flex`, which otherwise overrides it.
    const busy = state === 'connecting' || state === 'verifying' || state === 'pairing';
    const pendingRevocation = ctx.revocation === 'pending';
    const unconfirmedRevocation = state === 'disconnected' && ctx.revocation === 'unconfirmed';
    if (connectButton) {
      connectButton.hidden = state === 'session-active' || busy || pendingRevocation || unconfirmedRevocation;
      connectButton.disabled = false;
    }
    if (disconnectButton) {
      disconnectButton.hidden = !((state === 'session-active' && !pendingRevocation) || unconfirmedRevocation);
      disconnectButton.disabled = unconfirmedRevocation;
    }
    if (statusEl) {
      const lines = [];
      lines.push(`Wallet: ${state}`);
      if (ctx.lastError) lines.push(`Error: ${ctx.lastError}`);
      if (ctx.notice) lines.push(`Notice: ${ctx.notice}`);
      if (ctx.wallet) {
        lines.push(`Account: ${ctx.wallet.account}`);
        lines.push(`Network: ${ctx.wallet.network}`);
        lines.push(`Agent: ${ctx.wallet.agentId}`);
      }
      if (ctx.challenge) {
        lines.push(`Challenge: ${ctx.challenge.message}`);
        lines.push(`Challenge expires: ${new Date(ctx.challenge.expiresAt * 1000).toISOString()}`);
      }
      if (ctx.session) {
        lines.push(`Pairing: ${ctx.session.pairingId}`);
        lines.push(`Session: ${ctx.session.status}`);
        lines.push(`Session expires: ${new Date(ctx.session.expiresAt * 1000).toISOString()}`);
        lines.push(`Remaining: ${ctx.session.remainingSeconds}s`);
      }
      if (ctx.revocation) {
        lines.push(`Server revocation: ${ctx.revocation}`);
      }
      if (state === 'session-active') {
        lines.push('The wallet extension stays connected; only this site\u2019s session is revoked on Disconnect.');
      }
      statusEl.textContent = lines.join('\n');
      statusEl.setAttribute('data-wallet-state', state);
    }
    if (typeof opts.onStateChange === 'function') {
      opts.onStateChange(state, ctx);
    }
  }

  const connection = createWalletConnection({
    apiBase:
      opts.apiBase ??
      (typeof globalThis !== 'undefined' ? globalThis.window?.AGENTTRUST_API_BASE_URL ?? '' : ''),
    timeoutMs: opts.timeoutMs,
    fetchFn: opts.fetchFn,
    detectProvider: opts.detectProvider,
    pairOnConnect: opts.pairOnConnect,
    onStateChange: (state, ctx) => render(state, ctx),
  });

  // The buttons hide themselves the moment a flow starts (the state
  // transitions synchronously at the start of connect/disconnect), so no
  // manual `disabled` toggling is needed here — and it must not be added,
  // because the render above owns `disabled` and a click handler's
  // `finally` would re-enable a button the state machine disabled
  // (e.g. Disconnect after an unconfirmed revocation).
  if (connectButton) {
    connectButton.addEventListener('click', async () => {
      await connection.connect();
    });
  }
  if (disconnectButton) {
    disconnectButton.addEventListener('click', async () => {
      await connection.disconnect();
    });
  }
  render(connection.getState(), connection.getContext());
  return connection;
}
