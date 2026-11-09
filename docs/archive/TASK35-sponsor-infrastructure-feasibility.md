# TASK 35 — Sponsor Infrastructure Feasibility Assessment

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Read-only feasibility study.** No infrastructure deployed, no key accessed, no account
created or funded, no source or test modified.

**Evidence labels used throughout:**

- **[SRC]** — verified by reading installed package source or current repository source.
- **[EXEC]** — verified by executing a read-only command/probe in this session.
- **[DOC]** — from official Concordium/x402 documentation, not independently re-derived.
- **[EST]** — estimate, with assumptions stated.
- **[ASSUME]** — assumption, explicitly not verified.

---

## 1. Executive verdict

**FEASIBLE WITH CONDITIONS.**

A real Concordium sponsor signer can be integrated without changing the durable settlement,
replay, or crash-recovery architecture. The SDK exposes every primitive required. The
conditions are ordered and non-negotiable:

1. **TASK34.4 (M1/M2 remediation) must precede real signer development.** `recordSignEvent()`
   is a live bypass of the durable-state gate, and state-based rejections leave no forensic
   trace. With a mock signer these are an audit defect; with a real signer M1 becomes a
   signature.
2. **The settle path must actually use the authorization boundary.** The energy cap and
   sponsor≠recipient check exist **only** inside `narrowSponsor.ts`, which
   `FacilitatorCore.settle()` never calls. A signer wired into `settle()` today inherits an
   unbounded fee exposure.
3. **A funded sponsor account must exist**, separate from the registry account.

Recommended architecture: **dedicated signing service over authenticated local IPC** — not
in-process, not HSM-first. Rationale in §8.

The gateway remains keyless under every option considered. `DENY_ALL_FACILITATOR`, settlement
disablement, and testnet-only enforcement are untouched.

---

## 2. Baseline and repository state

```
git rev-parse HEAD
  4c8994db391d77796e06e49c843c42be1eae615b                        [EXEC]

@concordium/web-sdk   12.0.2   (node_modules/@concordium/web-sdk/package.json)   [EXEC]
@x402/concordium      2.29.0   (node_modules/@x402/concordium/package.json)      [EXEC]
@x402/core            2.29.0   (node_modules/@x402/core/package.json)            [EXEC]
node                  26.7.0   (node -v)                                        [EXEC]
```

`services/facilitator/` is entirely **untracked** — created after the single initial commit.
The assessment reads the working tree directly; `git diff` would show nothing for it. [EXEC]

---

## 3. Existing architecture assessment

### 3.1 Signer boundary — `services/facilitator/src/signer.ts`

```typescript
export interface SponsorSigner {
  info(): SignerInfo;
  addSponsorSignature(txJson: unknown): Promise<unknown>;
  submitTransaction(txJson: unknown): Promise<string>;
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<FinalizationOutcome>;
  getAccountInfo(address: string): Promise<AccountInfoView>;
  getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined>;
  getTokenDecimals(tokenId: string): Promise<number>;
}
```
[SRC — `signer.ts:63-76`]

Only implementations: `createMockSigner` (`canSign: false`) and the instrumented ledger mock.
`createSigner()` throws for real mode:

> `real mode requires a separately provisioned sponsor signer; this prototype implements mock only.`

[SRC — `signer.ts:352`]

### 3.2 Authorization boundary — `services/facilitator/src/narrowSponsor.ts`

`NarrowSponsorSigner` exposes exactly one operation, `authorize()`. `decideAuthorization()` is a
pure function with 11 sequential guards:

1. policy present and structurally valid
2. network matches
3. transaction version
4. asset supported
5. sender/recipient/sponsor present
6. address validity (`ACCOUNT_RE`)
7. sponsor matches configured sponsor
8. sponsor ≠ sender
9. sponsor ≠ recipient
10. expiry within window
11. energy within cap

[SRC — `narrowSponsor.ts`]

TASK34.2 made the durable-state gate atomic inside
`repository.authorizeSignEvent()`: `BEGIN IMMEDIATE` → read row → state must be `created` →
`tx_hash IS NULL` → no prior `approved` → INSERT → COMMIT.
[SRC — `repository.ts:656-704`]

### 3.3 Durable lifecycle — `state.ts`

