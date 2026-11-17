#!/bin/bash
# AgentTrust x402 — reproducible deployment recovery.
#
# Restores the deployment after a VM replacement from this repository and the
# durable storage under /home/hatch (the only path that survives a replacement).
# Safe to re-run: it never deletes state, never recreates a database that already
# has data, never overwrites the durable wallet exports, never generates or
# replaces the Owner authorization key, and restarts a running service only
# when its code, unit or env file actually changed.
#
# What it does, in order:
#   0. preflight gates: the production signing launcher must wire Owner
#      authorization (see the Owner authorization note below); the Owner key file must
#      already exist with the right mode and owner; the public API URL and
#      the CORS origins must be set; the durable exports must hash-match
#   1. verifies the durable wallet exports by SHA-256 (never reads their contents)
#   2. restores the three service users (distinct UIDs — the Owner, the
#      facilitator and the signing service must never share one) and the
#      shared group `agenttrust`
#   3. recreates the service homes, the Owner's private directory and the
#      shared IPC socket directory
#   4. syncs /opt/agenttrust from THIS repository (never from GitHub)
#   5. builds (tsc + the SO_PEERCRED helper) when the code changed
#   6. writes the four env files (no secrets in them; the Owner public-key
#      hex is derived from the existing key file, never committed)
#   7. copies the sponsor export from durable storage into the signing
#      service's home (only when missing or its hash differs; the durable
#      copy is never touched)
#   8. installs + enables the four systemd units
#   8.5 refreshes the egress proxy credential probe-first (the facilitator
#      restarts only when its stored credential is proven dead; see
#      deploy/refresh-proxy-credential.sh)
#   9. starts Owner -> Signing -> Facilitator -> Resource Server
#  10. verifies sockets, process identity, /healthz, /supported, the 402
#      challenge and /api/services
#
# Owner authorization wiring (preflight gate, step 0b): the production
# signing launcher (scripts/sponsor-wallet-service.mts) passes
# `ownerAuthorization` to createSigningService — it reads
# SIGNING_OWNER_PUBLIC_KEY / SIGNING_OWNER_SOCKET / SIGNING_OWNER_UID and
# passes `{ publicKey, consume: new IpcOwnerConsumeClient(...) }`, exactly
# as scripts/signing-service.mts (the test harness) does. Construction
# throws without it, so the gate below greps the launcher and refuses to
# deploy if the wiring is ever regressed. If the gate fires, the signing
# service cannot start and the facilitator reports canSign=false.
#
# It performs NO signing, settlement, broadcast or CCD transaction, no
# production onboarding, and never runs scripts/x402-pay.mts.
# Run as root (or via sudo) from a checkout of this repository:
#
#   sudo deploy/recover-deployment.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR=/opt/agenttrust

# --- Operator inputs: edit these once, keep them stable across replacements.
# The three UIDs must be distinct and must not collide with any existing user
# (1001 is the local test user on some hosts — do not reuse it). The units in
# deploy/systemd/ carry the same numbers; if you change them here, change
# them there too — the preflight checks they match.
UID_FACILITATOR=1101
UID_OWNER=1102
UID_SIGNING=1103
GROUP_NAME=agenttrust
USER_FACILITATOR=agenttrust
USER_OWNER=agenttrust-owner
USER_SIGNING=agenttrust-signing
HOME_FACILITATOR=/home/agenttrust
HOME_OWNER=/home/agenttrust-owner
HOME_SIGNING=/home/agenttrust-signing

# REQUIRED for a production deployment. The resource server refuses to serve
# a usable 402 challenge without the public URL, and the browser frontend
# cannot call the API without its exact origin in the CORS allowlist. Set
# them before running; the preflight dies when either is empty. CORS_ORIGINS
# is a comma-separated list of exact origins (no `*`, no `*.vercel.app`).
PUBLIC_URL="https://api.sabokun.my.id/agenttrust/protected"
CORS_ORIGINS=""

STATE_DIR=/home/hatch/agenttrust-state
DURABLE=/home/hatch/.agenttrust
SOCKET_DIR=/var/lib/agenttrust/sockets
AUTHZ_SOCK=$SOCKET_DIR/authz.sock
SIGN_SOCK=$SOCKET_DIR/sign.sock
SPONSOR=3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK
SPONSOR_SHA=8a4410fdf2f311cd829227ca8e5ff80d79042896496600784ec6c42378810dc7
SENDER_SHA=051c5d6287e18da10591ae6d364f8387f17e15a07278318dfe47933775e366b7
NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27
SETTLEMENT_DB=$STATE_DIR/facilitator.db
DISCOVERY_DB=$STATE_DIR/discovery.db
OWNER_KEY_FILE=$STATE_DIR/owner-authorization-key.pem

