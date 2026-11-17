# AgentTrust x402 — Architecture

AgentTrust x402 is a verifiable trust and payment layer for independently operated AI agents on the
Concordium blockchain. This document describes the system architecture and workflows.

## Overview

AgentTrust answers one question with evidence: *is this agent really who it claims to be, on
chain, right now — and should I pay it?*

It registers an agent in the CIS-8004 Agent Registry, verifies other agents **independently**
(its own `fetch`, its own SHA-256, its own comparison against the on-chain metadata hash),
applies an explicit trust policy, runs x402 exact-CCD payment logic behind a hard settlement
gate, records everything in a hash-chained audit trail, and exposes all of it over the Model
Context Protocol (MCP) so any AI agent can use it as a tool.

## Components

```
src/
  core/       network + contract constants
  registry/   Concordium Agent Registry MCP client, transaction builder
  verify/     independent cross-agent verification (no imports from registration path)
  payments/   x402 exact-CCD protocol, payment gate, facilitator probe, signing boundary
  commerce/   trust policy + orchestrator, shared mock simulation
  audit/      hash-chained JSONL trail, lock hardening
  mcp/        MCP tool surface + stdio server
  pairing/    wallet connection, agent pairing, permissions, agentic wallets,
              wallet skills, x402 client integration
  cli/        verify / commerce / registration entry points
```

## Trust verification flow

1. `registry.search` / `registry.card` fetch the agent's card from the live registry.
2. `verify/` independently re-fetches the card, recomputes SHA-256, compares against the
   on-chain metadata hash.
3. `trust.verify` applies the trust policy (owner, badge, status, contract refs).
4. Verdict: `TRUSTED` / `REJECTED` / `INCONCLUSIVE` / `NOT_TESTED`. Only `TRUSTED` allows
   commerce. `REJECTED` and `INCONCLUSIVE` both deny payment.

`REJECTED` is never produced by an HTTP error, redirect, DNS/TLS failure, or timeout — those
are `INCONCLUSIVE` with `failure_kind: "unavailable"`.

## Commerce flow (simulated)

1. `commerce.simulate` runs the trust-gated orchestrator with an injected facilitator.
2. Trust gate must pass (`TRUSTED`).
3. Payment gate (x402 exact-CCD) must pass.
4. Settlement is **mock** — `settled: false`, `facilitator: "mock"`. No transaction is signed,
   submitted, or recorded on chain.

## x402 payment flow

- `payments/x402.ts`: `buildPaymentRequirements`, `buildPaymentRequired` (402 body),
  `preflightPaymentPayload`, `authorizePayment` (preflight → facilitator.verify →
  facilitator.settle → receipt), `DENY_ALL_FACILITATOR` gate.
- `payments/x402Sdk.ts`: adapts to `@x402/concordium` and `@x402/core` SDKs.
- HTTP provider (`src/x402/provider.ts`): serves protected resource, emits 402, verifies
  payment proof against live Testnet, grants 200 only on finalized matching transfer.
- HTTP x402 is **BLOCKED** for complete end-to-end real settlement: no public CCD
  facilitator exists. See integration doc.

## Agent wallet architecture

The gateway runs a full agent-wallet stack on top of trust and payment layers:

- **Connect Wallet page**: non-custodial Concordium Browser Wallet connection. No keys in
  this process.
- **Ownership verification**: signed challenge proving wallet control.
- **Agent pairing**: links a wallet to a CIS-8004 identity / Agent Card.
- **Permissions**: per-agent spending limits, recipient allowlist, network binding,
  manual approval, reservations.
- **Dedicated agent wallets**: independent signing identities with local key custody.
- **Agent Wallet Skills**: `wallet_get_status`, `wallet_get_permissions`,
  `wallet_request_payment`, `wallet_request_approval`, `wallet_get_activity`.
- **Signing boundary**: four-stage (authorization → signing request → out-of-process signing
  → settlement gate). Private keys stay in a local key store; agent-facing APIs and the
  browser never see key material.

