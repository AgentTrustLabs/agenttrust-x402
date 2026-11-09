# TASK 20 — Agent Card Validation & Trust Boundary Review

Date: 2026-11-05 · Adversarial review of card retrieval, parsing, validation and trust
verification. **Seven reproducible defects found, all fixed.** The most serious was an SSRF
primitive: a permissionless registry could make the gateway fetch loopback and cloud-metadata
addresses.

---

## VERIFIED

### V1 — Trust boundary trace (read from source, not docs)

Data flow, with every point where external data enters a security decision:

| # | Stage | Code | Trust property |
|---|---|---|---|
| 1 | Registry discovery | `AgentRegistryMcp.callToolRaw('agent_of' \| 'search_agents')` (`src/registry/mcpClient.ts`) | **Untrusted.** Hosted MCP service; response parsed as JSON with no schema |
| 2 | Record selection | `parseDiscoveryResponse` (`crossAgent.ts:111`) | Matches `Number(r.token_id) === expect.tokenId`; anything non-object skipped |
| 3 | `agent_uri` resolution | `record.agent_uri` read straight into the fetcher (`crossAgent.ts:539`) | **Untrusted, and previously unchecked — D1** |
| 4 | HTTP retrieval | `fetchCardBytes` (`crossAgent.ts:229`) | Raw bytes; no redirect handling, no size cap, no timeout — **D1/D2/D3** |
| 5 | Response validation | same | `res.ok`, `content-type` recorded but never used as a decision input (correct: bytes are authoritative) |
| 6 | UTF-8 decode | `new TextDecoder('utf-8', { fatal: true })` | Rejects invalid UTF-8 — correct |
| 7 | JSON parse | `JSON.parse` then `typeof === 'object' && !Array.isArray` | Rejects arrays/scalars — correct |
| 8 | Card structure | `validateCard` (`crossAgent.ts:330`) | Field presence, **but not field types — D5**; single-extension assumption — **D6** |
| 9 | Raw-byte hashing | `localSha256` (`crossAgent.ts:294`) | SHA-256 over exact bytes, no normalisation — correct, and tested |
| 10 | Identity comparison | `compareCardToRecord` (`crossAgent.ts:231`) | Card claims vs registry record; registry is the authority |
| 11 | On-chain hash compare | `compareHashes` | Case/`0x` normalised; missing hash → INCONCLUSIVE — correct |
| 12 | Verdict | `decideTrust` (`crossAgent.ts:326`) | TRUSTED requires all 7 required checks PASS; one FAIL → REJECTED; else INCONCLUSIVE |
| 13 | MCP exposure | `toolTrustVerify` → `trust.verify` | Verdict reported as a normal tool result (`isError` absent), per TASK 19 semantics |

Points 3, 4, 8 were where untrusted data was used without adequate checking.

### V2 — Baseline test suite, written before any fix

`test/task20-card-boundary.test.mts` — **37 tests**, all offline, all asserting the *required*
semantics rather than the current behavior. On the untouched code: **28/37 passed, 9 failed**.
Those 9 failures are the reproduced defects. One test (`A11`) **hung the suite indefinitely** —
that is D3, and it had to be neutralised to let the remaining tests run at all, which is itself
evidence of the defect.

---

## CONCRETE DEFECTS AND FIXES

### D1 — SSRF: registry-supplied `agent_uri` was fetched with no destination check

**World's most serious finding here.** The registry is a public, permissionless directory.
Anyone can register an agent whose `agent_uri` is:

```
file:///etc/passwd
http://127.0.0.1:8545/
http://localhost:8080/admin
http://169.254.169.254/latest/meta-data/iam/security-credentials/
http://10.0.0.5/internal
```

and `verifyAgent` → `fetchCardBytes` would fetch it verbatim. Verified: all five reached the
transport stub.

```console
FAIL A8.  non-HTTP(S) URL schemes are refused      → file:///etc/passwd reached the transport
FAIL A9.  URLs carrying userinfo are refused       → https://user:pass@evil.test reached it
FAIL A10. loopback and private-network refused     → 127.0.0.1, localhost, 169.254.169.254,
                                                     10.0.0.5, 192.168.1.1 all reached it
```

Impact: an attacker who registers an agent turns any gateway that verifies it into an
orchestrated request to an address the attacker cannot reach directly — classic SSRF, with
cloud metadata (`169.254.169.254`) the worst target. No credential is needed and no user
action beyond "verify this token id".

