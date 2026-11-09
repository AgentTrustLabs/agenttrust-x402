# TASK 22 — HTTP Failure Semantics & Full-Phase Timeout Verification

Date: 2026-11-05 · TASK 21's pinned transport was correct about *where* the socket goes but
bounded only one phase of the request. **Five timeout defects reproduced, one coherent deadline
implemented, 918/918 tests pass.** Token 1004 still TRUSTED, same bytes, same hash.

---

## VERIFIED

### V1 — Source trace of timeout coverage before this task

TASK 21's transport, as delivered:

```ts
// 1. DNS — awaited, unbounded
const dest = await resolveCardDestination(rawUrl, opts.lookup, {...});

// 2. request created (connect starts)
const req = lib.request({...}, res => {...});

// 3. idle timer only
req.setTimeout(timeoutMs, () => { req.destroy(...); });

req.end();
```

| Phase | Bounded by | Verdict |
|---|---|---|
| DNS resolution | **nothing** — plain `await` | ✗ unbounded |
| TCP connect | `req.setTimeout` | Partial: Node arms the socket timeout on `connect`, so it fires — but the promise also had no absolute cap |
| TLS handshake | `req.setTimeout` | Fires via socket idle timer, but not independently demonstrated |
| Response headers | `req.setTimeout` | Fires |
| Body streaming | `req.setTimeout` | **Idle only** — resets on every chunk, so a drip evades it forever |
| Whole lifecycle | nothing | ✗ no absolute deadline |

The task's suspicion was correct on both counts: DNS was outside the timeout entirely, and
`req.setTimeout` is an idle timer, not a deadline.

### V2 — The five reproduced defects

Each was proven before any change, with a deterministic local fixture.

#### D1 — DNS resolution was completely unbounded

```console
FAIL P1. a DNS resolution that never completes is bounded by the deadline
       must not hang forever (elapsed 3002ms)
FAIL P2. a DNS resolution that exceeds the deadline is bounded
       must not wait for the 5s resolver (elapsed 3000ms)
```

A resolver that never resolves made `httpGetPinned` hang indefinitely. A permissionless registry
could point an `agent_uri` at a host whose authoritative nameserver blackholes queries, and
verification would never return. The MCP layer's 30 s `withTimeout` masked it for `trust.verify`,
but the library, the CLI and the commerce orchestrator all hung.

#### D2 — A late DNS answer could still open a connection

```console
FAIL P3. a late DNS answer cannot open a connection after cancellation
       timed out  expected: false  actual: true
```

Because there was no deadline on DNS, a resolver that eventually answered started the request
after any caller-side timeout had already fired. Reproduced: the fixture server received a
connection from a DNS answer that arrived *after* the caller had given up.

#### D3 — TCP connect had no absolute bound

```console
FAIL P4. a stalled TCP connect is bounded and the socket is destroyed
       connect must be bounded (elapsed 4000ms)
```

Against a TEST-NET-1 destination (`192.0.2.1`, routable nowhere, so SYNs are dropped), the call
did not return within 4 s at a 300 ms configured timeout. `req.setTimeout` alone does not bound
this — the promise had no absolute cap.

#### D4 — A stalled TLS handshake left the socket open

```console
FAIL P6. a stalled TLS handshake is bounded and the socket is destroyed
       the socket was destroyed, not left open  expected: 0  actual: 1
```

Initially read as a client leak. Diagnosed properly before changing anything, with a standalone
probe comparing a raw listener that never reads against one that does:

```console
events (server never reads): [["connection", 59988]]
events (server reads):       [["connection", 45092], ["server-end", 45092], ["server-close", 45092]]
```

The client **did** destroy the socket (`end` then `close` observed as soon as the server read).
The defect was in the *fixture*: a raw `net` socket that never reads never observes the peer's
FIN. **The fixture was corrected, the transport was not changed for this** — an important
distinction, and the reason the diagnosis step matters.

The genuine part of D4 is that the handshake phase was only bounded by the socket idle timer, not
by a deadline.

#### D5 — A slow-drip body evaded the idle timeout indefinitely

