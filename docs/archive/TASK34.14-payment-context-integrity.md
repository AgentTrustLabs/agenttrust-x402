# TASK 34.14 — Payment Context Integrity During Authorization Recovery

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Minimal schema binding.** Mock signer only. No real signing, key material, or settlement.

---

## VERDICT

**PASS.** `sign_events` now binds the full payment context (`asset`, `amount`, `expiry`) in
addition to the fields already stored. Recovery returns `approved` only when every bound
field matches. A changed amount, asset, expiry, energy, recipient, sponsor, sender, or network
never recovers as `approved`. Legacy rows with NULL context fail closed. No second digest
was introduced; the `payment_digest` remains the single canonical identity.

---

## ROOT CAUSE

`sign_events` stored only `network`, `sender`, `sponsor`, `recipient`, `energy`,
`policy_version`. Recovery compared exactly those. `asset`, `amount`, and `expiry` were
**absent**, so a recovery request carrying a different amount (or asset, or expiry) but the
same caller-supplied `payment_digest` matched on every compared field and returned
`approved`.

The digest (`paymentDigest`) already binds all of these fields through the payload, but the
**owner does not recompute the digest** — it trusts the caller's `payment_digest` to locate
the record. Therefore it must be able to compare the individual fields against durable
evidence.

### Canonical payment identity

`store.paymentDigest(payload)` hashes `{ x402Version, payload }` where `payload` contains:

