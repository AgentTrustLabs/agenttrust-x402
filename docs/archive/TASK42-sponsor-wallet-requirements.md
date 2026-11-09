# TASK 42 — Sponsor Wallet Requirements Discovery

Date: 2026-11-06 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

**Investigation and reporting only.** No code changes, no wallet operations, no signing, no
transactions, no funding, no commits.

---

## Executive Recommendation

**Use a dedicated Concordium Testnet sponsor account, provisioned outside the facilitator,
with its signing key held by a separate signing service (not the Gateway or Facilitator).**

The existing operator account (19943.619923 CCD) must **not** be reused as the sponsor —
it is the registry owner and would conflate fee-payer and identity-owner roles.

The simplest viable hackathon approach is:

1. Create a new Testnet account (wallet export).
2. Fund it with ~5 CCD (covers ~200 simple transfers at ~0.025 CCD each).
3. Build an `AccountSigner` from the wallet export in a **separate signing service**
   (not in the facilitator repository).
4. Wire it via the TASK35 adapter's injected `AccountSigner` parameter.

No browser/mobile wallet supports unattended signing — interactive wallets cannot drive
an automated agent-to-agent payment flow.

---

## Existing capabilities (what TASK33–TASK41 already provide)

| Capability | Status | Source |
|---|---|---|
| SDK sponsor-signing adapter (`createSdkSponsorSigner`) | ✅ implemented | `sdkSponsorSigner.ts` |
| V2→V1 wire converter | ✅ implemented | `wireConverter.ts` |
| Pipeline integration (validate→claim→authorize→convert→signer→hash→submit) | ✅ wired | `core.ts` |
| Sender signature verification (SDK primitive) | ✅ implemented | `senderVerifier.ts` |
| Account info provider (gRPC, read-only) | ✅ implemented | `grpcAccountInfoProvider.ts` |
| Authorization boundary (owner IPC, durable approval) | ✅ implemented | TASK34 arc |
| Energy derivation (Concordium formula) | ✅ implemented | `energy.ts` |
| Transaction hash computation | ✅ implemented | `signer.ts:computeTransactionHash` |
| Mock signer (no key material) | ✅ functional | `createMockSigner` |
| `AccountSigner` injection point | ✅ adapter accepts it | `createSdkSponsorSigner({ accountSigner })` |

**What is missing:** an actual `AccountSigner` instance backed by a real sponsor account.
The adapter accepts one, but nothing in this repository constructs one from key material —
by design (TASK 24).

---

## Missing components

1. **A funded Testnet sponsor account** (base58check address + account index).
2. **A signing key** held by a separate service (not this repository).
3. **An `AccountSigner`** constructed from the key by that service.
4. **An IPC or in-process transport** between the facilitator and the signing service
   (the TASK34 owner-process architecture can be reused for this).
5. **Configuration values** (`FACILITATOR_SPONSOR_ADDRESS`, `FACILITATOR_MODE=real`).

---

## Sponsor wallet requirements

### 1. New or existing account?

**New dedicated account.** The existing operator account (`4dWn8miA…`, 19943.619923 CCD)
is the registry owner and must not double as the fee-payer. A dedicated sponsor account
isolates fee-payer risk and allows independent funding/rotation.

### 2. Required account properties

- Concordium Testnet account (base58check address).
- At least one active credential (credential index 0).
- At least one key pair under that credential.
- Account threshold = 1 (single-key signing) for simplicity.
- Sufficient CCD balance for fees.

### 3. CCD balance requirement

Estimated from TASK02 on-chain data: a simple transfer costs ~0.025 CCD (energy ~2000,
fee ~0.025 CCD).

| Demo scale | Transactions | CCD needed |
|---|---|---|
| Minimal demo | 10 payments | ~0.3 CCD |
| Moderate demo | 50 payments | ~1.5 CCD |
| Comfortable margin | 200 payments | ~5 CCD |

**Recommendation: 5 CCD.** This covers ~200 payments with margin for retries and gas
spikes. No faucet operation is performed in this task.

### 4. Credential type and signing capability

- **Credential type:** standard Concordium account credential (Ed25519 keys).
- **Signing capability:** the `AccountSigner` must produce a signature for an
  `AccountTransactionSignature` digest. The SDK provides:
  - `buildBasicAccountSigner(privateKey)` — single key, single credential.
  - `buildAccountSigner(walletExport)` — multi-credential, multi-key.
- The sponsor account needs `accountThreshold = 1` and `credentialPublicKeys.threshold = 1`
  so a single signature suffices.

### 5. Signing mechanism

