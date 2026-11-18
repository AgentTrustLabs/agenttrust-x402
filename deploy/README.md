# AgentTrust x402 — deployment definitions

Reproducible deployment for the real-mode backend: Owner authorization,
sponsor signing service, facilitator, and the public x402 resource server.
Run `deploy/recover-deployment.sh` as root from a checkout of this repo to
rebuild the deployment after a VM replacement. Nothing in this directory is
executed by this task itself; these are definitions, validated by shell and
unit checks only.

## Layout

| Piece | Path | Owner / mode |
|---|---|---|
| Code | `/opt/agenttrust` (rsync from this repo) | root, world-readable |
| Facilitator + resource server user | `agenttrust` (uid 1101) | group `agenttrust` |
| Owner user | `agenttrust-owner` (uid 1102) | group `agenttrust` |
| Signing service user | `agenttrust-signing` (uid 1103) | group `agenttrust` |
| Service homes | `/home/agenttrust`, `/home/agenttrust-owner`, `/home/agenttrust-signing` | 0750, per-user |
| Env files | `<home>/.agenttrust/{owner,signing,facilitator,resource}.env` | 0600, per-service user |
| IPC sockets | `/var/lib/agenttrust/sockets/{authz,sign}.sock` | 2770, root:`agenttrust` (setgid) |
| Owner private dir | `/home/agenttrust-owner/.agenttrust/authz-dir/` (`authz.db`, `owner.log`) | 0700, `agenttrust-owner` |
| Settlement DB | `/home/hatch/agenttrust-state/facilitator.db` (+ `-wal`/`-shm`) | 0644, `agenttrust` (Owner reads it read-only) |
| Discovery DB | `/home/hatch/agenttrust-state/discovery.db` (+ `-wal`/`-shm`) | 0600, `agenttrust` |
| Owner key | `/home/hatch/agenttrust-state/owner-authorization-key.pem` | 0600, `agenttrust-owner` (created by that user; see below) |
| Wallet exports | `/home/hatch/.agenttrust/*.export` (durable copies, never touched) | 0600, root |
| Sponsor export (service copy) | `/home/agenttrust-signing/.agenttrust/sponsor-3xRV448Q.export` | 0600, `agenttrust-signing` |

Only `/home/hatch` survives a VM replacement. Everything else (code, users,
homes, sockets, units) is recreated by the recovery script; the databases,
the Owner key and the wallet exports persist.

## Startup order

`agenttrust-owner` → `agenttrust-signing` → `agenttrust-facilitator` →
`agenttrust-resource`. The units enforce it with `Requires=` + `After=`:
signing requires the Owner socket, the facilitator requires both sockets,
the resource server requires the facilitator. Stop order is the reverse
(systemd handles it). The recovery script starts in the same order and
waits for each readiness condition (socket exists, `/healthz` ok, 402 on
`/protected`, 200 on `/api/services`).

## Bootstrap a fresh host (before the first recovery run)

The recovery script's preflight (step 0d) requires the Owner key to exist
before step 2 creates the service users — so on a fresh host, create the
users manually first. These are the exact commands the recovery script
itself uses (same UIDs, group, shell, homes, and locked accounts):

  sudo groupadd -g 1101 agenttrust
  sudo useradd -u 1101 -g agenttrust -s /usr/sbin/nologin -M -d /home/agenttrust agenttrust
  sudo useradd -u 1102 -g agenttrust -s /usr/sbin/nologin -M -d /home/agenttrust-owner agenttrust-owner
  sudo useradd -u 1103 -g agenttrust -s /usr/sbin/nologin -M -d /home/agenttrust-signing agenttrust-signing
  sudo passwd -l agenttrust
  sudo passwd -l agenttrust-owner
  sudo passwd -l agenttrust-signing

Verify with `id agenttrust agenttrust-owner agenttrust-signing` and
`getent group agenttrust` (gid 1101). The home directories are created by
the recovery script in step 3 (`-M` matches what the script uses). If the
users already exist with different UIDs, the recovery script refuses to
proceed — fix them before re-running. Generate the Owner key next (step 2
below), then run the recovery script.

