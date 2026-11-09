# TASK 24 — x402 Real Payment Feasibility & Integration Design

Date: 2026-11-05 · Bounded feasibility investigation. **No production payment behavior was
modified, no settlement enabled, no transaction signed or submitted, no key touched.**

## FINAL VERDICT: **CONDITIONALLY FEASIBLE**

A credible, officially-supported path exists and is **proven compatible with AgentTrust's own
code, unmodified**. It depends on one external prerequisite nobody has yet supplied: **a Concordium
testnet facilitator with a funded sponsor account**. There is no hosted one; the SDK ships the
facilitator, so the prerequisite is *operational* (run one, fund a sponsor), not *technical*.

---

## 1. The exact x402 flow, reconstructed from code

Traced through `src/payments/*.ts` and the vendored `@x402/concordium` 2.29.0 sources.

### Protocol requirements (from the x402 v2 Exact/Concordium spec, not our design)

1. Resource server answers `402` with `PaymentRequired { x402Version: 2, resource, accepts[] }`.
2. Each `PaymentRequirements` carries `{ scheme: 'exact', network, asset, amount, payTo, maxTimeoutSeconds, extra }`.
3. `extra.feePayer` **must** be present on Concordium. Verified in the client implementation:

   ```js
   // node_modules/@x402/concordium/dist/esm/chunk-P7DLOXRQ.mjs:60
   const feePayer = requirements.extra?.feePayer;
   if (typeof feePayer !== "string" || !feePayer) {
     throw new Error("requirements.extra.feePayer is required. …");
   }
   ```

   So the client **cannot even build a payload** without knowing the sponsor address. The sponsor
   is not optional in this scheme — it is structurally required.
4. The client builds a **V1 sponsored transaction**: sender signature present, `signatures.sponsor`
   empty `{}`, header carries `sponsor.address`. Filled by the client's own signer.
5. Facilitator `POST /verify` → validates 9 MUST rules (recipient, amount, asset, expiry, signature,
   payload safety).
6. Facilitator `POST /settle` → adds the sponsor signature, finalizes, submits, waits for
   finalization, returns a transaction hash.
7. Resource server grants access on a successful settle **with** a hash.

### AgentTrust-specific design decisions (ours, not the protocol's)

| Decision | Where | Rationale |
|---|---|---|
| `settle` defaults to `false` | `authorizePayment` | verify-only dry run is possible; no accidental transfer |
| `DENY_ALL_FACILITATOR` is the default port | `x402.ts:411` | no implicit endpoint, no env fallback |
| Access requires settle **success AND** a tx hash | `x402.ts:355-370` | a "successful" settlement with no hash is unauditable |
| Verify-only returns `granted: false` | `x402.ts:339` | verification is not payment |
| No retry on settle | `authorizePayment` | retrying a possibly-landed payment is a double-spend risk |
| `maxExpiryOffsetSeconds` 600 | `x402.ts:52`, SDK Rule 7 | matches spec |
| No signer, seed, key or mnemonic in the module | `SETTLEMENT-SAFETY.md` | hard boundary |
| Trust verdict kept separate from payment status | `TrustResult` vs `AccessDecision` | a TRUSTED agent can still fail to pay; a paying one can still be untrusted |

### Where the private key lives — and must not

The scheme splits cleanly, and this is the key architectural finding:

| Party | Holds | Signs |
|---|---|---|
| **Payer (Agent A)** | its own key, in its own wallet/process | sender half of the V1 sponsored tx |
| **Facilitator** | sponsor key | sponsor half, then submits |
| **AgentTrust gateway** | **nothing** | nothing |

`ExactConcordiumScheme` (client) takes a `ClientConcordiumSigner`; the facilitator variant takes a
`FacilitatorConcordiumSigner`. Two different classes, two different keys, neither of which the
gateway needs. AgentTrust only ever consumes the HTTP `/verify` and `/settle` surfaces.

---

## 2. Payment infrastructure investigation

### 2a. Hosted Concordium facilitator — **DOES NOT EXIST**

Re-probed in this task (documented `/supported` endpoint only; no verify, no settle):

```console
facilitator.concordium.com                 NXDOMAIN
x402-facilitator.concordium.com            NXDOMAIN
x402.concordium.com                        NXDOMAIN
facilitator.testnet.concordium.com         NXDOMAIN
x402.testnet.concordium.com                NXDOMAIN
```

The public `x402.org` facilitator, queried live:

```console
$ curl -s https://x402.org/facilitator/supported
kinds: 11
networks: algorand:SGO1…, aptos:2, base-sepolia, eip155:84532, hedera:testnet,
          solana-devnet, solana:EtWT…, stellar:testnet, xrpl:1
ccd present: False
```

The x402 Foundation's own **Facilitators** directory lists ~19 production facilitators (Stellar,
CDP/Coinbase, Celo, Corbits, Dexter, Fireblocks, HPP, NEAR, PayAI, Polygon, Solvador, Sui, T54 XRPL,
X Pay, TRDEFI Arc…). **Not one supports `ccd:*`.**

Concordium's own documentation describes `/verify` and `/settle` as services *the resource server
runs* — it publishes no hostname, because there is none.

### 2b. Self-hosted facilitator with a separately operated sponsor — **VIABLE**

This is the path. The official SDK **ships the facilitator**, not just the client:

```console
$ ls node_modules/@x402/concordium/dist/esm/exact/
client/        facilitator/        server/
```

Constructed it in-process with a **keyless stub signer** and asked it for `/supported`:

```console
$ npx tsx scripts/task24-probe-facilitator.mts
{
  "kinds": [{
    "x402Version": 2,
    "scheme": "exact",
    "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    "extra": { "feePayer": "3abcStubSponsorAddressForShapeOnly" }
  }],
  "extensions": [],
  "signers": { "ccd:*": ["3abcStubSponsorAddressForShapeOnly"] }
}

=== AgentTrust validateSupportedShape ===
{"ok":true}

=== AgentTrust classifyCompatibility ===
{ "usable": true, "code": "OK",
  "reason": "exact v2 with feePayer 3abcStubSponsorAddressForShapeOnly",
  "schemesOnNetwork": ["exact"],
  "networks": ["ccd:4221332d34e1694168c2a0c0b3fd0f27"] }

VERDICT: SDK facilitator output is accepted by AgentTrust code UNMODIFIED
```

**This is the single most important result of the task.** The official SDK's facilitator produces
exactly the `/supported` shape that AgentTrust's existing `validateSupportedShape` and
`classifyCompatibility` already accept, with **zero changes to our code**. The piece that was
missing in TASK 07 was not a protocol mismatch — it was a *deployment*.

Sponsor separation is achievable two ways, both keeping the gateway keyless:

- **Out-of-process HTTP facilitator** — run `x402Facilitator` + `ExactConcordiumScheme` in its own
  process/service; AgentTrust points `createHttpFacilitator({ url })` at it. Sponsor key never
  enters the gateway. This is what `createHttpFacilitator` already does and it has never been
  constructed anywhere in the project.
