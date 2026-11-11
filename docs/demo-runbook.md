# AgentTrust x402 — Demo Runbook

Reproducible guide for the real-payment demo. There are two demos here; do not confuse them:

- **Evidence demo (for judges, reproducible anywhere).** Re-verifies the recorded
  payment against the live Testnet chain. Read-only, no wallet, no key, no broadcast.
  This is the demo to run.
- **Live payment (operator only, one-time).** Settles a new payment through the three
  services. It needs the sender and sponsor wallets and spends Testnet CCD. It is
  documented for reproducibility, not for judges to repeat — the one payment it
  produced is already recorded in [`docs/demo-real-payment.md`](demo-real-payment.md).

## Prerequisites

- Node.js ≥ 22 and npm. Verified on Node 24.22.1 / npm 10.9.4.
- A checkout of this repository with dependencies installed:
  ```bash
  npm ci
  npm run build   # tsc — emits dist/
  ```
- Outbound HTTPS to `grpc.testnet.concordium.com:20000` and `testnet.ccdscan.io`
  (for the evidence demo). The test suite itself needs no network.
- For the evidence demo: nothing else. No wallet, no private key, no seed phrase,
  no API key, no `.env` file.
- For the live payment: the deployment described below, plus the sender and sponsor
  wallet exports held by the operator. Those files are never in this repository.

## Non-secret configuration

All runtime configuration comes from the audited template `.env.example` (36 variables,
no secrets). The deployment uses three runtime env files, one per service, each built
from that template and each owned by the service user with mode 0600:

| File | Contents |
|---|---|
| `/home/agenttrust/.agenttrust/owner.env` | 9 `AUTHZ_*` + `TASK348_LOG` variables |
| `/home/agenttrust/.agenttrust/signing.env` | 5 `FACILITATOR_SPONSOR_*` / signing variables |
| `/home/agenttrust/.agenttrust/facilitator.env` | 28 `FACILITATOR_*` variables |

Public, verifiable values (the rest are code defaults from the template):

| Setting | Value |
|---|---|
| `FACILITATOR_MODE` | `real` |
| `FACILITATOR_NETWORK` / `AUTHZ_NETWORK` | `ccd:4221332d34e1694168c2a0c0b3fd0f27` (Testnet) |
| `FACILITATOR_HOST` / `FACILITATOR_PORT` | `127.0.0.1` / `8787` |
| `FACILITATOR_SENDER_VERIFICATION` | `sdk` |
| `FACILITATOR_NODE_HOST` / `FACILITATOR_NODE_PORT` / `FACILITATOR_NODE_USE_TLS` | `grpc.testnet.concordium.com` / `20000` / `1` |
| `FACILITATOR_DB_PATH` = `AUTHZ_DB_FILE` | `/home/agenttrust/.agenttrust/facilitator.db` |
| `FACILITATOR_AUTHZ_SOCKET` | `/home/agenttrust/.agenttrust/authz.sock` |
| `FACILITATOR_SIGNING_SERVICE_SOCKET` | `/home/agenttrust/.agenttrust/sign.sock` |
| `FACILITATOR_SIGNING_SERVICE_UID` | `1001` |
| `FACILITATOR_MAX_ENERGY` = `AUTHZ_MAX_ENERGY` | `1000` |
| `FACILITATOR_MAX_FEE_MICROCCD` | `10000000` (10 CCD) |
| `FACILITATOR_RECONCILE_ENABLED` | `0` (no operator token needed) |
| `AUTHZ_SEED_FIXTURES` | `0` (fixtures off) |
| `AUTHZ_POLICY_VERSION` | `authz-prod-v1` |

The operator token (`FACILITATOR_OPERATOR_TOKEN_SHA256`) is empty because reconciliation
is disabled. Never put a real token, wallet export, or `.env` with secrets into the
repository. The service user is `agenttrust` (UID/GID 1001, `nologin`, locked password,
no sudo); the deployment directory is `/opt/agenttrust`; the service home is
`/home/agenttrust` (0750) with `.agenttrust` at 0700.

## Startup order

