# TASK 34.13 — Durable Authorization Recovery Semantics

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Recovery only.** Mock signer. No real signing, key material, or settlement.

---

## 1. Problem

TASK34.11 wired authorization into `FacilitatorCore.settle()`. On
`authorization_already_recorded` it **failed closed** because IPC v1 exposed no way to verify
that the recorded approval belonged to *this* payment and context.

The missing case: the owner commits an approval, the response is lost, and the facilitator
must be able to recover the original decision — without creating a second approval and
without trusting the reason code alone.

---

## 2. Design: owner-mediated recovery

The owner already stores the full authorization context on `sign_events`:

```
payment_digest, network, sender, sponsor, recipient, energy, policy_version, decision, reason
```

That is sufficient evidence for recovery. **No schema change, no second database.**

New operation in the IPC contract:

```jsonc
// request
{ "protocolVersion": 1, "requestId": "…", "operation": "recover",
  "paymentDigest": "…", "context": { …same canonical fields as authorize… } }

// response
{ "protocolVersion": 1, "requestId": "…", "outcome": "approved|rejected|unknown|owner_unavailable|protocol_error",
  "reason": "…|null", "detail": "…|null" }
```

**Read-only.** The owner performs no INSERT, UPDATE, or DELETE during recovery.

### Outcome derivation

| Condition | Outcome | Reason |
|---|---|---|
| exactly one approved event, all context fields match | `approved` | `null` |
| no payment row | `unknown` | `unknown_payment` |
| no approved, ≥1 rejected | `rejected` | the recorded reason |
| no approved, no rejected, policy conclusively rejects | `rejected` | `wrong_network` / `wrong_sponsor` / `sponsor_is_sender` / `sponsor_is_recipient` / `energy_negative` / `energy_exceeds_cap` / `expired` / `expiry_excessive` |
| no records, policy inconclusive | `unknown` | `no_durable_decision` |
| >1 approved event | `unknown` | `conflicting_evidence` |
| approved event but any context field differs | `unknown` | `context_mismatch` |

Context fields compared: `payment_digest`, `network`, `sender`, `sponsor`, `recipient`,
`energy`, `policy_version`.

**The caller's approval claim is never read.** Recovery is derived from the owner's own
durable records and the owner's own policy.

---

## 3. Call graph — before / after

```
BEFORE (TASK34.11)
  authorize() ─ approved ────────────────► signer
             └ authorization_already_recorded ─► FAIL CLOSED

AFTER (TASK34.13)
  authorize() ─ approved ────────────────► signer
             └ authorization_already_recorded
                   └─ recover() ─ approved (owner verified) ─► signer
                                 └ anything else ─► FAIL CLOSED
```

`core.ts` — new branch, still **before** the signer:

```ts
if (auth.reason === 'authorization_already_recorded') {
  const recovered = await this.authorization.recover(authRequest);
  if (recovered.outcome !== 'approved') { /* fail closed */ }
  // only a verified matching approval reaches the signer
}
```

---

## 4. Tests

### 4.1 Unit / local-client suite — `test/task3413-recovery.test.mts` — **8/8**

| # | Scenario | Result |
|---|---|---|
| 01 | matching approval recovers | `approved` |
| 02 | no durable decision | `unknown` / `no_durable_decision` |
| 03 ×4 | sponsor / recipient / sender / network mismatch | **not approved** |
| 03b | energy mismatch | **not approved** |
| 04 | different payment digest | `unknown` |
| 05 | durable rejection | `rejected` |
| 06 | repeated recovery | record count unchanged, still 1 |
| 07 | settlement recovers exactly once | signer called **1×** |
| 08 | no record, policy inconclusive | `unknown` |

### 4.2 Real IPC suite — `test/task3413-ipc-recovery.test.mts` — **7/7**

Live owner (uid 997), real `SO_PEERCRED`, real Unix socket:

```
ok 01. authorize returns approved — approved/null
ok 02. recovery returns approved — approved/null
ok 03. mismatched sponsor is not approved — rejected/wrong_sponsor
ok 04. mismatched energy is not approved — unknown/context_mismatch
ok 05. unknown payment → unknown — unknown/unknown_payment
ok 06. repeated recovery stays approved — approved
ok 07. re-authorize is refused (no second approval) — rejected/authorization_already_recorded
```

