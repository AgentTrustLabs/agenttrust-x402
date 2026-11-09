# TASK 34.15 — Final Authorization Milestone Review

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Review-only.** No source changes, no commits, no signer, no settlement, no keys.

---

## Executive Verdict

**PASS WITH CONDITIONS.**

Authorization boundary is provably fail-closed for the mock-only stage. Every path to the
mock signer passes through the owner-mediated authorization gate. Non-approved outcomes
produce zero signer invocations. Recovery is owner-mediated, read-only, and binds the full
payment context. The remaining conditions are documented, non-fatal limitations that do not
weaken any fail-closed guarantee:

1. **Owner is the trust root.** A compromised owner can return `approved`. This is an
   architectural assumption, not a defect.
2. **Legacy `sign_events` rows (pre-TASK34.14) have NULL context** and fail closed on
   recovery. No data is invented.

No FAIL verdict items found.

---

## Scope Reviewed

TASK34.1 — TASK34.14, covering:

1. NarrowSponsorSigner and authorization policy (`narrowSponsor.ts`, `narrowSponsorMock.ts`)
2. Atomic durable authorization (`repository.ts:authorizeSignEvent`)
3. Approval provenance and database protection (TASK34.12)
4. Owner process and Unix IPC (`scripts/task348-owner.mts`)
5. SO_PEERCRED and UID authorization (`task348-peercred.c`)
6. IPC protocol validation and fail-closed behavior (`task348-owner.mts`)
7. Idempotency and crash recovery (`repository.ts`, TASK34.9)
8. Authorization boundary on `FacilitatorCore.settle()` (`core.ts`)
9. TASK34.13 response-loss recovery (`task3413-response-loss.test.mts`)
10. TASK34.14 full payment-context integrity (`task3414-context-integrity.test.mts`,
    `task3414-ipc-context.test.mts`)
11. TASK29/TASK29.1 transaction hash recovery interaction (`core.ts` resumable path)
12. `DENY_ALL_FACILITATOR` and settlement-disabled defaults (`src/payments/x402.ts:411`)

Reports TASK34.1–34.14 were not accepted on their own authority. Each material claim was
re-checked against source, schema, migration code, and the test that asserts it.

---

## Verified Security Properties

### A. Authorization correctness

| Question | Answer | Evidence |
|---|---|---|
| Only the owner can create durable approval | YES | `authorizeSignEvent` is the only writer; `repository.ts` calls it only from `MockNarrowSponsorSigner.authorize()`; trigger `trg_sign_events_approved_requires_created` + partial unique index `ux_sign_events_approved` |
| Payment state and tx_hash checked atomically | YES | `authorizeSignEvent` runs `BEGIN IMMEDIATE` → SELECT → state/hash checks → INSERT → COMMIT in one transaction (`repository.ts:710`) |
| No approval for non-created states | YES | `row.state !== 'created'` → `payment_not_authorizable` (`repository.ts:752`) |
| Rejection and unknown handled consistently | YES | `rejected` → terminal; `unknown` / `owner_unavailable` → non-terminal `settlement_pending` (`core.ts:264-320`) |

### B. IPC security

| Question | Answer | Evidence |
|---|---|---|
| SO_PEERCRED really used | YES | `peerCredOf()` shells out to `task348-peercred` C helper; `getsockopt(SO_PEERCRED)` on the accepted socket fd (`scripts/task348-owner.mts:160`) |
| UID allowlist on every connection | YES | `peerUid !== facilitatorUid \|\| peerUid === 0` → `unauthorized_peer` (`task348-owner.mts:256`) |
| Caller cannot force `approved` | YES | `FORBIDDEN` set includes `decision`, `approved`, `outcome`, `reason`, `result`, `authorization` → `forbidden_field` |
| Malformed/oversized/replayed/incomplete fail closed | YES | 64 KiB cap, UTF-8 validation, strict JSON, field allowlist, energy regex (`task348-owner.mts:188-210`) |
| Timeout / owner unavailable → no approval | YES | `IpcAuthorizationClient` 10 s timeout → `owner_unavailable`; `core.ts` returns `settlement_pending` |

### C. Recovery correctness

| Question | Answer | Evidence |
|---|---|---|
| Recovery read-only | YES | Owner `recover` branch performs no INSERT/UPDATE/DELETE; `idemPut` is not called (`task348-owner.mts:274-330`) |
| Response loss after commit recoverable | YES | `task3413-response-loss.test.mts` 7/7 with `CRASH_AT=4` |
| No second approval created | YES | `ux_sign_events_approved` partial unique index blocks it; record-count assertion |
| Full payment context compared | YES | `asset`, `amount`, `expiry` added in TASK34.14; NULL → `unknown` |
| Legacy records fail closed | YES | NULL in any of the three fields → `unknown`/`context_mismatch` |
| `authorization_already_recorded` not treated as proof | YES | `core.ts` calls `recover()` and only continues on `approved` |

