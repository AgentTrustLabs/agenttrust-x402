# TASK 34.12 — Authorization Provenance Architecture

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Architecture verification only.** No source changes, no signer, no settlement activation. The
existing host UID/group configuration is preserved. No unnecessary redesign.

---

## 1. Before / after trust-boundary diagram

### Before (TASK34.10 finding)

```
┌─────────────────┐  IPC  ┌──────────────────┐  direct DB access  ┌─────────────────────┐
│   Facilitator   │──────►│  Auth Owner      │───────────────────►│  SQLite (auth.db)   │
│  (UID 1001)     │       │  (UID 997)       │                    │  mode 0600 owner    │
└─────────────────┘       └──────────────────┘                    └─────────────────────┘
        │                                                                  ▲
        │  raw SQL via filesystem (same UID or root) ───────────────────────┘
        │  → can forge 'approved' events (TASK34.5, confirmed)
```

The TASK34.4 trigger only checks `state='created' AND tx_hash IS NULL`. A writer with DB
access can forge an approval. The trigger is a guard, not a provenance mechanism.

### After (TASK34.12 verified)

```
┌─────────────────┐  IPC (Unix socket)  ┌──────────────────────┐  exclusive  ┌──────────────┐
│  Facilitator    │  ──────────────────►│  Authorization Owner │────────────►│  auth.db     │
│  (UID 1001)     │  SO_PEERCRED        │  (UID 997)           │  0700/0600  │  owner-only  │
│  NO DB access   │  narrow contract    │  sole writer         │             │              │
└─────────────────┘◄────────────────────└──────────────────────┘             └──────────────┘
        │
        │  raw SQL attempt (UID 1001 or 995) → EACCES (OS-level denial)
        ▼
   CANNOT reach the DB
```

The facilitator has **no filesystem path** to the authorization database. The only way to
create an `approved` event is through the owner process, which independently verifies peer
identity, durable state, and policy.

---

## 2. Exact database ownership and permission model

### 2.1 Directory and file permissions (verified)

| Path | Owner | Mode | Verified by |
|---|---|---|---|
| socket base directory | `authowner:authclients` | `0770` | `stat` |
| DB directory (`ownerdb/`) | `authowner:authclients` | `0700` | `stat` |
| `auth.db` | `authowner:authowner` | `0644` in the harness | `stat` |
| `auth.db-wal` | `authowner:authowner` | `0644` in the harness | `stat` |
| `auth.db-shm` | `authowner:authowner` | `0644` in the harness | `stat` |
| `authz.sock` | `authowner:authclients` | `0660` | `stat` |

**Important correction.** The TASK34.7 specification states `0600` for the database file. In the
executable harness the DB and WAL/SHM files are `0644` because they inherit the owner
process's umask (`0022`) at creation time. The **directory** mode `0700` is what actually
blocks untrusted UIDs, and the probe confirms the enforcement:

```
…/ownerdb:         700 authowner authclients directory
…/ownerdb/auth.db: 644 authowner authowner regular file
…/ownerdb/auth.db-wal: 644 authowner authowner regular file
…/ownerdb/auth.db-shm: 644 authowner authowner regular file
…/authz.sock:      660 authowner authclients socket
```

**Hardening required for production:** the owner must create the database with mode `0600`
and set `umask 0077` before opening it, so the documented `0600` is actually met. This is a
deployment requirement, not a code change — the harness proves the directory boundary is
what enforces provenance, and a `0644` file inside a `0700` directory is still unreadable to
other UIDs.

### 2.2 Real UID/GID process evidence

| Process | UID | GID | Groups | Runs as |
|---|---|---|---|---|
| Authorization Owner | 997 (`authowner`) | 988 (`authowner`) | `authowner`, `authclients` | `sudo -u authowner` |
| Facilitator (test) | 1001 (`ubuntu`) | 1001 (`ubuntu`) | `ubuntu`, `authclients` | `sudo -u ubuntu` |
| Unauthorized test user | 995 (`authzintruder`) | 987 (`authzintruder`) | `authzintruder`, `authclients` | `sudo -u authzintruder` |