Run requirement (documented in the file): the connecting process must be uid 1001 **and**
hold the `authclients` group, because the socket grants connect permission to that group.

```
sudo -u ubuntu npx tsx test/task3413-ipc-recovery.test.mts
```

A bare `npx tsx` under the interactive login lacks the supplementary group and the suite
**skips** rather than reporting a false failure.

---

## 5. Durable behavior

- **Recovery writes nothing.** Test 06 asserts the `sign_events` count is unchanged after
  repeated recovery (still exactly 1).
- **Re-authorize after recovery is refused** by the durable gate
  (`authorization_already_recorded`) — no second approval can be created.
- **Crash safety unchanged.** Recovery reads only committed rows. A crash during recovery
  leaves state untouched; the owner restarts and answers from durable records.

---

## 6. Failure semantics

| Case | Facilitator behavior | Payment state |
|---|---|---|
| `approved` (verified match) | continue to signer | unchanged |
| `rejected` | stop, no signer | `rejected` |
| `unknown` | stop, no signer | unchanged (non-terminal) |
| `owner_unavailable` | stop, no signer | unchanged (non-terminal) |
| `protocol_error` | stop, no signer | `rejected` |

Non-terminal outcomes return `settlement_pending` + `extra.nonTerminal:true`, so an operator
can reconcile — **never an automatic retry**.

---

## 7. Full suite

```
1827/1827 passed · 43 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

**Known pre-existing flake.** `test/task06-audit-integrity.test.mts` test 11 fails roughly
2 runs in 15 (documented since TASK06; `src/audit/lock.ts` untouched). When it flaked during
this task's final run the suite reported 24/25; an immediate standalone rerun gave 25/25.
This is unrelated to the authorization work and was not modified.

---

## 8. VERIFIED / NOT TESTED / BLOCKED

**VERIFIED**
- Matching approval recovered as `approved`
- Mismatched digest / sponsor / recipient / sender / network / energy → not approved
- Durable rejection → `rejected`
- No record → `unknown`
- Repeated recovery creates no record
- Re-authorize cannot create a second approval
- Settlement reaches the signer exactly once after recovery
- Real IPC: authorized peer, real owner, real socket
- Caller-supplied decision is never consulted

**NOT TESTED**
- Owner crash *during* recovery — recovery is read-only, so a crash leaves state unchanged;
  the read-only nature is verified by the record-count assertion rather than by SIGKILL.
- Concurrent recovery + authorize on the same payment from two processes. The durable gate
  (`authorization_already_recorded` + partial unique index) makes a second approval
  impossible; concurrent recovery itself is idempotent by construction.

**BLOCKED**
- Real-signer end-to-end recovery. No real signer exists (mock only), so the "recovered
  approval reaches a real sponsor signature" path is not executable.

---

## 9. Remaining limitations

1. **Non-terminal outcomes require manual reconciliation.** `unknown` and
   `owner_unavailable` leave the payment unchanged. The facilitator never auto-retries.
2. **`authorization_already_recorded` is still not proof.** It is only the *trigger* for a
   recovery request. The owner must independently verify the matching durable approval.
3. **Recovery trusts the owner process.** A compromised owner can return a matching
   `approved` for a payment it approved. That is the documented trust root.
4. **Same-UID and root limitations** unchanged from TASK34.12.
5. **No new database.** The existing `sign_events` table is the recovery evidence; no
   second store was added.

---

## 10. Files

**Changed**
- `services/facilitator/src/authorization.ts` — `recover()` on the interface, local client, IPC client
- `services/facilitator/src/core.ts` — recovery branch in `settle()`
- `scripts/task348-owner.mts` — `recover` operation in the harness owner

**New**
- `test/task3413-recovery.test.mts`
- `test/task3413-ipc-recovery.test.mts`

**Unchanged:** `repository.ts` · `state.ts` · `narrowSponsor*.ts` · `signer.ts` ·
`DENY_ALL_FACILITATOR` · production DB schema
