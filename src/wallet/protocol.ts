/**
 * Wallet Context message protocol (typed, versioned, fail-closed).
 *
 * Rules enforced here and by the shell/client:
 *  - exact origin allowlist (never '*'), validated on BOTH sides;
 *  - one-time nonce and unique request id per message;
 *  - fixed method allowlist — no generic method invocation;
 *  - no key material, seed, KEK, or signer object is ever serialised.
 */

export const WALLET_PROTOCOL_VERSION = 1 as const;

export const WALLET_METHODS = ['wallet.hello', 'wallet.getStatus', 'wallet.lock', 'wallet.signTransaction'] as const;
export type WalletMethod = (typeof WALLET_METHODS)[number];

export const WALLET_PARENT_ORIGIN = 'http://127.0.0.1:4590';
export const WALLET_CONTEXT_ORIGIN = 'http://127.0.0.1:4591';

export interface HelloPayload {
  /** Parent declares its own origin; the shell still checks event.origin. */
  parentOrigin: string;
}

export type WalletRequestPayload = HelloPayload | Record<string, never>;

export interface WalletRequest {
  version: typeof WALLET_PROTOCOL_VERSION;
  type: 'request';
  id: string;
  nonce: string;
  method: WalletMethod;
  /** Present after a successful hello. */
  sessionId?: string;
  payload?: WalletRequestPayload;
}

export interface WalletResponse {
  version: typeof WALLET_PROTOCOL_VERSION;
  type: 'response';
  id: string;
  nonce: string;
  sessionId?: string;
  ok: boolean;
  error?: string;
  result?: {
    state?: 'locked' | 'unlocked';
    sessionId?: string;
    methods?: readonly WalletMethod[];
    walletId?: string;
    publicKey?: string;
  };
}

export type ErrorCode =
  | 'invalid_message'
  | 'unsupported_version'
  | 'invalid_method'
  | 'invalid_payload'
  | 'invalid_nonce'
  | 'nonce_replayed'
  | 'duplicate_request_id'
  | 'unknown_session'
  | 'session_required'
  | 'invalid_origin'
  | 'timeout'
  | 'cancelled';

const HEX32 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{16,128}$/;

export function isWalletMethod(v: unknown): v is WalletMethod {
  return typeof v === 'string' && (WALLET_METHODS as readonly string[]).includes(v);
}

export function isHexNonce(v: unknown): v is string {
  return typeof v === 'string' && HEX32.test(v);
}

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v);
}

/** Strict structural validation of an incoming request. No coercion. */
export function parseRequest(value: unknown): WalletRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m['version'] !== WALLET_PROTOCOL_VERSION) return null;
  if (m['type'] !== 'request') return null;
  if (!isRequestId(m['id']) || !isHexNonce(m['nonce'])) return null;
  if (!isWalletMethod(m['method'])) return null;
  if (m['sessionId'] !== undefined && !isRequestId(m['sessionId'])) return null;
  if (m['payload'] !== undefined && (typeof m['payload'] !== 'object' || m['payload'] === null || Array.isArray(m['payload']))) return null;
  return {
    version: WALLET_PROTOCOL_VERSION,
    type: 'request',
    id: m['id'] as string,
    nonce: m['nonce'] as string,
    method: m['method'] as WalletMethod,
    ...(m['sessionId'] !== undefined ? { sessionId: m['sessionId'] as string } : {}),
    ...(m['payload'] !== undefined ? { payload: m['payload'] as WalletRequestPayload } : {}),
  };
}

/** Validate a response against the exact request it answers. */
export function parseResponse(value: unknown): WalletResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m['version'] !== WALLET_PROTOCOL_VERSION || m['type'] !== 'response') return null;
  if (!isRequestId(m['id']) || !isHexNonce(m['nonce'])) return null;
  if (typeof m['ok'] !== 'boolean') return null;
  return {
    version: WALLET_PROTOCOL_VERSION,
    type: 'response',
    id: m['id'] as string,
    nonce: m['nonce'] as string,
    ok: m['ok'],
    ...(typeof m['error'] === 'string' ? { error: m['error'] } : {}),
    ...(m['result'] && typeof m['result'] === 'object' && !Array.isArray(m['result'])
      ? { result: m['result'] as WalletResponse['result'] } : {}),
  };
}