```
created → prepared → submitting → outcome_unknown → observed → finalized
                                                  ↘ rejected
                                                  ↘ recovery_unavailable
```
[SRC — `state.ts:28-61`]

Terminal: `finalized`, `rejected`. No edge into `finalized` from any non-`observed` state.

### 3.4 Evidence verification — `concordiumEvidence.ts`

`ConcordiumEvidenceVerifier` calls `getBlockItemStatus(TransactionHash)`, binds
`outcome.summary.hash` to the requested hash, and maps: finalized+match+not-failed →
`finalized`; finalized+match+failed → `failed`; hash mismatch → inconclusive;
`committed`/`received` → not final; `NOT_FOUND`/timeout/malformed → inconclusive.
[SRC — `concordiumEvidence.ts`; live-confirmed against three token-1004 transactions in TASK31]

### 3.5 Current restrictions — all present [SRC]

| Restriction | Location |
|---|---|
| Mainnet refused | `config.ts:96` throws |
| Mock must bind loopback | `config.ts` |
| Real mode requires durable (non-`:memory:`) DB | `config.ts` |
| `DENY_ALL_FACILITATOR` default | `src/payments/x402.ts:411-423` — both methods throw |
| Reconcile route 404 unless enabled | `server.ts` |
| Operator token stored as SHA-256 digest, never logged | `auth.ts` |
| `canSign: false` on mock, surfaced at `/healthz` | `signer.ts:97`, `server.ts` |
| Testnet-only CAIP-2 | `config.ts` |

### 3.6 The settle-path gap — **the central finding**

`FacilitatorCore.settle()` runs: `parseEnvelope` → `checkAgreement` → `checkExpiry` →
`store.claim` → `addSponsorSignature` → `computeTransactionHash` → `prepare` → `claimSubmit` →
`submitTransaction` → `markBroadcast` → hash compare → finalize.

It references **neither** `decideAuthorization`, **nor** `maxEnergy`, **nor** any
sponsor≠recipient check:

```
grep -E 'maxEnergy|sponsor.*recipient|decideAuthorization' \
     services/facilitator/src/core.ts
  → no matches                                                    [EXEC]

grep -c 'maxEnergy\|sponsor_is_recipient' \
     services/facilitator/src/narrowSponsor.ts
  → 9                                                             [EXEC]
```

**Consequence:** TASK34's controls sit in a boundary that is off the production settle path.
Attaching a real signer to `addSponsorSignature()` today would expose the sponsor to unbounded
fees and to paying itself. This is prerequisite #2, and it is a correctness issue, not a
hardening nicety.

---

## 4. Narrow signer contract (future)

The contract must bind, before any signature is produced: configured network · exact sponsor
account · sender · recipient · asset and amount · expiry · energy exposure · payment digest ·
durable payment state · single-use authorization · the fully signed transaction hash (which by
construction exists only **after** sponsor signing).

```typescript
interface SponsorSigningRequest {
  network: string;          // must equal the configured testnet CAIP-2
  sponsor: string;          // must equal the configured sponsor account
  sender: string;
  recipient: string;
  asset: string;            // token/CCD identifier
  amount: string;           // atomic units, exact
  expiry: number;           // epoch seconds
  energy: bigint;           // energy exposure of this transaction
  paymentDigest: string;    // AgentTrust replay key
  // deliberately absent: persistedHash and any raw digest
}

interface NarrowSponsorSigner {
  authorize(req: AuthorizationRequest): Promise<AuthorizationResult>;  // exists (TASK34/34.2)
  sign(req: SponsorSigningRequest): Promise<SponsoredSignature>;       // future
}
```

`sign()` must refuse unless **all** hold:

| Binding | Rule |
|---|---|
| Network | equals configured network; testnet only; mainnet refused |
| Sponsor | equals the configured sponsor account |
| Sender | valid address, ≠ sponsor |
| Recipient | valid address, ≠ sponsor |
| Asset + amount | exactly the values this approval was issued for |
| Expiry | `now < expiry ≤ now + maxExpiryOffset` |
| Energy | `energy ≤ maxEnergy` |
| Payment digest | matches the durable payment row |
| Durable state | `created` **and** `tx_hash IS NULL` |
| Single use | exactly one `approved` sign event for this digest (TASK34.2 gate) |
| Signed hash | computed **after** signing; never supplied as input |

