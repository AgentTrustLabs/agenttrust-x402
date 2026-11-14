# API Discovery — MVP

The first layer of the Agent Network foundation: a directory of API services
an agent can discover, price, and pay for — before it pays.

## What it is

- **Service Registry** (`src/discovery/registry.ts`): in-memory store of
  API services. Register, validate, list, filter, search, activate /
  deactivate, and track provider verification.
- **Discovery API** (`src/discovery/http.ts`): read-only HTTP routes,
  mounted on the x402 resource server when a registry is provided:
  `GET /api/services`, `GET /api/services/:id`.
- **Provider verification**: registration and verification are separate.
  A service is `registered` when listed. It becomes `verified` only when
  an injected verifier (wrapping `verifyAgent` from
  `src/verify/crossAgent.ts`) returns TRUSTED. Nothing fabricates a
  reputation or a trust score.

## Boundaries

- **Concordium Testnet only.** Any other network is rejected at
  registration and at filter time.
- **No payment logic.** The registry builds the x402
  `PaymentRequirements` an agent reads before paying. It never verifies,
  settles, or constructs a transaction.
- **No signing, no settlement, no broadcast, no new transactions.**
- **Read-only HTTP.** There is no POST/PUT/DELETE. Registration is
  operator-side through the registry module, never over unauthenticated
  HTTP. A write attempt gets 405.
- **In-memory store.** A restart forgets registrations — the same honesty
  as the x402 provider's in-memory replay store. Persistence is a later,
  separate decision.
- **No tokenomics, staking, or escrow.** No trust scores. No reputation.
- Token 1004, the Agent Card, the registry, the metadata hash, and the
  sponsor/sender wallets are untouched. Nothing is committed or pushed.

## Registering a service (operator-side)

```ts
import { createServiceRegistry } from '../src/discovery/registry.js';

const registry = createServiceRegistry();
const result = registry.register({
  name: 'Testnet Price Feed',
  description: 'Live CCD price ticks from Concordium Testnet.',
  category: 'data',
  endpoint: 'https://api.example.com/price',
  provider: {
    tokenId: 1004,
    ownerAccount: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    agentUri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json',
  },
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  pricing: {
    amountMicroCcd: '10',
    asset: 'CCD',
    payTo: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB',
    maxTimeoutSeconds: 300,
    description: 'Per price-tick request',
  },
});
if (!result.ok) {
  // result.errors: one line per problem, each naming its field.
}
```

Validation (all enforced, all tested):

| Field | Rule |
| --- | --- |
| `name` | non-empty string, max 128 chars |
| `description` | non-empty string, max 1024 chars |
| `category` | one of `data`, `compute`, `content`, `communication`, `utility`, `other` |
| `endpoint` | valid absolute http(s) URL, no userinfo, no percent-encoded host. Validated as a URL only — the registry never fetches it, so this does not prove reachability or safety. An agent must validate an endpoint before calling it. |
| `network` | must be `ccd:4221332d34e1694168c2a0c0b3fd0f27` (Testnet) |
| `provider.tokenId` | positive integer |
| `provider.ownerAccount` | valid Concordium account (base58, exactly 50 chars) |
| `provider.agentUri` | valid absolute http(s) URL, or `null` (no card linked yet) |
| `pricing.amountMicroCcd` | decimal integer string, > 0, at most `1000000000` (1000 CCD) |
| `pricing.asset` | must be `'CCD'` |
| `pricing.payTo` | valid Concordium account |
| `pricing.maxTimeoutSeconds` | positive integer, at most 600 (when present) |
| `pricing.description` | non-empty string, max 256 chars (when present) |

