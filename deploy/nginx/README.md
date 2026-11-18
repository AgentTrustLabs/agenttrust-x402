# Reverse proxy (nginx) — `api.sabokun.my.id`

The public API is served by nginx on the host:

```
https://api.sabokun.my.id/agenttrust/*  ->  http://127.0.0.1:4590/*
```

The `/agenttrust` prefix is stripped before proxying, so the resource
server sees the bare paths it serves (`/protected`, `/api/services`,
`/.well-known/agent-card.json`). This is the **inbound** reverse proxy —
it is unrelated to the egress "Proxy credential" in `deploy/README.md`,
which is the facilitator's outbound proxy to the Testnet node.

## What the config does

- HTTPS for `api.sabokun.my.id` (TLS 1.2/1.3, Let's Encrypt certificate).
- HTTP → HTTPS redirect (301), except `/.well-known/acme-challenge/`
  (served from `/var/www/certbot` so certbot issuance and renewal work).
- Proxies `/agenttrust/*` to `127.0.0.1:4590` with the prefix stripped.
- Forwards `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- Timeouts: connect 5s, send/read 60s. The 60s read timeout covers the
  payment flow (facilitator verify + settle + on-chain finalized read),
  which can take tens of seconds; it is not infinite.
- Port 4590 stays loopback-only (the resource server binds
  `127.0.0.1:4590`); nothing else is served on this host (`location /`
  returns 404).
- HSTS for this host only (no `includeSubDomains`).
- CORS is untouched: nginx passes the `Origin` header through and returns
  the resource server's `Access-Control-*` headers unchanged. This config
  neither adds nor strips any `Access-Control-*` header.

## What it does not change

No application code, no frontend, no wallet, no payment flow, no Agent
Card, no Token #1004. This only adds files under `deploy/nginx/` (plus a
pointer in `deploy/README.md`). The host, DNS, and certificates are
operator actions.

## Prerequisites (host)

1. **DNS:** `api.sabokun.my.id` A record → the host's public IPv4. It
   must resolve to the host **before** certbot runs. (AAAA is optional;
   the config listens on IPv4 only — add `listen [::]:80;` and
   `listen [::]:443 ssl;` if the host has IPv6.)
2. **nginx** installed on the host (`apt install nginx` on Debian/Ubuntu,
   `dnf install nginx` on RHEL). **nginx is not installed on the build
   VM, so `nginx -t` could not be run there — it must be run on the host
   before reloading (see Verify).**
3. **The resource server deployed and running** (recovery done):
   `systemctl is-active agenttrust-resource.service` must be `active`,
   and `ss -tlnp | grep 4590` must show `127.0.0.1:4590` only.
4. **Firewall:** allow `80/tcp` and `443/tcp`; do **not** open `4590/tcp`.
5. **certbot** installed (`apt install certbot` / `dnf install certbot`).
   No certificate is issued by this repo and no DNS change is made here.

## Install (as root, on the host)

1. Install nginx and certbot (see prerequisites).
2. From the repo checkout root, check that the host has no existing
   server block for this name: `grep -r "api.sabokun.my.id" /etc/nginx/
   || true` (no output means no conflict). If a server block already
   exists — for example from an earlier `certbot --nginx` run — STOP and
   resolve the conflict with the operator before installing: remove or
   merge the old block. Two blocks for the same name make nginx warn
   "conflicting server name" and serve the first-loaded one. Then copy
   the config:
   - Debian/Ubuntu:
     `install -m 0644 deploy/nginx/api.sabokun.my.id.conf /etc/nginx/sites-available/api.sabokun.my.id.conf && ln -sf /etc/nginx/sites-available/api.sabokun.my.id.conf /etc/nginx/sites-enabled/`
   - RHEL:
     `install -m 0644 deploy/nginx/api.sabokun.my.id.conf /etc/nginx/conf.d/api.sabokun.my.id.conf`
3. Create the certbot webroot: `mkdir -p /var/www/certbot`
4. **First certificate.** The config references cert files that do not
   exist yet, so nginx cannot start until the certificate exists. Run
   certbot standalone while nginx is stopped (or not yet started):
   `systemctl stop nginx` (if running)
   `certbot certonly --standalone -d api.sabokun.my.id`
   On first run, certbot asks for an email address (optional, for
   expiry notices) and agreement to the Let's Encrypt Terms of Service.
   This writes `/etc/letsencrypt/live/api.sabokun.my.id/fullchain.pem`
   and `privkey.pem` — the exact paths the config references.
5. Validate and start: `nginx -t` (must print `syntax is ok` and `test
   is successful`), then `systemctl start nginx` (or `reload` if it is
   already running).
6. **Renewal.** After nginx is running, switch renewal to webroot so it
   needs no downtime, and record the reload hook so nginx serves the
   renewed certificate. Use `certbot reconfigure` (requires Certbot
   >= 2.3.0; check with `certbot --version`). Confirm the certificate
   name first with `certbot certificates` (it is `api.sabokun.my.id`):
   `certbot reconfigure --cert-name api.sabokun.my.id --webroot -w /var/www/certbot --deploy-hook "systemctl reload nginx"`
   This runs a test renewal against the Let's Encrypt staging server
   first and only saves the new settings if it succeeds — it issues no
   new production certificate. Future `certbot renew` then uses the HTTP
   block's acme-challenge location with nginx still running, and reloads
   nginx after each successful renewal.
   Do NOT re-run `certbot certonly --webroot` to switch the renewal
   method: for a certificate that already exists it prompts to keep the
   existing certificate (which does not change the renewal
   authenticator) or renew-and-replace (which issues a new certificate
   for no benefit). `reconfigure` is the supported way to change the
   renewal settings.
   Verify the switch: `certbot renew --dry-run` (it must succeed), and
   confirm `/etc/letsencrypt/renewal/api.sabokun.my.id.conf` shows
   `authenticator = webroot`, a `webroot_path` of `/var/www/certbot`,
   and `renew_hook = systemctl reload nginx`. Note: `--dry-run` does not
   run deploy hooks by default; add `--run-deploy-hooks` to test the
   hook too (it reloads nginx after a successful dry run, using the
   current certificate).
   The alternative is to keep standalone: `certbot reconfigure
   --cert-name api.sabokun.my.id --authenticator standalone --pre-hook
   "systemctl stop nginx" --post-hook "systemctl start nginx"
   --deploy-hook ""` — renewal then briefly stops nginx (the post-hook
   restarts it with the new certificate, so no reload hook is needed).
   If Certbot is older than 2.3.0 and has no `reconfigure`, the official
   fallback is: (1) test the amended options with a dry run —
   `certbot renew --cert-name api.sabokun.my.id --webroot -w
   /var/www/certbot --deploy-hook "systemctl reload nginx" --dry-run`;
   (2) if the dry run succeeds, persist the change with a live renewal
   — `certbot renew --cert-name api.sabokun.my.id --webroot -w
   /var/www/certbot --deploy-hook "systemctl reload nginx"
   --force-renewal`. WARNING: `--force-renewal` issues a NEW production
   certificate even though the current one is not due, and it counts
   against Let's Encrypt's duplicate-certificate rate limit (5 per 7
   days for the same domain set). Do not run step (2) without the
   operator's explicit approval; upgrading Certbot to >= 2.3.0 is
   preferred.

## Verify (on the host, after install)

- `nginx -t` — `syntax is ok`, `test is successful`.
- `curl -s -o /dev/null -w "%{http_code}\n" http://api.sabokun.my.id/agenttrust/protected`
  → `301` (HTTP → HTTPS redirect).
- `curl -s https://api.sabokun.my.id/agenttrust/protected` → HTTP 402
  with the x402 challenge naming
  `https://api.sabokun.my.id/agenttrust/protected`. A **402 (not 404)**
  proves the prefix was stripped: without stripping, the resource
  server would 404 on `/agenttrust/protected`.
- `curl -s https://api.sabokun.my.id/agenttrust/api/services` → HTTP
  200 with the service list (empty until onboarding).
- Preflight (after the origin is added to `CORS_ORIGINS`):
  `curl -s -D - -o /dev/null -X OPTIONS -H "Origin: https://<your-vercel-project>.vercel.app" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: X-PAYMENT" https://api.sabokun.my.id/agenttrust/protected`
  → 204 with `Access-Control-Allow-Origin` (before the origin is added,
  403).
- `ss -tlnp | grep 4590` → `127.0.0.1:4590` only (not `0.0.0.0:4590`).
- `curl -s -o /dev/null -w "%{http_code}\n" https://api.sabokun.my.id/`
  → `404` (nothing else is served on this host).

## Troubleshooting

- `nginx -t` fails with "cannot load certificate": the certificate does
  not exist yet — run install step 4 (certbot standalone) first.
- `502 Bad Gateway`: the resource server is not running —
  `systemctl status agenttrust-resource.service`,
  `journalctl -u agenttrust-resource.service`.
- `404` on `/agenttrust/protected`: the prefix was not stripped — check
  that the installed config is the repo copy (not an edited one) and
  that `location /agenttrust/` uses `proxy_pass http://127.0.0.1:4590/;`
  (with the trailing slash).
- Certificate renewal fails: check the HTTP block's acme-challenge
  location and that `/var/www/certbot` exists and is writable by
  certbot; see install step 6 for the webroot switch.
- `curl` to the public URL fails from the host itself: the host may not
  resolve its own public name — test from another machine, or add the
  name to `/etc/hosts` for the test.
