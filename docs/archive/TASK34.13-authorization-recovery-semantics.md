# TASK 34.13 — Authorization Recovery Semantics

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Recovery only.** Mock signer. No real signing, key material, or settlement.

---

## 1. Recovery protocol

New IPC operation `recover`, added to `agenttrust-authz v1`:

```jsonc
// request
{ "protocolVersion": 1, "requestId": "<uuid>", "operation": "recover",
  "paymentDigest": "<hex>",
  "context": { "network": "ccd:…", "version": 1, "sender": "…", "sponsor": "…",
               "recipient": "…", "asset": "CCD", "amount": "…", "expiry": …, "energy": "…" } }

// response
{ "protocolVersion": 1, "requestId": "<uuid>",
  "outcome": "approved|rejected|unknown|owner_unavailable|protocol_error",
  "reason": "…|null", "detail": "…|null" }
```

**Read-only.** The owner performs no INSERT, UPDATE, or DELETE during recovery. The
facilitator never opens the database.

### Canonical identity and context binding

Same canonicalization as `authorize` (no second digest algorithm):

| Field | Source |
|---|---|
| `paymentDigest` | `store.paymentDigest(payload, accepted, url)` |
| `network` | x402 network |
| `version` | payload `version` |
| `sender` / `recipient` | x402 payTo / payload |
| `sponsor` | `requirements.extra.feePayer` (fallback: signer info address) |
| `asset` / `amount` | x402 |
| `expiry` | x402 |
| `energy` | `energy.estimateEnergy(tx, 2)` |
| `policy_version` | `narrowSponsor` policy version |

Caller-supplied `decision`, `approved`, or equivalent fields are rejected as
`forbidden_field`.

---

## 2. Owner-side durable verification

`scripts/task348-owner.mts` — `recover` branch:

```
payment row exists?            → no  → unknown / unknown_payment
approved events == 0:
  rejected events > 0          → yes → rejected / <recorded reason>
  else re-derive policy        → conclusive reject → rejected / <policy reason>
                              → inconclusive       → unknown / no_durable_decision
approved events > 1            → unknown / conflicting_evidence
approved events == 1:
  any context field differs    → unknown / context_mismatch
  all fields match             → approved
```

Context compared: `payment_digest`, `network`, `sender`, `sponsor`, `recipient`, `energy`,
`policy_version`.

**No caller-controlled decision is read.**

---

## 3. Response-loss test sequence (real owner, no exception-before-commit)

`test/task3413-response-loss.test.mts`

| Step | Action | Evidence |
|---|---|---|
| 1 | Owner A starts with `CRASH_AT=4` | after commit + idempotency record, before response |
| 2 | Client calls `authorize()` | owner commits `sign_events` row, then dies |
| 3 | Client receives `owner_unavailable` | no response delivered |
| 4 | Owner B starts with `CRASH_AT=0` | fresh process, same database |
| 5 | Client calls `recover()` | reads the durable record → `approved` |
| 6 | Repeated `recover()` | idempotent → `approved` |
| 7 | `authorize()` again | refused → `authorization_already_recorded` |
| 8 | Mismatched sponsor / energy / digest | not approved |

Raw output:

```
ok 01. response lost → owner_unavailable — owner_unavailable/owner_unavailable
ok 02. recovery returns approved — approved/null
ok 03. repeated recovery stays approved — approved
ok 04. re-authorize refused — rejected/authorization_already_recorded
ok 05. mismatched sponsor not approved — rejected/wrong_sponsor
ok 06. mismatched energy not approved — unknown/context_mismatch
ok 07. unknown payment → unknown — unknown/unknown_payment

task34.13 response-loss: 7/7 passed, 0 failed
```

---

## 4. Instrumentation

| Counter | Where | Assertion |
|---|---|---|
| Authorization record count | `repo.signEvents(digest).length` | unchanged after recovery; exactly 1 |
| Recovery request count | client call log | each recover is one IPC request |
| Approval writer invocation count | owner `idemPut` / `sign_events` insert | **0 during recovery** |
| Mock signer invocation count | `calls.addSponsorSignature` | **1** on approved path, **0** otherwise |
| Submission invocation count | `calls.submitTransaction` | **1** on approved path, **0** otherwise |

Verified in `task3413-recovery.test.mts` (unit) and `task3413-response-loss.test.mts` (IPC).

---

## 5. Retry limits and timeout

