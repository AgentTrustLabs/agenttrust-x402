/**
 * Mock production guard.
 *
 * Mock facilitator mode (`AGENTTRUST_X402_FACILITATOR_MODE=mock`) is a
 * testing-only mode: the server serves the Discovery API and the HTTP
 * 402 challenge without a real facilitator, sponsor, signing service,
 * or any Concordium transaction, and paid requests can never unlock
 * (the provider fails closed at the on-chain read). It must never be
 * enabled accidentally in production and must never be reachable from
 * the network — it is a loopback-only test harness.
 *
 * Mock mode is allowed ONLY when ALL of these hold:
 *
 *   1. The mode is explicitly selected:
 *      `AGENTTRUST_X402_FACILITATOR_MODE=mock`.
 *   2. The explicit opt-in is present:
 *      `AGENTTRUST_X402_ALLOW_MOCK=1` (or `true`). A single mistyped
 *      or leaked mode variable is never enough on its own.
 *   3. The environment is not production: `NODE_ENV` must not be
 *      `production` (case-insensitive). Mock mode is never allowed in
 *      production, even with the opt-in.
 *   4. The configured bind host is loopback — exactly one of
 *      `127.0.0.1`, `::1`, or `localhost`. A non-loopback host, an
 *      empty host, or any ambiguous host value is rejected
 *      fail-closed.
 *
 * Real mode is unaffected: it never needs the opt-in, the host check,
 * or the environment check, and all of its facilitator, chain,
 * feePayer, and settlement checks are unchanged.
 *
 * The guard is enforced at the production entry point, the launcher
 * (`scripts/x402-resource-server.mts`), which calls
 * `assertMockModeAllowed` right after resolving the mode and before
 * any probe or network I/O — a rejection exits 1 before the server
 * binds, probes, or serves anything. The library
 * (`startX402ResourceServer`, `createX402Provider`) does not enforce
 * it: tests drive the library directly with mock mode and must not
 * need a production opt-in. `resolveMockAllowed` and `isLoopbackHost`
 * are pure parsers, so the rule is unit-testable without spawning a
 * server.
 */

/** The two explicit truthy values that allow mock mode. */
const MOCK_ALLOWED_VALUES = new Set(['1', 'true']);

/** The only hosts mock mode may bind to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Parse `AGENTTRUST_X402_ALLOW_MOCK`. Returns true ONLY for an explicit
 * truthy value (`1` or `true`, case-insensitive, surrounding whitespace
 * ignored). Everything else — undefined, empty, `0`, `false`, `yes`,
 * garbage — is false. There is no implicit opt-in.
 */
export function resolveMockAllowed(raw?: string): boolean {
  const value = raw?.trim().toLowerCase();
  return value !== undefined && MOCK_ALLOWED_VALUES.has(value);
}

/**
 * Is this host a loopback host? Only the three exact values count:
 * `127.0.0.1`, `::1`, `localhost` (case-insensitive for the hostname,
 * surrounding whitespace ignored). Everything else — `0.0.0.0`, a LAN
 * or public IP, a hostname, an empty string, undefined, a shorthand
 * like `127.1`, a bracketed `[::1]`, a trailing-dot `localhost.` —
 * is NOT loopback for this guard. Fail-closed: when in doubt, reject.
 */
export function isLoopbackHost(raw?: string): boolean {
  const value = raw?.trim().toLowerCase();
  return value !== undefined && value !== '' && LOOPBACK_HOSTS.has(value);
}

/** The inputs the mock production guard reads. */
export interface MockModeGuardInput {
  /** Value of `AGENTTRUST_X402_ALLOW_MOCK`. */
  allowMock?: string;
  /** The effective bind host (`AGENTTRUST_X402_HOST`, after its default). */
  host?: string;
  /** Value of `NODE_ENV`. */
  nodeEnv?: string;
}

/**
 * Enforce the mock production guard. Real mode always passes. Mock mode
 * passes only when the opt-in is present, the environment is not
 * production, and the bind host is loopback; otherwise it throws a
 * clear error naming the exact variable that caused the rejection.
 * The launcher turns this into a startup failure (exit 1) before any
 * probe or network I/O.
 */
export function assertMockModeAllowed(mode: 'real' | 'mock', input: MockModeGuardInput = {}): void {
  if (mode !== 'mock') return;
  if (!resolveMockAllowed(input.allowMock)) {
    throw new Error(
      'AGENTTRUST_X402_FACILITATOR_MODE=mock requires AGENTTRUST_X402_ALLOW_MOCK=1. ' +
        'Mock mode is testing-only: it serves the Discovery API and the HTTP 402 challenge ' +
        'without a real facilitator, sponsor, or signing, and paid requests can never unlock. ' +
        'Set AGENTTRUST_X402_ALLOW_MOCK=1 explicitly to allow it.',
    );
  }
  if (input.nodeEnv?.trim().toLowerCase() === 'production') {
    throw new Error(
      'AGENTTRUST_X402_FACILITATOR_MODE=mock is never allowed when NODE_ENV=production. ' +
        'Mock mode is testing-only and must never run in production, even with AGENTTRUST_X402_ALLOW_MOCK=1.',
    );
  }
  if (!isLoopbackHost(input.host)) {
    throw new Error(
      'AGENTTRUST_X402_FACILITATOR_MODE=mock requires a loopback host: ' +
        'AGENTTRUST_X402_HOST must be 127.0.0.1, ::1, or localhost ' +
        `(got ${JSON.stringify(input.host)}). ` +
        'Mock mode must never bind to a non-loopback address.',
    );
  }
}
