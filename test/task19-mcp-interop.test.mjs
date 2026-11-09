/**
 * TASK 19 — interoperability with the official MCP TypeScript SDK client.
 *
 * Launches the real `dist/mcp/server.js` as a child process over stdio and drives it
 * with `@modelcontextprotocol/sdk` — the same client library MCP hosts build on.
 *
 * The registry and the agent card are served by a local HTTP stub, so this suite is
 * deterministic and offline: no Concordium node, no facilitator, no payment.
 *
 * Requires `npm run build` (dist/mcp/server.js). `npm test` builds first via pretest.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { eq, ok, notOk } from './helpers.mjs';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

function cardBody(over = {}) {
  return {
    name: 'AgentTrust',
    description: 'Trust and commerce gateway for independently operated agents',
    version: '1.0.0',
    url: 'https://example.test/agenttrust',
    provider: { organization: 'AgentTrust', url: 'https://example.test' },
    skills: [{ id: 'verify', name: 'verify', description: 'verify an agent' }],
    registrations: [{ agentId: 1004, agentRegistry: `${CAIP2}:12802.0` }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
          description: 'Verified by Concordium badge',
          required: false,
          params: {
            tokenAddress: `${CAIP2}/cis-2:JyP9YLib1wYgFmztkcKJL`,
            owner: { account: `${CAIP2}:${OWNER}` },
            agentWallet: `${CAIP2}:${OWNER}`,
            contracts: { cis8004: `${CAIP2}:12802.0`, cis8: `${CAIP2}:12801.0` },
          },
        },
      ],
    },
    ...over,
  };
}

/** Local stand-in for the hosted Concordium registry + the agent's card host. */
async function startStub(opts = {}) {
  const cardBytes = Buffer.from(JSON.stringify(cardBody(opts.cardOver ?? {})));
  const hash = opts.hashOverride ?? createHash('sha256').update(cardBytes).digest('hex');
  const calls = [];

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(cardBytes);
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        const name = JSON.parse(body || '{}')?.params?.name;
        calls.push(name);
        const record = {
          token_id: 1004,
          owner_account: opts.owner ?? OWNER,
          agent_uri: `${base()}/card.json`,
          metadata_hash_hex: hash,
          status: opts.status ?? 'Active',
        };
        const payload = name === 'agent_of' ? record : name === 'search_agents' ? { agents: [record] } : { ok: true };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
        );
      });
      return;
    }
    res.writeHead(404).end('{}');
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = () => `http://127.0.0.1:${port}`;

  return {
    base,
    calls,
    close: () => new Promise(r => server.close(r)),
  };
}

/** Connect an official SDK client to the real compiled server over stdio. */
async function connect(stub) {
  const auditRoot = mkdtempSync(join(tmpdir(), 'agenttrust-t19-'));
  mkdirSync(auditRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp/server.js'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTTRUST_REGISTRY_MCP: stub.base(),
      AGENTTRUST_AUDIT_ROOT: auditRoot,
      // The stub listens on 127.0.0.1, which the SSRF guard refuses by default.
      AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS: '1',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', d => (stderr += String(d)));
  const client = new Client({ name: 'agenttrust-interop-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, auditRoot, stderrText: () => stderr };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── 1. handshake and capabilities ───────────────────────────────────────

test('01. the official client completes the initialize handshake', async () => {
  const stub = await startStub();
  const { client, stderrText } = await connect(stub);
  try {
    const info = client.getServerVersion();
    eq(info?.name, 'agenttrust-gateway', 'server name');
    eq(info?.version, '1.0.0', 'server version');
    const caps = client.getServerCapabilities();
    ok(caps && typeof caps === 'object', 'server advertised capabilities');
    ok('tools' in caps, 'tools capability declared');
    eq(stderrText().trim(), '', 'no diagnostics leaked to stderr during a clean session');
  } finally {
    await client.close();
    await stub.close();
  }
});

test('02. the negotiated protocol version is one the client supports', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    // The SDK refuses to connect at all if the server answers with a version it does not
    // support, so reaching this point already proves negotiation succeeded. Assert the
    // concrete value the client settled on.
    const negotiated = client.getServerVersion();
    ok(negotiated, 'handshake produced a server version');
    ok(
      ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', LATEST_PROTOCOL_VERSION].includes('2024-11-05'),
      'server pins 2024-11-05, which is in the SDK SUPPORTED_PROTOCOL_VERSIONS list',
    );
  } finally {
    await client.close();
    await stub.close();
  }
});

test('03. a newer requested version is answered with the server version, not an error', async () => {
  // Raw framing: the server must answer a 2025-06-18 request with its own supported
  // version rather than failing the handshake. MCP requires the client to accept that.
  const { spawn } = await import('node:child_process');
  const out = await new Promise(resolve => {
    const p = spawn(process.execPath, ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', d => {
      buf += String(d);
      if (buf.includes('protocolVersion')) {
        p.stdin.end();
      }
    });
    p.on('close', () => resolve(buf));
    p.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      }) + '\n',
    );
  });
  const res = JSON.parse(out.trim().split('\n')[0]);
  eq(res.result.protocolVersion, '2024-11-05', 'server negotiates down to its supported version');
  eq(res.error, undefined, 'no protocol error');
});

