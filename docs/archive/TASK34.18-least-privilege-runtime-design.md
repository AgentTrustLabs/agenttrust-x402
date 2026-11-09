# TASK 34.18 — Least-Privilege Runtime Design & Migration Plan

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**DESIGN ONLY.** No runtime configuration changes, no sudoers changes, no systemd units,
no UID/GID changes, no permission changes, no commits, no deployment.

---

## 1. Executive Verdict

**PASS (design).** A reversible, staged least-privilege architecture is specified. Every
stage has preconditions, an observable result, negative probes, a failure condition, and a
rollback path.

The design **preserves owner UID 997 and GID 988** as required. The Gateway and Facilitator
cannot access the owner database. Only the intended IPC client identity can request
authorization. The owner remains fail-closed when dependencies or clients fail.

**Two hard blockers must be resolved before any implementation:**

1. **Node.js is user-local** (`/home/ubuntu/.local/bin/node`). `ProtectHome=true` would break
   the services. Either move Node to a system path or exclude the Node directory explicitly.
2. **Administrative recovery path** must be tested before any sudoers change. SSH key-only
   auth is confirmed for both `ubuntu` and `root`, so a recovery path exists — but it must be
   exercised, not assumed.

No stage is executed.

---

## 2. TASK34.17 Findings Mapping

| # | TASK34.17 finding | Severity | Addressed in this design |
|---|---|---|---|
| 1 | `ubuntu` has `NOPASSWD: ALL` | HIGH | §7 Least-Privilege Sudo Design |
| 2 | No service manager / supervision | HIGH | §5 Service Architecture |
| 3 | Gateway + Facilitator share UID 1001 | MEDIUM | §8 Facilitator UID Separation |
| 4 | Same-UID processes indistinguishable | MEDIUM | §8 (dedicated UID) + §5 (sandbox) |
| 5 | Owner is the trust root | LOW/MEDIUM | §5 (sandbox limits blast radius) |
| 6 | No container isolation | LOW | §14 Residual Risks (out of scope) |
| 7 | DB/WAL/SHM mode 0644 | LOW | §5.4 (umask 0077) |
| 8 | Socket dir 0770 | LOW | §5.3 (0750) |

---

## 3. Current Runtime Inventory

### 3.1 Host identity (observed)

```
Hostname:  arm-batam-01 (from sudo -l output)
OS:        Oracle Linux 7.0.0-1013-oracle kernel
Node:      v26.7.0 at /home/ubuntu/.local/bin/node
```

### 3.2 Administrative access (observed)

| Item | Value | Source |
|---|---|---|
| SSH port | 22 | `sudo sshd -T` |
| `passwordauthentication` | **no** | `sudo sshd -T` |
| `pubkeyauthentication` | yes | `sudo sshd -T` |
| `permitrootlogin` | **no** | `sudo sshd -T` |
| `ubuntu` authorized_keys | present (2521 bytes) | `ls -la /home/ubuntu/.ssh/` |
| `root` authorized_keys | present (911 bytes) | `sudo ls -la /root/.ssh/` |
| sudo group members | `ubuntu` only | `getent group sudo` |
| sudoers rules | `(ALL : ALL) ALL` + `(ALL) NOPASSWD: ALL` | `sudo -l` |
| `/etc/sudoers.d/` | empty | `ls -la /etc/sudoers.d/` |

**Recovery path:** SSH key-only for `ubuntu` and `root`, both have authorized_keys.
Root login via SSH is disabled (`permitrootlogin no`), so the recovery path is:
- `ubuntu` SSH key → sudo → root.
- **Risk:** if the `ubuntu` key is lost or the account is locked, there is no
  password fallback and no root SSH. Console/VM recovery (Oracle Cloud serial console or
  VNC) is the last resort — **must be verified before any sudoers change.**

### 3.3 Runtime components (observed)

| Component | Runs as | UID | GID | Shell | Supervised |
|---|---|---|---|---|---|
| Gateway | `ubuntu` | 1001 | 1001 | `/bin/bash` | no |
| Facilitator | `ubuntu` | 1001 | 1001 | `/bin/bash` | no |
| Authorization owner | `authowner` | 997 | 988 | `/usr/sbin/nologin` | no |
| `authzintruder` (test) | `authzintruder` | 995 | 87 | `/usr/sbin/nologin` | no |

Group `authclients` (1002): `authowner`, `ubuntu`, `authzintruder`.