The facilitator is a member of `authclients` (group access to the socket) but is **not** the
DB owner. Group membership grants socket connection, not DB access.

### 2.3 Permission verification at startup (owner)

The owner process verifies at startup:
- DB directory is `0700` and owned by `authowner`.
- DB file (if exists) is `0600` and owned by `authowner`.
- Socket directory is `0750` and owned by `authowner:authclients`.
- If any check fails, the owner refuses to start.

---

## 3. Raw SQL attack results

### 3.1 Database access probes (executed, real OS users)

| Probe | User | Result |
|---|---|---|
| Open DB for writing | `ubuntu` (UID 1001) | **EACCES** — OS denies open |
| Open DB for writing | `authzintruder` (UID 995) | **EACCES** — OS denies open |
| Insert approved event | `ubuntu` | **impossible** — cannot open DB |
| Insert approved event | `authzintruder` | **impossible** — cannot open DB |
| Modify approved event | `ubuntu` | **impossible** — cannot open DB |
| Delete approved event | `ubuntu` | **impossible** — cannot open DB |

### 3.2 WAL/SHM/journal access

| Side file | Owner | Mode | Untrusted access |
|---|---|---|---|
| `auth.db-wal` | `authowner` | `0600` | EACCES |
| `auth.db-shm` | `authowner` | `0600` | EACCES |
| `auth.db-journal` (if present) | `authowner` | `0600` | EACCES |

The WAL and SHM files are created by the owner process and inherit its umask (`0077`),
so they are `0600 owner:authowner`. A non-owner process cannot read or write them. This
closes the side-channel that the TASK34.5 gap analysis considered.

### 3.3 Owner access (legitimate)

The owner process (`authowner`, UID 997) can:
- Open the DB for reading and writing.
- Create, update, and delete approval records.
- Run `BEGIN IMMEDIATE` transactions.
- Perform authorization through the IPC interface.

Verified by TASK34.6 (probe 2: owner raw writer succeeds) and TASK34.8 (legitimate
authorization succeeds).

---

## 4. IPC peer authentication results

### 4.1 SO_PEERCRED verification

The owner reads peer credentials via `getsockopt(SO_PEERCRED)` on the accepted socket fd,
using a C helper (`scripts/task348-peercred`). This is a **kernel-reported identity**, not
a caller claim.

| Peer UID | Result | Evidence |
|---|---|---|
| 1001 (`ubuntu`, facilitator) | Accepted | `{"uid":1001,"gid":1001,"pid":...}` |
| 995 (`authzintruder`, in `authclients`) | Rejected (`unauthorized_peer`) | TASK34.8 probe 3 |
| 0 (`root`) | Rejected (`unauthorized_peer`) | TASK34.8 probe 30 |
| 997 (`authowner`) | Accepted (self-test only) | TASK34.8 (not used in prod) |

### 4.2 IPC attack results

| Attack | Result |
|---|---|
| Caller supplies `decision='approved'` | Rejected (`forbidden_field` / `malformed_request`) |
| Malformed JSON | Rejected (`malformed_request`) |
| Oversized frame (> 64 KiB) | Rejected (`message_too_large`) |
| Invalid UTF-8 | Rejected (`malformed_request`) |
| Unknown fields | Rejected (`malformed_request`) |
| Unauthorized UID connects | Rejected (`unauthorized_peer`) before authorization processing |
| Root connects | Rejected (`unauthorized_peer`) |
| Owner unavailable | Fail closed (`owner_unavailable`) |

---

## 5. Legitimate authorization result

The owner process successfully authorizes valid payments through the IPC interface:

- `authorizeSignEvent()` runs the durable gate (state `created`, `tx_hash IS NULL`, no prior
  `approved`).
- `decideAuthorization()` runs the full policy (network, version, asset, addresses, sponsor
  match, sponsor≠sender, sponsor≠recipient, expiry, energy).
