# TASK 34.11 — Settlement Authorization Boundary Integration

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Narrow integration.** No real signer, no key material, no settlement activation. The mock
signer remains mock-only (`canSign: false`). `DENY_ALL_FACILITATOR` untouched.

---

## 1. Exact settlement path (documented before the change)

`FacilitatorCore.settle()` in `services/facilitator/src/core.ts`, in execution order:

```
settle(body)
 ├─ parseEnvelope(body)                 → invalid_request
 ├─ checkAgreement(payload, reqs)       → requirements_mismatch
 ├─ checkExpiry(payload, reqs)          → expired
 ├─ store.claim(digest, reqKey)         → pending | in_progress | terminal
 │                                        | different_authorisation | idempotent | resumable | fresh
 ├─ [NEW] authorization.authorize()     ← TASK 34.11
 ├─ signer.addSponsorSignature()        ← signer boundary
 ├─ computeTransactionHash(sponsored)
 ├─ store.prepare(digest, hash)         ← durable hash before broadcast
 ├─ store.claimSubmit(digest, hash)
 ├─ signer.submitTransaction(sponsored)
 ├─ store.markBroadcast(digest, hash)
 ├─ hash comparison
 └─ signer.waitForFinalization → store.reconcile
```

**Before this task:** the arrow from `claim` went straight to `addSponsorSignature()`. There
was no authorization step at all. A real signer attached here would have signed any payment
whose digest claimed successfully — no durable approval required.

---

## 2. What was added

### 2.1 `services/facilitator/src/authorization.ts` (new)

Two implementations of one interface:

| Type | Purpose |
|---|---|
| `AuthorizationClient` | The seam `FacilitatorCore` holds |
| `LocalAuthorizationClient` | Test/mock only — calls `repository.authorizeSignEvent()` directly |
| `IpcAuthorizationClient` | Production — Unix socket, agenttrust-authz v1, never opens the DB |

```typescript
export type AuthorizationOutcome =
  | 'approved' | 'rejected' | 'unknown' | 'owner_unavailable' | 'protocol_error';
```

**`LocalAuthorizationClient`** performs the address-free subset of the narrow policy first
(network, sponsor match, sponsor≠sender, sponsor≠recipient, energy > 0, energy ≤ cap, expiry
window), then calls the **durable gate**:

```typescript
this.repo.authorizeSignEvent({ paymentDigest, decision: 'approved', ... });
```

This is the exact boundary TASK34.2/34.4 built: state must be `created`, `tx_hash` must be
NULL, no prior `approved` event, audit inserted in the same `BEGIN IMMEDIATE` transaction.

It deliberately does **not** run `decideAuthorization`'s base58 address validation, because
the mock signer's sponsor is `3mockSponsorPlaceholderNotARealAccountAddress0000` — not a real
Concordium account. Production uses `IpcAuthorizationClient`, where the owner runs the full
policy against a real sponsor address.

**`IpcAuthorizationClient`** speaks agenttrust-authz v1 over the socket. It is structural only
in this task — wired into `startFacilitator` when `FACILITATOR_AUTHZ_SOCKET` is set, but never
exercised with a live owner because settlement is not activated.

### 2.2 `services/facilitator/src/energy.ts` (new)

Derives the sponsor's energy exposure from the transaction using Concordium's own formula:

```
energy = 100·signatureCount + 1·(94 + payloadSize) + transactionSpecificCost
```

Constants verified against `@concordium/web-sdk` `energyCost.js` and
`AccountTransactionV1.js` in TASK35. `transactionSpecificCost` defaults to `300n` (simple
transfer) and is passed explicitly by `settle()`. Returns `null` when the transaction shape
cannot be priced — the caller then refuses authorization.

### 2.3 `core.ts` changes

- `CoreOptions.authorization?: AuthorizationClient` — the injected boundary.
- `CoreOptions.maxAuthorizationEnergy?: bigint` — cap (default `100_000n`), used only by the
  local client.