**Explicit non-goal:** the signer must never accept a raw digest or an arbitrary client
request. `AccountSigner.sign(digest: ArrayBuffer)` is general-purpose and the SDK does not
constrain the digest [SRC — `signHelpers.d.ts:43-51`]; the adapter is the only barrier.

### Preserved lifecycle (unchanged, in order)

```
1  validate transaction + sender authorization
2  verify durable authorization            (created, tx_hash IS NULL, single-use)
3  sponsor signing
4  construct fully signed transaction
5  calculate final transaction hash
6  persist hash durably                    (BEGIN IMMEDIATE)
7  claim submission
8  broadcast
9  verify transaction evidence             (hash-bound)
10 finalize only from independently verified evidence
```

**Hash verification must not move ahead of step 3.** The final hash covers the sponsor
signature, which does not exist before step 3; computing it earlier produces a different value
and would defeat TASK29 pre-broadcast persistence. [SRC — TASK28 finding, and `preFinalized()`
recomputes the header including `sponsor`]

---

## 5. Operational security control matrix

| # | Control | Exists? | Status / evidence |
|---|---|---|---|
| 1 | Key custody | ❌ **Missing** | No key handling exists; mock only [SRC] |
| 2 | Signer process isolation | ❌ **Missing** | Would be architecture B |
| 3 | Authenticated IPC | ❌ **Missing** | No IPC today |
| 4 | Request validation before signing | ⚠️ **Partial** | Complete in `narrowSponsor.ts`; **not wired to `settle()`** [EXEC] |
| 5 | Energy cap | ⚠️ **Partial** | Present in `narrowSponsor.ts` only; absent from settle path [EXEC] |
| 6 | Fee cap in CCD | ❌ **Missing** | Requires chain parameters at decision time |
| 7 | Sponsor balance monitoring | ❌ **Missing** | No polling or alerting |
| 8 | Rate limiting | ❌ **Missing** | `/settle` unbounded per caller |
| 9 | Replay protection | ✅ **Exists** | `paymentDigest` + `payment_claims` PK [SRC] |
| 10 | Single-use authorization | ✅ **Exists** | partial unique index `ux_sign_events_approved` [SRC] |
| 11 | Audit logging | ⚠️ **Partial** | `transitions` + `sign_events`; state rejections unaudited (M2) [EXEC] |
| 12 | Secret rotation | ❌ **Missing** | No secret exists; no rotation design |
| 13 | Backup and recovery | ⚠️ **Partial** | SQLite file only; no documented backup procedure |
| 14 | Incident response | ❌ **Missing** | No runbook |
| 15 | Emergency disablement | ✅ **Exists** | real mode throws; `DENY_ALL_FACILITATOR`; reconcile 404 by default [SRC] |
| 16 | Testnet-only enforcement | ✅ **Exists** | `config.ts:96` refuses mainnet and unknown networks [SRC] |
| 17 | Durable hash before broadcast | ✅ **Exists** | TASK29 ordering in `core.settle()` [SRC] |
| 18 | At-most-once submission | ✅ **Exists** | `claimSubmit` + `payment_claims` PK [SRC] |
| 19 | Evidence hash binding | ✅ **Exists** | `concordiumEvidence.ts` [SRC] |
| 20 | Append-only audit | ✅ **Exists** | INSERT-only on `sign_events` [SRC] |

Nothing in this table was implemented in this task.

---

## 6. TASK34.3 findings and remediation dependency

### 6.1 M1 — `recordSignEvent()` bypass (Medium, latent today)

`recordSignEvent()` is public on `SettlementRepository` (`repository.ts:162` interface,
`605-630` implementation) and inserts into `sign_events` with **no** state or hash check.
Executed proof: an `approved` event was accepted for a payment in `prepared`.
[EXEC — `scripts/task343-adversarial-probe.mts` probe 1]

**Effect on a future signer.** Today there is no production caller, so the defect is latent.
A real signer changes that: it introduces a new consumer of the authorization store. Any future
code path that calls `recordSignEvent()` would mint an approval that never passed the
durable-state gate. Mock signer → false audit record. **Real signer → a signature.**