Start in this order. Each service is started as UID 1001 with `setsid` + `nohup` so it
survives the launching shell; each writes a PID file and a stdout log under
`/home/agenttrust/.agenttrust/`. Do not start the Facilitator before the other two —
its startup probe fails closed if the Signing Service is unreachable, and its
`/healthz` reports unhealthy until the Owner is reachable.

**1. Authorization Owner**

```bash
setsid nohup runuser -u agenttrust -- /bin/bash -c \
  'echo $$ > /home/agenttrust/.agenttrust/authz-owner.pid; cd /opt/agenttrust && set -a; source /home/agenttrust/.agenttrust/owner.env; set +a; exec npx tsx scripts/authz-owner.mts /home/agenttrust/.agenttrust/authz-dir /home/agenttrust/.agenttrust/authz.sock 1001' \
  >> /home/agenttrust/.agenttrust/owner.stdout.log 2>&1 < /dev/null &
```

Expect in `owner.stdout.log`: `owner listening on /home/agenttrust/.agenttrust/authz.sock`.
Check: `authz.sock` exists, mode 0660; `facilitator.db` created, mode 0600.

**2. Signing Service**

```bash
setsid nohup runuser -u agenttrust -- /bin/bash -c \
  'echo $$ > /home/agenttrust/.agenttrust/signing.pid; cd /opt/agenttrust && set -a; source /home/agenttrust/.agenttrust/signing.env; set +a; exec npx tsx scripts/sponsor-wallet-service.mts' \
  >> /home/agenttrust/.agenttrust/signing.stdout.log 2>&1 < /dev/null &
```

Expect in `signing.stdout.log`:
`service listening pid=… uid=1001 socket=/home/agenttrust/.agenttrust/sign.sock signer=loaded source=env`.
Check: `sign.sock` exists, mode 0660. The sponsor export must already be at
`/home/agenttrust/.agenttrust/sponsor-3xRV448Q.export`, mode 0600, owned by
`agenttrust` — the service refuses to start otherwise.

**3. Facilitator (real mode)**

```bash
setsid nohup runuser -u agenttrust -- /bin/bash -c \
  'echo $$ > /home/agenttrust/.agenttrust/facilitator.pid; cd /opt/agenttrust && set -a; source /home/agenttrust/.agenttrust/facilitator.env; set +a; exec npx tsx services/facilitator/src/server.ts' \
  >> /home/agenttrust/.agenttrust/facilitator.stdout.log 2>&1 < /dev/null &
```

Expect in `facilitator.stdout.log`:
`authorization owner reachable; shared database /home/agenttrust/.agenttrust/facilitator.db (dev=… ino=…)`,
`facilitator listening on http://127.0.0.1:8787 (mode=real)`, and
`real mode: signing via the dedicated IPC signing service; submission via Concordium gRPC.`

## Demo commands

### Evidence demo (judges — run this)

```bash
npx tsx scripts/demo-real-payment.mts
```

Expected (on the deployment machine): `demo-real-payment: 15 passed, 0 failed, 0 skipped`
and `DEMO PASSED`. On a machine without the live services or DB, the facilitator and
DB checks report `SKIP` instead of failing; the on-chain checks are authoritative and
must all pass. The script performs no signing, no POST, and no broadcast.

### Liveness checks (manual)

```bash
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"mode":"real","network":"ccd:4221332d34e1694168c2a0c0b3fd0f27","canSign":true,"ownerReachable":true}

curl -s http://127.0.0.1:8787/supported
# {"kinds":[{"x402Version":2,"scheme":"exact","network":"ccd:4221332d…","extra":{"feePayer":"3xRV448Q…"}}],…}
```

### DB checks (read-only)

```bash
python3 -c "
import sqlite3
con = sqlite3.connect('file:/home/agenttrust/.agenttrust/facilitator.db?mode=ro', uri=True)
print('payments', con.execute('SELECT COUNT(*) FROM payments').fetchone()[0])
print('settlements', con.execute('SELECT COUNT(*) FROM settlements').fetchone()[0])
print('approved', con.execute(\"SELECT COUNT(*) FROM sign_events WHERE decision='approved'\").fetchone()[0])
"
# payments 1, settlements 1, approved 1
```

