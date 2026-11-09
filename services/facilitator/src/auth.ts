/**
 * Operator authentication for state-changing endpoints.
 *
 * `/reconcile` can move money-adjacent state, so it is operator-only: a bearer token supplied
 * via configuration as a **SHA-256 digest**, never the token itself. Comparing digests means
 * the process never holds the plaintext, and a config leak does not directly yield a usable
 * credential.
 *
 * Also supported: an expiry, so a credential can be time-boxed for a maintenance window.
 *
 * What is NOT supported, deliberately: no default token, no "if unset, allow", no fallback to
 * an empty string, no query-string token (those end up in logs).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface OperatorAuthConfig {
  /** SHA-256 hex digest of the accepted token. */
  tokenSha256: string;
  /** Optional absolute expiry, epoch ms. */
  expiresAt: number | null;
}

export type AuthFailure =
  | { ok: false; code: 'missing' }
  | { ok: false; code: 'malformed' }
  | { ok: false; code: 'invalid' }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'not_configured' };

export type AuthResult = { ok: true } | AuthFailure;

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export class OperatorAuth {
  private readonly expected: Buffer;
  private readonly expiresAt: number | null;
  private readonly now: () => number;

  constructor(config: OperatorAuthConfig, opts: { now?: () => number } = {}) {
    if (!/^[0-9a-f]{64}$/i.test(config.tokenSha256)) {
      throw new Error('operator token digest must be a 64-character hex SHA-256');
    }
    this.expected = Buffer.from(config.tokenSha256.toLowerCase(), 'hex');
    this.expiresAt = config.expiresAt;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Validate an `Authorization: Bearer <token>` header.
   *
   * Every failure mode is distinct so the caller can log the *reason* without ever logging the
   * credential.
   */
  check(headerValue: string | undefined | null): AuthResult {
    if (this.expiresAt !== null && this.now() >= this.expiresAt) return { ok: false, code: 'expired' };
    if (!headerValue) return { ok: false, code: 'missing' };

    const m = /^Bearer[ \t]+(.+)$/i.exec(headerValue.trim());
    if (!m) return { ok: false, code: 'malformed' };

    const token = m[1]!.trim();
    if (!TOKEN_RE.test(token)) return { ok: false, code: 'malformed' };

    const got = createHash('sha256').update(token).digest();
    if (got.length !== this.expected.length) return { ok: false, code: 'invalid' };
    // Constant-time compare: a timing oracle on a 256-bit digest is not a practical attack,
    // but this costs nothing and removes the question.
    return timingSafeEqual(got, this.expected) ? { ok: true } : { ok: false, code: 'invalid' };
  }
}

/** Build from config, failing closed when reconcile is enabled without a credential. */
export function buildOperatorAuth(config: {
  reconcileEnabled: boolean;
  tokenSha256?: string | undefined;
  expiresAt?: number | null | undefined;
}, opts: { now?: () => number } = {}): OperatorAuth | null {
  if (!config.reconcileEnabled) return null;
  if (!config.tokenSha256) {
    throw new Error(
      'FACILITATOR_RECONCILE_ENABLED=1 requires FACILITATOR_OPERATOR_TOKEN_SHA256; ' +
        'refusing to expose an unauthenticated state-changing endpoint',
    );
  }
  return new OperatorAuth({ tokenSha256: config.tokenSha256, expiresAt: config.expiresAt ?? null }, opts);
}

/** Hash a token so an operator can generate the configured digest without editing code. */
export function hashOperatorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