## Before the first run (operator actions)

1. **Verify the production signing launcher passes Owner authorization.**
   `scripts/sponsor-wallet-service.mts` reads `SIGNING_OWNER_PUBLIC_KEY` /
   `SIGNING_OWNER_SOCKET` / `SIGNING_OWNER_UID` and passes
   `{ publicKey, consume: new IpcOwnerConsumeClient(...) }` to
   `createSigningService` (which throws at construction without it), exactly
   as `scripts/signing-service.mts` (the test harness) does. The recovery
   script's preflight gate checks for `ownerAuthorization` in the launcher
   and refuses to deploy if the wiring is ever regressed.
2. **Generate the Owner key once** (never by the recovery script). The key
   lives in the state directory, not in `/home/hatch/.agenttrust/`: the Owner
   launcher requires the key file to be mode 0600 **and owned by the Owner
   UID**, and `chown` is blocked on the `/home/hatch` subvolume (verified:
   `Operation not permitted` even as root), so a root-created file there
   would stay root-owned and the Owner would refuse to start. The key must
   be created **by the Owner user itself**, in the group-writable state
   directory (the file itself is 0600, so only the Owner can read it). As
   root, after the `agenttrust-owner` user exists (see Bootstrap above), from
   the repo checkout:
   `runuser -u agenttrust-owner -- node_modules/.bin/tsx scripts/generate-owner-key.mts /home/hatch/agenttrust-state/owner-authorization-key.pem`.
   Run it from the repo checkout, not from `/opt/agenttrust` — that directory
   only exists after a recovery run (run `npm ci` in the checkout first if
   `tsx` is missing). The script refuses to overwrite an existing file. Regenerating the key
   later changes the Owner identity and requires re-pinning the public key
   (the recovery script derives the hex from the key file each run).
3. **Set the production inputs** at the top of `deploy/recover-deployment.sh`:
   `PUBLIC_URL` (required) and `CORS_ORIGINS` (exact origin(s), no
   wildcards; may stay empty for a local-first run, with CORS disabled).
4. **Create the Vercel project** for the frontend and put its exact origin
   in `CORS_ORIGINS` before exposing the frontend.

## Proxy credential

The facilitator's gRPC client reaches the Testnet node only through the
runtime egress proxy. The credential is session-scoped and rotates, so
refresh it **immediately before every facilitator start or restart** — the
recovery script does this in its own step via
`deploy/refresh-proxy-credential.sh`, which probes the stored credential
first and swaps it only when proven dead. Run the helper standalone
(`--check` to probe only, `--force` to rotate a working one) after any
facilitator restart triggered outside the recovery script. Never on a
timer: a stored credential that still probes valid must not be churned.
The helper never prints credential values and never stores them in the repo.

## Environment variables (names only)

**Owner** (`owner.env`): `AUTHZ_AUTHORIZATION_KEY_FILE`, `AUTHZ_SETTLEMENT_DB_FILE`,
`AUTHZ_DB_FILE`, `AUTHZ_SIGNING_SERVICE_UID`, `AUTHZ_SPONSOR_ADDRESS`,
`AUTHZ_NETWORK`, `AUTHZ_MAX_ENERGY`, `AUTHZ_MAX_EXPIRY_OFFSET_SECONDS`,
`AUTHZ_ALLOWED_ASSETS`, `AUTHZ_POLICY_VERSION`, `AUTHZ_OWNER_LOG`,
`AUTHZ_OWNER_PEERCRED_BIN`.

**Signing** (`signing.env`): `FACILITATOR_SPONSOR_WALLET_FILE`,
`FACILITATOR_SIGNING_SERVICE_SOCKET`, `FACILITATOR_SPONSOR_ADDRESS`,
`FACILITATOR_NETWORK`, `FACILITATOR_SIGNING_SERVICE_UID`,
`SIGNING_OWNER_PUBLIC_KEY`, `SIGNING_OWNER_SOCKET`, `SIGNING_OWNER_UID`.

