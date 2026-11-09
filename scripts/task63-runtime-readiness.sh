#!/usr/bin/env bash
# TASK63 — real-mode runtime readiness probe (read-only; no payment requests, no signing).
set -u

SPONSOR=3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK
CAIP2=ccd:4221332d34e1694168c2a0c0b3fd0f27
SOCK=/tmp/t63-sign.sock
DB=/tmp/t63-ready.db
EXPORT=/home/ubuntu/.agenttrust/sponsor.export
UID_=1001

cd /home/ubuntu/projects/agenttrust || exit 1

echo '=== 0. preflight ==='
stat -c 'export perm=%a owner=%U size=%s' "$EXPORT"
rm -f "$SOCK" "$DB"

echo
echo '=== 1. start signing service (loads the secured export) ==='
npx tsx scripts/task57-wallet-service.mts "$SOCK" "$SPONSOR" "$CAIP2" "$UID_" "$EXPORT" > /tmp/t63-svc.log 2>&1 &
SVC_PID=$!
for i in $(seq 1 40); do
  [ -S "$SOCK" ] && break
  sleep 0.25
done
if ! kill -0 "$SVC_PID" 2>/dev/null; then
  echo "SIGNING SERVICE FAILED TO START"
  cat /tmp/t63-svc.log
  exit 2
fi
echo "service pid=$SVC_PID"
grep -v 'DeprecationWarning\|trace-deprecation' /tmp/t63-svc.log | sed 's/^/  /'
stat -c 'socket perm=%a owner=%U:%G' "$SOCK"

echo
echo '=== 2. real-mode facilitator startup (loopback, ephemeral port) ==='
FACILITATOR_MODE=real \
FACILITATOR_HOST=127.0.0.1 \
FACILITATOR_PORT=0 \
FACILITATOR_SPONSOR_ADDRESS=$SPONSOR \
FACILITATOR_NETWORK=$CAIP2 \
FACILITATOR_DB_PATH=$DB \
FACILITATOR_NODE_HOST=grpc.testnet.concordium.com \
FACILITATOR_NODE_PORT=20000 \
FACILITATOR_NODE_USE_TLS=1 \
FACILITATOR_SENDER_VERIFICATION=sdk \
FACILITATOR_SIGNING_SERVICE_SOCKET=$SOCK \
FACILITATOR_SIGNING_SERVICE_UID=$UID_ \
FACILITATOR_MAX_FEE_MICROCCD=10000000 \
FACILITATOR_MAX_ENERGY=1000 \
npx tsx services/facilitator/src/server.ts > /tmp/t63-fac.log 2>&1 &
FAC_PID=$!

URL=''
for i in $(seq 1 120); do
  URL=$(grep -oE 'http://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+' /tmp/t63-fac.log | head -1)
  [ -n "$URL" ] && break
  kill -0 "$FAC_PID" 2>/dev/null || break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "FACILITATOR DID NOT START"
  grep -v 'DeprecationWarning\|trace-deprecation' /tmp/t63-fac.log | sed 's/^/  /'
  kill -9 "$FAC_PID" 2>/dev/null
  kill -9 "$SVC_PID" 2>/dev/null
  exit 3
fi

grep -v 'DeprecationWarning\|trace-deprecation' /tmp/t63-fac.log | sed 's/^/  /'
echo "  bound url: $URL"

echo
echo '=== 3. readiness endpoints (no payment requests) ==='
echo -n '  GET /healthz  -> '
curl -s --max-time 20 "$URL/healthz"
echo
echo -n '  GET /supported -> '
curl -s --max-time 20 "$URL/supported" | head -c 400
echo
echo -n '  POST /reconcile (unauthenticated, must be 404) -> '
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 -X POST "$URL/reconcile" -H 'content-type: application/json' -d '{}'

echo
echo '=== 4. shutdown ==='
kill -TERM "$FAC_PID" 2>/dev/null
kill -TERM "$SVC_PID" 2>/dev/null
sleep 1
kill -9 "$FAC_PID" 2>/dev/null
kill -9 "$SVC_PID" 2>/dev/null
echo '  stopped'
