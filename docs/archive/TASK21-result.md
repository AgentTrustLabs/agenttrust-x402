# TASK 21 — SSRF Transport Hardening & Retrieval Failure Semantics

Date: 2026-11-05 · The DNS-rebinding gap left open by TASK 20 is closed by pinning the
validated address to the socket, not by validating the hostname harder. Failure semantics were
re-derived per status code. **888/888 tests pass across 22 suites; token 1004 still TRUSTED with
the same 2 777 bytes and the same SHA-256.**

---

## VERIFIED

### V1 — Transport trace (read from source, then proven with a socket)

TASK 20 ended at `checkAgentUri()` → `fetchCardBytes(url, fetchImpl)`. The `fetchImpl` in every
production path was `fetch as never` — Node's global `fetch`, i.e. `undici`. So the real chain was:

```
registry record.agent_uri
  → checkAgentUri()          ← string/URL validation only
  → fetchCardBytes()
  → global fetch (undici)
       → dns.lookup(hostname)   ← SECOND, INDEPENDENT RESOLUTION
       → connect(resolved address)
```

| Question | Answer (verified) |
|---|---|
| Does DNS resolve before or during the connection? | **During** — inside `undici`, after our validation returned. |
| Is the validated IP the IP connected to? | **No.** `checkAgentUri` never resolved anything; it inspected the URL's hostname string. |
| IPv4 and IPv6 both covered? | Only literals in the URL. A hostname resolving to `::1` or `::ffff:127.0.0.1` was never examined. |
| Can multiple answers select an unsafe address? | **Yes** — undici picks from the answer set; one public + one private answer was a coin flip. |
| Can redirects bypass validation? | No — `fetch` was called without `redirect: 'manual'`, but the injected wrapper checked `res.ok` and 3xx is not ok, so the body was never read... **but** undici had already followed the redirect internally before returning `res`. A 302 → `http://169.254.169.254/` **was actually requested**. |
| Proxies / dispatcher / env proxy? | undici honours `NODE_USE_ENV_PROXY`/dispatcher config; nothing in the code constrained it. |
| Does timeout abort the request? | **No.** `Promise.race([fetchImpl(...), timeoutPromise])` rejects the *await*; the underlying `fetch` keeps running with its socket open until it completes on its own. |

That last one is the TASK 21 timeout question and the answer was: the request was **abandoned,
not aborted**.

### V2 — The bypass, reproduced

`test/task21-ssrf-transport.test.mts` test 01 documents it directly: a URL that is https,
public-looking, and free of userinfo passes `checkAgentUri` — and under TASK 20 that was the
entire defence. Test 02 then proves the new destination check refuses the same URL when its
hostname resolves to `127.0.0.1`.

Every destination test proves the **peer address of an accepted TCP connection**, not a
validator's return value: the fixture server records `req.socket.remoteAddress`, and the
"unsafe" cases assert the server saw **zero connections** — stronger than "zero successful
responses".

---

## REPRODUCED DEFECTS

| # | Defect | Evidence |
|---|---|---|
| **S1** | Hostname validation ≠ destination validation. A hostname resolving to loopback/private/link-local passed and was contacted. | Tests 02–04: with TASK 20's transport, `cards.attacker.example → 127.0.0.1` reached the server. |
| **S2** | MIXED answer sets accepted. One public + one private answer: whichever undici picked. | Test 05: answer set `['93.184.216.34', '127.0.0.1']` now refuses the whole set. |
| **S3** | IPv4-mapped IPv6 unchecked (`::ffff:169.254.169.254`). | Test 06. |
| **S4** | Redirects were followed **inside undici**, before our response check ran — so a 302 to a metadata endpoint was requested even though we never read its body. | Test 11: pinned transport contacts exactly one address and does not follow. |
| **S5** | Timeout abandoned the request instead of aborting it; the socket stayed open. | Test 14: with the pinned transport, `req.destroy()` fires and the call returns in <2 s against a 5 s server. |
| **S6** | 400/401/403/410 were classed `permanent` → REJECTED, but so was nothing else wrong… except 429 and 408 were handled by the transient rule only by accident of ordering. Classification was implicit rather than stated, and 401/403 were treated as fraud. | Test 17 asserts the explicit table; test 18 drives all 11 statuses end-to-end. |

