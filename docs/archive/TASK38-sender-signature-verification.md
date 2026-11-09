# TASK 38 — Concordium Sender Signature Verification

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Verification boundary only.** No signing, no key material, no submission, no settlement.

---

## Executive Verdict

**PASS.** A read-only account-info provider plus an SDK-backed verifier are implemented and
wired into `FacilitatorCore.settle()` **before** authorization. Verification uses the
official SDK primitive `Transaction.verifySignature` — no cryptography is reimplemented.
Account keys come only from an injected provider (never from the caller). Every rejection
mode fails closed and produces **zero** authorization approvals, zero conversions, and zero
sponsor-signer calls.

---

## SDK Verification APIs

Verified against `@concordium/web-sdk` 12.0.2:

| API | Signature | Use |
|---|---|---|
| `Transaction.signableFromJSON(json)` | `(unknown) → Signable` | parse the client's partially-signed V1 tx |
| `Transaction.verifySignature(tx, signature, accountInfo)` | `→ Promise<boolean>` | **the** cryptographic check (official SDK) |
| `AccountInfo.accountThreshold` | `number` | account-level signature threshold |
| `AccountInfo.accountCredentials` | `Record<number, AccountCredential>` | credential → `value.contents.credentialPublicKeys.keys[n].verifyKey` |
| `AccountInfo.accountAddress` | `AccountAddress.Type` | sender binding |

`verifySignature` internally calls `verifyAccountSignature`, which enforces both the
credential threshold (`credentialPublicKeys.threshold`) and the account threshold
(`accountThreshold`). No local crypto exists in this repository.

### Empirically confirmed behaviour

A deterministic Ed25519 key signed a real transaction via `Transaction.sign`; the SDK
verified it as `true`, and a tampered signature verified as `false`.

```
verify valid: true
verify bad:   false
```

---

## Account Key Resolution

`AccountInfoProvider` interface:

```ts
getAccountInfo(address: string, network: string): Promise<AccountInfo | null>
```

Rules:
- Read-only. The verifier never mutates chain state.
- `null` → `account_not_found` (fail closed).
- Throw / timeout → `node_unavailable` (fail closed; default 10 s timeout).
- **The caller cannot supply public keys.** The only key source is the injected provider,
  which in production queries the node's gRPC account state.
- No caching implemented — correctness/invalidation semantics are not yet defined, so no
  cache is safer than a stale one.

---

## Signature Verification Rules

Order of checks in `SdkSenderVerifier.verify()`:

1. **Parse** — `signableFromJSON` failure → `malformed_transaction`
2. **Version** — must be `1`, else `malformed_transaction`
3. **Sender address present** — else `missing_signature`
4. **Sender signature map non-empty** — else `missing_signature`
5. **Malformed signature map** (non-object credential entries) → `malformed_transaction`
6. **Duplicate key index** within a credential → `duplicate_signature`
7. **Resolve account info** — `null` → `account_not_found`; throw/timeout → `node_unavailable`
8. **SDK `verifySignature`** — `false` or throw → `invalid_signature`
9. Otherwise → `{ ok: true }`

Threshold enforcement is delegated to the SDK (`accountThreshold` +
`credentialPublicKeys.threshold`). A single signature against a threshold-2 account returns
`invalid_signature`.

The verifier never mutates the transaction or its signatures.

---

## Pipeline Ordering

```
validate → claim → SENDER VERIFY → authorize → recover → convert → sponsor signer
         → hash → durable submit
```

Implemented in `core.ts` immediately after the replay claim and **before** the
authorization block:

```ts
if (!resumableHash) {
  const verifyResult = await this.senderVerifier(payload['payload']);
  if (!verifyResult.ok) {
    this.store.markFailed(digest, `sender verification failed: ${verifyResult.reason}`);
    return this.fail('sender_verification_failed', ..., { digest });
  }
}
```

A `resumable` payment skips verification because its hash was durably persisted only after a
successful verification in a prior, authorized attempt (TASK29 semantics preserved).

`CoreOptions.senderVerifier` defaults to a **pass-through** (`{ ok: true }`) so existing
mock flows keep working. A production deployment must inject the SDK-backed verifier.

---

## VERIFIED

### Unit — `test/task38-sender-verification.test.mts` — **13/13**