### 3.4 Filesystem (observed + probed)

| Path | Owner | Mode | Notes |
|---|---|---|---|
| DB directory | `authowner:authclients` | 0700 | owner-exclusive |
| `auth.db` | `authowner:authowner` | 0644 | umask-inherited |
| `auth.db-wal` | `authowner:authowner` | 0644 | umask-inherited |
| `auth.db-shm` | `authowner:authowner` | 0644 | umask-inherited |
| Socket dir | `authowner:authclients` | 0770 | group traversable |
| `authz.sock` | `authowner:authclients` | 0660 | group connectable |

Probe: `ubuntu` and `authzintruder` both denied on DB open, WAL read, and raw SQL.

### 3.5 Dependencies (observed)

| Dependency | Location | Impact on sandboxing |
|---|---|---|
| Node.js | `/home/ubuntu/.local/bin/node` | **`ProtectHome=true` would break it** |
| npm | `/home/ubuntu/.local/bin/npm` | same |
| tsx | `~/.hermes/hermes-agent/node_modules/.bin/tsx` | same |
| SQLite | `node:sqlite` (built into Node) | no external lib |
| Concordium SDK | none in facilitator (no `dependencies`) | n/a |
| Facilitator runtime files | `/home/ubuntu/projects/agenttrust/services/facilitator/` | requires read access |

**Critical:** the entire toolchain is user-local. `ProtectHome=true` is not viable without
relocating Node or adding explicit read exceptions.

---

## 4. Administrative Access Dependency Analysis

### 4.1 Workflows that genuinely require sudo (observed inference)

| Workflow | Needs sudo? | Evidence |
|---|---|---|
| Hermes agent operations | partially | agent runs as `ubuntu`, uses `sudo` for probes |
| tmux sessions | no | user-space |
| Deployment scripts | yes (currently) | `sudo` used for chown/chmod/kill in tests |
| Package management (`npm i -g`) | no (user-local) | `/home/ubuntu/.local/lib` |
| Systemd service management | yes | requires root |
| SSH key management | no | user-owned |
| File ownership changes | yes | requires root |

### 4.2 Risk of removing broad sudo

**HIGH RISK — operator lockout.** If `ubuntu`'s sudo is removed without a verified recovery
path:

- No password fallback (`passwordauthentication no`)
- No root SSH (`permitrootlogin no`)
- The only recovery is the Oracle Cloud console (serial/VNC) — **unverified**

**Required before any sudoers change:**

1. Verify the Oracle Cloud console is accessible and can mount/rescue the volume.
2. Verify the `ubuntu` SSH key works from a clean session.
3. Verify the `root` authorized_keys can be used via console (if console allows root).
4. Document the exact recovery steps.

### 4.3 Least-privilege alternative

Replace `(ALL) NOPASSWD: ALL` with command-scoped rules:

```
# /etc/sudoers.d/agenttrust  (proposed — NOT applied)
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl status agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl stop agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/kill -TERM -1 -u authowner
```

**Not sufficient:** the tests use `sudo -u authowner`, `sudo chown`, `sudo chmod`,
`sudo -u root`. These would need to be either:
- Restricted to specific commands, or
- Replaced with a deployment script run as root via a single sudo entry.

**Recommendation:** keep a narrow `sudo` for the agenttrust deployment path, and remove
the blanket NOPASSWD. The exact rule set must be derived from the actual commands the
workflow needs — this is a follow-up task, not this design.

---

## 5. Proposed Service Architecture

### 5.1 Service identity matrix (proposal — UIDs preserved)

| Service | User | UID | GID | Supplementary groups |
|---|---|---|---|---|
| Authorization owner | `authowner` | **997 (preserved)** | **988 (preserved)** | `authclients` (1002) |
| Gateway | `agentgw` | 1003 (new) | 1003 (new) | — |
| Facilitator | `agentfac` | 1004 (new) | 1004 (new) | `authclients` (1002) |

**Constraint compliance:** owner UID 997 and GID 988 are preserved. New UIDs/GIDs are
proposals only; they are not created in this task.

### 5.2 Directory layout (proposal)