---

## MINIMAL FIX

New in `src/verify/crossAgent.ts`:

**`isProhibitedAddress(ip)`** — one place that decides whether an address may be contacted.
Normalises IPv4-mapped IPv6 *down to the embedded IPv4 first* (that form is how a loopback
connection reaches an IPv4 socket), then covers `0/8`, `10/8`, `127/8`, `169.254/16`,
`172.16/12`, `192.168/16`, `100.64/10`, `224/4+`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`.

**`resolveCardDestination(url, lookup)`** — resolves **once**, checks **every** answer, and
refuses the entire set if any address is prohibited. Resolution failure is `transient`; a
prohibited destination is `permanent`. The returned addresses are what the transport pins — no
second lookup ever happens, which is what closes rebinding: test 07 asserts the resolver was
called **exactly once** even when it returns different answers on successive calls.

**`httpGetPinned(url, opts)`** — `node:http`/`node:https` with:

- `lookup: (h, o, cb) => cb(null, pinned.address, pinned.family)` — the validated address *is* the socket address. Handles both the `all: true` and single-address callback shapes (Node calls the former internally; the first implementation returned `undefined` and failed with `ERR_INVALID_IP_ADDRESS`, which test 14 caught).
- `host: url.hostname` preserved for the `Host` header; `servername: url.hostname` preserved for TLS SNI and certificate verification. Pinning does not break virtual hosting or TLS — **no custom TLS stack**.
- redirects never followed: a 3xx is returned as a failure and the socket destroyed.
- body capped at 256 KiB **while streaming**, so an oversized body is never fully buffered.
- `req.setTimeout(ms, () => req.destroy(...))` — a real abort; the socket is torn down.
- `agent: false`, and the transport never consults `HTTP_PROXY`/`HTTPS_PROXY`. Test 13 sets all three and proves the card host is contacted directly with the expected body.
- bytes are assembled from the raw stream and hashed unchanged — no re-encoding, so exact raw-byte SHA-256 is preserved.

**`defaultLookup`** — `dns.lookup(host, { all: true })`, so a multi-answer record is seen in full
rather than truncated to the first address.

**`classifyHttpStatus(status)`** — the explicit table (see V4).

Plumbing: `fetchImpl` became **optional** on `fetchCardBytes`, `verifyAgent`, `OrchestratorDeps`
and `ServerConfig`. Omitting it selects the pinned transport. The CLI no longer wraps global
`fetch`; the MCP tools and orchestrator now spread the option only when a caller supplied one.
That inversion matters: previously every production path *forced* the unpinned `fetch`, so the
safe transport could never have been reached.

**Not changed:** the six MCP tools and schemas, trust policy, payment module, `badge_valid`
scoring, audit format, registry/identity architecture, on-chain code.

---

## V4 — HTTP status → verdict classification

| Outcome | Class | `card_retrieved` | `trust_decision` | Rationale |
|---|---|---|---|---|
| 200 + valid card | — | PASS | continue normal evaluation | — |
| 400 Bad Request | permanent | FAIL | **REJECTED** | The URI is being requested incorrectly by *the registry's own record*; it does not serve this card. |
| 401 Unauthorized | permanent | FAIL | **REJECTED** | The card is not publicly retrievable, so the anchor cannot be checked; a card that cannot be fetched cannot be the published card. |
| 403 Forbidden | permanent | FAIL | **REJECTED** | As 401. |
| 404 Not Found | permanent | FAIL | **REJECTED** | At a URI the registry declares serves the card, "not here" is a positive contradiction. |
| 408 Request Timeout | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | The publisher could not answer in time — unavailable, not fraudulent. |
| 410 Gone | permanent | FAIL | **REJECTED** | The publisher states the resource is permanently removed. |
| 429 Too Many Requests | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Rate limiting is an availability condition, never evidence about an agent. |
| 500 | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Publisher fault. |
| 502 | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Upstream fault. |
| 503 | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Unavailable. |
| 504 | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Upstream timeout. |
| 3xx redirect | permanent | FAIL | **REJECTED** | Not followed by design, so nothing was served at the claimed location. |
| DNS failure (ENOTFOUND/ESERVFAIL) | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | A resolver failure establishes nothing about the agent. |
| TLS failure | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Could be an expired cert, an interception proxy, or a transient fault — none of which proves fraud. |
| Connection refused | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Service down. |
| Timeout / abort | **transient** | INCONCLUSIVE | **INCONCLUSIVE** | Unavailable. |
| Empty response | permanent | FAIL | **REJECTED** | A 200 with no body is not a card. |
| Malformed content (not UTF-8 / not JSON / not an object) | permanent | FAIL | **REJECTED** | Served bytes that are not a card. |
| Valid JSON, wrong structure | permanent | FAIL | **REJECTED** | Served a document that is not a card. |
| Unsupported / wrong content-type | — | PASS if bytes valid | continues | The header is metadata; the on-chain hash binds **bytes**. Recorded, never decisive. |
| Oversized body (>256 KiB) | permanent | FAIL | **REJECTED** | A card larger than the limit is not a card. |
| Prohibited destination (SSRF) | permanent | FAIL | **REJECTED** | The record itself points somewhere the gateway must not go. |

**REJECTED is reserved for real contradictions** — raw-byte hash mismatch, owner mismatch,
contract reference mismatch, revoked/inactive registration, and the "the card positively is not
served here" cases above. **REJECTED is never produced by** 408, 429, 5xx, DNS, TLS, refusal, or
timeout. Test 18 drives all eleven statuses through `verifyAgent` and asserts both directions of
that rule.

---

## TESTS PROVING THE ACTUAL CONNECTION DESTINATION

`test/task21-ssrf-transport.test.mts` — **20 tests, offline, deterministic.** A controlled
resolver returns addresses we choose; a local `node:http` server records `req.socket.remoteAddress`
per accepted connection. No real cloud metadata host, no production internal service, and no DNS
query leaves the machine (verified: the suite passes with `HTTP_PROXY`/`HTTPS_PROXY` poisoned to
`127.0.0.1:9`).

| # | Test | What it proves |
|---|---|---|
| 01 | `checkAgentUri` alone does not protect the destination | the gap is stated as a test, not prose |
| 02 | hostname → loopback refused | destination check catches what hostname check misses |
| 03 | hostname → RFC1918 refused | `10/8`, `172.16/12`, `192.168/16`, CGNAT |
| 04 | hostname → link-local / metadata refused | `169.254.169.254`, `fe80::1` |
| 05 | **mixed answers refused** | one unsafe address poisons the set |
| 06 | IPv4-mapped IPv6 normalised and refused | `::ffff:127.0.0.1`, `::ffff:169.254.169.254` |
| 07 | rebinding cannot change the destination | resolver called **exactly once** |
| 08 | DNS failure is transient | not a contradiction |
| 09 | **pinned transport lands on the validated IP, keeps `Host`** | server recorded `127.0.0.1`, `Host: cards.example:<port>`, bytes verbatim |
| 10 | unsafe resolution opens **no socket at all** | server saw 0 connections |
| 11 | redirect not followed | one hop only, status surfaced |
| 12 | redirect chain / loop identical | one request, no loop |
| 13 | **proxy env vars do not redirect** | all three set; direct connection, correct body |
| 14 | **timeout actually aborts** | 5 s server, 200 ms timeout, returned <2 s ⇒ socket destroyed |
| 15 | connection refused is transient | — |
| 16 | 256 KiB cap on the pinned path | streaming abort, classed permanent |
| 17 | status classification table | all 12 statuses |
| 18 | only permanent → REJECTED | 11 statuses end-to-end through `verifyAgent` |
| 19 | unprotected content-type not decisive | — |
| 20 | malformed content is permanent | served non-card → REJECTED |

---

## FILES CHANGED

| File | Change |
|---|---|
| `src/verify/crossAgent.ts` | `isProhibitedAddress`, `resolveCardDestination`, `httpGetPinned`, `defaultLookup`, `classifyHttpStatus`; `fetchImpl` optional; `checkAgentUri` gains `allowPrivateHosts` |
| `src/mcp/tools.ts` | pass `fetchImpl` only when injected, so production uses the pinned transport |
| `src/commerce/orchestrator.ts` | `fetchImpl` optional, spread only when supplied |
| `src/cli/verify.ts` | dropped the global-`fetch` card wrapper |
| `test/task21-ssrf-transport.test.mts` | **new**, 20 tests |
| `docs/archive/TASK21-result.md` | this report |

---

## FULL REGRESSION

```console
$ npx tsc --noEmit   →  exit 0
$ npx tsc            →  exit 0
$ npm test           →  all suites passed   (22 suites, 888/888)
```

| Suite | Result |
|---|---|
| task21-ssrf-transport (new) | **20/20** |
| task20-card-boundary | 37/37 |
| task19-mcp-interop | 13/13 |
| task03-discovery-and-trust | 47/47 |
| task03-cli-contract | 11/11 |
| task04-sdk-conformance / x402-exact | 15/15 · 44/44 |
| task05-commerce | 36/36 |
| task06-audit-integrity / 06.1-lock | 25/25 · 14/14 |
| task07-facilitator-readiness | 30/30 |
| task08-mcp-interface | 39/39 |
| task10 / task11 / task12 / task14 / task15 | 14/14 · 14/14 · 11/11 · 18/18 · 13/13 |
| finding-1…4, regression-bytes | 6/6 · 7/7 · 11/11 · 10/10 · 9/9 |
| **Total** | **888/888** |

Run three times consecutively: 22/22 suites passing each time.

End-to-end demonstration:

```console
$ node scripts/task08-demo.mjs
3 trust             TRUSTED
4 second agent      19  REJECTED  (live third-party)
6 success           access_granted  settled=false (SIMULATED)
9 audit verified    3/3
  forged auth       AUTHORIZATION_NOT_ACCEPTED
  shutdown          exit 0, stderr clean
NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED
```

**Offline confirmed:** `HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 npx tsx test/task21-ssrf-transport.test.mts` → **20/20 passed**.

---

## TOKEN 1004 VERIFICATION

```console
$ npm run verify -- --token-id 1004
agent discovered           PASS
card retrieved             PASS
card valid                 PASS
badge valid                PASS
hash matches on chain      PASS
owner matches              PASS
status active              PASS
contract references match  PASS
────────────────────────────────────────
TRUST DECISION             TRUSTED
card         200 · 2777 bytes · https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json
sha256 (local)     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)  3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions       0 (read-only)
```

Same 2 777 bytes, same SHA-256, still TRUSTED — now retrieved through the **pinned** transport
rather than global `fetch`, which proves pinning works against the real card host and a real TLS
handshake with SNI intact.

On-chain state: `nonce 4`, balance `19943619923` microCCD (19 943.619923 CCD). Unchanged since
TASK 02. **Zero transactions, zero signing, zero settlement, no key material touched.**

---

## REMAINING LIMITATIONS

1. **A resolver that lies consistently is not detectable.** Pinning guarantees the address we
   validated is the address we connect to; it cannot tell whether that address is the *right*
   address for the hostname. A malicious resolver returning a plausible public IP is
   indistinguishable from a correct one at this layer. Closing that needs DNSSEC or a trust
   anchor, which is out of scope and not a transport fix.
2. **No connection reuse / pooling.** `agent: false` opens a fresh socket per fetch. Correct for
   this threat model (no cross-host reuse of a pinned connection), at the cost of a TCP/TLS
   handshake per verification. Fine for read-only verification; not tuned for throughput.
3. **Only the first validated address is pinned.** When a hostname has several *safe* addresses
   only `addresses[0]` is used, so there is no failover if that one is down. A failure there is
   classified `transient`, which is the right verdict, but an available second address goes
   unused.
4. **TLS failures are classed transient.** An expired or self-signed certificate could equally be
   a permanent operator error. Without more information from the TLS layer the honest reading is
   "evidence unavailable", so INCONCLUSIVE was chosen deliberately over REJECTED.
5. **Redirect classification is a policy choice, not a derived fact.** 3xx is treated as
   `permanent` because nothing was served at the claimed location. An operator who wants
   "redirect = temporary" would be making a different, defensible choice.
6. **Pre-existing flake in `task06-audit-integrity` (unrelated, NOT fixed).** Test 11
   ("two concurrent writers produce one continuous chain") fails intermittently — reproduced
   **2/15 standalone runs** with `src/audit/lock.ts` byte-identical to its committed state
   (`git diff` empty). Root cause proven with a standalone probe: `withFileLock` creates the lock
   with `openSync(..., 'wx')` and writes the JSON in a second call, so a concurrent contender can
   `readLock()` the file while it still exists but is **empty**. `readLock` returns `null` for
   unparseable content, and `null` falls through to `throw AuditLockUnrecoverableError('lock
   content is unreadable or malformed')` — fail-closed on what is really the sub-millisecond
   in-flight window. Probe output:

   ```
   CASE1 empty lock  → THREW AuditLockUnrecoverableError after 1ms: lock content is unreadable or malformed
   CASE2 live lock   → THREW AuditLockTimeoutError after 306ms (correct: fail closed)
   ```

   An attempted fix was reverted and `lock.ts` left untouched: repairing it means choosing
   between "treat an empty lock as in-flight and retry" (weakens a fail-closed guard) and "write
   the record atomically via `link()`/rename" (a change to the audit-lock architecture, outside
   this task's scope). **Reported, not fixed.** All three recorded `npm test` runs after the
   revert passed 22/22.

---

## NOT TESTED

- A real hostile registry entry pointing at an internal host — would require an on-chain
  registration, which is forbidden.
- Real DNS rebinding against a live attacker-controlled domain.
- Concurrent fetch load; the 10 s timeout is not stress-tested.
- TLS failure paths against real bad certificates (classified by construction, not by experiment).
- Whether the pinned transport behaves identically behind a corporate egress firewall.
- Card semantic truthfulness: TRUSTED still means only "identity claim internally consistent and
  card bytes match the on-chain anchor" — never that an agent is honest, safe, or competent.

## BLOCKED

Nothing in scope. One finding (the `task06` lock flake) is reported rather than fixed because the
correct repair is an architectural decision about the audit lock, not a transport change. No
unsafe workaround was introduced.

---

## FINAL VERDICT

**SSRF GAP CLOSED AT THE SOCKET. Failure semantics re-derived. 888/888 green.**

TASK 20 validated hostnames and then let `fetch` resolve the name again — so "public-looking
hostname that resolves to `127.0.0.1`" walked straight through, and a 302 to a metadata endpoint
was actually requested by undici before our response check ever saw a status code. Destination
validation now happens on the **resolved address set**, resolution happens **exactly once**, and
the selected address is **pinned** into the socket via a custom `lookup`, with `Host` and TLS SNI
still bound to the original hostname so no custom TLS stack was needed. Mixed answer sets are
refused outright rather than gambled on, IPv4-mapped IPv6 is normalised before the check, and
proxy environment variables are ignored by a transport that never consults them.

The timeout was the quiet one: `Promise.race` abandoned the request while the socket stayed open.
The pinned transport calls `req.destroy()`, which test 14 proves by returning in under two seconds
against a server that waits five.

Failure classification is now explicit per status rather than implicit in an `ok ? PASS : FAIL`
ternary: 408, 429 and every 5xx, plus DNS, TLS, refusal and timeout, are `transient` and yield
INCONCLUSIVE; 400/401/403/404/410 and 3xx are `permanent`. REJECTED remains reserved for genuine
contradictions — hash, owner, contract, revocation, and "the card positively is not served here".

Token 1004 verifies TRUSTED through the new transport with the identical 2 777 bytes and the
identical `3f614404…` SHA-256, and the account is still at nonce 4 with 19 943.619923 CCD.

One pre-existing, unrelated intermittent failure in the audit-lock concurrency test was
reproduced (2/15 runs), root-caused to the empty-file window between `open(...,'wx')` and the
record write, and deliberately **left unfixed** with the evidence attached, because the correct
repair is a decision about the audit lock's architecture rather than this task's transport.