log()  { printf '[recover] %s\n' "$*"; }
die()  { printf '[recover] FATAL: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (or via sudo)"

# --- 0. Preconditions -------------------------------------------------------
command -v node >/dev/null || die "node not found"
command -v npm >/dev/null || die "npm not found"
command -v rsync >/dev/null || die "rsync not found"
command -v systemctl >/dev/null || die "systemctl not found"
command -v runuser >/dev/null || die "runuser not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required, found $(node --version)"

# 0a. The three UIDs must be distinct and match the units in this repo.
[ "$UID_FACILITATOR" != "$UID_OWNER" ] && [ "$UID_FACILITATOR" != "$UID_SIGNING" ] && [ "$UID_OWNER" != "$UID_SIGNING" ] \
  || die "the three service UIDs must be distinct (facilitator=$UID_FACILITATOR owner=$UID_OWNER signing=$UID_SIGNING)"
# Each unit must declare its exact service user: owner -> agenttrust-owner,
# signing -> agenttrust-signing, facilitator + resource -> agenttrust. A
# "one of the three users" check would pass a unit running as the wrong
# user, so check the mapping itself.
for spec in "agenttrust-owner:agenttrust-owner" "agenttrust-signing:agenttrust-signing" "agenttrust-facilitator:agenttrust" "agenttrust-resource:agenttrust"; do
  u="${spec%%:*}"; expected="${spec##*:}"
  grep -q "^User=${expected}$" "$REPO_ROOT/deploy/systemd/$u.service" \
    || die "unit $u.service does not declare User=$expected — update the unit or the UID variables above"
done
grep -q " $UID_FACILITATOR $UID_SIGNING" "$REPO_ROOT/deploy/systemd/agenttrust-owner.service" \
  || die "unit agenttrust-owner.service does not carry facilitator uid $UID_FACILITATOR and signing uid $UID_SIGNING — update the unit or the UID variables above"

# 0b. Production signing launcher gate (see the Owner authorization note in the header).
# createSigningService throws without ownerAuthorization, so a deployment
# built on the current launcher would fail at the signing step. Refuse here,
# before touching anything, instead of deploying a half-working stack. The
# gate checks the actual wiring pattern, not just the property name: a
# comment mentioning ownerAuthorization must not pass it.
grep -q "ownerAuthorization: { publicKey" "$REPO_ROOT/scripts/sponsor-wallet-service.mts" \
  || die "BLOCKED: scripts/sponsor-wallet-service.mts does not pass ownerAuthorization to createSigningService — fix the launcher first (see the header note)"

# 0c. Production deployment inputs. PUBLIC_URL is required: the resource
# server refuses to serve a usable 402 challenge without it. CORS_ORIGINS
# is required for the browser frontend, but an empty value is allowed for a
# local-first deployment (CORS stays disabled and browser calls fail) — the
# script warns loudly instead of dying, so a local real-mode verification
# run is not blocked before the Vercel project exists.
[ -n "$PUBLIC_URL" ] || die "PUBLIC_URL is empty — set the public resource URL (e.g. https://api.sabokun.my.id/agenttrust/protected)"
if [ -z "$CORS_ORIGINS" ]; then
  log "WARNING: CORS_ORIGINS is empty — CORS is disabled and the browser frontend cannot call the API; set the exact production origin(s) before exposing the frontend"
else
  case "$CORS_ORIGINS" in *\**|*\.\*|*\*\.*) die "CORS_ORIGINS must not contain a wildcard" ;; esac
fi

# 0d. Owner authorization key: must already exist, mode 0600, owned by the
# Owner UID. This script never generates or replaces it: the key is the
# Owner's identity, and regenerating it would invalidate the pinned public
# key the signing service verifies against. Generate it once, as the Owner
# user, with the repo's key generator (see deploy/README.md), then re-run.
[ -f "$OWNER_KEY_FILE" ] || die "Owner key file missing: $OWNER_KEY_FILE — generate it once (deploy/README.md) and re-run; this script never creates a key"
[ "$(stat -c %a "$OWNER_KEY_FILE")" = 600 ] || die "Owner key file must be mode 0600: $OWNER_KEY_FILE"
[ "$(stat -c %u "$OWNER_KEY_FILE")" = "$UID_OWNER" ] || die "Owner key file must be owned by uid $UID_OWNER (agenttrust-owner): $OWNER_KEY_FILE"

