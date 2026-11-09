# TASK 46 — Facilitator Sponsor Signer IPC Wiring

Wires the existing `IpcAccountSigner` into Facilitator startup so real mode obtains sponsor
signatures from the dedicated signing service over the Unix socket built in TASK 43/44.

Fake signer only. No key material, no wallet, no funding, no transaction construction,
submission, or broadcast. Settlement is not activated and `DENY_ALL_FACILITATOR` is untouched.

## VERDICT

**PASS WITH CONDITIONS.**

Wiring is complete and every required failure path fails closed. The conditions are the
inherited TASK 43/44 limitations, restated in *REMAINING PREREQUISITES*: the only signer
reachable through this path is the deterministic fake, and broadcast is deliberately
unimplemented, so a successful IPC signature still produces `settlement_pending`, never
`success`.

## CHANGES

| File | Change |
|---|---|
| `services/facilitator/src/config.ts` | UID validation reordered so `0` fails with the root-specific message and out-of-range values fail with the range message. Both values were already parsed; the two error branches were previously unreachable in the wrong order (`0` matched the range test first). |
| `services/facilitator/src/signingService.ts` | `IpcAccountSigner.sign()` now settles exactly once (send-once discipline): a `settled` latch shared by success, every rejection, socket error, and a new `close` handler. A service that dies mid-request previously hung until the full timeout; it now rejects immediately with `signing service closed the connection before responding`. Added `probeSigningService()` — a connect-and-close reachability check used at startup; it does not sign and does not authenticate. |
| `services/facilitator/src/server.ts` | `startFacilitator()` fails closed in real mode when the signing-service socket is unreachable, before the HTTP server binds. No opt-out flag exists. |
| `test/task46-facilitator-sponsor-signer-wiring.test.mts` | Rewritten: 30 tests across config contract, signer construction, startup fail-closed, lifecycle against misbehaving sockets, cross-process signing, and the gateway invariants. |

No schema change. No change to `core.ts`, `sdkSponsorSigner.ts`, `wireConverter.ts`,
`senderVerifier.ts`, `ipcSponsorSigner.ts`, or `src/payments/**`.

## CONFIGURATION CONTRACT

| Variable | Mode | Rule |
|---|---|---|
| `FACILITATOR_SIGNING_SERVICE_SOCKET` | real | **Required.** Trimmed, non-empty, absolute path (`/…`). No default, no substitution. Absent or empty → `real mode requires FACILITATOR_SIGNING_SERVICE_SOCKET`. Relative → `must be an absolute Unix socket path`. |
| `FACILITATOR_SIGNING_SERVICE_UID` | real | **Required.** Integer 1–65533. `0` → `must not be 0 (root is rejected)`. Non-integer → `must be an integer UID between 1 and 65533`. Out of range → `…between 1 and 65533`. |
| both | mock | **Forbidden.** Either one set → `mock mode must not configure the signing service — the mock signer never uses IPC`. This keeps a stale config from pointing a mock at a real service. |
| `FACILITATOR_SIGNING_TIMEOUT_MS` | both | Optional, default `10000`, must be a positive number. |

Neither value is a secret; neither is logged. The only place the socket path reaches output is
the startup failure message (a filesystem path the operator supplied), and the UID never
appears in any log line.

## STARTUP FLOW

```
startFacilitator(env)
  ├─ loadConfig(env)                       ← throws on any rule above (real: both required)
  ├─ real mode only: probeSigningService(socket, timeoutMs)
  │     connect() → close(). No request, no signature, no peer auth.
  │     unreachable → throw ConfigurationError('<reason> (<socket>)')   [fail closed]
  ├─ real: createIpcSponsorSigner({socketPath, expectedUid, sponsorAddress, network, …})
  │     └─ new IpcAccountSigner(...)  → injected as the SDK AccountSigner
  │     └─ createSdkSponsorSigner({ accountSigner: ipcSigner, … })
  │           addSponsorSignature → Transaction.sponsor() → IpcAccountSigner.sign(digest)
  ├─ mock: createMockSigner / createLedgerSigner  (unchanged)
  ├─ sender verification wiring (unchanged, TASK 41: real requires `sdk`)
  ├─ new FacilitatorCore({ signer, … })     ← sponsor adapter + wire converter preserved
  └─ http server binds
```