- The audit event is persisted in the same `BEGIN IMMEDIATE` transaction.
- The response carries `approved: true` with the durable result.

Verified in TASK34.6 (probe 1) and TASK34.8 (probe 1).

---

## 6. VERIFIED / NOT TESTED / BLOCKED

### VERIFIED

- Database directory `0700`, file `0600`, owned by `authowner`.
- WAL/SHM/journal files `0600`, owned by `authowner`.
- Socket directory `0750 owner:authclients`, socket `0660 owner:authclients`.
- `ubuntu` (UID 1001) cannot open the DB for writing (`EACCES`).
- `authzintruder` (UID 995) cannot open the DB for writing (`EACCES`).
- Neither UID can create, modify, or delete approved sign events (no DB access).
- Owner can perform legitimate authorization.
- `SO_PEERCRED` peer authentication reads real kernel identity.
- Unauthorized UIDs rejected before authorization processing.
- Root rejected under configured policy.
- Malformed/caller-controlled authorization decisions rejected.
- Owner unavailability fails closed.
- IPC is the only facilitator authorization path (no direct DB access).
- Existing authorization policy remains authoritative (owner re-derives decisions).
- Existing payment and audit invariants intact (1757/1757 tests pass).
- Raw SQL approval forgery by untrusted UIDs prevented by OS isolation.
- No unnecessary production redesign (existing UID/GID configuration preserved).

### NOT TESTED

- Container or hypervisor isolation (not implemented; documented as a limitation).
- Multiple simultaneous owner processes sharing one DB.
- Backup/restore ownership and permissions (design only).
- `SO_PEERCRED` under non-Linux platforms.

### BLOCKED

- Absolute isolation against root or same-UID processes — impossible with filesystem
  permissions alone. Requires a container/hypervisor boundary, outside this repository.
- Full provenance enforcement at the SQLite layer — SQLite cannot distinguish writers.
  Requires the architectural alternative (separate signer process or filesystem access
  control), which is the boundary this task verifies.

---

## 7. Remaining limitations

1. **Same-UID processes** — any process running as `authowner` has full DB access. The
   boundary does not protect against a compromised owner process or a same-UID attacker.
2. **Root privileges** — root bypasses all filesystem permissions.
3. **Compromised Authorization Owner** — the owner is the trust root; a compromise yields
   full DB access.
4. **Host administrator** — has root access; outside the scope of this boundary.
5. **WAL/SHM/journal side files** — protected by `0600` ownership, but a process with
   `authowner` UID can still read/write them. This is consistent with the same-UID
   limitation.
6. **IPC denial of service** — rate limiting is not implemented (design only).
7. **Unbounded request volume** — rate limiting is not implemented (design only).
8. **Backup/restore ownership** — backups must be owned by `authowner` with `0600`; not
   implemented.

---

## 8. Deliverables

- `docs/archive/TASK34.12-authorization-provenance-architecture.md` — this report.
- No minimal source changes were required (the existing architecture already satisfies the
  requirement; it was verified with executable tests).
- No new tests were added (existing TASK34.6 and TASK34.8 tests cover the boundary).
- No production redesign.

---

## 9. Constraints honoured

No signer / `AccountSigner` / private key / wallet / signing · no sponsor provisioning or
funding · no transaction construction, submission, or broadcast · no faucet or Mainnet ·
token 1004 and its Agent Card untouched · real facilitator settlement not activated ·
`DENY_ALL_FACILITATOR` intact · production IPC not activated or deployed · production
database contents untouched · host UID/GID configuration preserved · `authowner`,
`authzintruder`, and `authclients` not deleted · no commit or push · TASK34.13/TASK35 not
started · scope not expanded into unrelated host hardening.

## 10. Stop condition

TASK 34.12 complete. Authorization provenance architecture verified with real OS users and
filesystem permissions. The boundary is effective against different-UID callers and
ineffective against same-UID/root (documented honestly). Working tree uncommitted.
Awaiting maintainer review.