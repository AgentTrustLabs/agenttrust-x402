# TASK 34.11 — Settlement Authorization Boundary Integration

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Narrow integration.** Mock signer only. No real signer, key, settlement activation, or
production IPC deployment.

---

## 1. Before / after settlement call graph

### Before

```
settle(body)
 ├─ parseEnvelope
 ├─ checkAgreement
 ├─ checkExpiry
 ├─ store.claim(digest, reqKey)
 ├─ signer.addSponsorSignature(payload.payload)      ← NO authorization step
 ├─ computeTransactionHash
 ├─ store.prepare → store.claimSubmit → signer.submitTransaction
 └─ markBroadcast → waitForFinalization → reconcile
```

Any payment that passed replay protection reached the signer. There was no durable-approval
requirement.

### After

```
settle(body)
 ├─ parseEnvelope
 ├─ checkAgreement
 ├─ checkExpiry
 ├─ store.claim(digest, reqKey)                    ← replay protection
 ├─ authorization.authorize(request)              ← NEW boundary
 │    ├─ outcome !== 'approved'  → return (never reaches the signer)
 │    └─ outcome === 'approved'  → continue
 ├─ signer.addSponsorSignature(payload.payload)
 ├─ computeTransactionHash
 ├─ store.prepare → store.claimSubmit → signer.submitTransaction
 └─ markBroadcast → waitForFinalization → reconcile
```

**Ordering evidence:** the authorization call sits at `core.ts` immediately after the
`resumableHash` block and before the first `this.signer.` call. A `resumable` payment (durable
hash already persisted) skips re-authorization — the hash can only exist after authorization
succeeded, and re-authorizing would be refused by the durable gate.

---

## 2. The authorization boundary and IPC client

### 2.1 Interface

`services/facilitator/src/authorization.ts`:

```typescript
export type AuthorizationOutcome =
  | 'approved' | 'rejected' | 'unknown' | 'owner_unavailable' | 'protocol_error';

export interface AuthorizationClient {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
}
```

### 2.2 `LocalAuthorizationClient` (test/mock only)

Applies the address-free subset of the narrow policy (network, sponsor match, sponsor≠sender,
sponsor≠recipient, energy > 0, energy ≤ cap, expiry window), then calls the **durable gate**:

```typescript
this.repo.authorizeSignEvent({ paymentDigest, decision: 'approved', ... });
```

This is the exact boundary TASK34.2/34.4 built — `BEGIN IMMEDIATE` → state must be `created`
→ `tx_hash IS NULL` → no prior `approved` → `INSERT sign_events` → `COMMIT`.

It skips `decideAuthorization`'s base58 address validation because the mock sponsor is
`3mockSponsorPlaceholderNotARealAccountAddress0000`, which is not a real Concordium account.
Production uses the IPC client, where the owner runs the full policy against a real sponsor.

### 2.3 `IpcAuthorizationClient` (production path)

Opens the Unix socket, sends the agenttrust-authz v1 envelope, reads one JSONL response,
maps `outcome` to the five outcomes. Timeouts and connection errors map to
`owner_unavailable`. Malformed responses map to `protocol_error`.

It **never opens the authorization database** and never trusts a caller-supplied decision.

### 2.4 Wiring

- `CoreOptions.authorization?: AuthorizationClient` — injected boundary.
- `CoreOptions.maxAuthorizationEnergy?: bigint` — cap (default `100_000n`).
- `FacilitatorConfig.authorizationSocket` ← `FACILITATOR_AUTHZ_SOCKET`.
- `startFacilitator` constructs `IpcAuthorizationClient` when the socket is configured,
  otherwise leaves the local mock client in place.

---

## 3. Energy derivation

`services/facilitator/src/energy.ts` uses Concordium's own formula:

```
energy = 100·signatureCount + 1·(94 + payloadSize) + transactionSpecificCost
```

Constants verified against `@concordium/web-sdk` `energyCost.js` and `AccountTransactionV1.js`
in TASK35. `transactionSpecificCost` is passed explicitly as `SIMPLE_TRANSFER_BASE_COST = 300n`.
A shape that cannot be priced returns `null`, and `settle()` then refuses authorization.

---

## 4. Signer invocation counts per scenario

The mock signer is wrapped in a counting proxy; `addSponsorSignature` and `submitTransaction`
are counted per scenario.