A newly registered service has `providerVerification.status: 'registered'`
and `status: 'inactive'`. Registration is not verification, and a service
is not discoverable until it is verified and activated (see
[Activation policy](#activation-policy)).

## Provider verification (registered vs verified)

```ts
// The verifier is injected per call. In production it wraps verifyAgent;
// in tests it is a stub. The registry never decides trust itself.
const verified = await registry.verifyProvider(serviceId, async (provider) => {
  // … run verifyAgent({ expect: { network, cis8004: '12802.0', cis8: '12801.0',
  //      tokenId: provider.tokenId, ownerAccount: provider.ownerAccount },
  //      discoveryPayload, fetchImpl }) and map its trust_decision …
  return { decision: 'TRUSTED', reason: 'card hash matches on-chain anchor' };
});
```

| Verifier decision | `providerVerification.status` | Meaning |
| --- | --- | --- |
| `TRUSTED` | `verified` | The provider's Agent Card passed full verification. |
| `REJECTED` | `rejected` | Verification ran and the identity was contradicted. |
| `INCONCLUSIVE` | `unverified` | Verification ran but the evidence could not be established. Not trusted, not accused. |
| (no card linked) | `unverified` | `provider.agentUri` is `null`: there is no card to verify against. A TRUSTED verdict cannot apply. |
| (verifier throws) | `unverified` | Verification could not run. Unavailability, not a contradiction. |

`registered` and `verified` are never mixed: a service is either listed
(`registered`) or proven (`verified`). An agent that requires trust must
check `providerVerification.status === 'verified'` — and must not treat
`registered` as trusted.

## Activation policy

A service is `active` ONLY while its provider verification is TRUSTED
(`providerVerification.status === 'verified'`). The registry enforces
this at every status mutation, so there is no path that leaves an
unverified provider active or discoverable:

- **Registration** always creates an `inactive` service. The
  registration input has no status field — there is no value, flag, or
  manual status change that can make a service active at registration.
- **`activate`** (`setStatus` to `'active'`) is refused unless the
  provider is verified. A refused activation writes an audit row. If
  the service is somehow active without valid verification (a
  pre-policy row), the refusal deactivates it instead of leaving it
  active.
- **Re-verification** that stops being TRUSTED (REJECTED or
  INCONCLUSIVE) deactivates an active service at the moment the
  evidence changes. It cannot be re-activated until a fresh TRUSTED
  verification.
- **Onboarding** (`agenttrust-discovery onboard`) registers as
  inactive, verifies, and activates only on TRUSTED.
- **The Discovery API is read-only** (POST/PUT/DELETE → 405) and MCP
  has no registration tool, so there is no write path outside the
  operator CLI and the registry itself.

The default Discovery list (`status: 'active'`) therefore contains
only verified providers. A service that is `inactive` still shows its
price (a fact) but is not payable: no `paymentRequirements`, and
`available: false`.

**Read-path fail-closed.** The same invariant is applied by the
projection layer (`toServiceView` + `list`) to every Discovery
response, even for a stored row that violates it. A legacy row that is
stored `active` but whose provider verification is not TRUSTED is
projected as `inactive` (`available: false`, no `paymentRequirements`)
and never appears in the active list or as an active service via the
detail endpoint. The `status` filter and the `status` field in the view
are the EFFECTIVE (discoverable) status: `active` means stored active
AND verified TRUSTED; `inactive` means not discoverable. The stored
record is never changed by a read — no row is deactivated, deleted, or
rewritten just to hide it from Discovery. To find such rows, query the
database directly (`sqlite3 discovery.db "SELECT id FROM services
WHERE status='active' AND verification_status <> 'verified'"`), then
fix them with `verify` + `activate` or `deactivate`.

## Discovery API

Mounted on the x402 resource server when a registry is injected
(`startX402ResourceServer({ ..., discovery: registry })`). The production
script (`scripts/x402-resource-server.mts`) wires an empty registry, so the
endpoints are live and return an empty list until services are registered
operator-side.

### `GET /api/services`

List + filter + search. Query parameters:

| Param | Meaning |
| --- | --- |
| `category` | one of the closed categories |
| `network` | must be the Testnet CAIP-2 |
| `q` | case-insensitive substring search over name + description |
| `status` | `active` \| `inactive` \| `all` (default `active`) — the EFFECTIVE status: `active` means discoverable (stored active AND verified TRUSTED) |
| `limit` | integer 1..100 (default 25) |

Example response:

```json
{
  "services": [
    {
      "id": "svc_9f2c1a7b4e8d03f1",
      "name": "Testnet Price Feed",
      "description": "Live CCD price ticks from Concordium Testnet.",
      "category": "data",
      "endpoint": "https://api.example.com/price",
      "provider": {
        "tokenId": 1004,
        "ownerAccount": "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d",
        "agentUri": "https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json"
      },
      "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
      "pricing": {
        "amountMicroCcd": "10",
        "asset": "CCD",
        "payTo": "3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB",
        "maxTimeoutSeconds": 300,
        "description": "Per price-tick request"
      },
      "status": "active",
      "available": true,
      "providerVerification": {
        "status": "verified",
        "decision": "TRUSTED",
        "checkedAt": "2026-11-12T12:05:00.000Z",
        "reason": "provider Agent Card passed full verification (TRUSTED)"
      },
      "registeredAt": "2026-11-12T12:00:00.000Z",
      "paymentRequirements": {
        "scheme": "exact",
        "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
        "asset": "CCD",
        "amount": "10",
        "payTo": "3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB",
        "maxTimeoutSeconds": 300,
        "extra": {}
      }
    }
  ],
  "total": 1,
  "filters": { "status": "active", "limit": 25 }
}
```

Notes:

- `paymentRequirements` is present only for **active** services. An
  inactive service still shows its `pricing` (a fact), but it is not
  payable, so no requirement is offered. `available` is the same fact in
  one boolean.
- `paymentRequirements.extra` is `{}`: the fee payer belongs to the
  facilitator (announced via its `/supported`), not to the service. A
  discovery response never invents a fee payer.
- Invalid filters return 400 with a plain error message. An empty
  registry returns `{ "services": [], "total": 0 }`, not an error.

### `GET /api/services/:id`

One service, same shape as a list entry. Unknown id returns 404
`{ "error": "service not found" }`. An inactive service is returned here
(with `available: false` and no `paymentRequirements`) so an agent can see
*why* it is not usable; it is only hidden from the default list.

### Other methods

Any non-GET method on a discovery route returns 405 with an
`Allow: GET` header. Discovery is read-only.

## How an agent uses it

1. `GET /api/services?category=data` — find candidate services.
2. Read `pricing` and `paymentRequirements` **before** paying.
3. Check `providerVerification.status`: `verified` means the provider's
   Agent Card passed full verification; `registered` means listed but not
   yet verified — do not treat it as trusted.
4. Call the service's `endpoint` and pay the `paymentRequirements` through
   the normal x402 flow (`GET` → 402 → `X-PAYMENT` → 200). The Discovery
   API itself never takes a payment.

## MCP readiness

See `docs/discovery-mcp.md` for the minimal interface design for
`discover_services` and `get_service_details`. No MCP integration is built
yet — the interface is designed so the tools are thin adapters over this
registry, following the existing `src/mcp/tools.ts` pattern.

## Tests

`test/discovery-api.test.mts` — 34 tests, all passing. Covers registration
+ validation, discovery, search + filtering, unknown service, invalid
metadata, unverified provider (all four verification outcomes), inactive
service, pricing + payment requirements, and x402 payment-flow
compatibility (the 402 → 200 flow still works on a server that also
serves Discovery; without a registry the discovery routes do not exist).
