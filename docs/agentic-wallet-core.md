# AgentTrust Agentic Wallet Core

## VERDICT: PASS WITH CONDITIONS

Dedicated per-agent wallets are implemented end to end: an owner-authorized,
idempotent, concurrency-safe provisioning flow; durable SQLite persistence that
survives restart (including revoked state); independent Ed25519 signing identities
held behind a key boundary that never exposes private keys; lifecycle and funding
states; a signing method bound to wallet + agent + owner + network + parameters;
and explicit integration with the `PermissionManager` (provisioning grants
nothing).

One production capability is explicitly **disabled and documented**, not faked: a
real on-chain Concordium account cannot be created without deploying a credential
(a transaction), which the task forbids. Provisioning therefore creates local key
material and records `accountAddress = null` with status `awaiting_funding`; the
on-chain address is supplied later by the owner after deployment. The wallet is
never marked `active` merely because local keys were generated.

## Architecture and data model

```
agent pairing ──┐
verified owner ──┼─► AgenticWalletManager.provision(owner, agent, network)
                 │     1. verify owner signature over a wallet challenge
                 │     2. require an active agent pairing
                 │     3. idempotency lookup (owner, agent, network)
                 │     4. WalletKeyStore.ensure(walletId)      ← private key stays here
                 │     5. persist wallet (accountAddress=null, awaiting_funding)
                 │     6. return wallet + WalletSigner (public surface only)
permissions ► pause/resume/revoke propagate to PermissionManager
SQLite WalletStore  ► durable metadata + lifecycle events (no keys)
```

`AgenticWallet` (in `src/pairing/walletStore.ts`), persisted as `agent_wallets`:

| Field | Meaning |
|---|---|
| `walletId` | `w_` + 24 hex chars (sha256 of owner:agent:network:time) |
| `agentId` | CIS-8004 token id |
| `ownerWalletAddress` | verified owner account (from Connect Wallet) |
| `network` | CAIP-2, explicit |
| `genesisHash` | full 64-hex genesis hash, explicit |
| `accountAddress` | **null until the on-chain account exists** (see blocker) |
| `signingPublicKeyHex` | 32-byte Ed25519 public key (hex) |
| `status` | `provisioned` \| `awaiting_funding` \| `active` \| `paused` \| `revoked` \| `recovery_required` |
| `fundingStatus` | `unknown` \| `unfunded` \| `funded` |
| `balanceMicroCcd` | observed balance (string; BigInt internally) |
| `createdAt` / `updatedAt` | unix seconds |

Unique index `(owner_wallet_address, agent_id, network)` — this **is** the
idempotency key. A second provisioning for the same tuple returns the existing
wallet and never creates a second signing identity.

## Provisioning flow

1. Owner connects + verifies their wallet (`verifyMessageSignature`).
2. Owner selects an active, trusted, paired agent (agent pairing store).
3. `AgenticWalletManager.provision` re-verifies the owner over a **wallet-specific
   challenge** (`AgentTrust wallet\nowner=…\nagent=…\nnetwork=…\naction=provision…`).
4. The challenge is consumed only after verification succeeds; a failed signature
   does not burn it, a successful one can never be replayed.
5. An active agent pairing for `(owner, agent, network)` is required.
6. Idempotency: if `(owner, agent, network)` already has a wallet, it is returned
   with `created: false`. Concurrency: an in-flight set keyed by the same tuple
   makes concurrent callers wait and then return the persisted wallet — the test
   proves exactly one wallet id under `Promise.all`.
7. `WalletKeyStore.ensure(walletId)` generates (or reuses) an Ed25519 keypair.
8. The wallet is persisted with `accountAddress: null`, `status:
   awaiting_funding`, `fundingStatus: unknown`.
9. The owner receives the wallet id, public key, network, and genesis hash. The
   on-chain account address is **not** fabricated.

**Never `active` on provisioning.** `active` is reached only through
`recordFunding(walletId, balance)` with `balance > 0` — an explicit, owner-supplied
observation. The code contains no chain query and no transaction construction.

## Signing and key custody boundaries

`src/pairing/walletSigner.ts`:

- `WalletSigner` exposes exactly `{ walletId, publicKeyHex, signDigest }`. The
  test asserts `Object.keys(signer).sort() === ['publicKeyHex','signDigest','walletId']`
  and that neither the signer nor the wallet record contains any `private|seed|mnemonic`
  material.