**Verdict: must be fixed before real signer implementation.** Not deferrable.

### 6.2 M2 — state rejections not audited (Medium, forensic)

`authorizeSignEvent()` returns early on durable-state violations without inserting an event
(`repository.ts:665-683`). Executed proof: zero rows after a gate rejection on a `prepared`
payment. [EXEC — probe 4]

The comment at `repository.ts:653` states rejections *are* audited — true for policy
rejections, false for state rejections.

**Operational impact.** An operator asking "why did this payment never settle?" cannot
distinguish "refused: already prepared" from "never attempted".

**Forensic impact.** An attacker probing the gate — repeatedly re-submitting payments that are
already `prepared` — leaves **no trace**. The cheapest attack-detection signal is lost. For a
fee-paying sponsor, refusal-vs-absence is the difference between an attack signature and a
client bug.

**Verdict: fix alongside M1.** Both are bounded edits to a single method.

### 6.3 Prerequisite recommendation

**Yes — TASK34.4 should be a prerequisite to real signer development.** Both findings sit on
the exact path a real signer depends on. Remediating after a key is live means auditing a
system that has already signed. Neither finding was silently fixed here.

---

## 7. Fee and risk model

### 7.1 Concept separation — do not conflate

| Concept | Meaning | Where it comes from |
|---|---|---|
| **Energy unit (NRG)** | Protocol unit of computation | Concordium protocol [DOC] |
| **Transaction energy limit** | `header.energyAmount`: the cap the sender commits to | SDK `Energy` type [SRC] |
| **Actual consumed energy** | Energy the node reports after execution, ≤ limit | `summary.energyCost` [SRC] |
| **CCD transaction cost** | `consumedEnergy × rate`, rate from chain parameters | `convertEnergyToMicroCcd` [SRC] |
| **Sponsor balance requirement** | CCD held ≥ cost + reserve | operational [EST] |

Energy is **not** CCD. The energy limit is **not** the fee. A transaction may consume less than
its limit; the sponsor pays what is consumed, not what is reserved.

### 7.2 Deterministic energy — exactly computable offline [SRC]

```
energy = constantA · signatureCount
       + constantB · (headerSize + payloadSize)
       + transactionSpecificCost
```

Verified constants:

| Constant | Value | Source |
|---|---|---|
| `constantA` | `100n` | `energyCost.js` |
| `constantB` | `1n` | `energyCost.js` |
| v0 header base | `60` bytes (`32+8+8+4+8`) | `AccountTransactionV0.js:92` |
| V1 header with sponsor | `2 + 60 + 32` = **94** bytes | `AccountTransactionV1.js:132-137` |
| simple-transfer base | `300n` | `accountTransactions.js:20-22` |

A sponsored V1 transfer, 2 signatures, 41-byte payload:
`100·2 + (94 + 41) + 300 =` **635 NRG**.

**Client-controlled exposure:** `signatureCount` comes from the client's header. Each extra
signature adds 100 NRG. Nothing in AgentTrust currently bounds it — the energy cap exists only
in `narrowSponsor.ts` (§3.6).

### 7.3 CCD conversion — dependency documented, query not performed

`convertEnergyToMicroCcd(cost, chainParameters)` exists [SRC — `energyCost.js`] and consumes
`euroPerEnergy` and `microGTUPerEuro`, which are chain parameters
[SRC — `translation.js:234-235` maps them: `euroPerEnergy`, and `microCcdPerEuro` →
`microGTUPerEuro`].

**No conversion factor is invented here.** The rate is block-dependent. Obtaining it requires a
chain-parameters query against a node — **not performed in this task**, by constraint.

### 7.4 Empirical anchor — measured, not assumed

Three finalized token-1004 transactions observed on Testnet during TASK31:

| Operation | Consumed energy | Actual fee (CCD) | implied microCCD/NRG |
|---|---|---|---|
| `CIS-8004.register` | 2380 | 22.010289 | ≈ 9248.0 |
| `CIS-8004.setAgentURI` | 1859 | 17.180273 | ≈ 9241.7 |
| `CIS-8004.setAgentURI` (re-anchor) | 1860 | 17.189515 | ≈ 9241.7 |

[EXEC — live node responses recorded in TASK31; rate derived by division]