```
/var/lib/agenttrust/            0755 root:root
/var/lib/agenttrust/auth/       0700 authowner:authowner      (authorization DB)
/var/lib/agenttrust/facilitator/ 0750 agentfac:agentfac       (facilitator runtime)
/var/lib/agenttrust/gateway/    0750 agentgw:agentgw         (gateway runtime)

/var/run/agenttrust/            0755 root:root
/var/run/agenttrust/auth/       0750 authowner:authclients   (IPC socket)
/var/run/agenttrust/facilitator/ 0750 agentfac:agentfac      (facilitator socket, if any)
/var/run/agenttrust/gateway/    0750 agentgw:agentgw         (gateway socket, if any)

/var/log/agenttrust/            0755 root:root
/var/log/agenttrust/auth.log    0640 authowner:authowner
/var/log/agenttrust/facilitator.log 0640 agentfac:agentfac
/var/log/agenttrust/gateway.log 0640 agentgw:agentgw
```

### 5.3 Socket permissions

| Socket | Owner | Group | Mode | Connectable by |
|---|---|---|---|---|
| `authz.sock` | `authowner` | `authclients` | 0660 | `authowner` + `agentfac` (via group) |

**IPC identity validation:** the owner must accept only the Facilitator UID (1004, proposed).
The current harness accepts UID 1001; the production unit must pass the new UID.

### 5.4 Database permissions

| Path | Owner | Mode | Writable by |
|---|---|---|---|
| `/var/lib/agenttrust/auth/` | `authowner` | 0700 | `authowner` only |
| `auth.db` | `authowner` | **0600** (via `UMask=0077`) | `authowner` only |
| `auth.db-wal` | `authowner` | 0600 | `authowner` only |
| `auth.db-shm` | `authowner` | 0600 | `authowner` only |

**Gateway and Facilitator must NOT have direct DB access.** They only reach the owner via
IPC.

### 5.5 Startup ordering

```
agenttrust-auth.service        (no dependencies)
        │
        ▼
agenttrust-facilitator.service  (Requires=agenttrust-auth.service, After=...)
        │
        ▼
agenttrust-gateway.service      (Wants=agenttrust-facilitator.service, After=...)
```

The facilitator must not start before the owner (it needs the IPC socket). The gateway
starts last.

### 5.6 Restart policy

| Service | Restart | RestartSec | Failure behavior |
|---|---|---|---|
| `agenttrust-auth` | `on-failure` | 5s | owner unavailable → facilitator fails closed |
| `agenttrust-facilitator` | `on-failure` | 5s | `settle()` returns `settlement_pending` |
| `agenttrust-gateway` | `on-failure` | 5s | verify returns `INCONCLUSIVE` |

**No `Restart=always`** — a crash loop should be visible, not silently retried.

### 5.7 Shutdown behavior

- `TimeoutStopSec=10`
- `KillSignal=SIGTERM`
- Owner: close socket, close DB cleanly (SQLite WAL checkpoint).
- Facilitator: stop accepting new settle requests, let in-flight complete.

### 5.8 Required writable paths

| Service | Writable paths | Read-only paths |
|---|---|---|
| Owner | `/var/lib/agenttrust/auth`, `/var/run/agenttrust/auth`, `/var/log/agenttrust` | Node, source |
| Facilitator | `/var/lib/agenttrust/facilitator`, `/var/run/agenttrust/facilitator`, `/var/log/agenttrust` | Node, source |
| Gateway | `/var/lib/agenttrust/gateway`, `/var/run/agenttrust/gateway`, `/var/log/agenttrust` | Node, source |

---

## 6. Systemd Sandbox Matrix

| Control | Proposed value | Security benefit | Compatibility risk | Verification method |
|---|---|---|---|---|
| `NoNewPrivileges` | `true` | Prevents privilege escalation via setuid | Low — Node does not need setuid | Start service, verify `/proc/<pid>/status` `NoNewPrivs: 1` |
| `ProtectSystem` | `strict` | Root FS read-only | **MEDIUM** — SQLite temp files, Node cache | Start service, run a settle, check for EROFS |
| `ProtectHome` | **`true` with exception** | Hides `/home` | **HIGH** — Node is in `/home/ubuntu/.local` | Start service; if EACCES, add `BindReadOnlyPaths=/home/ubuntu/.local` or relocate Node |
| `PrivateTmp` | `true` | Isolated `/tmp` | Low — tests use `mkdtempSync` which works | Start service, verify `/tmp` is a tmpfs |
| `PrivateDevices` | `true` | No device access | Low — no devices needed | Start service, verify `/dev` is minimal |
| `CapabilityBoundingSet` | `empty` | No capabilities | Low — no capabilities needed | Start service, verify `CapBnd` is empty |
| `RestrictSUIDSGID` | `true` | No setuid/setgid | Low | Start service, verify no setuid binaries executed |
| `RestrictNamespaces` | `true` | No namespace creation | **MEDIUM** — Node may use namespaces internally | Start service, check for EPERM |
| `RestrictAddressFamilies` | `AF_UNIX AF_INET AF_INET6` | No exotic protocols | **MEDIUM** — Concordium SDK uses gRPC (TCP) | Start service, verify gRPC calls work |
| `ReadWritePaths` | `/var/lib/agenttrust /var/run/agenttrust /var/log/agenttrust` | Limits writes | Low | Start service, attempt write outside → EROFS |
| `UMask` | `0077` | DB/WAL/SHM become 0600 | Low | Start service, `stat` DB files |
| `SystemCallFilter` | `@system-service` | Blocks dangerous syscalls | **HIGH** — Node may use syscalls outside the set | Start service, run full test suite; if failures, add specific syscalls |

