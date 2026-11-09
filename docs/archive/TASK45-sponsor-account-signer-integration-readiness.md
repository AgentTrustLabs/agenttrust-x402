# TASK 45 — Sponsor AccountSigner Integration Readiness

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Investigation and design only.** No code changes, no signing, no key material, no commits.

---

## VERDICT

**PASS.** The existing architecture already provides every seam needed to connect a real
`AccountSigner`. No source-code changes are required for the integration itself — only
provisioning of a signing service with key custody and maintainer approval. The
`IpcAccountSigner` (TASK43) already implements the SDK's `AccountSigner` interface, and
`createSdkSponsorSigner` (TASK35) already accepts an injected `AccountSigner`. The gap is
purely operational: a dedicated signing service holding a real key, behind the TASK34
owner-process isolation boundary.

---

## CURRENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Facilitator (UID agentfac, proposed)                                       │
│                                                                             │
│  config: senderVerification=sdk, authorizationSocket=<path>                 │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ FacilitatorCore.settle()                                             │   │
│  │   validate → claim → sender verify (GrpcAccountInfoProvider)          │   │
│  │   → authorize (IPC → owner) → recover → convert → signer → hash      │   │
│  │                                                          │           │   │
│  │  signer = createSdkSponsorSigner({                       │           │   │
│  │    sponsorAddress,                                        │           │   │
│  │    accountSigner: IpcAccountSigner (injected) ◄───────────┘           │   │
│  │  })                                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                          │ IPC (Unix socket, SO_PEERCRED)                   │
│                          ▼                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Signing Service (UID signer, proposed — TASK43 foundation)            │   │
│  │   createSigningService({ accountSigner, sponsorAddress, network,      │   │
│  │                          allowedUid })                                │   │
│  │   └─► accountSigner.sign(digest) → AccountTransactionSignature       │   │
│  │   └─► returns signature over IPC                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                          │                                                  │
│                          ▼                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Key Custody (separate process, separate UID)                         │   │
│  │   buildBasicAccountSigner(privateKey)   OR                            │   │
│  │   buildAccountSigner(walletExport)                                    │   │
│  │   The key NEVER leaves this process.                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## VERIFIED SDK CONTRACT

### `AccountSigner` interface

Source: `node_modules/@concordium/web-sdk/lib/esm/signHelpers.d.ts:43-55`

```ts
export interface AccountSigner {
  sign(digest: ArrayBuffer): Promise<AccountTransactionSignature>;
  getSignatureCount(): bigint;
}
```

### `AccountTransactionSignature` type

Source: `node_modules/@concordium/web-sdk/lib/esm/types.d.ts:1389`

```ts
export type AccountTransactionSignature = Record<number, CredentialSignature>;
```

Structure: `{ credentialIndex: { keyIndex: hexSignature } }`.

### `AccountSigner` construction (verified, NOT used here)

| Function | Source | Input | Requires key? |
|---|---|---|---|
| `buildBasicAccountSigner(privateKey)` | `signHelpers.d.ts:73` | `HexString` (private key) | **Yes** |
| `buildAccountSigner(walletExport)` | `signHelpers.d.ts:82` | `WalletExportFormat` | **Yes** (contains keys) |
| `buildAccountSigner(keys)` | `signHelpers.d.ts:100` | `SimpleAccountKeys` | **Yes** |
| `parseWallet(walletString)` | `signHelpers.d.ts:39` | wallet export JSON | contains keys |
| `parseSimpleWallet(walletString)` | `signHelpers.d.ts:34` | simple wallet JSON | contains keys |

**All construction paths require key material.** The facilitator never calls any of them.

### SDK signing flow used by the adapter

```
Transaction.signableFromJSON(tx) → Transaction.sponsor(signable, accountSigner) → Transaction.toJSON(signed)
```

Verified empirically in TASK35: `sponsor()` calls `AccountTransactionV1.createSignature(preFinalized(tx), signer)`,
which calls `signer.sign(digest)`. The returned signature is added to the sponsor slot.

---

## SIGNING SERVICE INTEGRATION CONTRACT

### Does `createSigningService` accept a real SDK-backed signer without protocol changes?

**Yes.** `createSigningService(opts)` takes `opts.accountSigner: AccountSigner` (TASK43
source, line 126). The service calls `opts.accountSigner.sign(digestBuffer)` and returns
the `AccountTransactionSignature`. No protocol change is needed — the IPC contract
(`agenttrust-sign v1`) already supports the `signed` outcome with a signature payload.

### Exact boundary

```
Facilitator ──IPC──► Signing Service ──► AccountSigner.sign(digest) ──► signature
     │                      │
     │                      ├─ validates digest, sponsor, network
     │                      ├─ validates SO_PEERCRED peer UID
     │                      ├─ replay protection (request ID)
     │                      └─ returns { outcome, signature, reason, detail }
     │
     └─ IpcAccountSigner.sign(digest) implements AccountSigner
        └─ createSdkSponsorSigner({ accountSigner: ipcSigner })
```

