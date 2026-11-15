/**
 * Discovery API — HTTP transport (read-only).
 *
 * Routes (mounted by the x402 resource server when a registry is provided):
 *
 *   GET /api/services            list + filter + search
 *   GET /api/services/:id        one service, with pricing + x402 payment
 *                                requirements when it is active
 *
 * Read-only by design: there is no POST/PUT/DELETE. Registration happens
 * operator-side through the registry module, never over unauthenticated
 * HTTP. A client that tries to write gets 405, not a silent ignore.
 *
 * Query parameters for the list:
 *   category   one of the closed SERVICE_CATEGORIES
 *   network    must be the Testnet CAIP-2
 *   q          case-insensitive substring search over name + description
 *   status     'active' | 'inactive' | 'all' (default 'active')
 *   limit      integer 1..100 (default 25)
 *
 * Errors are a code + message, never a stack trace. Unknown service is 404.
 * Invalid filters are 400. Wrong method is 405 with an Allow header.
 */

import type { IncomingMessage } from 'node:http';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  SERVICE_CATEGORIES,
  DISCOVERY_NETWORK,
  toServiceView,
  type ServiceRegistry,
} from './registry.js';

export interface DiscoveryHttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Parse the query string of a request URL into a plain object. */
function queryOf(req: IncomingMessage): Record<string, string> {
  const raw = (req.url ?? '/').split('?')[1] ?? '';
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function badRequest(message: string): DiscoveryHttpResult {
  return { status: 400, body: { error: message } };
}

/**
 * Handle a request. Returns `null` when the path is not a discovery route,
 * so the caller can fall through to its own routing (e.g. /protected).
 */
export function handleDiscoveryRequest(
  registry: ServiceRegistry,
  req: IncomingMessage,
): DiscoveryHttpResult | null {
  const path = (req.url ?? '/').split('?')[0]!;
  const method = req.method ?? 'GET';

  const isList = path === '/api/services';
  const detailMatch = /^\/api\/services\/([^/]+)$/.exec(path);
  if (!isList && !detailMatch) return null;

  if (method !== 'GET') {
    return {
      status: 405,
      body: { error: 'method not allowed' },
      headers: { allow: 'GET' },
    };
  }

  if (isList) {
    const q = queryOf(req);
    const category = q['category'];
    const network = q['network'];
    const search = q['q'];
    const status = q['status'];
    const limitRaw = q['limit'];

    if (category !== undefined && !(SERVICE_CATEGORIES as readonly string[]).includes(category)) {
      return badRequest(`category must be one of ${SERVICE_CATEGORIES.join(', ')}`);
    }
    if (network !== undefined && network !== DISCOVERY_NETWORK) {
      return badRequest(`network must be ${DISCOVERY_NETWORK} (Concordium Testnet only)`);
    }
    if (status !== undefined && status !== 'active' && status !== 'inactive' && status !== 'all') {
      return badRequest("status must be 'active', 'inactive', or 'all'");
    }
    let limit = DEFAULT_LIST_LIMIT;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) return badRequest('limit must be an integer');
      limit = Number(limitRaw);
      if (limit < 1 || limit > MAX_LIST_LIMIT) {
        return badRequest(`limit must be an integer 1..${MAX_LIST_LIMIT}`);
      }
    }

    let result: ReturnType<ServiceRegistry['list']>;
    try {
      result = registry.list({
        ...(category !== undefined ? { category } : {}),
        ...(network !== undefined ? { network } : {}),
        ...(search !== undefined ? { q: search } : {}),
        ...(status !== undefined ? { status } : {}),
        limit,
      });
    } catch (e) {
      return badRequest((e as Error).message);
    }
    return {
      status: 200,
      body: {
        services: result.services.map(toServiceView),
        total: result.total,
        filters: {
          ...(category !== undefined ? { category } : {}),
          ...(network !== undefined ? { network } : {}),
          ...(search !== undefined ? { q: search } : {}),
          status: status ?? 'active',
          limit,
        },
      },
    };
  }

  // Detail: /api/services/:id (detailMatch is non-null here: the early
  // return above only lets list routes and detail routes through).
  if (!detailMatch) return null;
  let id: string;
  try {
    id = decodeURIComponent(detailMatch[1]!);
  } catch {
    // A malformed percent-encoding (e.g. /api/services/%ZZ) is bad
    // client input, not a server error: 400, not the catch-all 500
    // the resource server returns for unexpected throws.
    return badRequest('service id is not valid percent-encoding');
  }
  const service = registry.get(id);
  if (!service) {
    return { status: 404, body: { error: 'service not found' } };
  }
  return { status: 200, body: toServiceView(service) };
}