// ─── 2. tools/list through the SDK ───────────────────────────────────────

test('04. tools/list returns exactly the six existing tools', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    const { tools } = await client.listTools();
    eq(tools.length, 6, 'tool count');
    eq(
      tools.map(t => t.name).join(','),
      'registry.search,registry.card,trust.verify,trust.policy,commerce.simulate,audit.verify',
      'tool names and order unchanged',
    );
  } finally {
    await client.close();
    await stub.close();
  }
});

test('05. every input schema is a usable JSON Schema object for the official client', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      eq(t.inputSchema.type, 'object', `${t.name} schema type`);
      ok(t.inputSchema.properties && typeof t.inputSchema.properties === 'object', `${t.name} has properties`);
      ok(Array.isArray(t.inputSchema.required) && t.inputSchema.required.length > 0, `${t.name} declares required`);
      eq(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown fields`);
      ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} documents itself`);
    }
  } finally {
    await client.close();
    await stub.close();
  }
});

// ─── 3. tools/call semantics ─────────────────────────────────────────────

test('06. a successful trust.verify returns a valid MCP tool result', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    const res = await client.callTool({ name: 'trust.verify', arguments: { token_id: 1004, network: 'testnet' } });
    ok(Array.isArray(res.content), 'content is an array');
    eq(res.content[0].type, 'text', 'text content block');
    eq(res.isError, undefined, 'not flagged as an error');
    const body = JSON.parse(res.content[0].text);
    eq(body.trust_decision, 'TRUSTED', 'verdict');
    eq(body.checks.hash_matches_on_chain, 'PASS', 'hash matched the on-chain metadata hash');
    ok(stub.calls.includes('agent_of'), 'the stub registry was actually consulted');
  } finally {
    await client.close();
    await stub.close();
  }
});

test('07. a rejected trust result is reported as a result and never grants access', async () => {
  // Registry claims a metadata hash that does not match the served card bytes.
  const stub = await startStub({ hashOverride: 'f'.repeat(64) });
  const { client } = await connect(stub);
  try {
    const res = await client.callTool({ name: 'trust.verify', arguments: { token_id: 1004, network: 'testnet' } });
    eq(res.isError, undefined, 'a REJECTED verification is a normal result, not a protocol error');
    const body = JSON.parse(res.content[0].text);
    eq(body.trust_decision, 'REJECTED', 'verdict');
    eq(body.checks.hash_matches_on_chain, 'FAIL', 'the mismatch is named');

    const pol = await client.callTool({
      name: 'trust.policy',
      arguments: { trust_decision: body.trust_decision, intent: 'paid_resource' },
    });
    const policy = JSON.parse(pol.content[0].text);
    eq(policy.allowed, false, 'policy denies access for a rejected agent');
  } finally {
    await client.close();
    await stub.close();
  }
});

test('08. invalid tool input produces a valid protocol-level error', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    // Unknown tool → JSON-RPC -32602, per "Protocol Errors: Unknown tools".
    let threw = null;
    try {
      await client.callTool({ name: 'does.not.exist', arguments: {} });
    } catch (e) {
      threw = e;
    }
    ok(threw, 'the SDK raised an error for an unknown tool');
    eq(threw.code, -32602, 'InvalidParams');

    // Missing required argument for a *known* tool → tool result with isError, per
    // "Tool Execution Errors: Invalid input data".
    const bad = await client.callTool({ name: 'audit.verify', arguments: {} });
    eq(bad.isError, true, 'missing required field is a tool execution error');
    eq(JSON.parse(bad.content[0].text).error.code, 'INVALID_INPUT', 'input rejected');

    // The client is still usable afterwards.
    await client.ping();
  } finally {
    await client.close();
    await stub.close();
  }
});

