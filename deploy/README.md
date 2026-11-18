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
4. **Create the Vercel project** for the frontend — see "Frontend on
   Vercel" below. Put its exact origin in `CORS_ORIGINS` before exposing
   the frontend.

## Frontend on Vercel

The Vercel project serves only static files. The API lives on the host
behind `https://api.sabokun.my.id/agenttrust` (the resource server and
facilitator deployed by the recovery script). Vercel does **not** deploy
the backend, and the recovery script does **not** deploy the frontend:
they are two separate deployments, connected only by the API base URL
below and by the backend's CORS allowlist.

### Project settings

- **Repository:** `AgentTrustLabs/agenttrust-x402` (this repo).
- **Root Directory:** `web`.
- **Build Command / Output Directory / Framework:** taken from
  `web/vercel.json` — `node build.mjs` / `dist` / framework `null`
  (Framework Preset "Other" in the dashboard). Do not override them
  with different values; the committed `vercel.json` is authoritative.

### Environment variable (build time)

Set in the Vercel project settings (Environment Variables), for every
environment whose deployments must call the API:

  AGENTTRUST_API_BASE_URL=https://api.sabokun.my.id/agenttrust

`web/build.mjs` reads this variable **at build time** and bakes it into
`dist/index.html` (replacing the `__AGENTTRUST_API_BASE_URL__`
placeholder). A value set or changed after a build does nothing to the
already-built output — redeploy (rebuild) after changing it.

If the variable is missing at build time, the build still succeeds, but
the placeholder is replaced with an empty string and the frontend falls
back to same origin: both API calls (`GET /protected` and
`GET /api/services`, via the `apiUrl()` helper in
`web/prototype-v5-6.html`) go to the Vercel origin, which serves only
static files, so they 404 and the UI reports the API as unavailable. A
malformed value (not an `http(s)` URL) fails the build loudly instead
(`build.mjs` throws).

### CORS: allow the Vercel origin on the backend

The browser enforces CORS, so the exact production Vercel origin must
be listed in the backend's allowlist — in two places, with the same
complete value:

1. **Source of truth** — `CORS_ORIGINS` at the top of
   `deploy/recover-deployment.sh` (line 80; see "Before the first run",
   step 3). The recovery script regenerates `resource.env` from this
   variable on every run (step 6), so a value set only in the live env
   file would be silently reverted by the next recovery.
2. **Live file** — `AGENTTRUST_CORS_ORIGINS` in
   `/home/agenttrust/.agenttrust/resource.env`, applied by restarting
   only the resource service (procedure below).

The same string must flow through all three carriers: the validated
`COMPLETE` (step 2), the script's `CORS_ORIGINS` (step 2, verified
identical to `COMPLETE` before continuing), and the live
`AGENTTRUST_CORS_ORIGINS` (step 4, verified by `grep` after the write).
If any of the three differs, stop and resolve it — a difference means
the next recovery would silently apply the wrong allowlist.

Do not re-run the full recovery script for a CORS-only change. The
script has no scope flag: it also re-syncs code from the working copy
with `--delete` (stopping all four services first if the code
changed), rebuilds, refreshes the egress proxy credential (which can
restart the facilitator), touches all four units and env files, and
refuses to run at all if any unrelated preflight fails (Owner key
mode/owner, durable export hashes, launcher gate). A one-line CORS
change does not need any of that.

  CORS_ORIGINS="<existing-origins>,https://<your-vercel-project>.vercel.app"

`<existing-origins>` is the allowlist from step 1 — the identical value
in both sources, or the explicitly resolved list if they conflicted;
if the allowlist is currently empty, drop the `<existing-origins>,`
prefix. Replace
`https://<your-vercel-project>.vercel.app` with the actual Production
origin shown by Vercel after the project is created — it is not known
until then, so no real origin is recorded here. Every entry must be
the exact origin, byte-for-byte: no trailing slash, no path, no
wildcard. `*.vercel.app` is rejected — the recovery script refuses a
wildcard, and the server's `parseCorsOrigins` also fails startup on
one. An origin that is not listed gets no `Access-Control-Allow-Origin`
header (a preflight answers 403), so the browser blocks the response
and the frontend cannot call the API.

#### Narrow CORS update procedure (as root, on the host)

What is already in the repo, and what is not: the file state (0600,
`agenttrust:agenttrust`), the atomic temp+chmod+chown+mv pattern, the
`parseCorsOrigins` validator, and the restart primitive are all
already in the source (`deploy/recover-deployment.sh` step 6 and its
`start_service`; `deploy/refresh-proxy-credential.sh`;
`src/x402/cors.ts`). The composed sequence itself is an operator
procedure — there is no dedicated CORS helper script. (The only
scripted paths are the full recovery and the proxy-only refresh
helper.) Run the steps in order, in the same shell session, and stop at
the first error; nothing below prints any env value except the CORS
list itself.

