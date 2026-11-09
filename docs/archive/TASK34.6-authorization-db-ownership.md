# TASK 34.6 — Architecture B: Authorization Database Ownership Boundary

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

## 1. Executive verdict

**PASS WITH CONDITIONS.**

A process-isolated authorization database ownership boundary was demonstrated with **two
separate OS users** (`authowner` UID 997 and the `ubuntu` caller UID 1001, group
`authclients`). The owner process is the sole writer of the database; a non-owner process
cannot even open the file (OS-level `EACCES`), and every authorization decision flows through a
narrow, authenticated IPC interface that the caller cannot use to mint approvals.

The boundary is **not** absolute: it collapses under same-UID access and under root. Those
limitations are documented in §5 and are inherent to filesystem permissions, not to this
implementation.

---

## 2. Architecture assessment

### 2.1 Current ownership

| Component | Opens SQLite? | Write access? |
|---|---|---|
| Gateway (`src/...`) | No | No — `DENY_ALL_FACILITATOR` by default |
| Facilitator (`services/facilitator/src/repository.ts`) | **Yes** — `new DatabaseSync(path)` | **Yes** — direct `INSERT INTO sign_events` |
| Narrow sponsor mock (`narrowSponsorMock.ts`) | Via repository | Via repository |
| Evidence verifier (`concordiumEvidence.ts`) | No | No — read-only gRPC |

Today the facilitator process is both the HTTP handler and the database writer. TASK34.5
proved that a raw SQL writer with the same DB access can forge an approval, because SQLite
triggers cannot distinguish writers.

### 2.2 Can ownership be separated without restructuring?

**Yes, narrowly.** The `SettlementRepository` interface is already the seam. Moving it into a
dedicated process requires:

1. The owner process creates the DB in a private directory (mode 0700, owner-only).
2. The owner exposes a narrow IPC operation: `authorize(paymentDigest, context) → result`.
3. The facilitator becomes an IPC client; it never opens the DB.
4. The gateway stays unchanged (it never touched the DB).

No changes to `FacilitatorCore.settle()` are needed for the boundary itself; the signer
adapter (future task) would call the IPC client instead of the repository directly.

### 2.3 Trust boundaries and threat model

```
┌─────────────────┐     IPC (Unix socket, 0660 owner:group)     ┌─────────────────────┐
│  Facilitator    │  ────────────────────────────────────────►  │  Authorization Owner │
│  (ubuntu UID)   │  { paymentDigest, context }               │  (authowner UID)     │
│  no DB access   │  ◄────────────────────────────────────────  │  owns auth.db (0700) │
└─────────────────┘     { approved, reason }                   └─────────────────────┘
        │                                                                  │
        │  same-UID or root bypasses the filesystem boundary                │
        ▼                                                                  ▼
   direct DB write possible if UID matches or root                        sole DB writer
```

**Threat model:**

- **Compromised facilitator (ubuntu UID):** cannot open the DB (EACCES). Must use IPC.
- **Compromised owner (authowner UID):** full DB access — expected, the owner is trusted.
- **Same-UID attacker (any process as authowner):** full DB access — documented limitation.
- **Root attacker:** full access to everything — documented limitation.
- **IPC impersonation:** mitigated by socket ownership/permissions; a process in the
  `authclients` group can connect but cannot impersonate the owner.

---

## 3. Isolated proof of concept

### 3.1 Components

| File | Role |
|---|---|
| `scripts/task346-owner.mts` | Owner process: creates DB in private dir, listens on Unix socket, evaluates authorization via the repository + mock signer |
| `scripts/task346-caller.mts` | IPC client: sends a JSON request, reads the reply |
| `scripts/task346-rawwriter.mts` | Raw writer probe: attempts `DatabaseSync` open + INSERT |
| `scripts/task346-seed.mts` | Seeds a payment row (owner-only) |
| `scripts/task346-migrate.mts` | Forces an audit-write failure (owner-only) |
| `scripts/task346-same-uid-control.mts` | Demonstrates same-UID access succeeds |
| `test/task346-process-boundary.test.mts` | Orchestrates all 12 adversarial probes |

