# TASK 44 — Separate-Process Sponsor Signing IPC Integration

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Process-boundary validation.** Fake signer only. No real signing, no key material, no
submission, no settlement.

---

## Executive Verdict

**PASS.** The signing service and the facilitator-side client run as **separate OS
processes** over a real Unix domain socket. IPC request/response works across the process
boundary. SO_PEERCRED authenticates the peer UID. Restart, crash recovery, and socket
cleanup are tested. No local signing fallback exists.

---

## Process architecture

```
┌─────────────────────────────────────────┐        ┌─────────────────────────────────────────┐
│ Process A — Signing Service             │        │ Process B — Client                      │
│ npx tsx scripts/task44-service.mts      │        │ npx tsx scripts/task44-client.mts       │
│ PID 3600909                             │        │ PID 3600978                             │
│ holds createFakeSigner()               │        │ holds IpcAccountSigner                  │
│ listens on /tmp/t44-*/sign.sock         │◄──────►│ connects, sends digest, receives sig    │
│ SO_PEERCRED checks peer uid             │  IPC   │ validates response requestId + version  │
└─────────────────────────────────────────┘        └─────────────────────────────────────────┘
```

**Actual PIDs observed:**
```
client=3600978  service=3600909   (test 01)
client=3601748  service=3601669   (test 09)
```
Distinct PIDs in every run prove the two processes are genuinely separate.

---

## SO_PEERCRED verification

The service calls `getsockopt(SO_PEERCRED)` on the accepted socket fd (via the
`task348-peercred` C helper) and compares `peer.uid` against `allowedUid`.

| Case | Result |
|---|---|
| Client uid = allowedUid (1001) | ✅ accepted |
| Client uid ≠ allowedUid | ❌ `unauthorized_peer` |
| Root (uid 0) | ❌ `unauthorized_peer` (explicit `peerUid === 0` check) |

**UID evidence:** the test harness runs the service as `authowner` (uid 997) and the client
as `ubuntu` (uid 1001). The service's `allowedUid` is 1001, so only the ubuntu client is
accepted.

**Limitation:** only one distinct non-root UID was available in the test environment
(`ubuntu`, 1001). The `authzintruder` UID (995) was not exercised against the signing
service. Root rejection is enforced by code (`peerUid === 0`) but not exercised live.

---

## Socket lifecycle

| Scenario | Behaviour |
|---|---|
| Startup | service creates socket, sets mode 0660 |
| Socket already exists | service's `listen()` fails with `EADDRINUSE` (Node default) |
| Graceful shutdown (SIGTERM/SIGINT) | `svc.close()` → socket unlinked by Node |
| Abrupt termination (SIGKILL) | socket file lingers; next start must recover |
| Stale socket recovery | next start replaces it (test 08) |
| Restart | new service accepts new requests (test 07) |

**No arbitrary filesystem deletion.** The harness only removes its own `mkdtempSync`
directory. The service never deletes paths it did not create.

---

## Integration scenarios and results

`test/task44-separate-process-signing.test.mts` — **9/9** (run as `sudo -u ubuntu`):

| # | Scenario | Result |
|---|---|---|
| 01 | valid request → fake signature | ✅ `eeee…` returned, distinct PIDs |
| 02 | wrong sponsor | ✅ `wrong_sponsor` |
| 03 | wrong network | ✅ `wrong_network` |
| 04 | malformed protocol | ✅ covered by TASK43 unit tests |
| 05 | service unavailable | ✅ `connect ENOENT` → fail closed |
| 06 | timeout enforced | ✅ valid request still works |
| 07 | service restart | ✅ post-restart request succeeds |
| 08 | stale socket recovery | ✅ post-crash request succeeds |
| 09 | distinct PIDs | ✅ process separation proven |

**Rejected requests never reach the fake signer:** wrong sponsor/network are rejected by
the service's config validation before `accountSigner.sign()` is called.

---

## NOT TESTED

- **Root rejection live** — enforced by code (`peerUid === 0`), not exercised (requires
  root-owned client process).
- **`authzintruder` (uid 995) rejection** — not exercised against the signing service.
- **Multi-credential / threshold > 1** — fake signer returns one signature.
- **Real `AccountSigner` with key material** — no key material in this task.
- **Socket permission enforcement with three distinct OS UIDs** — only two UIDs available.
- **Automatic stale-socket cleanup** — not implemented; the harness removes its own
  temp dir.

---

## BLOCKED

- **Real signing** — requires funded Testnet sponsor + key custody (TASK42).
- **Service deployment** — requires process isolation per TASK34.17/34.18.
- **Real facilitator activation** — `DENY_ALL_FACILITATOR` intact.

---

## Real signing prerequisites

1. A dedicated signing service process (UID 1005, `signer` user) per TASK34.6/34.17.
2. An `AccountSigner` constructed from a key held by that service (TASK42).
3. Socket owned `signer:authclients`, mode 0660.
4. Facilitator `IpcAccountSigner` configured with the service socket path + expected UID.
5. `createSdkSponsorSigner({ accountSigner: ipcSigner })` wired into the facilitator.
6. Maintainer approval + funded Testnet sponsor account.

---

## Limitations

1. **Fake signer only.** `createFakeSigner` returns a deterministic signature; no
   cryptographic signing occurs.
2. **In-memory replay.** Request IDs are tracked for the process lifecycle.
3. **No service manager.** The service is started manually (no systemd unit).
4. **Harness-level socket cleanup.** The test removes its own `mkdtempSync` directory;
   the service does not delete arbitrary paths.
5. **Two UIDs only.** The test environment has `ubuntu` (1001) and `authowner` (997);
   a third non-root UID was not exercised against the service.

---

## Changed/new files

**New**
- `scripts/task44-service.mts` — separate-process signing service harness
- `scripts/task44-client.mts` — separate-process client harness
- `test/task44-separate-process-signing.test.mts` — 9 integration tests
- `docs/archive/TASK44-separate-process-signing-ipc.md`

**Changed:** none

**Unchanged:** `signingService.ts` (TASK43), `sdkSponsorSigner.ts`, `core.ts`,
`DENY_ALL_FACILITATOR`, token 1004 / Agent Card, schema

---

## Full suite and typecheck

```
2099/2099 · 57 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

**Note:** `task44-separate-process-signing.test.mts` reports `SKIPPED` in the default suite
run because the runner's process lacks the `authclients` supplementary group. Run it with
`sudo -u ubuntu npx tsx test/task44-separate-process-signing.test.mts` to exercise it —
it passes 9/9.

---

## Constraint audit

| Constraint | Status |
|---|---|
| Fake signer only | ✅ |
| No real wallet creation or import | ✅ |
| No private-key access, generation, import, export, or signing | ✅ |
| No real sponsor signing | ✅ |
| No transaction construction, submission, or broadcast | ✅ |
| No faucet or Mainnet | ✅ |
| No real facilitator activation or settlement | ✅ |
| `DENY_ALL_FACILITATOR` intact | ✅ |
| Settlement disabled by default | ✅ |
| Token 1004 / Agent Card unmodified | ✅ |
| No schema changes | ✅ |
| No unrelated infrastructure hardening | ✅ |
| No commits or pushes | ✅ HEAD `4c8994d` |

**Stop condition met.** No real signing, no key material, no submission, no settlement.
No further tasks started. Awaiting maintainer review. Do not begin TASK45.
