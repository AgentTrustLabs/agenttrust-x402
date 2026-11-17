# AgentTrust x402 — Integration

This document covers integration surfaces: MCP tools, Agent Wallet Skills, x402, and Concordium.

## MCP server

- Entry: `node dist/mcp/server.js` (JSON-RPC 2.0 over stdio).
- Env: `AGENTTRUST_REGISTRY_MCP`, `AGENTTRUST_AUDIT_ROOT` (see configuration).
- Six tools:

| Tool | Purpose |
|---|---|
| `registry.search` | Search agents in the live registry. |
| `registry.card` | Fetch an agent card. |
| `trust.verify` | Independent cross-agent trust verification. |
| `trust.policy` | Trust policy configuration. |
| `commerce.simulate` | Trust-gated commerce with mock facilitator. |
| `audit.verify` | Verify the hash-chained audit trail. |

### Trust result

| Decision | Meaning | Commerce |
|---|---|---|
| `TRUSTED` | every required check PASS | allowed |
| `REJECTED` | evidence contradicts a mandatory requirement | **denied** |
| `INCONCLUSIVE` | required evidence could not be obtained | **denied** |

Per-check verdicts: `PASS` / `FAIL` / `INCONCLUSIVE` / `NOT_TESTED`. `NOT_TESTED` is not consent.

### Error reporting

Protocol errors (malformed JSON-RPC) are distinct from tool errors (tool-level failure).

## Agent Wallet Skills

Skills: `wallet_get_status`, `wallet_get_permissions`, `wallet_request_payment`,
`wallet_request_approval`, `wallet_get_activity`.

- Authentication: agent identity + wallet resolution.
- Authorization boundaries: permission checks before any payment/approval.
- Payment and approval lifecycle: request → approval → execute → receipt.
- Error codes: `wallet_not_funded`, permission denied, etc.

## Connect wallet & agent pairing

- Supported wallet: Concordium Browser Wallet (non-custodial).
- Connection flow: connect → ownership verification (signed challenge) → agent pairing.
- Pairing protocol: links wallet to a CIS-8004 identity / Agent Card.
- Security boundaries: no keys in the gateway process.
- Minimal permission foundation: spending limits, allowlist, network binding.

## x402 payment

### Protocol layer (`src/payments/x402.ts`)

- `buildPaymentRequirements` — exact CCD, payTo, amount, network, feePayer.
- `buildPaymentRequired` — 402 body.
- `preflightPaymentPayload` — scheme/network/asset/amount/payTo/expiry checks.
- `authorizePayment` — preflight → facilitator.verify → facilitator.settle → receipt.
- `DENY_ALL_FACILITATOR` — default gate (enabled).

### SDK adaptation (`src/payments/x402Sdk.ts`)

- `@x402/concordium` and `@x402/core` SDKs.
- `createHttpFacilitator`, `buildResourceServer`.

### HTTP x402 resource server (the 402 → payment → grant loop)

The loop is implemented. Four layers, each reusing the existing components —
no second payment architecture:

| Layer | File | Role |
|---|---|---|
| Provider gate | `src/x402/provider.ts` | Decides access: header → preflight → resource binding → facilitator verify → facilitator settle → independent on-chain read → atomic replay claim. No HTTP, no keys. |
| Chain verifier | `src/x402/concordiumChainVerifier.ts` | Read-only Testnet `getBlockItemStatus`, genesis-bound. The facilitator's word alone never unlocks the resource. |
| Facilitator client | `src/payments/x402Sdk.ts` (`createHttpFacilitator`) | POSTs `{ x402Version: 2, paymentPayload, paymentRequirements }` to the self-hosted facilitator's `/verify` + `/settle` — exactly the envelope its core `parseEnvelope` accepts (pinned by `test/http-x402-resource-server.test.mts` test 19). |
| HTTP transport | `src/x402/resourceServer.ts` | Maps HTTP to the provider and back. No payment logic of its own. |

Flow:

