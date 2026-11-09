# TASK 58 — Sponsor Wallet Provisioning Runbook

## VERDICT: PASS WITH CONDITIONS

The read-only verification path is built and validated against live Testnet data. The
maintainer-executable procedure is ready. Two conditions: (1) the wallet-export format was
corrected relative to TASK56 (the Desktop Wallet encrypted backup is **not** what the SDK
accepts — see section 2), and (2) provisioning itself remains a maintainer action.

## 1. EXECUTIVE RECOMMENDATION

Create the sponsor account with **Concordium Wallet for Web** (browser extension) or
**Concordium Wallet** (mobile), then use **Export private key → Export to file** to produce a
single-account JSON key file. Feed that file to `loadWalletExportSigner(path)` via
`scripts/task57-wallet-service.mts`.

Do **not** use the Desktop Wallet's encrypted "Export/Import" backup: it is password-protected
and is not the format `parseWallet` accepts. The Desktop Wallet also uses a LEDGER device, so
its keys are not exportable as a plain key file — unsuitable for unattended server-side signing.

## 2. OFFICIAL WALLET CREATION INSTRUCTIONS

Verified against official Concordium documentation (docs.concordium.com) and the installed
SDK 12.0.2.

### Correct export format (SDK 12.0.2 `parseWallet` requirements)

`parseWallet(walletString)` (lib/esm/signHelpers.js) requires:
- `type` — string (e.g. `"concordium-browser-wallet-account"`)
- `v` — number (e.g. `0`)
- `environment` — string (e.g. `"testnet"`)
- `value.address` — string
- `value.credentials` — object
- `value.accountKeys` — defined (object with `threshold` and `keys`)

