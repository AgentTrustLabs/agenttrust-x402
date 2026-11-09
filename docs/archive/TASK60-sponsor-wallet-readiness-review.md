# TASK 60 — Sponsor Wallet Provisioning Readiness Review

## VERDICT: READY WITH CONDITIONS

The provisioning path is coherent and the read-only verification tooling is validated against
live Testnet data. One correction to TASK56 is required (the Desktop Wallet encrypted backup is
**not** the format the SDK accepts — see section 2). Four blockers remain external to the code
(B1 sponsor provisioning, B2 key custody, GAP E confirming-evidence rule, production secret
injection), and the maintainer must execute the manual steps.

## 1. WALLET EXPORT FORMAT COMPATIBILITY (HIGHEST PRIORITY)

### Exact official export format

Concordium Wallet for Web / Concordium Wallet (mobile) → **Account Settings → Export private
key → Export to file** produces a single-account JSON file. Documented shape (from Concordium's
multi-sig account guide, verified against the SDK):

```json
{
  "type": "concordium-browser-wallet-account",
  "v": 0,
  "environment": "testnet",
  "value": {
    "accountKeys": {
      "threshold": 1,
      "keys": { "0": { "keys": { "0": { "signKey": "<hex>", "verifyKey": "<hex>" } }, "threshold": 1 } }
    },
    "credentials": { "0": "<credential-id hex>" },
    "address": "<base58check>"
  }
}
```

### SDK 12.0.2 `parseWallet` contract

`parseWallet(walletString)` (`signHelpers.js`) requires:
- `type` — string
- `v` — number
- `environment` — string
- `value.address` — string
- `value.credentials` — object
- `value.accountKeys` — defined (then validated by `validateSimpleWallet`)

The wallet export above satisfies all of these. **Compatible.**

### `loadWalletExportSigner` correctness

- Reads the file at the configured path (injected reader in tests; `readFileSync` in prod).
- Calls `parseWallet(raw)` → `WalletExportFormat`.
- Validates: `value` is an object, `address` is a non-empty string, `accountKeys` exists with
  `threshold >= 1` and at least one credential, each credential has `threshold >= 1` and at
  least one key. (Default policy: account threshold === 1 and every credential threshold === 1.)
- Calls `buildAccountSigner(exported)` → `AccountSigner`.
- Verifies the result exposes `sign` and `getSignatureCount`.
- All failures throw generic `WalletExportError` messages; no file contents, credentials, keys,
  or signatures are leaked.

### Address and credential correspondence

- `value.address` is validated as a non-empty string. The signing service then validates
  `req.sponsor === opts.sponsorAddress` (the configured sponsor) before signing — so a
  mismatched export is rejected at sign time, not at load time.
- `value.credentials` is carried in the export; `buildAccountSigner` signs for all credentials
  and keys in the export. The sponsor account's on-chain credentials (threshold 1, 1 key)
  match the loader's threshold-1 policy.

### Account and credential threshold handling

- Loader requires account threshold === 1 and credential threshold === 1 (default policy).
- `buildAccountSigner` handles any threshold; the policy restriction is a safety choice for
  the sponsor account (unattended, single-signer).
- On-chain validation (`task58-verify-sponsor-account.mts`) confirms `accountThreshold === 1`
  and `credentialPublicKeys.threshold === 1`.

### Format differences (NOT interchangeable)

| Format | Producer | `parseWallet`-compatible? |
|---|---|---|
| Concordium Wallet for Web / mobile "Export private key" → file | Web/mobile wallet | **YES** — single-account JSON `{type, v, environment, value}` |
| Concordium Wallet for Web backup file | Web wallet settings | Possibly — contains seed phrase + accounts; not the single-account shape |
| Desktop Wallet "Export/Import" backup | Desktop Wallet | **NO** — encrypted, password-protected, contains identities/accounts |
| Desktop Wallet "Export a key → Account credentials" | Desktop Wallet | **NO** — multi-sig credentials file, different schema |
| `concordium-client` account import file | concordium-client | Partially — `parseSimpleWallet` accepts the simpler `{address, credentials, accountKeys}` shape |
| Private key hex (64 chars) | any | **NO** — `buildBasicAccountSigner` accepts a hex string, but `parseWallet` does not |

**Correction to TASK56:** TASK56 recommended "Concordium Wallet (desktop) export". The Desktop
Wallet cannot produce the `parseWallet`-compatible single-account export (it uses a LEDGER
device and an encrypted backup). The correct source is **Concordium Wallet for Web or
Concordium Wallet (mobile)** via "Export private key → Export to file".

### Empirical format probe (14/14)

