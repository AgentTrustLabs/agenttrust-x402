# TASK 34.5 — Database-Level Approval Provenance Verification

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

## 1. Executive verdict

**NOT FULLY CLOSED — documented limitation.**

The TASK34.4 trigger successfully prevents raw SQL approval inserts for payments in any state
other than `created` with `tx_hash IS NULL` (probes 2–4 pass). However, for a payment that **is**
in `created` state with `tx_hash IS NULL`, a raw SQL writer **can** insert an `approved` event
(probe 1, executed, confirmed). This is the remaining gap. SQLite triggers cannot distinguish a
legitimate authorization transaction from a raw SQL transaction; the trigger only sees the
resulting row, not who produced it.

A nonce-based provenance scheme was designed and prototyped. It closes the single-statement
bypass but is itself forgeable by a coordinated two-statement raw SQL transaction (executed
probe: succeeded). It was **not** committed, because it would add complexity without closing
the gap. The TASK34.4 trigger remains the only database-level guard.

**Smallest safe architectural alternative:** move the approval authority into a process that
the raw-SQL writer cannot reach — i.e. architecture B from TASK35 (dedicated signing service
owning the database), or filesystem-level access control on the DB file. The gateway/facilitator
remains keyless; the signer process becomes the sole writer of `sign_events`.

---

## 2. Reproduced gap (executed, not inferred)

Probe 1 — isolated temp DB, real `node:sqlite`, real `SqliteSettlementRepository`:

```
payment state=created tx_hash=NULL
raw INSERT approved (created, NULL hash): approved rows now = 1
  | SQLite ACCEPTED the insert
>>> GAP CONFIRMED: raw SQL created an approval the gate never issued
```

Probe 5 — coordinated raw attack (nonce + approved in one transaction):

```
coordinated raw attack (nonce + approved in one tx): approved rows = 1 — SUCCEEDED
```

The TASK34.4 trigger does fire correctly for invalid states (probes 2–4):

```
raw INSERT approved (prepared):       refused — "approved sign event requires a created payment with NULL tx_hash"
raw INSERT approved (submitting):      refused
raw INSERT approved (outcome_unknown): refused
```

---

## 3. Why SQLite cannot close this

SQLite triggers operate on the **resulting row**, not on the **originating transaction's
identity**. There is no `CURRENT_USER`, no connection ID accessible to triggers, no
row-level security, and no way to distinguish a `BEGIN` issued by the repository from a `BEGIN`
issued by a raw `DatabaseSync`. Any mechanism that relies on a table the repository writes
(nonce, token, flag) can be replicated by the same raw SQL writer in the same transaction,
because the raw writer has the same privileges as the repository.

The attempted nonce design (issue unconsumed nonce → insert approved carrying it → consume
nonce, all in one transaction) raises the cost of a bypass from one statement to two, but
does not prevent it. It was prototyped, probed, shown to be forgeable, and reverted. It is
not committed.

---

## 4. What does close the gap (architectural, not DB-level)

| Approach | Closes the gap? | Cost |
|---|---|---|
| Filesystem permissions on the DB file (single-tenant, facilitator-only process) | Yes — raw SQL requires DB file access, which is already a compromise | Operational, no code |
| Dedicated signer process owning the DB (architecture B, TASK35) | Yes — the facilitator never opens the DB; only the signer writes approvals | ~3–5 days, IPC contract already defined |
| HMAC-seeded nonce verified by the trigger | No — SQLite cannot compute HMAC; the secret would have to be in the DB or a PRAGMA, which a raw writer can read |
| Separate approval table with a different schema | No — same privilege problem |

The smallest effective change is **filesystem-level access control**: the facilitator already
opens its own DB file in single-tenant mode. Ensuring no other process can open it (file
mode 0600, owned by the facilitator user) makes the raw-SQL threat require a process-level
compromise, at which point the attacker already has the sponsor key anyway.

---

## 5. Legitimate authorization path (unchanged, verified)

- `authorizeSignEvent()` still produces exactly one approval for a valid created payment.
- Policy rejection creates only a rejected event.
- A second authorization attempt cannot create another approval (unique partial index).
- Cross-process concurrent authorization: exactly one approval (two OS processes, one DB).
- Audit-write failure remains fail-closed (`audit_write_failed`, no approval).
- Rejection audit survives restart.

All 9 TASK34.5 checks pass, plus the 23 TASK34.4 checks, plus the full suite.

---

## 6. Adversarial test matrix (11 tests)

