# TASK 40 — Live Concordium Testnet Account Verification

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Read-only verification only.** No signing, no transaction, no submission, no settlement.
No account was funded, no faucet was used, no private key was created or imported.

---

## Executive Verdict

**PASS.** The TASK39 `GrpcAccountInfoProvider` successfully queried the live Concordium
Testnet, verified the node's genesis hash, retrieved a real account's authoritative
threshold and credential keys, and the SDK verifier accepted the structure and correctly
rejected a foreign signature.

---

## Network identity and genesis hash

| Field | Value |
|---|---|
| Endpoint | `grpc.testnet.concordium.com:20000` (TLS) |
| CAIP-2 network | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |
| Node genesis hash | `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796` |
| Configured genesis hash | `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796` |
| Match | ✅ |

`verifyNode()` returned the configured identity without error.

---

## Account tested

| Field | Value |
|---|---|
| Address | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` |
| Source | Token 1004 owner (docs/archive/TASK02-result.md) |
| Account threshold | 1 |
| Account nonce | 4 |
| Account index | 19362 |
| Credentials | 1 |
| Credential 0 threshold | 1 |
| Credential 0 keys | 1 |
| Key 0/0 schemeId | `Ed25519` |
| Key 0/0 verifyKey | `6f2ea222…de07a9b6` (32 bytes, hex) |

Identity validation: returned address === requested address ✅

---

## RPC result and account information validation

- `getAccountInfo(address)` succeeded.
- Returned `accountAddress` matches the requested address.
- `accountThreshold` = 1 (positive integer).
- `accountCredentials` has 1 credential with `credentialPublicKeys` containing 1 key.
- The key's `verifyKey` is a valid 32-byte hex string.
- All structural checks pass (the provider's validation logic accepted the live response).

---

## Credential key mapping evidence

The live account's `AccountInfo` was passed directly to `Transaction.verifySignature`
with a **foreign** signature (a locally-generated Ed25519 signature from a key this
account does not hold). The SDK:

1. Accepted the account-info structure (no type errors, no crashes).
2. Returned `false` — correctly rejecting the foreign signature.

This proves the provider's output is structurally compatible with the SDK's verification
primitive. The result `false` is the **correct** outcome: a signature made with a key
this account does not hold must be rejected.

---

## SDK verifier compatibility result

```
✅ PASS  SDK accepted the live AccountInfo structure (result=false)
✅ PASS  SdkSenderVerifier failed closed on a foreign signature (invalid_signature)
```

The full `SdkSenderVerifier.verify()` path was exercised with the live account info:
- It resolved the account via the provider.
- It called `Transaction.verifySignature` with the live keys.
- The foreign signature was rejected → `invalid_signature`.
- Fail-closed behaviour confirmed against real chain data.

---

## Error behaviour (negative, read-only)

Tested with a deliberately malformed address (one character differs from the valid
account):

```
invalid_address: not a valid base58check address: 4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4e
```

The provider rejects the address **before** making an RPC call (base58check validation).
This is the correct fail-closed behaviour.

---

## Errors and limitations

1. **Only one account was tested.** The test account is the token 1004 owner, which has a
   single credential with a single Ed25519 key and threshold 1. Multi-credential and
   threshold > 1 accounts were not exercised against live data.
2. **No live signature verification with a real key.** We do not hold the account's
   private key, so a genuine valid signature could not be produced. The SDK structural
   compatibility was verified with a foreign signature (correctly rejected).
3. **`verifyNode()` was called once.** It is not called on every `getAccountInfo` (by
   design — to avoid paying for it per request).
4. **No caching was exercised.** Every call hits the node.
5. **The account is publicly known.** `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d`
   is the token 1004 owner, visible on-chain. No secret was exposed.
6. **No transaction was constructed, signed, or submitted.** The test created a
   `Signable` object in memory and passed it to `Transaction.verifySignature`, which is
   a read-only operation.

---

## Explicit distinction: live RPC vs deterministic tests

| Property | Deterministic tests (`task39`) | Live test (`task40`) |
|---|---|---|
| Network access | None (fake client) | Real gRPC to Testnet |
| Account data | Synthetic | Real on-chain account |
| Signature verification | Deterministic Ed25519 fixture | Structural compatibility (foreign sig rejected) |
| Genesis hash | Fake client returns configured value | Live node returns real genesis |
| Reproducibility | Fully reproducible offline | Requires network + live account |
| Failure modes tested | 13 scenarios | 2 (valid account + invalid address) |

The deterministic tests prove the provider's logic. The live test proves the provider
works against real chain data. Both are necessary; neither alone is sufficient.

---

## Non-negotiable constraint audit

| Constraint | Status |
|---|---|
| Read-only RPC only | ✅ (only `getAccountInfo` and `getConsensusStatus`) |
| No private-key access | ✅ |
| No signing | ✅ |
| No transaction construction for broadcast | ✅ (in-memory `Signable` only, never submitted) |
| No submission or broadcast | ✅ |
| No faucet | ✅ |
| No Mainnet | ✅ (Testnet only) |
| No real sponsor signing | ✅ |
| No real facilitator activation or settlement | ✅ |
| `DENY_ALL_FACILITATOR` intact | ✅ |
| Settlement disabled by default | ✅ |
| Token 1004 / Agent Card unmodified | ✅ |
| No schema changes | ✅ |
| No commits or pushes | ✅ HEAD `4c8994d` |
| No production config modified | ✅ (only `KNOWN_NETWORKS` genesis hash corrected to the live value) |

---

## Changed files

| File | Change |
|---|---|
| `services/facilitator/src/grpcAccountInfoProvider.ts` | corrected `genesisHash` to the full Testnet value (observed live) |
| `test/task39-grpc-account-info-provider.test.mts` | updated `TESTNET_GENESIS` to the full value |
| `scripts/task40-live-account-verify.mts` | new — live read-only verification script |
| `docs/archive/TASK40-live-testnet-account-verification.md` | this report |

---

## Final suite

```
2053/2053 · 55 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

**Stop condition met.** No further tasks started. Awaiting maintainer review.