- **Self-facilitation inside the resource server** (x402's documented third path) — the *payee*
  (Agent B) runs the facilitator. Also keeps AgentTrust keyless, but couples sponsorship to the
  seller.

### 2c. Client-signed non-sponsored path — **NOT SUPPORTED**

Rejected on evidence, not assumption. The client throws without `extra.feePayer`
(`chunk-P7DLOXRQ.mjs:60`), and the payload it builds is a *sponsored V1 transaction* with an empty
sponsor signature slot that the facilitator must fill via `Transaction.sponsor()`. There is no
code path in the scheme that produces an unsponsored, self-paid transaction. A client that wanted
to pay its own fee would be fighting the scheme.

### 2d. Candidate comparison

| Path | Official source | Network | Asset | x402 v2 / exact | /supported | /verify | /settle | Sponsor needed | Keyless for AgentTrust | Testable today |
|---|---|---|---|---|---|---|---|---|---|---|
| `x402.org` facilitator | x402 Foundation | 9 networks, **no ccd** | — | v2 | ✗ no `ccd:*` | n/a | n/a | n/a | yes | **NO — wrong network** |
| Concordium-hosted facilitator | — | — | — | — | **NXDOMAIN** | — | — | — | — | **NO — does not exist** |
| Self-hosted SDK facilitator + separate sponsor | **Concordium (official SDK)** | testnet `ccd:4221…` | CCD (also PLT) | v2 / exact ✓ | **✓ verified** | ✓ implemented | ✓ implemented | **yes, funded** | **yes** | **YES** |
| Self-facilitation in resource server | x402 Foundation documented pattern | testnet | CCD | v2 / exact ✓ | ✓ | ✓ | ✓ | yes, funded | yes (payee sponsors) | YES |
| Client-signed non-sponsored | — | — | — | — | — | — | — | — | — | **NO — scheme requires feePayer** |
| Third-party hosted `ccd` facilitator | — | — | — | — | none listed | — | — | — | — | **NO — none exists** |

---

## 3. Agent-to-agent roles

Scenario: **Agent A buys a paid service from Agent B, with AgentTrust as the trust gate and audit
layer**, and a separate Facilitator F providing sponsorship + settlement.

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent A (payer)<br/>own key, own process
    participant AT as AgentTrust Gateway<br/>NO key material
    participant B as Agent B (payee /<br/>resource server)
    participant F as Facilitator F<br/>sponsor key
    participant CH as Concordium testnet

    A->>AT: trust.verify(token_id of B)
    AT->>CH: registry read (read-only)
    AT->>B: GET agent card (pinned transport, SSRF-guarded)
    AT-->>A: TRUSTED / REJECTED / INCONCLUSIVE<br/>+ failure_kind + failed_requirements

    Note over A,AT: Agent A applies its own policy.<br/>A REJECTED or INCONCLUSIVE stops here —<br/>no payment is ever attempted.

    A->>B: GET /paid-resource
    B-->>A: 402 PaymentRequired<br/>{ accepts:[{scheme:'exact', network:'ccd:…',<br/>asset:'CCD', amount, payTo:B,<br/>extra:{feePayer:F}}] }

    Note over A: A checks payTo == verified owner,<br/>amount within its own cap,<br/>network == testnet, expiry ≤ 600s

    A->>A: ExactConcordiumScheme.createPaymentPayload(2, req)<br/>builds sponsored V1 tx, signs SENDER half<br/>(A's key never leaves A)
    A->>B: GET /paid-resource with PAYMENT-SIGNATURE

    B->>AT: (optional) trust check already done; B may re-verify
    B->>F: POST /verify {paymentPayload, paymentRequirements}
    F-->>B: { isValid, payer }

    alt verify invalid
        B-->>A: 402 with reason
    else verify valid
        B->>F: POST /settle
        F->>F: addSponsorSignature(sponsor key)
        F->>CH: finalize + sendTransaction
        CH-->>F: committed → finalized
        F-->>B: { success, transaction: <txHash>, network }
        Note over B: access requires success AND a tx hash
        B-->>A: 200 + resource + PAYMENT-RESPONSE{txHash}
    end

    B->>AT: audit.verify / record settlement evidence
    A->>AT: audit.verify — both sides hold auditable evidence
```

### Responsibility matrix

| Action | Responsible | AgentTrust may do it? |
|---|---|---|
| Decide whether B is trusted | **Agent A**, using AgentTrust's verdict | produces the verdict, not the decision |
| Sign the payment | **Agent A** | **never** |
| Serve the 402 + requirements | **Agent B** | no (B is not the gateway) |
| Verify the payload | **Facilitator F** | may proxy to F; never verifies signatures itself |
| Sponsor the fee | **Facilitator F** (separate key) | **never** |
| Submit the transaction | **Facilitator F** | **never** |
| Grant access | **Agent B**, on `success && txHash` | no — B is the resource server |
| Audit evidence | **A and B**, both via AgentTrust's trail | yes, as the audit layer |

The gateway's role in payment is deliberately thin: **it never stands between the money and the
resource.** It gates *who you may transact with*; the payment rail is A → F → chain, and the
access decision is B's.

---

## 4. Security and trust boundaries

All preserved; none changed in this task.

| Requirement | Status | Mechanism |
|---|---|---|
| Never export/log private keys | **held** | module accepts no signer/seed/mnemonic; `redactJson` on output; verified by task11 (14/14) |
| No sponsor credentials in the gateway | **held** | `FacilitatorConcordiumSigner` exists only in the SDK; no code path constructs one |
| MCP input cannot create operator authorization | **held** | `REJECTED_FIELDS` → `AUTHORIZATION_NOT_ACCEPTED`; task19 test 11, task08 tests 04–06 |
| No access on verification alone | **held** | `authorizePayment` returns `granted:false` on verify-only |
| No access on simulated settlement | **held** | `settle.settled` literal `false`; `receipt.settled: false` |
| Reject missing/malformed/mismatched/expired/replayed evidence | **held** | `preflightPaymentPayload`, `checkTransactionExpiry`, recipient/amount/asset/expiry rules |
| Ambiguous settlement never auto-retried | **held** | no retry in `authorizePayment`; documented in `SETTLEMENT-SAFETY.md` |
| Trust verdict separate from payment status | **held** | `TrustResult` (with `failure_kind`) vs `AccessDecision` vs policy `code` |

### New boundaries this design would require (for the eventual implementation task)

1. **Replay.** x402 v2 has a `payment-identifier` extension for idempotency; this project does not
   implement it. A settled payload replayed against the same resource must be rejected. Today the
   protection is the nonce/expiry in the transaction itself, which is not sufficient across
   multiple resources.
2. **`settlement_pending`.** The x402 docs define this as non-terminal: the tx may still confirm.
   Treating it as failure risks denying a paying client; treating it as success risks free access.
   Correct handling is: record the hash, do not grant, reconcile on chain, grant on confirmation.
3. **Amount ≠ price substitution.** The requirement's `amount` is set by Agent B. Agent A must
   check it against its own cap before signing — AgentTrust's policy cap is A-side, and the
   gateway is not in the signing path.
4. **Facilitator trust.** F sees every payload and sponsors every fee. Running F is a trust
   position, not a neutral utility.

---

## 5. Experimental validation performed

| # | Experiment | Method | Result |
|---|---|---|---|
| 1 | Hosted Concordium facilitator exists? | DNS + `getent` for 5 plausible hostnames | **5/5 NXDOMAIN** |
| 2 | `x402.org` supports CCD? | live `GET /supported` | **11 kinds, 0 `ccd:*`** |
| 3 | Official directories list a CCD facilitator? | x402 Foundation Facilitators page | **19 listed, none CCD** |
| 4 | Does the SDK ship a facilitator? | inspect `@x402/concordium/dist/esm/exact/facilitator` | **yes** |
| 5 | Can it be constructed keylessly? | stub signer with no key material | **yes — `getSigners()`, `getExtra()` return the sponsor** |
| 6 | Does its `/supported` satisfy AgentTrust? | `validateSupportedShape` + `classifyCompatibility` | **`{ok:true}`, `usable:true, code OK`** |
| 7 | Does the client require `feePayer`? | read `createPaymentPayload` source | **throws without it — sponsor structurally required** |
| 8 | Is a non-sponsored path available? | searched client scheme for an unsponsored branch | **none exists** |

**Not performed, deliberately:** no `/verify` or `/settle` call against any service; no transaction
built, signed or submitted; no key generated, read, exported or logged; no on-chain write.

---

## 6. Blockers, with evidence

| Blocker | Evidence | Blocks what | Removable? |
|---|---|---|---|
| **B1 — No hosted CCD facilitator exists** | 5 NXDOMAIN; `x402.org` 11 kinds, 0 CCD; x402 directory 19 entries, 0 CCD | anything instantly testable | yes, by deploying one |
| **B2 — A funded sponsor account is required** | `chunk-P7DLOXRQ.mjs:60` throws without `extra.feePayer`; facilitator must `addSponsorSignature` + `sendTransaction` | every real payment | yes, needs testnet CCD + an operator key held by the facilitator |
| **B3 — AgentTrust must not hold that key** | `SETTLEMENT-SAFETY.md`; this task's constraints | running F inside the gateway process | yes, by running F as a separate service |
| **B4 — No replay/idempotency implementation** | no `payment-identifier` handling in `src/payments/` | safe multi-resource settlement | yes, bounded feature |
| **B5 — `settlement_pending` unhandled** | `authorizePayment` treats non-success as `granted:false` | correct behaviour on ambiguous outcomes | yes, bounded feature |

B1 and B2 are the *only* things standing between this project and a demonstrable real testnet
payment. Neither is a protocol or code defect.

---

## 7. Recommended next bounded implementation task

**Only because a viable path exists**, and only after maintainer approval:

> **TASK 25 — Out-of-process Concordium facilitator prototype + one end-to-end testnet payment**
>
> Scope:
> 1. A standalone `services/facilitator/` process using the official SDK's `x402Facilitator` +
>    `ExactConcordiumScheme`, reading the sponsor key from **its own** environment — never from
>    the gateway, never from this repo.
> 2. Expose `/supported`, `/verify`, `/settle` over HTTP with the shape proven in §2b.
> 3. Point AgentTrust's existing `createHttpFacilitator({ url })` at it — **no change to the
>    gateway's payment code**, since the compatibility test already passes unmodified.
> 4. One happy path on testnet: Agent A (funded test account) buys a mocked resource from Agent B,
>    facilitator sponsors and settles, both sides write audit evidence, hash confirmed on
>    ccdscan testnet.
> 5. Add `settlement_pending` reconciliation and replay rejection before enabling anything beyond
>    a single manual run.
>
> Explicitly out of scope: mainnet, PLT assets, production hardening, any change to trust
> verdicts, any gateway-held key.

Estimated blocker removal: B1 and B2 by item 1–2; B3 by the process split; B4/B5 by item 5.

---

## 8. Verification — nothing regressed

```console
$ npx tsc --noEmit   → exit 0
$ npx tsc            → exit 0
$ npm test           → all suites passed   (24 suites, 960/960)   × 3 consecutive runs
```

| Suite | Result |
|---|---|
| task04-x402-exact | **44/44** |
| task04-sdk-conformance | **15/15** |
| task07-facilitator-readiness | **30/30** |
| task05-commerce | **36/36** |
| all others (24 suites) | unchanged |

**Deny-by-default still holds:**

```ts
export const DENY_ALL_FACILITATOR: ConsumerFacilitator = {
  async verify() { throw new Error('no facilitator configured: refusing to verify'); },
  async settle() { throw new Error('no facilitator configured: refusing to settle'); },
```

**Settlement still disabled by default** (`authorizePayment({ settle })` defaults `false`).

**Token 1004:**

```console
$ node dist/cli/verify.js --token-id 1004 --quiet   → exit 0
TRUST DECISION             TRUSTED
sha256 (local)     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)  3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions       0 (read-only)
```

On-chain unchanged: `nonce 4`, `19943619923` microCCD (19 943.619923 CCD).

**Zero transactions. Zero signing. Zero settlement. No key read, exported, or logged.**

### Files changed

| File | Change |
|---|---|
| `scripts/task24-probe-facilitator.mts` | **new** — feasibility probe (stub signer, no key, no network write) |
| `docs/archive/TASK24-x402-feasibility.md` | this report |

**No file in `src/payments/` was modified.** `git status` confirms: no `src/` changes in this task.

---

## 9. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED
- x402 v2 Exact flow reconstructed from source: requirements → payload → verify → settle → hash → access.
- `extra.feePayer` is **structurally required**; a non-sponsored client path does not exist.
- No hosted Concordium facilitator exists (5 NXDOMAIN; `x402.org` has 0 `ccd:*` kinds; the x402
  Foundation directory lists 19 facilitators, none CCD).
- The official SDK **ships a complete facilitator** (`exact/facilitator`), constructible without
  any key material.
- Its `/supported` output is **accepted unmodified** by AgentTrust's existing
  `validateSupportedShape` and `classifyCompatibility` (`ok:true`, `usable:true`, `code:'OK'`).
- The key split is clean: payer key in the client, sponsor key in the facilitator, **nothing in the
  gateway**.
- All eight security boundaries still hold; 960/960 tests; deny-by-default and settle-disabled
  unchanged; token 1004 TRUSTED with an unchanged hash.

### NOT TESTED
- Any real `/verify` or `/settle` against a live facilitator (none exists to call; calling a
  home-made one would require a funded sponsor key, which this task forbids).
- A real payment payload (requires a signer).
- `settlement_pending` handling and on-chain reconciliation.
- Replay/idempotency behaviour across multiple resources.
- PLT (non-CCD) asset path — supported by the SDK, deliberately out of scope.

### BLOCKED
- **A real, demonstrable testnet payment** — blocked by B1 (no hosted CCD facilitator) and B2 (no
  funded sponsor under a separate operator). Both are *operational*, not technical: the protocol,
  the SDK, and AgentTrust's own compatibility layer all already line up.

---

## 10. Remaining semantic limitations

1. **CONDITIONALLY FEASIBLE, not FEASIBLE.** Everything on our side works against the official SDK
   today, but nothing has been settled on-chain, so the claim "real agent-to-agent x402 payments
   work on Concordium testnet" cannot be made yet — only "every code-level precondition is proven".
2. **Sponsor is a trust position.** Whoever runs the facilitator sees every payload and pays every
   fee. Self-facilitation moves that trust to the payee rather than removing it.
3. **AgentTrust is not in the payment path.** Its role is the trust verdict plus the audit trail.
   A payment can succeed for an agent whose verdict was INCONCLUSIVE if the buyer's own policy
   permits it — the gateway does not and cannot enforce the buyer's spending decision.
4. **Card semantic truthfulness is still not proven.** TRUSTED means the identity claim is
   consistent and the bytes match the anchor. It says nothing about whether the paid service is
   worth buying.
5. **Pre-existing TASK 06 audit-lock flake** remains untouched (`lock.ts` unmodified); all suites
   passed in the three recorded runs.
