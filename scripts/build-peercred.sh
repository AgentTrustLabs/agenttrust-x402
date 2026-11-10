#!/bin/sh
# Build the SO_PEERCRED helper for the CURRENT host architecture.
#
# scripts/authz-peercred is a native binary and must never be committed: a binary
# built on one architecture cannot execute on another (Exec format error).
# Source of truth: scripts/authz-peercred.c
#
# Fails loudly: a missing compiler or a compile error aborts the caller.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/scripts/authz-peercred.c"
OUT="$ROOT/scripts/authz-peercred"

if [ ! -f "$SRC" ]; then
  echo "build-peercred: source not found: $SRC" >&2
  exit 1
fi

CC_BIN=${CC:-}
if [ -z "$CC_BIN" ]; then
  for c in cc gcc clang; do
    if command -v "$c" >/dev/null 2>&1; then CC_BIN=$c; break; fi
  done
fi
if [ -z "$CC_BIN" ]; then
  echo "build-peercred: no C compiler found (tried cc, gcc, clang; set CC=...)" >&2
  exit 1
fi

TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

# -O2 only; no arch flags, so the host toolchain targets the host by default.
"$CC_BIN" -O2 -o "$TMP" "$SRC"
chmod 0755 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT INT TERM

echo "build-peercred: built $OUT with $CC_BIN for $(uname -m)"
