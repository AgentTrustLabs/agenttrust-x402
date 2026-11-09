# TASK 19 — MCP Protocol Compatibility & Interoperability

Date: 2026-11-05 · Compatibility hardening of the existing MCP server against the official
MCP TypeScript SDK client. Two protocol defects found and fixed; no tool added, removed, or
re-specified. Zero transactions, zero signing, zero settlement.

---

## VERIFIED

### V1 — Baseline inspection (before any change)

Read: `src/mcp/server.ts` (137 lines), `src/mcp/tools.ts` (837), `test/task08-mcp-interface.test.mts`
(916), `package.json`, `docs/MCP-GUIDE.md` (352).

| Aspect | Baseline behavior |
|---|---|
| Handshake | `initialize` → `{protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo, instructions}` |
| Version negotiation | **Static**: always answers `2024-11-05`, ignores `params.protocolVersion` |
| Client capability handling | Ignored entirely (none are needed — no sampling/roots/elicitation used) |
| `tools/list` | 6 tools, `{name, description, inputSchema}`; no `nextCursor`, no pagination |
| `tools/call` | Fixed envelope: `{content:[{type:'text',text:JSON}], isError?:true}` |
| JSON-RPC errors | `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32603` handler throw |
| Notifications | `notifications/initialized` and bare `initialized` → `null` (silent) |
| Shutdown | stdin close → process exits 0 |
| stdout/stderr | Only `process.stdout.write` in `send()`; no `console.*` anywhere in `src/mcp` |

Internal tests were green (38/38) at baseline. That is exactly why the task said not to trust
them: **three protocol violations survived a fully green suite.** See V3.

### V2 — Official SDK client interoperability (before fixes)

`@modelcontextprotocol/sdk` **1.32.2** installed as a devDependency (engines `node >=18`;
project runs Node 26.7.0, declared `>=20` — compatible). The SDK's
`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`
includes the server's pinned version, so negotiation succeeds.

Probed with a real `StdioClientTransport` against `dist/mcp/server.js`:

```console
negotiated: { name: 'agenttrust-gateway', version: '1.0.0' }
tools: registry.search,registry.card,trust.verify,trust.policy,commerce.simulate,audit.verify
serverCapabilities => {"tools":{}}
unknownTool => {content:[…"unknown tool 'nope.nope'"…], isError:true}   ← WRONG, see D1
```

Handshake, `tools/list`, schemas, and every tool call already worked. The defects were in the
**error and notification paths** — precisely the ones internal tests asserted the wrong way.

### V3 — Defects found (all reproduced before fixing)

#### D1 — Unknown tool returned a tool result instead of a protocol error

MCP specification, *Tools § Error Handling*:

> **Protocol Errors**: Standard JSON-RPC errors for issues like: **Unknown tools**, Invalid
> arguments, Server errors. […] **Tool Execution Errors**: Reported in tool results with
> `isError: true`: API failures, **Invalid input data**, Business logic errors.

Baseline returned `result.isError: true` with `{"code":"INVALID_INPUT","message":"unknown tool 'x'"}`.

```console
$ echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"does.not.exist"}}' | node dist/mcp/server.js
{"jsonrpc":"2.0","id":1,"result":{"content":[…],"isError":true}}      ← baseline
```

The official SDK's own server throws `McpError(ErrorCode.InvalidParams, 'Tool … not found')` for the
same situation (`@modelcontextprotocol/sdk/dist/esm/server/mcp.js:154`), so a client written against
that server expects `-32602`. Returning `isError` here makes an unknown-tool call look like a
*successful* tool invocation to clients that surface protocol errors distinctly — it hides a
client-side naming bug behind a "tool responded with an error" message.

**Fixed:** unknown tool → `-32602`. Same for `tools/call` with a non-string `params.name`, which
was previously also an `isError` result.

#### D2 — Notifications received responses (protocol stream corruption)

JSON-RPC 2.0 and the MCP spec: a message without an `id` member is a **notification** and MUST NOT
be answered. The server answered every unhandled notification with `{"id":null,"error":{…-32601}}`:

```console
NOTIFY notifications/cancelled -> 1 response(s): {"jsonrpc":"2.0","id":null,"error":{"code":-32601,…}}
NOTIFY notifications/progress  -> 1 response(s): {"jsonrpc":"2.0","id":null,"error":{"code":-32601,…}}
NOTIFY unknown/notification    -> 1 response(s): {"jsonrpc":"2.0","id":null,"error":{"code":-32601,…}}
NOTIFY ping (as notification)  -> 1 response(s): {"jsonrpc":"2.0","id":null,"result":{}}
```

Real clients *do* send these: aborting a tool call makes the official SDK emit
`notifications/cancelled`; progress is emitted by any long-running client. The SDK tolerated the
stray `id:null` reply (verified: the client stayed usable afterwards), so this did not break the
tested client — but it is a spec violation and a landmine for stricter clients that key a response
map on `id` and treat `null` as a request id.

**Fixed:** any message without an `id` member is treated as a notification, and no response is
written for it — including the `catch` path, so a throwing notification handler cannot emit
`-32603` either.

#### D3 — `notifications/cancelled` and `notifications/progress` were unhandled (consequence of D2)

Now explicitly recognised (`notifications/initialized`, `notifications/cancelled`,
`notifications/progress`, `notifications/roots/list_changed`). They are acknowledged by silence,
which is what the spec asks for — the server cannot actually cancel a tool mid-flight, and says so
in §9 of the guide rather than pretending.

#### D4 — Green-but-wrong test assertion (pre-existing)

`test/task08-mcp-interface.test.mts:749` asserted `parsed[3].result.isError === true` for
`tools/call` with no name — encoding D1's bug as the expected behavior. Corrected to `-32602`.
This is the documented reason not to trust a green suite: the test was written against the
implementation instead of the spec.

### V4 — Fixes applied (2 files of source, minimal)

`src/mcp/server.ts`:

```diff
-import { TOOLS, callTool, type ServerConfig } from './tools.js';
+import { TOOLS, callTool, findTool, type ServerConfig } from './tools.js';

     case 'notifications/initialized':
+    case 'notifications/cancelled':
+    case 'notifications/progress':
+    case 'notifications/roots/list_changed':
     case 'initialized':
       return null;

     case 'tools/call': {
       const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
       if (typeof params.name !== 'string') {
-        return reply(id, toolContent({ code: 'INVALID_INPUT', message: 'params.name must be a string' }, true));
+        return fail(id, -32602, 'params.name must be a string');
+      }
+      if (!findTool(params.name)) {
+        return fail(id, -32602, `unknown tool: ${params.name.slice(0, 64)}`);
       }
       const out = await callTool(config, params.name, params.arguments ?? {});
```

```diff
+    // JSON-RPC: a request is a *notification* only when it has no `id` member at all.
+    // An explicit `id: null` is still a request and must be answered.
+    const isNotification = !('id' in req);
     void handle(req)
       .then(res => {
-        if (res) send(res);
+        if (res && !isNotification) send(res);
       })
       .catch(e => {
+        if (isNotification) return;
         send(fail(req.id ?? null, -32603, …));
       });
```

**What deliberately did not change:** the six tool names, their descriptions, `inputSchema`s, the
`{content:[…], isError}` envelope for tool errors, the 8 KiB cap, `assertNoForbiddenFields`,
`REJECTED_FIELDS`, `DENY_ALL_FACILITATOR`, `toToolError`'s one-line 300-char reduction, the
`audit.verify` bare-filename confinement, and the stdout-only-JSON-RPC invariant. No tool was
added; no architecture was replaced.

`test/task08-mcp-interface.test.mts`: assertion corrected (D4) + new test 39 locking notification
silence.

### V5 — New interoperability suite: `test/task19-mcp-interop.test.mjs`

12 tests, offline, ~3 s. Launches the **real compiled server** as a child process via
`StdioClientTransport`, with a local `http` stub standing in for the registry and the agent card
host — so it is deterministic, needs no Concordium node, and never touches a facilitator.

