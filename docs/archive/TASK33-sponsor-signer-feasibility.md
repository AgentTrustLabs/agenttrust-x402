# TASK 33 — Real Sponsor Signer Feasibility Study

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b` · Feasibility study only.

## 1. Executive verdict

**FEASIBLE WITH CONDITIONS.**

The official SDK exposes every primitive needed to add a sponsor signature to a client-signed
V1 transaction and to submit the result. The existing AgentTrust validation already covers
most of the x402 Concordium verification rules. The remaining gap is **key custody**: the
SDK's only signer factory (`buildBasicAccountSigner(privateKey)`) accepts a raw private key
string, which is exactly what the AgentTrust architecture rules out. A production signer
must be a narrow, context-bound adapter — never the SDK factory exposed directly to HTTP
handlers.

## 2. Exact installed SDK versions

| Package | Version |
|---|---|
| `@concordium/web-sdk` | 12.0.2 |
| `@x402/concordium` | 2.29.0 |
| `@x402/core` | 2.29.0 |
| Node | 26.7.0 |

## 3. Source-level API findings

### 3.1 Sponsor signing

`@x402/concordium` `FacilitatorConcordiumSigner.addSponsorSignature(tx)` (source:
`dist/esm/index.mjs:63-68`):

```js
const signable = Transaction.signableFromJSON(tx);
const sponsored = await Transaction.sponsor(signable, sponsorSigner);
return Transaction.toJSON(sponsored);
```

`Transaction.sponsor(transaction, signer)` (`web-sdk/transactions/Transaction/signable.js:91-105`):

```js
export async function sponsor(transaction, signer) {
    let signature = await AccountTransactionV1.createSignature(preFinalized(transaction), signer);
    return addSponsorSignature(transaction, signature);
}
```

`AccountTransactionV1.createSignature` signs `preFinalized(transaction)` with the sponsor's
key. The sponsor signature is then merged via `addSponsorSignature` / `mergeSignaturesInto`.

**Trust boundary:** the sponsor signer signs a digest derived from the transaction's header,
payload, and sponsor address. It does **not** sign an arbitrary message. However, the signer
interface is `AccountSigner.sign(digest: ArrayBuffer) → AccountTransactionSignature` — a
general-purpose digest signer. The SDK factory does not restrict what digest it signs. **The
restriction must be enforced by the adapter, not by the SDK.**

### 3.2 Signer factories

- `buildBasicAccountSigner(privateKey: HexString)` — accepts a hex private key string.
  (`web-sdk/signHelpers.d.ts:73`)
- `toConcordiumFacilitatorSigner(sponsorAddress, signerOrKey, grpcConfig)` — accepts either
  a private key string or an `AccountSigner` instance (`@x402/concordium/dist/esm/index.mjs:43-46`).

**Finding:** the SDK's convenience factory reads a private key from a string. Any
integration that calls it inside the facilitator process would place the key in that process's
memory, violating the AgentTrust keyless architecture. The `AccountSigner` interface is the
only safe entry point — and it can be implemented by an external, context-bound signer.

### 3.3 Submission

`submitTransaction(signedTxJSON)` (`@x402/concordium/dist/esm/index.mjs:70-74`):

```js
const signable = Transaction.signableFromJSON(signedTxJSON);
const finalized = Transaction.finalize(signable);
const txHash = await grpcClient.sendTransaction(finalized);
return txHash.toString();
```

The hash returned is `getAccountTransactionHash(finalized)` — the same value AgentTrust
already computes pre-broadcast (TASK28/29). The node does not invent a hash.

### 3.4 Validation

`@x402/concordium`'s `verify()` (inspected in `dist/cjs/exact/facilitator/index.js`) performs:

- scheme / network / asset / amount / payTo agreement
- sender signature cryptographic verification (Rule 8, via `getAccountInfo`)
- sponsor address present in header and matching fee payer
- expiry (spec rule 7)
- replay protection (the SDK does not implement this — AgentTrust does)

## 4. Signing lifecycle (exact)

```
1. Client builds V1 sponsored transaction (sender + sponsor header, payload)
2. Client signs sender portion  →  signatures.sender populated, signatures.sponsor = {}
3. Facilitator receives {x402Version, paymentPayload, paymentRequirements}
4. Facilitator validates:
     a. structural envelope (X402_VERSION, payload, requirements)
     b. agreement (scheme, network, asset, amount, payTo)
     c. expiry (not past, ≤ 600s ahead)
     d. replay (paymentDigest uniqueness)
     e. sender signature (SDK getAccountInfo + verify)
