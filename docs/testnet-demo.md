# AgentTrust — Testnet Demo

This document covers running and verifying the AgentTrust demo on Concordium Testnet.

## Prerequisites

- Node.js ≥ 22 (verified on 22.23.3 and 26.7.0).
- `npm ci && npm run build`.
- Outbound HTTPS for the live registry and Agent Card fetch.
- No API keys, no wallet, no credentials required.

## Quick start

```bash
npm ci                 # reproducible install
npm run build          # tsc — emits dist/
npm test               # compiles via pretest, then runs all suites
```

Verify the toolchain:

```bash
npm run typecheck                       # tsc --noEmit
node dist/cli/verify.js --token-id 1004  # read-only, exit 0 = TRUSTED
```

## Demo (≈3 minutes)

```bash
cd /home/ubuntu/projects/agenttrust
npm run build            # the demo drives dist/mcp/server.js
node scripts/mcp-demo.mjs --out docs/evidence/mcp-demo
```

Exit `0` means all nine steps passed, evidence artifacts were written and re-read,
`settled` is `false`, and the server shut down cleanly. Any failure — missing `dist/`,
server crash, malformed JSON-RPC, request timeout, missing evidence — exits `3` with a
`DEMO FAILED:` line on stderr and writes no success artifact.

Drives the real server over stdio and prints:

```
tools                6
1 discover          token 1004
2 card              2777 bytes  sha256 3f6144046d843b7b…
3 trust             TRUSTED
4 second agent      19  REJECTED  (live third-party)
6 success           access_granted  settled=false (SIMULATED)
7 trust reject      trust_rejected  facilitator calls=0
8 payment reject    payment_rejected  settled=false
9 audit verified    3/3
  forged auth       AUTHORIZATION_NOT_ACCEPTED
  shutdown          exit 0, stderr clean
NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED
```

Narrative, in order:

1. **Discovery** — `registry.search` finds AgentTrust (token 1004) in the live registry.
2. **Card** — 2 777 bytes, SHA-256 `3f614404…` — the same value the chain records.
3. **Verification** — every required check PASS → `TRUSTED`.
4. **A second, independent agent** — token 19 from the live registry, `REJECTED` because
   its card lacks the Concordium badge extension. Real third party, real rejection.
5. **Commerce** — trust gate passes, mock payment verifies, mock settlement, access granted.
   Read the disclaimer aloud: simulated.
6. **Trust rejection** — an owner pin mismatch stops the flow *before* a payment
   requirement exists: `facilitator calls = 0`.
7. **Payment rejection** — `mode: "reject"` → `payment_rejected`, no receipt, nothing settled.
8. **Audit** — all three trails verify: 8 events for the grant, 4 for the trust rejection,
   7 for the payment rejection, each with a matching checkpoint.
9. **Boundary** — a forged authorization is refused by name.

## Live read-only Testnet evidence

Executed against `grpc.testnet.concordium.com:20000` (read-only).

### Registration (token 1004)

- Agent: `JyP9YLib1wYgFmztkcKJL`
- Agent Card: 2 777 bytes, SHA-256 `3f614404…` (on-chain metadata hash).
- Trust verdict: `TRUSTED` (read-only, exit 0).

### First controlled sponsored transaction (TASK 65)

- Transaction hash: `c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a`
- Finalization status: `finalized`
- Block hash: `f7dcec686e29bfd6acca13f7b8f3d2e88d054058776c4a4df5db68d6b4320bd7`
- Outcome: `transfer` (successful), 635 NRG, 4.695636 CCD fee, 1 microCCD amount.
- Sender: `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`
- Sponsor: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`
- Recipient: `3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB`

### Second transaction (TASK 70)

- Transaction hash: `b472caa354f9c017cc7d6254fbe12ef8fc2bc0ee3c989a561c6cd9bf957220c2`
- Block hash: `cf0b758b7c79350c3c4fe6458b298da15e1adde31b8eb29d4f19c18708db5022`

### Third transaction — real facilitator payment (2026-11-11)

The first payment settled through the production three-service deployment (Facilitator +
Authorization Owner + Signing Service) is documented in
[`docs/demo-real-payment.md`](demo-real-payment.md): transaction
`b271dc8b69fcd0296b4087c01cb308646d7bc55c22f35001fb9702b6eddcfdbb`, finalized, 1 microCCD,
635 NRG, sponsor fee 4.620843 CCD. Verify it with `npx tsx scripts/demo-real-payment.mts`.

### Provider end-to-end over the real verifier

| Scenario | Result |
|---|---|
| Correct recipient + amount (T65) | **200 paid** |
| Wrong recipient | 402 `chain_mismatch` (`recipient mismatch`) |
| Wrong amount | 402 `chain_mismatch` (`amount mismatch`) |
| Unknown transaction | 503 `verification_unavailable` (no release) |
| Replay same (requestId, txHash) | first 200, second **409 replay** |

### Concordium verification rules

- `getBlockItemStatus` for finalized/rejected outcome.
- Recipient, amount, network, finality verified before granting access.
- Replay protection: track consumed (requestId, txHash) pairs.

## Configuration for demo

- `AGENTTRUST_AUDIT_ROOT` — audit trail directory (default `/tmp/agenttrust-audit`).
- `AGENTTRUST_REGISTRY_MCP` — registry base URL.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AUDIT_READ_DENIED` on a filename you just saw | `AGENTTRUST_AUDIT_ROOT` differs between runs |
| `UPSTREAM_ERROR: registry agent_of` | registry unreachable, or the token does not exist |
| `card_retrieved: FAIL` | the agent's `agent_uri` is dead (common for third-party agents) |
| Host sees nothing | the host is talking HTTP, not stdio |
| `TIMEOUT` | a tool exceeded 30 s (slow registry) |
| Missing `dist/` | run `npm run build` first |
| `dist/mcp/server.js not found` | build output missing; `npm run build` |

## Testnet readiness

- Read-only account verification: `npx tsx scripts/account-verify-live.mts`.
- Testnet readiness probe: `npx tsx scripts/testnet-readiness.mts`.
- Runtime readiness: `bash scripts/runtime-readiness.sh`.

## Limitations

1. No real settlement — no CCD facilitator exists.
2. No operator authorization channel — refused at MCP boundary.
3. stdio only — no HTTP/SSE transport.
4. Unauthenticated — any local process can spawn the server.
5. Audit trail not immutable without external anchor.
6. `AGENTTRUST_AUDIT_ROOT` defaults to `/tmp/agenttrust-audit`, shared by all runs.
7. Third-party agent cards vary — dead URLs, localhost URLs, mismatched hashes.
8. On-chain agent account creation / funding not implemented.
9. No real on-chain settlement.