- `payload.accepted` → `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, `extra`
- `payload.payload.signedTransaction` → `version`, `header.{sender, nonce, expiry, numSignatures, sponsor}`, `payload.{type, toAddress, amount}`

The digest already binds `network`, `asset`, `amount`, `expiry`, `sender`, `recipient`,
`sponsor`, and the transaction shape.

### Why a changed amount could still recover as approved (before the fix)

`sign_events` stored only `network`, `sender`, `sponsor`, `recipient`, `energy`,
`policy_version`. Recovery compared exactly those. `asset`, `amount`, and `expiry` were
**absent**, so a recovery request carrying a different amount (or asset, or expiry) but the
same caller-supplied `payment_digest` matched on every compared field and returned
`approved`.

The digest binds the fields, but the **owner does not recompute the digest** — it trusts the
caller's `payment_digest` to locate the record, so it must be able to compare the fields
against durable evidence.

### Consumers of recovery

- `LocalAuthorizationClient.recover()` — test/mock path, reads the same durable table.
- `IpcAuthorizationClient.recover()` — production path, sends the canonical context to the owner.
- `scripts/task348-owner.mts` `recover` branch — owner-side durable verification.
- `FacilitatorCore.settle()` — only continues to the signer on `approved`.

---

## IMPLEMENTATION

### Schema

`sign_events` gains three nullable columns:

```sql
asset  TEXT,
amount TEXT,
expiry INTEGER
```

`NULL` = a record written before this binding. Recovery treats NULL as *cannot verify* and
fails closed. **No data is invented for legacy rows.**

Migration (`repository.ts`):

```ts
private migrate(): void {
  const columns = this.db.prepare('PRAGMA table_info(sign_events)').all();
  // ALTER TABLE sign_events ADD COLUMN asset TEXT   (only if absent)
  // ALTER TABLE sign_events ADD COLUMN amount TEXT
  // ALTER TABLE sign_events ADD COLUMN expiry INTEGER
}
```

### Writes

`insertSignEvent()` and `insertRejectedSignEvent()` now persist the three fields. Both the
local client and `MockNarrowSponsorSigner` pass them through from the authorization request.

### Recovery verification

Both the local client and the owner compare:

```
payment_digest, network, sender, sponsor, recipient, energy, policy_version,
asset, amount, expiry
```

Any difference → `unknown` / `context_mismatch`. Any NULL → `unknown` / `context_mismatch`
with a `(missing durable evidence)` marker.

### Files changed

| File | Change |
|---|---|
| `services/facilitator/src/repository.ts` | schema columns, migration, `SignEventInput`, `SignEventRow`, `insertSignEvent`, `insertRejectedSignEvent`, `signEvents` SELECT |
| `services/facilitator/src/narrowSponsorMock.ts` | pass `asset`, `amount`, `expiry` to the durable gate |
| `services/facilitator/src/authorization.ts` | local client: pass context on authorize, compare context on recover |
| `scripts/task348-owner.mts` | owner recovery compares the three fields |

**Unchanged:** `paymentDigest`, `state.ts`, `signer.ts`, `DENY_ALL_FACILITATOR`, the durable
submission state machine, TASK29.1 resumable-hash behavior.

---

## VERIFIED

- Every bound field changed → recovery never returns `approved`
- Legacy NULL context fails closed
- Matching context recovers `approved`
- Repeated recovery writes nothing
- Recovery never creates an approval
- Re-authorize still refused by the durable gate
- Real IPC owner + real `SO_PEERCRED`
- Response-loss recovery still works with the binding
- `payment_digest` remains the single canonical identity (no second digest)

### Adversarial verification

#### Unit — `test/task3414-context-integrity.test.mts` — **14/14**

| # | Scenario | Result |
|---|---|---|
| 00 | baseline matching context | `approved` |
| 01 | **amount changed** | not approved |
| 02 | **asset changed** | not approved |
| 03 | **expiry changed** | not approved |
| 04 | energy changed | not approved |
| 05a | recipient changed | not approved |
| 05b | sponsor changed | not approved |
| 06 | sender changed | not approved |
| 07 | network changed | not approved |
| 08 | digest not matching canonical context | `unknown` |
| 09 | legacy record with NULL context | not approved (fail closed) |
| 10 | 5 repeated recoveries, correct context | all `approved`, no records written |
| 12 | 10 recoveries write nothing | record count unchanged |
| 13 | non-approved recovery writes nothing | record count unchanged |

#### Real IPC — `test/task3414-ipc-context.test.mts` — **11/11**

Live owner (uid 997), real `SO_PEERCRED`, real Unix socket:

```
ok 01. authorize returns approved — approved/null
ok 02. matching context recovers approved — approved/null
ok 03. amount changed — unknown/context_mismatch
ok 04. asset changed — rejected/unsupported_asset
ok 05. expiry changed — unknown/context_mismatch
ok 06. energy changed — unknown/context_mismatch
ok 07. sponsor changed — rejected/wrong_sponsor
ok 08. recipient changed — unknown/context_mismatch
ok 09. sender changed — unknown/context_mismatch
ok 10. network changed — rejected/wrong_network
ok 11. re-authorize still refused — rejected/authorization_already_recorded
```

Note: `asset`, `sponsor`, and `network` mismatches are caught by the **policy** first
(`unsupported_asset`, `wrong_sponsor`, `wrong_network`) and return `rejected`; the rest are
caught by the context comparison and return `unknown`. Both are non-approved.

#### Response-loss regression

`test/task3413-response-loss.test.mts` still passes (7/7) with the binding active — the
request now uses a **fixed expiry** so the context is byte-identical across `authorize` and
`recover`. This is the TASK29.1 resumable-hash behavior, unaffected.

### Test results

| Requirement | Covered by |
|---|---|
| amount changed | 01 / 03 |
| asset changed | 02 / 04 |
| expiry changed | 03 / 05 |
| energy changed | 04 / 06 |
| recipient / sponsor changed | 05a,05b / 07,08 |
| sender changed | 06 / 09 |
| network changed | 07 / 10 |
| digest ≠ canonical context | 08 |
| legacy incomplete context | 09 |
| repeated recovery (correct) | 10 |
| response loss after commit | task3413-response-loss |
| recovery writes no approval | 10, 12, 13 |
| no signer/submission on non-approved | 13 + core boundary |
| `DENY_ALL_FACILITATOR` regression | full suite (task25) |

Full suite: **1865/1865 · 47 suites · 0 FAIL** (one pre-existing `task06` flake, see Remaining limitations).

---

## NOT TESTED

- Migration against a production-sized `sign_events` table (the `ALTER TABLE` path is
  exercised on fresh databases; a large-table migration would need a separate soak test).
- Recovery when `asset`/`amount`/`expiry` are present but the `payments` row is missing
  (covered by the `unknown_payment` branch in TASK34.13).
- Owner crash *during* recovery (read-only, so state unchanged; the read-only property is
  asserted via record count, not SIGKILL).
- Concurrent recovery + authorize from two processes. The durable gate + partial unique
  index make a second approval impossible; concurrent recovery is idempotent by construction.

---

## BLOCKED

- Real-signer end-to-end recovery (mock signer only).
- Real facilitator settlement (disabled by `DENY_ALL_FACILITATOR`).

---

## Remaining limitations

1. **Legacy rows cannot be recovered.** A record with NULL context fails closed. This is
   intentional: the owner cannot invent evidence.
2. **The owner trusts the caller's `payment_digest`** as a lookup key. The digest is bound
   to the full context by construction, so a mismatched context is caught by the field
   comparison — but the owner does not recompute the digest (it has no payload).
3. **Owner is the trust root.** A compromised owner can return `approved`.
4. **Same-UID and root limitations** unchanged from TASK34.12.
5. **Pre-existing flake.** `test/task06-audit-integrity.test.mts` test 11 fails ~2/15 runs
   (TASK06-era; `src/audit/lock.ts` untouched). Standalone rerun 25/25.

---

## Test results (final)

```
1865/1865 passed · 47 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

## Files changed

**Changed**
- `services/facilitator/src/repository.ts`
- `services/facilitator/src/narrowSponsorMock.ts`
- `services/facilitator/src/authorization.ts`
- `scripts/task348-owner.mts`

**New**
- `test/task3414-context-integrity.test.mts`
- `test/task3414-ipc-context.test.mts`
- `docs/archive/TASK34.14-payment-context-integrity.md`

**Unchanged:** `paymentDigest` · `state.ts` · `signer.ts` · `DENY_ALL_FACILITATOR` ·
production data