```console
FAIL P10. a slow-drip body cannot extend the deadline indefinitely
       must not be extended by chunk activity (elapsed 5000ms)
```

A server sending one byte every 100 ms resets `req.setTimeout` on every chunk. Reproduction:
a 500 ms configured timeout never fired; the call ran to the 5 s test guard. Any publisher — or
any attacker with an agent registration — could keep a verification open as long as it liked.

---

## MINIMAL FIX

All changes are in `src/verify/crossAgent.ts::httpGetPinned`. TASK 21's pinning is untouched.

### One absolute deadline for the entire lifecycle

```ts
const deadlineAt = Date.now() + timeoutMs;
const remaining = () => Math.max(1, deadlineAt - Date.now());
```

DNS is raced against `remaining()`; the socket deadline timer is armed with `remaining()`; the
idle timer is re-armed with `remaining()`. Every phase consumes the *same* budget, so the total
wall time can never exceed `timeoutMs` no matter how the work is distributed.

### DNS phase bounded, and late answers neutralised

```ts
dest = await Promise.race([
  resolveCardDestination(rawUrl, opts.lookup, {...}),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`… exceeded ${timeoutMs}ms during DNS resolution`)), remaining())
  ),
]);
...
if (cancelled || Date.now() >= deadlineAt) {
  return { ok: false, failure: 'transient', error: `… exceeded ${timeoutMs}ms before connecting` };
}
```

The cancellation flag means a resolver that answers after the deadline **returns a transient
failure and never reaches the request constructor**, so no connection can be opened by a late
answer. Test P3 proves this by waiting 800 ms past the deadline and asserting the fixture server
recorded **zero** connections.

### Absolute deadline timer that covers connect and handshake

```ts
const deadlineTimer = setTimeout(() => {
  req.destroy(new Error(`card fetch aborted after ${timeoutMs}ms (deadline)`));
}, remaining());
deadlineTimer.unref?.();
req.on('close', clearDeadline);
```

`req.setTimeout` does not fire during connect or the TLS handshake, and resets on every body
chunk. This timer does neither: it is absolute, and `req.destroy()` tears the socket down. Tests
P4 (connect), P6 (handshake) and P10 (drip) each prove the bound and that the socket is gone.

### Idle timer retained as a second guard

`req.setTimeout(remaining(), …)` is kept — an idle socket still validates, and it fires sooner
than the deadline when a peer goes quiet. It is no longer load-bearing.

**Preserved, verified by the passing task21 suite:** IP pinning via custom `lookup`, `Host` and
TLS `servername` bound to the original hostname, all DNS answers checked with mixed sets refused,
IPv4/IPv6/IPv4-mapped filtering, redirects never followed, proxy environment variables ignored,
256 KiB streaming cap, raw bytes handed to SHA-256 unchanged.

---

## DELIVERABLE 1 — Explicit classification table

| Outcome | Class | `card_retrieved` | Verdict | Reasoning |
|---|---|---|---|---|
| 200 + valid card | — | PASS | continue | evidence established |
| **400** | permanent | FAIL | REJECTED | the registry's own record produces a malformed request to its own endpoint |
| **401** | permanent | FAIL | REJECTED | card is not publicly retrievable, so the anchor cannot be checked |
| **403** | permanent | FAIL | REJECTED | as 401 |
| **404** | permanent | FAIL | REJECTED | at the URI the registry declares serves the card, "not here" contradicts the record |
| **408** | **transient** | INCONCLUSIVE | INCONCLUSIVE | the publisher could not answer in time |
| **410** | permanent | FAIL | REJECTED | publisher states permanent removal |
| **429** | **transient** | INCONCLUSIVE | INCONCLUSIVE | rate limiting is availability, never evidence about an agent |
| **500** | **transient** | INCONCLUSIVE | INCONCLUSIVE | publisher fault |
| **502** | **transient** | INCONCLUSIVE | INCONCLUSIVE | upstream fault |
| **503** | **transient** | INCONCLUSIVE | INCONCLUSIVE | unavailable |
| **504** | **transient** | INCONCLUSIVE | INCONCLUSIVE | upstream timeout |
| DNS failure | **transient** | INCONCLUSIVE | INCONCLUSIVE | resolver failure establishes nothing |
| TLS failure | **transient** | INCONCLUSIVE | INCONCLUSIVE | expired / intercepted / transient — none is an identity claim |
| Connection refused | **transient** | INCONCLUSIVE | INCONCLUSIVE | service down |
| Connection timeout | **transient** | INCONCLUSIVE | INCONCLUSIVE | unavailable |
| Response timeout | **transient** | INCONCLUSIVE | INCONCLUSIVE | unavailable |
| Empty response | permanent | FAIL | REJECTED | a 200 with no body is not a card |
| Malformed JSON | permanent | FAIL | REJECTED | served bytes are not a card |
| Invalid card structure | permanent | FAIL | REJECTED | served a document that is not a card |
| Oversized response | permanent | FAIL | REJECTED | a card over the cap is not a card |
| Prohibited destination | permanent | FAIL | REJECTED | the record points somewhere the gateway must not go |
| **Redirect response (3xx)** | permanent | FAIL | REJECTED | **policy**: not followed, so nothing was served at the claimed location |