`scripts/task60-export-format-probe.mts` exercises the REAL SDK 12.0.2 `parseWallet` /
`buildAccountSigner` with synthetic fixtures:

| Case | Result |
|---|---|
| A1–A6. Documented `concordium-browser-wallet-account` single-account export | **ACCEPTED** — type/v/environment/address/accountKeys/credentials all parsed |
| B1. Bare `{address, credentials, accountKeys}` (concordium-client account shape) | **REJECTED** by `parseWallet` (requires `type`/`v`/`environment`); the SDK's `parseSimpleWallet` + `buildAccountSigner` is the path for that shape |
| C1. Desktop Wallet encrypted backup shape | **REJECTED** (no `environment`) |
| D1. Multi-sig credentials file shape | **REJECTED** (no `value`/`type`) |
| E1. Bare private-key hex | **REJECTED** |
| F1–F2. `loadWalletExportSigner` on the documented shape | **ACCEPTED** — signer constructed, `getSignatureCount() === 1` |
| G1–G2. Loader on an incompatible export | **REJECTED** with a generic message (no contents leaked) |

### Missing evidence

The documented single-account export shape is confirmed compatible, but the maintainer's
actual export must still be validated against `parseWallet` before provisioning (the wallet
app's exact `type` string may vary by version). This is the one remaining unverified item.

## 2. SPONSOR IDENTITY CONSISTENCY MATRIX

| Component | Sponsor identity source | Validation |
|---|---|---|
| `FACILITATOR_SPONSOR_ADDRESS` (config) | env var, shape-checked by `isConcordiumAccount` | base58check 45–55 chars |
| Signing service (`createSigningService`) | constructor arg `sponsorAddress` | `req.sponsor !== opts.sponsorAddress` → rejected |
| Wallet export (`value.address`) | SDK export | non-empty string at load time; service validates at sign time |
| `IpcAccountSigner` | `sponsorAddress` option | sent to service; service validates against its own config |
| `sdkSponsorSigner` (`validateSponsorContext`) | `opts.sponsorAddress` | `ctx.sponsor !== opts.sponsorAddress` → `wrong sponsor` |
| Transaction sponsor header (`core.ts`) | `requirements.extra.feePayer ?? signer.info().address` | wire converter checks `sponsorValue !== policy.sponsorAddress` |
| Wire converter (`convertV2ToSdkV1`) | `policy.sponsorAddress` (= signer address) | `wrong_sponsor` on mismatch |

All six points bind to the same address. A mismatch at any point fails closed. No gap found.

## 3. SECRET LOADING AND PROCESS INTEGRATION

Verified against `walletExportLoader.ts`, `task57-wallet-service.mts`, `signingService.ts`:

- **Loading before socket binding:** the launcher calls `loadWalletExportSigner(exportPath)`
  before `svc.listen(socketPath)`. A failure exits 1; the socket is never bound. ✓
- **Invalid export prevents startup:** missing path / missing file / malformed / bad threshold /
  builder throw → `WalletExportError` → caught → exit 1. ✓
- **Wallet material never crosses IPC:** only the 32-byte digest is sent (`SigningRequest.digest`).
  The export, credentials, keys, and signatures never leave the service process. ✓
- **Facilitator receives only the digest-based protocol:** `IpcAccountSigner.sign(digest)` sends
  `{digest, sponsor, network, ...}`; the service validates and returns a signature. ✓
- **No fake-signer fallback in real mode:** `createSigner()` throws in real mode; `loadConfig`
  requires the signing socket + UID; `startFacilitator` probes reachability at boot. ✓
- **File permissions documented:** `0600`/`0640`, owner = service user, group `authclients`
  (TASK58 section 6). ✓
- **Error messages do not disclose wallet contents:** all loader errors are generic
  (`"wallet export file could not be read"`, `"could not be parsed"`, `"signer construction
  failed"`, etc.). Verified by TASK57 tests 19–21. ✓

## 4. SPONSOR ACCOUNT VERIFICATION

`scripts/task58-verify-sponsor-account.mts` checks:

| Check | Read-only? | Requires real account? | Verified |
|---|---|---|---|
| Address shape (base58check) | yes | no | yes (bad address → INVALID) |
| Genesis / network identity | yes | no | yes (live genesis matched) |
| Account existence | yes | yes | yes (existing → EXISTS; candidate → NOT FOUND) |
| Credential count + scheme | yes | yes | yes (1 cred, Ed25519) |
| Account + credential thresholds | yes | yes | yes (both 1) |
| Balance | yes | yes | yes (19943.619923 CCD) |
| Nonce | yes | yes | yes (4) |

All checks are read-only (gRPC `getConsensusStatus` + `getAccountInfo`). No writes, no signing.

## 5. FUNDING AND FEE CONSISTENCY

| Item | Value | Source |
|---|---|---|
| Measured sponsored transfer | 603 NRG → 4.325 CCD | TASK55 (live rate 7172.7136 microCCD/NRG) |
| Recommended integration budget | 25 CCD | TASK56/TASK58 |
| Maximum fee cap | 10 CCD (`FACILITATOR_MAX_FEE_MICROCCD` default 10 000 000) | config.ts |
| Maximum energy | 1000 NRG (`FACILITATOR_MAX_ENERGY` default 1 000) | config.ts (TASK55) |
| Account creation cost | ~0.1 CCD, paid by creator | Concordium docs |
| Cap consistency | 1000 × 8000 (conservative) = 8 CCD ≤ 10 CCD | verified |

Enforcement: `sdkSponsorSigner.validateSponsorContext` rejects `energy > maxEnergy` and
`feeMicroCcd > maxFeeMicroCcd` before signing. `core.ts` derives energy from the transaction
itself (never client-supplied). Wire converter rejects `energy > maxExecutionEnergy`. All three
caps agree (1000 NRG). Verified by TASK55 tests D09–D14.

## 6. TRANSACTION LIFECYCLE READINESS (TASK59)

- Terminal `rejected` requires 2 consistent rejection observations (`REJECTION_CONFIRMATIONS_REQUIRED = 2`).
- `finalized` success is never overwritten by a later rejection.
- `received` / `committed` / `unknown` / transport error / timeout → non-terminal.
- Recovery: two concurrent workers cannot bypass the gate (SQLite `BEGIN IMMEDIATE`).
- `summary.failed` counts only confirmed terminal rejections.
- Limitations documented: per-pass (not time-separated) confirmation, single-node, no manual
  override, `prepared` rows not recovered.

## 7. MAINTAINER EXECUTION CHECKLIST

1. Install Concordium Wallet for Web (or mobile) — **not** the Desktop Wallet.
2. Confirm network = Testnet (upper-right corner).
3. Create the sponsor account; confirm it appears on chain.
4. Obtain the public address.
5. Run `npx tsx scripts/task58-verify-sponsor-account.mts <address>` — expect EXISTS,
   threshold 1, 1 Ed25519 credential, balance > 0.
6. Export private key → Export to file (single-account JSON).
7. Transfer the file to the signing-service host only; `chmod 600`.
8. Fund the account (~25 CCD via faucet).
9. Re-run the verifier to confirm the balance.
10. Start `npx tsx scripts/task57-wallet-service.mts <sock> <sponsor> <caip2> <uid> <export-path>`.
11. Confirm socket `0o660`, service user owns it, `signer=loaded`.
12. Configure facilitator env vars; keep `FACILITATOR_MODE=real` gated.
13. Apply TASK55 code fixes (B3, B4, confirming-evidence rule).
14. Run focused + full test suites; confirm `DENY_ALL_FACILITATOR` and settlement default
    remain disabled.
15. Obtain explicit maintainer approval before any signing or broadcast.

## 8. BLOCKERS AND REQUIRED CORRECTIONS

| # | Blocker | Owner | Status |
|---|---|---|---|
| B1 | Sponsor account not provisioned/funded | maintainer | open |
| B2 | No production key-custody path (only test harness) | maintainer | open |
| B3 | Submitter injection (TASK55) | code | **fixed** |
| B4 | grpc evidence client class (TASK55) | code | **fixed** |
| GAP E | Confirming-evidence rule (TASK59) | code | **fixed** |
| — | Production secret injection for signing service | code/maintainer | open (test harness uses env) |
| — | TASK56 Desktop Wallet recommendation corrected | docs | corrected in TASK58 |

**Required correction to TASK56:** replace "Concordium Wallet (desktop) export" with
"Concordium Wallet for Web / mobile — Export private key → Export to file". The Desktop Wallet
encrypted backup and LEDGER-based keys are not usable by `loadWalletExportSigner`.

## 9. RECOMMENDED NEXT BOUNDED TASK

Maintainer performs the section-7 checklist (wallet creation, export, funding, signing-service
startup) in a controlled environment, then a **dry-run rehearsal** through the full pipeline
using the fake transport (no broadcast) to confirm the end-to-end path before any real
transaction.

## CONSTRAINTS HONOURED

No account or wallet created. No credentials or keys generated. No wallet material opened,
imported, exported, or inspected. No seed phrase, private key, or wallet export requested. No
faucet used. No account funded. No signing, construction, submission, broadcast, or
finalization. No real facilitator settlement activated. `DENY_ALL_FACILITATOR` and the
settlement default remain disabled. Token 1004 and its Agent Card untouched. No production
source code modified. No commits or pushes.