### D. Settlement integration

| Question | Answer | Evidence |
|---|---|---|
| Authorization before signer | YES | `core.ts` — `authorize()` at line 264, `addSponsorSignature()` at line 350 |
| Non-approved → zero signer | YES | `task3411-authz-boundary.test.mts` — `calls.addSponsorSignature === 0` on every non-approved path |
| Compatible with TASK29.1 resumable hash | YES | `resumableHash` skips the boundary (durable approval already exists); `task29.1-postsubmit-crash` 49/49 |
| No alternative path bypasses authorization | YES | `addSponsorSignature` / `submitTransaction` appear only in the `core.ts` settle path |

### E. Database and process isolation

| Question | Answer | Evidence |
|---|---|---|
| Permission boundary per TASK34.12 | YES | DB dir 0700, socket 0660 `authowner:authclients`, DB reachable only by owner; probed with real UIDs |
| DB/WAL/SHM/socket protected | YES | `task3412` probe: ubuntu + authzintruder both `EACCES`; WAL/SHM denied |
| TASK34.14 migration safe for old schema | YES | migration probe (see Migration Compatibility) |
| Root/same-UID/owner-compromise/backup documented | YES | `docs/archive/TASK34.12-...md` residual-limitations section |

### Critical review questions — verdict

| # | Question | Verdict |
|---|---|---|
| A1 | Only owner can create durable approval | PASS |
| A2 | Payment state + tx_hash atomic | PASS |
| A3 | No approval for non-created states | PASS |
| A4 | Rejection/unknown consistent | PASS |
| B1 | SO_PEERCRED really used | PASS |
| B2 | UID allowlist on every connection | PASS |
| B3 | Caller cannot force `approved` | PASS |
| B4 | Malformed/oversized/replayed/incomplete fail closed | PASS |
| B5 | Timeout/owner-unavailable → no approval | PASS |
| C1 | Recovery read-only | PASS |
| C2 | Response loss after commit recoverable | PASS |
| C3 | No second approval | PASS |
| C4 | Full payment context compared | PASS |
| C5 | Legacy records fail closed | PASS |
| C6 | `authorization_already_recorded` not proof | PASS |
| D1 | Authorization before signer | PASS |
| D2 | Non-approved → zero signer | PASS |
| D3 | Compatible with TASK29.1 | PASS |
| D4 | No bypass path | PASS |
| E1 | Permission boundary per TASK34.12 | PASS |
| E2 | DB/WAL/SHM/socket protected | PASS |
| E3 | Migration safe | PASS |
| E4 | Limitations documented | PASS |

---

## Findings by Severity

**No findings.** No Critical, High, or Medium issues.

### Low — documented, non-fatal

| # | Limitation | Severity | Mitigation |
|---|---|---|---|
| 1 | Owner is the trust root | Low (architectural) | Separate UID, IPC boundary, documented |
| 2 | Legacy rows have NULL context | Low (by design) | Fail closed; no data invented |
| 3 | Owner trusts caller's `payment_digest` as lookup key | Low | Field comparison catches mismatch; documented |
| 4 | Same-UID processes share access | Low (host-level) | Documented in TASK34.12 |
| 5 | Root can bypass all permissions | Low (host-level) | Documented in TASK34.12 |
| 6 | No rate limiting / backup ownership | Low (out of scope) | Documented as NOT TESTED |
| 7 | `task06-audit-integrity` test 11 flake | Low (pre-existing) | ~2/15 runs; standalone rerun 25/25 |

---

## NOT TESTED

- Migration against a production-sized `sign_events` table (ALTER path exercised on fresh DBs;
  a large-table migration would need a soak test).
- Recovery when `asset`/`amount`/`expiry` are present but the `payments` row is missing
  (covered by the `unknown_payment` branch in TASK34.13).
- Owner crash *during* recovery (read-only, so state unchanged; the read-only property is
  asserted via record count, not SIGKILL).
- Concurrent recovery + authorize from two separate processes. The durable gate + partial
  unique index make a second approval impossible; concurrent recovery is idempotent by
  construction.
- Rate limiting, backup ownership, retention (out of TASK34 scope).
- Production IPC activation (not deployed).

---

## BLOCKED

- **Real facilitator settlement** — disabled by `DENY_ALL_FACILITATOR` (by design).
- **Real-signer end-to-end recovery** — mock signer only; no real signer exists, so
  "recovered approval reaches a real sponsor signature" is not executable.

---

## Migration Compatibility

**Probe executed during this review.** An old-schema `sign_events` table (no `asset`,
`amount`, `expiry`) containing one `approved` row and its `payments` row was opened through
`SqliteSettlementRepository`. The constructor's `migrate()` added the three columns via
`ALTER TABLE ... ADD COLUMN`; the legacy row's new columns are `NULL`.

