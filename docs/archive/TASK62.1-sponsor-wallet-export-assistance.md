# TASK 62.1 — Sponsor Wallet Export Assistance

## EXPORT_FOUND: NO

No maintainer-provided sponsor wallet export was found in the approved locations.

Metadata-only scan performed (filenames + sizes + mtimes; **no file contents were read, copied,
or transmitted**):

| Location | Result |
|---|---|
| `/etc/agenttrust/`, `/home/ubuntu/.agenttrust/`, `/run/agenttrust/`, `/opt/agenttrust/`, `/home/ubuntu/sponsor/`, `/home/ubuntu/.config/agenttrust/` | do not exist |
| `*.json` / `*.export` / `*.wallet` named like sponsor/wallet/export under `/home/ubuntu`, `/etc`, `/run`, `/opt`, `/tmp` | none (except a TASK57 test artifact — see note) |

**Note on `/tmp/t57-sdk-qxnZST/wallet.json` (metadata only: 443 bytes, mtime 2026-11-08 09:03,
mode 0664, directory owned by `ubuntu` with mode 0700):** this is a leftover TASK57 test
fixture (mtime matches the TASK57 test run; size matches the synthetic `aa`/`bb`/`cc` fixture).
It is **not** the sponsor export and its contents were not read. It can be removed by the
maintainer; no action required from the agent.

## EXPORT_GUIDANCE: verified steps (SDK 12.0.2)

Verified against the official Concordium documentation and the installed SDK 12.0.2
`parseWallet` contract (lib/esm/signHelpers.js). The export must be the single-account key
file, **not** the Desktop Wallet encrypted backup (that format is password-protected and is
rejected by `parseWallet`).

### Correct path: Concordium Wallet for Web (browser extension) or Concordium Wallet (mobile)

1. Install the Concordium Wallet for Web extension (or the mobile app).
2. Open the extension/app and **confirm the network is Testnet** (shown in the upper-right
   corner; switch before creating the account).
3. Create a new wallet (seed phrase) and a new account. Wait until the account appears in
   the Accounts list (on-chain creation completes).
4. Open **Accounts → the sponsor account**.
5. Tap/click **Export private key**.
6. Enter the wallet passcode and tap **Reveal**.
7. Tap **Export to file** (or "Copy key" → save manually as a `.json` file).
8. Save the file. Its contents must be a JSON object with `type`, `v`, `environment`, and
   `value.{address, credentials, accountKeys}` — the `concordium-browser-wallet-account` (web)
   or `concordium-wallet-account` (mobile) shape accepted by `parseWallet`.

### Verification (read-only, before handing the path to the agent)

```
npx tsx scripts/task58-verify-sponsor-account.mts 3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK
```

Expected: `EXISTS`, threshold 1, 1 Ed25519 credential, balance 20000 CCD.

### Do not use

- Desktop Wallet "Export/Import" backup (encrypted, password-protected, not parseWallet-compatible).
- Desktop Wallet "Export a key → Account credentials" (multi-sig credentials file, different schema).
- A bare 64-hex private key (not a wallet export; `parseWallet` rejects it).

## SAFE_DESTINATION: recommended path

On the signing-service host only (never on the facilitator host, never in Git):

```
/etc/agenttrust/sponsor-wallet.json
```

Ownership and permissions:

```
chown <service-user>:authclients /etc/agenttrust/sponsor-wallet.json
chmod 600 /etc/agenttrust/sponsor-wallet.json
```

The file is read once at service startup; the signing service does not re-read it. After the
service has started successfully, the maintainer may delete the file — the `AccountSigner`
is held in memory for the process lifetime.

## NEXT_MAINTAINER_ACTION

1. Complete the export steps above using Concordium Wallet for Web or mobile.
2. Save the file to the safe destination and set `chmod 600`.
3. Provide **only the local file path** to the agent through the approved local execution
   environment (never the file contents, seed phrase, or private key).
4. The agent will then run:
   ```
   npx tsx scripts/task62-sponsor-loader-integration.mts <export-path>
   ```
   and report the results.

Stop here. No TASK62 retry until the maintainer supplies the local export path. No wallet
material was requested, read, copied, or transmitted. No source changes, commits, or pushes.
`DENY_ALL_FACILITATOR` unchanged.