The facilitator **cannot** hold a private key (TASK 24 constraint: "no private-key or
seed-phrase handling"). The signer must be:

- An **injected `AccountSigner`** (already supported by `createSdkSponsorSigner`).
- Constructed **outside** the facilitator process — by a dedicated signing service, an HSM,
  or a test fixture.
- The facilitator never sees the key. It calls `accountSigner.sign(digest)` and receives
  a signature.

The SDK's `buildBasicAccountSigner(privateKey)` and `buildAccountSigner(walletExport)` are
the construction paths, but **both require key material** — they must run in a separate
process with its own UID and IPC boundary (reusing the TASK34 owner-process architecture).

### 6. Can an existing browser/mobile wallet provide the signing interface?

**No — not for unattended operation.**

- Browser wallets (Concordium Wallet, Concordium Wallet for Web) require **interactive
  user approval** per transaction. They expose `sign()` only via a user-facing prompt.
- Mobile wallets are the same — each transaction needs biometric/PIN confirmation.
- The Concordium SDK's `AccountSigner` interface is synchronous (`sign(digest)` returns
  a promise), but browser wallets implement it through a UI popup that blocks until the
  user approves. There is no "auto-approve" mode.

**Conclusion:** interactive wallets cannot drive an automated agent-to-agent payment flow.
The sponsor must be a **server-side account** with an unattended `AccountSigner`.

### 7. Does the TASK35 adapter support the proposed wallet integration?

**Yes, but only with a server-side `AccountSigner`.**

`createSdkSponsorSigner({ accountSigner })` accepts any object implementing the SDK's
`AccountSigner` interface (`sign(digest)` + `getSignatureCount()`). A wallet-backed signer
would need to implement this interface, but browser wallets don't expose it for unattended
use.

A wallet export file (`parseWallet` → `buildAccountSigner`) can produce an `AccountSigner`
that runs unattended — but the export file contains the private key, so it must be held
by a separate signing service, not the facilitator.

### 8. Required configuration values

| Variable | Required | Example |
|---|---|---|
| `FACILITATOR_MODE` | yes | `real` (currently throws — no real signer) |
| `FACILITATOR_SPONSOR_ADDRESS` | yes | the new sponsor account address |
| `FACILITATOR_NETWORK` | yes | `ccd:4221332d34e1694168c2a0c0b3fd0f27` (Testnet) |
| `FACILITATOR_SENDER_VERIFICATION` | yes | `sdk` |
| `FACILITATOR_NODE_HOST` | yes | `grpc.testnet.concordium.com` |
| `FACILITATOR_NODE_PORT` | yes | `20000` |
| `FACILITATOR_AUTHZ_SOCKET` | recommended | path to the authorization owner socket |
| `FACILITATOR_DB_PATH` | yes (real mode) | durable SQLite path |

### 9. Permissions and operational responsibilities

The wallet/sponsor owner retains:

- **Key custody** — the private key never leaves the signing service.
- **Funding** — the owner funds the account with CCD.
- **Rotation** — the owner can rotate keys by updating the signing service.
- **Revocation** — the owner can stop the signing service, which makes the facilitator
  unable to sign (fail-closed).
- **Monitoring** — the owner monitors the account balance and transaction history.

The facilitator retains:

- **No key access** — structurally impossible (no key parameter in the adapter).
- **No signing** — it calls `accountSigner.sign(digest)` and receives a signature.
- **No submission** — submission is in the durable pipeline, disabled by default.
- **Authorization enforcement** — every signature requires prior durable approval from the
  authorization owner.

### 10. Simplest viable hackathon approach

1. Create a new Testnet account (wallet export via Concordium Wallet).
2. Fund it with ~5 CCD (Testnet faucet or transfer from the existing operator account).
3. Parse the wallet export (`parseWallet` → `buildAccountSigner`) in a **separate signing
   service** process (UID 997 or a new dedicated UID).
4. The signing service exposes `sign(digest)` over IPC (reuse the TASK34 owner-process
   architecture).
5. The facilitator connects to the signing service and injects the resulting
   `AccountSigner` into `createSdkSponsorSigner`.
6. Set `FACILITATOR_MODE=real`, `FACILITATOR_SPONSOR_ADDRESS=<new address>`,
   `FACILITATOR_SENDER_VERIFICATION=sdk`.

**Total new code needed:** a thin IPC wrapper around `buildAccountSigner`. The adapter,
pipeline, authorization, and recovery are already implemented.

---

## Comparison of viable approaches

### A. Existing sponsor account with an external signer

| Aspect | Detail |
|---|---|
| Prerequisites | A funded Testnet account + an external signing service holding its key |
| Complexity | Medium — needs a signing service process + IPC |
| Compatibility | Full — `createSdkSponsorSigner` accepts any `AccountSigner` |
| Advantages | Clean separation; key never touches the facilitator |
| Limitations | Requires a separate process and key custody |
| Automated demo | ✅ Yes (unattended once the signing service is running) |

### B. Dedicated new sponsor account

| Aspect | Detail |
|---|---|
| Prerequisites | New account creation + funding + signing service |
| Complexity | Medium (same as A, plus account creation) |
| Compatibility | Full |
| Advantages | Isolated fee-payer; independent rotation; no conflation with registry owner |
| Limitations | Needs funding (a few CCD) |
| Automated demo | ✅ Yes |

