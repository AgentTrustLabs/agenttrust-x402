# TASK 68 — Demo Runbook

## Required services

1. Node.js ≥ 22 and npm (lockfile 3).
2. AgentTrust gateway build (`npm run build`).
3. Concordium Testnet node access (`grpc.testnet.concordium.com:20000`, TLS).
4. For the real-transaction evidence display only: a public explorer link (no service needed).

No wallet, API key, or credential is required for the read-only demo. Wallet operations are
out of scope for this runbook.

## Environment configuration (public, non-secret)

```
NODE_ENV=production
AGENTTRUST_AUDIT_ROOT=/tmp/agenttrust-audit
```

Do not put wallet paths, export filenames, or secret values in the demo environment or in any
public material. Wallet provisioning is an operator-only procedure documented in
`docs/archive/TASK58-sponsor-wallet-provisioning-runbook.md`.

## Startup sequence

```
npm ci
npm run build
npm run typecheck
node dist/cli/verify.js --token-id 1004
```

Expected: typecheck exits 0; verify exits 0 and prints `TRUSTED`.

## Exact demonstration commands and expected outputs

### Step 1 — Trust verification (read-only)

```
node dist/cli/verify.js --token-id 1004
```
Expected: exit 0, `TRUSTED`.

### Step 2 — MCP server (stdio)

```
node dist/mcp/server.js
```
Expected: JSON-RPC 2.0 server on stdio; exits 0 on clean shutdown.

### Step 3 — Commerce simulation (mock facilitator)

```
node dist/cli/commerce.js --token-id 1004 --out /tmp/agenttrust-demo
```
Expected: `access_granted` or trust rejection; `settled: false`; disclaimer present.

### Step 4 — Real sponsored transaction evidence

Open the public explorer link:
```
https://ccdexplorer.io/transactions/c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a?network=testnet
```
Expected: finalized transfer of 1 microCCD, energy 635 NRG, sponsor fee 4.695636 CCD.

### Step 5 — HTTP x402 end-to-end flow (recorded, no new transaction)

Recorded evidence of the live flow is in `docs/http-x402-integration.md`:

```
GET  /protected  → HTTP 402 (x402 payment requirement)
POST /protected  → HTTP 200 (protected resource) after independent on-chain verification
```

Transaction: `b472caa354f9c017cc7d6254fbe12ef8fc2bc0ee3c989a561c6cd9bf957220c2`
Block: `cf0b758b7c79350c3c4fe6458b298da15e1adde31b8eb29d4f19c18708db5022`
Energy: 635 NRG, sponsor fee: 4.640474 CCD, amount: 1 microCCD.

No new transaction is sent during the demo. The provider and facilitator are local-only
(127.0.0.1) and must not be exposed publicly.

## Recovery steps if a demo component fails

- Build failure: `npm ci && npm run build`; check Node ≥ 22.
- Registry unreachable: retry; the registry is a live Testnet service. Fall back to recorded
  evidence in `docs/archive/TASK68-evidence-index.md`.
- MCP server fails to start: check `dist/mcp/server.js` exists; rerun `npm run build`.
- Commerce exits non-zero: expected for trust rejection (exit 1) or payment rejection (exit 2);
  only exit 3 is a usage/transport error.
- Explorer link unavailable: use the recorded hash, block hash, and status from
  `docs/archive/TASK65-first-controlled-testnet-transaction.md`.

## Safe fallback using recorded evidence

If live Testnet is unavailable, use the recorded evidence:
- `docs/archive/TASK68-evidence-index.md`
- `docs/archive/TASK65-first-controlled-testnet-transaction.md`
- `docs/archive/TASK63-testnet-facilitator-runtime-readiness.md`

Do not attempt to re-run the transaction. No new CCD may be spent during the demo.

## Secret and wallet protection

- No wallet export, seed phrase, private key, or credential is used in the demo.
- No signing IPC service is started.
- No facilitator is started in real mode.
- `DENY_ALL_FACILITATOR` remains enabled; settlement remains disabled.
- Do not display wallet paths, export filenames, or environment values containing secrets.
- Do not screenshot or copy terminal output that contains key material.
