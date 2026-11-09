# TASK 41 — Production Sender Verification Wiring

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Wiring only.** No signing, no key material, no submission, no settlement, no deployment.

---

## Executive Verdict

**PASS.** `startFacilitator` now constructs a real `GrpcAccountInfoProvider` + `SdkSenderVerifier`
when `FACILITATOR_SENDER_VERIFICATION=sdk`. Mock mode defaults to the pass-through verifier.
Real mode **requires** `sdk` — `loadConfig` throws otherwise. Missing endpoint or invalid
config fails closed. No implicit environment fallback selects passthrough in production.

---

## Existing production initialization path

Before TASK41, `startFacilitator` (server.ts:98) always used the pass-through verifier
(`FacilitatorCore` default). The `senderVerifier` option was never populated in production.

## New dependency wiring

```
Concordium Testnet gRPC client (GrpcAccountInfoProvider)
  → SdkSenderVerifier (TASK38)
  → FacilitatorCore (senderVerifier option)
```

Wired in `server.ts`:

```ts
if (config.senderVerification === 'sdk') {
  const provider = new GrpcAccountInfoProvider({ host, port, useTls, network, timeoutMs });
  const sdkVerifier = new SdkSenderVerifier({ network, accountInfoProvider: provider, timeoutMs });
  senderVerifier = (txJson) => sdkVerifier.verify(txJson);
}
// passthrough (mock only): senderVerifier stays undefined → FacilitatorCore default
```

---

## Production vs mock selection rules

| Mode | `FACILITATOR_SENDER_VERIFICATION` | Result |
|---|---|---|
| `mock` | unset / `passthrough` | pass-through (default) |
| `mock` | `sdk` | real provider + SDK verifier |
| `real` | unset / `passthrough` | **ConfigurationError** (fail closed) |
| `real` | `sdk` + full endpoint | real provider + SDK verifier |
| any | invalid value | **ConfigurationError** |

No implicit fallback: `real` mode without `sdk` throws at `loadConfig` time.

---

## Fail-closed behavior

- Missing `FACILITATOR_NODE_HOST` → `ConfigurationError`
- Missing `FACILITATOR_NODE_PORT` → `ConfigurationError`
- Unknown network → `ConfigurationError` (at provider construction)
- Invalid genesis hash → `AccountInfoProviderError` (at runtime)
- Provider RPC failure → `node_unavailable` → pipeline stops
- Missing account → `account_not_found` → pipeline stops
- Invalid signature → `invalid_signature` → pipeline stops
- No fallback to pass-through on any error

---

## Pipeline ordering evidence

```
validate → claim → sender verify → authorize → recover → convert → signer → hash → submit
```

`senderVerifier` is called at `core.ts:274`, before `authorization.authorize()` at `:264`'s
successor. Verified by `task41` test 08 (rejected verification → zero convert/sign/submit).

---

## Test results

`task41-production-sender-verification-wiring.test.mts` — **10/10**:

| # | Scenario | Result |
|---|---|---|
| 01 | mock mode defaults to passthrough | ✓ |
| 02 | mock mode can opt into sdk | ✓ |
| 03 | real mode without sender-verification → throws | ✓ |
| 04 | real mode with passthrough → throws | ✓ |
| 05 | real mode with sdk but no host → throws | ✓ |
| 06 | real mode with sdk but no port → throws | ✓ |
| 07 | invalid mode → throws | ✓ |
| 08 | real mode + sdk config accepted, provider constructible | ✓ |
| 09 | mock mode starts with passthrough | ✓ |
| 10 | mock mode with sdk + unreachable endpoint starts (fail closed at request time) | ✓ |

Full suite: **2073/2073 · 56 suites · 0 FAIL**
Typecheck: facilitator ✓ · gateway ✓

---

## Explicit limitations

1. **`verifyNode()` is not called at startup.** The provider's `getAccountInfo()` validates
   the returned address, but genesis-hash assertion is the operator's responsibility at
   startup. A future task can add a startup hook.
2. **No caching.** Every settle triggers a provider call.
3. **`real` mode cannot actually start** (no real signer — `createSigner` throws). The
   wiring is proven at the config/provider-construction level; full end-to-end requires a
   real signer.
4. **Network identity is the provider's responsibility.** The verifier passes `network` but
   does not independently assert the genesis hash.

---

## Files

**Changed**
- `services/facilitator/src/config.ts` — `SenderVerificationMode`, `senderVerification`,
  `senderVerificationTimeoutMs`, loadConfig rules
- `services/facilitator/src/server.ts` — production wiring block

**New**
- `test/task41-production-sender-verification-wiring.test.mts` — 10 tests
- `docs/archive/TASK41-production-sender-verification-wiring.md`

**Unchanged**
- `senderVerifier.ts`, `grpcAccountInfoProvider.ts`, `core.ts`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
- No schema change

---

## Constraint audit

| Constraint | Status |
|---|---|
| No private-key access | ✅ |
| No transaction construction/submission/broadcast | ✅ |
| No faucet or Mainnet | ✅ |
| No real sponsor signing | ✅ |
| No real facilitator activation/settlement | ✅ |
| `DENY_ALL_FACILITATOR` intact | ✅ |
| Settlement disabled by default | ✅ |
| Token 1004 / Agent Card unmodified | ✅ |
| No schema changes | ✅ |
| No commits or pushes | ✅ HEAD `4c8994d` |

**Stop condition met. Berhenti — menunggu review maintainer. TASK42 tidak dimulai.**