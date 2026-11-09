# TASK 63 — Testnet Facilitator Runtime Readiness

## VERDICT: PASS WITH CONDITIONS

Real-mode facilitator startup, signing-service readiness, Testnet RPC, and V1 pipeline wiring
all verified against the live Testnet and the secured sponsor wallet. One cosmetic production
defect found (misleading startup log line) — reported, not fixed (requires maintainer approval).

## 1. RUNTIME CONFIGURATION

| Setting | Value | Check |
|---|---|---|
| `FACILITATOR_MODE` | `real` | ✅ |
| `FACILITATOR_HOST` | `127.0.0.1` (loopback only) | ✅ |
| `FACILITATOR_PORT` | `0` (ephemeral) | ✅ |
| `FACILITATOR_SPONSOR_ADDRESS` | `3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK` | ✅ matches TASK61 |
| `FACILITATOR_NETWORK` | `ccd:4221332d34e1694168c2a0c0b3fd0f27` | ✅ matches live genesis |
| `FACILITATOR_DB_PATH` | durable file | ✅ |
| `FACILITATOR_NODE_HOST` / `PORT` / `TLS` | `grpc.testnet.concordium.com` / `20000` / `1` | ✅ |
| `FACILITATOR_SENDER_VERIFICATION` | `sdk` | ✅ |
| `FACILITATOR_SIGNING_SERVICE_SOCKET` / `UID` | `/tmp/t63-sign.sock` / `1001` | ✅ consistent with the service process |
| `FACILITATOR_MAX_FEE_MICROCCD` | `10000000` (10 CCD) | ✅ |
| `FACILITATOR_MAX_ENERGY` | `1000` NRG | ✅ consistent (1000 × 8000 = 8 CCD ≤ 10 CCD) |
| `FACILITATOR_EVIDENCE_MODE` | unset (default `none`) | ✅ no untrusted verifier |
| `FACILITATOR_RECONCILE_ENABLED` | unset (`0`) | ✅ `/reconcile` route absent |

Secret values: the sponsor wallet export is never in env; the signing service reads it from
`/home/ubuntu/.agenttrust/sponsor.export` (mode 0600, owner ubuntu). No secret values appear in
this report.

### `DENY_ALL_FACILITATOR`

`src/payments/x402.ts:411` — unchanged, throws on `verify` and `settle`, returns empty `kinds`.
The gateway does not wire a facilitator by default; settlement stays disabled. ✅

## 2. SIGNING SERVICE READINESS

```
service listening pid=... uid=1001 socket=/tmp/t63-sign.sock signer=loaded
socket perm=660 owner=ubuntu:ubuntu
```

- Real wallet signer loaded successfully ✅
- Socket bound, `0660`, owned by the service user ✅
- IPC client connects ✅ (TASK62: 14/14)
- Wrong sponsor refused (`wrong_sponsor`) ✅ (TASK62 test 11)
- No mock fallback: `createSigner()` throws in real mode; `loadConfig` requires socket + UID;
  `startFacilitator` probes reachability at boot ✅
- Service failure → facilitator startup throws `ConfigurationError` → no silent local signing ✅

## 3. TESTNET RPC READINESS

`npx tsx scripts/task58-verify-sponsor-account.mts 3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK`

```
genesis       : 4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796  (testnet match)
account       : EXISTS
balance       : 20000.000000 microCCD (20000 CCD)
nonce         : 1
account threshold : 1
credentials   : 1
  cred 0: threshold=1 keys=1 schemes=[Ed25519]
ready for TASK57 loader : YES
```

All read-only gRPC (`getConsensusStatus`, `getAccountInfo`). ✅

## 4. V1 PIPELINE WIRING

Static inspection (all present, no changes needed):

```
FacilitatorCore.settle
  └─ IpcSponsorSigner.submitTransaction            (server.ts:170 injects `submitter`)
       └─ ConcordiumTransactionSubmitter.submit
            └─ GrpcConcordiumTransport.submit
                 └─ Transaction.signableFromJSON → Transaction.finalize
                      └─ ConcordiumGRPCNodeClient.sendTransaction(Transaction.Finalized)
```

- `server.ts:146-161` constructs `ConcordiumGRPCNodeClient` + `GrpcConcordiumTransport` +
  `ConcordiumTransactionSubmitter` in real mode and injects it into `createIpcSponsorSigner`.