SETTLEMENT_SHA_BEFORE=""
[ -f "$SETTLEMENT_DB" ] && SETTLEMENT_SHA_BEFORE="$(sha256sum "$SETTLEMENT_DB" | cut -d' ' -f1)"
DISCOVERY_SHA_BEFORE=""
[ -f "$DISCOVERY_DB" ] && DISCOVERY_SHA_BEFORE="$(sha256sum "$DISCOVERY_DB" | cut -d' ' -f1)"
log "working copy: $REPO_ROOT"
log "settlement db: $SETTLEMENT_DB (existed: $([ -n "$SETTLEMENT_SHA_BEFORE" ] && echo yes || echo no))"
log "discovery db: $DISCOVERY_DB (existed: $([ -n "$DISCOVERY_SHA_BEFORE" ] && echo yes || echo no))"

# --- 1. Durable wallet exports: metadata + hash only, never contents -------
for f in "$DURABLE/sender-4dWn8miA.export" "$DURABLE/sponsor-3xRV448Q.export"; do
  [ -f "$f" ] || die "durable export missing: $f"
done
[ "$(sha256sum "$DURABLE/sponsor-3xRV448Q.export" | cut -d' ' -f1)" = "$SPONSOR_SHA" ] \
  || die "sponsor export hash mismatch — refusing to proceed (durable copy untouched)"
[ "$(sha256sum "$DURABLE/sender-4dWn8miA.export" | cut -d' ' -f1)" = "$SENDER_SHA" ] \
  || die "sender export hash mismatch — refusing to proceed (durable copy untouched)"
log "durable exports verified by SHA-256 (sponsor + sender, 496 bytes each, mode 0600)"

# --- 2. Service users (distinct UIDs; the Owner, facilitator and signing
# service must never share one — the Owner launcher refuses to start when
# the facilitator UID equals its own, or the signing UID equals the
# facilitator's) ------------------------------------------------------------
ensure_user() { # name uid home
  local name="$1" uid="$2" home="$3"
  if id "$name" >/dev/null 2>&1; then
    [ "$(id -u "$name")" = "$uid" ] || die "user $name exists with a different uid (expected $uid)"
    [ "$(id -g "$name")" = "$UID_FACILITATOR" ] || die "user $name is not in group $GROUP_NAME (gid $UID_FACILITATOR)"
    log "user $name already exists (uid $uid, group $GROUP_NAME)"
  else
    id -u "$uid" >/dev/null 2>&1 && die "uid $uid is already taken by another user — pick a free UID"
    useradd -u "$uid" -g "$GROUP_NAME" -s /usr/sbin/nologin -M -d "$home" "$name"
    passwd -l "$name" >/dev/null
    log "created user $name (uid $uid, group $GROUP_NAME, nologin, locked, no sudo)"
  fi
}
if getent group "$GROUP_NAME" >/dev/null 2>&1; then
  [ "$(getent group "$GROUP_NAME" | cut -d: -f3)" = "$UID_FACILITATOR" ] || die "group $GROUP_NAME exists with a different gid (expected $UID_FACILITATOR)"
  log "group $GROUP_NAME already exists (gid $UID_FACILITATOR)"
else
  groupadd -g "$UID_FACILITATOR" "$GROUP_NAME"
  log "created group $GROUP_NAME (gid $UID_FACILITATOR)"
fi
ensure_user "$USER_FACILITATOR" "$UID_FACILITATOR" "$HOME_FACILITATOR"
ensure_user "$USER_OWNER" "$UID_OWNER" "$HOME_OWNER"
ensure_user "$USER_SIGNING" "$UID_SIGNING" "$HOME_SIGNING"
# /home/hatch is mode 2770 root:nogroup on a subvolume owned by another user
# namespace: group permission checks against it do not resolve for the
# service users (they are not in nogroup), and chown there is blocked, so
# the state directory below stays root-owned. Access is granted the minimal
# way that works: other-execute on /home/hatch itself (traversal only — no
# listing, no reading; /home/hatch/.agenttrust stays 0700 root, so the
# exports and the Owner key remain unreachable to the services), and the
# state directory is group `agenttrust`, mode 3770 (setgid + sticky bit;
# chgrp works there — verified on a scratch file — so no access for users
# outside the group).
chmod o+x /home/hatch
log "/home/hatch now traversable by the service users (o+x only; contents still not listable)"

