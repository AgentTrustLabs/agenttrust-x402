# TASK 43 — Dedicated Sponsor Signing Service (Mock-Only Foundation)

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Mock-only foundation.** No real wallet, no key material, no signing, no submission.

---

## Architecture

```
┌──────────────────────────────┐     IPC (Unix socket)     ┌──────────────────────────────┐
│  Facilitator                 │ ──────────────────────────► │  Sponsor Signing Service     │
│  (UID agentfac)              │  sign(digest) → sig        │  (UID signer, separate)      │
│                              │                            │                              │
│  IpcAccountSigner            │                            │  createSigningService({      │
│  (implements AccountSigner)  │                            │    accountSigner: fake/real  │
│                              │                            │    sponsorAddress             │
│  createSdkSponsorSigner({    │                            │    network                   │
│    accountSigner: ipcSigner  │                            │    allowedUid                │
│  })                          │                            │  })                          │
└──────────────────────────────┘                            └──────────────────────────────┘
```

The facilitator holds **no key material**. It constructs an `IpcAccountSigner` that
implements the SDK's `AccountSigner` interface and delegates `sign(digest)` to the service
over IPC. The service validates the request, signs with its injected signer, and returns
the signature.

---

## IPC Protocol

Versioned signing request/response protocol (`agenttrust-sign v1`):

### Request

```jsonc
{
  "protocolVersion": 1,
  "requestId": "<uuid>",
  "operation": "sign",
  "digest": "<64-char hex (32 bytes)>",
  "sponsor": "<base58check sponsor address>",
  "network": "<CAIP-2>",
  "context": { "sender?", "recipient?", "amount?", "asset?", "expiry?", "energy?" }
}
```

### Response

```jsonc
{
  "protocolVersion": 1,
  "requestId": "<uuid>",
  "outcome": "signed" | "rejected" | "unknown" | "owner_unavailable" | "protocol_error",
  "signature": { "0": { "0": "<hex>" } } | null,
  "reason": "..." | null,
  "detail": "..." | null
}
```

### Validation rules

- Protocol version must be 1.
- Request ID: 1–128 chars.
- Operation: only `sign`.
- Digest: 64-char hex.
- Sponsor, network: non-empty strings.
- Context: optional, bounded to `sender`, `recipient`, `amount`, `asset`, `expiry`, `energy`.
- Forbidden fields: `decision`, `approved`, `outcome`, `reason`, `result`, `signature`.
- Max message: 64 KiB.
- Invalid/missing/oversized/malformed → `protocol_error` with a stable reason.

### What is signed

Only the **32-byte digest** (64 hex chars) is transmitted. The full transaction is never
sent over IPC. The service signs the digest and returns the signature. The facilitator
reconstructs the transaction hash locally.

### Replay protection

Request IDs are tracked in-memory for the process lifecycle. A replayed request returns
the original result without re-signing.

---

## SO_PEERCRED identity rules

- The signing service accepts only the configured facilitator UID.
- `peerCredOf()` shells out to the C helper (`getsockopt(SO_PEERCRED)`).
- `peer.uid !== allowedUid || peer.uid === 0` → `unauthorized_peer`.
- The facilitator client sends its own UID via SO_PEERCRED (kernel-reported, not caller-claimed).
- **Same-UID and root limitations** apply (documented in TASK34.12).

---

## VERIFIED

### Unit — `test/task43-signing-service.test.mts` — **13/13**

| # | Scenario | Result |
|---|---|---|
| 01 | valid request → signed with fake signature | ✓ |
| 02 | invalid digest → `invalid_digest` | ✓ |
| 03 | wrong sponsor → `wrong_sponsor` | ✓ |
| 04 | wrong network → `wrong_network` | ✓ |
| 05 | unsupported protocol → `unsupported_protocol` | ✓ |
| 06 | missing sponsor → `invalid_sponsor` | ✓ |
| 07 | caller-supplied decision → `forbidden_field` | ✓ |
| 08 | oversized digest → `invalid_digest` | ✓ |
| 09 | replayed request → same result, no re-sign | ✓ |
| 10 | signer throws → `signer_error` | ✓ |
| 11 | unknown operation → `unknown_operation` | ✓ |
| 12 | forbidden field → `forbidden_field` | ✓ |
| 13 | valid request → accepted | ✓ |