Signing path per settlement:

```
validate → claim → SENDER VERIFY → authorize → recover → CONVERT → addSponsorSignature
   → (32-byte digest, 64 hex) → Unix socket → signing service → SO_PEERCRED
   → service validates sponsor/network/digest → fake signer → signature back
   → local hash → durable persist → submitTransaction  ← throws: not implemented
```

Only the digest crosses the boundary. The transaction never does. The service validates
`sponsor`/`network` against **its own** config, so client-supplied values are assertions, not
instructions.

## VERIFIED

Each item below is backed by a named test in
`test/task46-facilitator-sponsor-signer-wiring.test.mts`; all 30 pass.

1. **Mock mode backward-compatible** — A01 (no signing config needed, default timeout), C02
   (mock `/healthz` still reports `mode: mock`, `canSign: false`).
2. **Real mode requires socket + UID** — A04, A05; malformed values rejected by A06, A07, A08,
   A09; valid values accepted and never defaulted by A10.
3. **Valid configuration constructs `IpcAccountSigner`** — B02: the signer built from a valid
   config is driven through a real socket. A silent listener is used on purpose, so the
   assertion (`signing service timeout`) proves the call left the process; a local signer
   would have returned a signature without any socket.
4. **Fake signature through the IPC path** — E02: two real OS PIDs (facilitator-side client,
   `scripts/task44-service.mts`), sponsor signer called once, sponsored hash durably recorded.
5. **Missing service fails closed** — C01 and E03: `startFacilitator` refuses with
   `signing service unreachable: …`.
6. **Timeout fails closed** — D01.
7. **No local signing fallback** — B02/B03/E02/E03 plus D01–D05: every failure rejects.
   `IpcAccountSigner.sign()` has no branch that returns a signature it did not receive.
8. **Sender verification still enforced** — E05: `invalid_signature` from the verifier produces
   `sender_verification_failed`, signer call count `0`, empty transaction hash — with the IPC
   signer wired in and a live service.
9. **`DENY_ALL_FACILITATOR` intact** — F01: `verify` and `settle` both throw.
10. **Settlement disabled by default** — F02: `guardSettlement({allowSettlement:false})` returns
    `SETTLEMENT_DISABLED`.
11. **Service exit, invalid response, foreign request ID, refused connect** — D02, D03, D04, D05.
12. **UID mismatch refused by SO_PEERCRED** — E04: a service configured with the wrong allowed
    UID answers `protocol_error / unauthorized_peer`; the client surfaces
    `signing service refused: unauthorized_peer`. The *service* refuses, not the client.
13. **Clean shutdown** — E06: SIGTERM stops the service, the process is gone, and the next
    signing attempt rejects (`unavailable|timeout|closed the connection`).
14. **Startup probe honesty** — D06: reports reachable on a live listener and `unreachable` once
    it closes; sends no request and returns no signature.

## NOT TESTED

- **Real signature validity.** `createFakeSigner()` returns a fixed hex string. No verification
  path can distinguish it from a real Ed25519 sponsor signature, and none is attempted.
- **Real settlement.** `submitTransaction` and `waitForFinalization` throw by design in this
  mode, so no payment can complete. E02 asserts `settlement_pending` and explicitly *not*
  `success`.
- **A service running as UID 1005** (the TASK 34.6/34.17 design target). The harness runs as
  UID 1001 because that is the only non-root account available; UID-mismatch behaviour is
  exercised by configuring the service with an *unexpected* allowed UID (E04).
- **Group-only authorization.** SO_PEERCRED checks UID, not supplementary groups. The socket is
  `0660 owner:authclients`; group membership is an access precondition, not an identity check.
  Unchanged by this task.
- **Root rejection at the client.** `peer.uid === 0` is rejected inside the service; the client
  cannot observe it without a root-owned service, so it is unverified here.
- **Live gRPC sender verification.** E05 injects a failing verifier; a successful `sdk`
  verification against Testnet is TASK 38/39 scope and needs network access.
- **Replay across service restart.** Replay state is in-memory by design; the durable
  authorization gate remains the authority.

## BLOCKED

Nothing blocked the wiring. Two behaviours are **not supported by the current implementation**
and were documented rather than expanded:

1. **`IpcAccountSigner` does not verify the peer UID itself.** `expectedUid` is carried in the
   options but the client cannot read peer credentials on its own connected socket without a
   native helper; SO_PEERCRED is enforced server-side by the service. The client's
   `expectedUid` is therefore a *configured expectation*, not a local check. E04 proves the
   refusal comes from the service. Making the client assert it too would require a second
   native helper and is out of scope.
2. **No startup handshake.** The probe confirms the socket accepts connections. It cannot
   confirm the service will accept *this* UID's requests, because a probe that sends a signing
   request would itself be a signing attempt. A failed peer check therefore surfaces on the
   first settlement request, not at boot.

## TEST RESULTS

```
dedicated suite (uid 1001 + group authclients):
  npx tsx test/task46-facilitator-sponsor-signer-wiring.test.mts
  task46: 30/30 passed, 0 failed

full repository suite (npm run build && npm test):
  60 suites total, 59 PASS, 1 FAIL
  FAIL  task14-audit-strictness.test.mts   17/18 — "15. concurrent writers keep one chain
        with strict validation on"
```

`task14` is a known concurrency flake in this repository: re-run standalone it reports
`18/18 passed`. No file under `src/` was modified by this task (see *CONSTRAINT AUDIT*), and
that suite does not touch the facilitator, so the failure is unrelated to TASK 46.

TASK 46 loads and passes inside the default runner: 24 of its 30 tests need no privileges, and
the six cross-process ones self-skip cleanly when uid 1001 + group authclients are absent.

## TYPECHECK RESULTS

```
(cd services/facilitator && npx tsc -p tsconfig.json --noEmit)   rc=0
npx tsc --noEmit                                                rc=0
```

## HEAD BEFORE/AFTER

```
before: 4c8994db391d77796e06e49c843c42be1eae615b
after : 4c8994db391d77796e06e49c843c42be1eae615b   (no commits, no push)
```

Working tree only. Files touched: `config.ts`, `signingService.ts`, `server.ts`, the TASK 46
test file, this document.

## CONSTRAINT AUDIT

| Constraint | Status |
|---|---|
| Fake signer only | OK — `createFakeSigner()` in the harness; no other signer exists in this path. |
| No wallet creation or import | OK — no wallet API is called anywhere in the diff. |
| No private-key access/generation/export/real signing | OK — `IpcAccountSigner` and `createSdkSponsorSigner` take an injected `AccountSigner`; neither accepts key material. B04 asserts the signer object exposes no key-shaped property. |
| No sponsor funding or faucet | OK — untouched. |
| No transaction construction, submission, broadcast | OK — `submitTransaction` throws (`never broadcasts`); B03 asserts every chain method refuses. |
| No Mainnet | OK — `loadConfig` still refuses Mainnet; `KNOWN_NETWORKS` still omits it. |
| No real facilitator activation | OK — real mode cannot settle (no broadcast) and no process was left running. |
| No real payment or settlement | OK — E02 asserts `settlement_pending`, never `success`. |
| `DENY_ALL_FACILITATOR` intact | OK — F01. |
| Settlement disabled by default | OK — F02; no config flag was added. |
| Token 1004 / Agent Card untouched | OK — no file under contracts, fixtures, or evidence was modified. |
| No schema change | OK — none needed; `sign_events` is unchanged. |
| No unrelated infrastructure hardening | OK — the only behavioural change outside wiring is the client-side settle-once/close handler, which is required for the "service exits during a request" lifecycle case. |
| No commits or pushes | OK — HEAD unchanged. |

## REMAINING PREREQUISITES

Signing **for real** requires all of the following, none of which this task performs:

1. A dedicated signing-service process owned by a `signer` UID, with socket `signer:authclients`
   0660, started under a process supervisor. No systemd unit exists.
2. An `AccountSigner` inside that process backed by a key it holds — the facilitator never sees
   it. Today the only implementation is `createFakeSigner()`.
3. A funded Testnet sponsor account, plus `sponsor()`-compatible account credentials.
4. A real `submitTransaction` / `waitForFinalization` implementation in the sponsor signer
   boundary. Deliberately absent; adding one is a separate task with its own crash-safety and
   idempotency review.
5. Maintainer approval to move from fake to real signer, and a decision on whether the client
   should also assert the peer UID locally.