# --- 3. Directories ---------------------------------------------------------
# Service homes are wiped on VM replacement and recreated here. The state
# directory lives on the /home/hatch subvolume, where chown is blocked, so
# it stays root-owned; chgrp works there (verified), so the directory is
# group `agenttrust` with mode 3770 — group read/write/traverse, setgid so
# files created here inherit the service group, sticky bit so only a file's
# owner (or the directory owner, root) can delete or rename it, and no
# access for anyone outside the group. That is the strictest mode that
# still works: the facilitator creates the databases and their -shm/-wal
# files as a group member, the Owner reads the settlement DB read-only (and
# creates its key file once, also as a group member), no service can delete
# another service's files, and no other local user can even traverse the
# directory. The database files themselves are created by the service users (0600, or 0644 for the settlement DB so the Owner can read
# it), so their contents are readable only by the intended users.
install -d -m 0750 -o "$USER_FACILITATOR" -g "$GROUP_NAME" "$HOME_FACILITATOR"
install -d -m 0750 -o "$USER_OWNER" -g "$GROUP_NAME" "$HOME_OWNER"
install -d -m 0750 -o "$USER_SIGNING" -g "$GROUP_NAME" "$HOME_SIGNING"
install -d -m 0700 -o "$USER_FACILITATOR" -g "$GROUP_NAME" "$HOME_FACILITATOR/.agenttrust"
install -d -m 0700 -o "$USER_OWNER" -g "$GROUP_NAME" "$HOME_OWNER/.agenttrust" "$HOME_OWNER/.agenttrust/authz-dir"
install -d -m 0700 -o "$USER_SIGNING" -g "$GROUP_NAME" "$HOME_SIGNING/.agenttrust"
install -d -m 2770 -o root -g "$GROUP_NAME" "$SOCKET_DIR"
mkdir -p "$STATE_DIR"
# chgrp works on this subvolume (verified on a scratch file inside the
# directory); chown does not, so the directory stays root-owned. Die loudly
# if the group cannot be set: a 3770 directory with the wrong group would
# lock the facilitator out entirely.
chgrp "$GROUP_NAME" "$STATE_DIR" \
  || die "cannot set group $GROUP_NAME on $STATE_DIR — the state directory must be group $GROUP_NAME (mode 3770) for the services to work without other-write; fix the directory group manually, then re-run"
chmod 3770 "$STATE_DIR"
runuser -u "$USER_FACILITATOR" -- touch "$STATE_DIR/.write-test" && rm -f "$STATE_DIR/.write-test" \
  || die "service user $USER_FACILITATOR cannot write to $STATE_DIR"
# Existing databases must already be writable by their service user; a stale
# file owned by a wiped UID cannot be fixed by this script (it never deletes
# state), so fail loudly and let the operator decide.
for spec in "$SETTLEMENT_DB:$USER_FACILITATOR" "$DISCOVERY_DB:$USER_FACILITATOR"; do
  f="${spec%%:*}"; u="${spec##*:}"
  if [ -f "$f" ]; then
    runuser -u "$u" -- test -w "$f" || die "$f exists but is not writable by $u (stale ownership from a previous deployment) — chown it to $u or move it aside, then re-run"
  fi
done
log "directories ready: service homes (0750), .agenttrust dirs (0700), Owner authz-dir (0700), $SOCKET_DIR (2770 $GROUP_NAME), $STATE_DIR (3770 root:$GROUP_NAME, sticky, service group verified writable, no access for others)"

# --- 4. Code sync: working copy -> /opt (never GitHub) -----------------------
mkdir -p "$DEPLOY_DIR"
# Dry-run first: a running service is restarted only when its code changed.
# Build outputs are excluded from the sync on purpose: dist/ and the
# SO_PEERCRED helper are built inside /opt by step 5, so their fresh mtimes
# must not count as "code changed" on the next run (idempotency).
# node_modules is excluded for the same reason: `npm ci` rewrites it with fresh
# mtimes, which would make every dry-run report the whole tree as changed.
# Dependencies are tracked separately, by package.json / package-lock.json
# checksums, in step 5.
# The sync must NOT preserve permissions or ownership from the working copy:
# those files are 660 root:root (umask 0007 under /home/hatch), while /opt must
# stay world-readable for the service users — the post-sync `chmod -R a+rX`
# provides that. Preserving perms made every dry-run report all files as
# "changed" (permissions differ), so every re-run restarted the services.
# --no-perms/--no-owner/--no-group keep -a's recursion, links and times, so
# change detection rests on mtime+size only.
# --omit-dir-times: the build rewrites scripts/authz-peercred on every build,
# which bumps /opt/scripts/ directory mtime; without this, the next dry-run
# would report the directory itself as changed and restart the services again.
RSYNC_OPTS=(-a --no-perms --no-owner --no-group --omit-dir-times --delete)
RSYNC_EXCLUDES=(--exclude=.git --exclude=dist --exclude=scripts/authz-peercred --exclude=node_modules)
if rsync -ani "${RSYNC_OPTS[@]}" "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$DEPLOY_DIR/" | grep -q .; then
  CODE_CHANGED=1
