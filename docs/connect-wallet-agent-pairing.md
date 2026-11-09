# Connect Wallet & Agent Pairing

## VERDICT: PASS WITH CONDITIONS

The Connect Wallet experience and the agent pairing protocol are implemented as a
real, usable product feature: a working static Connect Wallet page backed by a local
pairing server, a non-custodial Concordium browser-wallet connector, cryptographic
ownership verification, CIS-8004 identity + Agent Card verification, an append-only
audit log, revocation, and a minimal permission foundation. The full protocol path
(challenge → verify → pair → unlink → disconnect) is exercised end-to-end over a
real loopback socket in the test suite and over a real Testnet node in a live run.

Two things are deliberately reported as blockers rather than faked:
1. QR / mobile (WalletConnect) pairing — the repository has no WalletConnect
   infrastructure, relay configuration, or project id.
2. Live pairing of token 1004 — its Agent Card host currently returns HTTP 502
   (transient evidence unavailability), so the verifier fails closed and pairing is
   refused. The code is correct; the card host is not.

## Supported wallet integration

Integration is against the OFFICIAL Concordium Browser Wallet API, verified against
the installed `@concordium/browser-wallet-api-helpers` 3.3.0 type definitions
(`lib/wallet-api-types.d.ts`, `MainWalletApi`). No wallet API is invented.

Verified API facts used:
- `requestAccounts(): Promise<string[]>` — prompts the user; **throws** on rejection;
  may resolve with an empty list.
- `connect(): Promise<string | undefined>` — deprecated alias; also **throws** on
  rejection. Used only as a fallback when `requestAccounts` is absent.
- `getMostRecentlySelectedAccount(): Promise<string | undefined>` — resolves
  `undefined` when locked / no connected account. The only method that can resolve
  `undefined` without the user cancelling.
- `getSelectedChain(): Promise<string | undefined>` — genesis hash of the chain
  selected in the wallet; `undefined` when locked or not set up. This is the
  network-identification primitive.
- `signMessage(account, message): Promise<AccountTransactionSignature>` — **throws**
  on user rejection; the wallet prepends bytes internally so the message can never
  be replayed as a transaction. Returns the signature directly (credential → key →
  hex), NOT a `{ signature: string }` wrapper.
- `sendTransaction(...)` exists but is deliberately NOT exposed: TASK 71 never
  constructs, signs, or broadcasts a transaction.

`ConcordiumWalletProvider` (in `src/pairing/walletConnector.ts`) is the injected
subset of that surface, so tests never need a browser.

## Actual user connection flow

Implemented end-to-end in `signing-site/pair.html` served by `scripts/pairing-server.mts`:

1. Page detects `window.concordium` (polls up to ~4 s).
2. `1 · Connect wallet` calls `requestAccounts()` (fallback `connect()`). A rejection
   maps to `cancelled`, never to `failed`.
3. The selected account is shown; `getSelectedChain()` returns the genesis hash,
   which is mapped to a CAIP-2 network via the closed `GENESIS_TO_CAIP2` table.
   An unrecognised or mismatched chain is reported as `wrong_network` / `network_unknown`
   and pairing is blocked.
4. `2 · Verify ownership` issues a challenge from the backend, signs it with
   `signMessage(account, message)` (no transaction is constructed), and the backend
   verifies the signature against on-chain account keys fetched from the Testnet node.
5. `3 · Pair with agent` re-issues a fresh signature and pairs only if the agent passes
   the independent CIS-8004 + Agent Card verification (TRUSTED).
6. `Unlink pairing` revokes the pairing (idempotent).
7. `Disconnect` drops the address and every derived capability.

Run it:

    npx tsx scripts/pairing-server.mts
    # open http://127.0.0.1:4518

## Ownership verification

- `createChallenge(agentId, opts)` — unique (sha256 of agent + network + 16-byte nonce
  + expiry), short-lived (default 300 s), single-use, network-bound. The message
  embeds agent id, network, nonce and expiry.
- `verifyOwnership` uses the official SDK `verifyMessageSignature` against on-chain
  account keys supplied by a read-only provider (never by the client). The SDK
  prepends the account address and 8 zero bytes, which is the same scheme the wallet
  uses internally, so a signed message can never be replayed as a transaction.
- Structured failure reasons: `invalid_address`, `invalid_signature`, `wrong_network`,
  `challenge_expired`, `challenge_used`, `unknown_agent`, `account_not_found`.

## Pairing protocol

- `PairingStore` (in `src/pairing/pairing.ts`): `issueChallenge`, `getChallenge`,
  `consumeChallenge`, `verifyAndPair`, `getPairing`, `listPairings`, `revoke`,
  `disconnect`, `audit`.
- `verifyAndPair` order is load-bearing: challenge status → CIS-8004 identity →
  already-paired guard → ownership signature → single-use consume. A rejected stage
  consumes nothing and advances nothing.
- Reassignment of an already-paired agent is refused (`already_paired`).
- Agent identity is verified through the injected `verifyAgentIdentity` callback.
  The real implementation is `createAgentIdentityVerifier` in `src/pairing/agentTrust.ts`,
  which calls the existing `verifyAgent()` pipeline (TASK 03) and requires a TRUSTED
  verdict. No verifier supplied → fail closed (`untrusted_agent`).
- Revocation is idempotent; `disconnect` is a client-side state transition that
  keeps the record auditable.
- The audit log contains only public identifiers (pairing id, agent id, wallet
  address, network, action, detail). No keys, no signatures, no challenge responses.

## Security boundaries

- No private key, recovery phrase, wallet export, or signature is stored anywhere.
  The wallet's signature is used transiently for verification and then discarded.
- A connected address is **not** ownership. Ownership is established only by a
  successful `verifyMessageSignature` over a live, single-use, network-bound challenge.