### 3.2 IPC contract (narrow)

```
Request:  { paymentDigest, network, version, sender, sponsor, recipient, asset, amount, expiry, energy }
          (NO decision field — the caller cannot request an approval)
Response: { approved: true } | { approved: false, reason, detail? }
```

The owner rejects any request that includes a `decision` field (`malformed_request`).

### 3.3 OS-level boundary

```
/tmp/t346-<id>/          0770  authowner:authclients  (shared base)
  ownerdb/               0700  authowner:authclients   (private — DB lives here)
    auth.db              0600  authowner:authowner      (owner-only)
  auth.sock              0660  authowner:authclients   (group can connect)
```

---

## 4. Adversarial verification (12 probes, all passing)

| # | Probe | Result |
|---|---|---|
| 1 | Legitimate IPC authorization (ubuntu → owner) | **approved: true** |
| 2 | Raw writer as owner (authowner) | succeeds (owner can write) |
| 3 | Raw writer as non-owner (ubuntu) | **EACCES** — OS denies open |
| 4 | Non-owner cannot write an approval | 0 approvals inserted |
| 5 | (reserved) | — |
| 6 | Malformed IPC request | `malformed_request` (fail-closed) |
| 7 | Caller supplies `decision=approved` | `malformed_request` (rejected) |
| 8 | Duplicate authorization (same digest, two requests) | first approved, second refused (`authorization_already_recorded`) |
| 9 | Concurrent authorization (two OS processes) | exactly one approval |
| 10 | Owner restart + durable audit recovery | DB survives, no crash |
| 11 | Owner unavailable | caller fails closed (ENOENT) |
| 12 | Audit write failure | `audit_write_failed`, no approval |

### Exact raw-writer output

**Owner (authowner UID 997):**
```json
{"stage":"open","layer":"OK","message":"opened for write"}
{"stage":"insert","layer":"SQL_OR_APP","code":"ERR_SQLITE_ERROR","message":"UNIQUE constraint failed: sign_events.payment_digest"}
{"stage":"verify","approved":1}
```

**Non-owner (ubuntu UID 1001):**
```json
{"stage":"open","layer":"OS_PERMISSION","code":"ERR_SQLITE_ERROR","message":"unable to open database file"}
```

### Same-UID control

Running the raw writer as the owner UID (authowner) succeeds and inserts an approval
(`same-uid-control.mts` → approved rows = 1). This confirms the boundary is **filesystem
ownership**, not an application rule. Same UID → full access.

---

## 5. Security limitations (honest)

| Limitation | Assessment |
|---|---|
| **Same-UID processes** | Any process running as `authowner` has full DB access. The boundary does not protect against a compromised owner process or a same-UID attacker. |
| **Root privileges** | Root bypasses all filesystem permissions. The boundary does not protect against root. |
| **Unix socket ownership** | The socket is 0660 `authowner:authclients`. Any process in the `authclients` group can connect. Connection ≠ authorization; the owner still evaluates every request. |
| **Socket impersonation / stale socket** | A stale socket file left by a crashed owner could be replaced by an attacker. Mitigation: the owner unlinks the socket on startup and creates it fresh; the test verifies this. |
| **Process crashes during authorization** | `BEGIN IMMEDIATE` + rollback on throw ensures no partial audit event. Verified by the audit-write-failure probe. |
| **IPC replay / duplicates** | The repository's `payment_digest` primary key and partial-unique index prevent duplicate approvals. Verified (probe 8). |
| **Database backup / recovery ownership** | Backups must be owned by the owner user and mode 0600. Not implemented; documented as operational requirement. |
| **Single service account deployment** | If the facilitator and owner run as the same OS user, the boundary collapses to application-level only. The boundary is only meaningful with separate UIDs. |

**Do not claim that filesystem permissions protect against a compromised owner process, root,
or another process running with equivalent privileges.** They do not.

---

