/**
 * Parent-side Wallet Context client. Validates exact wallet origin, echoes
 * request id + nonce, enforces timeout and cancellation, and never exposes
 * key material (the shell never sends any).
 */
import {
  parseResponse, WALLET_PROTOCOL_VERSION,
  type WalletMethod, type WalletRequest, type WalletResponse,
} from './protocol.js';

export interface ParentTransport {
  postMessage(message: WalletRequest, targetOrigin: string): void;
  addEventListener(type: 'message', handler: (event: { origin: string; data: unknown }) => void): void;
  randomNonce(): string;
  randomId(): string;
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ParentClientOptions {
  walletOrigin: string;
  parentOrigin: string;
  transport: ParentTransport;
  timeoutMs?: number;
}

interface Pending {
  resolve(value: WalletResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  nonce: string;
}

export function createWalletParentClient(opts: ParentClientOptions) {
  const transport = opts.transport;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pending = new Map<string, Pending>();
  let sessionId: string | null = null;

  const onMessage = (event: { origin: string; data: unknown }): void => {
    if (event.origin !== opts.walletOrigin) return; // exact origin validation
    const response = parseResponse(event.data);
    if (!response) return;
    const entry = pending.get(response.id);
    if (!entry) return; // unknown / late response after timeout: ignore
    if (response.nonce !== entry.nonce) return; // nonce must match the request
    pending.delete(response.id);
    transport.clearTimeout(entry.timer);
    entry.resolve(response);
  };
  transport.addEventListener('message', onMessage);

  const send = (method: WalletMethod, payload?: WalletRequest['payload'], useSession = true): Promise<WalletResponse> => {
    const id = transport.randomId();
    const nonce = transport.randomNonce();
    const request: WalletRequest = {
      version: WALLET_PROTOCOL_VERSION,
      type: 'request',
      id,
      nonce,
      method,
      ...(useSession && sessionId ? { sessionId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
    return new Promise<WalletResponse>((resolve, reject) => {
      const timer = transport.setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, nonce });
      transport.postMessage(request, opts.walletOrigin); // exact targetOrigin
    });
  };

  const cancel = (id: string): void => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    transport.clearTimeout(entry.timer);
    entry.reject(new Error('cancelled'));
  };

  const handshake = async (): Promise<WalletResponse> => {
    const response = await send('wallet.hello', { parentOrigin: opts.parentOrigin }, false);
    if (response.ok && response.result?.sessionId) sessionId = response.result.sessionId;
    else sessionId = null;
    return response;
  };

  /** Sign a prepared sponsored transaction. Returns only SDK-shaped signedTransaction. */
  const signTransaction = async (
    prepared: Record<string, unknown>,
    options: { network?: 'testnet'; credentialIndex?: number } = {},
  ): Promise<{ ok: true; signedTransaction: Record<string, unknown>; senderAddress: string; credentialIndex: number } | { ok: false; error: string }> => {
    if (!sessionId) return { ok: false, error: 'session_required' };
    let response: WalletResponse;
    try {
      response = await send('wallet.signTransaction', {
        network: options.network ?? 'testnet',
        prepared,
        credentialIndex: options.credentialIndex ?? 0,
      } as unknown as WalletRequest['payload']);
    } catch (e) {
      return { ok: false, error: (e as Error).message === 'timeout' ? 'signing_timeout' : 'signing_cancelled' };
    }
    if (!response.ok) {
      const error = response.error ?? 'signing_failed';
      if (error === 'wallet_locked' || error === 'session_required' || error === 'session_expired') {
        sessionId = null;
        cancelAll();
      }
      return { ok: false, error };
    }
    const result = response.result as { signedTransaction?: unknown; senderAddress?: unknown; credentialIndex?: unknown } | undefined;
    const signedTransaction = result?.signedTransaction;
    if (!result || typeof signedTransaction !== 'object' || signedTransaction === null || Array.isArray(signedTransaction)) {
      return { ok: false, error: 'invalid_signature_response' };
    }
    return {
      ok: true,
      signedTransaction: signedTransaction as Record<string, unknown>,
      senderAddress: typeof result.senderAddress === 'string' ? result.senderAddress : '',
      credentialIndex: typeof result.credentialIndex === 'number' ? result.credentialIndex : 0,
    };
  };

  const dispose = (): void => { sessionId = null; cancelAll(); };

  const getStatus = async (): Promise<WalletResponse> => {
    if (!sessionId) return { version: WALLET_PROTOCOL_VERSION, type: 'response', id: 'local', nonce: '0'.repeat(64), ok: false, error: 'session_required' };
    return send('wallet.getStatus');
  };

  const lock = async (): Promise<WalletResponse> => {
    if (!sessionId) return { version: WALLET_PROTOCOL_VERSION, type: 'response', id: 'local', nonce: '0'.repeat(64), ok: false, error: 'session_required' };
    const response = await send('wallet.lock');
    if (response.ok) {
      sessionId = null;
      cancelAll();
    }
    return response;
  };

  const cancelAll = (): void => {
    for (const [id, entry] of Array.from(pending.entries())) {
      pending.delete(id);
      transport.clearTimeout(entry.timer);
      entry.reject(new Error('cancelled'));
    }
  };

  return { handshake, getStatus, lock, cancel, cancelAll, dispose, signTransaction, get pendingCount(): number { return pending.size; } };
}
