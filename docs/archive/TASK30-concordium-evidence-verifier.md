# TASK 30 — Real Concordium Evidence Verifier Integration (Read-Only)

Date: 2026-11-05 · Baseline HEAD `4c8994d` · No network, no signing, no submission.

## Recommendation

**IMPLEMENTED AND LOCALLY VERIFIED.** A real read-only adapter (`ConcordiumEvidenceVerifier`)
queries `getBlockItemStatus` through the official SDK and maps node responses into the
facilitator's evidence contract. Every ambiguous or malformed response is inconclusive.
Default configuration is `none` — reconciliation cannot finalize anything unless an operator
explicitly selects a verifier.

## 1. SDK versions and verified source behaviour

| Package | Version |
|---|---|
| `@concordium/web-sdk` | 12.0.2 |
| `@x402/concordium` | 2.29.0 |
| `@x402/core` | 2.29.0 |
| Node | 26.7.0 |

Source references (all in `node_modules/@concordium/web-sdk/lib/esm/grpc/`):

- `GRPCClient.js:113-119` — `getBlockItemStatus(transactionHash)`:
  ```js
  async getBlockItemStatus(transactionHash) {
      const transactionHashV2 = { value: TransactionHash.toBuffer(transactionHash) };
      const response = await this.client.getBlockItemStatus(transactionHashV2).response;
      return translate.blockItemStatus(response);
  }
  ```
  The SDK method itself does **not** return `undefined` for a missing transaction — a
  missing block item surfaces as a gRPC `NOT_FOUND` error (see `GRPCClient.js:1180`
  `if (isRpcError(e) && e.code === 'NOT_FOUND')`). The `@returns undefined` doc comment is
  inaccurate; the code is authoritative.

- `translation.js:2024-2041` — `blockItemStatus()`:
  ```js
  switch (itemStatus.status.oneofKind) {
    case 'received':  return { status: 'received' };
    case 'committed': return { status: 'committed', outcomes: [...trBlockItemSummaryInBlock] };
    case 'finalized': return { status: 'finalized', outcome: trBlockItemSummaryInBlock(...) };
    default: throw Error('BlockItemStatus was undefined!');
  }
  ```
  **Three** statuses only. An unexpected shape **throws** in translation — it does not
  degrade to a permissive value.

- `translation.js:2018-2023` — `trBlockItemSummaryInBlock()`:
  ```js
  return { blockHash: BlockHash.fromProto(...), summary: blockItemSummary(...) };
  ```
  **Finalized evidence does carry a `blockHash`** — a verifiable identifier additional to the
  transaction hash. `committed` carries an **array** of these.

- `translation.js:1981-1986` — `blockItemSummary()` base:
  ```js
  { index, energyCost, hash: TransactionHash.fromProto(...) }
  ```
  **The transaction hash IS included in the status response** (`summary.hash`), so the
  adapter can bind evidence to the requested hash rather than trusting the request.

- `translation.js:1657-1675` — `trAccountTransactionSummary()`, failed representation:
  ```js
  case 'none': return { ...base, transactionType: SDK.TransactionKindString.Failed, ... }
  ```
  A **rejected/failed transaction is represented as `summary.transactionType === 'failed'`**,
  not as a distinct status. That is why the adapter tests `transactionType` before reporting
  `finalized`.

### `undefined` / `committed` / `finalized` semantics, as verified

| Shape | Meaning | Adapter result |
|---|---|---|
| `status: 'finalized'`, `summary.hash === requested`, `transactionType !== 'failed'` | on-chain, immutable, succeeded | `finalized` |
| `status: 'finalized'`, `summary.hash === requested`, `transactionType === 'failed'` | on-chain, immutable, **rejected** | `failed` → payment `rejected` (terminal) |
| `status: 'finalized'`, `summary.hash !== requested` | node returned a different transaction | **inconclusive** (hash mismatch) |
| `status: 'committed'` | included in a block, **not final** | `committed` → stays `outcome_unknown` |
| `status: 'received'` | mempool only | `pending` → stays `outcome_unknown` |
| gRPC `NOT_FOUND` | the node does not have it | **inconclusive** (never "not broadcast") |
| translation throw / malformed / unexpected shape | untrustworthy | **inconclusive** |
| timeout | no answer | **inconclusive** |

## 2. Implementation

`services/facilitator/src/concordiumEvidence.ts` (new, ~200 lines):

- `ConcordiumEvidenceVerifier implements EvidenceVerifier` — takes a `ConcordiumStatusClient`
  (structural interface, so tests inject a deterministic mock).
- Rejects anything that is not a 64-char hex hash **before** calling the node.
- Normalizes case (`toLowerCase`) so `ABC…` and `abc…` resolve to the same hash.
- `mapStatus(raw, requestedHash, source)` — a **pure exported function** so the mapping is
  testable without I/O.
- Never reads a caller-supplied `status`. The `EvidenceRequest` type has no such field; the
  verifier answers only from the node response.

### Hash binding (the critical invariant)