- `server.ts:377` `buildVerifier` grpc case uses `ConcordiumGRPCNodeClient` (TASK55 B4).
- Signing path: `IpcSponsorSigner` → `SdkSponsorSigner` → `IpcAccountSigner` → signing service.
- Verification: `GrpcAccountInfoProvider` + `SdkSenderVerifier` (sdk mode required in real).
- Recovery: `recoverPending()` never calls `submitTransaction` (TASK53 test 13).

**Remaining integration gaps:**

1. **No scheduler.** `recoverPending()` is a method; nothing invokes it on boot. A caller must
   call it explicitly (or via the operator `/reconcile` endpoint, which is disabled by default).
2. **Production secret injection.** The signing service receives the export path as a CLI
   argument. A production deployment should use a secret store or a systemd-tmpfiles mount.
3. **`/reconcile` is disabled** unless `FACILITATOR_RECONCILE_ENABLED=1` + a token digest are set.
   That is intentional (no unauthenticated state mutation).

## 5. STARTUP RESULT

```
facilitator listening on http://127.0.0.1:38025 (mode=real)
GET /healthz   -> {"ok":true,"mode":"real","network":"ccd:4221332d34e1694168c2a0c0b3fd0f27","canSign":true}
GET /supported -> {"kinds":[{"x402Version":2,"scheme":"exact","network":"ccd:4221332d34e1694168c2a0c0b3fd0f27",
                             "extra":{"feePayer":"3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK"}}],
                   "signers":{"ccd:*":["3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK"]}}
POST /reconcile (unauthenticated) -> 404
```

- Binds loopback only (`127.0.0.1`), ephemeral port ✅
- `/healthz` reports `mode=real`, `canSign=true`, correct network ✅
- `/supported` advertises the sponsor address as `feePayer` and signer ✅
- `/reconcile` absent without an operator credential ✅
- No payment requests were accepted or processed ✅

### Defect found (reported, not fixed)

`services/facilitator/src/server.ts:397` prints unconditionally:

```
this is a MOCK: it cannot sign and cannot submit. No chain is contacted.
```

In real mode this is **false** — the facilitator does sign (via the signing service) and the
submitter is wired. This is a stale log line from the mock era and could mislead an operator
during a real-mode incident. It does not affect behaviour (only `console.log`). Recommended
fix: make it conditional on `config.mode === 'mock'`. Requires maintainer approval before
modifying production source.

## VERIFIED

- Real-mode facilitator startup on loopback with ephemeral port.
- `/healthz`, `/supported`, and `/reconcile` (404) behaviour.
- Signing service loads the secured export, binds its socket, refuses wrong sponsor.
- Testnet genesis, sponsor existence, balance 20 000 CCD, nonce 1, thresholds 1/1, Ed25519.
- V1 pipeline wiring statically confirmed.
- `DENY_ALL_FACILITATOR` unchanged; settlement disabled.

## NOT TESTED

- `/settle` and `/verify` with real payment requests (explicitly out of scope).
- A real broadcast or signature against a real transaction (no signing of transactions).
- Recovery scheduling (no scheduler).
- Production secret injection.

## BLOCKED

- None for runtime readiness.
- Before any real transaction: maintainer must apply TASK55 code fixes (B3/B4), decide the
  production secret-injection mechanism, enable `/reconcile` (or a scheduler) if needed, and
  give explicit broadcast approval.

## RECOMMENDED NEXT BOUNDED TASK

1. Fix the `server.ts:397` misleading startup message (one-line conditional) — maintainer
   approval required.
2. Implement a startup recovery hook (invoke `recoverPending()` on boot) so persisted hashes
   are reconciled without manual action.
3. Define the production secret-injection mechanism for the signing service.
4. Only then: a controlled first sponsored Testnet transaction with explicit maintainer
   approval.

## CONSTRAINTS HONOURED

No transaction constructed for broadcast. No transaction signing. No submission or broadcast.
No settlement or payment execution. No faucet or funding. Token 1004 and its Agent Card
untouched. `DENY_ALL_FACILITATOR` enabled; settlement disabled. No private key material printed,
copied, or transmitted. No production source modified (defect reported instead). No commits or
pushes.