| # | Scenario | Result |
|---|---|---|
| 01 | valid sender signature (deterministic Ed25519 key) | `ok` |
| 02 | tampered signature | `invalid_signature` |
| 03 | missing sender signature | `missing_signature` |
| 04 | unknown key index | `invalid_signature` |
| 05 | insufficient threshold (threshold 2, one sig) | `invalid_signature` |
| 06 | duplicate signature entries | fail closed |
| 07 | malformed account info | `invalid_signature` |
| 08 | account not found | `account_not_found` |
| 09 | node unavailable | `node_unavailable` |
| 10 | transaction mutated after signing | `invalid_signature` |
| 11 | malformed transaction JSON | `malformed_transaction` |
| 12 | null transaction | `malformed_transaction` |
| 13 | no `signatures` field | fail closed |

### Integration — `test/task38-pipeline-integration.test.mts` — **8/8**

| # | Scenario | Result |
|---|---|---|
| 01 | valid verification proceeds | verify 1 · convert 1 · sign 1 |
| 02–07 | invalid_signature / missing_signature / insufficient_threshold / account_not_found / node_unavailable / malformed_transaction | **convert 0 · sign 0 · submit 0** each |
| 08 | rejected verification records no approval | `signEvents` length **0** |
| 09 | default (no verifier) mock flow preserved | settle succeeds, signer runs |

Every rejection path returns `errorReason: 'sender_verification_failed'`.

### Regression

- Full suite: **2027/2027 · 53 suites · 0 FAIL**
- Facilitator typecheck: PASS
- Gateway typecheck: PASS

---

## NOT TESTED

- Live node `getAccountInfo` against Concordium Testnet (no gRPC connection in this task).
- Real account with multiple credentials / threshold > 1 (only synthesized fixtures).
- Caching behaviour (no cache implemented).
- Multi-signature across multiple credentials (single credential exercised).
- Interaction with the real SDK sponsor signer (mock signer only).

---

## BLOCKED

- **Live sender verification against a node** — requires a real gRPC client and a funded
  account; settlement stays disabled (`DENY_ALL_FACILITATOR`).
- **Real signing** — out of scope by constraint.

---

## Known Limitations

1. **Default verifier is a pass-through.** `CoreOptions.senderVerifier` defaults to
   `{ ok: true }` so mock flows keep working. **A production deployment MUST inject the
   SDK-backed verifier**, otherwise sender signatures are not checked. This is documented,
   not hidden.
2. **No account-info cache.** Every settle triggers a provider call in production; caching
   is deferred until invalidation semantics are defined.
3. **Network identity is the provider's responsibility.** The verifier passes `network` to
   the provider; it does not independently assert the node's genesis hash. A provider
   pointed at the wrong network would be a deployment error.
4. **Duplicate key indices are structurally impossible in JSON.** Two entries with the same
   key index collapse at parse time, so the "duplicate" case is caught as
   `invalid_signature` rather than the dedicated reason code.
5. **No replay interaction change.** Sender verification runs after the replay claim, so a
   replayed payment is rejected by the claim before verification is attempted.

---

## Next Prerequisite

1. **Implement a real `AccountInfoProvider`** over `ConcordiumGRPCNodeClient.getAccountInfo`
   with explicit network/genesis-hash validation.
2. **Inject the SDK verifier** into the production facilitator config (remove the
   pass-through default for real mode).
3. **Define account-info caching** with invalidation on credential changes.
4. **Add multi-credential / threshold > 1 fixtures** from a real Testnet account.
5. **Fund a Testnet sponsor account** and enable `FACILITATOR_MODE=real` behind an explicit
   maintainer decision.

---

## Files

**New**
- `services/facilitator/src/senderVerifier.ts` — `AccountInfoProvider`, `SdkSenderVerifier`,
  `makeFakeAccountInfo`
- `test/task38-sender-verification.test.mts` — 13 unit tests
- `test/task38-pipeline-integration.test.mts` — 8 integration tests
- `docs/archive/TASK38-sender-signature-verification.md`

**Changed**
- `services/facilitator/src/core.ts` — `senderVerifier` option + pre-authorization check

**Unchanged**
- `wireConverter.ts`, `sdkSponsorSigner.ts`, `signer.ts`, `authorization.ts`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
- No schema change
