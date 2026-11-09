# TASK 57 — Local Sponsor Wallet Secret Loading

## VERDICT

**PASS.**

A bounded, fail-closed wallet-export loader was implemented in the signing-service process.
It reads a local wallet-export file, validates its shape and thresholds, constructs an SDK
`AccountSigner` via `parseWallet` + `buildAccountSigner`, and injects it into the existing
signing service without changing the IPC protocol. The facilitator never sees the export, the
seed, or any credential material. Synthetic fixtures only — no real wallet material was used.

## 1. SDK API EVIDENCE

Verified against `@concordium/web-sdk@12.0.2`:

- `parseWallet(walletString: JsonString): WalletExportFormat` — `signHelpers.d.ts`
- `buildAccountSigner(walletExport: WalletExportFormat): AccountSigner` — `signHelpers.d.ts:82`
- `buildAccountSigner<T extends WithAccountKeys>(value: T): AccountSigner` — `:91`
- `buildAccountSigner(keys: SimpleAccountKeys): AccountSigner` — `:100`
- `buildAccountSigner(key: HexString): AccountSigner` — `:109`
- `buildBasicAccountSigner(privateKey: HexString): AccountSigner` — `:73` (threshold-1 only)
- `AccountSigner` interface: `sign(digest: ArrayBuffer): Promise<AccountTransactionSignature>`,
  `getSignatureCount(): bigint`.
- `WalletExportFormat`: `{ type, v, environment, value: SimpleWalletFormat }` where
  `SimpleWalletFormat = { address, accountKeys: { threshold, keys: { credIdx: { threshold, keys: { keyIdx: { signKey, verifyKey } } } } }, credentials: { credIdx: HexString } }`.

The loader imports from the root `@concordium/web-sdk` (which re-exports `signHelpers`).

## 2. IMPLEMENTATION OVERVIEW

New file: `services/facilitator/src/walletExportLoader.ts`

- `loadWalletExportSigner(path, deps?)` → `AccountSigner`
- `WalletExportError` — generic error type; messages never contain file contents, parsed
  credentials, keys, or signatures.
- Validation performed:
  - path must be a non-empty string
  - file must be readable (generic "could not be read")
  - export must parse (generic "could not be parsed")
  - `value` must be an object with a non-empty `address`
  - `accountKeys` must exist with `threshold >= 1` and at least one credential
  - each credential must have `threshold >= 1` and at least one key
  - (default policy) account threshold === 1 and every credential threshold === 1
  - constructed signer must expose `sign` and `getSignatureCount`
- `build` is wrapped in try/catch → generic "signer construction failed"
- Dependency injection: `readFile`, `parseWallet`, `buildAccountSigner`, `requireThresholdOne`
  (tests inject test doubles; production uses the real SDK)

New file: `scripts/task57-wallet-service.mts`
- Signing-service launcher that calls `loadWalletExportSigner(exportPath)` BEFORE binding
  the socket. A failure exits 1 with a generic message; the service never starts. The IPC
  protocol is unchanged.

No production source code was modified except the new loader module. `signingService.ts`,
`ipcSponsorSigner.ts`, `sdkSponsorSigner.ts`, and `server.ts` are untouched.

## 3. CONFIGURATION REQUIRED BY THE SIGNING-SERVICE PROCESS

```
npx tsx scripts/task57-wallet-service.mts \\
  <socket-path> <sponsor-address> <network-caip2> <allowed-uid> <wallet-export-path>
```

- `<wallet-export-path>`: absolute path to the Concordium Wallet export JSON, readable only by
  the service user.
- The export is read once at startup; the file is not re-read per request.
- Socket permissions: `0o660`, owner = service user, group = `authclients`.
- UID authorization: SO_PEERCRED via `scripts/task348-peercred`, `peer.uid === allowedUid`,
  root rejected.

Facilitator env (unchanged from TASK55): `FACILITATOR_MODE=real`,
`FACILITATOR_SPONSOR_ADDRESS`, `FACILITATOR_SIGNING_SERVICE_SOCKET`,
`FACILITATOR_SIGNING_SERVICE_UID`, node endpoint, sender verification = sdk, durable DB path.