These are **three samples from one block range**. They bound the rate to ≈ 9242–9248
microCCD/NRG *at that moment*. They do not establish a stable rate, and they are not a
substitute for reading chain parameters.

### 7.5 Conservative operational model

[EST — assumptions stated explicitly]

Assumptions: rate ≈ 9245 microCCD/NRG (§7.4); payload ≈ 41 bytes; 2 signatures;
`signatureCount` bounded by the energy cap.

| Scenario | Energy/tx | CCD/tx | Reserve for N txs | Suggested floor |
|---|---|---|---|---|
| Smoke test (5) | 635 | ≈ 5.87 | ≈ 30 CCD | 50 CCD |
| Pilot (50) | 635 | ≈ 5.87 | ≈ 295 CCD | 350 CCD |
| Sustained (1000) | 635 | ≈ 5.87 | ≈ 5 870 CCD | 6 500 CCD |

**All rows are estimates.** They assume a stable rate and a bounded signature count. If the
energy cap is not enforced on the settle path, the second assumption fails and sponsor exposure
is unbounded — the operational expression of finding §3.6.

**Recommended floor: 50 CCD, alert below 10 CCD.** Covers a smoke test plus retries without
replenishment mid-incident.

### 7.6 Risk register (fee-related)

| Risk | Likelihood | Impact | Control |
|---|---|---|---|
| Client inflates `signatureCount` | High if cap missing | Unbounded fee drain | Energy cap on settle path |
| Rate drift | Medium | Budget overrun | Read chain parameters; monitor spend |
| Sponsor pays itself | Medium if check missing | Fee→recipient loop, no value transfer | sponsor≠recipient on settle path |
| Balance exhaustion mid-batch | Medium | Failed settlements | Low-balance alert at 10 CCD |
| Retry storm | Medium | Fee burn | Rate limiting (missing) |
| Replay of a signed payload | Low | Double spend | `paymentDigest` + claims (exists) |

---

## 8. Architecture comparison and recommendation

| Architecture | Key exposure | Security properties | Operational complexity | Compatibility confidence | Major failure modes | Est. effort |
|---|---|---|---|---|---|---|
| **A. In-process signer** | **High** — key in the process that parses untrusted HTTP | Process boundary only; no isolation from parser | **Low** — one process | **High** — `AccountSigner` is a documented interface [SRC] | Memory/core dump leaks key; dependency compromise yields key | ~1 day |
| **B. Dedicated signing service over authenticated local IPC** | **Medium** — separate process, narrow schema | OS process boundary; `SO_PEERCRED`/mTLS; per-request context validation; independent audit log; hot rotation | **Medium** — two processes, socket lifecycle, readiness probe, supervision | **High** — plain JSON over a socket, no SDK constraint | Signer down (availability); IPC auth misconfig; replay at IPC layer if unbound | ~3–5 days |
| **C. Hardware-backed (KMS/HSM)** | **Low** — key never in app memory | KMS policy gates which digests may be signed; hardware tamper resistance | **High** — provisioning, IAM, networking, procurement, cost | **Low** — no provider verified against Concordium's digest | Digest-format mismatch; provider rate limits; latency; cost overrun; vendor lock-in | Weeks + procurement |

### HSM/KMS compatibility — honest status

| Provider | Ed25519 raw signing | Assessment |
|---|---|---|
| AWS KMS | No (ECDSA/RSA only) | **NOT VERIFIED** — likely unsupported [DOC] |
| GCP Cloud KMS | No (ECDSA/RSA only) | **NOT VERIFIED** — likely unsupported [DOC] |
| Azure Key Vault | Ed25519 (preview) | **NOT VERIFIED** against Concordium's 32-byte pre-finalization digest |
| YubiHSM 2 | Ed25519 | **NOT VERIFIED** — needs a custom adapter |
| Thales Luna | Ed25519 | **NOT VERIFIED** — needs a custom adapter |
| Ledger / Trezor | Different key-handling model | **NOT VERIFIED** — likely unsupported |

Concordium account signatures are Ed25519 [DOC]. Whether any specific KMS will sign the exact
pre-finalization digest through a compatible API is **unverified for every provider**. No
provider was tested. Do not select path C on assumption.

### Recommendation — **B, dedicated signing service over authenticated local IPC**

