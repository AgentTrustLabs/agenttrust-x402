# TASK 39 — Read-only Concordium AccountInfoProvider

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Read-only provider.** No signing, no key material, no submission, no settlement.

---

## Executive Verdict

**PASS.** A read-only `AccountInfoProvider` backed by the official
`ConcordiumGRPCNodeClient.getAccountInfo()` is implemented and connected to the TASK38
SDK verifier. Account keys come only from the node; caller-supplied keys never override the
provider. Network identity is validated against the Testnet genesis hash. Every failure mode
throws `AccountInfoProviderError` and fails closed. Mainnet is deliberately absent from the
configured networks.

---

## SDK/gRPC API evidence

Verified against `@concordium/web-sdk` 12.0.2:

| Location | Declaration |
|---|---|
| `lib/esm/grpc/GRPCClient.d.ts:84` | `getAccountInfo(accountIdentifier: SDK.AccountIdentifierInput, blockHash?: BlockHash.Type): Promise<SDK.AccountInfo>` |
| `lib/esm/nodejs/grpc.d.ts:16` | `class ConcordiumGRPCNodeClient extends ConcordiumGRPCClient` |
| `lib/esm/grpc-api/v2/concordium/service.client.d.ts:105` | gRPC `getAccountInfo(input: AccountInfoRequest): UnaryCall<AccountInfoRequest, AccountInfo>` |
| `lib/esm/types.d.ts:980` | `accountThreshold: number` |
| `lib/esm/types.d.ts:702` | `keys: Record<number, Upward<VerifyKey>>` |
| `lib/esm/types.d.ts:715` | `credentialPublicKeys` |

`getAccountInfo` **throws `RpcError` when the account is absent** — the provider maps that to
`null` (account not found) rather than an exception.

---

## AccountInfoProvider contract

```ts
interface AccountInfoProvider {
  getAccountInfo(address: string, network: string): Promise<AccountInfo | null>;
}
```

`GrpcAccountInfoProvider` implements it:

```ts
new GrpcAccountInfoProvider({
  host, port, useTls,        // node connection
  network: 'ccd:4221…',      // CAIP-2, must be in KNOWN_NETWORKS
  timeoutMs,                 // default 10_000
  client?,                   // test seam (transport only)
});
```

Returned `AccountInfo` is passed **unmodified** to `Transaction.verifySignature` — the SDK
reads `accountThreshold`, `accountCredentials[…].value.contents.credentialPublicKeys`.

---

## Network identity validation

`KNOWN_NETWORKS` contains **Testnet only**:

```
'ccd:4221332d34e1694168c2a0c0b3fd0f27' → genesis 4221332d34e1694168c2a0c0b3fd0f27
```

Mainnet is deliberately absent: an unknown network fails at construction with
`unknown_network`, so a misconfiguration cannot silently point the provider at Mainnet.

`verifyNode()` queries `getConsensusStatus()` and compares `genesisBlock` against the
configured hash; a mismatch throws `network_mismatch`.

---

## Account key mapping

The provider validates, per credential:

| Check | Failure |
|---|---|
| credential index numeric | `malformed_account_info` |
| `credentialPublicKeys` present | `malformed_account_info` |
| `credentialPublicKeys.threshold ≥ 1` | `malformed_account_info` |
| key index numeric | `malformed_account_info` |
| `verifyKey` is 32-byte hex | `malformed_account_info` |

The returned keys are the node's authoritative `verifyKey` values. The verifier consumes
only those; the transaction JSON cannot influence them.

---

## Production verifier wiring

`SdkSenderVerifier` (TASK38) is unchanged — it already accepts an `AccountInfoProvider` and
calls `Transaction.verifySignature`. The production wiring is:

```ts
const provider = new GrpcAccountInfoProvider({
  host: 'grpc.testnet.concordium.com',
  port: 20000,
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
});
const verifier = new SdkSenderVerifier({ network: CAIP2, accountInfoProvider: provider });
```

`FacilitatorCore` still defaults `senderVerifier` to a **pass-through** for mock flows.
Production must inject the SDK verifier — no silent fallback exists: a provider failure
throws, and the verifier maps it to `node_unavailable` / `account_not_found`, both
fail-closed.