- Two stores: `InMemoryWalletKeyStore` (tests) and `FileWalletKeyStore`
  (mode-0600 file under a protected directory). Both return a `WalletSigner`; the
  private key is held in memory inside `makeSigner` and never returned.
- `signDigest` signs the given bytes with Ed25519. It does **not** construct a
  transaction.

`AgenticWalletManager.signDigest` binds every request before signing:

1. wallet exists;
2. `agentId` matches the wallet (`agent_mismatch`);
3. `ownerWalletAddress` matches (`owner_mismatch`);
4. `network` matches (`wrong_network`);
5. status is not `revoked` / `paused` / `recovery_required`;
6. if a `PermissionManager` is wired, `isPaymentAllowed` must pass
   (`permission_denied` / `per_tx_limit_exceeded` / …);
7. only then is `WalletSigner.signDigest` called.

Arbitrary agent-supplied signing requests are rejected: the caller supplies only a
digest and parameters; the manager resolves the key from its own store and validates
every binding. No endpoint accepts a private key or a raw key file.

**Custody limitation (documented, not production-ready):** the current boundary is
in-process. For production, the signer should be moved behind the existing IPC
pattern (`services/facilitator/src/signingService.ts` / `task348-owner.mts`) so the
key never resides in the same process as the agent-facing API. That migration is
explicitly **not** done here; the manager is structured so the `WalletKeyStore`
dependency can be replaced by an IPC client without changing callers.

## Persistence model

SQLite via `node:sqlite` — the same primitive `services/facilitator` already uses,
so no new dependency and no native build.

- `agent_wallets` — wallet metadata (no keys). Upsert updates
  `account_address`, `status`, `funding_status`, `balance_micro_ccd`, `updated_at`.
- `wallet_events` — append-only audit (`wallet_provisioned`, `funding_recorded`,
  `wallet_paused`, `wallet_resumed`, `wallet_revoked`, `wallet_signed`). Contains
  public identifiers and truncated digests only.
- Writes use `BEGIN IMMEDIATE` + `COMMIT` (with rollback), so lifecycle changes are
  atomic.
- Restart: reopening the same file restores wallets, statuses, and revoked state.
  Verified by tests 06/07 using a temp-file DB and two manager instances.
- Storage errors throw; `provision` catches and returns
  `{ok:false, reason:'storage_unavailable'}` — fail closed, never an in-memory
  fallback.

## Wallet lifecycle

```
provisioned ──► awaiting_funding ──(balance>0)──► active
                     │                             │
                     │                             ├──► paused ──(resume)──► active
                     │                             │
                     └──► revoked (terminal, key deleted)
paused / active ──► revoked (terminal)
any non-terminal ──► recovery_required
```

- `provision` → `awaiting_funding` (never `active`).
- `recordFunding(balance>0)` → `active` + `funded`; `balance==0` → `awaiting_funding` + `unfunded`.
- `pause` → `paused`; `resume` → `active` if funded else `awaiting_funding`.
- `revoke` → `revoked`; deletes the key material; invalidates permissions.
- `revoked` is terminal for signing.

## Owner funding workflow

There is **no automatic CCD transfer** and no faucet call. The owner funds the
account out of band; the wallet records the observation via `recordFunding`. The UI
distinguishes:

- **locally provisioned** — `awaiting_funding`, `fundingStatus: unknown`;
- **on-chain account existence** — `accountAddress !== null` (owner-supplied);
- **funded** — `fundingStatus: funded` with a balance;
- **active** — `status: active`.

A wallet that has local keys but no on-chain address is never presented as
existing on chain.

## Permission integration

- `AgenticWalletManager` accepts an optional `PermissionManager`.
- **Provisioning never grants a permission.** Test 12 asserts
  `permissions.getPermission(owner, agent, network) === undefined` after
  provisioning and that payment is denied with `no_permission`.
- `pause(walletId)` calls `permissions.pausePermission(owner, agent, network)`.
- `resume(walletId)` calls `permissions.resumePermission(...)`.
- `revoke(walletId)` calls `permissions.revokePermission(...)` **and**
  `permissions.invalidateWallet(owner)`.
