# AgentTrust x402 — Configuration

This document covers configuration and environment variables for AgentTrust.

## Environment variables

### MCP server (`src/mcp/server.ts`)

| Variable | Default | Description |
|---|---|---|
| `AGENTTRUST_REGISTRY_MCP` | `https://agent-registry-mcp.concordium.com` | Base URL of the Concordium Agent Registry MCP service. |
| `AGENTTRUST_AUDIT_ROOT` | `/tmp/agenttrust-audit` | Directory for the hash-chained audit trail. Shared by all runs on the host. |
| `AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS` | unset | Set to `1` to allow agent card fetches from loopback/cloud-metadata hosts (testing only). |

### Registration CLI (`src/cli/index.ts`)

| Variable | Default | Description |
|---|---|---|
| `AGENTTRUST_OWNER` | (required) | Base58 owner account address for registration. |

### Pairing server (`scripts/pairing-server.mts`)

| Variable | Default | Description |
|---|---|---|
| `AGENTTRUST_PAIRING_HOST` | `127.0.0.1` | Bind host. Never expose publicly. |
| `AGENTTRUST_PAIRING_PORT` | `4518` | Bind port. |
| `AGENTTRUST_PAIRING_NETWORK` | `ccd:4221332d34e1694168c2a0c0b3fd0f27` | Concordium Testnet CAIP-2. |
| `AGENTTRUST_PAIRING_AGENT_ID` | `1004` | Agent token ID to pair with. |
| `AGENTTRUST_NODE_HOST` | `grpc.testnet.concordium.com` | Concordium gRPC host. |
| `AGENTTRUST_NODE_PORT` | `20000` | Concordium gRPC port. |
| `AGENTTRUST_REGISTRY_URL` | `https://agent-registry-mcp.concordium.com/mcp` | Registry MCP URL. |
| `AGENTTRUST_WALLET_DB` | `wallets.db` (next to static root) | SQLite path for the agentic wallet store. |
| `AGENTTRUST_X402_PAY_TO` | `3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8` | Recipient account for x402 payment. |
| `AGENTTRUST_X402_AMOUNT` | `500` | Payment amount in microCCD. |
| `AGENTTRUST_X402_RESOURCE` | `https://example.com/protected` | Protected resource URL. |
| `AGENTTRUST_X402_MOCK_CHAIN` | unset | Set to `1` to use a mock chain verifier (testing only). |

### Registry verification (`scripts/registry-verify.mjs`)

| Variable | Default | Description |
|---|---|---|
| `AGENTTRUST_CARD` | `docs/evidence/task02/agent-card.v2.json` | Path to the agent card JSON for verification. |

### Functional identifiers (do not rename)

The following identifiers contain "TASK" in their names but are functional (env vars,
constants). They are preserved for backward compatibility:

- `TASK348_LOG`, `TASK348_PEERCRED_BIN` — IPC test harness (env vars).
- `TASK349_LOG`, `TASK349_PEERCRED_BIN` — SQLite crash test (env vars).
- `TEST_SIGNING_SEED_HEX` — Ed25519 test key (env var).
- `TASK65_SENDER_WALLET_FILE` — sender wallet file path (env var).

These are internal test identifiers and do not appear in production code paths.

## Secret handling

- No API keys, no wallet, no credentials are required to run the gateway.
- Private keys are never requested, stored, or transmitted by the gateway.
- The signing boundary keeps keys in a local key store; agent-facing APIs and the browser
  never see key material.
- `AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS` is for testing only and must not be set in production.
- `AGENTTRUST_X402_MOCK_CHAIN=1` is for testing only.

## Sponsor wallet provisioning

The sponsor wallet (Concordium account used to pay transaction fees) is provisioned by the
maintainer, not by the gateway:

1. Create the account with **Concordium Wallet for Web** (browser extension) or
   **Concordium Wallet** (mobile). Confirm the network is **Testnet**.
2. Use **Export private key → Export to file** to produce a single-account JSON key file.
   - Do NOT use the Desktop Wallet encrypted backup (password-protected, rejected by
     `parseWallet`).
   - Do NOT use a bare 64-hex private key (rejected by `parseWallet`).
3. Save the file to a safe destination on the signing-service host only:
   `/etc/agenttrust/sponsor-wallet.json`, `chmod 600`, owned by the service user.
4. The file is read once at service startup; after startup the maintainer may delete it.
5. Verify with `npx tsx scripts/sponsor-account-verify.mts <account-address>`.

Expected: `EXISTS`, threshold 1, 1 Ed25519 credential, balance 20000 CCD.

## Spending controls

- Permission schema: spending limits, recipient allowlist, network binding, manual approval,
  reservations.
- Enforcement happens before any facilitator call.
- Storage: in-memory store (production persistence not yet wired).
- Pause/revoke: permissions can be paused or revoked per agent.

## Package distribution

- `private: true` — not published to npm.
- No license, repository, author, homepage, or publishConfig declared.
- No library entry point (`exports`/`main`) — surfaces are the four `bin` commands and the
  stdio MCP server.
- Consumers run from a checkout: `npm ci && npm run build`, then `node dist/…`.
