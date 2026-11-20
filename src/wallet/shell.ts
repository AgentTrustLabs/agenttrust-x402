/**
 * Wallet Context shell (iframe side). No key vault, no signing, no network.
 *
 * Transport is injected so the security logic is testable without a browser.
 * The shell validates: exact origin allowlist, protocol version, one-time
 * nonce, unique request id, method allowlist, payload shape, session state.
 */
import {
  parseRequest, parseResponse, isWalletMethod, WALLET_PROTOCOL_VERSION,
  type WalletRequest, type WalletResponse, type WalletMethod,
} from './protocol.js';

export interface ShellTransport {
  /** Must post to an exact targetOrigin, never '*'. */
  postMessage(message: WalletResponse, targetOrigin: string): void;
  /** Browser window; the caller wires the 'message' listener. */
  addEventListener(type: 'message', handler: (event: { origin: string; data: unknown }) => void): void;
  randomNonce(): string;
  randomId(): string;
  now(): number;
}

export interface ShellVaultBridge {
  lock(): void | Promise<void>;
  status(): { state: 'locked' | 'unlocked'; walletId?: string | null; publicKey?: string | null };
}

export interface ShellOptions {
  allowedParentOrigins: readonly string[];
  transport: ShellTransport;
  /** Optional vault bridge, wired only inside the Wallet Context. */
  vault?: ShellVaultBridge;
  /** Optional signing bridge (Wallet Context only). */
  signing?: {
    sign(request: WalletRequest, sessionId: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
    invalidate?(sessionId: string): void;
  };
}

export interface WalletStatus {
  state: 'locked' | 'unlocked';
  version: typeof WALLET_PROTOCOL_VERSION;
  methods: readonly WalletMethod[];
}

interface Session {
  id: string;
  createdAt: number;
}

export function createWalletShell(opts: ShellOptions) {
  const allowed = new Set(opts.allowedParentOrigins);
  const transport = opts.transport;
  const usedNonces = new Set<string>();
  const usedIds = new Set<string>();
  const sessions = new Map<string, Session>();
  let state: 'locked' | 'unlocked' = 'locked';
  let currentSession: Session | null = null;

  const status = (): WalletStatus => ({
    state: opts.vault ? opts.vault.status().state : state,
    version: WALLET_PROTOCOL_VERSION,
    methods: opts.signing ? ['wallet.hello', 'wallet.getStatus', 'wallet.lock', 'wallet.signTransaction'] : ['wallet.hello', 'wallet.getStatus', 'wallet.lock'],
    ...(opts.vault?.status().walletId ? { walletId: opts.vault.status().walletId } : {}),
    ...(opts.vault?.status().publicKey ? { publicKey: opts.vault.status().publicKey } : {}),
  });

  const reply = (eventOrigin: string, response: WalletResponse): void => {
    // Exact origin only. Unknown origins are dropped silently (fail closed).
    if (!allowed.has(eventOrigin)) return;
    transport.postMessage(response, eventOrigin);
  };

  const error = (eventOrigin: string, id: string, nonce: string, code: string): void => {
    reply(eventOrigin, {
      version: WALLET_PROTOCOL_VERSION, type: 'response', id, nonce, ok: false, error: code,
    });
  };

  const handle = (event: { origin: string; data: unknown }): void => {
    const origin = event.origin;
    if (!allowed.has(origin)) return; // origin validation, both directions
    const request = parseRequest(event.data);
    if (!request) {
      const raw = (event.data ?? {}) as Record<string, unknown>;
      error(origin, typeof raw['id'] === 'string' ? raw['id'] : 'invalid', typeof raw['nonce'] === 'string' ? raw['nonce'] : 'invalid', 'invalid_message');
      return;
    }
    if (usedNonces.has(request.nonce)) { error(origin, request.id, request.nonce, 'nonce_replayed'); return; }
    if (usedIds.has(request.id)) { error(origin, request.id, request.nonce, 'duplicate_request_id'); return; }
    usedNonces.add(request.nonce);
    usedIds.add(request.id);

    if (request.method === 'wallet.hello') {
      const payload = request.payload as { parentOrigin?: unknown } | undefined;
      if (!payload || payload.parentOrigin !== origin) {
        error(origin, request.id, request.nonce, 'invalid_origin');
        return;
      }
      const session: Session = { id: transport.randomId(), createdAt: transport.now() };
      sessions.set(session.id, session);
      currentSession = session;
      reply(origin, {
        version: WALLET_PROTOCOL_VERSION, type: 'response', id: request.id, nonce: request.nonce,
        sessionId: session.id, ok: true, result: { state, sessionId: session.id, methods: status().methods },
      });
      return;
    }

    if (!request.sessionId || request.sessionId !== currentSession?.id || !sessions.has(request.sessionId)) {
      error(origin, request.id, request.nonce, 'session_required');
      return;
    }

    if (request.method === 'wallet.getStatus') {
      reply(origin, {
        version: WALLET_PROTOCOL_VERSION, type: 'response', id: request.id, nonce: request.nonce,
        sessionId: request.sessionId, ok: true, result: status(),
      });
      return;
    }

    if (request.method === 'wallet.lock') {
      opts.signing?.invalidate?.(request.sessionId);
      sessions.delete(request.sessionId);
      currentSession = null;
      state = 'locked';
      // The vault's state is cleared synchronously before this reply is posted.
      void opts.vault?.lock();
      reply(origin, {
        version: WALLET_PROTOCOL_VERSION, type: 'response', id: request.id, nonce: request.nonce,
        ok: true, result: { state },
      });
      return;
    }

    if (request.method === 'wallet.signTransaction') {
      if (!opts.signing) { error(origin, request.id, request.nonce, 'invalid_method'); return; }
      void opts.signing.sign(request, request.sessionId).then((r) => {
        if (r.ok) reply(origin, { version: WALLET_PROTOCOL_VERSION, type: 'response', id: request.id, nonce: request.nonce, sessionId: request.sessionId, ok: true, result: r.result as WalletResponse['result'] });
        else error(origin, request.id, request.nonce, r.error);
      }).catch(() => error(origin, request.id, request.nonce, 'signing_failed'));
      return;
    }

    error(origin, request.id, request.nonce, 'invalid_method');
  };

  transport.addEventListener('message', handle);
  return {
    status,
    /** Test/diagnostic hook: number of consumed nonces. */
    get consumedNonces(): number { return usedNonces.size; },
    /** Test hook: drop all sessions (does not clear nonce replay memory). */
    resetSessions(): void { sessions.clear(); currentSession = null; state = 'locked'; },
  };
}

export { parseResponse, isWalletMethod };