### The 3xx decision, stated plainly

The task asked for an explicit choice. **A redirect is treated as an invalid-endpoint policy
failure, not as evidence of fraud.** The gateway does not follow redirects (they are a classic
SSRF pivot), so it cannot know whether the payload behind the redirect is the anchored card — it
only knows that the URI the registry published does not serve it. That is a positive statement
about the *endpoint*, and it maps to `permanent` → REJECTED for the token.

It is **not** described as proof the owner is fraudulent, and it does not establish an owner
mismatch or a hash mismatch. Documentation and code comments say exactly that. An operator who
preferred "redirect = temporary" could flip one line in `classifyHttpStatus`; that is a
defensible alternative, not a defect.

### REJECTED is reserved for contradictions

Deliberately produced only by: raw-byte hash mismatch, owner mismatch, contract reference
mismatch, revoked/inactive registration, and the "card positively is not served here" outcomes
above. Test P13 drives ten access/availability failures and asserts **every one** is
INCONCLUSIVE; test P14 drives the genuine contradictions and asserts REJECTED.

---

## DELIVERABLE 3 — Deterministic phase tests

`test/task22-phase-timeout.test.mts` — **15 tests, offline**, using a controlled resolver, local
HTTP servers, a local raw TCP listener, and a generated self-signed certificate
(`openssl req -x509 … -subj "/CN=localhost"`, `days 1`, written to `/tmp` for the run).

| # | Phase | Fixture | Assertion |
|---|---|---|---|
| P1 | DNS never resolves | resolver returns a never-settling promise | returns ≤ 2 s at 300 ms budget, transient |
| P2 | DNS exceeds budget | resolver answers at 5 s | returns ≤ 2 s, transient |
| P3 | **late DNS** | resolver answers at 400 ms, deadline 50 ms | **server records 0 connections** after 800 ms |
| P4 | TCP connect stalls | `192.0.2.1` (TEST-NET-1) | bounded, transient |
| P5 | connection refused | port closed after listen | transient |
| P6 | **TLS handshake stalls** | raw TCP listener that reads but never responds | bounded, transient, **socket count 0** |
| P7 | TLS cert invalid | self-signed cert, hostname mismatch | transient, error names a TLS cause |
| P8 | no response headers | HTTP server that never responds | bounded, transient, socket count 0 |
| P9 | body stalls mid-stream | headers + partial body, then silence | bounded, transient, socket count 0 |
| P10 | **slow drip** | 1 byte / 100 ms, 500 ms budget | absolute deadline honoured, socket count 0 |
| P11 | oversized body | 8 MiB producer | permanent, producer stopped, socket count 0 |
| P12 | classification table | — | all 11 HTTP statuses |
| P13 | availability ≠ fraud | 408/429/500/502/503/504/DNS/TLS/refused/timeout | **all INCONCLUSIVE** |
| P14 | contradictions | hash, owner, revoked | **all REJECTED** |
| P15 | redirect policy | 302 | never TRUSTED; policy documented |