## 6. Production architecture proposal

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────────────────┐
│   Gateway    │     │   Facilitator    │     │  Authorization / Signer     │
│  (no DB)     │────►│  (IPC client)    │────►│  Owner (exclusive DB)       │
│  DENY_ALL    │     │  no DB writes    │ IPC │  owns auth.db (0700)        │
└──────────────┘     └──────────────────┘     │  sole writer of sign_events │
                                              └─────────────────────────────┘
```

- **Gateway:** no database access. Gates on `DENY_ALL_FACILITATOR` by default.
- **Facilitator:** IPC client only. No direct DB writes. Calls `authorize()` via the socket.
- **Authorization/signer owner:** exclusive DB ownership. The only process that can write
  `sign_events`. Runs as a dedicated, low-privilege OS user.
- **IPC:** narrow authenticated request/response over a Unix socket (0660, owner:group).
  No caller-supplied decision field. The owner independently reads durable state.
- **Database:** private directory (0700), restrictive permissions (0600), controlled backup.
- **Audit:** append-only durable records (`sign_events`, `sign_attempts`, `transitions`).

This preserves the existing keyless gateway design and the TASK26–29.1 durable-state,
replay, and crash-recovery invariants. The signer (future task) would live inside the owner
process, never in the facilitator.

---

## 7. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED (executed, separate OS processes)

- Non-owner (ubuntu, UID 1001) cannot open the owner's DB: `EACCES` (probe 3).
- Non-owner cannot insert an approval: 0 rows (probe 4).
- Owner (authowner, UID 997) can read and write its own DB (probe 2).
- Legitimate IPC authorization succeeds (probe 1).
- Malformed IPC request fails closed (probe 6).
- Caller-supplied `decision` field is rejected (probe 7).
- Duplicate authorization refused (probe 8).
- Cross-process concurrent authorization → exactly one approval (probe 9).
- Owner restart + durable audit recovery (probe 10).
- Owner unavailable → caller fails closed (probe 11).
- Audit write failure → `audit_write_failed`, no approval (probe 12).
- Same-UID raw writer succeeds (documented control, `task346-same-uid-control.mts`).
- Full suite 1621/1621 across 36 suites; both typechecks clean.

### NOT TESTED

- TLS/mTLS over the IPC channel (not applicable — Unix socket, same host).
- A real signer inside the owner process (no key material in this task).
- Backup and recovery procedures (operational, not implemented).
- Process supervision / restart policy (systemd unit, not implemented).

### BLOCKED

- Absolute isolation against root or same-UID processes — **impossible with filesystem
  permissions alone.** Requires a hypervisor or container boundary, which is outside this
  repository's scope.

---

## 8. Deliverables

- `docs/archive/TASK34.6-authorization-db-ownership.md` — this report.
- `scripts/task346-owner.mts` — owner process (DB + Unix socket).
- `scripts/task346-caller.mts` — IPC client.
- `scripts/task346-rawwriter.mts` — raw writer probe.
- `scripts/task346-seed.mts` — payment seeding helper.
- `scripts/task346-migrate.mts` — audit-write-failure helper.
- `scripts/task346-same-uid-control.mts` — same-UID control.
- `test/task346-process-boundary.test.mts` — 12 adversarial probes.

No production source changes. No key material. No signer. No settlement.

---

## 9. Constraints honoured

No private key / wallet / `AccountSigner` / signing · no sponsor account creation, funding,
or provisioning · no transaction construction, submission, broadcast, or faucet · no Mainnet
interaction · no real settlement · `FacilitatorCore.settle()` untouched ·
`DENY_ALL_FACILITATOR` preserved · token 1004 and its Agent Card untouched · no production
data migrated · no commit, push, release, or publish · TASK35.1/TASK36 not started.

## 10. Stop condition

TASK 34.6 complete. Architecture B demonstrated with separate OS processes. The boundary is
effective against different-UID callers and ineffective against same-UID/root (documented
honestly). Awaiting explicit maintainer approval before any production implementation.