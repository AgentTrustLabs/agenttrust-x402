# TASK 68 — Three-Minute Demo Script

Total runtime: 3:00. Live commands are read-only except where explicitly marked as a recorded
demo. No new transactions are sent during the demo.

## 0:00–0:25 — Problem and product introduction

Narrative:
"AI agents act for humans, but there is no durable answer to: who owns this agent, is it
trustworthy right now, and should I pay it? AgentTrust binds agent identity to a Concordium
on-chain registry entry, verifies it independently, and gates commerce behind an explicit trust
policy."

Show: `README.md` opening paragraph.

Key points:
- Agent identity is not an API key; it is a CIS-8004 registry entry on Testnet.
- Trust is verified independently, not via a shared cache.
- Commerce has a hard settlement gate; the default facilitator denies all.

## 0:25–0:55 — Agent identity and ownership verification

Live command (read-only):
```
node dist/cli/verify.js --token-id 1004
```
Expected output: `TRUSTED` (exit 0).

Show: token 1004, agent `JyP9YLib1wYgFmztkcKJL`, Agent Card hash `3f614404…`.

Narrative:
"Token 1004 is the live Testnet identity. The Agent Card is published off-chain, and its SHA-256
hash is stored on chain, so a swapped card is detectable. Verification fetches the card, hashes
it, and compares to the on-chain value."

## 0:55–1:35 — AgentTrust MCP/API capabilities

Live command (read-only):
```
node dist/cli/verify.js --token-id 1004
```
and
```
node dist/mcp/server.js
```
Explain the six tools:
- `registry.search`
- `registry.card`
- `trust.verify`
- `trust.policy`
- `commerce.simulate`
- `audit.verify`

Show: `docs/MCP-GUIDE.md` tool list.

Narrative:
"MCP is an untrusted input boundary. Every input is schema-validated. There is no tool that can
settle a payment; `commerce.simulate` always uses the mock facilitator and returns `settled: false`."

## 1:35–2:25 — Real sponsored transaction and CCDExplorer evidence

Show: the finalized transaction on CCDExplorer:
```
https://ccdexplorer.io/transactions/c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a?network=testnet
```

Narrative:
"This is a real V1 sponsored simple transfer on Concordium Testnet. The sender transferred
1 microCCD to the recipient; the sponsor paid the fee. The transaction finalized in block
`f7dcec686e29bfd6acca13f7b8f3d2e88d054058776c4a4df5db68d6b4320bd7`."

Show: hash, energy 635 NRG, fee 4.695636 CCD, sender/sponsor/recipient addresses.

Important limitation to state:
"This proves signing, submission, finalization, and fee payment. It is NOT a complete end-to-end
HTTP x402 agent payment flow through MCP commerce."

## 2:25–3:00 — Why this matters and future direction

Narrative:
"Agent identity is verifiable, trust is explicit, and payments have a hard boundary. The
facilitator signs through a dedicated IPC service, never holds keys, and can submit real
sponsored transactions. A complete HTTP x402 flow is now demonstrated: an unpaid request
returns 402, the payment is verified and finalized on Testnet, and only then does the
provider return 200 with the resource."

Recorded HTTP evidence (no live transaction during the demo):
- Unpaid request → HTTP 402 with a valid x402 payment requirement.
- Paid request → HTTP 200 with the protected resource, after independent on-chain verification.
- Transaction hash: `b472caa354f9c017cc7d6254fbe12ef8fc2bc0ee3c989a561c6cd9bf957220c2`
- Finalization: `finalized`, block `cf0b758b7c79350c3c4fe6458b298da15e1adde31b8eb29d4f19c18708db5022`
- Energy: 635 NRG, fee: 4.640474 CCD, amount: 1 microCCD.

## Demo limitations (updated)

- The live HTTP flow is demonstrated with a recorded transaction; no new transaction is sent
  during the demo.
- `commerce.simulate` remains simulated (`settled: false`); it is not presented as real.
- Replay protection is in-memory within a provider process.
- `DENY_ALL_FACILITATOR` remains enabled; settlement remains disabled outside the bounded
  demonstration path.