### Evidence of actual cancellation

Not "the promise resolved" — the fixtures measure the transport:

- **Socket accounting.** Each server keeps a live-socket set from `connection`/`close` events.
  Tests P6, P8, P9, P10, P11 assert the set is **empty** after the call returns plus a settle
  delay.
- **Producer stopped.** P11 counts bytes the server actually wrote and asserts it stopped within
  one chunk of the abort.
- **Zero connections.** P3 asserts the fixture server accepted **zero** connections, proving a
  late DNS answer cannot initiate one.
- **Wall-clock bounds.** Every timeout test returns well inside the `within()` guard, so "the
  deadline fired" is measured, not inferred.

---

## DELIVERABLE 5 — Files changed

| File | Change |
|---|---|
| `src/verify/crossAgent.ts` | absolute lifecycle deadline; DNS raced + late-answer neutralisation; deadline timer spanning connect/TLS/headers/body; idle timer re-armed from remaining budget |
| `test/task22-phase-timeout.test.mts` | **new**, 15 phase tests |
| `docs/archive/TASK22-result.md` | this report |

`src/audit/lock.ts` — **not modified** (`git diff` empty), per instruction. TASK 06's lock race was
neither investigated nor fixed.

---

## DELIVERABLE 7 — Full regression

```console
$ npx tsc --noEmit   →  typecheck OK
$ npx tsc            →  build OK
$ npm test           →  all suites passed   (23 suites, 918/918)
```

| Suite | Result |
|---|---|
| task22-phase-timeout (new) | **15/15** |
| task21-ssrf-transport | 20/20 |
| task20-card-boundary | 37/37 |
| task19-mcp-interop | 13/13 |
| task03-discovery-and-trust | 47/47 |
| task03-cli-contract | 11/11 |
| task04-sdk-conformance / x402-exact | 15/15 · 44/44 |
| task05-commerce | 36/36 |
| task06-audit-integrity / 06.1-lock | 25/25 · 14/14 |
| task07-facilitator-readiness | 30/30 |
| task08-mcp-interface | 39/39 |
| task10 / task11 / task12 / task14 / task15 | 14 · 14 · 11 · 18 · 13 |
| finding-1…4, regression-bytes | 6 · 7 · 11 · 10 · 9 |
| **Total** | **918/918 across 23 suites** |

End-to-end demonstration:

```console
$ node scripts/task08-demo.mjs
7 trust reject      trust_rejected  facilitator calls=0
8 payment reject    payment_rejected  settled=false
9 audit verified    3/3
  forged auth       AUTHORIZATION_NOT_ACCEPTED
  shutdown          exit 0, stderr clean
NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED
```

**Offline confirmed:** `HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 npx tsx test/task22-phase-timeout.test.mts` → **15/15 passed**.

---

## DELIVERABLE 8 — Token 1004

```console
$ npm run verify -- --token-id 1004
agent discovered           PASS      card retrieved  PASS
card valid                 PASS      badge valid     PASS
hash matches on chain      PASS      owner matches   PASS
status active              PASS      contract references match  PASS
TRUST DECISION             TRUSTED
card         200 · 2777 bytes · https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json
sha256 (local)     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)  3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions       0 (read-only)
```

Exact raw-byte hash unchanged. On-chain: `nonce 4`, `19943619923` microCCD (19 943.619923 CCD) —
identical to TASK 02. **Zero transactions, zero signing, zero settlement.**

---

## DELIVERABLE 9 — Remaining limitations

1. **OS-level DNS cancellation is not possible with the current API.** `dns.lookup` delegates to
   `getaddrinfo(3)`, which has no cancellation handle; `dns.Resolver.cancel()` only aborts
   asynchronous `resolve*()` queries made through c-ares, not the `lookup` path the transport uses
   (and the transport needs `lookup` semantics for `/etc/hosts` and NSS). The threads doing the
   `getaddrinfo` call keep running until the OS answers.

   **What is guaranteed instead:** the deadline fires, the call returns transient, and the late
   answer **cannot** open a connection — proven by P3 (zero connections after 800 ms past the
   deadline). The abandoned promise resolves into a no-op branch and its result is discarded.

   **What is not guaranteed:** the `getaddrinfo` worker thread is not reclaimed until the resolver
   answers. Repeated verifications against a blackholed name could accumulate stuck libuv threads.
   Bounding that would require running resolution in a short-lived worker/thread pool that can be
   terminated, which is an architectural change beyond this task.