### Live payment (operator only — do not repeat without approval)

The one recorded payment was produced once, with operator approval, as follows. Do not
run a second one without a new approval: the spending limit is one payment transaction.

1. Preflight (read-only): sender/sponsor/recipient account info from the live node
   (`scripts/sponsor-account-verify.mts`, `scripts/sender-wallet-verification.mjs`),
   node connectivity (`scripts/testnet-readonly.mts`, 8/8).
2. Build the payment envelope (operator machine only): sender loads its export with
   `parseWallet` + `buildAccountSigner`, fetches its live nonce (13), builds a V1
   sponsored transfer — recipient `3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB`,
   amount `1` microCCD, expiry now + 300 s, `executionEnergyAmount` 300, sponsor
   `3xRV448Q…` — signs it with `Transaction.sign`, and wraps it in the x402 v2
   envelope (`buildPaymentRequirements`, `preflightPaymentPayload`). The envelope is a
   temporary file, mode 0600, deleted after the test.
3. `POST /verify` with the envelope → `isValid: true`.
4. `POST /settle` with the same envelope, exactly once → `success: true`,
   `finality: "finalized"`, transaction hash.
5. Verify on chain (`getBlockItemStatus`) and in the DB (counts above), then replay
   `POST /settle` with the same envelope once to prove idempotency
   (`idempotentReplay: true`, same hash). Never re-broadcast on an ambiguous result;
   reconcile by hash instead.

## Verification of results

| Check | Expected |
|---|---|
| `demo-real-payment.mts` | exit 0, 15 passed / 0 failed (deployment machine) |
| `/healthz` | HTTP 200, `ok:true`, `mode:real`, `canSign:true`, `ownerReachable:true` |
| `/supported` | `scheme:exact`, Testnet network, `feePayer` + signer = sponsor |
| DB counts | payments 1, settlements 1, approved 1 |
| Explorer | status `finalized`, amount `0.000001 CCD`, energy `635` |
| Sender nonce | 14 (was 13 before the payment; unchanged by the replay) |
| Sponsor nonce | 1 (unchanged — a sponsored transaction consumes the sender's nonce) |

## Cleanup

Stop in reverse order (Facilitator, Signing Service, Owner). Kill by PID file, not by
pattern — a `pkill -f` pattern that contains the service's own command line can match
the shell running the command:

```bash
kill "$(cat /home/agenttrust/.agenttrust/facilitator.pid)"
kill "$(cat /home/agenttrust/.agenttrust/signing.pid)"
kill "$(cat /home/agenttrust/.agenttrust/authz-owner.pid)"
```

Then confirm: no `authz-owner`, `sponsor-wallet-service`, or `facilitator/src/server`
process remains, port 8787 is closed, and the Signing Service socket is gone (it
removes its socket on a clean stop). **Do not delete** the DB, the env files, or the
wallet exports as part of cleanup — they are the deployment state. Delete only files
you created for the test (temporary build/verify scripts, the payment envelope).

Confirm no new transaction was created by the evidence demo: the sender nonce must
still be 14 and the DB counts must still be 1/1/1 afterwards.

## Troubleshooting

- **Facilitator exits 2 with `configuration error`.** Read the message: it names the
  missing or mismatched setting (signing service unreachable, wallet file not
  deployment-ready, node genesis mismatch, Owner on a different DB). Fix the
  configuration; do not switch to mock mode to hide it.
- **`/healthz` returns 503 with `ownerReachable: false`.** The Owner is down or on a
  different DB. Restart the Owner first, then check `db_identity` matches the
  Facilitator's DB file (device + inode).
- **Demo script reports a transient gRPC 502.** The Testnet node or proxy hiccuped on
  a read. Re-run the script; a read-only check may be retried freely.
- **Demo script reports `SKIP` for facilitator/DB checks.** Expected on a machine
  without the deployment. The on-chain checks are the authoritative ones.
- **Port 8787 already in use.** A Facilitator is already running; check its PID file
  before starting another one.