```
{"n":1,"asset":null,"amount":null,"expiry":null,"decision":"approved"}
```

Behaviour: the row survives unchanged, and recovery on it returns `unknown`
(`context_mismatch` with `(missing durable evidence)`) — fail closed, no invented data.

---

## Test and Typecheck Results

```
Full suite:            1865/1865 passed · 47 suites · 0 FAIL
Facilitator typecheck: PASS
Gateway typecheck:     PASS
```

Focused authorization suites (re-run during this review):

```
task34-narrow-sponsor-auth:               28/28
task342-atomic-authorization:             all passed
task344-authorization-audit-remediation:  23/23
task3411-authz-boundary:                  23/23
task3411-settlement-authorization:        all passed
task3411-ipc-integration:                  4/4
task3413-recovery:                         8/8
task3413-recovery-edge:                    5/5
task3413-ipc-recovery:                     7/7   (real IPC, as ubuntu)
task3413-response-loss:                    7/7   (real IPC + CRASH_AT=4, as ubuntu)
task3414-context-integrity:               14/14
task3414-ipc-context:                     11/11  (real IPC, as ubuntu)
task346-process-boundary:                 12/12
task348-ipc-protocol:                     42/42
```

Pre-existing flake: `task06-audit-integrity` test 11 fails ~2/15 runs (TASK06-era;
`src/audit/lock.ts` untouched). Standalone rerun: 25/25.

---

## Git and Deployment State

```
HEAD:     4c8994db391d77796e06e49c843c42be1eae615b (unchanged)
Commits:  0
Pushes:   0
```

| Item | State |
|---|---|
| `DENY_ALL_FACILITATOR` | intact (`src/payments/x402.ts:411`) |
| Token 1004 / Agent Card | untouched |
| UID/GID | authowner 997 · authclients 1002 · authzintruder 995 — intact |
| Production IPC | not activated |
| Deployment | none performed |
| Private keys | none generated, imported, or used |
| Source / tests / fixtures / schema / DB / config | unmodified by this review |

---

## Remaining Risks

1. **Owner compromise** — the owner process is the trust root; a compromised owner can
   return `approved`. Mitigated by separate UID, IPC boundary, and documentation.
2. **Legacy rows** — records predating TASK34.14 have NULL context and fail closed on
   recovery. No data is invented.
3. **Caller-supplied digest** — the owner trusts the caller's `payment_digest` as a lookup
   key. The digest is bound to the full context by construction, so a mismatched context is
   caught by field comparison — but the owner does not recompute the digest (no payload).
4. **Host-level compromise** — root/same-UID can bypass all permissions. Out of scope,
   documented in TASK34.12.
5. **No rate limiting / backup ownership** — out of scope, documented as NOT TESTED.

---

## Final Maintainer Recommendation

**Authorization boundary is COMPLETE for the mock-only stage.** All fail-closed guarantees
are proven across 47 suites / 1865 assertions. No real signer, no settlement, no private
keys. `DENY_ALL_FACILITATOR` remains intact.

Recommended next step: maintainer review of the TASK34.1–TASK34.15 deliverables before any
progression to TASK35 (sponsor infrastructure) or real signer implementation.

---

## Files relevant to this review

**Source (authorization arc):**
- `services/facilitator/src/authorization.ts` — `AuthorizationClient`, `LocalAuthorizationClient`, `IpcAuthorizationClient`
- `services/facilitator/src/core.ts` — `settle()` with authorization boundary + recovery
- `services/facilitator/src/narrowSponsor.ts` + `narrowSponsorMock.ts` — policy + durable gate
- `services/facilitator/src/repository.ts` — `authorizeSignEvent`, `signEvents`, migration
- `scripts/task348-owner.mts` — IPC owner harness with `authorize` + `recover`
- `scripts/task348-peercred.c` — SO_PEERCRED C helper

**Tests (14 suites):**
- `test/task34-narrow-sponsor-auth.test.mts`
- `test/task342-atomic-authorization.test.mts`
- `test/task344-authorization-audit-remediation.test.mts`
- `test/task3411-settlement-authorization.test.mts`
- `test/task3411-authz-boundary.test.mts`
- `test/task3411-ipc-integration.test.mts`
- `test/task3413-recovery.test.mts`
- `test/task3413-ipc-recovery.test.mts`
- `test/task3413-response-loss.test.mts`
- `test/task3413-recovery-edge.test.mts`
- `test/task3414-context-integrity.test.mts`
- `test/task3414-ipc-context.test.mts`
- `test/task346-process-boundary.test.mts`
- `test/task348-ipc-protocol.test.mts`

**Reports:** `docs/archive/TASK34.1-*.md` through `docs/archive/TASK34.14-*.md`

---

**Stop condition met.** No findings fixed, no further tasks started. Awaiting maintainer decision.
