/**
 * Standalone HTTP x402 resource server (transport only).
 *
 * This is the missing link between the pieces that already exist:
 *   - `src/x402/provider.ts` decides whether a payment unlocks the resource
 *     (preflight → facilitator verify → facilitator settle → independent
 *     on-chain read → atomic replay claim),
 *   - `src/payments/x402Sdk.ts` `createHttpFacilitator` speaks to the real
 *     self-hosted facilitator over HTTP,
 *   - `src/x402/concordiumChainVerifier.ts` reads Testnet independently.
 *
 * This module adds no payment logic of its own. It only maps HTTP to the
 * provider and back:
 *
 *   GET /protected                  → 402 + PaymentRequired challenge
 *   GET /protected + X-PAYMENT      → provider gate → 200 + resource, or
 *                                      400 malformed / 402 unpaid-or-invalid /
 *                                      409 replay / 503 verification unavailable
 *
 * On a granted access the response carries the settlement in the
 * `PAYMENT-RESPONSE` header (and the `X-PAYMENT-RESPONSE` alias), base64 JSON
 * in the SDK convention (`@x402/core` `encodePaymentResponseHeader`): the
 * client decodes it the same way the SDK client does.
 *
 * Boundaries:
 *   - Binds to loopback by default. Never expose on a public interface
 *     without an auth layer in front; the resource is public once paid.
 *   - Never signs, never constructs transactions, never holds keys.
 *   - Never retries a settlement. One paid attempt, one provider decision.
 *   - The replay store lives in the provider; a restart forgets consumed
 *     payments, so a restarted server must not be treated as a fresh ledger.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChainTransferSummary, ChainVerifier, X402Provider } from './provider.js';
import { handleDiscoveryRequest } from '../discovery/http.js';
import type { ServiceRegistry } from '../discovery/registry.js';
import { corsHeadersFor, corsPreflight } from './cors.js';

export interface X402ResourceServerOptions {
  /** Decides access. Constructed by the caller (facilitator + chain wired in). */
  provider: X402Provider;
  /** Path served, e.g. `/protected`. Default `/protected`. */
  resourcePath?: string;
  /**
   * Optional Discovery registry. When provided, the server also answers the
   * read-only Discovery API (`GET /api/services`, `GET /api/services/:id`)
   * before the /protected routing. When omitted, the server behaves exactly
   * as before — no new routes exist. Discovery never touches the payment
   * flow: it is a separate read path over a separate store.
   */
  discovery?: ServiceRegistry;
  /**
   * Optional exact-origin CORS allowlist (see src/x402/cors.ts). When
   * provided and non-empty, the server answers CORS preflight (OPTIONS
   * with an Origin header) on the resource path and the Discovery API,
   * and adds Access-Control-Allow-Origin to normal responses for listed
   * origins only. When omitted or empty, CORS is disabled and every
   * response is byte-identical to before (no behavior change at all).
   * No wildcard, no credentials: see cors.ts.
   */
  corsOrigins?: readonly string[];
  /**
   * Optional static website directory (V5.4 integration spike). When
   * provided, the server also answers GET / (the V5.4 prototype) and
   * GET /three.module.js from that directory — and nothing else. Only
   * the two exact filenames are ever served, so no directory traversal
   * is possible. The files are served read-only; the payment flow and
   * the Discovery API are untouched.
   */
  staticDir?: string;
}

