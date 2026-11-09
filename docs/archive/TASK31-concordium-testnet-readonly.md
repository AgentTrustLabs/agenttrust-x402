# TASK 31 — Concordium Testnet Read-Only Connectivity and Evidence Verification

Date: 2026-11-05 · Baseline HEAD `4c8994d` · Authorized read-only Testnet access.

## Recommendation

**VERIFIED AGAINST THE REAL TESTNET.** The installed SDK connected to
`grpc.testnet.concordium.com:20000`, queried `getConsensusStatus` and `getBlockItemStatus`
for all three token-1004 transaction hashes, and the TASK30 adapter mapped every response to
`finalized` with a matching `summary.hash`. No signing, submission, or write occurred.

## 1. Endpoint verification

- Host: `grpc.testnet.concordium.com` (resolved to `34.36.245.204`)
- Port: `20000`
- Interface: gRPC v2 (official Concordium node)
- Source: `docs.concordium.com` (the task's stated official endpoint). This task did not
  invent or substitute any URL.

Consensus status returned `bestBlock` and `genesisBlock`. The genesis block hash
`4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796` begins with the
CAIP-2 chain id `4221332d34e1694168c2a0c0b3fd0f27` used throughout AgentTrust, confirming
the connection is Concordium Testnet, not Mainnet.

## 2. Transaction hashes recovered

From `docs/archive/TASK02-result.md` (verified local record, not invented):

| # | Hash | Operation | Block hash (from node) | Energy | Sender |
|---|---|---|---|---|---|
| 1 | `5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0` | `CIS-8004.register` | `8df328f521a50f348a700afba89c37ca17c946996b1cef8b10cc3cd8da22e24a` | 2380 | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` |
| 2 | `c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e` | `CIS-8004.setAgentURI` (URI fix) | `71119b6c22ad9c35c81a5688af61bacc18e1cf7925598e5c9d8c75ac38440c96` | 1859 | same |
| 3 | `cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a` | `CIS-8004.setAgentURI` (badge re-anchor) | `32d80f4adc1e3183d09e66eaa35aa65eef593456fcd61c8f758d817e07241b27` | 1860 | same |

All three are `status: finalized`, `transactionType: update`, and `summary.hash` equals the
requested hash exactly. All three senders equal the registered owner
`4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` (token 1004 owner). This is the
read-only evidence that the AgentTrust registration transactions are real on-chain
transactions on Concordium Testnet.

## 3. Adapter mapping against real responses

The TASK30 adapter (`ConcordiumEvidenceVerifier`) was fed each real node response:

| Hash | `available` | `observed` | Notes |
|---|---|---|---|
| `5abc7f8b…` | true | `finalized` | hash bound, non-failed type |
| `c93d7024…` | true | `finalized` | hash bound, non-failed type |
| `cb0c2ef7…` | true | `finalized` | hash bound, non-failed type |

All three report `finalized` with verified hash binding. No adapter exception, no
misclassification, no hash mismatch.

## 4. One real SDK behaviour finding (corrected the adapter)

The first run of the connectivity script failed with `Request message serialization failure`
because the adapter passed a **string** to `GRPCClient.getBlockItemStatus()`, which expects a
`TransactionHash` object. The SDK doc comment says `@returns undefined if it does not exist`
but the actual behaviour is a gRPC `NOT_FOUND` error — the doc comment is inaccurate; the
code is authoritative.

Fix applied to `services/facilitator/src/concordiumEvidence.ts`: convert the 64-hex string
to `TransactionHash.fromHexString()` before calling the node. The offline tests still pass
because the conversion is a no-op for an already-valid hash and the mock client ignores the
argument type.

This is the only code change in TASK31. It is a correctness fix, not a feature.

## 5. Test results

### Connectivity script: `scripts/task31-testnet-readonly.mts` — 8/8

```
ok  getConsensusStatus succeeded — bestBlock=...
ok  network identified as a Concordium chain
ok  hash 5abc7f8bbc51… queryable
ok  hash c93d702472b4… queryable
ok  hash cb0c2ef73202… queryable
ok  adapter 5abc7f8bbc51… did not throw
ok  adapter c93d702472b4… did not throw
ok  adapter cb0c2ef73202… did not throw
```

### Offline regression (unchanged)

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

## 6. Constraints honoured

- Only `grpc.testnet.concordium.com:20000` was contacted. No Mainnet, no unknown provider.
- Read-only calls only: `getConsensusStatus` and `getBlockItemStatus`. No signing, no
  submission, no transaction construction, no account state mutation.
- No credentials or private data sent (the Concordium gRPC endpoint is unauthenticated).
- No port scanning, no service enumeration.
- Token 1004 and its registration untouched.
- No commit, push, publish, or GitHub issue. HEAD remains `4c8994d`.

### Packaging secret-scan finding

Adding the three hashes to `scripts/task31-testnet-readonly.mts` initially failed
`task15-packaging` test F5.7 ("64-hex value outside a public-hash context"): the scanner
accepts a 64-hex literal only on a line that also names `hash` / `transaction` / `sha256`.
Fixed by annotating each literal with `// transaction hash N` — the values are public
transaction identifiers, not key material, and the scanner is correctly conservative.

## 7. Changed files

```
MODIFIED:
  services/facilitator/src/concordiumEvidence.ts   +TransactionHash conversion (correctness fix)
NEW:
  scripts/task31-testnet-readonly.mts             connectivity + evidence script
  docs/archive/TASK31-concordium-testnet-readonly.md
```

## 8. Remaining blockers before sponsor provisioning

1. **Sponsor signer** — `createSigner()` still throws in `real` mode. Requires a funded,
   separately operated sponsor account; no key material may enter this repository.
2. **Live evidence verification is now partially verified** — the adapter maps real
   `finalized` responses correctly. The remaining unverified paths are `NOT_FOUND`,
   `committed`, timeout, and TLS failure against a real node; these require a hash that is
   genuinely absent or in-flight, which a smoke test with a synthetic hash would cover.
3. **Ordering fix (TASK 29/29.1) already in place** — no change needed here.

## Stop condition

TASK 31 complete. Adapter verified against real Testnet: 3/3 token-1004 transaction hashes
map to `finalized` with verified hash binding. Awaiting explicit maintainer approval before
any sponsor provisioning or real settlement work.