## 4. SECRET ISOLATION AND FAILURE BEHAVIOR

- The wallet export is read inside the signing-service process only.
- Nothing from the export (address, credentials, keys, signatures) is logged, returned in
  errors, or echoed. Error messages are generic (`"wallet export file could not be read"`,
  `"could not be parsed"`, `"signer construction failed"`).
- The facilitator continues to send only the 32-byte digest over IPC.
- `loadWalletExportSigner` throws `WalletExportError` on any failure; there is no fallback
  signer. The service does not start.
- Missing path / missing file / malformed export / unsupported threshold / builder throw →
  all fail closed with a generic message.

## 5. TEST RESULTS

Focused suite `test/task57-local-sponsor-wallet-secret-loading.test.mts`: **27/27 passed, 0
failed**.

Coverage:
- Valid synthetic export reaches the injected parser/builder (01–06).
- SDK signer construction succeeds with a test double (07–08).
- Missing export path fails closed (09–10).
- Missing file fails closed (11–12).
- Malformed export fails closed (13–14).
- Unsupported credential/threshold fails closed (15–19).
- Secret content never appears in logs or returned errors (20–21).
- Signing service signs with the loaded signer (22–23).
- Signing service does not start when load fails (24–25).
- Real integration: launcher + synthetic export starts the service and the IPC client
  obtains a signature (verified manually, not in the automated suite, to avoid leaving a
  background process).

End-to-end verification performed (not part of the automated suite):
- `scripts/task57-wallet-service.mts` started with a synthetic export →
  `service listening ... signer=loaded`, socket `0o660`.
- `IpcAccountSigner.sign()` over the socket returned a signature with key `0`.

Full suite: **68 suites, 0 failed** (clean run after the task14 environmental flake settled;
`EXIT=0`).

Build and typechecks:
```
npm run build                                                    rc=0
npx tsc --noEmit                                                 rc=0
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)    rc=0
```

## 6. WHAT REMAINS UNTESTED

- Real SDK parsing of an actual Concordium Wallet export file. The synthetic fixture matches
  the `WalletExportFormat` shape, and the loader delegates to the real `parseWallet` /
  `buildAccountSigner` in production, but no real export was available (and none was requested).
- Threshold > 1 accounts (the loader rejects them by policy; a future variant could support
  multi-sig sponsors via `buildAccountSigner` without the threshold-one restriction).
- The launcher has no automated test (it is a thin wrapper over the loader + service, verified
  manually).
- No test exercises the `readFile` default against a real filesystem path in CI beyond the
  missing-file case (the valid case uses an injected reader).

## 7. MANUAL STEPS THE MAINTAINER MUST PERFORM LATER

1. Install the Concordium Wallet (desktop) and create a Testnet sponsor account.
2. Export the account (wallet export JSON).
3. Securely transfer the export to the signing-service host (never to the facilitator).
4. Fund the sponsor account (~25 CCD recommended).
5. Start the signing service with
   `npx tsx scripts/task57-wallet-service.mts <sock> <sponsor> <network> <uid> <export-path>`.
6. Verify the socket is `0o660` and the service user owns it.
7. Configure the facilitator env vars and keep `FACILITATOR_MODE=real` gated behind maintainer
   approval.
8. Delete the export file from the host after the service has started (the `AccountSigner` is
   in memory; the file is not re-read).

## 8. EXPLICIT STATEMENT

No real wallet or key was used in this task. The synthetic fixture contains only placeholder
hex strings (`aa`, `bb`, `cc` repeats). No private key was generated, imported, exported,
logged, or accessed. No signing of a real transaction occurred (the IPC test signed a 32-byte
zero digest with a synthetic key, producing a synthetic signature that was never submitted).
No account was provisioned or funded. No faucet request was made. No transaction was constructed,
submitted, or broadcast. No Mainnet was contacted. Token 1004 and its Agent Card are untouched.
`DENY_ALL_FACILITATOR` and the settlement default remain disabled. No commits or pushes.