Why B:

- **C's compatibility is unverified.** Committing to it risks a procurement dead end after
  weeks of IAM work.
- **B removes the dominant practical risk** — key co-location with the untrusted-input parser —
  at a fraction of C's effort.
- **B's interface is exactly the `NarrowSponsorSigner` contract** already built and tested in
  TASK34/34.2. The seam exists; B fills it.
- **The gateway stays keyless under all three**; B additionally keeps the *facilitator* keyless.
- **Path to C stays open.** The IPC contract is the boundary: swapping the signer service's
  backend from a local key to an HSM does not change the facilitator.

Why not A: the facilitator parses untrusted JSON on the same heap. Co-locating a value-moving key
there is the highest-impact mistake available for the least saved effort.

Why not C first: choosing it before verifying digest compatibility is buying a risk, not
reducing one.

**Gateway keyless design preserved:** the gateway never imports the signer, never sees a key, and
continues to gate on `DENY_ALL_FACILITATOR` by default.

---

## 9. Sponsor account requirements

### 9.1 Identity

Standard Concordium account, base58check, validated by
`ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/` [SRC — `config.ts:62`].

Must be **separate** from the registry account `4dWn8miA…Zg4d` (owner of token 1004):

- separation of duties — fee payer must not also control agent identity [ASSUME → design rule];
- the registry account is an on-chain identity; exposing it to an automated hot path risks it;
- rotation of a sponsor key must not require re-registering the agent.

Funding must never come from the registry account. [Constraint]

### 9.2 Capabilities

| Requirement | Status |
|---|---|
| Ed25519 account key | [DOC] — standard Concordium accounts |
| Implements `AccountSigner.sign(digest)` | [SRC] — `signHelpers.d.ts:43-51` |
| CCD balance for fees | [SRC] — sponsor is the fee payer via `header.sponsor` |
| No contract, no special credential | [SRC] — plain account suffices |

### 9.3 Funding and replenishment

- Testnet faucet, operator-initiated — out of scope, not performed.
- No automated replenishment exists.
- Monitor via `getAccountInfo` polling; alert below 10 CCD.
- Reserve guidance in §7.5 (**estimates**).

---

## 10. Compatibility with existing code

| Component | Change needed for a real signer |
|---|---|
| `SponsorSigner` interface | None — same method shape |
| `core.settle()` ordering | None — already sign → hash → prepare → claim → submit |
| `ReconciliationService` / `EvidenceVerifier` | None |
| `SqliteSettlementRepository` schema | None — all states exist |
| `sign_events` table | Exists (TASK34) |
| `/healthz` `canSign` | Flips to `true`; already reported, not gated |
| `FacilitatorConfig` | Needs `maxEnergy`, `maxExpiryOffset`, sponsor policy values |
| `core.settle()` validation | **Must call the authorization boundary** (§3.6) |

---

## 11. Implementation prerequisites (ordered)

1. **TASK34.4** — remediate M1 (`recordSignEvent` bypass) and M2 (unaudited state rejections).
2. **Wire the authorization boundary into `settle()`** — `decideAuthorization` must gate
   `addSponsorSignature`, not sit orphaned.
3. **Enforce energy cap and sponsor≠recipient on the settle path.**
4. **Add `maxEnergy` / `maxExpiryOffset` to `FacilitatorConfig`**, validated fail-closed.
5. **Implement architecture B** — signer service, authenticated IPC, the §4 contract.
6. **Add sponsor balance monitoring** and a low-balance alert.
7. **Add rate limiting** on `/settle` and `/reconcile`.
8. **Write the incident runbook** — disable paths, key rotation, recovery, backup.
9. **Provision a funded Testnet sponsor account** — external, separate from the registry account.
10. **Verify `NOT_FOUND` and timeout evidence paths** against a live node — still unverified.

---

## 12. Recommended next bounded task

**TASK 34.4 — Close TASK34.3 M1/M2 (mock-only, zero key material).**

Scope, fully offline:

- Make `recordSignEvent()` private, or gate it identically to `authorizeSignEvent()`.
- Persist `rejected` sign events for durable-state violations: wrong state, non-null hash,
  unknown payment, duplicate approval. The partial unique index applies only to
  `decision = 'approved'`, so rejections do not block a valid retry.
