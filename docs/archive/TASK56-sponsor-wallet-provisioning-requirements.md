# TASK 56 — Sponsor Wallet Provisioning Requirements Discovery

## 1. EXECUTIVE RECOMMENDATION

Use the **Concordium Wallet (desktop) export flow** to create a dedicated Testnet sponsor
account, then feed its wallet-export JSON into the existing signing service via
`buildAccountSigner(parseWallet(export))`. No new adapter is required — the SDK already
provides the conversion. The facilitator never sees the key material.

Do **not** create, fund, or sign with the account yet. This document is the provisioning
requirements only.

## 2. ACCOUNT AND CREDENTIAL REQUIREMENTS

Verified against the installed `@concordium/web-sdk@12.0.2` and the live Testnet node.

| Requirement | Value | Evidence |
|---|---|---|
| Network | Concordium Testnet, CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27` | `TESTNET_CAIP2` (config.ts); genesis `4221332d…50f796` verified live |
| Address format | Concordium base58check, 45–55 chars, no `0/O/I/l` | `ACCOUNT_RE` (config.ts); `AccountAddress.fromBase58` |
| Credential type | Ed25519 (`schemeId = 0`) | operator account credential 0: `schemeId: "Ed25519"`, 32-byte verifyKey |
| Account threshold | `1` | `accountThreshold` must be a positive integer (provider validation) |
| Credential threshold | `1` | `credentialPublicKeys.threshold >= 1` (provider validation); `buildBasicAccountSigner` requires threshold 1 |
| Signing scheme | Ed25519 digest signing via `AccountSigner.sign(digest)` | `signHelpers.d.ts` `AccountSigner` interface |
| Single-credential account | Sufficient | `buildBasicAccountSigner` note: fails if threshold > 1, but threshold 1 + 1 key is fine |
| Special configuration | None required | Standard account; no contract, no multi-sig, no special policy |

`buildBasicAccountSigner(privateKey)` and `buildAccountSigner(walletExport)` both produce an
`AccountSigner` that signs the first credential's first key. For threshold-1 accounts these are
equivalent; `buildAccountSigner(walletExport)` is preferred because it carries the full
credential set and survives a future threshold increase.

## 3. WALLET CREATION OPTIONS AND COMPARISON

### Option A — Concordium Wallet (desktop) export (RECOMMENDED)

- **Procedure:** Install the Concordium Wallet desktop app, create a new Testnet account
  (the app handles key generation and account creation on chain), then export the account
  ("Export account" → produces a JSON wallet file containing the private keys and account
  metadata).
- **Account information available:** address, account index, nonce, credentials, public keys,
  and the private key seed (inside the export file). Full `WalletExportFormat`.
- **Connection to signing service:** the export JSON is parsed with `parseWallet(export)` and
  passed to `buildAccountSigner(walletExport)`. The resulting `AccountSigner` is injected into
  `createSigningService({ accountSigner, sponsorAddress, network, allowedUid })`.
- **Unattended server-side signing:** yes — the signing service holds the `AccountSigner` in
  memory for the process lifetime. The export file is read once at startup and never re-read.
- **Limitations:** requires a desktop environment and a manual export step; the export file
  contains private key material and must be handled as a secret; the export format must match
  `WalletExportFormat` (the SDK's `parseWallet` validates it).
- **Operational requirements:** secure transfer of the export file to the signing-service host,
  secure storage (or deletion after injection), and a secret-management mechanism for the
  signing-service process.

### Option B — Concordium CLI (`concordium-client`)

- **Procedure:** Install the CLI, configure a Testnet node endpoint, create an account with
  `concordium-client account create` (which submits an account-creation transaction paid by an
  existing funded account), then export keys.
- **Account information available:** address, account index, and key material (via
  `concordium-client account show` / key export).
- **Connection to signing service:** the CLI's key export format differs from the wallet
  export; an adapter would be needed to convert it into the `SimpleAccountKeys` /
  `SimpleWalletFormat` shape that `buildAccountSigner` accepts, or use
  `buildBasicAccountSigner(privateKeyHex)` with the first credential's first key.
- **Unattended server-side signing:** possible, but the conversion step adds operational
  complexity and a new failure surface.
- **Limitations:** CLI is not installed in this environment; installation and node-endpoint
  configuration are extra steps; key-export format must be verified against the SDK's parsers.
- **Operational requirements:** same as Option A plus CLI installation and format verification.

### Option C — SDK-generated keypair + manual on-chain account creation

- **Procedure:** generate an Ed25519 keypair in a secure environment, then submit an
  account-creation transaction from an existing funded account (paying the creation cost) that
  registers the new public key. The resulting account address is derived from the creation.
- **Account information available:** address (derived), public key, private key (held by the
  creator).
- **Connection to signing service:** `buildBasicAccountSigner(privateKeyHex)` directly, or
  construct `SimpleAccountKeys` and use `buildAccountSigner(keys)`.
- **Unattended server-side signing:** yes, once the key is injected.
- **Limitations:** requires an existing funded account to pay the creation cost (~0.1 CCD);
  the account-creation transaction must be constructed and submitted (a write operation, which
  this task and TASK55's constraints forbid the agent from performing); the address is not
  chosen by the operator.
- **Operational requirements:** an existing funded Testnet account, a submission path, and
  careful key handling.

### Recommendation

**Option A (Concordium Wallet export).** It is the officially supported path that produces a
`WalletExportFormat` directly consumable by `buildAccountSigner`, supports the full credential
set (so a future threshold increase does not break signing), and requires no adapter. Option B
adds a format-conversion step; Option C requires a write transaction and an existing funded
account, which conflicts with the no-broadcast constraint.

## 4. FUNDING CALCULATION

Evidence (TASK55, live Testnet, protocol 10):

- Exchange rate: 7172.71359466307 microCCD/NRG.
- Sponsored simple transfer (2 sigs, 94-byte sponsored header, 41-byte payload, 300 base cost):
  **603 NRG → 4.325 CCD**.
- Maximum fee cap: 10 CCD (`FACILITATOR_MAX_FEE_MICROCCD` default 10 000 000).
- Maximum energy: 1 000 NRG (`FACILITATOR_MAX_ENERGY` default 1 000).

| Item | Amount | Basis |
|---|---|---|
| Minimum for one transaction | ~4.33 CCD | Measured sponsored simple transfer fee (603 NRG × 7172.71 microCCD/NRG). Add 0.5 CCD buffer → **5 CCD**. |
| Recommended for integration testing | **25 CCD** | Covers 5 transactions at the 10 CCD worst-case cap, or ~6 at the measured 4.33 CCD rate, with retry headroom. |
| Reserve for retries / multiple tests | Included in the 25 CCD | ~5 CCD of retry headroom at the measured rate. |
| Account creation cost | ~0.1 CCD | Paid by the creator (the faucet-funded account that creates the sponsor), **not** by the sponsor itself. |
| Additional per-transaction costs | None beyond the fee | Concordium charges `min(energyLimit, energyUsed) × exchangeRate`; no separate base fee beyond the energy cost. |

Do not reuse the stale TASK42 estimate (~5.04 CCD / 0.025 CCD per payment). The measured
value is 4.325 CCD per simple sponsored transfer.

## 5. PRODUCTION SIGNER COMPATIBILITY

Inspected: `AccountSigner` interface (`signHelpers.d.ts`), `signingService.ts`,
`IpcAccountSigner`, `sdkSponsorSigner.ts`, `server.ts`, and the SDK signer builders.

### Required account export / credential representation

- `WalletExportFormat` (the JSON exported by the Concordium Wallet) **or** a `SimpleWalletFormat`
  / `SimpleAccountKeys` / single `HexString` private key.
- The SDK provides `parseWallet(walletString)` → `WalletExportFormat` and
  `buildAccountSigner(walletExport)` → `AccountSigner`.
- Alternatively, `buildBasicAccountSigner(privateKeyHex)` for a threshold-1, single-key
  account.

### Whether the wallet supports a supported signing interface

Yes. The Concordium Wallet export is exactly the input `buildAccountSigner` accepts. The
resulting `AccountSigner.sign(digest)` returns an `AccountTransactionSignature` covering all
credentials and keys in the export — which is what `Transaction.sponsor` needs.

### Whether an adapter is needed

**No new adapter is needed.** The SDK's `buildAccountSigner` / `buildBasicAccountSigner` already
implement the `AccountSigner` interface that `createSigningService` and `createSdkSponsorSigner`
consume. The only wiring is: read the export (or seed), construct the `AccountSigner`, inject it
into `createSigningService`.

### Required environment variables / configuration

Signing-service process (out-of-band, never in the facilitator):
- The wallet export JSON or private key seed, supplied via a secret store / env var / file
  mounted read-only. The current test harness uses `TASK48_TEST_KEY=<64-hex seed>`; a production
  deployment needs a real secret-injection mechanism (not yet implemented).
- `sponsorAddress`, `network`, `allowedUid` (constructor args to `createSigningService`).

Facilitator process:
- `FACILITATOR_MODE=real`
- `FACILITATOR_SPONSOR_ADDRESS=<sponsor base58check address>`
- `FACILITATOR_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27`
- `FACILITATOR_SIGNING_SERVICE_SOCKET=<absolute path>`
- `FACILITATOR_SIGNING_SERVICE_UID=<uid>`
- `FACILITATOR_NODE_HOST=grpc.testnet.concordium.com`
- `FACILITATOR_NODE_PORT=20000`
- `FACILITATOR_NODE_USE_TLS=1`
- `FACILITATOR_SENDER_VERIFICATION=sdk`
- `FACILITATOR_DB_PATH=<durable file>`
- `FACILITATOR_MAX_FEE_MICROCCD` and `FACILITATOR_MAX_ENERGY` (defaults: 10 000 000 / 1 000)

### Whether the signing service can remain isolated from the facilitator

Yes — and it must. The architecture is already designed for this:
- `IpcAccountSigner` talks to the service over a Unix socket using SO_PEERCRED.
- Only the 32-byte digest crosses the boundary; the full transaction and all key material stay
  in the service process.
- The facilitator holds no key material (`createSigner()` throws in real mode).
- Socket permissions `0o660`, owned by the service user, group `authclients`.

## 6. REQUIRED MAINTAINER DECISIONS

### Information the agent can obtain independently (already done)

- Testnet genesis hash and network identity.
- Live exchange rate and energy cost (7172.7136 microCCD/NRG; 603 NRG / 4.325 CCD per
  sponsored simple transfer).
- SDK API shapes (`buildAccountSigner`, `parseWallet`, `AccountSigner`, `ConcordiumGRPCNodeClient`).
- Account info for any public address (read-only RPC).
- Fee model and cap consistency.

### Information the maintainer must supply

1. Choice of wallet creation method (Concordium Wallet export recommended).
2. The sponsor account's base58check address and account index (after creation).
3. The wallet export file or private key seed (out-of-band — never through the agent).
4. The signing-service host, OS user, socket path, and UID.
5. The secret-management mechanism (env var, mounted file, vault, HSM).
6. The funded sender account and its signing key (held by the sender, not the facilitator).

### Actions requiring explicit approval

- Creating the wallet (in the Concordium Wallet app).
- Requesting faucet funding for the sponsor account.
- Starting the signing service with key material.
- Switching `FACILITATOR_MODE` to `real`.
- Applying the B3/B4 code fixes and the confirming-evidence rule.
- Any real transaction signing or broadcast.

### Actions that must remain outside the agent's scope

- Holding, viewing, logging, exporting, or generating private keys.
- Executing the faucet request.
- Creating the wallet in the Concordium Wallet app.
- Modifying production source without review.
- Any broadcast or submission.

## 7. EXACT NEXT STEPS TO CREATE AND CONNECT THE WALLET

1. Maintainer reviews this document and approves provisioning.
2. Maintainer installs the Concordium Wallet (desktop) and creates a new Testnet account.
3. Maintainer exports the account (wallet export JSON) and securely transfers it to the
   signing-service host (never to the facilitator host).
4. Maintainer records the sponsor's base58check address and account index.
5. Maintainer requests Testnet faucet funding (~25 CCD) for the sponsor account.
6. Maintainer provisions a signing-service host/user, socket path, and UID.
7. Maintainer starts the signing service with the wallet export injected (e.g. via a
   secret-mounted file read at startup), using `buildAccountSigner(parseWallet(export))`.
8. Maintainer sets the facilitator env vars (section 5) with `FACILITATOR_MODE=real`.
9. Maintainer applies the TASK55 code fixes (B3, B4, confirming-evidence rule) and reviews.
10. Maintainer runs the focused + full test suites and confirms `DENY_ALL_FACILITATOR` and
    the settlement default remain disabled.
11. Maintainer performs the first controlled Testnet transaction with explicit broadcast
    approval.

## 8. REMAINING TECHNICAL BLOCKERS

- **B1** — sponsor account not provisioned (this task's output is the plan; provisioning is
  a maintainer action).
- **B2** — production key-custody path not established (only the test harness
  `task48-service.mts` exists).
- **Confirming-evidence rule** (GAP E) — recommended before live use, not a hard blocker for
  a single-node deployment.
- **Production secret injection** for the signing service — not yet implemented (the test
  harness uses `TASK48_TEST_KEY`).

## CONSTRAINTS HONOURED

No wallet created. No keypair or credential generated. No private-key access, import, export,
or logging. No faucet requests. No account funding. No signing. No transaction construction or
broadcast. No Mainnet. Token 1004 and its Agent Card untouched. No production source code
changed. No commits or pushes.