### C. Wallet-based interactive signing

| Aspect | Detail |
|---|---|
| Prerequisites | Browser/mobile wallet with the account |
| Complexity | Low to start, high to automate |
| Compatibility | **Partial** — the SDK's `AccountSigner` interface can be implemented as a wallet proxy, but every transaction requires user approval |
| Advantages | No server-side key management |
| Limitations | **Cannot be unattended.** Every payment needs a user click/biometric. Agent-to-agent payments would stall. |
| Automated demo | ❌ No |

---

## Exact maintainer requirements

### Mandatory

| # | Item | What is needed | Why |
|---|---|---|---|
| 1 | **Testnet sponsor account** | A Concordium Testnet account address (base58check) | The facilitator needs a fee-payer identity |
| 2 | **Testnet funding** | ~5 CCD transferred to the sponsor account | Covers ~200 payments at ~0.025 CCD each |
| 3 | **Signing mechanism decision** | Confirm: dedicated account + external signing service (approach B) | The only unattended option |
| 4 | **Explicit approval** | Written approval to provision a sponsor account and signer | Non-negotiable constraint: no real facilitator activation without maintainer approval |

### Optional

| # | Item | What is needed | Why |
|---|---|---|---|
| 5 | **Account export** | A wallet export file or key material for the signing service | The signing service needs to construct an `AccountSigner` — **held by the service, never by the facilitator** |
| 6 | **Signing service UID** | A dedicated OS user (e.g., `signer`, UID 1005) | Process isolation per TASK34.6/34.17 |
| 7 | **IPC transport** | Confirmation that the TASK34 owner-process IPC model is acceptable for the signer | Reuses existing architecture |

### Not needed

| # | Item | Why not needed |
|---|---|---|
| — | Browser/mobile wallet | Cannot be unattended |
| — | Mainnet account | Testnet only |
| — | Faucet access | Funding can come from the existing operator account |
| — | Changes to `DENY_ALL_FACILITATOR` | Stays intact until maintainer approves activation |
| — | Changes to token 1004 / Agent Card | Untouched |

**Security note:** private keys, seed phrases, recovery phrases, passwords, and wallet
exports are NEVER requested in chat. The maintainer provides them through a secure
out-of-band channel to the signing service operator only.

---

## Recommended next bounded implementation task

**TASK43 — Dedicated Testnet Sponsor Signing Service**

Scope:
1. Create a separate signing service process (UID 1005, `signer` user).
2. Accept an injected `AccountSigner` (constructed from a key held by the service).
3. Expose `sign(digest)` over a Unix IPC socket with SO_PEERCRED (reuse TASK34.7 contract).
4. Wire the facilitator to the signing service via `IpcAccountSigner` (implements `AccountSigner`).
5. Add deterministic fake-signer tests (no key material).
6. Document the service boundary and threat model.

**Prerequisites:** maintainer approval + funded Testnet sponsor account + signing key held
by the signing service operator.

---

## VERIFIED / NOT TESTED / BLOCKED

### VERIFIED

- SDK signer construction APIs (`buildBasicAccountSigner`, `buildAccountSigner`, `parseWallet`)
- SDK `AccountSigner` interface (`sign` + `getSignatureCount`)
- Official facilitator signer (`toConcordiumFacilitatorSigner` — requires private key, not used)
- TASK35 adapter accepts injected `AccountSigner` (no key parameter)
- Browser/mobile wallets require interactive approval (no unattended mode)
- Existing operator balance: 19943.619923 CCD (TASK02)
- Energy cost per simple transfer: ~0.025 CCD (TASK02 on-chain data)
- `DENY_ALL_FACILITATOR` intact
- Full suite: 2073/2073 passed

### NOT TESTED

- Wallet export parsing (`parseWallet` / `parseSimpleWallet`) — not exercised (no wallet file)
- `buildAccountSigner` with a real wallet export — not exercised (no key material)
- IPC transport for the signing service (design only, not implemented)
- Live Testnet account creation or funding (no operation performed)

### BLOCKED

- **Real sponsor signing** — requires a funded account + key custody decision.
- **Real facilitator activation** — requires maintainer approval + TASK43.
- **Testnet funding** — requires maintainer action (transfer or faucet).

---

## Changed files

**None.** This is a read-only investigation. No source, test, schema, or configuration
changes were made.

**New deliverable:**
- `docs/archive/TASK42-sponsor-wallet-requirements.md`

---

## Full suite and typecheck

```
2073/2073 passed · 56 suites · 0 FAIL
typecheck: facilitator ✓ · gateway ✓
HEAD 4c8994db391d77796e06e49c843c42be1eae615b — no commits
```

**Stop condition met.** No implementation performed. No further tasks started. Awaiting
maintainer review. Do not begin TASK43.