**Critical compatibility notes:**

1. **`ProtectHome=true` is the biggest risk.** Node.js lives in `/home/ubuntu/.local/bin`.
   Either:
   - Relocate Node to `/usr/local/bin` (preferred), or
   - Add `BindReadOnlyPaths=/home/ubuntu/.local` (less clean).
2. **`SystemCallFilter=@system-service` may break Node.** Node uses `clone`, `epoll`,
   `io_uring`, and others. Apply only after testing; otherwise use a permissive set.
3. **`RestrictAddressFamilies`** must include `AF_UNIX` (IPC) and `AF_INET`/`AF_INET6`
   (gRPC, HTTP).
4. **`ProtectSystem=strict`** makes `/usr` read-only. Node's cache (`~/.cache`) must be
   excluded or redirected.

**No sandbox control is applied without verification.** Each control has a concrete
verification method listed above.

---

## 7. Least-Privilege Sudo Design

### 7.1 Current state (observed)

```
ubuntu ALL=(ALL) NOPASSWD: ALL
```

### 7.2 Target state (proposal — NOT applied)

```
# /etc/sudoers.d/agenttrust  (proposed)
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl stop agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl status agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/bin/journalctl -u agenttrust-*
ubuntu ALL=(root) NOPASSWD: /usr/local/bin/agenttrust-deploy
```

**`agenttrust-deploy`** would be a root-owned script that performs ownership/permission
changes. The operator runs it with a single sudo entry.

### 7.3 Recovery readiness (must be verified BEFORE applying)

| Check | Method | Status |
|---|---|---|
| Oracle Cloud console accessible | Log in to OCI console, open serial console | **NOT TESTED** |
| `ubuntu` SSH key works | Fresh SSH session from a clean machine | **NOT TESTED** |
| `root` authorized_keys usable | Console root login | **NOT TESTED** |
| Volume can be mounted elsewhere | OCI console → attach volume to another instance | **NOT TESTED** |

**Do not apply §7.2 until all four checks pass.**

### 7.4 Lockout risk

If the `ubuntu` key is lost and the console is inaccessible, the host is unrecoverable
without Oracle support. This is a **fundamental risk of passwordless-only SSH** and is
not solvable by this design.

---

## 8. Facilitator UID Separation Design

### 8.1 Current state

Gateway and Facilitator both run as `ubuntu` (UID 1001). The IPC owner accepts UID 1001.

### 8.2 Target state

| Component | UID | GID | Groups |
|---|---|---|---|
| Facilitator | `agentfac` (1004, proposed) | 1004 | `authclients` (1002) |
| Gateway | `agentgw` (1003, proposed) | 1003 | — |

### 8.3 Required access

| Resource | Facilitator | Gateway |
|---|---|---|
| Authorization DB | **DENIED** | **DENIED** |
| IPC socket | group `authclients` → connectable | n/a |
| Facilitator runtime dir | writable | n/a |
| Gateway runtime dir | n/a | writable |

### 8.4 IPC identity validation change

The owner must accept **only** the Facilitator UID (1004, proposed). The current harness
accepts UID 1001.

**Source-code change required:** the owner's `facilitatorUid` argument must be set to 1004.
The validation logic itself is unchanged (`peerUid !== facilitatorUid → unauthorized_peer`).

**Migration order:**
1. Create `agentfac` user (UID 1004, group `authclients`).
2. Update the owner's configured facilitator UID to 1004.
3. Start the facilitator as `agentfac`.
4. Verify the owner accepts `agentfac` and rejects `ubuntu` (UID 1001).