1. **Read both allowlists and compare them.** Only the two CORS lines
   are shown — no other env value is printed.

     grep '^CORS_ORIGINS=' deploy/recover-deployment.sh
     grep '^AGENTTRUST_CORS_ORIGINS=' /home/agenttrust/.agenttrust/resource.env

   - If the two values are identical (ignoring the variable name and
     the quotes around the script's value), that list is the starting
     point: the complete final list is every origin in it, plus the new
     one. Never write only the new origin — that silently drops every
     existing origin.
   - If the two values differ, **STOP. Do not proceed.** Do not merge
     them, do not take their union, and do not automatically pick one
     side. A difference means an origin may have been intentionally
     removed from one source — reintroducing it from the other would
     undo that removal. Determine the intended final allowlist
     explicitly, origin by origin: only origins the operator has
     confirmed should remain are preserved. Write the resolved list
     down before touching either file.

2. **Validate the complete final list, then set the source of truth.**
   The list is validated BEFORE either file is modified. Set `COMPLETE`
   to the final list from step 1 — the starting list plus the new
   origin, or the explicitly resolved list if the sources conflicted —
   keeping only origins the operator has confirmed should remain. Copy
   the existing origins from the step-1 output; do not retype them from
   memory.

   In an interactive shell, turn history expansion off first: `set +H`
   disables Bash history expansion for the current shell, so a `!` in
   the value is kept literally and reaches the guard below — which
   rejects it with a clear message — instead of being expanded (or
   erroring) at the assignment itself. Non-interactive shells already
   have it off; the command is harmless there.

     set +H
     COMPLETE="<existing-origins>,https://<your-vercel-project>.vercel.app"

   Guard first: the parser accepts a few characters that break shell
   quoting — `parseCorsOrigins` only checks that each entry is a bare
   origin, it does not reject `"`, `$`, backtick, `\`, or `!` — so
   reject them here, before the value is used in any quoted assignment.
   The check reads the literal value and allows normal origins:
   comma-separated multi-origin lists, ports, IPv6 (`[::1]`), and
   underscores. If it triggers, stop and re-check the origins; do not
   proceed to validation.

     if printf '%s' "$COMPLETE" | grep -q '["$`\\!]'; then echo "CORS list contains a shell-special character - stop and re-check the origins" >&2; exit 1; fi

   Then validate the guarded value with the same parser the server runs
   at startup; on a bad value this throws and the sequence stops here.

     (cd /opt/agenttrust && node_modules/.bin/tsx --eval "import { parseCorsOrigins } from './src/x402/cors.js'; console.log(JSON.stringify(parseCorsOrigins(process.argv[1])));" "$COMPLETE")

   Only after guard and validation both pass, edit the `CORS_ORIGINS`
   line at the top of `deploy/recover-deployment.sh` to that same
   validated string. This is the value future recoveries will regenerate
   `resource.env` from.

   Verify the edit before continuing: the script's assignment must be
   identical to `COMPLETE`, and the script must still parse. Neither
   check executes the recovery script — the first only reads the file,
   the second only checks its syntax.

     [ "$(grep '^CORS_ORIGINS=' deploy/recover-deployment.sh)" = "CORS_ORIGINS=\"$COMPLETE\"" ] || { echo "script CORS_ORIGINS does not match the validated list - fix it before continuing" >&2; exit 1; }
     bash -n deploy/recover-deployment.sh

3. **Back up the live env file.** The backup is created by root, so it
   is root-owned; the rollback step restores the service ownership and
   mode explicitly.

     cp /home/agenttrust/.agenttrust/resource.env \
        /home/agenttrust/.agenttrust/resource.env.bak.$(date +%Y%m%d)
     chmod 0600 /home/agenttrust/.agenttrust/resource.env.bak.*

4. **Write the validated list atomically.** `set -e` stops the sequence
   on any failure, and the trap removes the temp file, so a failed run
   never leaves the live file half-written or wrongly owned. The
   validator prints only the parsed CORS list.

     set -euo pipefail
     D=/home/agenttrust/.agenttrust
     # COMPLETE was set and validated in step 2. Refuse to continue if
     # it is missing (for example, this block run in a fresh shell) —
     # never write an empty or guessed list.
     : "${COMPLETE:?complete list not set — run step 2 first}"
     # Re-validate the same list before writing: the write must not
     # proceed on an unvalidated value.
     (cd /opt/agenttrust && node_modules/.bin/tsx --eval "import { parseCorsOrigins } from './src/x402/cors.js'; console.log(JSON.stringify(parseCorsOrigins(process.argv[1])));" "$COMPLETE")
     T=$(mktemp "$D/.resource.env.tmp.XXXXXX")
     trap 'rm -f "$T"' EXIT
     sed '/^AGENTTRUST_CORS_ORIGINS=/d' "$D/resource.env" > "$T"
     printf 'AGENTTRUST_CORS_ORIGINS=%s\n' "$COMPLETE" >> "$T"
     chmod 0600 "$T"
     chown agenttrust:agenttrust "$T"
     mv "$T" "$D/resource.env"
     trap - EXIT
     stat -c '%a %U:%G %n' "$D/resource.env"
     grep '^AGENTTRUST_CORS_ORIGINS=' "$D/resource.env"
     # stat must read: 600 agenttrust agenttrust
     # grep must show the complete list from step 1, including every
     # origin the operator confirmed should remain.

