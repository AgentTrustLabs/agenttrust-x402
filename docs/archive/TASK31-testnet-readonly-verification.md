# TASK 31 — Testnet Read-Only Verification

Date: 2026-11-05T20:06:17Z (UTC) · Baseline HEAD `4c8994d`

## Executive summary

The installed SDK connected to the official Concordium Testnet endpoint, confirmed Testnet
identity, performed read-only chain-method queries, and the TASK30 adapter correctly
interpreted three real token-1004 historical transaction responses as `finalized` with hash
binding. Token 1004 remains unchanged. No signing, submission, or write occurred.

## VERIFIED

### Endpoint connection

| Property | Value |
|---|---|
| Host | `grpc.testnet.concordium.com` |
| Port | `20000` |
| Resolved IP | `34.36.245.204` |
| Transport | gRPC v2, TLS |
| Client | `ConcordiumGRPCNodeClient` (`@concordium/web-sdk/nodejs`) |
| Result | **Connected** |

### Network identity (Testnet)

`getConsensusStatus()` returned:

- `bestBlock`: `0a11754f6a707f358ec7da73844742dc311cdc554b9385f609d2445f3cdcb3ac`
  (varies per query — chain is live)
- `genesisBlock`: `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`

The genesis block begins with `4221332d34e1694168c2a0c0b3fd0f27` — the CAIP-2 chain identifier
used by AgentTrust (`ccd:4221332d34e1694168c2a0c0b3fd0f27`). **Mainnet was not contacted.**

### Read-only request

`getConsensusStatus` succeeded. This is a documented chain-method read-only query. No
mutating call was made.

### Actual transaction-status responses

Three historical transaction hashes, recovered from `docs/archive/TASK02-result.md` (local
authoritative record, not invented):

| # | Transaction hash | Status | Block hash | `transactionType` | Energy |
|---|---|---|---|---|---|
| 1 | `5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0` | `finalized` | `8df328f521a50f348a700afba89c37ca17c946996b1cef8b10cc3cd8da22e24a` | `update` | 2380 |
| 2 | `c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e` | `finalized` | `71119b6c22ad9c35c81a5688af61bacc18e1cf7925598e5c9d8c75ac38440c96` | `update` | 1859 |
| 3 | `cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a` | `finalized` | `32d80f4adc1e3183d09e66eaa35aa65eef593456fcd61c8f758d817e07241b27` | `update` | 1860 |

**Transaction hash field**: present at `outcome.summary.hash`, equal to the requested hash in
all three cases.

**Block hash representation**: `outcome.blockHash` is a 64-hex string.

**Sender**: `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` — the registered owner of
token 1004, consistent across all three transactions.

### Redacted actual SDK response

```json
{
  "status": "finalized",
  "outcome": {
    "blockHash": "8df328f5…e24a",
    "summary": {
      "index": "0",
      "energyCost": { "value": "2380", "__type": "ccd_energy" },
      "hash": "5abc7f8b…af0",
      "type": "accountTransaction",
      "cost": "22010289",
      "sender": "4dWn8miA…Zg4d",
      "transactionType": "update"
    }
  }
}
```

Truncated for readability; no connection details are present in this payload.

### TASK30 adapter verification against the real node

`ConcordiumEvidenceVerifier` fed each real response:

| Hash | `available` | `observed` |
|---|---|---|
| `5abc7f8b…` | `true` | `finalized` |
| `c93d7024…` | `true` | `finalized` |
| `cb0c2ef7…` | `true` | `finalized` |

**Hash binding verified**: the adapter requires `outcome.summary.hash === requestedHash`; all
three matched. No hash mismatch. No inconclusive result was upgraded to `finalized`.

### Token 1004 consistency