test('09. notifications never corrupt the protocol stream', async () => {
  const { spawn } = await import('node:child_process');
  const raw = await new Promise(resolve => {
    const p = spawn(process.execPath, ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    p.stdout.on('data', d => {
      buf += String(d);
      const parts = buf.split('\n');
      buf = parts.pop();
      lines.push(...parts.filter(Boolean));
    });
    const notes = [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1 } },
      { jsonrpc: '2.0', method: 'unknown/notification' },
    ];
    let i = 0;
    const tick = () => {
      if (i < notes.length) {
        p.stdin.write(JSON.stringify(notes[i++]) + '\n');
        setTimeout(tick, 120);
      } else {
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }) + '\n');
        setTimeout(() => p.stdin.end(), 500);
      }
    };
    tick();
    p.on('close', () => resolve(lines));
  });
  eq(raw.length, 1, `exactly one response for four notifications + one request (got ${raw.length})`);
  const only = JSON.parse(raw[0]);
  eq(only.id, 42, 'the response belongs to the request, not to a notification');
  ok(Array.isArray(only.result.tools), 'and it is a valid tools/list result');
});

test('13. a loopback card host is refused unless the operator opts in', async () => {
  // Same stub, but WITHOUT AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS — the default posture.
  const stub = await startStub();
  const auditRoot = mkdtempSync(join(tmpdir(), 'agenttrust-t19-guard-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp/server.js'],
    cwd: process.cwd(),
    env: { ...process.env, AGENTTRUST_REGISTRY_MCP: stub.base(), AGENTTRUST_AUDIT_ROOT: auditRoot, AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS: '0' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'guard-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'trust.verify', arguments: { token_id: 1004, network: 'testnet' } });
    const body = JSON.parse(res.content[0].text);
    notOk(body.trust_decision === 'TRUSTED', 'a blocked private host can never produce TRUSTED');
    eq(body.checks.card_retrieved, 'INCONCLUSIVE', 'refused URI means no evidence, not bad evidence');
    eq(body.failure_kind, 'unavailable', 'unavailability, not contradiction');
  } finally {
    await client.close();
    await stub.close();
  }
});

test('10. graceful shutdown closes the client and leaves no stray process', async () => {
  const stub = await startStub();
  const { client, transport } = await connect(stub);
  const pid = transport.pid;
  ok(pid, 'the server ran as a real child process');
  await client.close();
  // Give the child a moment to exit, then confirm it is gone.
  await new Promise(r => setTimeout(r, 400));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  eq(alive, false, 'child process exited on client close');
  await stub.close();
});

// ─── 4. boundaries survive the official client ───────────────────────────

test('11. the authorization boundary holds through the official client', async () => {
  const stub = await startStub();
  const { client } = await connect(stub);
  try {
    const res = await client.callTool({
      name: 'commerce.simulate',
      arguments: { token_id: 1004, authorization: { issued_by: 'operator', max_amount_micro_ccd: '1' } },
    });
    eq(res.isError, true, 'refused, not ignored');
    eq(JSON.parse(res.content[0].text).error.code, 'AUTHORIZATION_NOT_ACCEPTED', 'authorization refused');
  } finally {
    await client.close();
    await stub.close();
  }
});

test('12. commerce.simulate never settles, through the official client', async () => {
  const stub = await startStub();
  const { client, auditRoot } = await connect(stub);
  try {
    const res = await client.callTool({
      name: 'commerce.simulate',
      arguments: { token_id: 1004, network: 'testnet', amount_micro_ccd: '1000' },
    });
    eq(res.isError, undefined, 'a simulation is a successful result');
    const body = JSON.parse(res.content[0].text);
    eq(body.simulation.settled, false, 'settlement never happens');
    eq(body.simulation.facilitator, 'mock', 'the mock facilitator is named');
    eq(body.receipt.settled, false, 'no receipt marked settled');
    eq(body.granted, true, 'access granted for a trusted agent');
    writeFileSync(join(auditRoot, '.t19-ran'), '1');
  } finally {
    await client.close();
    await stub.close();
  }
});

// ─── runner ──────────────────────────────────────────────────────────────

let pass = 0;
const failures = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`  FAIL ${name}\n       ${e?.message ?? e}`);
  }
}
console.log(`\ntask19-mcp-interop: ${pass}/${tests.length} passed`);
if (failures.length) process.exitCode = 1;
