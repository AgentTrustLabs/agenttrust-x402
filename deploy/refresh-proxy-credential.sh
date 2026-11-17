#!/bin/bash
# refresh-proxy-credential.sh — probe-first egress proxy credential refresh.
#
# The runtime issues a fresh egress proxy token to every exec session, and
# there is no in-VM refresh command, API or helper a service can call. The
# only source of a fresh credential is the environment of the agent turn
# that runs this script.
#
# Tokens are per-session but NOT short-lived: a stored token keeps working
# after its session ends. So this helper does NOT rotate on value change. It
# rotates only when the stored credential is proven dead:
#
#   1. Probe the STORED credential (from the env file) with a real TLS egress
#      check. If it is valid and --force is not given, exit 0: nothing is
#      written, the facilitator is not restarted.
#   2. Otherwise take the candidate from THIS process's environment, probe it
#      BEFORE touching the file. If the candidate fails, exit non-zero and
#      leave the last-good config untouched.
#   3. If the candidate is identical to the stored one, exit 0 (no change).
#   4. Atomically replace only the proxy lines in the env file (0600,
#      agenttrust:agenttrust) and restart agenttrust-facilitator exactly once
#      (unless --no-restart, or the service is not active yet — the bootstrap
#      starts it afterwards). Then check /healthz and /supported.
#
# Usage:
#   refresh-proxy-credential.sh [--force] [--no-restart] [--check] [--repo-root=DIR] [env-file]
#     --force       refresh even if the stored credential still probes valid
#     --no-restart  update the file but do not restart the facilitator
#     --check       probe the stored credential only; never modify anything
#                   (exit 0 = valid, 1 = invalid/absent) — usable by a
#                   monitor that has no token of its own.
#     --repo-root=DIR
#                   use DIR as the repo root for the tsx executable and the
#                   probe script, instead of this script's own checkout.
#                   The recovery script passes --repo-root=/opt/agenttrust
#                   (its step 5 installs dependencies there); run manually
#                   from a checkout, omit it. The tsx executable and the
#                   probe file are validated before any probe runs.
#     env-file      default /home/agenttrust/.agenttrust/facilitator.env
#
# When to run it: immediately before any facilitator start or restart, and
# whenever the facilitator's startup node check fails with a TLS/proxy error.
# The recovery script calls it in its own step; run it standalone after a
# facilitator restart that was triggered by anything else. Never on a timer:
# a stored credential that still probes valid must not be churned.
#
# Never prints credential values (only valid/invalid/changed/unchanged).
# Exit codes: 0 ok / no-op, 1 stored credential invalid (--check) or usage
# error, 2 no candidate credential in the environment, 3 candidate probe
# failed, 4 file update / restart / health failure.
#
# Run as root (it writes a 0600 file owned by agenttrust and restarts a
# systemd unit). No signing, settlement, broadcast or CCD transaction.
set -euo pipefail

PROXY_VARS="HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY https_proxy http_proxy all_proxy no_proxy NODE_USE_ENV_PROXY"
ENV_FILE=/home/agenttrust/.agenttrust/facilitator.env
FACILITATOR_USER=agenttrust
FORCE=0
NO_RESTART=0
CHECK_ONLY=0
REPO_ROOT_OVERRIDE=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --check) CHECK_ONLY=1 ;;
    --repo-root=*)
      REPO_ROOT_OVERRIDE="${a#--repo-root=}"
      [ -n "$REPO_ROOT_OVERRIDE" ] || { echo "[proxy-refresh] --repo-root requires a non-empty directory" >&2; exit 1; } ;;
    --repo-root) echo "[proxy-refresh] --repo-root requires a directory (use --repo-root=DIR)" >&2; exit 1 ;;
    --*) echo "[proxy-refresh] unknown flag: $a" >&2; exit 1 ;;
    *) ENV_FILE="$a" ;;
  esac
done

# The tsx executable and the probe script come from the repo root: the
# recovery script passes --repo-root=/opt/agenttrust (dependencies are
# installed there in its step 5), while a manual run from a checkout uses
# the checkout itself. Never fall back silently: a missing tsx or probe
# exits 1 before any probe runs.
if [ -n "$REPO_ROOT_OVERRIDE" ]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
TSX="$REPO_ROOT/node_modules/.bin/tsx"
PROBE="$REPO_ROOT/scripts/proxy-egress-probe.mts"
[ -x "$TSX" ] || { echo "[proxy-refresh] tsx not found at $TSX (run from the repo or /opt/agenttrust)" >&2; exit 1; }
[ -f "$PROBE" ] || { echo "[proxy-refresh] probe script not found: $PROBE" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "[proxy-refresh] env file not found: $ENV_FILE" >&2; exit 1; }

PROBE_OUT="$(mktemp)"
trap 'rm -f "$PROBE_OUT"' EXIT

# Read one VAR=value line from a file (value may contain : / @ = but no newline).
# Prints nothing (exit 0) when the variable is absent — without this, `set -e`
# + `pipefail` kills the script on the first grep miss, which is exactly the
# fresh-install case (env file with no proxy lines yet).
read_var() { # file var -> prints the value (or nothing)
  grep "^$2=" "$1" | head -n 1 | cut -d= -f2- || true
}

