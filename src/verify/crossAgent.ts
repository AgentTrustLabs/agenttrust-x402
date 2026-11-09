/**
 * Cross-agent verification — the consumer side of AgentTrust.
 *
 * An independent agent uses this to decide whether to transact with a CIS-8004
 * registered agent. It deliberately does NOT import AgentTrust's registration
 * code and does NOT trust the hosted badge checker as sole evidence: every check
 * is re-derived locally from bytes it fetched itself.
 *
 * All I/O is injected so the logic is testable offline and the caller controls
 * where the truth comes from.
 */

import { createHash } from 'node:crypto';
import * as httpMod from 'node:http';
import * as httpsMod from 'node:https';
import { lookup as dnsLookup } from 'node:dns';

// ─── Types ────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_TESTED';
export type TrustDecision = 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';

export interface RegistryRecord {
  token_id: number | string;
  owner_account: string;
  agent_uri: string | null;
  metadata_hash_hex: string | null;
  agent_wallet?: string | null;
  status: string;
  registered_at?: string;
  last_event_block?: number;
}

export interface CardFetchResult {
  ok: boolean;
  status: number;
  url: string;
  bytes: Uint8Array | null;
  contentType: string | null;
  error: string | null;
  /**
   * How the failure should be read, which decides the verdict:
   *  - `permanent` — the evidence positively contradicts the claim (a 404 at a URI the
   *    registry says serves the card; a card over the size limit; a URL that is not
   *    fetchable at all) → `FAIL` → REJECTED.
   *  - `transient` — the evidence could not be established right now (5xx, 429, 408,
   *    DNS/TLS failure, timeout) → `INCONCLUSIVE`. An outage is not misconduct.
   *  - `none` — retrieved.
   */
  failure: 'none' | 'permanent' | 'transient';
}

export interface BadgeVerification {
  /** Hosted verifier's own verdict, if one was consulted. */
  consulted: boolean;
  raw: Record<string, unknown> | null;
  error: string | null;
}

export interface ContractExpectation {
  network: string;          // CAIP-2, e.g. ccd:4221...
  cis8004: string;          // "12802.0"
  cis8?: string;            // "12801.0"
  tokenId: number;
  /** Expected owner account (base58). Compared against the registry record. */
  ownerAccount?: string;
}

/**
 * Why a verdict came out the way it did — deliberately separate from the verdict.
 *
 * A verdict is a conclusion about the *agent's claims*. A failure kind is a statement about
 * the *evidence*. Collapsing them is what produced the class of defect this interface
 * exists to prevent: "the card was not reachable" being reported as "the agent failed
 * verification".
 *
 *  - `none`            nothing failed
 *  - `contradiction`   supplied evidence positively violates a mandatory requirement
 *                      (hash mismatch, owner mismatch, contract mismatch, revocation,
 *                      malformed or invalid card *content*)
 *  - `unavailable`     evidence could not be obtained or established (network, DNS, TLS,
 *                      timeout, HTTP availability/access, endpoint policy)
 */
export type FailureKind = 'none' | 'contradiction' | 'unavailable';

export interface TrustResult {
  agent_discovered: Verdict;
  /**
   * Retrieval status, not an identity check. `PASS` when bytes were obtained, otherwise
   * `INCONCLUSIVE` — never `FAIL`, because "the endpoint did not give us the card" is not
   * evidence that the agent's identity claims are false.
   */
  card_retrieved: Verdict;
  card_valid: Verdict;
  badge_valid: Verdict;
  hash_matches_on_chain: Verdict;
  owner_matches: Verdict;
  status_active: Verdict;
  contract_references_match: Verdict;
  trust_decision: TrustDecision;
  /** Why: contradiction vs unavailability. Orthogonal to `trust_decision`. */
  failure_kind: FailureKind;
  /** The failed verification requirement(s), when `trust_decision` is REJECTED. */
  failed_requirements: string[];
  evidence: Record<string, unknown>;
}

// ─── Registry schema introspection ────────────────────────────────────────

export interface ToolSchema {
  name: string;
  required: string[];
  properties: Record<string, unknown>;
}

/** Extract a tool's input schema from a `tools/list` response. */
export function readToolSchema(toolsListResponse: unknown, toolName: string): ToolSchema {
  const tools = (toolsListResponse as { result?: { tools?: unknown[] } })?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('tools/list response has no result.tools array — schema unknown');
  }
  const tool = tools.find(
    (t): t is { name: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } } =>
      typeof t === 'object' && t !== null && (t as { name?: string }).name === toolName,
  );
  if (!tool) throw new Error(`tool "${toolName}" is not registered on this MCP server`);
  const schema = tool.inputSchema ?? {};
  return {
    name: toolName,
    required: [...(schema.required ?? [])],
    properties: schema.properties ?? {},
  };
}

/** Fail loudly if the expected required parameter is gone — never guess. */
export function assertToolAccepts(schema: ToolSchema, param: string): void {
  if (!schema.required.includes(param)) {
    throw new Error(
      `schema drift: "${schema.name}" no longer requires "${param}" (required: ${schema.required.join(', ') || 'none'})`,
    );
  }
}