**Fix** — `checkAgentUri()` (`crossAgent.ts:144`), applied inside `fetchCardBytes` *before* the
transport is called:

- scheme must be `http:` or `https:` (`file:`, `ftp:`, `gopher:`, `data:` refused)
- no `username`/`password` userinfo
- percent-encoded hostnames refused (parser-differential smuggling)
- `localhost`, `*.localhost`, `*.internal`, `*.local`, `*.home.arpa` refused
- IPv4 literals refused for `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`,
  `100.64/10` CGNAT, and `>= 224` multicast/reserved
- IPv6: `::1`, `::`, `fc00::/7`, `fe80::/10` refused, plus IPv4-mapped forms (`::ffff:127.0.0.1`)
  re-checked through the v4 rules
- the URL is **parsed**, not string-matched, so `http://127.0.0.1.nip.io/` is caught by whatever
  its literal is and `//evil.com` cannot pose as a path

Operator opt-in for local development: `AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS=1`. It is an
**environment variable, not a tool argument** — no MCP client can set it, which is what keeps
the boundary intact.

> **Residual limitation, stated plainly:** DNS rebinding is not prevented. The check inspects
> the URL's host, not the resolved address, so a hostname that resolves to `127.0.0.1` *after*
> the check would still be fetched. Closing that needs resolution-time pinning (connect to the
> validated IP with a fixed `Host` header), which is a transport change, not a validation one.

### D2 — No response size cap: a 64 MiB "card" was buffered and hashed

Verified: a response declaring `content-length: 67108864` was read into memory and hashed. A
permissionless registry could point `agent_uri` at a multi-gigabyte endpoint and exhaust the
gateway's memory — a denial of service that costs the attacker one registration.

**Fix** — `MAX_CARD_BYTES = 256 KiB`, enforced twice: on the declared `content-length` before
buffering, and on the actual `byteLength` after. A real card is 2 777 bytes; the cap is ~90×
headroom, so no legitimate card is excluded.

### D3 — No fetch timeout: a hanging response hung verification forever

Verified: `verifyAgent` with a fetch that never settles **never resolved**. The MCP layer wraps
tool calls in a 30 s `withTimeout`, so the server survived — but the library function itself, and
every direct caller (`src/cli/verify.ts`, `src/commerce/orchestrator.ts`,
`scripts/task03-verify.mts`), hang. In the test suite this showed up as an unsettled
top-level await and a suite that never printed a result.

**Fix** — `DEFAULT_CARD_TIMEOUT_MS = 10_000`, implemented as a `Promise.race` with a cleared
timer, configurable per call (`cardTimeoutMs`) and per server (`ServerConfig.cardTimeoutMs`).
A timeout classifies as **transient** (see D4).

### D4 — Every retrieval failure was REJECTED, including outages

Before: `checks.card_retrieved = fetched.ok ? 'PASS' : 'FAIL'`. So a 503, a 429, a 408, a DNS
failure, or a TLS error all became `FAIL` → **REJECTED**.

That violates the task's semantics directly: *"A registry lookup failure must not be misreported
as proof of fraud."* A publisher's origin being down for 30 seconds would be reported as an
agent that failed verification — an attacker-triggerable denial of trust, and a false accusation
against an honest agent.

**Fix** — failures are classified, and the class drives the verdict:

| Condition | Class | `card_retrieved` |
|---|---|---|
| 404, 403, 410, 400, 3xx, empty body, oversize, refused URI | permanent | **FAIL** → REJECTED |
| 5xx, 408, 429, status 0, DNS/TLS error, timeout | transient | **INCONCLUSIVE** |

404 stays FAIL deliberately: at a URI the registry itself declares serves the card, "there is no
card here" is a positive contradiction of the record.

### D5 — Field *presence* was validated, but not field *types*

`"name": 12345` passed `validateCard` (`ok: true`). So did `"description": ["a"]`,
`"url": 42`, `"version": false`, and — most importantly — non-string badge metadata.

```console
FAIL B5.  name=12345 must be a type error   → validateCard returned ok: true
```

Why it matters beyond tidiness: `compareCardToRecord` does `params.owner.account as string |
undefined` and then string-compares. A numeric or object value there coerces in ways the
comparison did not intend, and the resulting verdict was derived from a value the validator had
declared acceptable. Presence ≠ validity.