else
  CODE_CHANGED=0
fi
# A dependency change also counts as a code change (the services must restart
# onto the new node_modules). Compared BEFORE the sync below, because the sync
# itself copies the new package files into /opt.
PKG_CHANGED=0
if [ ! -f "$DEPLOY_DIR/package.json" ] \
  || ! cmp -s "$REPO_ROOT/package.json" "$DEPLOY_DIR/package.json" \
  || ! cmp -s "$REPO_ROOT/package-lock.json" "$DEPLOY_DIR/package-lock.json"; then
  PKG_CHANGED=1
  CODE_CHANGED=1
  log "code sync: changed=1 (package.json / package-lock.json differ)"
else
  log "code sync: changed=$CODE_CHANGED"
fi
if [ "$CODE_CHANGED" = 1 ]; then
  for s in agenttrust-resource agenttrust-facilitator agenttrust-signing agenttrust-owner; do
    if systemctl is-active -q "$s" 2>/dev/null; then
      systemctl stop "$s"
      log "stopped $s (code changed)"
    fi
  done
  rsync "${RSYNC_OPTS[@]}" "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$DEPLOY_DIR/"
  chmod -R a+rX "$DEPLOY_DIR"
  log "synced $REPO_ROOT -> $DEPLOY_DIR"
fi

# --- 5. Dependencies + build (only when needed) ----------------------------
# node_modules is managed, not synced: reinstall only when the lockfile (or
# package.json) changed (PKG_CHANGED was decided pre-sync in step 4), or when
# the install is missing/incomplete.
if [ "$PKG_CHANGED" = 1 ] || [ ! -x "$DEPLOY_DIR/node_modules/.bin/tsx" ]; then
  log "dependencies changed or incomplete — running npm ci in $DEPLOY_DIR"
  (cd "$DEPLOY_DIR" && npm ci --no-audit --no-fund)
fi
if [ "$CODE_CHANGED" = 1 ] || [ ! -d "$DEPLOY_DIR/dist" ] || [ ! -x "$DEPLOY_DIR/scripts/authz-peercred" ]; then
  log "building (tsc + SO_PEERCRED helper)"
  (cd "$DEPLOY_DIR" && npm run build)
  chmod -R a+rX "$DEPLOY_DIR"
fi
[ -x "$DEPLOY_DIR/node_modules/.bin/tsx" ] || die "tsx missing after build"
[ -x "$DEPLOY_DIR/scripts/authz-peercred" ] || die "authz-peercred helper missing after build"
[ -d "$DEPLOY_DIR/dist" ] || die "dist/ missing after build"
log "build verified: tsx + authz-peercred + dist/ present"