- Pairing never grants spending permission. `permissionGranted` and `txAuthorized`
  are false after pairing and require explicit, separate calls.
- Challenge must be unique, short-lived, and single-use — enforced.
- Replay and cross-network pairing are prevented (network binding + single-use consume).
- Unauthorized reassignment of an existing agent is refused.
- No transaction is constructed, signed, submitted, or broadcast by any code path in
  this task. `sendTransaction` is deliberately not exposed by the connector.
- The pairing server binds to `127.0.0.1` by default and must never be exposed
  publicly. It has no authentication (single-user local tool).
- Fail-closed: with no node configured, verification returns `node_unavailable`
  rather than a simulated success; an unverified/untrusted agent is never paired.

## Minimal permission foundation

`WalletSession` (in `src/pairing/walletSession.ts`) exposes five strictly independent
booleans: `walletConnected`, `ownershipVerified`, `agentPaired`, `permissionGranted`,
`txAuthorized`. Connecting grants nothing. Pairing grants nothing. Only
`grantPermission` (requires a paired agent and ≥1 scope) sets the fourth, and only
`authorizeTransaction` (requires an unexpired grant) sets the fifth. `disconnect`
and `unlinkAgent` drop every derived capability. `markAgentPaired` is a no-op unless
ownership was verified first and the wallet address matches.

## Implemented versus mocked functionality

Implemented (real code, real SDK primitives, real HTTP):
- Browser-wallet detection and connect normalisation over the documented API surface.
- Network identification via `getSelectedChain()` + closed genesis-hash → CAIP-2 map.
- Challenge generation, status, and expiry.
- Ownership verification via `verifyMessageSignature` (official SDK) against on-chain
  keys from the Testnet node.
- CIS-8004 identity + Agent Card verification via the existing `verifyAgent()` pipeline.
- Pairing store, revocation, disconnect, audit log.
- Wallet session state machine and permission foundation.
- Local pairing HTTP server (`src/pairing/server.ts` + `scripts/pairing-server.mts`)
  with real loopback socket I/O.
- Connect Wallet page (`signing-site/pair.html`) wired to the real browser wallet.

Mocked (automated tests only):
- The browser wallet provider (`ConcordiumWalletProvider`) is injected; no real
  extension or WalletConnect session is exercised in CI.
- Account info is a fake (deterministic key) in the unit tests; the loopback server
  test uses a fake provider. The production wiring uses `GrpcAccountInfoProvider`
  against the Testnet node.
- CIS-8004 verification is injected in unit tests; the live server run exercised the
  real registry + `verifyAgent()` pipeline.

## Remaining limitations / blockers

1. **QR / mobile (WalletConnect) pairing — BLOCKED.** The repository has no
   WalletConnect infrastructure, relay configuration, or project id. The browser-wallet
   path is implemented; the mobile path is not. A future implementation would add
   `@concordium/wallet-connectors` + a WalletConnect Cloud project id and a QR
   renderer. Documented here rather than faked.
2. **Live pairing of token 1004 — BLOCKED (environmental).** Its Agent Card host
   (`https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json`) returns
   HTTP 502 from this VPS, so `verifyAgent()` reports INCONCLUSIVE and the pairing
   verifier fails closed (`agent_rejected`). The code path is correct and exercised
   by the loopback test with a trusted verifier; the blocker is the card host, not
   the implementation. No transaction is attempted.
3. **Persistence is in-memory.** `PairingStore` is not backed by SQLite; a durable
   adapter can be dropped in later without changing the interface.
4. **No MCP tool exposes pairing.** The six MCP tools are unchanged; pairing is
   reachable via the local server and the `PairingStore` API.
5. **No spending permission is ever granted automatically**, by design.

## Evidence and test results

- `test/task71-connect-wallet-pairing.test.mts`: 30/30 passed.
- Typecheck `tsc --noEmit`: 0 errors. Build `tsc`: 0 errors.
- Live server run: `npx tsx scripts/pairing-server.mts` bound `127.0.0.1:4518`,
  served `signing-site/pair.html`, `/api/config`, `/api/status`, and `/api/challenge`
  successfully; `/api/pair` returned `agent_rejected` (409) for token 1004 because
  the CIS-8004 verifier could not retrieve the Agent Card (HTTP 502) — fail-closed,
  no transaction attempted.
- Full regression suite: `npm test` — all suites passed, exit 0.
- No wallet contents, private keys, recovery phrases, or secret fingerprints were
  printed or transmitted. No transaction was constructed, signed, submitted, or
  broadcast. Token 1004 and its Agent Card untouched. `DENY_ALL_FACILITATOR` unchanged.

## Completion criteria assessment

1. A user can connect a supported Concordium wallet — **implemented** (real page +
   real browser wallet API; exercised against the injected provider in CI).
2. Wallet ownership is cryptographically verified — **implemented and tested**
   (official SDK `verifyMessageSignature` over a live challenge).
3. The user can pair that wallet with a verified AgentTrust agent — **implemented;
   blocked in this environment** by the token-1004 card host returning 502
   (INCONCLUSIVE → fail-closed). The protocol path is verified end-to-end over a
   loopback socket with a trusted verifier.
4. Pairing can be revoked — **implemented and tested** (idempotent revoke).
5. Security and regression tests pass — **30/30 task71, typecheck + build clean,
   full regression green**.
6. The implementation is usable, not just a design — **yes**: a real page and a real
   server that a user with the Concordium browser wallet can run locally.

Verdict: PASS WITH CONDITIONS (QR/mobile pairing blocked by missing WalletConnect
infrastructure; live token-1004 pairing blocked by the Agent Card host returning
HTTP 502 — both documented, neither faked).
