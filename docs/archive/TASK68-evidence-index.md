# TASK 68 — Evidence Index

All evidence references are public or reproducible. No wallet contents, private keys, or secret
fingerprints are included.

## A. Implemented and verified

### A1. CIS-8004 identity and Agent Card
- Network: Concordium Testnet.
- Token: `1004`.
- Agent: `JyP9YLib1wYgFmztkcKJL`.
- Agent Card: 2 777 bytes.
- Agent Card SHA-256: `3f614404…` (on-chain metadata hash).
- Source: `README.md` (CIS-8004 registration + Agent Card publication).

### A2. Trust verification
- Command: `node dist/cli/verify.js --token-id 1004`
- Result: `TRUSTED` (read-only, exit 0).
- Source: `README.md`, `docs/archive/TASK03-result.md`.

### A3. MCP server
- Six tools: `registry.search`, `registry.card`, `trust.verify`, `trust.policy`,
  `commerce.simulate`, `audit.verify`.
- Source: `src/mcp/tools.ts`, `docs/MCP-GUIDE.md`.

### A4. Commerce gate
- Trust-gated orchestration + hash-chained audit trail.
- Payment uses a deterministic local mock facilitator; `settled: false`.
- Source: `src/commerce/orchestrator.ts`, `src/commerce/simulation.ts`, `README.md`.

### A5. Real Concordium facilitator
- Real-mode startup, IPC signing service, gRPC submission, bounded startup recovery,
  env-driven sponsor wallet injection, accurate real/mock logging.
- Source: `services/facilitator/src/server.ts`, `services/facilitator/src/config.ts`,
  `docs/archive/TASK64-pre-demo-runtime-completion.md`.

### A6. Sender wallet verification (TASK 66)
- Sender wallet export controls the approved sender account.
- Source: `docs/archive/TASK66-sender-wallet-verification.md`.

### A7. Recipient validation (TASK 67)
- Recipient account exists on Testnet.
- Source: `docs/archive/TASK67-recipient-validation.md`.

## B. Demonstrated on Testnet

### B1. Real sponsored transfer (TASK 65)
- Transaction hash:
  `c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a`
- Finalization status: `finalized`.
- Block hash:
  `f7dcec686e29bfd6acca13f7b8f3d2e88d054058776c4a4df5db68d6b4320bd7`
- Outcome: `transfer` (successful).
- Energy cost: 635 NRG.
- Sponsor fee: 4 695 636 microCCD (4.695636 CCD).
- Amount: 1 microCCD.
- Sender: `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`.
- Sponsor: `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`.
- Recipient: `3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB`.
- Source: `docs/archive/TASK65-first-controlled-testnet-transaction.md`.

### B2. Signature verification
- Sender signature valid: true (official SDK, against live sender AccountInfo).
- Sponsor signature valid: true (official SDK, against live sponsor AccountInfo).
- Negative control: sender signature against sponsor account = false.
- Source: `docs/archive/TASK65-first-controlled-testnet-transaction.md`.

### B3. Account changes
- Sender: 19943.619923 CCD / nonce 4 → 19943.619922 CCD / nonce 5.
- Sponsor: 20000.000000 CCD / nonce 1 → 19995.304364 CCD / nonce 1.
- Recipient: 20000.000000 CCD / nonce 1 → 20000.000001 CCD / nonce 1.
- Source: `docs/archive/TASK65-first-controlled-testnet-transaction.md`.

### B4. Public explorer reference
- CCDExplorer: `https://ccdexplorer.io/transactions/c1029c57ae5d44b3c65870c86f363139fbbc2deaefd2a0a9e95534ae8a1bd67a?network=testnet`
- Note: the link is a public explorer reference; it is not an AgentTrust API.

## C. Not yet implemented or not yet demonstrated

- Live HTTP x402 agent payment end to end through MCP commerce (`commerce.simulate` uses a
  mock facilitator; `settled: false`).
- Public facilitator access or unrestricted payment requests.
- Mainnet deployment.
- Production recovery scheduling (recovery is opt-in and bounded; not automated on boot).

## D. Evidence discipline

- The sponsored transfer proves signing, submission, finalization, and fee payment.
- It does NOT prove a complete end-to-end HTTP x402 agent payment flow.
- All commerce simulations in the repo remain `settled: false` and are never presented as real.
