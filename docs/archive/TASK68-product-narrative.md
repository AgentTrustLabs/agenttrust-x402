# TASK 68 — AgentTrust Product Narrative

## 1. Problem

AI agents increasingly act on behalf of humans and other agents: they search, verify, pay, and
execute tasks. In most systems today an agent is just a string name or an API key. There is no
durable, independently verifiable answer to three questions:

1. Who owns this agent?
2. Is the agent still active and trustworthy right now?
3. Should I pay it, and how do I prove I paid?

AgentTrust addresses this by binding agent identity to a Concordium on-chain registry entry,
verifying it independently from a second process, and gating commerce behind an explicit trust
policy and a settlement boundary.

## 2. Human ownership and agent identity

- An agent is registered in the CIS-8004 Agent Registry as token `1004` (`JyP9YLib1wYgFmztkcKJL`)
  on Concordium Testnet.
- The registration binds a public owner address, an agent type, a metadata hash, and a status.
- The Agent Card is a 2 777-byte JSON document published off-chain; its SHA-256
  (`3f614404…`) is recorded on chain, so the card cannot be swapped silently.
- Verification is performed by an independent process that fetches the card itself, computes
  SHA-256 itself, and compares it to the on-chain hash. No shared cache, no shared fetcher.
- Trust policy evaluation (`STRICT_POLICY`, `PARANOID_POLICY`) produces an explicit
  `TRUSTED` / rejected verdict with reasons.

## 3. CIS-8004 token 1004 and the Agent Card

- Token 1004 is the live, real Testnet identity for this agent.
- The Agent Card carries the agent's capabilities, endpoints, and metadata.
- The on-chain metadata hash makes the card tamper-evident.
- `node dist/cli/verify.js --token-id 1004` performs read-only verification and exits 0 when
  trusted.

## 4. MCP / API capabilities

The MCP server (`src/mcp/server.ts`, `src/mcp/tools.ts`) exposes six tools over stdio
(JSON-RPC 2.0):

1. `registry.search` — search the CIS-8004 registry.
2. `registry.card` — fetch an agent's Agent Card.
3. `trust.verify` — independent trust verification (owner, badge, status, contract refs).
4. `trust.policy` — evaluate a trust policy.
5. `commerce.simulate` — trust-gated commerce orchestration with a simulated payment.
6. `audit.verify` — verify the hash-chained audit trail.

All inputs are schema-validated; no filesystem, URL, shell, or network override is accepted
from the client. Errors are reduced to code + message.

## 5. Sponsored x402-related transactions

AgentTrust includes an x402 exact-CCD payment flow (requirements, verification, settlement
gate) and a Concordium facilitator that can sign and submit sponsored V1 transactions.

- The facilitator signs through a dedicated IPC signing service; it never holds key material.
- The gateway's default facilitator is `DENY_ALL_FACILITATOR`: no payment request can settle
  unless an operator explicitly injects a real facilitator.
- A standalone real sponsored transfer has been demonstrated on Testnet (TASK 65):
  1 microCCD, sender → recipient, sponsored by a dedicated sponsor account, finalized on chain.
- This proves signing, submission, finalization, and fee payment. It is NOT a complete
  end-to-end HTTP x402 agent payment flow through the MCP commerce path.

## 6. Implemented vs. planned

Implemented and verified:
- CIS-8004 registration (token 1004), Agent Card publication and hash.
- Independent trust verification and trust policy evaluation.
- Trust-gated commerce orchestration with a hash-chained audit trail.
- x402 exact-CCD requirements, verification, and settlement gate (code).
- MCP server with six tools.
- Real Concordium facilitator with IPC signing, gRPC submission, recovery, and secret injection.
- One real sponsored Testnet transfer (finalized).

Demonstrated on Testnet:
- Token 1004 identity and Agent Card.
- Trust verification (TRUSTED).
- Real sponsored transfer (TASK 65).

Not yet implemented or not yet demonstrated:
- Live HTTP x402 agent payment end to end through MCP commerce (commerce uses a mock
  facilitator; `settled: false`).
- Public facilitator access or unrestricted payment requests.
- Mainnet deployment.
- Automatic recovery scheduling in production (recovery is opt-in and bounded).