// ─── Discovery ────────────────────────────────────────────────────────────

/**
 * Validate a search_agents payload. Rejects anything that is not a plausible
 * registry response, so a malformed answer cannot be mistaken for "not found".
 */
export function parseDiscoveryResponse(
  payload: unknown,
  expect: { tokenId: number; owner: string },
): { found: boolean; record: RegistryRecord | null; reason: string } {
  if (!payload || typeof payload !== 'object') {
    return { found: false, record: null, reason: 'response is not an object' };
  }
  const agents = (payload as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) {
    return { found: false, record: null, reason: 'response has no agents array' };
  }
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue;
    const r = a as RegistryRecord;
    if (Number(r.token_id) === expect.tokenId) {
      return { found: true, record: r, reason: 'token_id matched' };
    }
  }
  return { found: false, record: null, reason: `no record with token_id ${expect.tokenId} in ${agents.length} result(s)` };
}

// ─── Card retrieval ───────────────────────────────────────────────────────

/** Largest card body the gateway will accept. A "card" larger than this is not a card. */
export const MAX_CARD_BYTES = 256 * 1024;
/** How long a single card fetch may take before it is treated as unavailable. */
export const DEFAULT_CARD_TIMEOUT_MS = 10_000;

/**
 * Is an IP literal a destination the gateway must not contact?
 *
 * Applied to the addresses a hostname *resolves to*, not just to literals in the URL —
 * which is the difference between "the URL looks fine" and "the socket goes somewhere safe".
 */
export function isProhibitedAddress(raw: string): { prohibited: boolean; reason?: string } {
  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) down to the embedded IPv4 first: the
  // mapped form is how a loopback connection reaches an IPv4 socket.
  let ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some(o => !Number.isInteger(o) || o > 255)) return { prohibited: true, reason: `invalid IPv4 ${raw}` };
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return { prohibited: true, reason: 'unspecified 0.0.0.0/8' };
    if (a === 10) return { prohibited: true, reason: 'private 10/8' };
    if (a === 127) return { prohibited: true, reason: 'loopback 127/8' };
    if (a === 169 && b === 254) return { prohibited: true, reason: 'link-local 169.254/16 (cloud metadata)' };
    if (a === 172 && b >= 16 && b <= 31) return { prohibited: true, reason: 'private 172.16/12' };
    if (a === 192 && b === 168) return { prohibited: true, reason: 'private 192.168/16' };
    if (a === 100 && b >= 64 && b <= 127) return { prohibited: true, reason: 'CGNAT 100.64/10' };
    if (a >= 224) return { prohibited: true, reason: 'multicast/reserved 224/4+' };
    return { prohibited: false };
  }

  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return { prohibited: true, reason: 'unspecified/loopback IPv6' };
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return { prohibited: true, reason: 'unique-local fc00::/7' };
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return { prohibited: true, reason: 'link-local fe80::/10' };
    if (/^ff[0-9a-f]{2}:/.test(ip)) return { prohibited: true, reason: 'multicast ff00::/8' };
    return { prohibited: false };
  }

  return { prohibited: true, reason: `unrecognised address ${raw}` };
}

/**
 * Resolve a validated `agent_uri` to the exact destinations the connection may use.
 *
 * This is the correction to TASK 20's gap: hostname validation proved nothing about the
 * address the socket would reach, so a hostname that resolves to `127.0.0.1` passed and
 * was contacted. Here every answer is checked, and **one prohibited address in the set
 * refuses the whole set** — picking "the first public one" is precisely how rebinding wins,
 * because the connection may use either.
 *
 * The returned addresses are what the transport pins; no further resolution happens.
 */
export async function resolveCardDestination(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<{ address: string; family: number }[]>,
  opts: { allowPrivateHosts?: boolean } = {},
): Promise<
  | { ok: true; url: URL; addresses: { address: string; family: number }[]; failure: 'none' }
  | { ok: false; reason: string; failure: 'permanent' | 'transient' }
> {
  const uri = checkAgentUri(rawUrl, opts);
  if (!uri.ok) return { ok: false, reason: uri.reason, failure: 'permanent' };
  const url = new URL(uri.url);

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // IP literal in the URL: no resolution needed, check it directly.
  const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  let answers: { address: string; family: number }[];
  if (isLiteral) {
    answers = [{ address: host, family: host.includes(':') ? 6 : 4 }];
  } else {
    try {
      answers = await lookupFn(host);
    } catch (e) {
      // ENOTFOUND/ESERVFAIL establishes nothing about the agent: the card is unavailable.
      return { ok: false, reason: `DNS resolution failed for ${host}: ${(e as Error).message}`, failure: 'transient' };
    }
  }

  if (!answers.length) {
    return { ok: false, reason: `DNS returned no addresses for ${host}`, failure: 'transient' };
  }

  if (!opts.allowPrivateHosts) {
    for (const a of answers) {
      const verdict = isProhibitedAddress(a.address);
      if (verdict.prohibited) {
        return {
          ok: false,
          reason: `${host} resolves to a prohibited destination (${a.address}: ${verdict.reason})`,
          failure: 'permanent',
        };
      }
    }
  }

  return { ok: true, url, addresses: answers, failure: 'none' };
}

