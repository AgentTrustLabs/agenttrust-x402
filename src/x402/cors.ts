/**
 * Controlled CORS for the x402 resource server.
 *
 * The frontend (Vercel) is a different origin from the API, so the two
 * browser-facing endpoints need cross-origin headers — but only for the
 * origins the operator explicitly allows:
 *
 *   GET /api/services     (and /api/services/:id — the same route family)
 *   GET /protected        (the configured resource path)
 *   OPTIONS preflight for both
 *
 * Rules:
 *   - Exact-origin allowlist, configured with AGENTTRUST_CORS_ORIGINS
 *     (comma-separated). No `*`, no `*.vercel.app` wildcard, no
 *     substring/prefix matching: the browser sends the canonical origin
 *     and it must match an allowlist entry byte-for-byte.
 *   - A wildcard or malformed entry fails startup loudly (parse throws),
 *     so a typo can never silently open the API.
 *   - An unlisted origin gets NO permission header — only `Vary: Origin`.
 *   - No `Access-Control-Allow-Credentials`: this API needs none (the
 *     frontend sends no cookies; `fetch` defaults to no credentials
 *     cross-origin). No new authentication is added.
 *   - Requests without an Origin header are not CORS requests: when CORS
 *     is unconfigured they are byte-identical to before, and a normal
 *     GET without Origin gains no headers at all.
 *   - The logic keys on the paths the server actually serves (the
 *     configured resource path + /api/services*). Behind a reverse
 *     proxy that strips a prefix (e.g. /agenttrust), the proxy forwards
 *     the bare path, so the same logic covers the deployment path.
 */

export const CORS_ALLOW_METHODS = 'GET, OPTIONS';
export const CORS_ALLOW_HEADERS = 'X-PAYMENT, Content-Type';

/**
 * Parse AGENTTRUST_CORS_ORIGINS into an exact-origin allowlist.
 *
 * Empty/unset → [] (CORS disabled; the server behaves exactly as before).
 * Each entry must be a bare origin (`scheme://host[:port]`), http: or
 * https:, no credentials, no path/query/fragment, and exactly canonical
 * (`new URL(entry).origin === entry` — a trailing slash or a default
 * port would never match the Origin header the browser sends, so it
 * fails startup instead of silently never matching). Duplicates are
 * dropped; empty entries are ignored.
 *
 * Throws on any `*` (bare wildcard or `*.domain`) and on any entry that
 * is not a bare http(s) origin. Fail-closed: a bad value stops startup.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(',')) {
    const origin = entry.trim();
    if (!origin) continue;
    if (origin.includes('*')) {
      throw new Error(
        `AGENTTRUST_CORS_ORIGINS must list exact origins, never a wildcard (got ${JSON.stringify(origin)})`,
      );
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`AGENTTRUST_CORS_ORIGINS entry is not a valid URL: ${JSON.stringify(origin)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `AGENTTRUST_CORS_ORIGINS entry must use http: or https: (got ${JSON.stringify(origin)})`,
      );
    }
    if (url.username || url.password) {
      throw new Error(
        `AGENTTRUST_CORS_ORIGINS entry must not contain credentials (got ${JSON.stringify(origin)})`,
      );
    }
    if (url.origin !== origin) {
      throw new Error(
        `AGENTTRUST_CORS_ORIGINS entry must be a bare origin (scheme://host[:port]) (got ${JSON.stringify(origin)})`,
      );
    }
    if (!seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

/** Exact match against the allowlist. The browser sends the canonical origin. */
export function isCorsOriginAllowed(origin: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(origin);
}

/**
 * Headers to add to a normal (non-preflight) response on a CORS path.
 *   - No Origin header → {} (not a CORS request; response unchanged).
 *   - Origin allowed → Access-Control-Allow-Origin + Vary: Origin.
 *   - Origin not allowed → Vary: Origin only — no permission header.
 * Never sets Access-Control-Allow-Credentials.
 */
export function corsHeadersFor(
  origin: string | undefined,
  allowlist: readonly string[],
): Record<string, string> {
  if (!origin) return {};
  if (!isCorsOriginAllowed(origin, allowlist)) return { vary: 'Origin' };
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/**
 * Answer a CORS preflight (OPTIONS carrying an Origin header) on a CORS path.
 * Returns null when the request carries no Origin header — the caller falls
 * through to the existing routing (405), preserving pre-CORS behavior for
 * non-browser OPTIONS.
 *   - Allowed origin → 204, no body, with Access-Control-Allow-Origin,
 *     Access-Control-Allow-Methods, Access-Control-Allow-Headers, Vary.
 *   - Unlisted origin → 403 with Vary only — no permission headers.
 */
export function corsPreflight(
  origin: string | undefined,
  allowlist: readonly string[],
): { status: number; headers: Record<string, string>; body: unknown } | null {
  if (!origin) return null;
  if (!isCorsOriginAllowed(origin, allowlist)) {
    return { status: 403, headers: { vary: 'Origin' }, body: { error: 'origin not allowed' } };
  }
  return {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': CORS_ALLOW_METHODS,
      'access-control-allow-headers': CORS_ALLOW_HEADERS,
      vary: 'Origin',
    },
    body: null,
  };
}