The facilitator's `IpcAccountSigner` (TASK43, `signingService.ts:286`) already implements
`AccountSigner`. It can be injected directly into `createSdkSponsorSigner`. No adapter
code change is needed.

### What the service validates (from TASK43)

- Digest: 64-char hex (32 bytes).
- Sponsor: must equal the service's configured sponsor address.
- Network: must equal the service's configured network.
- Peer UID: SO_PEERCRED must match the configured facilitator UID.
- Request ID: replay protection (in-memory, per-process).

### What the service does NOT do

- No authorization (that is the owner process's job).
- No submission (the facilitator's durable pipeline owns that).
- No key material inspection (the service trusts the injected signer).

---

## REQUIRED CONFIGURATION

| Variable | Required | Purpose |
|---|---|---|
| `FACILITATOR_MODE` | yes | `real` (currently throws — no real signer) |
| `FACILITATOR_SPONSOR_ADDRESS` | yes (real mode) | Base58check sponsor account |
| `FACILITATOR_NETWORK` | yes | CAIP-2 network (Testnet only) |
| `FACILITATOR_SENDER_VERIFICATION` | yes (real mode) | `sdk` |
| `FACILITATOR_NODE_HOST` | yes (sdk mode) | gRPC endpoint host |
| `FACILITATOR_NODE_PORT` | yes (sdk mode) | gRPC endpoint port |
| `FACILITATOR_AUTHZ_SOCKET` | recommended | Authorization owner IPC socket |
| `FACILITATOR_DB_PATH` | yes (real mode) | Durable SQLite path (not `:memory:`) |
| `FACILITATOR_SIGNING_SERVICE_SOCKET` | **new** | Signing service IPC socket path |
| `FACILITATOR_SIGNING_SERVICE_UID` | **new** | Expected signing-service UID (SO_PEERCRED) |

### New configuration needed (not yet implemented)

- `FACILITATOR_SIGNING_SERVICE_SOCKET` — path to the signing service's Unix socket.
- `FACILITATOR_SIGNING_SERVICE_UID` — expected UID of the signing service process.

These are design proposals. No config changes were made in this task.

---

## SPONSOR ACCOUNT REQUIREMENTS

From TASK42, unchanged:

| Requirement | Detail |
|---|---|
| Account type | Concordium Testnet account |
| Credential | At least one active credential (index 0) |
| Key pair | Ed25519 under credential 0 |
| Threshold | `accountThreshold = 1`, `credentialPublicKeys.threshold = 1` |
| Balance | ~5 CCD (covers ~200 payments at ~0.025 CCD each) |
| Key custody | Held by the signing service process, **never** by the facilitator |

The sponsor account's public key must match the `verifyKey` that the authorization
owner's policy validates (indirectly — the owner validates sponsor identity, not the key).

---

## MISSING PREREQUISITES

| # | Prerequisite | Status | Blocks |
|---|---|---|---|
| 1 | Funded Testnet sponsor account | **Missing** | Real signing |
| 2 | Key material in a signing service | **Missing** | Real `AccountSigner` construction |
| 3 | Signing service process (UID 1005) | **Missing** | IPC transport |
| 4 | `IpcAccountSigner` wired into `createSdkSponsorSigner` | **Design only** | Adapter integration |
| 5 | `FACILITATOR_SIGNING_SERVICE_SOCKET` config | **Missing** | Client construction |
| 6 | `FACILITATOR_SIGNING_SERVICE_UID` config | **Missing** | SO_PEERCRED verification |
| 7 | Sender signature verification with real keys | **Missing** | TASK38 production path |
| 8 | Maintainer approval | **Missing** | All of the above |

---

## MINIMAL IMPLEMENTATION PLAN

1. **Provision the signing service process** (separate UID, separate process, own socket).
   - Reuse the TASK34 owner-process isolation model (§5.3 socket, §5.4 DB, §6 sandbox).
   - The service holds the `AccountSigner` constructed from a key it receives out-of-band.
   - It exposes `sign(digest)` over the `agenttrust-sign v1` IPC protocol.

2. **Wire the facilitator** to the signing service:
   - Add `FACILITATOR_SIGNING_SERVICE_SOCKET` and `FACILITATOR_SIGNING_SERVICE_UID` to config.
   - In `startFacilitator`, when `config.mode === 'real'`, construct `IpcAccountSigner`
     and pass it to `createSdkSponsorSigner({ accountSigner: ipcSigner })`.
   - Remove the `createSigner` throw (or replace it with the IPC-backed construction).

3. **Inject the real sender verifier** (TASK41 already wired the config; the provider
   needs a live Testnet connection).

4. **Test with deterministic fakes** (no key material) — the existing TASK43 tests prove
   the IPC contract; the TASK35 tests prove the adapter; the TASK37 tests prove the
   pipeline.

5. **Maintainer approval** to enable `FACILITATOR_MODE=real` with a funded sponsor.

**Estimated new code:** ~50 lines of wiring in `server.ts` + config. No changes to the
adapter, converter, or pipeline.

---

## BLOCKERS

| Blocker | Severity | Resolution |
|---|---|---|
| No funded Testnet sponsor account | High | Maintainer action (fund or faucet) |
| No key custody decision | High | Maintainer decision (HSM vs. signing service) |
| No signing service process | High | TASK43 foundation exists; needs deployment |
| `real` mode throws (`createSigner`) | Medium | Replace with IPC-backed signer construction |
| No `FACILITATOR_SIGNING_SERVICE_*` config | Medium | Add to `loadConfig` |
| Owner trust root | Low (architectural) | Documented, not solvable by code |

---

## NOT TESTED

- `IpcAccountSigner` against a real signing service process (tested in-process in TASK43).
- `createSdkSponsorSigner` with a real `AccountSigner` (tested with a fake).
- Full pipeline with a real sponsor signature (mock signer only).
- Live Testnet `getAccountInfo` for the sponsor account (TASK40 verified a different account).
- `verifyNode()` at startup (not wired).

---

## RECOMMENDED NEXT TASK

**TASK46 — Production Sponsor Signer Wiring (Mock-Only Verification)**

Scope:
1. Add `FACILITATOR_SIGNING_SERVICE_SOCKET` and `FACILITATOR_SIGNING_SERVICE_UID` to
   `loadConfig` with fail-closed validation.
2. Wire `IpcAccountSigner` into `startFacilitator` for `real` mode (replacing the
   `createSigner` throw).
3. Inject the real `GrpcAccountInfoProvider` + `SdkSenderVerifier` (TASK41 already wired
   the config; the provider needs a live connection).
4. Add deterministic integration tests (fake signing service, no key material).
5. Document the complete production wiring.

**Prerequisites:** maintainer approval + funded Testnet sponsor account + signing service
key custody.

---

## VERIFIED / NOT TESTED / BLOCKED (summary)

**VERIFIED**
- `AccountSigner` interface: `sign(digest) + getSignatureCount()` (SDK source)
- `IpcAccountSigner` implements `AccountSigner` (TASK43)
- `createSigningService` accepts injected `AccountSigner` (TASK43)
- `createSdkSponsorSigner` accepts injected `AccountSigner` (TASK35)
- `IpcAccountSigner` → `createSdkSponsorSigner` chain works (deterministic fake)
- IPC protocol `agenttrust-sign v1` (TASK43, 19/19 tests)
- SO_PEERCRED peer authentication (TASK34.8, 42/42 tests)
- Authorization boundary + recovery (TASK34.1–34.14)
- Pipeline integration (TASK37, 15/15 tests)
- Sender verification (TASK38, 21 tests)
- Account info provider (TASK39, 13 tests)
- Live Testnet account verification (TASK40)
- Production sender verification wiring (TASK41, 10 tests)

**NOT TESTED**
- `IpcAccountSigner` against a real signing service process (in-process only)
- `createSdkSponsorSigner` with a real `AccountSigner`
- Full pipeline with a real sponsor signature
- Live Testnet `getAccountInfo` for the sponsor account

**BLOCKED**
- Real signing (no funded sponsor account, no key custody decision)
- Real facilitator activation (`DENY_ALL_FACILITATOR` intact)
- Testnet settlement (disabled by default)

---

## Files

**Changed:** none (investigation only)

**New:**
- `docs/archive/TASK45-sponsor-account-signer-integration-readiness.md`

**Unchanged:**
- `signingService.ts`, `sdkSponsorSigner.ts`, `senderVerifier.ts`, `grpcAccountInfoProvider.ts`
- `core.ts`, `config.ts`, `server.ts`, `authorization.ts`, `repository.ts`, `signer.ts`
- `DENY_ALL_FACILITATOR` — intact
- token 1004 / Agent Card — untouched
- HEAD `4c8994d` — no commits

---

## Constraint audit

| Constraint | Status |
|---|---|
| Investigation and documentation only | ✅ |
| No source-code changes | ✅ |
| No wallet creation or import | ✅ |
| No private-key access/generation/export/signing | ✅ |
| No real AccountSigner execution | ✅ |
| No sponsor funding or faucet | ✅ |
| No transaction construction/submission/broadcast | ✅ |
| No Mainnet | ✅ |
| No real facilitator activation or settlement | ✅ |
| `DENY_ALL_FACILITATOR` intact | ✅ |
| Settlement disabled by default | ✅ |
| Token 1004 / Agent Card unmodified | ✅ |
| No schema changes | ✅ |
| No commits or pushes | ✅ HEAD `4c8994d` |
| No unrelated scope expansion | ✅ |

**Stop condition met.** No implementation performed. No further tasks started. Awaiting
maintainer review. Do not begin TASK46.
