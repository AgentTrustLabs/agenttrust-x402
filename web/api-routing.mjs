/**
 * Centralized API service configuration + routing layer for the AgentTrust
 * website.
 *
 * The website talks to three different backend services, each owning a
 * disjoint set of routes. A single base URL cannot address them
 * (split-brain — verified 2026-11-23: staging 4518 answered /api/payments,
 * /api/services and /api/a2a/tasks with 404, while the production origin
 * answered /api/config with 404):
 *
 *   - pairing   — the pairing server: identity, sessions, agent wallets,
 *                 permissions, approvals, x402 access, skills, A2A task
 *                 records (GET /api/a2a/tasks[/:id]).
 *   - resource  — the resource server: the protected x402 resource, the
 *                 service registry, the payment-record list, the gateway
 *                 Agent Card (/.well-known/agent-card.json).
 *   - a2a       — the standalone A2A server: the provider Agent Card and
 *                 JSON-RPC (SendMessage / GetTask / ListTasks / CancelTask /
 *                 SubscribeToTask) under /a2a/agents/<agentId>/.
 *
 * Each service has its own base URL, injected at build time from an env
 * var (web/build.mjs). The rules are explicit and fail-closed:
 *
 *   - A value that is a valid http(s) URL is used as that service's base.
 *   - An empty value means "not configured" for resource and a2a: any call
 *     to that service throws `service_not_configured:<service>`. Nothing
 *     ever falls back to another service's base, and nothing ever falls
 *     back to a production endpoint.
 *   - For pairing only, an empty value means "same origin": the pairing
 *     server is the one serving this website (serveStatic reads web/dist),
 *     so same-origin is the established pairing deployment.
 *   - A value that is not a valid http(s) URL (and not empty / a build
 *     placeholder) is a configuration error:
 *     `invalid_api_base_url:<service>`.
 *   - The legacy single base (AGENTTRUST_API_BASE_URL) is honoured only
 *     as the resource base, and only when the resource base itself is not
 *     configured. It is deprecated; new deployments set the per-service
 *     variables.
 *   - In the unbuilt source the injected values are the literal
 *     `__AGENTTRUST_...__` placeholders; those resolve to same origin so
 *     the source still works standalone.
 *
 * This module is pure (no DOM, no global fetch): the caller injects fetch.
 * It is shared by the website (imported by prototype-v5-6.html) and by the
 * regression suite (test/website-api-routing.test.mts).
 */

export const API_SERVICES = ['pairing', 'resource', 'a2a'];

/**
 * Route ownership: [path prefix, owning service]. The longest matching
 * prefix wins. A path with no owner is rejected (`unknown_api_route`) —
 * the website never guesses which service owns a route.
 *
 * Pairing owns the control plane (sessions, wallets, permissions,
 * approvals, x402 access, skills, A2A task records). Resource owns the
 * data plane (protected resource, registry, payment records, gateway
 * card). A2A owns the provider Agent Card and JSON-RPC.
 */
export const ROUTE_OWNERSHIP = [
  // Pairing server (src/pairing/server.ts).
  ['/api/config', 'pairing'],
  ['/api/status', 'pairing'],
  ['/api/session', 'pairing'],
  ['/api/challenge', 'pairing'],
  ['/api/verify', 'pairing'],
  ['/api/pair', 'pairing'],
  ['/api/unlink', 'pairing'],
  ['/api/disconnect', 'pairing'],
  ['/api/permission', 'pairing'],
  ['/api/approvals', 'pairing'],
  ['/api/approval/', 'pairing'],
  ['/api/activity', 'pairing'],
  ['/api/wallets', 'pairing'],
  ['/api/wallet', 'pairing'],
  ['/api/owner/', 'pairing'],
  ['/api/x402/', 'pairing'],
  ['/api/skills', 'pairing'],
  ['/api/a2a/tasks', 'pairing'],
  // Resource server (src/x402/resourceServer.ts, src/discovery/http.ts).
  ['/protected', 'resource'],
  ['/api/services', 'resource'],
  ['/api/payments', 'resource'],
  ['/.well-known/agent-card.json', 'resource'],
  // Standalone A2A server (src/a2a/server.ts, scripts/a2a-server.mts).
  ['/a2a/agents/', 'a2a'],
];

/** The sentinel the build writes when an env var is absent. */
export const API_BASE_UNSET = '__UNSET__';

/** Build placeholder prefix (unbuilt source): resolves to same origin. */
const PLACEHOLDER_PREFIX = '__AGENTTRUST_';

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!/^https?:\/\/[^/\s]+(\/\S*)?$/.test(value)) return false;
  return true;
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

/**
 * Resolve one service's base from its injected value.
 *
 * Returns { base, configured, source } where `base` is '' for same origin
 * and a URL otherwise; `configured` is false when the service has no base
 * and must not be called; `source` names where the base came from
 * ('url' | 'same-origin' | 'unbuilt' | 'unset').
 *
 * `sameOriginDefault` is true only for pairing (the server serving this
 * website). Resource and a2a have no same-origin default: an empty value
 * is "not configured", never a silent same-origin guess.
 */