- Deterministic tests for both behaviours, asserting exact row counts and reason codes.
- No key, no account, no network, no settlement, no settle-path behaviour change.

Rationale: it is the smallest task that removes the two findings a real signer would otherwise
inherit, and it needs no external dependency.

Then, in order: settle-path wiring → config limits → architecture B → provisioning.

---

## 13. VERIFIED / NOT VERIFIED / NOT TESTED

### VERIFIED

**Source-verified [SRC]**

- SDK versions 12.0.2 / 2.29.0 / 2.29.0; Node 26.7.0.
- `Transaction.sponsor()` signs `preFinalized(tx)` through
  `AccountTransactionV1.createSignature` (`signable.js:91-105`).
- `addSponsorSignature()` → `mergeSignaturesInto`, which **throws** on duplicate signature
  index (`signable.js:124-127`).
- `AccountSigner.sign(digest: ArrayBuffer)` is general-purpose; the SDK does not restrict the
  digest (`signHelpers.d.ts:43-51`).
- `buildBasicAccountSigner(privateKeyHex)` (`signHelpers.d.ts:73`) and
  `toConcordiumFacilitatorSigner(addr, keyOrSigner, cfg)` (`index.mjs:43-46`) accept a raw key
  string.
- Submission returns `getAccountTransactionHash(finalized)` (`index.mjs:70-74`).
- Energy formula and constants: `A=100`, `B=1`, v0 header 60, V1-with-sponsor header 94,
  transfer base 300 (`energyCost.js`, `AccountTransactionV0.js:92`,
  `AccountTransactionV1.js:132-137,151-153`, `accountTransactions.js:20-22`).
- `convertEnergyToMicroCcd` exists and depends on `euroPerEnergy` / `microGTUPerEuro` from chain
  parameters (`energyCost.js`, `translation.js:234-235`).
- Energy cap and sponsor≠recipient are **absent from `core.settle()`**; present only in
  `narrowSponsor.ts` (grep evidence §3.6).
- Every existing restriction in §3.5 is present in current source.

**Executed [EXEC]**

- `git rev-parse HEAD` matches the expected baseline.
- The two greps establishing §3.6.
- TASK34.3 probe reproductions of M1 (approval inserted for a `prepared` payment) and M2
  (zero rows after a state rejection).

**Measured**

- Three token-1004 transactions: 2380 / 1859 / 1860 NRG → 22.010289 / 17.180273 / 17.189515 CCD.

### NOT VERIFIED

- Any KMS/HSM provider's ability to sign Concordium's exact pre-finalization digest.
  **No provider tested — do not assume support.**
- That Concordium account credentials are Ed25519 for every account version (documented for
  standard accounts; not re-derived here).
- Current chain parameters / live exchange rate — no network query performed in this task.
- Whether the derived ~9245 microCCD/NRG rate holds outside the sampled block range.

### NOT TESTED

- Live sponsor signing — no sponsor account exists.
- `convertEnergyToMicroCcd` against real chain parameters.
- Architecture B IPC service — not implemented.
- `NOT_FOUND` / timeout branches of the evidence verifier against a live node.
- Rate limiting, balance monitoring, rotation, backup, incident response — none implemented.

### BLOCKED

- Sponsor account provisioning — external, operator-initiated, must not use the registry account.
- HSM procurement — infrastructure/vendor decision outside this repository.

---

## 14. Constraints honoured

Read-only · no private-key access · no key generation/import/export · no wallet access · no
sponsor account creation, provisioning, or funding · no faucet · no real signer implementation ·
no `AccountSigner` · no signing · no transaction construction for broadcast · no submission · no
broadcast · no Mainnet interaction · no real settlement · token 1004 unmodified · registry account
unmodified · settlement not enabled · `DENY_ALL_FACILITATOR` preserved · authorization and
crash-recovery protections preserved · no unrelated refactoring · no commit/push/publish · no
TASK34.3 finding silently fixed · TASK36 not started.

## 15. Stop condition

TASK 35 complete. Feasibility report and recommendation only — nothing deployed, nothing
implemented, no key and no funds touched.

Awaiting explicit maintainer approval before TASK34.4, TASK36, account provisioning, or any real
signing work.