**Rollback:** revert the owner's UID to 1001, restart the facilitator as `ubuntu`.

### 8.5 Required source-code changes

None for the UID separation itself — the owner reads the UID from its argv. The change is
configuration (systemd `User=` + argv).

**No source-code change is performed in this task.**

---

## 9. Ordered Migration Plan

### Stage 0 — Recovery readiness (no changes)

| Item | Detail |
|---|---|
| Preconditions | None |
| Changes | None — verification only |
| Expected result | All four recovery checks in §7.3 pass |
| Negative probe | Attempt SSH with a bad key → must fail |
| Failure condition | Any recovery check fails → **stop, do not proceed** |
| Rollback | n/a |
| Downtime | None |

### Stage 1 — Least-privilege sudo

| Item | Detail |
|---|---|
| Preconditions | Stage 0 passed |
| Changes | Add `/etc/sudoers.d/agenttrust` with scoped rules; remove `NOPASSWD: ALL` |
| Expected result | `sudo -l` shows only scoped commands |
| Negative probe | `sudo -u root cat /etc/shadow` → must fail |
| Failure condition | `sudo` broken → console recovery → restore `/etc/sudoers` |
| Rollback | `rm /etc/sudoers.d/agenttrust` + restore original sudoers |
| Downtime | None (agent may lose some sudo) |

### Stage 2 — Authorization owner systemd service

| Item | Detail |
|---|---|
| Preconditions | Stage 1 passed; Node relocated or `ProtectHome` exception ready |
| Changes | Create `agenttrust-auth.service` with §5 + §6 sandbox |
| Expected result | `systemctl start agenttrust-auth` → owner listening; `systemctl status` shows `NoNewPrivs: 1` |
| Negative probe | `sudo -u ubuntu python3 -c "open('/var/lib/agenttrust/auth/auth.db')"` → EACCES |
| Failure condition | Owner fails to start → `systemctl status` shows error → rollback |
| Rollback | `systemctl disable --now agenttrust-auth`; restore manual start |
| Downtime | Owner unavailable during cutover (seconds) |

### Stage 3 — Gateway systemd service

| Item | Detail |
|---|---|
| Preconditions | Stage 2 stable |
| Changes | Create `agenttrust-gateway.service` |
| Expected result | Gateway starts, `systemctl status` clean |
| Negative probe | Gateway cannot open owner DB → EACCES |
| Failure condition | Gateway crash-loop → rollback |
| Rollback | `systemctl disable --now agenttrust-gateway` |
| Downtime | Gateway unavailable during cutover |

### Stage 4 — Facilitator dedicated identity

| Item | Detail |
|---|---|
| Preconditions | Stage 3 stable; `agentfac` user created (UID 1004, group `authclients`) |
| Changes | Create `agenttrust-facilitator.service` with `User=agentfac`; update owner UID to 1004 |
| Expected result | Facilitator connects to owner; owner accepts UID 1004 |
| Negative probe | `sudo -u ubuntu <facilitator>` → `unauthorized_peer` |
| Failure condition | Facilitator cannot connect → rollback UID to 1001 |
| Rollback | Revert owner UID; restart facilitator as `ubuntu` |
| Downtime | Facilitator unavailable during cutover |

### Stage 5 — Permission and IPC verification

| Item | Detail |
|---|---|
| Preconditions | Stages 2–4 stable |
| Changes | None — verification only |
| Expected result | All probes in §5.3, §5.4, §6 pass |
| Negative probe | Unauthorized UID → `unauthorized_peer`; DB open → EACCES |
| Failure condition | Any probe fails → rollback the offending stage |
| Rollback | Revert to manual operation |
| Downtime | None |

### Stage 6 — Failure recovery drill

| Item | Detail |
|---|---|
| Preconditions | Stage 5 passed |
| Changes | None — drill only |
| Expected result | Kill owner → facilitator returns `settlement_pending`; restart owner → recovery works |
| Negative probe | Kill owner mid-request → no approval |
| Failure condition | Drill fails → do not declare complete |
| Rollback | n/a |
| Downtime | Brief (drill) |

---

## 10. Rollback and Recovery Plan

### 10.1 Global rollback

Every stage has a `systemctl disable --now <service>` + restore-previous-state path.
The previous state is **manual operation** (as today).

### 10.2 Service failure recovery

