# Provider Onboarding Foundation

The second layer of the Agent Network foundation: how a provider gets
listed, how its identity is verified, and how the listing survives a
restart — without opening registration to the public, without inventing
trust, and without touching the payment flow.

## Architecture

```
                        operator (human, this machine)
                                     │
                                     ▼
              ┌─────────────────────────────────────────┐
              │  agenttrust-discovery CLI (src/cli/)    │
              │  register · list · show · activate ·    │
              │  deactivate · verify · audit            │
              └──────────────────┬──────────────────────┘
                                 │  SQLite (node:sqlite)
                                 ▼
              ┌─────────────────────────────────────────┐
              │  Service Registry (src/discovery/)      │
              │  registry.ts  — validation, duplicates, │
              │                 verification mapping,   │
              │                 audit                   │
              │  store.ts     — ServiceStore interface  │
              │                 + memory + SQLite impls │
              │  verify.ts    — production verifier     │
              │                 (verifyAgent adapter)   │
              └──────────────────┬──────────────────────┘
                                 │  read-only
                                 ▼
              ┌─────────────────────────────────────────┐
              │  Discovery API (src/discovery/http.ts)  │
              │  GET /api/services · GET /api/services/ │
              │  :id — mounted on the x402 resource     │
              │  server, same file the CLI writes to    │
              └─────────────────────────────────────────┘
```

Three boundaries that the architecture enforces, not just documents:

1. **Registration is operator-only.** The only write path is the local CLI.
   The Discovery API has no POST/PUT/DELETE (they return 405). MCP has no
   registration tool. A client that wants a service listed must ask the
   operator.
2. **Registration is not verification.** A registered service is
   `providerVerification.status: 'registered'` — listed, not trusted.
   `verified` requires a TRUSTED verdict from `verifyAgent`. Nothing in
   this layer can produce `verified` on its own.
3. **Discovery never pays.** The registry builds the x402
   `PaymentRequirements` an agent reads *before* paying. It never verifies,
   settles, or constructs a transaction.

## Storage — why SQLite, why this file

**Chosen: `node:sqlite` (`DatabaseSync`), the same component the
facilitator already uses** (`services/facilitator/src/repository.ts`).
No new dependency, no native build, no new service to run.

| Option | Why not |
|---|---|
| Keep in-memory | The MVP's limitation: a restart forgets every registration. |
| JSON file | No atomicity, no constraints, no concurrent-writer safety. |
| A new database service (Postgres, etc.) | A deployment, a credential, and a dependency for a directory of a few dozen rows. Unjustified. |
| Reuse the facilitator's database file | Different concern, different schema, different owner. Mixing settlement state with a public directory couples two things that must evolve independently. |

**File:** `$AGENTTRUST_DISCOVERY_DB`, default
`/home/hatch/agenttrust-state/discovery.db` — the durable directory that
survives VM replacement, next to `facilitator.db`. The resource server and
the CLI open the same file.

**Durability posture (copied from the facilitator):** WAL +
`synchronous=FULL`, `BEGIN IMMEDIATE` write transactions, a 5s busy
timeout, and 0600 file permissions (best-effort). The schema enforces the
invariants so the application cannot violate them by forgetting a check:
`services.id` is PRIMARY KEY (one row per service), `status` and
`verification_status` are CHECK-constrained to their closed value sets,
and `audit` is append-only.

**Two processes, one file.** The resource server (running as `agenttrust`)
reads the file; the operator CLI (running as root) writes it. When root
creates the file first, the store best-effort `chown`s it to the service
user (`agenttrust`, configurable) so the server can still read it. Root can
always write, regardless of ownership.

**What the store holds** (one row per service): id, name, description,
category, endpoint, provider token id / owner account / agent URI, network,
pricing (amount, payTo, optional timeout and description), status,
verification status / decision / checked-at / reason, registered-at. Plus
one `audit` row per operator action (time, actor, action, service, detail).

## Production provider verification

`src/discovery/verify.ts` — `createProductionVerifier()`. It contains no
verification logic of its own; it wires the pieces that already exist:

1. **Registry record:** `agent_of` on the hosted Concordium Agent
   Registry MCP (`src/registry/mcpClient.ts`), by the provider's CIS-8004
   token id.
2. **Identity verification:** `verifyAgent`
   (`src/verify/crossAgent.ts`) — the same function the MCP `trust.verify`
   tool and the `agenttrust verify` CLI already use. It fetches the
   provider's Agent Card from the registry's `agent_uri` over the pinned
   transport, recomputes SHA-256 locally over the exact response bytes,
   and compares hash, owner, status and contract references against the
   on-chain record.
3. **Decision mapping:** TRUSTED → `verified`, REJECTED → `rejected`,
   INCONCLUSIVE → `unverified`. Any error (registry unreachable, card
   fetch failing, malformed record) or any timeout is INCONCLUSIVE.