5. Facilitator adds sponsor signature:
     Transaction.signableFromJSON(tx) → signable
     Transaction.sponsor(signable, sponsorSigner) → sponsored (signs preFinalized digest)
     Transaction.toJSON(sponsored) → signedTxJSON
6. AgentTrust computes txHash = getAccountTransactionHash(finalized)  [local, no network]
7. AgentTrust durably persists txHash (prepare())  [SQLite, synchronous=FULL]
8. AgentTrust claims submission (claimSubmit())  [atomic]
9. AgentTrust submits (submitTransaction)  [grpc sendTransaction]
10. AgentTrust records broadcast (markBroadcast)  [submitting → outcome_unknown]
11. AgentTrust verifies returned hash == persisted hash  [mismatch → pending, never success]
12. AgentTrust waits for finalization (bounded timeout)
13. AgentTrust applies evidence via ReconciliationService  [only verified finality advances]
```

**Trust boundaries:**

- Steps 1–2: client (untrusted). The client chooses the recipient, amount, and payload.
- Step 4: facilitator (trusted). All validation happens here; the client cannot bypass it.
- Step 5: sponsor signer (trusted, isolated). Signs only after validation.
- Step 9: node (untrusted). The node's response is verified by hash in step 11.
- Step 13: evidence verifier (trusted, read-only). Finality is never caller-supplied.

## 5. Validation coverage matrix

| x402 Concordium rule | AgentTrust coverage | Location |
|---|---|---|
| Transaction version = 1 | ✅ (implicit in `signableFromJSON` parse; `payload.payload` must be object) | `core.ts::parseEnvelope` |
| Sender identity | ✅ `payerOf(payload)` extracted; SDK verifies signature against on-chain account | `core.ts::payerOf`, SDK verify |
| Sponsor identity | ✅ `sponsor.address` must match fee payer (`sponsor_mismatch` check in SDK) | SDK `verify()` |
| Recipient | ✅ `checkAgreement` compares `accepted.payTo === requirements.payTo` | `core.ts::checkAgreement` |
| Exact amount | ✅ `checkAgreement` compares `accepted.amount === requirements.amount` | `core.ts::checkAgreement` |
| Asset type | ✅ `checkAgreement` compares `accepted.asset === requirements.asset` | `core.ts::checkAgreement` |
| Expiry | ✅ `checkExpiry` — not past, ≤ 600s ahead | `core.ts::checkExpiry` |
| Sender signature | ✅ SDK `getAccountInfo` + cryptographic verify (Rule 8) | SDK `verify()` |
| Payload operation count | ✅ SDK enforces exactly one operation (rule 9) | SDK `verify()` |
| Payload operation type | ✅ `requirements.scheme === 'exact'` | `core.ts::checkAgreement` |
| Sponsor ≠ sender | ✅ SDK `preflightLikelyToSucceed` checks `sponsor_as_sender` | SDK `verify()` |
| Sponsor ≠ recipient | ⚠️ **Not explicitly checked by AgentTrust.** Delegated to SDK (the sponsor signs, not the recipient). |
| Energy / fee exposure | ⚠️ **Not explicitly bounded by AgentTrust.** The SDK calculates energy from payload size + signature count. A malicious client could inflate `numSignatures` to raise energy. **Missing check.** |
| Network identity | ✅ `checkAgreement` compares `accepted.network === requirements.network === this.network` | `core.ts::checkAgreement` |
| Replay protection | ✅ `paymentDigest` + `requirementsKey` uniqueness | `store.ts`, `repository.ts` |
| Transaction hash binding | ✅ pre-broadcast persistence + returned-hash comparison | `core.ts::settle()` (TASK29) |

**Missing checks (to be added in a future implementation task):**

1. **Energy/fee cap** — bound `numSignatures` and payload size to a maximum energy cost.
   Without this, a client can force the sponsor to pay excessive fees.
2. **Sponsor ≠ recipient** — explicitly verify `sponsor.address !== payTo`.
3. **Transaction expiry upper bound** — already bounded by `MAX_EXPIRY_OFFSET_SECONDS = 600`,
   but the sponsor's own maximum tolerance should be configurable independently.

## 6. Key custody and isolation design

| Approach | Key exposure | Process compromise | Access control | Auditability | Complexity | Rotation |
|---|---|---|---|---|---|---|
| **A. In-process signer** | High — key in facilitator process memory | Full key loss on compromise | Process-level only | Application logs | Low | Restart required |
| **B. Dedicated signing service over authenticated local IPC** | Medium — key in separate process | Compromise of signer process loses key; facilitator compromise does not | Unix socket + mTLS or peer-cred auth | Structured audit log in signer process | Medium | Hot rotation possible |
| **C. External KMS/HSM** | Low — key never in application memory | KMS policy controls access | KMS IAM + attestation | KMS audit trail | High | KMS-managed |
| **D. Restricted signer adapter (recommended)** | Low-Medium — key in adapter process only | Adapter compromise loses key; facilitator compromise does not | Adapter validates signing context before signing | Audit log in adapter | Medium | Hot rotation possible |

**KMS/HSM compatibility:** the SDK's `AccountSigner.sign(digest)` accepts an `ArrayBuffer` and
returns a signature. A KMS that exposes raw Ed25519 signing (not ECDSA) could implement this
interface. Concordium uses Ed25519. **Conditionally compatible** — depends on the KMS
supporting Ed25519 raw signing, which AWS KMS and GCP KMS do not (they support ECDSA/RSA).
Azure Key Vault and dedicated HSMs (YubiHSM, Thales) do. This is not a code task; it is a
procurement/infrastructure decision.

## 7. Narrow signer authorization contract (proposed)

The sponsor signer must NOT be a general-purpose `AccountSigner`. It must be a context-bound
adapter that signs **only** after validating:

```typescript
interface SponsorSigningRequest {
  /** The fully validated V1 sponsored transaction (client-signed). */
  transaction: SignableV1Transaction;
  /** The payment digest from AgentTrust's replay store. */
  paymentDigest: string;
  /** The requirements key (recipient/amount/asset/network). */
  requirementsKey: string;
  /** The persisted transaction hash (computed pre-broadcast). */
  transactionHash: string;
  /** Network — must match the facilitator's configured network. */
  network: string;
  /** Maximum allowed energy cost. */
  maxEnergy: bigint;
  /** Maximum allowed expiry (epoch seconds). */
  maxExpiry: number;
}