| # | Scenario | Result |
|---|---|---|
| 1 | Raw SQL approval INSERT for a valid created payment | **ACCEPTED** (recorded gap, INFO) |
| 2 | Raw SQL approval INSERT for prepared | refused (trigger) |
| 3 | Raw SQL approval INSERT for submitting | refused (trigger) |
| 4 | Raw SQL approval INSERT for outcome_unknown | refused (trigger) |
| 5 | Coordinated raw attack (nonce + approved, one tx) | **ACCEPTED** (recorded limitation, INFO) |
| 6 | `authorizeSignEvent()` approves a valid created payment | 1 approved |
| 7 | Policy rejection creates only a rejected event | 1 rejected |
| 8 | Duplicate authorization cannot create a second approval | 1 approved |
| 9 | Cross-process → exactly one approval | 1 approved |
| 10 | Audit write failure → `audit_write_failed`, no approval | fail-closed |
| 11 | Rejection audit survives restart | 1 rejected + 1 approved |

Tests 1 and 5 are recorded evidence, not pass/fail regressions. They are printed as `INFO`
and excluded from the pass/fail count (9/9 pass).

---

## 7. Regression results

| Suite | Result |
|---|---|
| `task34-narrow-sponsor-auth` | 28/28 |
| `task342-atomic-authorization` | 22/22 |
| `task344-authorization-audit-remediation` | 23/23 |
| `task345-approval-provenance` | 9/9 (+ 2 INFO) |
| Full suite | 1597/1597 across 35 suites |
| Facilitator typecheck | clean |
| Gateway typecheck | clean |
| TASK34.3 adversarial probe | 0 findings |

## 8. Attempted remediation (reverted — not committed)

A nonce-based provenance scheme was prototyped and probed, then reverted because it did not
close the gap:

**Design:** `authorization_nonces` table + `authorization_nonce` column on `sign_events` +
trigger requiring an unconsumed nonce for `approved` inserts. The repository issues a nonce,
inserts the approved row carrying it, then consumes the nonce — all in one `BEGIN IMMEDIATE`
transaction.

**Result after prototype — the single-INSERT probe was blocked:**

```
raw INSERT approved (created, NULL hash): approved rows now = 0
  | SQLite said: approved sign event requires an unconsumed authorization nonce
```

**But the coordinated two-statement attack still succeeded:**

```
coordinated raw attack (nonce + approved in one tx): approved rows = 1 — SUCCEEDED
```

The attacker can forge a nonce in the same transaction, because SQLite triggers cannot
distinguish the repository's transaction from a raw one. The prototype was **reverted** — it
added complexity without closing the gap. The TASK34.4 trigger remains the only database-level
guard.

---

## 9. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED (executed against the real SQLite implementation)

- Raw SQL approval INSERT for a valid `created` payment → **ACCEPTED** (probe 1).
- Raw SQL approval INSERT for `prepared` → refused (probe 2).
- Raw SQL approval INSERT for `submitting` → refused (probe 3).
- Raw SQL approval INSERT for `outcome_unknown` → refused (probe 4).
- Coordinated raw attack → **ACCEPTED** (probe 5).
- `authorizeSignEvent()` approves a valid created payment (probe 6).
- Policy rejection creates only a rejected event (probe 7).
- Duplicate authorization cannot create a second approval (probe 8).
- Cross-process concurrent authorization → exactly one approval (probe 9).
- Audit write failure → `audit_write_failed`, no approval (probe 10).
- Rejection audit survives restart (probe 11).
- Full suite 1597/1597; both typechecks clean; HEAD `4c8994d` unchanged.

### NOT TESTED

- Filesystem-level access control as a mitigation (operational, no code).
- Architecture B (dedicated signer process owning the DB) — proposed, not implemented.
- HMAC-seeded nonce at the DB level (SQLite cannot compute HMAC).
- A raw SQL writer that also tampers with `payments` to force `created` state — out of scope;
  the trigger assumes the payment row is authoritative.

### BLOCKED

- Full provenance enforcement at the SQLite layer — **SQLite cannot distinguish a legitimate
  transaction from a raw SQL transaction.** Closing the gap requires an architectural change
  (filesystem access control or architecture B), not a database trigger. Documented as a
  known limitation; no false closure claimed.

---

## 10. Deliverables

- `docs/archive/TASK34.5-database-approval-provenance.md` — this report.
- `test/task345-approval-provenance.test.mts` — 11 probes (9 pass/fail + 2 recorded INFO).
- `scripts/task345-gap-probe.mts` — standalone gap reproduction.
- `scripts/task345-coord-attack.mts` — coordinated-attack reproduction.

No production source changes were committed in this task.

---

## 11. Constraints honoured

Read-only · no signer / `AccountSigner` / private key / wallet / signing · no sponsor account
creation, funding, or provisioning · no transaction construction, submission, broadcast, or
faucet · no Mainnet interaction · no real settlement or facilitator activation ·
`FacilitatorCore.settle()` untouched · `DENY_ALL_FACILITATOR` preserved · token 1004 and its
Agent Card untouched · no commit, push, release, or publish · TASK36 not started.

## 12. Stop condition

TASK 34.5 complete. Gap confirmed and documented with executable evidence. SQLite cannot
enforce provenance against a raw SQL writer with the same DB access. Smallest safe
architectural alternative proposed. Awaiting explicit maintainer approval.