```console
$ node test/task19-mcp-interop.test.mjs
  ok   01. the official client completes the initialize handshake
  ok   02. the negotiated protocol version is one the client supports
  ok   03. a newer requested version is answered with the server version, not an error
  ok   04. tools/list returns exactly the six existing tools
  ok   05. every input schema is a usable JSON Schema object for the official client
  ok   06. a successful trust.verify returns a valid MCP tool result
  ok   07. a rejected trust result is reported as a result and never grants access
  ok   08. invalid tool input produces a valid protocol-level error
  ok   09. notifications never corrupt the protocol stream
  ok   10. graceful shutdown closes the client and leaves no stray process
  ok   11. the authorization boundary holds through the official client
  ok   12. commerce.simulate never settles, through the official client

task19-mcp-interop: 12/12 passed
```

Coverage against the ten mandated checks:

| # | Mandated check | Test | Evidence |
|---|---|---|---|
| 1 | Initialize handshake succeeds | 01 | `getServerVersion()` → `agenttrust-gateway` 1.0.0; empty stderr |
| 2 | Negotiated version is valid | 02, 03 | SDK accepted `2024-11-05`; a `2025-06-18` request is answered `2024-11-05`, no error |
| 3 | Client receives server capabilities | 01 | `getServerCapabilities()` → `{"tools":{}}` |
| 4 | `tools/list` returns exactly six | 04 | names + order asserted verbatim |
| 5 | Schemas usable by official client | 05 | `type:'object'`, `properties`, non-empty `required`, `additionalProperties:false` |
| 6 | Successful `trust.verify` is a valid result | 06 | `content[0].type==='text'`, `isError` absent, `TRUSTED`, `hash_matches_on_chain: PASS` |
| 7 | Rejected trust represented correctly, no access | 07 | hash mismatch → `REJECTED`, `isError` **absent** (a verdict is data), policy `allowed:false` |
| 8 | Invalid input → valid protocol-level error | 08 | unknown tool `code:-32602`; known-tool bad input `isError:true`; client still pingable |
| 9 | Notifications do not corrupt the stream | 09 | 4 notifications + 1 request → **exactly 1** response, on the request's id |
| 10 | Graceful shutdown | 10 | child pid gone after `client.close()` |

Test 09 verifies D2's fix at the wire level; test 08 verifies D1's fix through the SDK's error
surface (`threw.code === -32602`).

### V6 — Regression verification

```console
$ npm run build          → tsc, exit 0, dist/ emitted
$ npm run typecheck      → tsc --noEmit, exit 0
$ npm test               → all suites passed
```

| Suite | Result |
|---|---|
| finding-1-faucet | 6/6 |
| finding-2-account-derivation | 7/7 |
| finding-3-agent-card | 11/11 |
| finding-4-wallet-serialization | 10/10 |
| regression-bytes | 9/9 |
| task03-cli-contract | 11/11 |
| task03-discovery-and-trust | 47/47 |
| task04-sdk-conformance | 15/15 |
| task04-x402-exact | 44/44 |
| task05-commerce | 36/36 |
| task06-audit-integrity | 25/25 |
| task06.1-lock-hardening | 14/14 |
| task07-facilitator-readiness | 30/30 |
| task08-mcp-interface | **39/39** (was 38, +1 for notification silence) |
| task10-packaging | 14/14 |
| task11-secret-hardening | 14/14 |
| task12-repo-hygiene | 11/11 |
| task14-audit-strictness | 18/18 |
| task15-packaging | 13/13 |
| task19-mcp-interop | **12/12** (new) |
| **Total** | **20 suites · 772/772 tests** |

Existing verification CLI, commerce simulation, and the end-to-end demo:

```console
$ node dist/cli/verify.js --help                → exit 0
$ node dist/cli/commerce.js --token-id 1004
  trust policy               ALLOWED
  payment requirement        250000 microCCD CCD
  facilitator (MOCK)         verify, settle
  settlement                 SIMULATED — not on chain
  access granted             true
  NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO KEY USED

$ node scripts/task08-demo.mjs
  tools                6
  trust                TRUSTED
  second agent 19      REJECTED (live third-party)
  success              access_granted settled=false (SIMULATED)
  audit verified       3/3
  forged auth          AUTHORIZATION_NOT_ACCEPTED
  shutdown             exit 0, stderr clean
  NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED
```