The adapter does not trust that the node answered about the transaction it asked for. It
extracts `outcome.summary.hash` and requires an exact match with the requested hash. A
mismatch yields `{available: false, observed: 'unknown', error: 'hash mismatch: …'}` — the
payment cannot advance and cannot be rejected either.

This matters because a node could return a well-formed `finalized` payload for a *different*
transaction (bug, wrong node, adversarial proxy). Without the binding check that would
finalize the wrong payment.

## 3. Configuration

New env vars, all default-deny:

| Variable | Default | Effect |
|---|---|---|
| `FACILITATOR_EVIDENCE_MODE` | `none` | `none` → empty fixture table, **nothing can finalize**. `fixture` → offline fixture table. `grpc` → real adapter. |
| `FACILITATOR_NODE_HOST` | — | Required when mode is `grpc`. |
| `FACILITATOR_NODE_PORT` | — | Required when mode is `grpc`; validated 1–65535. |
| `FACILITATOR_NODE_USE_TLS` | `0` | `1` for TLS. |

Validation is fail-closed: `grpc` without host/port throws `ConfigurationError` at startup.
No node credentials are read, stored, or logged — the Concordium gRPC endpoint is
unauthenticated by design.

`buildVerifier()` in `server.ts` is the single construction site. `opts.verifier` still wins,
so every existing test that injects a fixture verifier is unaffected.

## 4. Testing

`test/task30-concordium-evidence.test.mts` — **22/22**, fully offline against a mock
`ConcordiumStatusClient`.

Covers: finalized-success, finalized-failed, mismatched hash, missing summary hash, missing
outcome, committed, received, `undefined`, `null`, unsupported status, non-object response,
`NOT_FOUND`, connection failure, timeout, invalid short hash (client never called), invalid
non-hex hash, uppercase normalization, reconcile-finalizes, reconcile-committed-stays-pending,
terminal idempotency, concurrent reconcile (exactly one `changed`), `mapStatus` purity.

## 5. Regression

| Suite | Result |
|---|---|
| task25-facilitator | 36/36 |
| task26-settlement-durability | 32/32 |
| task27-multiprocess-settlement | 16/16 |
| task29-prebroadcast | 65/65 |
| task29-crashboundaries | 21/21 |
| task29.1-postsubmit-crash | 49/49 |
| task30-concordium-evidence | 22/22 |
| **full suite** | **1442/1442, 31 suites** |

## 6. Optional read-only connectivity check (NOT executed)

A later operator-authorized smoke test would be:

```console
FACILITATOR_MODE=mock \
FACILITATOR_EVIDENCE_MODE=grpc \
FACILITATOR_NODE_HOST=<operator-supplied testnet node host> \
FACILITATOR_NODE_PORT=<operator-supplied port> \
FACILITATOR_NODE_USE_TLS=1 \
FACILITATOR_DB_PATH=/tmp/facilitator-smoke.db \
FACILITATOR_RECONCILE_ENABLED=1 \
FACILITATOR_OPERATOR_TOKEN_SHA256=<sha256 of an operator token> \
npm start
```

then `POST /reconcile` with a **previously persisted** hash. **This task did not run it.**
No endpoint URL is invented here: the host and port must come from the operator, and the
Concordium documentation's node endpoints were not contacted or asserted.

## 7. Changed files

```
NEW:
  services/facilitator/src/concordiumEvidence.ts        adapter + pure mapping
  test/task30-concordium-evidence.test.mts              22 tests
  docs/archive/TASK30-concordium-evidence-verifier.md

MODIFIED:
  services/facilitator/src/config.ts                    +evidenceMode, nodeHost/Port/UseTls + validation
  services/facilitator/src/server.ts                    +buildVerifier(), imports

NOT MODIFIED:
  src/* (gateway) · src/audit/lock.ts · token 1004 · any signer or submission path
```

`git status --short` shows the new adapter/test/doc as untracked; `services/facilitator/` is
entirely untracked since it was created after `4c8994d`, so `git diff --stat` reports only
the pre-existing TASK 20–23 gateway changes.

## 8. Remaining blockers before testnet sponsor provisioning

1. **Sponsor signer** — `createSigner()` still throws in `real` mode. Requires a funded,
   separately operated sponsor account; no key material may enter this repository.
2. **Node endpoint provisioning** — `grpc` mode needs an operator-supplied host/port. This
   task deliberately did not contact, test, or document any real endpoint.
3. **Live evidence verification** — the adapter is verified against deterministic fixtures
   only. Its behaviour against a real node's `NOT_FOUND`, TLS, and retry semantics is
   unverified. That is the first thing the connectivity smoke test should establish.
4. **Ordering fix already in place** — TASK 29/29.1 closed the crash windows; nothing here
   changes them.

## 9. Constraints honoured

- Zero network interaction. No node contacted, no gRPC call, no DNS lookup to a node.
- No signing, no private-key access, no sponsor provisioning.
- No transaction construction, submission, or broadcast.
- No real facilitator activation.
- Replay protection and crash recovery unchanged (all suites green).
- Token 1004 untouched.
- No commit, push, publish, or GitHub issue. HEAD remains `4c8994d`.