Invariants:

- **Only TRUSTED can produce `verified`.** There is no fallback, no
  "close enough", no upgrade path. A failed card fetch, a timed-out MCP
  call, a missing `agent_uri` — all are INCONCLUSIVE, never TRUSTED.
- **The card is fetched from the provider's own published `agent_uri`.**
  The adapter never substitutes a local copy of a card: that would be
  verifying a claim against evidence the provider did not publish.
- **The default transport is the pinned one** (`verifyAgent` with no
  `fetchImpl`). Callers that need a different transport (tests, a
  proxy-aware environment) inject it explicitly; the default never
  silently downgrades.
- **A total deadline** (default 30s) bounds the whole verification
  (registry lookup + card fetch + checks). A hung lookup is INCONCLUSIVE,
  not a hung operator.
- **No credential is stored or displayed.** Only public data: token ids,
  account addresses, card URLs, hashes.
- The checked-at time and the decision are stored with the service, so an
  agent can see *when* a provider was last verified, not just *whether*.

Token 1004, the Agent Card URI, the registry and the metadata hash are
never modified by this adapter. It only reads them.

## Operator registration procedure

The CLI is `agenttrust-discovery` (bin `dist/cli/discovery.js`, source
`src/cli/discovery.ts`). It reads and writes the persistent registry
database. `--db` overrides the database path for one invocation;
`$AGENTTRUST_DISCOVERY_DB` overrides it for the process; the default is
`/home/hatch/agenttrust-state/discovery.db`.

```bash
# 1. Register a service (validation is the same as the registry's).
agenttrust-discovery register \
  --name "Testnet Price Feed" \
  --description "Live CCD price ticks from Concordium Testnet." \
  --category data \
  --endpoint https://api.example.com/price \
  --token-id 1004 \
  --owner 4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d \
  --agent-uri https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json \
  --amount 10 --pay-to 3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB \
  [--max-timeout 300] [--price-description "Per price-tick request"] \
  [--id svc_price-feed] [--actor alice]

# 2. Verify the provider (production verifier: registry MCP + verifyAgent).
agenttrust-discovery verify --id svc_price-feed

# 3. List / inspect / change status / audit.
agenttrust-discovery list [--status active|inactive|all] [--category data]
agenttrust-discovery show --id svc_price-feed
agenttrust-discovery deactivate --id svc_price-feed   # hides it from the default list
agenttrust-discovery activate --id svc_price-feed     # makes it payable again
agenttrust-discovery audit [--id svc_price-feed]
```

**Duplicate ids.** Re-registering the same id with *identical* content is
an idempotent no-op (the existing service is returned, nothing is
rewritten). The same id with *different* content is a conflict error —
never a silent overwrite. A service's id never changes.

**Exit codes.** 0 = success. 1 = usage, validation, storage, or
unknown-service error. `verify` exits 0 whenever a verification result
was produced (TRUSTED, REJECTED, and INCONCLUSIVE are all outcomes, not
command failures); it exits 1 only when the command itself could not run.

**What the CLI does not do.** It does not sign, settle, broadcast, or
construct a transaction. It does not read, display, or store a wallet
secret. It does not change token 1004, the Agent Card, the registry, or
the metadata hash.

## First provider readiness

**Status: BLOCKED — no provider can be activated yet.** The onboarding
flow is complete and verified, but there is no real, publicly reachable
x402 endpoint to list, and the one provider identity that exists cannot
currently be verified.

What was checked (live, 2026-11-12 ~19:57 WIB):

- **The resource server is loopback-only.** The only x402 endpoint in
  the repository binds `127.0.0.1:4590` (`/protected`). It is a real
  endpoint, but it is not publicly reachable, so an agent discovering it
  could not call it. Listing a loopback URL as a provider would be a
  placeholder, not a provider.
- **The Agent Card URL is down.** `https://api.sabokun.my.id/agenttrust/
  .well-known/agent-card.json` returns HTTP 502 consistently (three curl
  attempts and a Node fetch). The egress proxy works (the registry MCP
  health endpoint returns 200 through the same proxy), so the 502 is the
  origin, not the network.
- **The on-chain identity is real.** `agent_of` for token 1004 returns a
  live record: owner `4dWn8miA…`, agent URI as above, metadata hash
  `3f614404…`, status `Active`, registered 2026-11-04. The identity exists;
  its published card cannot currently be fetched.
- **Live verification of token 1004 returns INCONCLUSIVE.** The
  production verifier (registry MCP + `verifyAgent`, pinned transport)
  finds the agent (`agent_discovered: PASS`, `status_active: PASS`) but
  cannot retrieve the card (`card_retrieved: INCONCLUSIVE` — the pinned
  transport is blocked by the VM's direct-TCP interception, and the card
  host itself returns 502). The result is `unverified`, honestly, not
  `verified`.

**Concrete data still needed to activate the first provider:**

