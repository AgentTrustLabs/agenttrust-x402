# AgentTrust x402

Verifiable trust and x402 payments for independently operated AI agents on the **Concordium** blockchain.

AgentTrust lets one agent answer a question about another agent with evidence instead of trust: *is
this agent really who it claims to be, on chain, right now — and should I pay it?*

It registers an agent in the CIS-8004 Agent Registry, verifies other agents **independently** (its own
`fetch`, its own SHA-256, its own comparison against the on-chain metadata hash), applies an explicit
trust policy, runs x402 exact-CCD payment logic behind a hard settlement gate, records everything in a
hash-chained audit trail, and exposes all of it over the Model Context Protocol so any AI agent can use
it as a tool.

> **Simulated ≠ real — for the MCP and CLI commerce paths.** `commerce.simulate` and the
> commerce CLI settle with a **mock facilitator**: results carry `settled: false` and no
> transaction is signed, submitted, or recorded on chain. The self-hosted **Facilitator
> service** is different: it settles for real on Concordium Testnet, verified 2026-11-11
> with a finalized sponsored payment. See [Real Testnet payment demo](docs/demo-real-payment.md).
> See [Simulated settlement](#simulated-settlement--read-this-before-the-demo) for the mock paths.

---

## What works today

| Capability | Status |
|---|---|
| CIS-8004 registration on Concordium Testnet | **Real** — token `1004`, `JyP9YLib1wYgFmztkcKJL` |
| Agent Card publication + on-chain metadata hash | **Real** — 2 777 bytes, SHA-256 `3f614404…` |
| Registry discovery, card retrieval, local SHA-256 | **Real** — live registry |
| Independent trust verification (owner, badge, status, contract refs) | **Real** — `TRUSTED` on token 1004 |
| Trust-gated commerce orchestration + audit trail | **Real logic, simulated payment** |
| x402 exact-CCD payment requirements, verification, settlement gate | **Real** — verified live 2026-11-11 (1 Testnet payment, finalized) |
| MCP server (6 tools, stdio) | **Real** |
| Live CCD settlement | **Real** — self-hosted facilitator on Testnet (not a public service) |

---

## Agent wallet capabilities

The gateway also runs a full agent-wallet stack on top of the trust and payment layers:

| Capability | Status |
|---|---|
| Connect Wallet page + Concordium Browser Wallet connection | **Real** (non-custodial, no keys in this process) |
| Wallet ownership verification (signed challenge) | **Real** |
| Agent pairing + CIS-8004 identity / Agent Card verification | **Real** |
| Per-agent permissions: spending limits, allowlist, network binding, pause/revoke | **Real logic, in-memory store** |
| Dedicated agent wallets with independent signing identities | **Real (local key custody)** |
| Agent Wallet Skills (`wallet_get_status`, `wallet_get_permissions`, `wallet_request_payment`, `wallet_request_approval`, `wallet_get_activity`) | **Real** |
| HTTP x402: 402 requirement → wallet → payment → independent provider verification | **Real flow, mock facilitator + mock chain read** |
| On-chain agent account creation / funding | **Not implemented** — requires a credential deployment transaction |
| Real on-chain settlement | **Real via self-hosted facilitator (Testnet)** — the wallet HTTP x402 flow still uses a mock facilitator |

The signing boundary keeps private keys inside a local key store; agent-facing APIs and
the browser never see key material. Spending is gated by the permission layer: limits,
recipient allowlist, network binding, manual approval, and reservations are enforced
before any facilitator call.

See [`docs/integration.md`](docs/integration.md) for the wallet, pairing, x402, and Concordium
integration surfaces.

---

## Prerequisites

- **Node.js ≥ 22** — `engines` declares `>=20`; verified on 22.23.3 and 26.7.0. Node 20 itself was not
  executed during the readiness review.
- npm (lockfile is `lockfileVersion 3`; verified with npm 11).
- Outbound HTTPS for the live registry and Agent Card fetch. The **test suite needs no network** — every
  fetch is an injected mock.
- No API keys, no wallet, no credentials. Nothing in this repository asks for a private key or seed
  phrase, and there is no code path that could use one.

---

## Clean checkout

```bash
npm ci                 # reproducible install from package-lock.json
npm run build          # tsc — emits dist/  (type-check only: npm run typecheck)
npm test               # compiles via pretest, then runs all suites
```

That is the whole setup. `npm test` builds first (`pretest`), so `npm ci && npm test` also works from a
clean checkout.

Verify the toolchain:

```bash
npm run typecheck                       # tsc --noEmit, no emit
node dist/cli/verify.js --token-id 1004 # read-only, exit 0 = TRUSTED
```

---

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `node dist/cli/verify.js --token-id 1004` | Read-only cross-agent trust verification against the **live** registry | `0` trusted · `1` rejected · `3` usage/transport |
| `node dist/cli/commerce.js --token-id 1004 --out <dir>` | Full trust-gated commerce run with a **mock** facilitator | `0` granted · `1` trust rejected · `2` payment rejected · `3` usage |
| `node dist/mcp/server.js` | MCP server over stdio (JSON-RPC 2.0) | `0` on clean shutdown |
| `node scripts/mcp-demo.mjs` | End-to-end hackathon demo (9 steps) | `0` all steps pass · `3` demo/transport failure |
| `node dist/cli/index.js --owner <base58>` | Registration flow (**writes to chain** — operator wallet required) | `1` usage/error |

The four `bin` names (`agenttrust`, `agenttrust-verify`, `agenttrust-commerce`, `agenttrust-mcp`) require
`npm link` or a global install; the commands above work directly and need neither.

> There is **no signing script**. Registration signing happens in the Concordium Wallet browser
> extension, never in this process — the gateway has no `AccountSigner` and no key. A `sign` script
> existed and pointed at a target that never existed; it was removed rather than faked.

---

## MCP

Full setup, tool schemas, and invocation examples: **[`docs/integration.md`](docs/integration.md)**.

```json
{
  "mcpServers": {
    "agenttrust": {
      "command": "node",
      "args": ["/absolute/path/to/agenttrust/dist/mcp/server.js"],
      "env": { "AGENTTRUST_AUDIT_ROOT": "/tmp/agenttrust-audit" }
    }
  }
}
```

Six tools: `registry.search`, `registry.card`, `trust.verify`, `trust.policy`, `commerce.simulate`,
`audit.verify`. Two environment variables exist and both are operator-side:
`AGENTTRUST_REGISTRY_MCP` and `AGENTTRUST_AUDIT_ROOT`. No MCP input can override either.

---

## Simulated settlement — read this before the demo

This section describes the **MCP and CLI mock paths**. A real settlement now exists
separately: the self-hosted Facilitator service settled a sponsored Testnet payment on
2026-11-11 — see [Real Testnet payment demo](docs/demo-real-payment.md) and the
runbook ([`docs/demo-runbook.md`](docs/demo-runbook.md)). Nothing below applies to it.

`commerce.simulate` and the commerce CLI run a **deterministic local mock** in place of a facilitator:

- `simulation.settled: false`, `simulation.facilitator: "mock"`
- `receipt.simulated_transaction` is derived locally from `payTo:amount:asset`. **It is not a chain
  hash, not a block-explorer reference, and was never submitted.**
- Every result carries: *"SIMULATED settlement: no transaction was signed, submitted, or recorded on
  chain."*

`access_granted` therefore means **"the trust gate and the payment gate both passed in a simulation"** —
nothing more.

### Why settlement is not real (mock paths)

There is **no publicly reachable CCD x402 facilitator** for `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
Every plausible Concordium facilitator hostname resolves to NXDOMAIN, and the public
`x402.org/facilitator` advertises nine networks — none of them `ccd:`. This was verified directly, twice,
in the archived facilitator discovery report (now consolidated into `docs/integration.md`). Real
settlement therefore needs a facilitator of its own: the project now runs one, self-hosted
on Testnet, and it settled a real payment (see the demo doc above). It does not rely on a
public facilitator and will not fabricate one.

### Why the gateway cannot sign

The gateway holds no key and never imports `AccountSigner`. The design is a four-stage signing boundary
(authorization → signing request → out-of-process signing → settlement gate) of which only the first and
last live here. MCP clients **cannot** supply an `OperatorAuthorization`: any request carrying
authorization-shaped fields is rejected with `AUTHORIZATION_NOT_ACCEPTED`. A registered, `TRUSTED`,
badge-carrying agent identity grants no signing authority over this gateway.

---

## Trust results

| Decision | Meaning | Commerce |
|---|---|---|
| `TRUSTED` | every required check PASS | allowed |
| `REJECTED` | obtained evidence contradicts a mandatory requirement | **denied** |
| `INCONCLUSIVE` | required evidence could not be obtained | **denied** |

`REJECTED` is never produced by an HTTP error, a redirect, a DNS/TLS failure or a timeout —
those are `INCONCLUSIVE` with `failure_kind: "unavailable"`.
| `INCONCLUSIVE` | information missing, nothing failed outright | **denied** |

Per-check verdicts are `PASS` / `FAIL` / `INCONCLUSIVE` / `NOT_TESTED`. `NOT_TESTED` is **not** consent —
`badge_valid` reports it when the hosted badge checker was not consulted, because that checker is
corroboration rather than proof.

---

## Repository layout

```
src/
  core/       network + contract constants
  registry/   Concordium Agent Registry MCP client, transaction builder
  verify/     independent cross-agent verification (no imports from the registration path)
  payments/   x402 exact-CCD protocol, payment gate, facilitator probe, signing boundary
  commerce/   trust policy + orchestrator, shared mock simulation
  audit/      hash-chained JSONL trail, lock hardening
  mcp/        MCP tool surface + stdio server
  pairing/    wallet connection, agent pairing, permissions, agentic wallets,
              wallet skills, x402 client integration
  cli/        verify / commerce / registration entry points
test/         70+ suites, offline
scripts/      verification + demo scripts
docs/         architecture, configuration, integration, testnet demo, real-payment demo
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture, components, trust/commerce flows, wallet permissions, audit trail |
| [`docs/configuration.md`](docs/configuration.md) | Environment variables, secret handling, sponsor wallet provisioning, spending controls |
| [`docs/integration.md`](docs/integration.md) | MCP tools, wallet skills, x402, Concordium integration, BLOCKED status |
| [`docs/testnet-demo.md`](docs/testnet-demo.md) | Running and verifying the Testnet demo, live evidence, troubleshooting |
| [`docs/demo-real-payment.md`](docs/demo-real-payment.md) | Real sponsored Testnet payment: architecture, flow, evidence, verification |
| [`docs/demo-runbook.md`](docs/demo-runbook.md) | Reproducible demo runbook: prerequisites, startup order, commands, cleanup |

## Known limitations

1. **Real settlement is Testnet-only and self-hosted.** A live x402 payment is now proven
   ([demo doc](docs/demo-real-payment.md)); there is still no public CCD facilitator, and
   no Mainnet settlement.
2. **No operator authorization channel.** Authorization is refused at the MCP boundary by design.
3. **stdio only** — no HTTP/SSE transport, so no remote or multi-tenant deployment.
4. **Unauthenticated.** Any local process that can spawn the server can call the tools. Acceptable only
   because the tools cannot spend or mutate chain state.
5. **Audit trail is not immutable.** The hash chain detects modification, insertion, deletion, reordering
   and tail truncation — but a consistent rewrite of **both** the log and its checkpoint is undetectable,
   because the checkpoint lives beside the log with no external anchor. See
   [`docs/architecture.md`](docs/architecture.md).
6. **`AGENTTRUST_AUDIT_ROOT` defaults to `/tmp/agenttrust-audit`**, shared by all runs on the host.
7. **Third-party agent cards vary** — dead URLs, `localhost` URLs, and re-published cards whose hash no
   longer matches are all present in the live registry.

## License

No license file is included. The package is `"private": true` and is not published to npm. All rights
reserved by default — add a license before any external redistribution.

## Distribution model

This project is a **source repository with local CLI and MCP distribution**, not a public npm package:

- `"private": true` — set so an accidental `npm publish` is refused; npm treats it as non-publishable
  (the guard itself was not observable here because this host has no registry credentials).
- No `license`, `repository`, `author`, `homepage`, or `publishConfig` is declared, so nothing implies a
  registry target that does not exist.
- No library entry point (`exports`/`main`) — the surfaces are the four `bin` commands and the stdio MCP
  server. There is no module for a consumer to `import`.
- Consumers run it from a checkout: `npm ci && npm run build`, then `node dist/…`.

`npm pack --dry-run` describes what a tarball *would* contain if publication were ever authorized:
194 files, ~1.5 MB unpacked — `dist/`, `src/`, `scripts/`, `README.md`, `package.json`
only. Documentation, tests, evidence, signing sites, SQLite wallet stores and audit
checkpoints are excluded by the `files` allowlist in `package.json`.

Making this a public npm package would require explicit maintainer authorization plus, at minimum, a
chosen license, a `repository` URL, and a decision on whether `src/` and `scripts/` belong in the tarball.