---

## Error and fail-closed behaviour

| Condition | Result |
|---|---|
| Unknown network | `AccountInfoProviderError('unknown_network')` at construction |
| Node genesis ≠ configured | `AccountInfoProviderError('network_mismatch')` |
| Requested network ≠ bound | `AccountInfoProviderError('network_mismatch')` |
| Invalid base58check address | `AccountInfoProviderError('invalid_address')` |
| `NOT_FOUND` from node | `null` → verifier returns `account_not_found` |
| RPC failure | `AccountInfoProviderError('rpc_unavailable')` → verifier `node_unavailable` |
| Timeout | `AccountInfoProviderError('timeout')` → verifier `node_unavailable` |
| Missing/empty credentials | `AccountInfoProviderError('malformed_account_info')` |
| Bad threshold / key / index | `AccountInfoProviderError('malformed_account_info')` |
| Returned address ≠ requested | `AccountInfoProviderError('network_mismatch')` |

No path returns a fabricated or defaulted key set.

---

## Test results

`test/task39-grpc-account-info-provider.test.mts` — **13/13** (deterministic fake client, no
network):

| # | Scenario | Result |
|---|---|---|
| 01 | valid account info returned | ok |
| 02 | missing account → `null` | ok |
| 03 | RPC unavailable → `rpc_unavailable` | ok |
| 04 | timeout → `timeout` | ok |
| 05 | wrong network → `network_mismatch` | ok |
| 06 | unknown network → `unknown_network` | ok |
| 07 | malformed info (empty credentials) → `malformed_account_info` | ok |
| 08 | bad `verifyKey` → `malformed_account_info` | ok |
| 09 | account address mismatch → `network_mismatch` | ok |
| 10 | invalid address → `invalid_address` | ok |
| 11 | `verifyNode` rejects wrong genesis | ok |
| 12 | caller-supplied keys never reach the verifier | ok |
| 13 | provider feeds the SDK verifier (valid Ed25519 signature) | ok |

### Regression

- Full suite: **2053/2053 · 55 suites · 0 FAIL**
- Facilitator typecheck: PASS
- Gateway typecheck: PASS

---

## Limitations and untested cases

- **No live Testnet query was performed.** All tests use a deterministic fake client. A live
  `getAccountInfo` against `grpc.testnet.concordium.com:20000` is a follow-up and is reported
  separately if executed.
- **No caching.** Every call hits the node. Deliberate: invalidation semantics are undefined.
- **No real account exercised.** The provider's structural validation is tested against
  fixtures, not against a live account's full credential set.
- **`verifyNode()` is not called automatically on every `getAccountInfo`.** It is a separate
  call so operators can assert chain identity at startup without paying for it per request.
- **Genesis hash comparison is string equality after normalization.** It assumes the node
  returns a hex string; a `Uint8Array` response would need an adapter.
- **`client` test seam is transport-only.** It cannot inject account data through the
  production path — the verifier reads account info exclusively from the provider.

---

## Non-negotiable constraint audit

| Constraint | Status |
|---|---|
| No private-key access/generation/import/export/signing | ✅ |
| No transaction construction/submission/broadcast | ✅ |
| No faucet or Mainnet | ✅ (Mainnet absent from `KNOWN_NETWORKS`) |
| No real sponsor signing | ✅ |
| No real facilitator activation/settlement | ✅ |
| `DENY_ALL_FACILITATOR` intact | ✅ |
| Settlement disabled by default | ✅ |
| Token 1004 / Agent Card untouched | ✅ |
| No schema changes | ✅ |
| No commits or pushes | ✅ HEAD `4c8994d` |

---

## Next Prerequisite

1. **Run a live read-only `getAccountInfo`** against Testnet for a known account and record
   the observed structure (separate from these deterministic tests).
2. **Wire the provider into the production facilitator config** and remove the pass-through
   default for real mode.
3. **Add startup chain-identity assertion** via `verifyNode()`.
4. **Define caching** with explicit invalidation on credential changes.
5. **Fund a Testnet sponsor account** and enable `FACILITATOR_MODE=real` behind an explicit
   maintainer decision.