- `signDigest` runs `permissions.isPaymentAllowed(...)` before signing, so the
  spending limits, allowlist, network binding, and approval policy all apply to
  wallet operations. Test 13 proves a `per_tx_limit_exceeded` blocks the sign.
- Reservations, approvals, and spending limits are untouched.

## API / UI behavior

`scripts/pairing-server.mts` wires `AgenticWalletManager` and `WalletStore`
(path from `AGENTTRUST_WALLET_DB`, default `signing-site/../wallets.db`). Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/wallets?owner=` | list the owner's wallets |
| GET | `/api/wallet?walletId=` | one wallet + recent events |
| POST | `/api/wallet/challenge` | issue the provisioning challenge |
| POST | `/api/wallet/provision` | owner-authorized provisioning |
| POST | `/api/wallet/control` | `pause` / `resume` / `revoke` (each needs a fresh signed challenge) |

`signing-site/pair.html` gained an **Agent wallet (the agentic wallet manager)** card showing wallet
id, lifecycle, funding, account address (or "pending on-chain deployment"),
network, on-chain status, and wallet history, with provision / copy / pause /
resume / revoke actions. Every value is read back from the backend; the control
actions re-verify the owner signature server-side.

## Tested versus mocked

**Implemented and tested (offline, no transaction):**
- Independent wallet per agent, independent signing identities (tests 01, 11).
- Owner-agent-wallet association, network/genesis binding (02, 09, 18).
- Owner authorization, invalid/expired/replayed challenge (03, 04, 18, 19).
- Idempotent + concurrent provisioning (05).
- Restart persistence, revoked-state persistence (06, 07).
- Funding status vs on-chain existence (08).
- Signing binding to wallet/agent/owner/network (09).
- Paused/revoked cannot sign (10).
- Signature verifies against the public key; no private-key leakage (11).
- the permission layer: no auto-permission (12), limits enforced (13), pause/revoke invalidates
  permissions (14), owner unlink invalidates permissions (15).
- Storage unavailable fails closed (16).
- No transaction submission during provisioning (17).

**Mocked in tests:** the key store is in-memory (`InMemoryWalletKeyStore`); the
SQLite store uses a temp file for restart tests and `:memory:` otherwise.

**Not exercised with real hardware:** a real Concordium browser extension was not
available on this host, so the UI's popup-signing flow was not completed
interactively. The page's signing call is the same `signMessage` API verified
verified against the official SDK types.

## Remaining production limitations

1. **On-chain account creation is out of scope and disabled.** A real Concordium
   account requires deploying a credential (a transaction). The task forbids
   transactions, so provisioning stops at local key material with
   `accountAddress = null` and status `awaiting_funding`. The on-chain address must
   be supplied by the owner after deployment. **This capability is not faked.**
2. **Key custody is in-process.** The `FileWalletKeyStore` protects the key at rest
   (mode 0600) but the signing key lives in the same process as the HTTP server.
   Production should move signing behind the existing IPC signing service; the
   dependency seam is in place but the migration is not done.
3. **No balance query.** `recordFunding` is an observation, not an on-chain read.
   A future integration could query the node, but it is not implemented here.
4. **No credential/identity provisioning.** Concordium account creation needs an
   identity and a credential deployment; neither is implemented.
5. **No key rotation.** `recovery_required` is a status, but there is no
   rotation flow (new key + re-registration). Documented, not built.
6. **No automatic backup.** The `FileWalletKeyStore` writes a single file; no
   encrypted backup or recovery phrase is produced.
7. **No Agent Skills.** Out of scope by instruction (the agentic wallet manager is the wallet core only).

## Non-negotiables — confirmation

- CIS-8004 token 1004 and its Agent Card URI/hash: untouched.
- agent pairing and permission behavior: preserved; `task71` 30/30,
  `task72` 22/22.
- Sender and sponsor signing boundaries: untouched; no signing code modified.
- No private key, recovery phrase, or wallet export requested or stored through
  agent-facing APIs; the only key store is the local `WalletKeyStore`.
- No real Testnet account created, funded, or altered; no transaction constructed,
  signed, or broadcast.
- No CCD spending, no faucet operation, no unrestricted settlement.
- No automatic spending permission (test 12).
- No commits, no pushes.