# --- 6. Env files (plain KEY=value: readable by both `source` and systemd) --
# No secrets in these files. The sponsor wallet path is a path, never contents.
# The Owner public-key hex in signing.env is a PUBLIC key, derived here from
# the existing key file with the repo's own loader — it is never committed
# and never printed by this script (only written to the 0600 env file).
TMPDIR_ENV="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ENV"' EXIT
OWNER_PUB_HEX="$(cd "$DEPLOY_DIR" && "$DEPLOY_DIR/node_modules/.bin/tsx" --eval "
import { loadOwnerAuthorizationPrivateKey, ownerAuthorizationPublicKeyHex } from './services/facilitator/src/ownerAuthorization.js';
process.stdout.write(ownerAuthorizationPublicKeyHex(loadOwnerAuthorizationPrivateKey(process.argv[1]).publicKey));
" "$OWNER_KEY_FILE" 2>/dev/null)" || die "could not derive the Owner public key from $OWNER_KEY_FILE"
[ -n "$OWNER_PUB_HEX" ] || die "Owner public key derivation returned empty"
cat > "$TMPDIR_ENV/owner.env" <<EOF
AUTHZ_AUTHORIZATION_KEY_FILE=$OWNER_KEY_FILE
AUTHZ_SETTLEMENT_DB_FILE=$SETTLEMENT_DB
AUTHZ_DB_FILE=$HOME_OWNER/.agenttrust/authz-dir/authz.db
AUTHZ_SIGNING_SERVICE_UID=$UID_SIGNING
AUTHZ_SPONSOR_ADDRESS=$SPONSOR
AUTHZ_NETWORK=$NETWORK
AUTHZ_MAX_ENERGY=1000
AUTHZ_MAX_EXPIRY_OFFSET_SECONDS=600
AUTHZ_ALLOWED_ASSETS=CCD
AUTHZ_POLICY_VERSION=v348
AUTHZ_OWNER_LOG=$HOME_OWNER/.agenttrust/authz-dir/owner.log
AUTHZ_OWNER_PEERCRED_BIN=$DEPLOY_DIR/scripts/authz-peercred
EOF
cat > "$TMPDIR_ENV/signing.env" <<EOF
FACILITATOR_SPONSOR_WALLET_FILE=$HOME_SIGNING/.agenttrust/sponsor-3xRV448Q.export
FACILITATOR_SIGNING_SERVICE_SOCKET=$SIGN_SOCK
FACILITATOR_SPONSOR_ADDRESS=$SPONSOR
FACILITATOR_NETWORK=$NETWORK
FACILITATOR_SIGNING_SERVICE_UID=$UID_FACILITATOR
SIGNING_OWNER_PUBLIC_KEY=$OWNER_PUB_HEX
SIGNING_OWNER_SOCKET=$AUTHZ_SOCK
SIGNING_OWNER_UID=$UID_OWNER
EOF
cat > "$TMPDIR_ENV/facilitator.env" <<EOF
FACILITATOR_MODE=real
FACILITATOR_NETWORK=$NETWORK
FACILITATOR_HOST=127.0.0.1
FACILITATOR_PORT=8787
FACILITATOR_SPONSOR_ADDRESS=$SPONSOR
FACILITATOR_PENDING_TTL_MS=120000
FACILITATOR_REPLAY_TTL_MS=600000
FACILITATOR_DB_PATH=$SETTLEMENT_DB
FACILITATOR_DB_FILE_MODE=0644
FACILITATOR_RECONCILE_ENABLED=0
FACILITATOR_BUSY_TIMEOUT_MS=5000
FACILITATOR_EVIDENCE_MODE=none
FACILITATOR_NODE_HOST=grpc.testnet.concordium.com
FACILITATOR_NODE_PORT=20000
FACILITATOR_NODE_USE_TLS=1
FACILITATOR_AUTHZ_SOCKET=$AUTHZ_SOCK
FACILITATOR_SENDER_VERIFICATION=sdk
FACILITATOR_SENDER_VERIFY_TIMEOUT_MS=10000
FACILITATOR_SIGNING_SERVICE_SOCKET=$SIGN_SOCK
FACILITATOR_SIGNING_SERVICE_UID=$UID_SIGNING
FACILITATOR_SIGNING_TIMEOUT_MS=10000
FACILITATOR_MAX_FEE_MICROCCD=10000000
FACILITATOR_MAX_ENERGY=1000
FACILITATOR_SPONSOR_WALLET_FILE=$HOME_SIGNING/.agenttrust/sponsor-3xRV448Q.export
FACILITATOR_RECOVER_ON_STARTUP=0
FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS=30000
EOF
cat > "$TMPDIR_ENV/resource.env" <<EOF
AGENTTRUST_X402_HOST=127.0.0.1
AGENTTRUST_X402_PORT=4590
AGENTTRUST_X402_FACILITATOR_URL=http://127.0.0.1:8787
AGENTTRUST_X402_FACILITATOR_MODE=real
AGENTTRUST_X402_PUBLIC_URL=$PUBLIC_URL
AGENTTRUST_CORS_ORIGINS=$CORS_ORIGINS
AGENTTRUST_DISCOVERY_DB=$DISCOVERY_DB
EOF
# Egress proxy lines are NOT written here. They are owned by
# deploy/refresh-proxy-credential.sh (step 8.5): it probes the STORED
# credential with a real TLS egress check and only swaps in this run's
# credential when the stored one is proven dead — so a re-run no longer
# restarts the facilitator just because the session token value differs
# (distinct tokens stay valid after their session ends). The facilitator's
# gRPC client reaches grpc.testnet.concordium.com only with the proxy
# variables set (without them its startup node check fails closed with a TLS
# error). The values are never printed, never committed, and land only in
# facilitator.env (0600, service user). Only the facilitator and the resource
# server make outbound connections; the resource server uses the runtime's
# ambient proxy through global fetch, so only the facilitator gets them.
for f in owner signing facilitator resource; do
  case "$f" in
    owner) HOME_DIR="$HOME_OWNER"; SVC_USER="$USER_OWNER" ;;
    signing) HOME_DIR="$HOME_SIGNING"; SVC_USER="$USER_SIGNING" ;;
    facilitator|resource) HOME_DIR="$HOME_FACILITATOR"; SVC_USER="$USER_FACILITATOR" ;;
  esac
  # facilitator.env keeps its existing proxy lines: they are managed by the
  # refresh helper (step 8.5), so a proxy-only difference must not count as
  # an env change here (the helper restarts the facilitator itself when it
  # swaps the credential).
  if [ "$f" = facilitator ] && [ -f "$HOME_DIR/.agenttrust/$f.env" ]; then
    grep -E '^(HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|NODE_USE_ENV_PROXY)=' "$HOME_DIR/.agenttrust/$f.env" >> "$TMPDIR_ENV/$f.env" || true
  fi
  ENV_CHANGED=0
  if [ ! -f "$HOME_DIR/.agenttrust/$f.env" ] || ! cmp -s "$TMPDIR_ENV/$f.env" "$HOME_DIR/.agenttrust/$f.env"; then
    ENV_CHANGED=1
  fi
  install -m 0600 -o "$SVC_USER" -g "$GROUP_NAME" "$TMPDIR_ENV/$f.env" "$HOME_DIR/.agenttrust/$f.env"
  case "$f" in
    owner) OWNER_ENV_CHANGED=$ENV_CHANGED ;;
    signing) SIGNING_ENV_CHANGED=$ENV_CHANGED ;;
    facilitator) FACILITATOR_ENV_CHANGED=$ENV_CHANGED ;;
    resource) RESOURCE_ENV_CHANGED=$ENV_CHANGED ;;
  esac