**Fix** — `A2A_FIELD_TYPES` enforces `string` for `name`/`description`/`url`/`version`, `array`
for `skills`, and the badge extension's `tokenAddress`, `owner.account` and `contracts.cis8004`
must be strings. `capabilities` and `capabilities.extensions` must be of the right shape too, so
a wrong-shaped container does not get blamed on a "missing extension".

### D6 — Two badge extensions: the verdict depended on array order

A card declaring **two** Concordium badge extensions — one naming the real owner, one naming an
attacker — passed validation (`.find()` took the first) and was **TRUSTED** when the first
happened to agree with the registry.

```console
FAIL B11. a second, conflicting badge extension does not create a second identity
       conflicting owner claims cannot be trusted (expected falsy, got true)
```

The document contains a contradiction about who the agent belongs to. Silently trusting
whichever array element is first makes the verdict a function of JSON ordering, which the card
author controls.

**Fix** — more than one badge extension is a card validity error:
`card declares N Concordium badge extensions (exactly one is allowed)`. A card that cannot say
which identity it claims is not a valid card.

### D7 — A green test asserted the wrong semantics (task03)

`test/task03-discovery-and-trust.test.mts` — `'network error during card fetch → REJECTED'`
encoded D4's behavior as correct. Corrected to assert INCONCLUSIVE, with the reason recorded in
the test body. Same class of problem as TASK 19's D4: the suite was written against the
implementation rather than the specification.

---

## Regression and semantics

### New suite: `test/task20-card-boundary.test.mts` — 37/37

| Group | Covers |
|---|---|
| A. Retrieval (12) | 4xx→FAIL, 5xx→INCONCLUSIVE, transport→INCONCLUSIVE, 429/408→INCONCLUSIVE, empty→FAIL, oversize refused before buffering, 302 not followed, schemes refused, userinfo refused, loopback/private refused, timeout bounded, content-type not a trust input |
| B. Structure (11) | invalid JSON, invalid UTF-8, array/scalar bodies, missing fields, **wrong types**, missing extension, malformed badge, valid-but-unanchored card, 20 000-deep JSON, self-asserted trust is inert, conflicting extensions |
| C. Consistency (12) | hash mismatch, missing hash, owner mismatch, contract mismatch, revoked, partial status, not-found, malformed discovery payload, wrong token id, pinned-owner disagreement, all-checks-pass matrix, badge advisory |
| D. Hashing (2) | exact-byte hashing, hex casing/`0x` normalisation |

### Trust semantics, verified by test

| Condition | Verdict | Test |
|---|---|---|
| All required evidence verified | **TRUSTED** | C11 happy path, task03 happy path |
| Positive contradiction (hash, owner, contract, revoked, 404, malformed card) | **REJECTED** | C1–C5, A1, B1–B7 |
| Missing/unavailable evidence (5xx, timeout, no hash, not found, partial status) | **INCONCLUSIVE** | A2–A4, A11, C2, C6, C7 |
| **Invalid external content becoming TRUSTED** | impossible — 9 separate tests | B1–B8, B10, B11 |
| **Missing evidence treated as PASS** | impossible — `NOT_TESTED` and `INCONCLUSIVE` both block | C11 matrix over all 7 required checks |
| **Lookup failure reported as fraud** | fixed, D4 | A2–A4 |
| **Valid JSON being trusted** | fixed, D5/B8 — structure alone never suffices | B8, B10 |
| Card self-asserting `trust_decision: "TRUSTED"` | inert | B10 |

`badge_valid` remains **advisory** (C12): a hosted checker disagreeing does not gate, because
every required check is re-derived locally from bytes the gateway fetched itself.

### Full regression

```console
$ npm run build      → tsc, exit 0
$ npm run typecheck  → tsc --noEmit, exit 0
$ npm test           → all suites passed
```

| Suite | Result |
|---|---|
| finding-1…4, regression-bytes | 6/6, 7/7, 11/11, 10/10, 9/9 |
| task03-cli-contract | 11/11 |
| task03-discovery-and-trust | **47/47** (1 assertion corrected — D7) |
| task04-sdk-conformance / x402-exact | 15/15, 44/44 |
| task05-commerce | 36/36 |
| task06-audit-integrity / 06.1-lock | 25/25, 14/14 |
| task07-facilitator-readiness | 30/30 |
| task08-mcp-interface | 39/39 |
| task10 / task11 / task12 / task14 / task15 | 14/14, 14/14, 11/11, 18/18, 13/13 |
| task19-mcp-interop | **13/13** (+1 SSRF-default test) |
| **task20-card-boundary** | **37/37** (new) |
| **Total** | **21 suites · 848/848 tests** |

