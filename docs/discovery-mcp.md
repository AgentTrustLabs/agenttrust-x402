# Discovery MCP readiness — interface design (not yet built)

This document designs the minimal MCP interface for the Discovery API.
No MCP integration is built yet. The interface is designed first so that,
when it is built, each tool is a thin, strictly-validated adapter over the
existing registry module — following the pattern in `src/mcp/tools.ts`
(no business logic in the tool, bounded inputs, bounded errors).

## Tools

### `discover_services`

Find API services an agent can use. Read-only.

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 512 },
    "category": { "type": "string", "enum": ["data", "compute", "content", "communication", "utility", "other"] },
    "network": { "type": "string", "enum": ["testnet"] },
    "status": { "type": "string", "enum": ["active", "inactive", "all"] },
    "limit": { "type": "integer", "minimum": 1, "maximum": 25 }
  },
  "required": [],
  "additionalProperties": false
}
```

**Behaviour:** a thin adapter over `registry.list()` with the same
filters as `GET /api/services` (`q` ← `query`, `category`, `network`,
`status`, `limit`). Default `status` is `active`, default `limit` is 10
(the MCP search limit in `src/mcp/tools.ts`).

**Output:** the same shape as the HTTP list response:

```json
{
  "services": [ { "id": "...", "name": "...", "category": "...", "endpoint": "...", "provider": { "tokenId": 1004, "ownerAccount": "...", "agentUri": "..." }, "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27", "pricing": { "amountMicroCcd": "10", "asset": "CCD", "payTo": "...", "maxTimeoutSeconds": 300 }, "status": "active", "available": true, "providerVerification": { "status": "registered" }, "paymentRequirements": { "scheme": "exact", "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27", "asset": "CCD", "amount": "10", "payTo": "...", "maxTimeoutSeconds": 300, "extra": {} } } ],
  "total": 1,
  "filters": { "status": "active", "limit": 10 }
}
```

### `get_service_details`

Fetch one service by id. Read-only.

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "service_id": { "type": "string", "minLength": 1, "maxLength": 64 }
  },
  "required": ["service_id"],
  "additionalProperties": false
}
```

**Behaviour:** a thin adapter over `registry.get(id)` + `toServiceView()`.
Unknown id returns a bounded `INVALID_INPUT`-style error
(`service not found`), not an empty result.

**Output:** the same shape as `GET /api/services/:id` — one service view,
including `pricing`, `providerVerification`, and `paymentRequirements`
when the service is active.

## Security posture (same as the existing MCP tools)

- **No business logic in the tool.** The tool validates inputs and calls
  the registry; the registry owns validation, filtering, and the
  verification-status model.
- **Bounded inputs.** `maxStringLength` 512, `maxSearchLimit` 25,
  `maxInputBytes` 8 KiB — the same `LIMITS` as `src/mcp/tools.ts`.
- **Closed enums.** `network` is `testnet` only; `category` and `status`
  are enumerated. Anything else is `UNSUPPORTED_NETWORK` /
  `INVALID_INPUT`, never a silent default.
- **No forbidden fields.** The shared `assertNoForbiddenFields` rejects
  operator-only fields (`authorization`, `private_key`, `seed`, `url`,
  `endpoint`, `settle`, …). A client cannot supply an endpoint, a
  registry URL, or a settlement switch through these tools.
- **No settlement.** Neither tool can pay, settle, or construct a
  transaction. `discover_services` and `get_service_details` only *read*
  prices and requirements. Payment still goes through the normal x402
  flow (402 → `X-PAYMENT` → 200) outside MCP.
- **No trust fabrication.** The tools surface `providerVerification`
  exactly as stored (`registered` / `verified` / `rejected` /
  `unverified`). They never compute a reputation or a trust score, and
  they never upgrade `registered` to `verified`.

## What is deliberately NOT built yet

- **No registration tool.** Writing to the registry is an operator action.
  A `register_service` tool would need operator authorization, which MCP
  deliberately cannot accept (`AUTHORIZATION_NOT_ACCEPTED`). Registration
  stays operator-side until that authorization model is designed.
- **No verification tool.** Running `verifyAgent` over MCP would let a
  client choose the registry payload and the fetch target. Verification
  stays operator-side (or inside `trust.verify`, which already exists and
  derives its verdict independently).
- **No `trust.verify` replacement.** Provider trust is already covered by
  the existing `trust.verify` tool (token id → TRUSTED / REJECTED /
  INCONCLUSIVE). The discovery tools surface the *stored* verification
  status; they do not re-derive it. An agent that needs a fresh verdict
  calls `trust.verify` with the provider's `tokenId`.
- **No marketplace.** No listings, no reviews, no escrow, no tokenomics.
  Discovery is a directory, not a market.

## Implementation sketch (when the time comes)

```ts
// src/mcp/tools.ts — two new entries in TOOLS, following the existing pattern:
{
  name: 'discover_services',
  description: 'Find API services on Concordium Testnet: name, description, category, endpoint, provider identity, network, pricing, and x402 payment requirements. Read-only.',
  inputSchema: { /* as above */ },
  handler: (cfg, a) => toolDiscoverServices(cfg, a),
},
{
  name: 'get_service_details',
  description: 'Fetch one API service by id: full metadata, pricing, provider verification status, and x402 payment requirements when active. Read-only.',
  inputSchema: { /* as above */ },
  handler: (cfg, a) => toolGetServiceDetails(cfg, a),
},
```

Both handlers take the registry from `ServerConfig` (a new optional
field, e.g. `discoveryRegistry`), validate with the shared helpers
(`assertInputSize`, `assertNoForbiddenFields`), and return the registry's
own view shape. No new validation logic, no new trust logic.

## Open questions (decide before building)

1. **Where does the registry live in production?** The MVP registry is
   in-memory and per-process. An MCP server that outlives a restart needs
   either a shared registry instance or a persistence decision first.
2. **Who may register?** Registration is operator-side today. If a
   registration tool is ever added, it needs the operator-authorization
   model that MCP currently refuses by design.
3. **Fresh vs stored verification?** The discovery tools surface the
   stored status. Should `get_service_details` offer a `verify: true`
   option that re-runs `verifyAgent`? That would make the tool do network
   I/O with a client-chosen target — it needs the same destination-pinning
   review as `trust.verify` before it is added.