```
GET /protected                 → 402 + PaymentRequired challenge
GET /protected + X-PAYMENT     → 200 + resource + PAYMENT-RESPONSE header
                                (base64 JSON settlement, SDK convention;
                                 X-PAYMENT-RESPONSE alias also sent)
                                — or 400 malformed / 402 unpaid-or-invalid /
                                409 replay / 503 verification unavailable
```

Run it (loopback only, never expose publicly without an auth layer in front):

```
npx tsx scripts/x402-resource-server.mts
# env: AGENTTRUST_X402_HOST (127.0.0.1), AGENTTRUST_X402_PORT (4590),
#   AGENTTRUST_FACILITATOR_URL (http://127.0.0.1:8787),
#   AGENTTRUST_X402_PAY_TO (default: recipient of both verified live payments),
#   AGENTTRUST_X402_AMOUNT (default 1 microCCD), AGENTTRUST_X402_RESOURCE_PATH (/protected),
#   AGENTTRUST_X402_SENDER / AGENTTRUST_X402_SPONSOR (optional pins),
#   AGENTTRUST_NODE_HOST / AGENTTRUST_NODE_PORT (Testnet node for the chain verifier)
```

Startup fails closed: the facilitator is probed via `/supported` first
(`classifyCompatibility` — the sponsor address comes from the facilitator's
own announcement, never from local config), and the chain verifier checks
the node genesis before serving. This process never signs and holds no keys.

### Payment client

- `src/x402/client.ts` (`fetchPaidResource`) — GET → 402 → parse the
  challenge → build a signed payload via an injected creator → retry once
  with `X-PAYMENT` → 200 + decoded settlement header, or the failure passed
  through. Exactly one paid attempt; a rejected payment is never retried
  automatically. Amount, recipient, network and resource always come from
  the server's 402 challenge, never from the caller.
- `scripts/x402-pay.mts` — the production payload creator: sender wallet
  export (`loadWalletExportSigner`) + live nonce (`GrpcAccountInfoProvider`)
  + `Transaction.signableFromJSON` / `Transaction.sign` / `Transaction.toJSON`
  (with the SDK 12 BigInt → Number conversion for `header.nonce` and
  `header.executionEnergyAmount`). The sender signs only the sender part;
  the sponsor signature is added by the facilitator's signing service. The
  sponsor account is read from the requirement's `extra.feePayer`.
  **Live script: signs a real transaction and pays real (test) CCD — run only
  with a separate, explicit operator authorization for one payment.**

### Request-to-transaction binding

- The 402 requirement (resource URL, amount, recipient, network, expiry) is bound to the
  signed transaction.
- X-PAYMENT payload contract (this deployment): the standard SDK shape
  (`x402Version`, `accepted`, `payload.signedTransaction` — `PaymentPayload`
  in `@x402/core` carries an optional `resource`) plus two binding fields
  the provider requires: `resource: { url }` (must equal the 402's resource
  URL) and `requestId` (unique per paid attempt; the replay store claims the
  `(requestId, txHash)` pair atomically, so a second redemption of the same
  payment is refused with 409 even across different request ids).

### Settlement safety gate

- Preconditions for a live settlement (all required): sender verified, recipient verified,
  amount exact, network exact, sponsor funded, transaction finalized.
- Deliberate omissions: no public facilitator (settlement runs through the self-hosted
  facilitator — see [Real settlement](demo-real-payment.md)), no key custody in the gateway.

### Verification status

- Provider gate: 21 tests (`test/http-x402-provider.test.mts`, mocks only)
  + read-only validation against live Testnet (`scripts/verify-testnet-chain.mts`).
- HTTP loop: 19 tests (`test/http-x402-resource-server.test.mts`, real HTTP on
  loopback, fake facilitator + fake chain): unpaid 402, valid 200 + settlement
  headers, malformed header, invalid verify, expired, replay 409, settle
  throw → 503, settle without hash → 402, pending → 402, chain mismatch →
  402, chain unavailable → 503, client 402 → pay → 200, client payload
  failure never reaches settle, malformed 402, facilitator envelope contract.