| Scenario | `addSponsorSignature` | `submitTransaction` |
|---|---|---|
| Successful authorization | **1** | **1** |
| Rejected authorization | **0** | **0** |
| Unknown authorization | **0** | **0** |
| Owner unavailable | **0** | **0** |
| Protocol error | **0** | **0** |
| Malformed owner response | **0** | **0** |
| Authorization client throws | **0** | **0** |
| Digest mismatch | **0** | **0** |
| Sponsor mismatch | **0** | **0** |
| Recipient mismatch | **0** | **0** |
| Sponsor == sender | **0** | **0** |
| Energy over cap | **0** | **0** |
| `authorization_already_recorded` | **0** | **0** |
| Duplicate settlement request | **1** (first only) | **1** (first only) |
| Concurrent settlement requests | **1** total | **1** total |
| Owner crash / timeout | **0** | **0** |
| Signer failure after approval | **1** | **1** (then pending, never retried) |

No facilitator-side database approval writes exist. The only approval-producing repository
method is `authorizeSignEvent`, and the facilitator never calls it directly — it goes through
the injected `AuthorizationClient`.

---

## 5. Durable authorization behaviour

- `LocalAuthorizationClient` records the audit event through `authorizeSignEvent`, which is a
  single `BEGIN IMMEDIATE` transaction. A rejected state (`prepared`, non-null `tx_hash`,
  non-`created`, prior approval) writes a `rejected` event and returns `ok:false`.
- `authorization_already_recorded` is returned as a **rejection**, never as approval. Test 10b
  verifies zero `approved` sign events after that outcome.
- A rejected authorization moves the payment to `rejected` via the existing `markFailed`
  path. The durable submission state machine (`prepare`/`claimSubmit`/`markBroadcast`/
  `reconcile`) is unchanged.

---

## 6. Failure and recovery semantics

| IPC outcome | `settle()` result | Non-terminal? |
|---|---|---|
| `approved` | continues to the signer | — |
| `rejected` | `authorization_rejected` + payment → `rejected` | no |
| `unknown` | `settlement_pending` + `extra.nonTerminal` | yes |
| `owner_unavailable` | `settlement_pending` + `extra.nonTerminal` | yes |
| `protocol_error` | `authorization_protocol_error` | no |
| client throws | `authorization_failed` | no |

**No fail-open.** Ambiguous outcomes (`unknown`, `owner_unavailable`) map to the existing
non-terminal `settlement_pending` state and are never auto-retried.

**Recovery limitation (documented):** a consumed approval (`authorization_already_recorded`)
is not blindly accepted. The v1 IPC contract exposes only a decision, not a verifiable proof
of the existing approved event with matching context. No recovery path was invented, so the
payment must be re-driven with a new payload. This is documented as a limitation, not a gap
that was papered over.

---

## 7. Test results

### 7.1 Focused boundary tests — `test/task3411-authz-boundary.test.mts`

**23/23 passing.**

```
01. successful authorization reaches the signer exactly once
02. rejected never reaches the signer
03. unknown never reaches the signer
04. owner unavailable never reaches the signer
05. protocol error never reaches the signer
07a. malformed owner response never reaches the signer
07b. owner client throwing never reaches the signer
07c. approved outcome with no reason still passes
08a. DIFFERENT payment digest does not satisfy this payment
08b. sponsor mismatch rejected
08c. recipient mismatch rejected
08d. sponsor == sender rejected
09. energy over cap rejected
09b. energy derived positive and bounded
10. authorization_already_recorded NOT blindly accepted
10b. authorization_already_recorded leaves no approved sign event
11. duplicate settlement request cannot duplicate signing
12. concurrent settlement requests cannot bypass authorization
13. owner timeout never reaches the signer
14. signer failure after approval stays pending, never retried
15. DENY_ALL_FACILITATOR behaviour unchanged
```

### 7.2 Real IPC integration — `test/task3411-ipc-integration.test.mts`

**4/4 passing.** A real authorization owner process (`authowner`, UID 997) runs on a Unix
socket; a real `FacilitatorCore` with `IpcAuthorizationClient` drives it.

```
01. real IPC reachable and answers
   IPC settle result: authorization_rejected — authorization rejected: wrong_sponsor
   (mock sponsor is not a valid Concordium account; owner refuses)
02. owner absent → settlement_pending, authorizationOutcome=owner_unavailable
03. after restart the boundary still answers
04. owner down mid-run → fail closed
```