/**
 * HTTP GET over a **pinned** destination.
 *
 * `node:http`/`node:https` with a custom `lookup` that always returns the already-validated
 * address, so the DNS answer the check approved is the answer the socket uses. The original
 * hostname is still used for the `Host` header and for TLS SNI/certificate verification
 * (`servername`), so pinning does not break virtual hosting or TLS.
 *
 * Deliberate properties:
 *  - only `http:`/`https:`; the caller validates the URL first
 *  - redirects are never followed (`res.ok` is false for 3xx and the socket is closed)
 *  - the response body is capped at {@link MAX_CARD_BYTES}, enforced while streaming so an
 *    oversized body is never fully buffered
 *  - `timeoutMs` calls `req.destroy()`, so the socket is torn down rather than merely
 *    abandoned — no background request survives the timeout
 *  - proxy environment variables are ignored: this transport never consults them
 */
export async function httpGetPinned(
  rawUrl: string,
  opts: {
    lookup: (hostname: string) => Promise<{ address: string; family: number }[]>;
    timeoutMs?: number;
    maxBytes?: number;
    allowPrivateHosts?: boolean;
  },
): Promise<CardFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CARD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_CARD_BYTES;

  // ONE absolute deadline for the whole lifecycle: DNS, connect, TLS, headers, body.
  // `req.setTimeout` is an *idle* timer that resets on every chunk and does not cover DNS
  // at all, so a slow-drip body or a stuck resolver could outlive it indefinitely.
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadlineAt - Date.now());

  // DNS is raced against the deadline. The OS resolver cannot be aborted (see
  // docs/architecture.md §Limitations), so the late answer is *discarded*: the flag below
  // makes the abandoned promise's continuation a no-op, and the pinned transport is never
  // handed a resolver that can still fire.
  let cancelled = false;
  let dest: Awaited<ReturnType<typeof resolveCardDestination>>;
  // The DNS deadline timer must be *ref'd while pending* — a never-settling resolver promise
  // holds no libuv handle, so an unref'd timer would let Node exit before the deadline fires.
  // It is cleared explicitly once the race settles so it does not keep the process alive.
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    dest = await Promise.race([
      resolveCardDestination(rawUrl, opts.lookup, {
        ...(opts.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error(`card fetch exceeded ${timeoutMs}ms during DNS resolution`)),
          remaining(),
        );
      }),
    ]);
  } catch (e) {
    cancelled = true;
    return {
      ok: false,
      status: 0,
      url: rawUrl,
      bytes: null,
      contentType: null,
      error: (e as Error).message,
      failure: 'transient',
    };
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  // A resolver that answered after the deadline must not start a connection.
  if (cancelled || Date.now() >= deadlineAt) {
    return {
      ok: false,
      status: 0,
      url: rawUrl,
      bytes: null,
      contentType: null,
      error: `card fetch exceeded ${timeoutMs}ms before connecting`,
      failure: 'transient',
    };
  }
  if (!dest.ok) {
    return { ok: false, status: 0, url: rawUrl, bytes: null, contentType: null, error: dest.reason, failure: dest.failure };
  }

  const { url, addresses } = dest;
  const isTls = url.protocol === 'https:';
  const pinned = addresses[0]!;
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;

  return await new Promise<CardFetchResult>(resolve => {
    let settled = false;
    const finish = (r: CardFetchResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const lib = isTls ? httpsMod : httpMod;
    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        // TLS: keep the certificate/SNI check bound to the hostname, not the pinned IP.
        ...(isTls ? { servername: url.hostname } : {}),
        // Pin the socket: every lookup returns the address we already validated.
        // Node calls this with `{all: true}` when it wants the whole answer set, so both
        // shapes must be handled or the connect fails with ERR_INVALID_IP_ADDRESS.
        lookup: (_hostname: string, options: { all?: boolean } | undefined, cb: Function) => {
          if (options?.all) (cb as any)(null, [{ address: pinned.address, family: pinned.family }]);
          else (cb as any)(null, pinned.address, pinned.family);
        },
        // No proxy consultation, no agent multiplexing surprises.
        agent: false,
      },
      res => {
        const status = res.statusCode ?? 0;
        const contentType = (res.headers['content-type'] as string | undefined) ?? null;

        if (status < 200 || status >= 300) {
          res.resume(); // drain and release
          req.destroy();
          finish({
            ok: false,
            status,
            url: url.toString(),
            bytes: null,
            contentType,
            error: `HTTP ${status}`,
            failure: classifyHttpStatus(status),
          });
          return;
        }

        const declared = Number(res.headers['content-length'] ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          req.destroy();
          finish({
            ok: false,
            status,
            url: url.toString(),
            bytes: null,
            contentType,
            error: `declared body ${declared} bytes exceeds the ${maxBytes}-byte card limit`,
            failure: 'permanent',
          });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on('data', (c: Buffer) => {
          if (aborted) return;
          total += c.length;
          if (total > maxBytes) {
            // Cap enforced during streaming: never buffer more than the limit.
            aborted = true;
            res.destroy();
            req.destroy();
            finish({
              ok: false,
              status,
              url: url.toString(),
              bytes: null,
              contentType,
              error: `body ${total} bytes exceeds the ${maxBytes}-byte card limit`,
              failure: 'permanent',
            });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          const bytes = new Uint8Array(Buffer.concat(chunks));
          if (bytes.byteLength === 0) {
            finish({ ok: false, status, url: url.toString(), bytes: null, contentType, error: 'empty body', failure: 'permanent' });
            return;
          }
          finish({ ok: true, status, url: url.toString(), bytes, contentType, error: null, failure: 'none' });
        });
        res.on('error', (e: Error) => {
          if (aborted) return; // the size cap already decided this outcome
          finish({ ok: false, status, url: url.toString(), bytes: null, contentType, error: e.message, failure: 'transient' });
        });
      },
    );

    req.on('error', (e: Error) => {
      const code = (e as NodeJS.ErrnoException).code;
      finish({
        ok: false,
        status: 0,
        url: url.toString(),
        bytes: null,
        contentType: null,
        error: code ? `${code}: ${e.message}` : e.message,
        failure: 'transient',
      });
    });

    // A real abort, not an abandoned promise: destroy() closes the socket.
    // This is the *idle* guard; the absolute deadline below is what bounds the whole call.
    req.setTimeout(remaining(), () => {
      req.destroy(new Error(`card fetch aborted after ${timeoutMs}ms`));
    });

    // Absolute deadline across connect + TLS handshake + headers + body. `setTimeout`
    // does not fire during connect or handshake, and resets on every body chunk, so an
    // explicit timer is the only thing that bounds those phases.
    const deadlineTimer = setTimeout(() => {
      req.destroy(new Error(`card fetch aborted after ${timeoutMs}ms (deadline)`));
    }, remaining());
    deadlineTimer.unref?.();

    const clearDeadline = () => clearTimeout(deadlineTimer);
    req.on('close', clearDeadline);

    req.end();
  });
}

/**
 * Default resolver for the production transport.
 *
 * `all: true` matters: a hostname can return several addresses and the unsafe one may not
 * be first. Returns every answer so {@link resolveCardDestination} can reject the set.
 */
export function defaultLookup(hostname: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as { address: string; family: number }[]);
    });
  });
}