- **Live end-to-end run (real facilitator + real chain + real signed payment)
  has NOT been run yet** — the deployment is down (VM replacement) and a live
  payment needs a separate operator authorization. See [runbook](demo-runbook.md)
  for the live-test procedure.

### MCP interface (audit)

- `commerce.simulate` is mock-only by design: it runs the offline mock
  facilitator and always labels its receipt simulated. No MCP tool settles,
  signs, or touches the facilitator — the real payment path is the HTTP loop
  above, not MCP. That is intentional, not a gap to close here.

## Concordium integration

- Network: Testnet (CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27`).
- CIS-8004 Agent Registry: index 12802, subindex 0.
- CIS-8 External Key Registry: index 12801, subindex 0.
- Live registry MCP: `https://agent-registry-mcp.concordium.com`.
- Indexer: `https://agent-registry-indexer.concordium.com`.
- gRPC: `https://grpc.testnet.concordium.com:20000`.
- Admin: `3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8`.

### Verified lessons

- **Undocumented testnet faucet** — `PUT wallet-proxy/v0/testnetGTUDrop/{addr}`. Live: balance
  0 → 20 000 CCD. Explicitly NOT a supported API; documented fallback is the wallet UI.
- **Account creation requires an Identity Provider credential** — a structurally valid
  keypair-derived address is rejected with `Account creation is not finalized`. Testnet
  identity is free (no KYC); no public issuance API.
- **Post-registration token identity** — `build_agent_card` populates `tokenAddress` +
  `registrations` when `token_id` is forwarded; `build_agent_badge` is for an existing card.
- **Wallet serialization** — numeric type `2`, `{value}` wrappers, `{type:'module'}` schema,
  params passed separately.

### Wire conversion

- SDK V1 wire shape → x402 V2 wire shape (`src/payments/wireConverter.ts`).
- Transaction type: numeric enum.
- `receiveName` / `maxContractExecutionEnergy`: `{ value }` objects.
- Schema: `{ type: 'module', value: <base64 module schema> }`.
- `schemaVersion` may be omitted.

## Live end-to-end HTTP x402 run: implemented, not yet run live

**Status: implemented + verified locally with mocks; live run pending.**

The complete HTTP loop is now implemented (see [HTTP x402 resource
server](#http-x402-resource-server-the-402--payment--grant-loop) above):
a 402 requirement served by the resource server, paid through the
self-hosted facilitator, and granted only after independent on-chain
verification. The provider gate was validated read-only against live Testnet
(`scripts/verify-testnet-chain.mts`); the HTTP transport + client were
verified locally against fake facilitator + fake chain
(`test/http-x402-resource-server.test.mts`, 19/19).

What remains for a live run (all outside the current authorization):

1. **Re-provision the deployment** (services are down after the VM
   replacement) — needs separate operator authorization.
2. **Start the resource server** against the live facilitator
   (`scripts/x402-resource-server.mts`).
3. **One authorized live payment** via `scripts/x402-pay.mts` (separate
   authorization + preflight: sender nonce, balances, facilitator health),
   then verify: 200 + `PAYMENT-RESPONSE` with the real transaction hash,
   explorer confirmation, and a second identical `X-PAYMENT` returning 409.

Constraints honoured: no unrestricted public facilitator access, no automatic retry, no
private key exposure.

## Sponsor signing (Concordium)

- Sponsor signer: out-of-process via IPC (separate signing service).
- Ed25519 signing with fee validation.
- V1 sponsored submission: wire converter, gRPC transport.
- Authorization: durable authorization state, atomic authorization, authorization
  provenance, payment context integrity, legacy recovery.
- Threat model: production IPC contract, owner process isolation, least-privilege runtime.

### Sponsor wallet provisioning

- Create with Concordium Wallet for Web or mobile (Testnet).
- Export private key → Export to file (single-account JSON).
- Safe destination: `/home/agenttrust/.agenttrust/sponsor-3xRV448Q.export`, `chmod 600`,
  owned by the service user. Keep it in place — the service needs it on every restart.
- Verify: `npx tsx scripts/sponsor-account-verify.mts <account-address>`.