# Run the egress probe with exactly the given proxy variables (clean env, so
# no ambient proxy leaks into the test). Prints the probe's one-line verdict.
probe_with() { # "VAR=value" ... -> exit 0 = valid
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@" "$TSX" "$PROBE"
}

proxy_assignments() { # file -> prints "VAR=value" lines present in the file
  local f="$1" v val
  for v in $PROXY_VARS; do
    val="$(read_var "$f" "$v")"
    [ -n "$val" ] && printf '%s=%s\n' "$v" "$val" || :
  done
  return 0
}

# --- 1. probe the stored credential ----------------------------------------
STORED_FILE="$(mktemp)"
proxy_assignments "$ENV_FILE" > "$STORED_FILE"
if [ -s "$STORED_FILE" ]; then
  if probe_with NODE_USE_ENV_PROXY=1 $(cat "$STORED_FILE") > "$PROBE_OUT" 2>&1; then
    echo "[proxy-refresh] stored credential: VALID ($(cat "$PROBE_OUT"))"
  else
    echo "[proxy-refresh] stored credential: INVALID ($(cat "$PROBE_OUT"))"
    STORED_INVALID=1
  fi
else
  echo "[proxy-refresh] stored credential: ABSENT (no proxy lines in $ENV_FILE)"
  STORED_INVALID=1
fi
rm -f "$STORED_FILE"
if [ "$CHECK_ONLY" = 1 ]; then
  # --check reports only: 0 = stored credential valid, 1 = invalid/absent.
  [ "${STORED_INVALID:-0}" = 1 ] && exit 1 || exit 0
fi
if [ "${STORED_INVALID:-0}" != 1 ] && [ "$FORCE" != 1 ]; then
  echo "[proxy-refresh] no change: stored credential still works, facilitator untouched"
  exit 0
fi

# --- 2. candidate from this process's environment --------------------------
CANDIDATE_FILE="$(mktemp)"
for v in $PROXY_VARS; do
  [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}" >> "$CANDIDATE_FILE" || :
done
if [ ! -s "$CANDIDATE_FILE" ]; then
  rm -f "$CANDIDATE_FILE"
  echo "[proxy-refresh] no candidate credential in this process's environment — last-good config kept" >&2
  exit 2
fi
if ! probe_with NODE_USE_ENV_PROXY=1 $(cat "$CANDIDATE_FILE") > "$PROBE_OUT" 2>&1; then
  echo "[proxy-refresh] candidate credential FAILED its probe ($(cat "$PROBE_OUT")) — last-good config kept" >&2
  rm -f "$CANDIDATE_FILE"
  exit 3
fi
echo "[proxy-refresh] candidate credential: VALID ($(cat "$PROBE_OUT"))"

# --- 3. no-op when the candidate is identical to the stored one ------------
if [ "${STORED_INVALID:-0}" != 1 ] && cmp -s <(proxy_assignments "$ENV_FILE") "$CANDIDATE_FILE"; then
  rm -f "$CANDIDATE_FILE"
  echo "[proxy-refresh] no change: candidate is identical to the stored credential"
  exit 0
fi

# --- 4. atomic replacement of the proxy lines only -------------------------
DIR="$(dirname "$ENV_FILE")"
TMP_ENV="$(mktemp "$DIR/.facilitator.env.tmp.XXXXXX")"
grep -v -E '^(HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|NODE_USE_ENV_PROXY)=' "$ENV_FILE" > "$TMP_ENV" || true
cat "$CANDIDATE_FILE" >> "$TMP_ENV"
rm -f "$CANDIDATE_FILE"
chmod 0600 "$TMP_ENV"
chown "$FACILITATOR_USER:$FACILITATOR_USER" "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
echo "[proxy-refresh] env file updated (proxy lines only, atomic rename, 0600 $FACILITATOR_USER)"

# --- 5. restart once, then health-check ------------------------------------
if [ "$NO_RESTART" = 1 ]; then
  echo "[proxy-refresh] --no-restart: facilitator not restarted"
  exit 0
fi
if ! systemctl is-active -q agenttrust-facilitator; then
  echo "[proxy-refresh] facilitator not active yet — leaving the restart to the bootstrap"
  exit 0
fi
SPONSOR="$(read_var "$ENV_FILE" FACILITATOR_SPONSOR_ADDRESS)"
systemctl restart agenttrust-facilitator || { echo "[proxy-refresh] restart failed" >&2; exit 4; }
for _ in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"ok":true'; then
    break
  fi
  sleep 0.5
done
curl -sf http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"ok":true' \
  || { echo "[proxy-refresh] /healthz not ok after restart" >&2; exit 4; }
curl -sf http://127.0.0.1:8787/supported 2>/dev/null | grep -q "$SPONSOR" \
  || { echo "[proxy-refresh] /supported does not announce the sponsor after restart" >&2; exit 4; }
echo "[proxy-refresh] facilitator restarted once; /healthz ok, /supported announces the sponsor"
exit 0