interface NarrowSponsorSigner {
  /**
   * Sign ONLY if all of the following hold:
   *  - network === configured network (testnet only)
   *  - expiry <= maxExpiry (≤ now + 600s)
   *  - energyCost <= maxEnergy
   *  - sponsor.address !== sender (sponsor is not the sender)
   *  - sponsor.address !== recipient (sponsor is not the recipient)
   *  - transactionHash === getAccountTransactionHash(transaction with sponsor sig)
   *  - paymentDigest is recorded in the durable store (replay protection)
   *  - the transaction has not already been submitted (at-most-once)
   *
   * Otherwise throw. Never sign.
   */
  sign(request: SponsorSigningRequest): Promise<AccountTransactionSignature>;
}
```

**Consistency with TASK26–29.1:**

- The adapter's `sign()` is called **after** `checkAgreement`, `checkExpiry`, and replay
  verification, but **before** `prepare()` and `submitTransaction()`. This means the hash
  cannot be computed until signing completes — exactly the ordering TASK28 established.
- The adapter must record an audit event for every sign attempt (success and failure), with
  the payment digest, transaction hash, and sponsor address. This extends the existing
  `transitions` audit log.
- If signing fails, the payment stays in `created` (never `prepared`), and no submission
  can occur. The at-most-once guarantee is preserved.
- If the process crashes after signing but before `prepare()`, the payment is still
  `created` — no hash, no submission. A new process can retry from scratch (no hash means
  no duplicate risk).
- If the process crashes after `prepare()` but before submission, the hash is durable and
  the payment is `prepared` → `resumable` (TASK 29.1).

## 8. Failure and recovery matrix

| Failure | State transition | Retry safe? | New signature? | Submit? | Audit event |
|---|---|---|---|---|---|
| Invalid sender signature | `created → rejected` (terminal) | No — new payload required | No | No | `sign_refused: bad_sender_sig` |
| Wrong sponsor address | `created → rejected` (terminal) | No | No | No | `sign_refused: sponsor_mismatch` |
| Expired transaction | `created → rejected` (terminal) | No | No | No | `sign_refused: expired` |
| Malformed transaction | `created → rejected` (terminal) | No | No | No | `sign_refused: malformed` |
| Unsupported asset | `created → rejected` (terminal) | No | No | No | `sign_refused: unsupported_asset` |
| Unauthorized recipient | `created → rejected` (terminal) | No | No | No | `sign_refused: unauthorized_recipient` |
| Excessive energy/fee | `created → rejected` (terminal) | No | No | No | `sign_refused: excessive_energy` |
| Signer unavailable | `created` (unchanged) | Yes — retry the same payload | Yes (idempotent) | No | `sign_failed: signer_unavailable` |
| Signer timeout | `created` (unchanged) | Yes | Yes | No | `sign_failed: timeout` |
| Partial signing failure | `created` (unchanged) | Yes | Yes (re-sign) | No | `sign_failed: partial` |
| Crash before sponsor signature | `created` (unchanged) | Yes | Yes | No | (none — no state change) |
| Crash after signature, before `prepare()` | `created` (unchanged) | Yes | Yes | No | (none — no state change) |
| Crash after `prepare()`, before submission | `prepared` | Yes (resumable) | No — hash is durable | Only if claim taken | (none — hash already recorded) |
| Crash after submission | `outcome_unknown` | Reconcile only | No | No | (none — hash already recorded) |
| Duplicate signing request | Refused (idempotent if settled) | N/A | No | No | `sign_refused: duplicate` |
| Signature generated but durable state not updated | `created` (unchanged) | Yes | Yes (re-sign) | No | `sign_failed: durable_write_failed` |
| Node submission failure after signing | `created → outcome_unknown` (hash durable) | Reconcile only | No | No | `submit_failed: <reason>` |

**Key principle:** a new signature may only be generated when the payment is still in `created`
state with no durable hash. Once `prepare()` has run, the hash is durable and the payment
must be reconciled, not re-signed.

## 9. Compatibility with existing AgentTrust code

- The `SponsorSigner` interface (`signer.ts`) already separates `addSponsorSignature` and
  `submitTransaction`. A real implementation would implement `addSponsorSignature` via
  `Transaction.sponsor(signable, narrowSigner)` and `submitTransaction` via
  `grpcClient.sendTransaction(finalized)`.
- The `FacilitatorCore::settle()` flow already calls `addSponsorSignature` → `computeTransactionHash`
  → `prepare` → `claimSubmit` → `submitTransaction` → `markBroadcast` → hash comparison.
  A real signer slots in without changing this order.
- The `ReconciliationService` and `EvidenceVerifier` interface are unchanged.
- The `SqliteSettlementRepository` schema already supports all required states.
- The mock signer's `canSign: false` would become `canSign: true` for a real signer, but
  the `/healthz` endpoint would report this. The gateway's `classifyCompatibility` checks
  `canSign` but does not gate on it (it reports it as information).

## 10. Missing prerequisites

1. **A funded Concordium Testnet sponsor account.** Out of scope; requires external
   provisioning.
2. **A narrow signer adapter** implementing `NarrowSponsorSigner` (§7). This is the core
   deliverable of a future implementation task.
3. **Energy/fee cap** — missing validation (§5, item 1). Must be added before any real
   signing.
4. **Sponsor ≠ recipient check** — missing validation (§5, item 2).
5. **KMS/HSM decision** — if the operator wants keys outside process memory, the KMS must
   support Ed25519 raw signing. AWS KMS and GCP KMS do not. Azure Key Vault and dedicated
   HSMs do.
6. **Audit event schema** — the `transitions` table already records `from_state`,
   `to_state`, `reason`, `tx_hash`, `evidence`, `at`. Sign events need a new `kind` column
   or a separate `sign_events` table.
7. **Real evidence verifier** — `ConcordiumEvidenceVerifier` exists but has only been tested
   against fixtures and the three token-1004 hashes. A real `NOT_FOUND` and timeout test
   requires a hash that does not exist on-chain.

## 11. Recommended next bounded task

**TASK 34 — Narrow Sponsor Signer Adapter (Mock-Only, No Key Material).**

Scope:
- Implement `NarrowSponsorSigner` as a mock that validates the signing context and records
  an audit event, but still does not sign (returns a fixture signature).
- Add energy/fee cap and sponsor≠recipient validation to `FacilitatorCore::settle()`.
- Add a `sign_events` audit table to `SqliteSettlementRepository`.
- Test all failure/recovery cases from §8 with deterministic fixtures.
- Do not provision a real sponsor account. Do not enable real settlement.

This is the last task that can be done without external provisioning. After TASK34, the
remaining blocker is purely operational: a funded sponsor account.

## Constraints honoured

- No private-key access, generation, or wallet access.
- No sponsor account provisioning.
- No faucet request.
- No signing with real accounts.
- No real sponsor signer implementation.
- No transaction construction for submission.
- No transaction submission or broadcast.
- No Mainnet interaction.
- No real settlement.
- Token 1004 untouched.
- Settlement not enabled.
- `DENY_ALL_FACILITATOR` not disabled.
- Replay protection and crash recovery not weakened.
- No commit, push, publish, or GitHub issue.

## Stop condition

TASK 33 complete. Feasibility study only. No implementation. Awaiting explicit maintainer
approval before TASK 34 or any sponsor provisioning.