### IPC — `test/task43-ipc-signing.test.mts` — **6/6**

```
ok 01. IpcAccountSigner signs through the IPC service
ok 02. wrong sponsor rejected by the service
ok 03. wrong network rejected by the service
ok 04. signer failure propagates as a rejection
ok 05. service unavailable → error (no local fallback)
ok 06. timeout → error
```

### Regression

- Full suite: **2099/2099 · 57 suites · 0 FAIL**
- Facilitator typecheck: PASS
- Gateway typecheck: PASS

---

## NOT TESTED

- Real `AccountSigner` backed by key material (no key material in this task).
- Live IPC with a real signing service process (tested with in-process fake).
- Socket permission enforcement with real OS UIDs (TASK34.8 pattern, not re-run here).
- Replay protection across process restarts (in-memory only, by design).
- Multi-signature accounts (fake returns one signature).

---

## BLOCKED

- **Real signing** — requires a funded Testnet sponsor account + key custody (TASK42).
- **Real signing service deployment** — requires maintainer approval + process isolation
  (TASK34.17/34.18).
- **Real facilitator activation** — `DENY_ALL_FACILITATOR` intact.

---

## Error handling

| Condition | Service response | Client behaviour |
|---|---|---|
| Valid request | `signed` + signature | resolves with signature |
| Wrong sponsor | `rejected` / `wrong_sponsor` | rejects with `wrong_sponsor` |
| Wrong network | `rejected` / `wrong_network` | rejects with `wrong_network` |
| Signer throws | `rejected` / `signer_error` | rejects with `signer_error` |
| Invalid digest | `protocol_error` / `invalid_digest` | rejects with `invalid_digest` |
| Malformed JSON | `protocol_error` / `malformed_request` | rejects with `malformed_request` |
| Forbidden field | `protocol_error` / `forbidden_field` | rejects with `forbidden_field` |
| Oversized message | `protocol_error` / `message_too_large` | rejects with `message_too_large` |
| Service unavailable | n/a (connection refused) | rejects with `signing service unavailable` |
| Timeout | n/a | rejects with `signing service timeout` |
| Request ID mismatch | n/a | rejects with `request ID mismatch` |
| Protocol version mismatch | n/a | rejects with `unsupported protocol version` |

**No local fallback.** `IpcAccountSigner.sign()` rejects on every failure; it never
returns a fake signature or pass-through result.

---

## Real signing prerequisites

1. A dedicated signing service process (UID 1005, `signer` user) per TASK34.6/34.17.
2. An `AccountSigner` constructed from a key held by that service (TASK42).
3. The service socket owned `signer:authclients` with mode 0660.
4. The facilitator's `IpcAccountSigner` configured with the service socket path and
   expected UID.
5. `createSdkSponsorSigner({ accountSigner: ipcSigner })` wired into the facilitator.
6. Maintainer approval + funded Testnet sponsor account.

---

## Limitations

1. **Fake signer only.** `createFakeSigner` returns a deterministic signature; no
   cryptographic signing occurs.
2. **In-memory replay.** Request IDs are tracked for the process lifecycle; a restart
   loses replay state (acceptable — the durable authorization gate is the authority).
3. **No service manager.** The service is started manually (no systemd unit).
4. **`IpcAccountSigner` sends sponsor/network from client config.** The service validates
   them against its own config, so the client cannot influence signing policy — but the
   client must be configured correctly.
5. **No transaction submission.** The service signs only; submission stays in the
   facilitator's durable pipeline.

---

## Files

**New**
- `services/facilitator/src/signingService.ts` — service + IPC client + fake signer
- `test/task43-signing-service.test.mts` — 13 unit tests
- `test/task43-ipc-signing.test.mts` — 6 IPC integration tests
- `docs/archive/TASK43-dedicated-sponsor-signing-service.md`

**Unchanged**
- `sdkSponsorSigner.ts`, `wireConverter.ts`, `senderVerifier.ts`, `core.ts`, `authorization.ts`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
- No schema change
- No UID/GID change
- No commits or pushes

---

## Full suite and typecheck

```
2099/2099 · 57 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

**Stop condition met.** No real signing, no key material, no submission, no settlement.
No further tasks started. Awaiting maintainer review. Do not begin TASK44.