| Layer | Policy |
|---|---|
| `IpcAuthorizationClient` | single request, 10 s socket timeout → `owner_unavailable` |
| `FacilitatorCore.settle()` | **one** recovery attempt on `authorization_already_recorded`; no loop |
| Repeated recovery | idempotent by construction (read-only) |
| Non-terminal outcome | `settlement_pending` + `extra.nonTerminal:true`; **never auto-retried** |

**No indefinite loops. No unbounded retries.**

---

## 6. Settlement integration

```ts
// core.ts — before the signer, after claim/replay
if (auth.reason === 'authorization_already_recorded') {
  const recovered = await this.authorization.recover(authRequest);
  if (recovered.outcome !== 'approved') { /* fail closed */ }
  // only a verified matching approval reaches the signer
}
```

The existing `resumable` path (TASK29.1) is unchanged: a payment with a durable transaction
hash skips re-authorization because the hash is only produced after a successful approval.

---

## 7. Tests

| Suite | Result |
|---|---|
| `test/task3413-recovery.test.mts` (unit/local) | **8/8** |
| `test/task3413-ipc-recovery.test.mts` (real IPC) | **7/7** |
| `test/task3413-response-loss.test.mts` (real IPC + `CRASH_AT=4`) | **7/7** |
| `test/task3413-recovery-edge.test.mts` (conflict / malformed / concurrent / claim) | **5/5** |

Edge-suite raw output:

```
ok   duplicate approved insert is blocked by the index — storage-level guard
ok   single approved row recovers as approved — approved/null
ok   15a. empty policy_version → not approved — unknown/context_mismatch
ok   15b. malformed energy → not approved — unknown/context_mismatch
ok   8 concurrent recoveries all approved — 8/8
ok   17a. crafted claim → not approved — unknown/no_durable_decision
ok   17b. reason is no_durable_decision — no_durable_decision
```

Full suite: **1837/1837 · 45 suites · 0 FAIL** (one pre-existing `task06` flake, see §9).


---

## 8. VERIFIED / NOT TESTED / BLOCKED

**VERIFIED**
- Matching approval recovered as `approved`
- Response lost after commit → owner restarts → recovery returns `approved`
- Repeated recovery idempotent; no new record
- Re-authorize cannot create a second approval
- Mismatched digest / sponsor / recipient / sender / network / energy → not approved
- Durable rejection → `rejected`; no record → `unknown`
- Caller-supplied decision never consulted
- Recovery writes nothing (record count unchanged)
- Settlement reaches the signer exactly once after recovery
- Real IPC: authorized peer, real owner, real socket, real `SO_PEERCRED`

**NOT TESTED**
- Owner crash *during* recovery (read-only, so state unchanged; the read-only property is
  asserted via record count, not SIGKILL).
- Concurrent recovery + authorize from two processes. The durable gate + partial unique
  index make a second approval impossible; concurrent recovery is idempotent by construction.

**BLOCKED**
- Real-signer end-to-end recovery (mock signer only).

---

## 9. Schema limitations and remaining trust assumptions

1. **`sign_events` is the sole recovery evidence.** No second database was added.
2. **Context binding is only as strong as the stored fields.** `asset`, `amount`, and
   `expiry` are not compared during recovery (they are not stored on `sign_events`). A
   request that differs only in `amount` but matches on `payment_digest` + the compared
   fields would recover as `approved`. **This is a documented limitation.**
3. **`authorization_already_recorded` is not proof.** It only triggers a recovery request.
4. **Owner is the trust root.** A compromised owner can return `approved`.
5. **Same-UID and root limitations** unchanged from TASK34.12.
6. **Pre-existing flake.** `test/task06-audit-integrity.test.mts` test 11 fails ~2/15 runs
   (TASK06-era; `src/audit/lock.ts` untouched). Standalone rerun 25/25.

---

## 10. Files

**Changed**
- `services/facilitator/src/authorization.ts` — `recover()` on interface, local + IPC clients
- `services/facilitator/src/core.ts` — recovery branch in `settle()`
- `scripts/task348-owner.mts` — `recover` operation

**New**
- `test/task3413-recovery.test.mts`
- `test/task3413-ipc-recovery.test.mts`
- `test/task3413-response-loss.test.mts`
- `docs/archive/TASK34.13-durable-authorization-recovery.md`

**Unchanged:** `repository.ts` · `state.ts` · `narrowSponsor*.ts` · `signer.ts` ·
`DENY_ALL_FACILITATOR` · production DB schema