/** Map an HTTP status to how it may be read. */
export function classifyHttpStatus(status: number): 'none' | 'permanent' | 'transient' {
  if (status >= 200 && status < 300) return 'none';
  // Unavailable right now — the publisher is having a bad day, not lying.
  if (status === 408 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  // 3xx: we do not follow redirects, so nothing was served at the claimed location.
  // 400/401/403/404/410: the URI positively does not serve this card.
  return 'permanent';
}

/**
 * Decide whether a registry-supplied `agent_uri` may be fetched at all.
 *
 * The registry is a public, permissionless directory: anyone can register an agent whose
 * `agent_uri` points at `file:///etc/passwd`, `http://127.0.0.1:8545`, or
 * `http://169.254.169.254/latest/meta-data/`. The gateway fetches that URL, so without
 * this check it is a request-forgery primitive driven by untrusted data.
 *
 * Deliberately narrow: https only (plus http for local development), no userinfo, no
 * loopback / private / link-local / unique-local / unspecified targets, no encoded tricks
 * (the URL is parsed, not string-matched, and percent-encoded hosts are rejected).
 */
export function checkAgentUri(
  raw: string,
  opts: { allowPrivateHosts?: boolean } = {},
): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'agent_uri is not a valid absolute URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `agent_uri scheme '${u.protocol}' is not http(s)` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'agent_uri carries userinfo credentials' };
  }
  // Percent-encoded hostnames are a parser-differential smuggling trick, never legitimate.
  if (/%/.test(u.hostname)) {
    return { ok: false, reason: 'agent_uri hostname is percent-encoded' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Operator explicitly running a local registry (dev/test): the literal checks below are
  // skipped, but scheme and userinfo checks always apply.
  if (opts.allowPrivateHosts) return { ok: true, url: u.toString() };

  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, reason: 'agent_uri targets loopback' };
  }
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.home.arpa')) {
    return { ok: false, reason: 'agent_uri targets a private/internal name' };
  }

  // IPv4 and IPv6 literals must be publicly routable.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv =
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224; // multicast + reserved
    if (priv) return { ok: false, reason: `agent_uri targets private/reserved address ${host}` };
  } else if (host.includes(':')) {
    const v6 = host;
    if (
      v6 === '::1' ||
      v6 === '::' ||
      /^f[cd][0-9a-f]{2}:/i.test(v6) || // fc00::/7 unique-local
      /^fe[89ab][0-9a-f]:/i.test(v6) // fe80::/10 link-local
    ) {
      return { ok: false, reason: `agent_uri targets private/reserved IPv6 ${host}` };
    }
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) — re-check the embedded v4.
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mapped) {
      const inner = checkAgentUri(`http://${mapped[1]}/`);
      if (!inner.ok) return { ok: false, reason: `agent_uri targets a mapped private address (${mapped[1]})` };
    }
  }

  return { ok: true, url: u.toString() };
}