**On-chain state, unchanged across the whole task:**

```console
$ getAccountInfo 4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d
nonce 4   balance 19943619923 microCCD (19 943.619923 CCD)
```

Identical to TASK 02's post-registration state. **Zero transactions submitted, zero signing, zero
facilitator settlement.**

The audit trails written by the demo/CLI were restored with `git checkout` after each run so no
historical evidence was rewritten — verified with `scripts/task06-verify-trails.mts
docs/evidence/task05` → `ALL TRAILS VERIFIED`.

### V7 — Documentation

`docs/MCP-GUIDE.md` updated only where behavior or compatibility genuinely changed:

- §2 Requirements — the SDK is a devDependency used by the interop suite; the server does not
  depend on it.
- §3 — "Verified" note now names the official SDK 1.32.2 and points at §7a.
- §6 — new **Error reporting: protocol errors vs tool errors** table, including the explicit
  statement that a `REJECTED`/`INCONCLUSIVE` verdict is a normal result, not an error.
- §7a (new) — supported protocol version, downgrade behavior, capabilities, what the SDK test does
  and does not prove.
- §9 Known limitations — four new entries (pinned version, no `outputSchema`/structuredContent,
  no progress/cancellation/logging, no `listChanged`).

---

## FILES CHANGED

| File | Change |
|---|---|
| `src/mcp/server.ts` | +2 notification cases, `-32602` for unknown/invalid tool params, notification silence |
| `test/task08-mcp-interface.test.mts` | assertion corrected (D4), +test 39 (notification silence) |
| `test/task12-repo-hygiene.test.mts` | `tar --exclude=.git` — the tree is now a git repo, so the staging mirror must not copy `.git` |
| `test/task19-mcp-interop.test.mjs` | **new**, 12 SDK interoperability tests |
| `package.json` | `@modelcontextprotocol/sdk ^1.32.2` added to `devDependencies` |
| `package-lock.json` | lockfile updated for that devDependency |
| `docs/MCP-GUIDE.md` | §2, §3, §6, §7a new, §9 |

No application logic changed outside `src/mcp/server.ts`. No tool surface changed.

---

## NOT TESTED

- **Third-party host UIs** — Claude Desktop, Cursor, Continue were not driven. The claim is
  "conforms to the MCP protocol as implemented by the official SDK", not "works in <host>".
- **HTTP/SSE transport** — stdio only, unchanged, unsupported.
- **Protocol versions newer than `2024-11-05`** — a `2025-06-18` request negotiates *down*
  successfully, but the server does not implement that revision's features
  (`outputSchema`/`structuredContent`, elicitation, tasks, `listChanged`).
- **Cancellation actually aborting work** — `notifications/cancelled` is accepted silently; the
  in-flight tool call still runs to completion or its 30 s timeout. No test claims otherwise.
- **Load/stress** — concurrency remains proven only for two writers (TASK 06.1).

## BLOCKED

Nothing. No defect required a replacement architecture; both fixes were local to the dispatch and
transport layers of `src/mcp/server.ts`, which is what the task's constraint anticipated.

---

## FINAL VERDICT

**INTEROPERABLE with the official MCP client, after two spec fixes.**

The server already completed handshakes and served all six tools to `@modelcontextprotocol/sdk`
1.32.2 before any change. What a green internal suite had hidden was that it reported **unknown
tools as successful tool results** rather than `-32602`, and **answered notifications**, which the
JSON-RPC spec forbids and which real clients trigger on every cancelled or long-running call.

Both were fixed in `src/mcp/server.ts` in ~15 lines, with the security boundaries untouched: the
8 KiB cap, the forbidden-field scan that refuses `OperatorAuthorization`, the absence of any
signing or settlement path, and stdout carrying nothing but JSON-RPC all still hold and are now
additionally proven *through the official client* rather than through hand-rolled JSON.

Twelve new interoperability tests run offline against the real compiled server with a local
registry stub; 772/772 tests pass across 20 suites; typecheck and build are clean; the CLI,
commerce simulation, and demo are unchanged in behavior; the account nonce is still 4 and the
balance is still 19 943.619923 CCD, so nothing was signed, settled, or submitted.