1. A **publicly reachable x402 endpoint URL** (the resource server
   deployed behind a public host, or another provider's endpoint — not a
   loopback address, not `api.example.com`).
2. That endpoint's **price** (amount in microCCD) and **payTo** address.
3. The provider's **identity**: CIS-8004 token id, owner account, and
   Agent Card URL.
4. The **Agent Card host must be reachable** (currently 502), so
   `verifyAgent` can return TRUSTED and the provider can be listed as
   `verified` rather than `unverified`.

Until then the production registry stays empty. No placeholder service
has been registered.

## Tests

`test/discovery-onboarding.test.mts` — **26/26 passed**, fully offline
(the production verifier is exercised through injected stubs; the live
path is verified separately by the smoke test below).

- Persistence after restart (service, status both directions,
  verification state, audit log).
- Duplicate ids (identical → idempotent; conflicting → error; same rule
  after a restart; id validation).
- Production verifier: TRUSTED → verified; tampered card → REJECTED;
  card fetch 503 → INCONCLUSIVE; card fetch throwing → INCONCLUSIVE;
  registry lookup throwing → INCONCLUSIVE; hung lookup cut off by the
  deadline → INCONCLUSIVE; no `agentUri` can never become verified (even
  with a verifier that would return TRUSTED); owner mismatch → REJECTED.
- Storage failure: a database in a missing directory fails loudly at
  open; a read-only database file makes registration fail closed (no
  phantom service).
- Operator CLI (spawned as a subprocess against a temp database):
  register (always inactive) → list → show → activate refused
  (unverified, exit 1) → deactivate → audit; invalid registration
  rejected (exit 1, no service); unknown service / unknown command /
  missing database directory (exit 1). Activation after a TRUSTED
  verification is covered by the `onboard` command and by
  `test/provider-activation-policy.test.mts`.
- Unauthorized registration: POST and PUT to the Discovery API → 405 on
  the persistent registry (no service created); MCP exposes no
  service-registration tool.
- Regression: Discovery list/detail + `/protected` 402/200 on the
  persistent registry (including a restart in the middle), and the
  in-memory and persistent registries return the same Discovery view.

## Live smoke test (2026-11-12 ~19:58 WIB)

Operator CLI against a **temporary** database (deleted after; the
production database was not touched):

- `register` — service `svc_local-resource` created (endpoint the local
  resource server, `http://127.0.0.1:4590/protected`, labelled loopback /
  smoke-test-only), `providerVerification.status: 'registered'`,
  `paymentRequirements` present (amount 1, payTo the real recipient, no
  invented feePayer). **Note:** this smoke test ran before the activation
  policy change (2026-11-13); under the current policy a freshly
  registered service is `inactive` and has no `paymentRequirements`
  until it is verified TRUSTED and activated.
- `verify` — production verifier, live registry MCP: `unverified
  (INCONCLUSIVE)` — "verification evidence could not be established
  (unavailable: card or registry unavailable)". `checkedAt` stored.
  The provider is **not** marked verified.
- `show` — the verification state persisted.
- `audit` — two rows (register, verify), newest first, actor + detail.
- `list` from a second process — the service is there (persistence
  across processes). Database file mode 0600.

## Files

Created:

- `src/discovery/store.ts` — `ServiceStore` interface, in-memory store,
  `SqliteServiceStore` (`node:sqlite`), audit rows, file permissions +
  service-user ownership.
- `src/discovery/verify.ts` — the production verifier adapter
  (`verifyAgent` + registry MCP).
- `src/cli/discovery.ts` — the operator CLI (`agenttrust-discovery`).
- `test/discovery-onboarding.test.mts` — 26 tests.
- `docs/discovery-onboarding.md` — this document.

Changed:

- `src/discovery/registry.ts` — the registry now runs over a
  `ServiceStore` (default in-memory; pass a `SqliteServiceStore` for
  durability), supports explicit ids with idempotent duplicate handling,
  and writes an audit row per mutation (register / activate / deactivate /
  verify). The HTTP Discovery contract is unchanged; the existing 34
  discovery tests pass unmodified.
- `scripts/x402-resource-server.mts` — serves the persistent registry
  (`$AGENTTRUST_DISCOVERY_DB`, default
  `/home/hatch/agenttrust-state/discovery.db`) instead of an in-memory
  one, and closes it on shutdown.
- `package.json` — new bin `agenttrust-discovery`.

## What is NOT done (deliberately)

- **No first provider is listed.** See "First provider readiness" above.
  The production registry is empty until a real, publicly reachable
  endpoint and a verifiable card exist.
- **No MCP tools** (`discover_services`, `get_service_details`) — design
  only, in `docs/discovery-mcp.md`. Building them is a separate step.
- **No marketplace** — no listings, reviews, escrow, tokenomics, or
  staking.
- **No facilitator or signing change.** The payment flow is untouched;
  the regression tests prove it.
