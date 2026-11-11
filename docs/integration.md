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

### HTTP provider (`src/x402/provider.ts`)

- Serves a protected resource.
- Emits a 402 requirement.
- Verifies the payment proof against live Testnet.
- Grants 200 only on a finalized matching transfer.
- Rejects replay and mismatched parameters.

### Payment client

- Parses the 402 requirement.
- Constructs a signed V1 sponsored transaction using the existing sender wallet loader.

### Request-to-transaction binding

- The 402 requirement (resource URL, amount, recipient, network, expiry) is bound to the
  signed transaction.

### Settlement safety gate

- Preconditions for a live settlement (all required): sender verified, recipient verified,
  amount exact, network exact, sponsor funded, transaction finalized.
- Deliberate omissions: no real facilitator, no key custody in the gateway.

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

## BLOCKED: end-to-end HTTP x402 real settlement

**Status: BLOCKED.** Phase A (inspection) complete; Phases B/C/D not attempted.

The existing facilitator, x402 protocol layer, and signing infrastructure are ready. There is
no HTTP provider or payment client to integrate for a complete real settlement.

Missing integrations (minimum for a complete HTTP flow):

1. **HTTP provider endpoint** — serve protected resource, emit 402, accept payment proof,
   grant 200 only after independent verification.
2. **Payment client** — construct and sign an x402 payment payload from a 402 requirement.
3. **Independent on-chain verification at the provider** — query Testnet, verify transfer
   recipient, amount, sender, network, finality before granting access.
4. **Replay protection at the provider** — track consumed payment digests or transaction
   hashes.
5. **Request-to-transaction binding** — bind the 402 requirement to the signed transaction.
6. **Failure-path coverage** — malformed payment, wrong network, wrong recipient, wrong amount,
   invalid agent identity, invalid signature, pending/rejected transaction, replay.

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
- Safe destination: `/etc/agenttrust/sponsor-wallet.json`, `chmod 600`.
- Verify: `npx tsx scripts/sponsor-account-verify.mts <account-address>`.
