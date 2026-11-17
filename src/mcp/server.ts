#!/usr/bin/env node
/**
 * agenttrust-mcp — MCP (JSON-RPC 2.0 over stdio) server exposing AgentTrust x402.
 *
 * Transport: newline-delimited JSON-RPC on stdin/stdout, which is what MCP hosts
 * (Claude Desktop, Cursor, Continue, any MCP client) expect for a local server.
 * `content-length` framing is also accepted on input for compatibility with
 * LSP-style clients.
 *
 * Security: MCP is an untrusted input boundary. No tool accepts a filesystem path,
 * URL, shell command, credential, settlement switch, or OperatorAuthorization.
 * See src/mcp/tools.ts for the validation and the invariant.
 *
 *   agenttrust-mcp
 *   AGENTTRUST_AUDIT_ROOT=/tmp/agenttrust-audit agenttrust-mcp
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { TOOLS, callTool, findTool, type ServerConfig } from './tools.js';
import type { ServiceRegistry } from '../discovery/registry.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'agenttrust-gateway', version: '1.0.0' };
const DEFAULT_DISCOVERY_DB = '/home/hatch/agenttrust-state/discovery.db';

/**
 * Lazily open the SQLite-backed discovery registry on first use — never at
 * module load.
 *
 * Why: `node:sqlite` is experimental on Node 22 and its import prints an
 * `ExperimentalWarning` to stderr. The MCP handshake asserts empty stderr, so
 * the SQLite dependency must not load until a discovery tool actually needs
 * it. The import graph is kept clean for the same reason: the in-memory store
 * lives in `../discovery/memoryStore.js` (no SQLite), and this module only
 * ever touches `../discovery/store.js` through the dynamic import below.
 *
 * A single shared promise: concurrent discovery requests awaiting the first
 * open all resolve to the same registry instance; a failed open fails closed
 * to "unconfigured" (the tools answer STORE_UNAVAILABLE) instead of serving
 * an empty or fabricated registry. The outcome — registry or undefined — is
 * cached for the process lifetime.
 */
let discoveryPromise: Promise<ServiceRegistry | undefined> | undefined;
async function getDiscoveryRegistry(): Promise<ServiceRegistry | undefined> {
  if (discoveryPromise === undefined) {
    discoveryPromise = loadDiscoveryRegistry().catch(() => undefined);
  }
  return discoveryPromise;
}

async function loadDiscoveryRegistry(): Promise<ServiceRegistry | undefined> {
  const explicitDb = process.env['AGENTTRUST_DISCOVERY_DB'];
  let dbPath: string | undefined;
  if (explicitDb !== undefined) {
    dbPath = explicitDb;
  } else if (existsSync(dirname(DEFAULT_DISCOVERY_DB))) {
    dbPath = DEFAULT_DISCOVERY_DB;
  }
  if (dbPath === undefined) return undefined;
  const [{ createServiceRegistry }, { SqliteServiceStore }] = await Promise.all([
    import('../discovery/registry.js'),
    import('../discovery/store.js'),
  ]);
  return createServiceRegistry(new SqliteServiceStore(dbPath));
}

/**
 * Registry endpoint is operator configuration (env), never a tool argument.
 * There is no fallback: if the env var is absent the default official registry is
 * used, and no tool can override it.
 */
const config: ServerConfig = {
  registryBase: process.env['AGENTTRUST_REGISTRY_MCP'] ?? 'https://agent-registry-mcp.concordium.com',
  auditRoot: process.env['AGENTTRUST_AUDIT_ROOT'] ?? '/tmp/agenttrust-audit',
  // Off unless the operator says otherwise: a permissionless registry can otherwise point
  // an agent_uri at loopback or cloud metadata. Not reachable from any MCP tool argument.
  allowPrivateCardHosts: process.env['AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS'] === '1',
  getDiscoveryRegistry,
};

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

function reply(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function send(msg: RpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** MCP `tools/call` result envelope: text content, `isError` on failure. */
function toolContent(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handle(req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'AgentTrust x402: discover and independently verify Concordium CIS-8004 agents, evaluate the trust policy, and run trust-gated commerce with a MOCK facilitator. No tool settles, signs, or moves funds, and no tool accepts operator authorization.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
    case 'notifications/roots/list_changed':
    case 'initialized':
      return null;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      // Invalid *params* (unknown tool, non-string name) are protocol errors, per the
      // MCP spec's "Protocol Errors: Unknown tools / Invalid arguments". Input that is
      // invalid for a *known* tool stays a tool result with `isError: true`
      // ("Tool Execution Errors: Invalid input data").
      if (typeof params.name !== 'string') {
        return fail(id, -32602, 'params.name must be a string');
      }
      if (!findTool(params.name)) {
        return fail(id, -32602, `unknown tool: ${params.name.slice(0, 64)}`);
      }
      const out = await callTool(config, params.name, params.arguments ?? {});
      if (out.ok) return reply(id, toolContent(out.result));
      return reply(id, toolContent({ error: out.error }, true));
    }

    default:
      return fail(id, -32601, `method not found: ${String(req.method).slice(0, 64)}`);
  }
}

/**
 * Read newline-delimited JSON, tolerating optional Content-Length framing.
 *
 * JSON-RPC notifications (no `id` member) never receive a response — including
 * unknown ones, which the MCP spec requires to be silent. Sending a reply with
 * `id: null` for a notification corrupts the peer's request/response pairing.
 */
function startStdio(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    const text = line.trim();
    if (!text || /^content-length:/i.test(text) || /^content-type:/i.test(text)) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      send(fail(null, -32700, 'parse error'));
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      send(fail(req.id ?? null, -32600, 'invalid request'));
      return;
    }
    // JSON-RPC: a request is a *notification* only when it has no `id` member at all.
    // An explicit `id: null` is still a request and must be answered.
    const isNotification = !('id' in req);
    void handle(req)
      .then(res => {
        if (res && !isNotification) send(res);
      })
      .catch(e => {
        // Never leak a stack trace across the boundary.
        if (isNotification) return;
        send(fail(req.id ?? null, -32603, String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 200)));
      });
  });
}

startStdio();