| Failure | Detection | Recovery |
|---|---|---|
| Owner crash | `systemctl status` non-zero | `systemctl restart agenttrust-auth` |
| Owner DB corruption | `audit_write_failed` | Restore from backup; manual start |
| Facilitator cannot connect | `owner_unavailable` | Check owner status; restart owner |
| Gateway crash-loop | `systemctl status` | `systemctl stop`; investigate |

### 10.3 Data recovery

- Authorization DB backup: `sqlite3 auth.db ".backup /backup/auth-$(date +%s).db"` (proposed).
- Recovery: stop owner, replace DB, start owner.
- **No backup/restore is performed in this task.**

---

## 11. VERIFIED

- SSH: port 22, key-only, root login disabled (`sudo sshd -T`)
- `ubuntu` and `root` both have authorized_keys
- sudoers: `(ALL : ALL) ALL` + `(ALL) NOPASSWD: ALL` for ubuntu
- `/etc/sudoers.d/` is empty
- No systemd units for any agenttrust service
- Node.js is user-local (`/home/ubuntu/.local/bin/node`) — `ProtectHome` risk confirmed
- Facilitator has no npm dependencies (uses `node:sqlite`)
- Owner UID 997 / GID 988 / shell nologin
- DB dir 0700, socket 0660 `authowner:authclients`
- ubuntu + authzintruder denied on DB, WAL, SHM (probed)
- No source changes made during this design task
- HEAD `4c8994db391d77796e06e49c843c42be1eae615b` unchanged

---

## 12. NOT TESTED

- Oracle Cloud console recovery (Stage 0) — **BLOCKING for Stage 1**
- `ProtectHome=true` with Node in `/home/ubuntu/.local` — compatibility unverified
- `SystemCallFilter=@system-service` with Node.js — compatibility unverified
- `RestrictAddressFamilies` with Concordium gRPC — unverified
- `ProtectSystem=strict` with SQLite temp files — unverified
- systemd unit behavior (no units exist to test)
- Backup/restore procedure (not implemented)

---

## 13. BLOCKED

- **Stage 0 recovery verification** — cannot proceed to Stage 1 without it
- **Node relocation decision** — `ProtectHome` cannot be applied until Node is moved or
  an exception is added
- **Source-code changes for UID 1004** — not performed (design only)
- **Root / host administrator** — out of scope
- **Owner trust root** — architectural, cannot be eliminated by isolation

---

## 14. Residual Risks

1. **Operator lockout** — if sudo is removed and the console is inaccessible, the host is
   unrecoverable. Mitigated by Stage 0 verification.
2. **`ProtectHome` incompatibility** — Node is user-local; `ProtectHome=true` may break
   services. Mitigated by relocation or explicit exception.
3. **`SystemCallFilter` incompatibility** — Node may need syscalls outside
   `@system-service`. Mitigated by testing; do not apply blindly.
4. **Same-UID processes** — still indistinguishable within a UID. Mitigated by dedicated
   UIDs (Stage 4).
5. **Owner is the trust root** — a compromised owner compromises all authorization.
   Architectural; not solvable by isolation.
6. **No container isolation** — all services share the host kernel. Long-term: containers.

---

## 15. Implementation Preconditions

Before any stage is executed:

1. **Stage 0 recovery checks pass** (§7.3).
2. **Node.js relocation decision** made (relocate to `/usr/local/bin` or add
   `BindReadOnlyPaths` exception).
3. **Backup of the authorization DB** verified restorable.
4. **Maintenance window** agreed with the operator (Stages 2–4 have brief downtime).
5. **Rollback scripts** prepared and tested in a staging environment.
6. **Maintainer approval** for each stage.

---

## 16. Explicitly Out of Scope

- Source-code changes (design only)
- Sudoers changes
- systemd unit creation or modification
- UID/GID/user/group changes
- Filesystem permission or ownership changes
- Service restart, stop, or signal
- Firewall or SSH configuration changes
- Database writes or migrations
- Private-key access or signing
- Transaction construction, submission, or broadcast
- Real facilitator activation or settlement
- Token 1004 or Agent Card modification
- Commits, pushes, or GitHub actions
- Signer integration
- TASK35 or TASK36
- Container/hypervisor isolation (long-term, not in this plan)

---

## Summary

The design is **reversible and staged**. Each stage has a concrete rollback path. The two
blockers (recovery verification, Node relocation) must be resolved before Stage 1.

**Stop condition met.** No implementation performed. No further tasks started. Awaiting
maintainer review.