### Permission model

- Schema: spending limits, allowlist, network binding, pause/revoke.
- Enforcement: limits, recipient allowlist, network binding, manual approval, reservations
  are checked before any facilitator call.
- Storage: in-memory store (production persistence not yet wired).

### Key custody

- Signing keys live in a local SQLite store (metadata only, never key material in logs).
- `AccountSigner` is never imported by the gateway; signing happens out-of-process.
- MCP clients cannot supply `OperatorAuthorization` — rejected with
  `AUTHORIZATION_NOT_ACCEPTED`.

## Audit trail

- Hash-chained JSONL trail: each entry hashes the previous, detecting modification,
  insertion, deletion, reordering, and tail truncation.
- Lock hardening: stale lock race and ownership hardening.
- Checkpoint file beside the log; without an external anchor, a consistent rewrite of both
  log and checkpoint is undetectable.
- Default audit root: `/tmp/agenttrust-audit` (shared by all runs on the host).

## Crash-safe recovery

- Submission state machine: prepared → submitting → broadcast → reconciled.
- Idempotency: durable idempotency keys prevent duplicate submission.
- Recovery concurrency: exactly-once submission across processes.
- Crash boundary: post-submission/pre-markBroadcast crash verified (transaction hash is
  the recovery authority).

## Sponsor signing (Concordium)

- Sponsor signer: out-of-process via IPC (separate signing service).
- Ed25519 signing with fee validation.
- V1 sponsored submission: wire converter (SDK V1 wire shape), gRPC transport.
- Authorization: durable authorization state, atomic authorization, authorization
  provenance, payment context integrity, legacy recovery.
- Threat model: production IPC contract, owner process isolation, least-privilege runtime.

## Security findings (preserved)

- **M1 (remediated)**: `recordSignEvent()` was a public method on
  `SettlementRepository` that could insert an `approved` event without passing the
  durable-state gate. **CLOSED** — removed from the public interface; a DB-level trigger
  (`trg_sign_events_approved_requires_created`) enforces it for every writer, including raw SQL.
  Test: `authorization-audit-remediation.test.mts` M1.1 asserts `recordSignEvent` is absent.
- **M2 (remediated)**: state-based rejections (`prepared`, `submitting`, ...)
  were not audited. **CLOSED** — every durable-state rejection is recorded as a `rejected`
  event in the same transaction; missing payments are audited in a separate `sign_attempts`
  table without inventing a payment row.
- **M1.1 / M2.1 regression tests**: 23 adversarial tests in
  `authorization-audit-remediation.test.mts` guard against reintroduction.

## Concordium integration

- Network: Concordium Testnet (CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27`).
- CIS-8004 Agent Registry: index 12802, subindex 0.
- CIS-8 External Key Registry: index 12801, subindex 0.
- Standards: CIS-0, CIS-2, CIS-8004.
- Live registry: `https://agent-registry-mcp.concordium.com/` (40 tools, holds no private keys).
- Indexer: `https://agent-registry-indexer.concordium.com/`.
- gRPC: `https://grpc.testnet.concordium.com:20000`.
- Admin: `3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8`.
- Mainnet (docs cross-check): CIS-8004 index 10082, CIS-8 index 10081.

## Known limitations

1. No real settlement — no CCD facilitator exists.
2. No operator authorization channel — refused at MCP boundary by design.
3. stdio only — no HTTP/SSE transport.
4. Unauthenticated — any local process can spawn the server (acceptable: tools cannot spend
   or mutate chain state).
5. Audit trail not immutable — consistent rewrite of log + checkpoint is undetectable.
6. `AGENTTRUST_AUDIT_ROOT` defaults to `/tmp/agenttrust-audit`, shared by all runs.
7. Third-party agent cards vary — dead URLs, localhost URLs, re-published cards with
   mismatched hashes.
8. On-chain agent account creation / funding not implemented.
9. No real on-chain settlement.
