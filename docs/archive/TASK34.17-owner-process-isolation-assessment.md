# TASK 34.17 — Owner Process Isolation Assessment

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Read-only assessment.** No source changes, no service changes, no database writes, no
commits, no deployment, no UID/GID changes.

---

## Executive Verdict

**PASS WITH CONDITIONS (assessment, not implementation).**

The authorization owner process has **partial** OS-level isolation: separate UID (997),
exclusive DB directory (0700), and socket group separation. However, the isolation is
**not enforced by any service manager** — it exists only as an ad-hoc harness convention.
A compromised Gateway or Facilitator running as `ubuntu` (UID 1001) can escalate to root
via NOPASSWD sudo, bypassing every boundary. Same-UID and host-level threats remain
fundamental limitations.

No implementation was performed. The recommended architecture is concrete enough to support
a separate, bounded implementation task.

---

## Current Runtime Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  HOST (ubuntu VPS)                                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Gateway     │  │  Facilitator │  │  Auth Owner      │  │
│  │  (UID 1001)  │  │  (UID 1001)  │  │  (UID 997)     │  │
│  │  node/npm    │  │  npx tsx     │  │  sudo -u authown │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│         │                  │                  │              │
│         │   HTTP/stdio     │   IPC (socket)    │              │
│         └──────────────────┴──────────────────┘              │
│                                                             │
│  Shared: /etc/sudoers (NOPASSWD: ALL for ubuntu)            │
│  No systemd units for any service                           │
│  No container / hypervisor isolation                        │
└─────────────────────────────────────────────────────────────┘
```

- **No systemd units** exist for the gateway, facilitator, or authorization owner
  (`systemctl list-units` returns none; `find /etc/systemd/system -iname '*agenttrust*'`
  returns none).
- **No service manager** restarts or supervises any of these processes.
- The owner is started ad-hoc via `sudo -u authowner ... npx tsx scripts/task348-owner.mts`.
- Process lifecycle is managed manually (kill, restart, socket cleanup).

---

## Verified UID/GID and Filesystem Boundaries

### Process identities (observed)

| Process | UID | GID | Shell | Observed via |
|---|---|---|---|---|
| `ubuntu` (gateway/facilitator host user) | 1001 | 1001 | `/bin/bash` | `id`, `getent passwd` |
| `authowner` (authorization owner) | 997 | 988 | `/usr/sbin/nologin` | `id`, `getent passwd` |
| `authzintruder` (test-only adversarial user) | 995 | 87 | `/usr/sbin/nologin` | `id` |

### Group memberships (observed)

| User | Groups |
|---|---|
| `ubuntu` | ubuntu, adm, cdrom, sudo, dip, lxd, docker, authclients |
| `authowner` | authowner, authclients |
| `authzintruder` | authintruder, authclients |

**Note:** `ubuntu` is in the `sudo` group with `NOPASSWD: ALL`. This means any process
running as `ubuntu` can become root without authentication.

### Filesystem boundaries (observed + probed)

| Path | Owner | Mode | Probe result |
|---|---|---|---|
| DB directory (`ownerdb/`) | `authowner:authowner` | 0700 | ubuntu → EACCES (denied) |
| `auth.db` | `authowner:authowner` | 0644 (inherited umask) | ubuntu → unable to open |
| `auth.db-wal` | `authowner:authowner` | 0644 | ubuntu → EACCES |
| `auth.db-shm` | `authowner:authowner` | 0644 | ubuntu → EACCES |
| Socket base directory | `authowner:authclients` | 0770 | ubuntu → traversable (group) |
| `authz.sock` | `authowner:authclients` | 0660 | ubuntu → connectable (group) |

**Probe evidence (TASK34.12):**
```
ubuntu:        DENIED — sqlite3.OperationalError: unable to open database file
authzintruder: DENIED — OperationalError: unable to open database file
WAL/SHM:       DENIED — PermissionError
raw INSERT:    DENIED — OperationalError: unable to open database file
```

### UID/GID configuration (observed)

- `authowner` has UID 997, primary GID 988, supplementary group `authclients` (1002).
- `authowner` shell is `/usr/sbin/nologin` — no interactive login.
- No home directory access for the facilitator to authowner's files.

---

## IPC Trust Boundary

### Socket authentication

- **SO_PEERCRED** reads the peer's UID/GID/PID from the kernel (not caller-supplied).
  Verified via a C helper (`scripts/task348-peercred.c`) that calls
  `getsockopt(SO_PEERCRED)` on the accepted socket fd.
- UID allowlist: only the configured facilitator UID (1001) is accepted.
- Root (UID 0) is explicitly rejected: `peerUid === 0` → `unauthorized_peer`.
- Group membership alone is NOT sufficient for authorization — the UID must match exactly.

### Protocol validation

- JSONL framing, UTF-8 validation, 64 KiB max.
- Strict field allowlist: `protocolVersion`, `requestId`, `operation`, `paymentDigest`, `context`.
- Forbidden fields: `decision`, `approved`, `outcome`, `reason`, `result`, `authorization`.
- Energy: strict decimal string, no hex/exponent/whitespace.
- Caller-supplied decision fields → `forbidden_field`.

### IPC attack scenarios

| Scenario | Result | Evidence |
|---|---|---|
| Correct Facilitator UID (1001) connects | ACCEPTED | `task348-ipc-protocol.test.mts` |
| Unauthorized UID (995) connects | REJECTED (`unauthorized_peer`) | same |
| Root (UID 0) connects | REJECTED (`unauthorized_peer`) | same |
| Caller sends `decision=approved` | REJECTED (`forbidden_field`) | same |
| Oversized frame (>64 KiB) | REJECTED (`message_too_large`) | same |
| Invalid UTF-8 | REJECTED (`malformed_request`) | same |
| Malformed JSON | REJECTED (`malformed_request`) | same |
| Invalid energy (`1e3`, `0x10`, negative, whitespace) | REJECTED (`invalid_energy`) | same |
| Same request ID + changed payload | `request_id_conflict` | same |
| Owner unavailable | `owner_unavailable` (fail closed) | same |

---

## Process Privilege and Service Controls

### Current state

| Control | Status | Notes |
|---|---|---|
| Dedicated UID for owner | ✅ IMPLEMENTED | `authowner` (997) |
| Dedicated UID for facilitator | ⚠ SHARED | `ubuntu` (1001) — same as gateway host user |
| Separate GID for IPC | ✅ IMPLEMENTED | `authclients` (1002) |
| systemd unit for owner | ❌ NOT IMPLEMENTED | No unit file exists |
| systemd unit for facilitator | ❌ NOT IMPLEMENTED | No unit file exists |
| systemd unit for gateway | ❌ NOT IMPLEMENTED | No unit file exists |
| `NoNewPrivileges` | ❌ NOT IMPLEMENTED | No service manager |
| `ProtectSystem` | ❌ NOT IMPLEMENTED | No service manager |
| `ProtectHome` | ❌ NOT IMPLEMENTED | No service manager |
| `PrivateTmp` | ❌ NOT IMPLEMENTED | No service manager |
| `CapabilityBoundingSet` | ❌ NOT IMPLEMENTED | No service manager |
| `ReadWritePaths` restriction | ❌ NOT IMPLEMENTED | No service manager |
| Restart policy | ❌ NOT IMPLEMENTED | Manual only |
| Process supervision | ❌ NOT IMPLEMENTED | Manual only |

### Critical privilege issue

`ubuntu` (UID 1001) has `NOPASSWD: ALL` in sudoers. Any process running as `ubuntu`
— including the Gateway and Facilitator — can execute `sudo -u root ...` without
authentication. This means:

- The Gateway can read/write any file (including the authorization database).
- The Facilitator can become root and access the owner's files.
- The IPC boundary (SO_PEERCRED) is bypassed because a root-owned process can
  connect to the socket.

**This is the single most significant isolation weakness.** It is not a code defect
but a deployment configuration issue.

---

## Attack Scenarios

### 1. Compromised Gateway process

**Capability:** Full control of the gateway process (UID 1001).

| Attack | Result | Assessment |
|---|---|---|
| Read authorization DB directly | BLOCKED by OS permissions (0700 dir) | But bypassable via sudo (NOPASSWD) |
| Connect to IPC socket | ALLOWED (group membership) | UID must match 1001; if gateway runs as 1001, it is the authorized client |
| Forge an approval via IPC | BLOCKED — owner re-derives policy, caller cannot force `approved` | The gateway can only request; the owner decides |
| Modify owner-controlled files | BLOCKED by OS permissions | Bypassable via sudo |
| Signal/restart the owner | BLOCKED by OS permissions | Bypassable via sudo |

**Verdict:** The IPC protocol is fail-closed against a compromised gateway. However,
the sudo NOPASSWD configuration makes the OS-level boundary trivially bypassable.

### 2. Compromised Facilitator process

**Capability:** Full control of the facilitator process (UID 1001).

| Attack | Result | Assessment |
|---|---|---|
| Read authorization DB directly | BLOCKED by OS permissions (0700 dir) | Bypassable via sudo |
| Connect to IPC socket | ALLOWED (group membership, UID 1001) | Facilitator is the authorized IPC client |
| Forge an approval via IPC | BLOCKED — owner re-derives policy | Same as gateway |
| Bypass authorization in `settle()` | BLOCKED — `authorize()` is called before the signer | No alternate path exists |
| Modify payment state directly | BLOCKED by OS permissions | Bypassable via sudo |

**Verdict:** Same as gateway. The code-level boundary is sound; the deployment-level
boundary (sudo) is weak.

### 3. Unauthorized local UID

**Capability:** A local user (e.g., `authzintruder`, UID 995) that is in the
`authclients` group.

| Attack | Result | Assessment |
|---|---|---|
| Connect to IPC socket | ALLOWED (group membership) | But UID check rejects: `unauthorized_peer` |
| Read authorization DB | BLOCKED (0700 dir) | EACCES |
| Read WAL/SHM | BLOCKED | EACCES |
| Raw SQL insert | BLOCKED (cannot open DB) | EACCES |

**Verdict:** The UID allowlist correctly rejects unauthorized UIDs even when they have
group-level socket access. Verified by TASK34.12 probe.

### 4. Same-UID malicious process

**Capability:** A process running as UID 997 (authowner) or UID 1001 (ubuntu).

| Scenario | Result | Assessment |
|---|---|---|
| Process as UID 1001 connects to socket | ACCEPTED (it IS the authorized client) | The owner cannot distinguish a legitimate facilitator from a malicious process with the same UID |
| Process as UID 997 accesses DB | FULL ACCESS | The owner UID has complete access to its own database |

**Verdict:** Same-UID isolation is **not provided**. This is a fundamental limitation of
UID-based isolation. Mitigation requires different UIDs or container isolation.

### 5. Compromised Authorization Owner

**Capability:** Full control of the owner process (UID 997).

| Attack | Result | Assessment |
|---|---|---|
| Read/write authorization DB | FULL ACCESS | Owner owns the DB |
| Return arbitrary `approved` responses | FULL CONTROL | Owner is the trust root |
| Modify IPC socket | FULL ACCESS | Owner creates the socket |
| Access facilitator/gateway files | BLOCKED (different UID) | Unless via sudo |

**Verdict:** The owner is the trust root. A compromised owner compromises all
authorization decisions. This is by design and documented.

### 6. Root / host administrator

**Capability:** Root access to the host.

| Attack | Result | Assessment |
|---|---|---|
| Read/write any file | FULL ACCESS | Root bypasses all permissions |
| Signal/kill any process | FULL ACCESS | Root can kill the owner |
| Modify service configuration | FULL ACCESS | No service manager to protect |
| Modify sudoers | FULL ACCESS | Can grant any privilege |

**Verdict:** Root and host administrators are **out of scope** for process-level
isolation. This is a fundamental limitation.

### 7. Malformed or replayed IPC client

**Capability:** A local process that can connect to the socket.

| Attack | Result | Assessment |
|---|---|---|
| Replay a previous request | `request_id_conflict` (idempotency) | Durable idempotency record prevents re-execution |
| Send malformed JSON | `malformed_request` | Fail closed |
| Send oversized frame | `message_too_large` | Fail closed |
| Send forbidden fields | `forbidden_field` | Fail closed |
| Send invalid energy | `invalid_energy` | Fail closed |
| Timeout the response | `owner_unavailable` | Fail closed |

**Verdict:** IPC protocol is fail-closed against malformed and replayed input.

### 8. Database corruption or storage failure

| Attack | Result | Assessment |
|---|---|---|
| SQLite corruption | Owner fails to read → `owner_unavailable` | Fail closed |
| Disk full | INSERT fails → `audit_write_failed` | Fail closed |
| WAL/SHM tampering | WAL/SHM are 0644 but in a 0700 dir → unreachable | Blocked by directory permissions |

**Verdict:** Storage failures fail closed. The owner does not silently accept corrupted data.

---

## VERIFIED

- Separate UID for authorization owner (997) vs facilitator/gateway (1001)
- DB directory 0700 — untrusted UIDs cannot traverse
- DB, WAL, SHM inaccessible to ubuntu/authzintruder (EACCES)
- Socket 0660 `authowner:authclients` — group-level connect
- SO_PEERCRED reads kernel-reported UID (not caller-supplied)
- UID allowlist enforced on every connection (root rejected)
- Caller-supplied `decision` fields rejected (`forbidden_field`)
- Malformed/oversized/replayed/incomplete requests fail closed
- Owner unavailable → `owner_unavailable` (fail closed)
- No systemd units exist (verified: `systemctl` + `find /etc/systemd/system`)
- `authowner` shell is `/usr/sbin/nologin` (no interactive login)
- `ubuntu` has `NOPASSWD: ALL` in sudoers (verified: `sudo -l`)
- Migration TASK34.14 safe (legacy rows → NULL → fail closed)
- No source changes made during this assessment

---

## NOT TESTED

- Actual systemd unit deployment (no units exist to test)
- Container/hypervisor isolation (not implemented)
- `NoNewPrivileges`, `ProtectSystem`, `PrivateTmp`, `CapabilityBoundingSet` (no service manager)
- Backup/restore procedures (out of scope)
- Rate limiting / DoS resilience under load (out of scope)
- Host-level compromise scenarios (out of scope by definition)
- Whether `authowner` can be locked down further without breaking the IPC socket group

---

## BLOCKED

- **Root / host administrator** — out of scope; root bypasses all process-level isolation.
- **Compromised owner** — the owner is the trust root; a compromised owner compromises all
  authorization decisions. This is by design.
- **Same-UID isolation** — cannot be provided by UID-based isolation alone.
- **sudo NOPASSWD removal** — requires host-level configuration change; not safe to
  perform during an assessment.

---

## Residual Risks

1. **sudo NOPASSWD: ALL for ubuntu** (HIGH) — any process as `ubuntu` can become root
   and bypass all isolation. This is the single most significant weakness.
2. **No service manager** (HIGH) — processes are manually managed; no restart policy,
   no sandboxing, no supervision.
3. **Shared UID for gateway and facilitator** (MEDIUM) — both run as `ubuntu` (1001);
   a compromised gateway can access facilitator resources.
4. **Same-UID processes** (MEDIUM) — cannot be distinguished by the owner.
5. **Owner is the trust root** (LOW/MEDIUM) — architectural assumption, documented.
6. **No container isolation** (LOW) — all processes share the host kernel.

---

## Recommended Isolation Architecture

### Phase 1 — Immediate (configuration, no code changes)

1. **Remove NOPASSWD from ubuntu's sudoers** or restrict it to specific commands.
   This is the single highest-impact change.
2. **Create systemd units** for all three services with hardening:
   ```ini
   [Service]
   User=authowner
   Group=authowner
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   CapabilityBoundingSet=
   ReadWritePaths=/var/lib/agenttrust /var/run/agenttrust
   Restart=on-failure
   RestartSec=5
   ```
3. **Restrict the facilitator to a dedicated UID** (e.g., `authfac`, UID 1002) instead of
   sharing `ubuntu`'s UID.

### Phase 2 — Medium-term (code changes, separate task)

4. **Socket directory hardening:** change socket dir to `0750 authowner:authclients` (owner
   can write, group can traverse, others denied). Currently `0770`.
5. **DB file mode:** set `umask 0077` in the owner process so DB/WAL/SHM are `0600`.
   Currently `0644` (inherited umask).
6. **Log file isolation:** owner logs should be owned by `authowner`, not world-readable.
7. **Process supervision:** implement a watchdog that restarts the owner on crash.

### Phase 3 — Long-term (architectural)

8. **Container isolation:** run the owner in a separate container or VM with its own
   kernel namespace. This eliminates same-UID and host-level threats.
9. **Key custody:** if a real signer is ever activated, use an HSM or separate signing
   service with its own UID and IPC boundary.
10. **Audit log anchoring:** the audit trail should be anchored to an external system
    (e.g., a remote append-only log) to detect whole-log-plus-checkpoint forgery.

---

## Implementation Preconditions

Before implementing the recommended architecture, the following must be in place:

1. **Maintainer approval** to modify sudoers and create systemd units.
2. **A rollback plan** for service restarts (the owner is currently managed manually).
3. **Testing environment** that mirrors the production UID/GID layout.
4. **No active settlement** — the facilitator is mock-only, so service restarts are safe.
5. **Backup of the authorization database** before any permission changes.

---

## Explicitly Out of Scope

- Source-code changes (this is an assessment, not an implementation)
- Schema or migration changes
- Database writes
- Private-key access or signing
- Transaction construction, submission, or broadcast
- Real facilitator or settlement activation
- Token 1004 or Agent Card modification
- UID/GID, ownership, or permission changes
- Firewall rule changes
- Commit or push
- Signer integration
- TASK35 or TASK36

---

## Summary

The authorization owner has **partial** OS-level isolation: separate UID, exclusive DB
directory, and socket group separation. The IPC protocol is fail-closed. The owner is the
trust root.

The **single most significant weakness** is the `NOPASSWD: ALL` sudoers entry for `ubuntu`,
which allows any process running as the gateway/facilitator host user to become root and
bypass all boundaries. The second weakness is the **absence of a service manager**, which
means no sandboxing, no restart policy, and no supervision.

Neither weakness is a code defect — both are deployment/configuration gaps that can be
addressed without modifying the authorization logic.

**Stop condition met.** No implementation performed. No further tasks started. Awaiting
maintainer review.