| Record | Value |
|---|---|
| Token ID | 1004 |
| Contract address | `JyP9YLib1wYgFmztkcKJL` (CIS-8004 badge) |
| Owner | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` |
| Agent Card URI | `https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json` |
| Agent Card SHA-256 | `3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564` |

Live verification at 2026-11-05T20:06:17Z (read-only):

```
TRUST DECISION             TRUSTED
sha256 (local)             3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)          3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions               0 (read-only)
```

The on-chain `metadata_hash` equals the local card hash. The transaction sender equals the
registered owner. **No change to token, URI, owner, metadata, or on-chain state.**

## NOT TESTED

- **Failed transaction status** — no historical failed transaction exists in the token-1004
  record, and this task explicitly prohibited creating one. Offline fixture coverage remains
  (TASK30 test 02: `transactionType: 'failed'` → `failed`).
- **Sponsor signing** — no sponsor exists; `createSigner()` throws in `real` mode.
- **Real settlement** — settlement remains disabled.

## BLOCKED

- Nothing in this task. The endpoint was reachable, all three historical hashes were
  queryable, and the adapter interpreted them correctly.

## Actual-node response vs TASK30 fixtures — compatibility

| Aspect | Fixture expectation | Actual node | Match |
|---|---|---|---|
| Status field | `status: 'finalized'` | `status: 'finalized'` | ✅ |
| Hash field | `outcome.summary.hash` | `outcome.summary.hash` | ✅ |
| Block hash | `outcome.blockHash` | `outcome.blockHash` (64-hex) | ✅ |
| Failed representation | `transactionType: 'failed'` | not exercised | — |
| `undefined` semantics | doc says returns `undefined` | **gRPC `NOT_FOUND` error** | ❌ doc inaccurate |

### SDK source / documentation discrepancy (documented, not worked around)

The SDK's `getBlockItemStatus` doc comment states `@returns undefined if it does not exist`.
The actual implementation (`translation.js:2024-2041`) throws
`Error('BlockItemStatus was undefined!')` for an undefined status, and a missing transaction
surfaces as a gRPC `NOT_FOUND` RPC error (`GRPCClient.js:1180`). The **code is authoritative**;
the doc comment is inaccurate. The adapter treats `NOT_FOUND` as inconclusive.

### One adapter correctness fix made during TASK31

`GRPCClient.getBlockItemStatus()` expects a `TransactionHash` object, not a string. Passing a
string produced `Request message serialization failure`. The adapter now converts with
`TransactionHash.fromHexString()` before calling the node. Offline tests are unaffected
(mock client ignores the argument type).

## Configuration safety

- Testnet-only: only `grpc.testnet.concordium.com:20000` was contacted.
- TLS: the SDK's `ConcordiumGRPCNodeClient` uses `@grpc/grpc-js` with
  `credentials.createSsl()`. The official endpoint requires TLS; no silent downgrade was made.
  Verified against `node_modules/@concordium/web-sdk/lib/esm/nodejs/grpc.js` (transport is
  `GrpcTransport` with channel credentials).
- No Mainnet endpoint, no unknown third-party RPC, no port scan.
- No credentials or private data sent; the node endpoint is unauthenticated.
- No environment secrets logged.

## Exact SDK versions

| Package | Version |
|---|---|
| `@concordium/web-sdk` | 12.0.2 |
| `@x402/concordium` | 2.29.0 |
| `@x402/core` | 2.29.0 |
| `@grpc/grpc-js` | 1.14.7 |
| `@protobuf-ts/grpc-transport` | 2.11.1 |
| Node | 26.7.0 |

## Regression results (exact commands and counts)

```console
$ npx tsx test/task25-facilitator.test.mts            → 36/36
$ npx tsx test/task26-settlement-durability.test.mts  → 32/32
$ npx tsx test/task27-multiprocess-settlement.test.mts → 16/16
$ npx tsx test/task29-prebroadcast.test.mts           → 65/65
$ npx tsx test/task29-crashboundaries.test.mts        → 21/21
$ npx tsx test/task29.1-postsubmit-crash.test.mts     → 49/49
$ npx tsx test/task30-concordium-evidence.test.mts    → 22/22
$ npm test                                            → all suites passed
$ npx tsc --noEmit                                    → OK
$ (cd services/facilitator && npx tsc -p tsconfig.json --noEmit) → OK
```

**1442/1442 tests, 31 suites.** No pre-existing failures observed in this run. (The
`task06.1` lock race documented in TASK 26/27/29 remains out of scope and did not fire.)

## Changed files

```
MODIFIED:
  services/facilitator/src/concordiumEvidence.ts   +TransactionHash conversion (correctness)
NEW:
  scripts/task31-testnet-readonly.mts             connectivity + evidence script
  docs/archive/TASK31-concordium-testnet-readonly.md      earlier draft of this report
  docs/archive/TASK31-testnet-readonly-verification.md    this file
```

## Remaining blockers before sponsor provisioning

1. **Sponsor signer** — `createSigner()` still throws in `real` mode. Requires a funded,
   separately operated sponsor account; no key material may enter this repository.
2. **Failed-status live verification** — no historical failed transaction exists. Offline
   fixture coverage remains.
3. **`NOT_FOUND` / timeout live verification** — requires a hash that is genuinely absent or
   in-flight. Not attempted here (would require fabricating a hash, which is prohibited).

## Constraints honoured

Read-only Testnet access only · no Mainnet · no signing · no key access · no sponsor · no
transaction construction/submission/broadcast · no faucet/balance transfer · no contract
deployment/update · no token registration/repin · no real facilitator activation · token 1004
unchanged · replay and crash recovery untouched · unrelated gateway code untouched · HEAD
`4c8994d` · no commit/push/publish/issue.

## Stop condition

TASK 31 complete. Awaiting explicit maintainer approval before any sponsor provisioning or
real settlement work.