/** Fetch raw card bytes. The bytes are returned untouched — no parsing, no re-encoding. */
export async function fetchCardBytes(
  url: string,
  fetchImpl:
    | ((u: string) => Promise<{
        ok: boolean;
        status: number;
        headers?: { get(n: string): string | null };
        arrayBuffer(): Promise<ArrayBuffer>;
      }>)
    | undefined,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    allowPrivateHosts?: boolean;
    /** Resolver used by the pinned transport. Defaults to {@link defaultLookup}. */
    lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  } = {},
): Promise<CardFetchResult> {
  // Injected fetch ⇒ caller owns the transport (tests, fixtures). Default ⇒ the pinned
  // transport, so a real deployment can never fall back to validating a URL and then
  // connecting wherever DNS says.
  if (!fetchImpl) {
    return httpGetPinned(url, {
      lookup: opts.lookup ?? defaultLookup,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
    });
  }
  const maxBytes = opts.maxBytes ?? MAX_CARD_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CARD_TIMEOUT_MS;

  // A URL the registry handed us is untrusted input, not an instruction.
  if (!opts.allowPrivateHosts) {
    const uri = checkAgentUri(url);
    if (!uri.ok) {
      return { ok: false, status: 0, url, bytes: null, contentType: null, error: uri.reason, failure: 'permanent' };
    }
  }
  const target = url;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetchImpl(target),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`card fetch exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const contentType = res.headers?.get?.('content-type') ?? null;
    if (!res.ok) {
      // 4xx at a URI the registry says serves the card: the card is not there.
      // 3xx: we do not follow redirects, so the claim is unproven either way — but a
      // hand-rolled 3xx means the publisher answered instead of serving bytes.
      // 5xx/408/429: the publisher is unavailable right now.
      const transient = res.status >= 500 || res.status === 408 || res.status === 429 || res.status === 0;
      return {
        ok: false,
        status: res.status,
        url: target,
        bytes: null,
        contentType,
        error: `HTTP ${res.status}`,
        failure: transient ? 'transient' : 'permanent',
      };
    }

    // Refuse an oversized body before buffering it.
    const declared = Number(res.headers?.get?.('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false,
        status: res.status,
        url: target,
        bytes: null,
        contentType,
        error: `declared body ${declared} bytes exceeds the ${maxBytes}-byte card limit`,
        failure: 'permanent',
      };
    }

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        status: res.status,
        url: target,
        bytes: null,
        contentType,
        error: `body ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte card limit`,
        failure: 'permanent',
      };
    }
    if (bytes.byteLength === 0) {
      return { ok: false, status: res.status, url: target, bytes: null, contentType, error: 'empty body', failure: 'permanent' };
    }
    return { ok: true, status: res.status, url: target, bytes, contentType, error: null, failure: 'none' };
  } catch (e) {
    const msg = (e as Error).message;
    // A timeout or transport error is an outage, not evidence of misconduct.
    return { ok: false, status: 0, url: target, bytes: null, contentType: null, error: msg, failure: 'transient' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Card validation ──────────────────────────────────────────────────────

export const BADGE_EXTENSION_URI = 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1';
const A2A_REQUIRED = ['name', 'description', 'url', 'version', 'skills'] as const;

export interface CardCheck {
  ok: boolean;
  json: Record<string, any> | null;
  errors: string[];
  warnings: string[];
  parsedFromBytes: boolean;
}

/** Field → the only JSON types accepted for it. A card is a claim document, not free-form. */
const A2A_FIELD_TYPES: Record<string, 'string' | 'array'> = {
  name: 'string',
  description: 'string',
  url: 'string',
  version: 'string',
  skills: 'array',
};

/** Parse and structurally validate a card without modifying the bytes used for hashing. */
export function validateCard(bytes: Uint8Array): CardCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, json: null, errors: ['body is not valid UTF-8'], warnings, parsedFromBytes: false };
  }

  let json: Record<string, any>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, json: null, errors: ['body is valid JSON but not an object'], warnings, parsedFromBytes: false };
    }
    json = parsed as Record<string, any>;
  } catch (e) {
    return { ok: false, json: null, errors: [`body is not valid JSON: ${(e as Error).message}`], warnings, parsedFromBytes: false };
  }

  for (const field of A2A_REQUIRED) {
    if (json[field] === undefined || json[field] === null || json[field] === '') {
      errors.push(`missing required A2A field: ${field}`);
      continue;
    }
    // Presence is not validity: `"name": 12345` is a malformed card, and every field the
    // gateway later compares must have the type the comparison assumes.
    const want = A2A_FIELD_TYPES[field];
    if (want === 'string' && typeof json[field] !== 'string') {
      errors.push(`field '${field}' must be a string (got ${Array.isArray(json[field]) ? 'array' : typeof json[field]})`);
    }
    if (want === 'array' && !Array.isArray(json[field])) {
      errors.push(`field '${field}' must be an array (got ${typeof json[field]})`);
    }
  }
  if (Array.isArray(json.skills) && json.skills.length === 0) warnings.push('skills is empty');

  // `capabilities`, when present, must be an object — otherwise the extension lookup below
  // silently finds nothing and the failure is attributed to the wrong cause.
  if (json.capabilities !== undefined && json.capabilities !== null && typeof json.capabilities !== 'object') {
    errors.push('capabilities must be an object');
  }
  const extensions = json.capabilities?.extensions;
  if (extensions !== undefined && extensions !== null && !Array.isArray(extensions)) {
    errors.push('capabilities.extensions must be an array');
  }

  const badgeExtensions = (Array.isArray(extensions) ? extensions : []).filter(
    (e: any) => e?.uri === BADGE_EXTENSION_URI,
  );
  const ext = badgeExtensions[0];
  if (!ext) {
    errors.push(`missing Concordium badge extension (${BADGE_EXTENSION_URI})`);
  } else {
    if (badgeExtensions.length > 1) {
      // Two badge extensions can claim two different owners or two different tokens.
      // Picking one silently would make the verdict depend on array order.
      errors.push(`card declares ${badgeExtensions.length} Concordium badge extensions (exactly one is allowed)`);
    }
    if (typeof ext !== 'object' || ext === null) errors.push('badge extension is not an object');
    if (ext.params?.tokenAddress === undefined || ext.params?.tokenAddress === null) {
      errors.push('badge extension params.tokenAddress is missing');
    } else if (typeof ext.params.tokenAddress !== 'string') {
      errors.push('badge extension params.tokenAddress must be a string');
    }
    if (!ext.params?.owner?.account) errors.push('badge extension params.owner.account is missing');
    else if (typeof ext.params.owner.account !== 'string') {
      errors.push('badge extension params.owner.account must be a string');
    }
    if (!ext.params?.contracts?.cis8004) errors.push('badge extension params.contracts.cis8004 is missing');
    else if (typeof ext.params.contracts.cis8004 !== 'string') {
      errors.push('badge extension params.contracts.cis8004 must be a string');
    }
  }

  if (json.registrations !== undefined && !Array.isArray(json.registrations)) {
    warnings.push('registrations should be an array (ERC-8004)');
  }

  return { ok: errors.length === 0, json, errors, warnings, parsedFromBytes: true };
}

// ─── Identity comparison ──────────────────────────────────────────────────

/**
 * Compare the card's own identity claims against the registry record.
 * The registry is the authority; the card is the claim being checked.
 */
export function compareCardToRecord(
  card: Record<string, any>,
  record: RegistryRecord,
  expect: ContractExpectation,
): { owner_matches: Verdict; contract_references_match: Verdict; details: Record<string, unknown> } {
  const params = card?.capabilities?.extensions?.find?.((e: any) => e?.uri === BADGE_EXTENSION_URI)?.params;
  const details: Record<string, unknown> = {};

  // owner
  const badgeOwnerCaip = params?.owner?.account as string | undefined;
  const expectedOwnerCaip = `${expect.network}:${record.owner_account}`;
  details.badge_owner = badgeOwnerCaip ?? null;
  details.record_owner = record.owner_account;
  details.expected_owner_caip = expectedOwnerCaip;
  let owner: Verdict;
  if (!badgeOwnerCaip) owner = 'FAIL';
  else if (badgeOwnerCaip === expectedOwnerCaip) owner = 'PASS';
  else owner = 'FAIL';

  // contract references
  const expectedCis8004 = `${expect.network}:${expect.cis8004}`;
  const expectedCis8 = expect.cis8 ? `${expect.network}:${expect.cis8}` : null;
  details.cis8004 = params?.contracts?.cis8004 ?? null;
  details.expected_cis8004 = expectedCis8004;
  details.cis8 = params?.contracts?.cis8 ?? null;
  details.expected_cis8 = expectedCis8;

  const problems: string[] = [];
  if (params?.contracts?.cis8004 !== expectedCis8004) problems.push('cis8004 contract reference mismatch or missing');
  if (expectedCis8 && params?.contracts?.cis8 !== expectedCis8) problems.push('cis8 contract reference mismatch or missing');

  // token address must resolve to the expected token id
  const tokenAddress = params?.tokenAddress as string | undefined;
  details.token_address = tokenAddress ?? null;
  const expectedAsset = `${expect.network}/cis-2:`;
  if (!tokenAddress || !tokenAddress.startsWith(expectedAsset)) {
    problems.push(`tokenAddress is not a ${expectedAsset}… CAIP-19 reference`);
  }

  // registrations entry (ERC-8004)
  const reg = Array.isArray(card?.registrations)
    ? card.registrations.find((r: any) => Number(r?.agentId) === expect.tokenId)
    : undefined;
  details.registration_entry = reg ?? null;
  if (!reg) problems.push('card has no ERC-8004 registrations entry for this token id');
  else if (reg.agentRegistry !== expectedCis8004) problems.push('registrations.agentRegistry does not match the CIS-8004 contract');

  return {
    owner_matches: owner,
    contract_references_match: problems.length === 0 ? 'PASS' : 'FAIL',
    details: { ...details, contract_problems: problems },
  };
}

// ─── Local cryptographic verification ─────────────────────────────────────

/**
 * SHA-256 over the exact bytes served at agent_uri.
 *
 * No canonicalisation, no JSON re-serialisation, no whitespace trimming: the
 * on-chain metadata_hash is the digest of the byte sequence as published.
 * Returns the digest plus the length so a reviewer can reproduce it.
 */
export function localSha256(bytes: Uint8Array): { hex: string; byteLength: number; procedure: string } {
  return {
    hex: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    byteLength: bytes.byteLength,
    procedure: 'sha256(exact response body bytes, no normalisation)',
  };
}

export function compareHashes(localHex: string, record: RegistryRecord): Verdict {
  if (!record.metadata_hash_hex) return 'INCONCLUSIVE';
  const onChain = record.metadata_hash_hex.toLowerCase().replace(/^0x/, '');
  return localHex.toLowerCase() === onChain ? 'PASS' : 'FAIL';
}

// ─── Trust decision ───────────────────────────────────────────────────────

const REQUIRED_CHECKS = [
  'agent_discovered',
  'card_retrieved',
  'card_valid',
  'hash_matches_on_chain',
  'owner_matches',
  'status_active',
  'contract_references_match',
] as const;

/**
 * TRUSTED requires every required check to be PASS.
 * A single FAIL or INCONCLUSIVE yields REJECTED or INCONCLUSIVE respectively — never TRUSTED.
 * `badge_valid` is advisory: a third-party checker disagreeing
 * is recorded but does not by itself override locally-derived evidence.
 *
 * REJECTED is guarded by one invariant: a contradiction can only be established from
 * evidence that was actually obtained. If `card_retrieved` is not PASS, no identity
 * comparison ran against the published card, so nothing about the agent's claims has been
 * contradicted — only that the evidence is missing. Without this guard, a `FAIL` recorded
 * anywhere upstream (or a manually constructed check map) could turn an unreachable
 * endpoint into a fraud verdict.
 */
export function decideTrust(checks: Record<string, Verdict>): TrustDecision {
  const values = REQUIRED_CHECKS.map(k => checks[k] ?? 'NOT_TESTED');
  if (values.some(v => v === 'FAIL')) {
    // No card ⇒ nothing to contradict. Downgrade to INCONCLUSIVE rather than accuse.
    if (checks['card_retrieved'] !== 'PASS') return 'INCONCLUSIVE';
    return 'REJECTED';
  }
  if (values.some(v => v !== 'PASS')) return 'INCONCLUSIVE';
  return 'TRUSTED';
}

export interface VerifyInputs {
  expect: ContractExpectation;
  /** Result of search_agents (already parsed JSON). */
  discoveryPayload: unknown;
  /**
   * Injected fetch for the card. Omit in production so the *pinned* transport is used —
   * a plain `fetch` here would resolve DNS itself and bypass destination pinning.
   */
  fetchImpl?: Parameters<typeof fetchCardBytes>[1];
  /** Optional hosted-verifier result; treated as corroboration only. */
  badge?: BadgeVerification;
  /** Bound on a single card fetch. Defaults to {@link DEFAULT_CARD_TIMEOUT_MS}. */
  cardTimeoutMs?: number;
  /**
   * Permit private/loopback `agent_uri` targets. Off by default — see
   * {@link checkAgentUri}. Only an operator running a local registry may enable this.
   */
  allowPrivateCardHosts?: boolean;
}

/** End-to-end consumer verification. Pure orchestration over injected I/O. */
export async function verifyAgent(inputs: VerifyInputs): Promise<TrustResult> {
  const { expect, discoveryPayload, fetchImpl, badge, cardTimeoutMs, allowPrivateCardHosts } = inputs;
  const evidence: Record<string, unknown> = {};
  const checks: Record<string, Verdict> = {
    agent_discovered: 'NOT_TESTED',
    card_retrieved: 'NOT_TESTED',
    card_valid: 'NOT_TESTED',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'NOT_TESTED',
    owner_matches: 'NOT_TESTED',
    status_active: 'NOT_TESTED',
    contract_references_match: 'NOT_TESTED',
  };

  // 1. discovery
  const disc = parseDiscoveryResponse(discoveryPayload, {
    tokenId: expect.tokenId,
    owner: expect.ownerAccount ?? '',
  });
  evidence.discovery = { found: disc.found, reason: disc.reason, record: disc.record };
  checks.agent_discovered = disc.found ? 'PASS' : 'INCONCLUSIVE';
  if (!disc.record) {
    return finish(checks, evidence);
  }
  const record = disc.record;

  // If the caller declared an expected owner, the registry record must agree with it.
  // A record pointing at a different account is a hard failure: the caller's pin is
  // the stronger claim, and a card that merely agrees with the record proves nothing
  // about the owner the caller actually expects.
  const ownerPinFailed = Boolean(expect.ownerAccount) && record.owner_account !== expect.ownerAccount;
  if (ownerPinFailed) {
    evidence.discovery_owner_mismatch = {
      expected: expect.ownerAccount,
      recorded: record.owner_account,
      verdict: 'FAIL',
    };
  }

  // 2. status
  checks.status_active = record.status === 'Active' ? 'PASS' : record.status === 'Revoked' ? 'FAIL' : 'INCONCLUSIVE';
  evidence.status = record.status;

  // 3. card retrieval
  if (!record.agent_uri) {
    // The registry record omits the pointer to the card. That is a malformed *record*, but
    // it is still an absence of evidence rather than a contradiction of the agent's claims.
    evidence.card = { error: 'registry record has no agent_uri' };
    checks.card_retrieved = 'INCONCLUSIVE';
    return finish(checks, evidence);
  }
  const fetched = await fetchCardBytes(record.agent_uri, fetchImpl, {
    ...(cardTimeoutMs !== undefined ? { timeoutMs: cardTimeoutMs } : {}),
    ...(allowPrivateCardHosts ? { allowPrivateHosts: true } : {}),
  });
  evidence.card = {
    url: fetched.url,
    http_status: fetched.status,
    byte_length: fetched.bytes?.byteLength ?? null,
    content_type: fetched.contentType,
    error: fetched.error,
    failure_class: fetched.failure,
  };
  // Retrieval status is never FAIL. `permanent` here means the endpoint will not serve the
  // card (404/410/3xx/refused URI/oversize) — that is about availability and policy, not
  // about whether the agent's identity claims are true.
  checks.card_retrieved = fetched.ok && fetched.bytes ? 'PASS' : 'INCONCLUSIVE';
  if (!fetched.ok || !fetched.bytes) {
    return finish(checks, evidence);
  }

  // 4. card structure
  const cardCheck = validateCard(fetched.bytes);
  evidence.card_validation = { errors: cardCheck.errors, warnings: cardCheck.warnings };
  checks.card_valid = cardCheck.ok ? 'PASS' : 'FAIL';

  // 5. local hash vs on-chain
  const local = localSha256(fetched.bytes);
  const hashVerdict = compareHashes(local.hex, record);
  evidence.hash = {
    local_sha256: local.hex,
    on_chain_sha256: record.metadata_hash_hex,
    byte_length: local.byteLength,
    procedure: local.procedure,
    verdict: hashVerdict,
  };
  checks.hash_matches_on_chain = hashVerdict;

  // 6/7. identity + contract references (needs a parseable card)
  if (cardCheck.json) {
    const cmp = compareCardToRecord(cardCheck.json, record, expect);
    evidence.identity = cmp.details;
    checks.owner_matches = ownerPinFailed ? 'FAIL' : cmp.owner_matches;
    checks.contract_references_match = cmp.contract_references_match;
  } else {
    checks.owner_matches = 'INCONCLUSIVE';
    checks.contract_references_match = 'INCONCLUSIVE';
  }

  // 8. hosted badge checker — corroboration only
  if (badge?.consulted) {
    evidence.badge = { raw: badge.raw, error: badge.error };
    if (badge.error) checks.badge_valid = 'INCONCLUSIVE';
    else {
      const v = (badge.raw as { badge_valid?: unknown })?.badge_valid;
      checks.badge_valid = v === true ? 'PASS' : v === false ? 'FAIL' : 'INCONCLUSIVE';
    }
  } else {
    checks.badge_valid = 'NOT_TESTED';
  }

  return finish(checks, evidence);
}

/**
 * Checks whose FAIL is a contradiction of supplied evidence.
 *
 * Every one of these can only become FAIL after the gateway has *obtained and read*
 * something — a card, a registry record, an on-chain hash — and found that what it read
 * disagrees with the claim. `card_retrieved` is deliberately absent: it is retrieval
 * status, and retrieval failures are unavailability, never contradiction.
 */
const CONTRADICTION_CHECKS = [
  'card_valid',
  'hash_matches_on_chain',
  'owner_matches',
  'status_active',
  'contract_references_match',
] as const;

function finish(checks: Record<string, Verdict>, evidence: Record<string, unknown>): TrustResult {
  const trustDecision = decideTrust(checks);

  // REJECTED must name the requirement that was contradicted, and must only be reachable
  // through a check that actually examined supplied evidence.
  const failedRequirements = CONTRADICTION_CHECKS.filter(c => checks[c] === 'FAIL') as string[];

  let failureKind: FailureKind;
  if (trustDecision === 'TRUSTED') failureKind = 'none';
  else if (failedRequirements.length > 0) failureKind = 'contradiction';
  else failureKind = 'unavailable';

  return {
    agent_discovered: checks.agent_discovered!,
    card_retrieved: checks.card_retrieved!,
    card_valid: checks.card_valid!,
    badge_valid: checks.badge_valid!,
    hash_matches_on_chain: checks.hash_matches_on_chain!,
    owner_matches: checks.owner_matches!,
    status_active: checks.status_active!,
    contract_references_match: checks.contract_references_match!,
    trust_decision: trustDecision,
    failure_kind: failureKind,
    failed_requirements: failedRequirements,
    evidence,
  };
}