done
log "env files written: owner.env, signing.env, facilitator.env (proxy lines preserved), resource.env — mode 0600, per-service owners"

# --- 7. Sponsor export: durable -> signing service home (copy only when needed)
SVC_EXPORT="$HOME_SIGNING/.agenttrust/sponsor-3xRV448Q.export"
if [ -f "$SVC_EXPORT" ] && [ "$(sha256sum "$SVC_EXPORT" | cut -d' ' -f1)" = "$SPONSOR_SHA" ]; then
  log "service copy of sponsor export already present, hash matches — left untouched"
else
  install -m 0600 -o "$USER_SIGNING" -g "$GROUP_NAME" "$DURABLE/sponsor-3xRV448Q.export" "$SVC_EXPORT"
  [ "$(sha256sum "$SVC_EXPORT" | cut -d' ' -f1)" = "$SPONSOR_SHA" ] \
    || die "service copy of sponsor export failed hash check"
  log "copied sponsor export to signing service home (0600, $USER_SIGNING, hash verified)"
fi

# --- 8. systemd units -------------------------------------------------------
UNIT_CHANGED=0
for s in agenttrust-owner agenttrust-signing agenttrust-facilitator agenttrust-resource; do
  if [ ! -f "/etc/systemd/system/$s.service" ] || ! cmp -s "$REPO_ROOT/deploy/systemd/$s.service" "/etc/systemd/system/$s.service"; then
    install -m 0644 "$REPO_ROOT/deploy/systemd/$s.service" "/etc/systemd/system/$s.service"
    UNIT_CHANGED=1
    log "installed unit $s.service"
  fi
done
if [ "$UNIT_CHANGED" = 1 ]; then
  systemctl daemon-reload
  log "systemd daemon reloaded"
fi
systemctl enable agenttrust-owner agenttrust-signing agenttrust-facilitator agenttrust-resource >/dev/null
log "units enabled"

# --- 8.5 Egress proxy credential (probe-first, no restart churn) ------------
# The stored credential is probed with a real TLS egress check; it is swapped
# for this run's credential only when proven dead. The helper restarts the
# facilitator itself when it swaps, so a re-run of this script no longer
# restarts a healthy facilitator just because the session token differs.
# The helper runs with --repo-root=$DEPLOY_DIR: its tsx and probe come from
# the deployment directory (dependencies are installed there in step 5), not
# from this working copy, which may not have node_modules.
bash "$REPO_ROOT/deploy/refresh-proxy-credential.sh" --repo-root="$DEPLOY_DIR" "$HOME_FACILITATOR/.agenttrust/facilitator.env" \
  || die "proxy credential refresh failed; facilitator keeps its last-good config"