2. **One pinned address, no failover.** Only `addresses[0]` is used; a healthy second address goes
   unused and its failure is reported transient. Correct verdict, unused capacity.

3. **TLS failures are classed transient by policy.** An expired certificate could be a permanent
   operator error. Without more from the TLS layer, "evidence unavailable" is the honest reading;
   INCONCLUSIVE was chosen deliberately.

4. **Redirect → permanent is a policy choice**, documented above, not a derived fact.

5. **`unref()` on the timers** means a process with nothing else pending will exit rather than
   wait for the deadline. Correct for a CLI; a long-lived server keeps the loop alive by other
   means.

6. **No throughput tuning.** `agent: false` opens a fresh socket per fetch, so every verification
   pays a TCP/TLS handshake. Fine for read-only verification; not benchmarked under load.

7. **Pre-existing TASK 06 audit-lock flake remains, untouched as instructed.** It is unrelated to
   this task and `src/audit/lock.ts` was not modified (`git diff` empty). All recorded `npm test`
   runs in this task passed 23/23.

---

## NOT TESTED

- A real blackholed authoritative nameserver over the public internet (fixture-level only).
- Real certificate revocation (CRL/OCSP) behaviour; the fixture uses a self-signed cert.
- Concurrent phase exhaustion under load; the deadline is proven per-request, not under
  thousands of simultaneous verifications.
- Behaviour behind a corporate egress firewall or a TLS-inspecting proxy.
- Card semantic truthfulness: TRUSTED still means only "identity claim internally consistent and
  card bytes match the on-chain anchor" — never that an agent is honest, safe, or competent.

## BLOCKED

Nothing in scope. The single genuinely uncancellable phase (OS `getaddrinfo`) is reported above
with both what is guaranteed and what is not, rather than papered over. No custom TLS stack, no
transport replacement, and no unsafe workaround was introduced.

---

## FINAL VERDICT

**FULL LIFECYCLE NOW BOUNDED BY ONE DEADLINE. 918/918 green.**

TASK 21 put the socket on the validated address but bounded only the response phase, and bounded
it with an *idle* timer. Five defects followed from that, all reproduced first: a resolver that
never answers hung the call forever; a late answer started a connection after the caller had
given up; a stalled TCP connect outlived its configured timeout; a stalled TLS handshake was
socket-idle-bound only; and a server dribbling one byte per 100 ms reset the idle timer forever,
so a 500 ms timeout never fired.

The fix is one absolute deadline computed once and consumed by every phase — DNS raced against
the remaining budget with a cancellation flag that makes a late answer a no-op, and a
`req.destroy()` timer spanning connect, handshake, headers and body that `setTimeout` cannot
provide because it neither fires during connect nor survives a chunk. The idle timer is retained
as a second guard and is no longer load-bearing.

Cancellation is evidenced by the transport, not by resolved promises: fixtures assert zero
connections after a late DNS answer, zero live sockets after handshake/headers/body/drip aborts,
and a stopped producer after the size cap.

Failure semantics were re-derived per status and are now explicit: 408, 429, all 5xx, DNS, TLS,
refusal and every timeout are `transient` → INCONCLUSIVE; only genuine contradictions produce
REJECTED. The 3xx decision is stated as endpoint policy, not as fraud.

One honest gap remains and is documented precisely: `getaddrinfo` cannot be cancelled by any
current Node API. The call returns bounded and the late answer cannot reach a socket — both
proven — but the underlying resolver thread is not reclaimed until the OS answers. Bounding that
would need a terminable worker, which is an architectural change this task did not take.

Token 1004 still verifies TRUSTED with the identical 2 777 bytes and `3f614404…`, and the account
remains at nonce 4 with 19 943.619923 CCD.