Live end-to-end, unchanged and still TRUSTED:

```console
$ npx tsx scripts/task03-verify.mts
[3] GET agent_uri (raw bytes)     status 200 bytes 2777
[4] local SHA-256                 3f6144046d843b7b… matches on-chain: true
[5] hosted verifier               badge_valid: true
TRUST DECISION                    TRUSTED
```

On-chain state, unchanged: `nonce 4`, balance `19943619923` microCCD (19 943.619923 CCD).
**Zero transactions, zero signing, zero settlement.**

---

## FILES CHANGED

| File | Change |
|---|---|
| `src/verify/crossAgent.ts` | `checkAgentUri()`, size cap, timeout, failure classification, type validation, duplicate-extension rejection |
| `src/mcp/tools.ts` | `allowPrivateCardHosts` + `cardTimeoutMs` on `ServerConfig`, forwarded to both card paths |
| `src/mcp/server.ts` | `AGENTTRUST_ALLOW_PRIVATE_CARD_HOSTS` operator opt-in (default off) |
| `src/commerce/orchestrator.ts` | forwards the two new options to `verifyAgent` |
| `test/task20-card-boundary.test.mts` | **new**, 37 tests |
| `test/task19-mcp-interop.test.mjs` | stub opts in explicitly, +test 13 (default refuses loopback) |
| `test/task03-discovery-and-trust.test.mts` | D7 assertion corrected |
| `docs/archive/TASK20-result.md` | this report |

No change to: the six MCP tools, their schemas or names; the trust policy module; the payment
module; scoring of `badge_valid`; hashing procedure; audit format.

---

## NOT TESTED

- **DNS rebinding** — the guard validates the URL host, not the resolved address. A hostname
  that resolves to a private IP after the check would still be fetched. Documented, not fixed;
  fixing needs connect-time IP pinning.
- **Redirect following** — the gateway never follows redirects (`res.ok` is false for 3xx and the
  `location` header is ignored), so a redirect cannot be followed. Verified as not-followed, not
  verified as "correctly classified per RFC" — a 3xx is treated as `permanent`, which is a
  conservative choice rather than a derived fact.
- **Real hostile registry** — no agent was registered pointing at an internal address. The SSRF
  guard is proven against injected URLs, not against a live attacker registration (which would
  itself be an on-chain write, forbidden here).
- **Concurrency/timeout interaction under load** — the 10 s card timeout is not stress-tested.
- **Card semantic truthfulness** — nothing here proves an agent is honest, safe, or competent.
  TRUSTED means "the registry's identity claim is internally consistent and the card bytes match
  the on-chain anchor". It is a statement about cryptographic anchoring, not about behaviour.

## BLOCKED

Nothing. All seven defects were fixable within the existing architecture; no redesign was
needed and no module outside card validation had to be touched.

---

## FINAL VERDICT

**TRUST BOUNDARY HARDENED. Seven defects fixed, all reproduced first.**

The headline is D1: the gateway fetched whatever URL the registry handed it, including
`file://`, loopback, private ranges, and `169.254.169.254`. Because registration is permissionless
and costs nothing, that was a usable SSRF primitive against the host running the gateway. It is
now closed by a parsed-URL guard (not a string blacklist), with an operator-only env opt-in for
local development that no MCP client can reach.

D2 and D3 — no size cap, no timeout — turned the same permissionless registration into a
memory-exhaustion and hang primitive. Both bounded now, with the size cap enforced before the
body is buffered.

D4 is the semantic correction with the widest blast radius: an outage used to be reported as
fraud. Classification now separates *permanent* contradictions (404, refused URI, malformed
card) from *transient* unavailability (5xx, 429, DNS, timeout), so a flaky publisher can no longer
cause a REJECTED verdict and an honest agent is not accused because its origin blinked.

D5 and D6 close the paths where a *structurally valid but semantically contradictory* card could
reach TRUSTED: wrong field types passed validation and then fed the identity comparison, and a
card could declare two badge extensions with two different owners and have the verdict decided by
JSON array order.

Nine of the 37 new tests failed on the untouched code and one hung the suite outright — the
measure of what the previous green suite did not cover. 848/848 tests now pass across 21 suites,
the live registry verification is still TRUSTED with the same 2 777-byte card and the same
SHA-256, and the account nonce is still 4 with the balance unchanged at 19 943.619923 CCD.