Documented single-account export shape (from Concordium's multi-sig documentation):

```json
{
  "type": "concordium-browser-wallet-account",
  "v": 0,
  "environment": "testnet",
  "value": {
    "accountKeys": {
      "threshold": 1,
      "keys": { "0": { "threshold": 1, "keys": { "0": { "signKey": "<hex>", "verifyKey": "<hex>" } } } }
    },
    "credentials": { "0": "<credential-id hex>" },
    "address": "<base58check>"
  }
}
```

### Recommended procedure (Concordium Wallet for Web)

1. Install the Concordium Wallet for Web extension.
2. **Confirm the network is Testnet.** The network is shown in the upper-right corner; switch
   to Testnet before creating the account. (The Desktop Wallet equivalent is the Testnet build
   connecting to a Testnet node on port 20001.)
3. Create a new wallet (seed phrase) and a new account. The account is created on chain when
   the identity issuance completes.
4. **Confirm the account is fully created:** it appears in the Accounts list and is visible on
   a public explorer / the read-only verification script.
5. **Obtain the public address:** Accounts page → the account address (base58check). This is
   the only value the facilitator needs.
6. **Export the private key file:** Accounts → the account → **Export private key** → enter
   passcode → **Export to file**. The file is a JSON in the shape above and is compatible with
   `concordium-client` (per official docs) and with the SDK's `parseWallet`.

### Alternative (Concordium Wallet mobile)

Same flow: account settings (gear) → **Export private key** → Reveal → passcode → **Export to
file**.

### Not recommended

- **Desktop Wallet "Export/Import" backup** — encrypted, password-protected, and not the
  `parseWallet` format. Also requires a LEDGER device for signing.
- **Desktop Wallet "Export a key → Account credentials"** — produces a multi-sig credentials
  file, not a single-account key file.

## 3. EXACT ACCOUNT CONFIGURATION

| Property | Required value |
|---|---|
| Network | Concordium Testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`) |
| Account type | Standard Concordium account |
| Credentials | 1 (single Ed25519 credential) |
| Account threshold | 1 |
| Credential threshold | 1 |
| Signing scheme | Ed25519 |
| Address | base58check, 45–55 chars |

The TASK57 loader enforces account threshold === 1 and every credential threshold === 1, and
requires at least one credential with at least one key.

## 4. READ-ONLY VERIFICATION

Script: `scripts/task58-verify-sponsor-account.mts`

```
npx tsx scripts/task58-verify-sponsor-account.mts <base58check-address>
```

Checks (all read-only, live Testnet):
- address shape (base58check)
- genesis hash match (testnet identity)
- account existence
- credential count and scheme
- account + credential thresholds
- balance
- nonce

Validated against live Testnet:
- Existing account `4dWn8miA…evZg4d` → `EXISTS`, threshold 1, 1 credential Ed25519,
  balance 19943.619923 CCD, nonce 4, `ready for TASK57 loader : YES`.
- Non-existent account `4EfgogKP…aPdQuT5` → `NOT FOUND`.
- Malformed address → `INVALID`.

All checks use the existing read-only gRPC integration (`ConcordiumGRPCNodeClient`,
`getConsensusStatus`, `getAccountInfo`). No writes.

## 5. FUNDING AND BALANCE VERIFICATION PLAN

Recommended integration budget: **25 CCD**.

- Approximate account creation cost: ~0.1 CCD, paid by the creator (the faucet-funded account
  that creates the sponsor), **not** by the sponsor.
- Minimum balance for one sponsored simple transfer: ~4.33 CCD (TASK55 measured: 603 NRG at
  7172.7136 microCCD/NRG).
- The 25 CCD budget covers ~5 transactions at the 10 CCD worst-case cap, or ~6 at the measured
  4.33 CCD rate, with retry headroom.
- Verify incoming funds by re-running the verification script and confirming `balance > 0` and
  the expected amount.
- Reserve: keep at least 10 CCD unspent until the first transaction is confirmed; the
  `FACILITATOR_MAX_FEE_MICROCCD` cap (10 CCD) bounds any single transaction's fee.

Do not initiate funding. The maintainer requests the faucet transfer.

## 6. TASK57 INTEGRATION INSTRUCTIONS

The wallet export stays local to the signing-service host. The facilitator never sees it.

1. Copy the exported JSON file to the signing-service host only (e.g.
   `/etc/agenttrust/sponsor-wallet.json`).
2. Set ownership/permissions: `chown <service-user>:<authclients> <file>` and
   `chmod 600 <file>` (or `640` if the service user is in the group).
3. Start the signing service with the explicit export path:
   ```
   npx tsx scripts/task57-wallet-service.mts \
     /run/agenttrust/signing.sock \
     <sponsor-base58check-address> \
     ccd:4221332d34e1694168c2a0c0b3fd0f27 \
     <allowed-uid> \
     /etc/agenttrust/sponsor-wallet.json
   ```
   The loader runs **before** the socket is bound; a missing/malformed export or a
   signer-construction failure exits 1 and the service never starts.
4. Confirm the socket is `0o660` and owned by the service user.
5. Configure the facilitator with `FACILITATOR_SPONSOR_ADDRESS`, `FACILITATOR_SIGNING_SERVICE_SOCKET`,
   `FACILITATOR_SIGNING_SERVICE_UID`, and the node endpoint; keep `FACILITATOR_MODE=real`
   gated behind approval.
6. Verify the facilitator receives no wallet material: the IPC protocol carries only the
   32-byte digest; `loadWalletExportSigner` never returns or logs the export; the facilitator
   process has no read access to the export file.

## 7. SECRET HANDLING CHECKLIST

- [ ] Export file stored only on the signing-service host, never on the facilitator host.
- [ ] File permissions `0600`/`0640`, owner = service user.
- [ ] No copy in logs, shell history, CI artifacts, or chat.
- [ ] `loadWalletExportSigner` error messages contain no secret content (verified by TASK57).
- [ ] Signing service logs contain no export contents (only `signer=loaded`).
- [ ] Facilitator env contains no key material (only the sponsor public address).
- [ ] Delete the export file from the host after the service has started (the `AccountSigner`
      is in memory; the file is not re-read).
- [ ] Seed phrase / wallet private key stored separately from the export file (recovery).

## 8. MAINTAINER ACTION CHECKLIST

**Agent-verifiable (no action)**
- [x] Read-only verification script built and validated against live Testnet.
- [x] Export format confirmed against SDK 12.0.2 `parseWallet`.
- [x] Fee/energy model from TASK55 (603 NRG, 4.325 CCD, 7172.7136 microCCD/NRG).
- [x] TASK57 loader + launcher implemented and tested.

**Maintainer manual actions**
- [ ] Install Concordium Wallet for Web (or Concordium Wallet mobile).
- [ ] Confirm Testnet network.
- [ ] Create the sponsor account.
- [ ] Export the private key file (single-account JSON).
- [ ] Fund the sponsor account (~25 CCD).
- [ ] Provision the signing-service host/user/socket/UID.
- [ ] Start the signing service with the export path.
- [ ] Configure the facilitator env vars.
- [ ] Apply the TASK55 code fixes (B3, B4, confirming-evidence rule) and review.

**Approval-required**
- [ ] Create the wallet.
- [ ] Request faucet funding.
- [ ] Start the signing service with key material.
- [ ] Set `FACILITATOR_MODE=real`.
- [ ] First real sponsored transaction.

**Blockers before the first real transaction**
- [ ] B1 sponsor account provisioned + funded.
- [ ] B2 production key-custody path established.
- [ ] TASK55 code fixes applied.
- [ ] Confirming-evidence rule (GAP E) applied.
- [ ] Maintainer broadcast approval.

## 9. REMAINING BLOCKERS AND NEXT BOUNDED TASK

Blockers: B1 (sponsor account), B2 (production key custody), GAP E confirming-evidence rule,
production secret injection.

Next bounded task: maintainer performs section 8 manual actions, then a controlled
first-transaction rehearsal (dry-run through the full pipeline with the fake transport) before
any real broadcast.

## CONSTRAINTS HONOURED

No wallet or account created. No credentials or keys generated. No wallet material opened,
imported, exported, or inspected. No seed phrase, private key, or wallet export requested. No
faucet used. No account funded. No signing, construction, submission, broadcast, or finalization.
No real facilitator settlement activated. `DENY_ALL_FACILITATOR` and the settlement default
remain disabled. Token 1004 and its Agent Card untouched. No production source code modified
(the verification script is additive). No commits or pushes.