**Facilitator** (`facilitator.env`): `FACILITATOR_MODE`, `FACILITATOR_NETWORK`,
`FACILITATOR_HOST`, `FACILITATOR_PORT`, `FACILITATOR_SPONSOR_ADDRESS`,
`FACILITATOR_PENDING_TTL_MS`, `FACILITATOR_REPLAY_TTL_MS`,
`FACILITATOR_DB_PATH`, `FACILITATOR_DB_FILE_MODE`, `FACILITATOR_RECONCILE_ENABLED`,
`FACILITATOR_OPERATOR_TOKEN_SHA256` (only when reconcile is enabled),
`FACILITATOR_BUSY_TIMEOUT_MS`, `FACILITATOR_EVIDENCE_MODE`,
`FACILITATOR_NODE_HOST`, `FACILITATOR_NODE_PORT`, `FACILITATOR_NODE_USE_TLS`,
`FACILITATOR_AUTHZ_SOCKET`, `FACILITATOR_SENDER_VERIFICATION`,
`FACILITATOR_SENDER_VERIFY_TIMEOUT_MS`, `FACILITATOR_SIGNING_SERVICE_SOCKET`,
`FACILITATOR_SIGNING_SERVICE_UID`, `FACILITATOR_SIGNING_TIMEOUT_MS`,
`FACILITATOR_MAX_FEE_MICROCCD`, `FACILITATOR_MAX_ENERGY`,
`FACILITATOR_SPONSOR_WALLET_FILE`, `FACILITATOR_RECOVER_ON_STARTUP`,
`FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS`, plus the proxy variables
(`https_proxy` etc., managed by the refresh helper, never committed).

**Resource server** (`resource.env`): `AGENTTRUST_X402_HOST`,
`AGENTTRUST_X402_PORT`, `AGENTTRUST_X402_FACILITATOR_URL`,
`AGENTTRUST_X402_FACILITATOR_MODE`, `AGENTTRUST_X402_PUBLIC_URL` (required),
`AGENTTRUST_CORS_ORIGINS`, `AGENTTRUST_DISCOVERY_DB`,
`AGENTTRUST_AGENT_CARD_FILE` (optional override; default is the repo's
`signing-site/.well-known/agent-card.json`). Never set
`AGENTTRUST_X402_ALLOW_MOCK` in production.

## Shutdown and recovery limitations

- The **facilitator has no SIGTERM/SIGINT handler**: systemd stop kills it
  abruptly. SQLite WAL is crash-safe, and the settlement DB survives, but
  no graceful flush happens. Startup recovery (`FACILITATOR_RECOVER_ON_STARTUP`)
  and reconciliation (`FACILITATOR_RECONCILE_ENABLED` + operator token) are
  both **off by default** and stay off in these definitions — enabling them
  is an operator decision with real consequences (recovery replays pending
  rows; reconcile can finalize ambiguous settlements). A restart after a
  crash leaves pending rows unreconciled unless the operator enables them.
- The **resource server and the Owner and signing service do handle SIGTERM**
  gracefully (the resource server closes its registry and HTTP server; the
  Owner closes its server and databases). All units run `tsx` directly, never
  `npx`, so the signal reaches the node process.
- The **replay store is in-memory** in both the provider and the signing
  service: a restart forgets consumed payments. For the public descriptor
  service that only re-unlocks the same descriptor (the facilitator settle
  is durable and idempotent — no second CCD moves). A durable replay store
  is required before any scarce or expensive service.
- The **sponsor fee is an estimate** (`FACILITATOR_MAX_FEE_MICROCCD` caps the
  estimated fee, not the measured on-chain fee). The energy cap is the hard
  bound.
- The settlement DB is shared across UIDs at **0644** (the Owner must read
  it; the config rejects any group/world-write bit). The discovery DB is
  **0600 owned by `agenttrust`**: the store tightens permissions to 0600 on
  every open, so group sharing does not work for it — ownership is the
  mechanism, and the recovery script fails loudly if an existing file is
  not writable by its service user.