/** Base64 JSON of the settlement, in the SDK header convention. */
export function encodePaymentResponse(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** Decode a `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE` header value. */
export function decodePaymentResponse(header: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical resource URL for the 402 challenge and the
 * provider-side resource binding.
 *
 * When a public URL is configured (the server runs behind a reverse proxy),
 * it is used as the canonical URL: the 402 challenge names it, and payments
 * must be bound to it. The listening socket is unaffected — the server still
 * binds the loopback host/port the caller passes to
 * `startX402ResourceServer`. The public URL is NEVER derived from request
 * headers (`Host`, `X-Forwarded-*`): it comes only from operator
 * configuration, so a client cannot steer the binding.
 *
 * Validation — a bad value throws before anything listens, so a
 * misconfiguration fails startup loudly instead of serving a wrong URL:
 *   - absolute `https:` URL (plain `http:` is rejected: the public resource
 *     must be served over TLS),
 *   - a valid hostname (non-empty, containing at least one letter or digit —
 *     a bare `.` or `..` is not a hostname),
 *   - no username or password,
 *   - no query string and no fragment,
 *   - the path must be the protected resource route, optionally under a
 *     reverse-proxy prefix: it must equal `resourcePath`, or end with it
 *     at a path-segment boundary (`/agenttrust/protected` ends with
 *     `/protected`; `/otherprotected` does not, and neither does
 *     `/protected/extra`). A proxy prefix is the normal deployment — the
 *     public path carries the proxy's prefix while the server serves the
 *     bare route — so it is accepted, but nothing after the route is.
 * When no public URL is configured (undefined or empty), the loopback URL
 * built from the bind host/port is returned, preserving existing behavior.
 */
export function resolveResourceUrl(opts: {
  publicUrl?: string;
  host: string;
  port: number;
  resourcePath: string;
}): string {
  const raw = opts.publicUrl?.trim();
  if (!raw) {
    const hostForUrl = opts.host === '::1' ? '[::1]' : opts.host;
    return `http://${hostForUrl}:${opts.port}${opts.resourcePath}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AGENTTRUST_X402_PUBLIC_URL must be an absolute URL (got ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`AGENTTRUST_X402_PUBLIC_URL must use https: (got ${url.protocol})`);
  }
  if (!url.hostname || !/[A-Za-z0-9]/.test(url.hostname)) {
    throw new Error(`AGENTTRUST_X402_PUBLIC_URL must have a valid hostname (got ${JSON.stringify(raw)})`);
  }
  if (url.username || url.password) {
    throw new Error(`AGENTTRUST_X402_PUBLIC_URL must not contain credentials (got ${JSON.stringify(raw)})`);
  }
  if (url.search || url.hash) {
    throw new Error(`AGENTTRUST_X402_PUBLIC_URL must not contain a query or fragment (got ${JSON.stringify(raw)})`);
  }
  if (url.pathname !== opts.resourcePath && !url.pathname.endsWith(opts.resourcePath)) {
    throw new Error(
      `AGENTTRUST_X402_PUBLIC_URL path must be ${opts.resourcePath} (got ${url.pathname})`,
    );
  }
  return url.href;
}

export type FacilitatorMode = 'real' | 'mock';

/**
 * Resolve the facilitator mode for the resource server.
 *
 * The mode is explicit operator configuration
 * (`AGENTTRUST_X402_FACILITATOR_MODE`). It is never inferred from the
 * environment and never falls back from real to mock: an invalid value
 * fails startup loudly instead of silently selecting a mode.
 *
 *   - undefined / empty → 'real' (the production default — fail-closed).
 *   - 'real' → the real facilitator + real chain verifier (startup probe,
 *     sponsor feePayer required, all payment checks active).
 *   - 'mock' → the mock facilitator + a chain verifier that never reports
 *     a finalization (no real facilitator, no sponsor, no signing,
 *     settlement, broadcast, or CCD transfer; paid requests can never
 *     unlock — the provider fails closed at the on-chain read).
 *
 * The comparison is exact (case-sensitive) so a typo cannot silently
 * select the wrong mode.
 */
export function resolveFacilitatorMode(raw?: string): FacilitatorMode {
  const value = raw?.trim();
  if (!value) return 'real';
  if (value === 'real' || value === 'mock') return value;
  throw new Error(
    `AGENTTRUST_X402_FACILITATOR_MODE must be "real" or "mock" (got ${JSON.stringify(raw)})`,
  );
}

/**
 * A chain verifier for mock mode. It never reports a transaction as
 * finalized — there is no chain access in mock mode, so no payment can
 * ever be verified on-chain. The provider therefore fails closed (503
 * `on-chain verification unavailable`) for every paid request, even
 * after the mock facilitator "settles" it. This is the backstop that
 * makes mock settlement incapable of unlocking the resource: a 200
 * requires a finalized, matching on-chain transfer, and this verifier
 * never produces one.
 *
 * The `ChainVerifier` interface promises never to throw, so this returns
 * `{ status: 'unavailable' }` instead of throwing.
 */
export function createMockChainVerifier(): ChainVerifier {
  return {
    readTransfer: async (_txHash: string): Promise<ChainTransferSummary> => ({
      status: 'unavailable',
    }),
  };
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * Build the request handler. Pure transport: every payment decision comes
 * from the injected provider.
 */
export function createX402ResourceHandler(opts: X402ResourceServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const resourcePath = opts.resourcePath ?? '/protected';
  const provider = opts.provider;
  const corsOrigins = opts.corsOrigins ?? [];
  const corsActive = corsOrigins.length > 0;
  // CORS applies to the two browser-facing endpoints: the protected
  // resource (the configured path — behind a reverse proxy the proxy
  // strips its prefix and forwards this bare path) and the Discovery
  // API (list + detail — the same route family). Nothing else gets
  // CORS headers: the static website is same-origin by design.
  const isCorsPath = (path: string): boolean =>
    path === resourcePath || path === '/api/services' || path.startsWith('/api/services/');

  return (req, res) => {
    void (async () => {
      const url = (req.url ?? '/').split('?')[0]!;
      const method = req.method ?? 'GET';
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const corsPath = isCorsPath(url);
      const cors = corsActive && corsPath ? corsHeadersFor(origin, corsOrigins) : {};

      // CORS preflight, before any routing: an OPTIONS carrying an
      // Origin header on a CORS path is answered here (204 for a listed
      // origin, 403 for an unlisted one) and never reaches the 405
      // branches below. An OPTIONS without Origin is not a preflight —
      // it falls through to the existing routing (405), preserving the
      // pre-CORS behavior for non-browser clients.
      if (corsActive && corsPath && method === 'OPTIONS') {
        const preflight = corsPreflight(origin, corsOrigins);
        if (preflight !== null) {
          if (preflight.status === 204) {
            res.writeHead(204, preflight.headers);
            res.end();
          } else {
            json(res, preflight.status, preflight.body, preflight.headers);
          }
          return;
        }
      }

      // Discovery API (read-only). Only active when a registry was injected.
      // Checked before the /protected routing so /api/services never hits
      // the 404 below — and so the payment flow is untouched when no
      // registry is provided.
      if (opts.discovery) {
        const discovered = handleDiscoveryRequest(opts.discovery, req);
        if (discovered !== null) {
          json(res, discovered.status, discovered.body, { ...cors, ...(discovered.headers ?? {}) });
          return;
        }
      }

      // Static website (V5.4 prototype). Only active when a static
      // directory was injected. Exactly two files are served, by exact
      // pathname match; everything else falls through to the 404 below.
      if (opts.staticDir && method === 'GET' && (url === '/' || url === '/three.module.js')) {
        const file = url === '/' ? 'prototype-v5-4.html' : 'three.module.js';
        const contentType = url === '/'
          ? 'text/html; charset=utf-8'
          : 'text/javascript; charset=utf-8';
        try {
          const body = await readFile(join(opts.staticDir, file));
          res.writeHead(200, {
            'content-type': contentType,
            'cache-control': 'no-store',
            'content-length': body.length,
          });
          res.end(body);
        } catch {
          json(res, 404, { error: 'not found' });
        }
        return;
      }

      if (url !== resourcePath) {
        json(res, 404, { error: 'not found' }, cors);
        return;
      }
      if (method !== 'GET') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'GET', ...cors });
        return;
      }

      const header = req.headers['x-payment'];
      if (header === undefined) {
        // Unpaid: the 402 challenge. This is the only path that returns 402
        // without a payment attempt.
        const unpaid = provider.handleUnpaid();
        json(res, 402, unpaid.body, cors);
        return;
      }
      if (Array.isArray(header) || header.trim() === '') {
        json(res, 400, { error: 'X-PAYMENT header must be a single non-empty value' }, cors);
        return;
      }

      const outcome = await provider.handlePayment(header);
      if (outcome.status === 200) {
        const payment = (outcome.body as { payment?: Record<string, unknown> }).payment ?? {};
        const settlement = encodePaymentResponse({ success: true, ...payment });
        json(res, 200, outcome.body, {
          'payment-response': settlement,
          'x-payment-response': settlement,
          ...cors,
        });
        return;
      }
      json(res, outcome.status, outcome.body, cors);
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    });
  };
}

export interface StartedX402ResourceServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

/**
 * Resolve the bind host for the resource server.
 *
 * An unset, empty, or whitespace-only host is NOT "bind to all
 * interfaces": it is the loopback default. Node's `server.listen(port,
 * '')` binds to `::` (all interfaces), so an empty host must be
 * normalized here — before it reaches `listen` — or a single empty
 * env var (`AGENTTRUST_X402_HOST=`) silently exposes the server on
 * the network. A valid, explicitly configured host is returned
 * trimmed and unchanged (`0.0.0.0`, a LAN IP, `::1`, `localhost`,
 * `127.0.0.1` all keep their meaning; the operator chose them).
 *
 * The mock production guard (`src/x402/mockModeGuard.ts`) still
 * validates the EFFECTIVE host: it receives this normalized value,
 * so mock mode is allowed only when the server will actually bind
 * loopback. The guard's own parsers are unchanged — an empty string
 * is still "not loopback" to `isLoopbackHost`; it is the launcher
 * and this function that ensure an empty host never reaches a
 * `listen` call or the guard as an ambiguous value.
 */
export function resolveBindHost(raw?: string): string {
  const value = raw?.trim();
  return value ? value : '127.0.0.1';
}

/** Bind the handler on a real socket. Loopback by default. */
export async function startX402ResourceServer(opts: X402ResourceServerOptions & {
  host?: string;
  port?: number;
}): Promise<StartedX402ResourceServer> {
  const host = resolveBindHost(opts.host);
  const port = opts.port ?? 4590;
  const server = createServer(createX402ResourceHandler(opts));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${boundPort}`,
    server,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