5. **Restart only the resource service.** No `daemon-reload`: the unit
   file is unchanged, and systemd reads `EnvironmentFile` at (re)start;
   the launcher reads the env file once at startup. No other service
   reads `AGENTTRUST_CORS_ORIGINS`, so nothing else needs restarting.

     systemctl restart agenttrust-resource.service

   The restart briefly takes the public API down (a few seconds) and
   resets the in-memory replay store: consumed payments are forgotten,
   but the facilitator settle is durable and idempotent, so no second
   CCD moves (see "Shutdown and recovery limitations").

6. **Verify.** The service must be active, the startup log must print
   the effective allowlist, and the API must answer the new origin —
   and still refuse an unlisted one.

     systemctl is-active agenttrust-resource.service
     journalctl -u agenttrust-resource.service --since '2 minutes ago' | grep 'cors: enabled for'
     # Positive: the new origin gets the header (expect HTTP 402).
     curl -s -D - -o /dev/null -H "Origin: https://<your-vercel-project>.vercel.app" \
       https://api.sabokun.my.id/agenttrust/protected
     # Positive, preflight: expect HTTP 204 with Access-Control-Allow-Origin,
     # Access-Control-Allow-Methods: GET, OPTIONS, and Access-Control-Allow-Headers:
     # X-PAYMENT, Content-Type.
     curl -s -D - -o /dev/null -X OPTIONS \
       -H "Origin: https://<your-vercel-project>.vercel.app" \
       -H "Access-Control-Request-Method: GET" \
       -H "Access-Control-Request-Headers: X-PAYMENT" \
       https://api.sabokun.my.id/agenttrust/protected
     # Negative: an unlisted origin gets NO Allow-Origin header
     # (expect HTTP 402 without it; a preflight would answer 403).
     curl -s -D - -o /dev/null -H "Origin: https://not-allowed.example" \
       https://api.sabokun.my.id/agenttrust/protected
     # If the allowlist had pre-existing origins, repeat the positive
     # check for each of them — the update must not have dropped any.

7. **Rollback.** If the restart fails or verification fails, restore
   the backup — and then explicitly restore the service ownership and
   mode, because the backup is root-owned (created by root with `cp`)
   and a plain `mv` would leave the live file root-owned instead of
   the reference state (0600, `agenttrust:agenttrust`). Also revert
   the `CORS_ORIGINS` line in `deploy/recover-deployment.sh` to its
   previous value, so the next recovery does not re-apply the reverted
   change.

     D=/home/agenttrust/.agenttrust
     mv "$D/resource.env.bak.YYYYMMDD" "$D/resource.env"
     chown agenttrust:agenttrust "$D/resource.env"
     chmod 0600 "$D/resource.env"
     stat -c '%a %U:%G %n' "$D/resource.env"
     # must read: 600 agenttrust agenttrust
     systemctl restart agenttrust-resource.service
     systemctl is-active agenttrust-resource.service
     # (Use the exact backup name created in step 3.)

### Preview deployments

Each Vercel Preview deployment gets its own unique origin, different
from Production (shown in the Vercel dashboard for that deployment).
Because the allowlist is exact-match only, a Preview origin that needs
the API must be added to `CORS_ORIGINS` explicitly (and the resource
server restarted — same narrow procedure as above) — otherwise its API
calls fail CORS exactly like an unlisted Production origin. If a preview
does not need the API, leave it unlisted.

## Reverse proxy (nginx, inbound)

The public API `https://api.sabokun.my.id/agenttrust/*` is served by nginx
on the host, proxying to the resource server on `127.0.0.1:4590` with the
`/agenttrust` prefix stripped. The version-controlled config is
`deploy/nginx/api.sabokun.my.id.conf`; prerequisites (DNS, TLS via
certbot), install steps, and verification are in `deploy/nginx/README.md`.
This is the inbound reverse proxy — it is unrelated to the egress "Proxy
credential" below, which is the facilitator's outbound proxy to the
Testnet node. The proxy adds no CORS headers and changes none: CORS is
set entirely by the resource server.

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