# --- 9. Start Owner -> Signing -> Facilitator -> Resource --------------------
# A service is restarted only when its unit or its env file changed; otherwise
# a re-run leaves a healthy running service (and its pid) untouched.
start_service() {
  local svc="$1" env_changed="$2" check="$3"
  if systemctl is-active -q "$svc"; then
    if [ "$UNIT_CHANGED" = 1 ] || [ "$env_changed" = 1 ]; then
      systemctl restart "$svc"
      log "restarted $svc (unit or env changed)"
    else
      log "$svc already running (pid $(systemctl show -p MainPID --value "$svc")), leaving it"
      return 0
    fi
  else
    systemctl start "$svc"
    log "started $svc"
  fi
  # wait for the readiness condition, up to ~30 s
  for _ in $(seq 1 60); do
    if eval "$check" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  die "$svc did not become ready (check: $check); see journalctl -u $svc"
}
start_service agenttrust-owner "$OWNER_ENV_CHANGED" "[ -S $AUTHZ_SOCK ]"
start_service agenttrust-signing "$SIGNING_ENV_CHANGED" "[ -S $SIGN_SOCK ]"
start_service agenttrust-facilitator "$FACILITATOR_ENV_CHANGED" "curl -sf http://127.0.0.1:8787/healthz | grep -q '\"ok\":true'"
start_service agenttrust-resource "$RESOURCE_ENV_CHANGED" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4590/protected)\" = 402 ]"

# --- 10. Verify -------------------------------------------------------------
for spec in "agenttrust-owner:$USER_OWNER" "agenttrust-signing:$USER_SIGNING" "agenttrust-facilitator:$USER_FACILITATOR" "agenttrust-resource:$USER_FACILITATOR"; do
  s="${spec%%:*}"; u="${spec##*:}"
  pid="$(systemctl show -p MainPID --value "$s")"
  owner="$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ "$owner" = "$u" ] || die "$s runs as '$owner', expected $u"
  log "$s: active, pid $pid, user $u"
done
[ -S "$AUTHZ_SOCK" ] || die "authz.sock missing"
[ -S "$SIGN_SOCK" ] || die "sign.sock missing"
HEALTH="$(curl -s http://127.0.0.1:8787/healthz)"
echo "$HEALTH" | grep -q '"ok":true' || die "/healthz not ok: $HEALTH"
echo "$HEALTH" | grep -q '"mode":"real"' || die "/healthz mode is not real: $HEALTH"
echo "$HEALTH" | grep -q '"canSign":true' || die "/healthz canSign is not true: $HEALTH"
echo "$HEALTH" | grep -q '"ownerReachable":true' || die "/healthz ownerReachable is not true: $HEALTH"
curl -s http://127.0.0.1:8787/supported | grep -q "$SPONSOR" || die "/supported does not announce the sponsor"
log "health: $HEALTH"
log "/supported announces feePayer $SPONSOR"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4590/protected)" = 402 ] || die "resource server does not answer 402 on /protected"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4590/api/services)" = 200 ] || die "resource server does not answer 200 on /api/services"
log "resource server: /protected 402, /api/services 200"

if [ -n "$SETTLEMENT_SHA_BEFORE" ]; then
  [ "$(sha256sum "$SETTLEMENT_DB" | cut -d' ' -f1)" = "$SETTLEMENT_SHA_BEFORE" ] \
    && log "settlement database untouched by this run (hash unchanged)" \
    || log "settlement database present before run; hash changed only by service activity (rows added by the services, never by this script)"
else
  [ -f "$SETTLEMENT_DB" ] && log "settlement database created by the services at $SETTLEMENT_DB (fresh — on-chain evidence is authoritative)"
fi
if [ -n "$DISCOVERY_SHA_BEFORE" ]; then
  [ "$(sha256sum "$DISCOVERY_DB" | cut -d' ' -f1)" = "$DISCOVERY_SHA_BEFORE" ] \
    && log "discovery database untouched by this run (hash unchanged)" \
    || log "discovery database present before run; hash changed only by service activity"
else
  [ -f "$DISCOVERY_DB" ] && log "discovery database created by the services at $DISCOVERY_DB (fresh, 0 services — run the provider onboarding separately)"
fi
log "recovery complete: Owner + Signing + Facilitator + Resource Server up on Testnet"