export function resolveServiceBase(value, sameOriginDefault) {
  if (value === API_BASE_UNSET || value === null || value === undefined) {
    return { base: '', configured: false, source: 'unset' };
  }
  if (typeof value === 'string' && value.startsWith(PLACEHOLDER_PREFIX)) {
    // Unbuilt source (literal __AGENTTRUST_...__ placeholder): same origin.
    return { base: '', configured: true, source: 'unbuilt' };
  }
  if (value === 'same-origin') {
    return { base: '', configured: true, source: 'same-origin' };
  }
  if (typeof value === 'string' && value.length === 0) {
    if (sameOriginDefault) return { base: '', configured: true, source: 'same-origin' };
    return { base: '', configured: false, source: 'unset' };
  }
  if (isHttpUrl(value)) {
    return { base: stripTrailingSlashes(value), configured: true, source: 'url' };
  }
  throw new Error('invalid_api_base_url');
}

/**
 * Resolve the full per-service config from the injected values.
 *
 * `injected` is { pairing, resource, a2a, legacy } — the values written by
 * web/build.mjs (each a URL, '', '__UNSET__', or a literal placeholder).
 * Throws Error('invalid_api_base_url:<service>') on a malformed value.
 * The legacy single base is used as the resource base only when the
 * resource base itself is not configured.
 */
export function resolveApiConfig(injected) {
  const src = injected && typeof injected === 'object' ? injected : {};
  let pairing;
  let resource;
  let a2a;
  try {
    pairing = resolveServiceBase(src.pairing, true);
  } catch {
    throw new Error('invalid_api_base_url:pairing');
  }
  try {
    resource = resolveServiceBase(src.resource, false);
  } catch {
    throw new Error('invalid_api_base_url:resource');
  }
  try {
    a2a = resolveServiceBase(src.a2a, false);
  } catch {
    throw new Error('invalid_api_base_url:a2a');
  }
  // Legacy single base (AGENTTRUST_API_BASE_URL): resource fallback only.
  if (!resource.configured && typeof src.legacy === 'string' && src.legacy.length > 0) {
    if (src.legacy.startsWith(PLACEHOLDER_PREFIX)) {
      resource = { base: '', configured: true, source: 'unbuilt' };
    } else if (isHttpUrl(src.legacy)) {
      resource = { base: stripTrailingSlashes(src.legacy), configured: true, source: 'legacy' };
    } else if (src.legacy !== API_BASE_UNSET) {
      throw new Error('invalid_api_base_url:resource');
    }
  }
  return { pairing, resource, a2a };
}

/**
 * Which service owns a path? The longest matching ROUTE_OWNERSHIP prefix
 * wins. Returns null when no service owns the path.
 */
export function routeOwnerFor(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  // Match on the pathname only: a query string or fragment must not
  // change which service owns the route.
  const pathname = path.split(/[?#]/, 1)[0];
  let best = null;
  let bestLen = -1;
  for (const [prefix, service] of ROUTE_OWNERSHIP) {
    const matches = prefix.endsWith('/')
      ? pathname.startsWith(prefix)
      : pathname === prefix || pathname.startsWith(prefix + '/');
    if (matches && prefix.length > bestLen) {
      best = service;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Build the URL for a call to a specific service. Throws:
 *   - Error('unknown_service:<service>') for an unknown service name.
 *   - Error('service_not_configured:<service>') when the service has no
 *     base (missing configuration — never silently falls back).
 *   - Error('invalid_api_path') when the path does not start with '/'.
 * A same-origin base ('') returns the path unchanged.
 */
export function apiUrlFor(config, service, path) {
  if (!API_SERVICES.includes(service)) throw new Error(`unknown_service:${service}`);
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('invalid_api_path');
  const entry = config && config[service];
  if (!entry || entry.configured !== true) throw new Error(`service_not_configured:${service}`);
  return entry.base ? entry.base + path : path;
}

/**
 * Build the URL for a path, routing it to the service that owns it.
 * Throws Error('unknown_api_route:<path>') when no service owns the path.
 */
export function apiUrlForPath(config, path) {
  const owner = routeOwnerFor(path);
  if (!owner) throw new Error(`unknown_api_route:${path}`);
  return apiUrlFor(config, owner, path);
}

/**
 * Fetch + JSON parse with a bounded timeout, routed to one service.
 * `fetchImpl` is injected (the global fetch in the browser, a mock in
 * tests). Returns { status, body } (body null when the response is not
 * JSON). Throws Error('api_unreachable') on network failure,
 * Error('request_timeout') on timeout, and the service_not_configured /
 * unknown_service errors from apiUrlFor.
 */
export async function fetchJson(fetchImpl, config, service, path, init, timeoutMs = 10000) {
  const url = apiUrlFor(config, service, path);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { ...(init || {}), signal: ctrl.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('request_timeout');
    throw new Error('api_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchJson, with the service resolved from the path's owner. Throws
 * Error('unknown_api_route:<path>') when no service owns the path.
 */
export async function fetchJsonForPath(fetchImpl, config, path, init, timeoutMs = 10000) {
  const owner = routeOwnerFor(path);
  if (!owner) throw new Error(`unknown_api_route:${path}`);
  return fetchJson(fetchImpl, config, owner, path, init, timeoutMs);
}
