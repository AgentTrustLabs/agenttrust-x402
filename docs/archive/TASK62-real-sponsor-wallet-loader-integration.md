# TASK 62 — Real Sponsor Wallet Loader Integration

## VERDICT: PASS

The sponsor account (TASK61: PASS) is verified. The maintainer-supplied export
`/home/ubuntu/Downloads/3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK.export` was loaded
successfully, injected into the signing service, and its key proven to correspond to the
on-chain credential. All TASK62 conditions are cleared: the export is at `~/.agenttrust/sponsor.export`, mode 0600, owner ubuntu, and loads successfully.

## EXPORT FILE LOCATED AND SECURED

```
/home/ubuntu/.agenttrust/sponsor.export
496 bytes | mode 0600 | owner ubuntu:ubuntu
```

Moved (not copied) from `/home/ubuntu/Downloads/3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK.export`
(the source is gone). Directory `/home/ubuntu/.agenttrust/` is mode 0700.

Contents were read only by the loader and by the structural checks; **no key material appears in
this report or in any log**.

## WALLET FORMAT COMPATIBILITY

**The maintainer's real export is accepted by `loadWalletExportSigner` / `parseWallet`.**

```
ok  04. loadWalletExportSigner constructs a signer
```

Format probe (`scripts/task60-export-format-probe.mts`, 14/14) establishes which shapes the
SDK accepts:

- `concordium-browser-wallet-account` / `concordium-wallet-account` single-account export →
  **accepted** by `parseWallet` and by `loadWalletExportSigner`.
- Bare `{address,credentials,accountKeys}` → rejected by `parseWallet` (use `parseSimpleWallet`
  + `buildAccountSigner` for that shape).
- Desktop Wallet encrypted backup → rejected. Multi-sig credentials file → rejected.
  Bare private-key hex → rejected.

## SIGNATURE COUNT

```
ok  05. getSignatureCount() === 1 — observed 1
```

The real export carries exactly one credential with exactly one key, so `buildAccountSigner`
produces one signature per digest. `getSignatureCount()` returns `1n`.

## SPONSOR ADDRESS MATCH

```
ok  06. export address === TASK61 sponsor — export=3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK
ok  07. account threshold === 1
ok  08. every credential threshold === 1 — observed [1]
```

### Cryptographic correspondence with the on-chain account

Stronger than a string comparison — the export was checked against the live Testnet account:

| Check | Result |
|---|---|
| Export `verifyKey` equals the on-chain credential key for credential 0, key 0 | **true** |
| Export `credentials['0']` equals the on-chain `credId` | **true** |
| A digest signature from the loaded signer verifies against the on-chain `AccountInfo` (`verifyAccountSignature`) | **true** |
| Signature length | 64 bytes (Ed25519) |
| On-chain `accountThreshold` / credential 0 threshold | 1 / 1 |

This proves the export really controls the TASK61 sponsor account, not merely that the address
string matches.

## SIGNING SERVICE STARTUP

```
ok  09. signing service bound the configured Unix socket
```

Launcher (`scripts/task57-wallet-service.mts`) loads the export **before** binding; a missing
file exits 1 and never binds:

```
$ npx tsx scripts/task57-wallet-service.mts /tmp/t62-x.sock <sponsor> <caip2> 1001 /tmp/does-not-exist.json
failed to load wallet export: wallet export file could not be read
$ ls /tmp/t62-x.sock → No such file or directory
```

## LOCAL DIGEST-SIGNING TEST (supported, non-broadcast)

```
ok  10. IPC digest signing returns a signature — credentials=[0]
ok  11. wrong sponsor is refused — signing service refused: wrong_sponsor
```

`IpcAccountSigner.sign()` was called with an **all-zero 32-byte dummy digest** — not a
transaction digest. The resulting signature was discarded. No transaction was constructed or
submitted. A mismatched sponsor is refused fail-closed.

## SECRET EXPOSURE INSPECTION

| Check | Result |
|---|---|
| Directory `/home/ubuntu/.agenttrust/` mode | `700` ✅ |
| Export file mode | `600` ✅ |
| Export file owner | `ubuntu:ubuntu` ✅ |
| Not group-writable / world-readable | ✅ |
| No key hex in report text | ✅ |
| Loader returns only a signer (no export echo) | ✅ |
| IPC payload contains only the 32-byte digest | ✅ (protocol, unchanged) |
| Service log emits only `signer=loaded` | ✅ |

The export was **moved** out of `Downloads/` (a shared, world-traversable directory), not copied.
No duplicate of the key material remains at the original path.

## NOT TESTED

- Restart / reboot persistence of the loaded signer (the export is read once at startup; the
  file is not re-read).
- On-chain submission (out of scope — no broadcast, no signing of transactions).

## BLOCKED

**None for TASK62.**

Open items outside TASK62 scope:

1. **Production secret injection.** The signing service currently receives the export path as a
   CLI argument. A production deployment should use a secret store or a systemd-tmpfiles-style
   mount rather than a plain path on disk.
2. **B1/B2** (sponsor provisioning is done; production key custody / service hardening remains
   a maintainer decision).
3. **Settlement stays disabled.** `DENY_ALL_FACILITATOR` and the settlement default are
   unchanged; the first real transaction still requires explicit maintainer approval.

## METHOD NOTE

Script: `scripts/task62-sponsor-loader-integration.mts` (additive; production source unmodified).
Synthetic mode (`--synthetic`) proves the loader → service → IPC → digest-sign path for the
TASK61 address; real mode (this run) proves the maintainer's export loads, signs, and matches
the on-chain credential.

## CONSTRAINTS HONOURED

Export contents were never printed, copied, or transmitted. No wallet credentials changed. No
transaction constructed, signed, submitted, broadcast, or settled. No funding or faucet. No real
facilitator settlement activated. `DENY_ALL_FACILITATOR` and the settlement default remain
disabled. Token 1004 and its Agent Card untouched. No sudo used (the file was owned by ubuntu
and the move was within the same filesystem). No commits or pushes. Production source unmodified.