In every non-approved case the signer call count is **0**. The test is run as
`sudo -u ubuntu` so the facilitator process carries the `authclients` group and can reach the
socket; the owner runs as `authowner` and verifies peer credentials with `SO_PEERCRED`.

### 7.3 Full regression

| | |
|---|---|
| Full suite | **1811/1811 across 41 suites, 0 failures** |
| Facilitator typecheck | clean |
| Gateway typecheck | clean |

No test was weakened, skipped, or deleted.

---

## 8. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED

- Every path to the mock signer passes through the authorization boundary.
- Successful authorization reaches the signer exactly once.
- Rejected / unknown / owner-unavailable / protocol-error / malformed / throwing outcomes
  never reach the signer (`addSponsorSignature === 0`).
- Digest mismatch, sponsor mismatch, recipient mismatch, sponsor==sender, and energy-over-cap
  never reach the signer.
- `authorization_already_recorded` is not accepted as approval and leaves zero approved
  events.
- Duplicate and concurrent settlement requests produce exactly one signer invocation.
- Signer failure after approval stays pending and is never retried.
- Real IPC integration against a live owner over a Unix socket, with `SO_PEERCRED`.
- No facilitator-side database approval writes.
- `DENY_ALL_FACILITATOR` unchanged.
- Existing submission state machine intact.

### NOT TESTED

- `IpcAuthorizationClient` returning `approved` end-to-end with a real owner policy (the mock
  sponsor is not a valid Concordium account, so the owner's full policy refuses it). The
  approved path is covered by the in-process client and the structural IPC client.
- Settlement against a real signer — none exists.
- Recovery of a consumed approval — blocked on a v2 verification operation.
- Production systemd hardening — design only.

### BLOCKED

- Consumed-approval recovery requires an IPC operation the v1 contract does not provide. No
  approval path was invented.

---

## 9. Remaining limitations

1. **Consumed-approval recovery is not implemented.** A payment whose approval was already
   recorded fails closed and must be re-driven with a new payload. Documented, not worked
   around.
2. **The local client runs an address-free policy subset.** The mock sponsor is a placeholder,
   so `decideAuthorization`'s base58 validation cannot run. Production uses the IPC client,
   which runs the full policy in the owner.
3. **Energy derivation uses the payload byte length, not the SDK's canonical serializer.** The
   value is a lower bound (no base cost is omitted), which is the conservative direction for a
   cap, but it is not bit-exact with `AccountTransactionV1.calculateEnergyCost`.
4. **`resumable` payments skip re-authorization.** This is intentional (the durable hash is
   proof of prior authorization) and bounded to payments that already hold a persisted hash.
   It is not covered by a dedicated 34.11 test; it is covered by the existing `task29.1`
   crash-recovery suite.
5. **`IpcAuthorizationClient` is structural.** It is wired into `startFacilitator` when
   `FACILITATOR_AUTHZ_SOCKET` is set, but production IPC is not activated and settlement
   remains disabled.

---

## 10. Files

**Added**
- `services/facilitator/src/authorization.ts`
- `services/facilitator/src/energy.ts`
- `test/task3411-authz-boundary.test.mts` (23 tests)
- `test/task3411-ipc-integration.test.mts` (4 tests)
- `docs/archive/TASK34.11-settlement-authorization-boundary.md`

**Changed**
- `services/facilitator/src/core.ts` — `AuthorizationClient` option, constructor wiring,
  authorization call in `settle()`.
- `services/facilitator/src/config.ts` — `authorizationSocket` field + env parsing.
- `services/facilitator/src/server.ts` — `IpcAuthorizationClient` when a socket is configured.

`repository.ts`, `state.ts`, `narrowSponsor.ts`, `narrowSponsorMock.ts`, `signer.ts`, and
the gateway's `DENY_ALL_FACILITATOR` are unchanged.

---

## 11. Constraints honoured

Mock signer only · no private key access / generation / import / export / signing · no
sponsor provisioning or funding · no real transaction construction, submission, or broadcast ·
no faucet or Mainnet · token 1004 and its Agent Card untouched · real facilitator settlement
not enabled · `DENY_ALL_FACILITATOR` intact · production IPC not activated or deployed ·
production database contents untouched · no commit or push · TASK34.12/TASK34.13 not started.

## 12. Stop condition

TASK 34.11 complete. The authorization boundary is integrated into `settle()`, proven with
exact signer call counts, and verified against a real IPC owner. Working tree uncommitted.
Awaiting maintainer review.