- Constructor builds a `LocalAuthorizationClient` when none is injected.
- `settle()` calls `this.authorization.authorize(authRequest)` after the replay claim and
  before any signer call.

### 2.4 `config.ts` / `server.ts` changes

- `FacilitatorConfig.authorizationSocket: string | null` from `FACILITATOR_AUTHZ_SOCKET`.
- `startFacilitator` constructs `IpcAuthorizationClient` when the socket is configured,
  otherwise leaves the local mock client in place.

**No change to the durable submission state machine.** `prepare`/`claimSubmit`/`markBroadcast`
/`reconcile` are untouched.

---

## 3. Ordering enforced

```
1. Validate x402 requirements + payload        (parseEnvelope, checkAgreement)
2. Validate expiry                             (checkExpiry)
3. Claim replay protection                     (store.claim)
4. Request authorization from the owner        (authorization.authorize)   ← NEW
5. Continue only after outcome === 'approved'
6. Invoke the mock signer boundary             (addSponsorSignature)
7. Existing safe preparation logic             (hash → prepare → claimSubmit → submit)
```

A rejection, unknown result, owner outage, malformed response, timeout, or digest mismatch
returns **before** step 6. Proven by tests 02 (six outcome variants) and 03 (client throws):
`calls.addSponsorSignature === 0` and `calls.submitTransaction === 0` in every case.

**Resumable payments skip re-authorization.** A `resumable` claim means the hash is already
durable from a crashed attempt, which implies authorization already succeeded (the hash cannot
exist otherwise). Re-authorizing would be refused by the durable gate and would strand the
payment. This is the only path that reaches the signer without a fresh `authorize()` call, and
it is bounded to payments that already hold a durable hash.

---

## 4. Authorization recovery semantics (`authorization_already_recorded`)

**Not treated as proof of approval.** The current IPC contract exposes only a decision
outcome, not a verifiable proof of the existing approved event with matching context.

- In the **local** client, `authorization_already_recorded` is returned as `rejected` and
  `settle()` returns `authorization_rejected`. Fail closed.
- In the **IPC** client, the owner owns that decision. If it returns `rejected` with that
  reason, `settle()` fails closed the same way.

**Documented limitation:** a consumed-approval recovery path would require the owner to expose
a verification operation (approved event + matching digest + matching context + compatible
state). That operation does not exist in v1, so recovery is not implemented and the payment
must be re-driven with a new payload. No new approval path was invented.

---

## 5. Outcome handling (all five explicit)

| IPC outcome | `settle()` result | Signer reached? |
|---|---|---|
| `approved` | continues | yes |
| `rejected` | `authorization_rejected` + payment → `rejected` | **no** |
| `unknown` | `settlement_pending` + `extra.nonTerminal: true` | **no** |
| `owner_unavailable` | `settlement_pending` + `extra.nonTerminal: true` | **no** |
| `protocol_error` | `authorization_protocol_error` | **no** |
| client throws | `authorization_failed` | **no** |

`unknown` and `owner_unavailable` are ambiguous — the owner may or may not have recorded a
decision — so they map to the existing non-terminal `settlement_pending` state, never to
success and never to an automatic retry.

---

## 6. Test results

`test/task3411-settlement-authorization.test.mts` — **11/11**:

```
ok   settle succeeded                                        (approved → signer once)
ok   settle refused (rejected)  ×3
ok   settle refused (unknown)          → settlement_pending, nonTerminal
ok   settle refused (owner_unavailable) → settlement_pending, nonTerminal
ok   settle refused (protocol_error)
ok   settle refused                      (client threw)
ok   first settle succeeded
ok   second settle is idempotent, not a new signature
ok   settle refused                      (durable gate refusal)
task34.11: 11/11 passed, 0 failed
```

Assertions include exact call counts on a wrapping signer:

- approved → `addSponsorSignature === 1`, `submitTransaction === 1`
- every non-approved outcome → `addSponsorSignature === 0`, `submitTransaction === 0`

Additional verified properties:

- Energy exposure is derived and `>= 394n` (formula floor).
- The authorization request binds digest (64 chars), network, sender, sponsor, recipient,
  asset, amount, version.
- A rejected authorization leaves the payment `rejected` with **zero** `approved` sign events.

---

## 7. Regression

| Suite | Result |
|---|---|
| `task25-facilitator` | 36/36 |
| `task26-settlement-durability` | 32/32 |
| `task27-multiprocess-settlement` | 16/16 |
| `task29-prebroadcast` | 65/65 |
| `task29-crashboundaries` | 21/21 |
| `task29.1-postsubmit-crash` | 49/49 |
| `task342-atomic-authorization` | 22/22 |
| `task344-authorization-audit-remediation` | 23/23 |
| `task346-process-boundary` | 12/12 |
| `task348-ipc-protocol` | 42/42 |
| `task349-transaction-crash` | 15/15 |
| `task3411-settlement-authorization` | 11/11 |
| **Full suite** | **1757/1757 across 39 suites, 0 failures** |
| Facilitator typecheck | clean |
| Gateway typecheck | clean |

No test was weakened, skipped, or deleted.

---

## 8. Files changed / added

**Added**
- `services/facilitator/src/authorization.ts`
- `services/facilitator/src/energy.ts`
- `test/task3411-settlement-authorization.test.mts`
- `docs/archive/TASK34.11-settlement-authorization-integration.md`

**Changed**
- `services/facilitator/src/core.ts` — `AuthorizationClient` option, constructor wiring,
  authorization call in `settle()`.
- `services/facilitator/src/config.ts` — `authorizationSocket` field + env parsing.
- `services/facilitator/src/server.ts` — `IpcAuthorizationClient` when a socket is configured.

`repository.ts`, `state.ts`, `narrowSponsor.ts`, `narrowSponsorMock.ts`, and `signer.ts` are
**unchanged**.

---

## 9. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED

- `settle()` calls the authorization boundary after replay claim and before the signer.
- An `approved` outcome reaches the mock signer exactly once.
- Every non-approved outcome (rejected / unknown / owner_unavailable / protocol_error) and a
  throwing client leave `addSponsorSignature` and `submitTransaction` at **zero**.
- A rejected authorization leaves the payment `rejected` with no `approved` sign event.
- Energy exposure derived from the transaction using Concordium's formula.
- Request binds digest, network, sender, sponsor, recipient, asset, amount, version.
- Existing durable submission state machine unchanged; full suite green.
- `IpcAuthorizationClient` never opens the authorization database.

### NOT TESTED

- `IpcAuthorizationClient` against a live Authorization Owner with settlement enabled — it is
  structural only; settlement remains disabled and `DENY_ALL_FACILITATOR` stays on.
- Production full-policy path via IPC (the local client runs the address-free subset only).
- Recovery of a consumed approval (`authorization_already_recorded`) — requires a v2
  verification operation that does not exist.
- Real sponsor signing — no signer exists.

### BLOCKED

- Consumed-approval recovery is blocked on an IPC operation the v1 contract does not provide.
  Documented as a limitation; no approval path was invented.
- `resumable` payments bypass re-authorization by design (they already hold a durable hash,
  which is only obtainable after authorization). Verified indirectly by the existing
  `task29.1` crash-recovery suite, not by a dedicated 34.11 test.

---

## 10. Constraints honoured

No private key access, generation, import, export, or signing · no sponsor provisioning or
account funding · no transaction construction, submission, or broadcast · no faucet, Mainnet,
or live settlement · `DENY_ALL_FACILITATOR` intact · token 1004 and its Agent Card untouched ·
production IPC not activated (`FACILITATOR_AUTHZ_SOCKET` unset by default) · production
database contents and schema untouched · no commit or push · TASK35/TASK36 not started.

## 11. Stop condition

TASK 34.11 complete. The authorization boundary is wired into `settle()`; no settlement path
reaches the signer without an `approved` outcome. Working tree uncommitted. Awaiting
maintainer review.
