# TASK 23 — Trust Verification Semantics

Date: 2026-11-05 · **The verdict no longer accuses an agent of fraud because its endpoint was
unreachable.** `REJECTED` now requires a genuine contradiction of obtained evidence, and the
distinction is machine-readable rather than implied. **960/960 tests pass across 24 suites.**

---

## VERIFIED

### V1 — Complete verdict pipeline audit

Traced end-to-end, not just the status table. Every place a verdict is produced or consumed:

| Stage | File | What it decides |
|---|---|---|
| Registry discovery | `crossAgent.parseDiscoveryResponse` | sets `agent_discovered` (PASS / INCONCLUSIVE) |
| Status read | `crossAgent.verifyAgent` | `status_active` (PASS / FAIL for Revoked / INCONCLUSIVE otherwise) |
| Card retrieval | `crossAgent.fetchCardBytes` → `httpGetPinned` | `card_retrieved` — **was FAIL for permanent failures** ← defect |
| Card validation | `crossAgent.validateCard` | `card_valid` (PASS / FAIL) |
| Hash comparison | `compareHashes` | `hash_matches_on_chain` |
| Identity comparison | `compareCardToRecord` | `owner_matches`, `contract_references_match` |
| Badge (advisory) | `verifyAgent` | `badge_valid` — not a gating check |
| **Verdict** | `decideTrust` | TRUSTED / REJECTED / INCONCLUSIVE |
| Result assembly | `finish` | added `failure_kind` + `failed_requirements` |
| Policy | `trustPolicy.evaluateTrustPolicy` | ALLOWED / TRUST_REJECTED / TRUST_INCONCLUSIVE / … |
| Commerce | `orchestrator.runCommerce` | `granted`, `stage`, audit events |
| MCP | `tools.toolTrustVerify`, `toolTrustPolicy` | `trust.verify` / `trust.policy` |
| CLI | `cli/verify.ts` | exit 0 / 1 / 2 / 3 |
| Demo | `scripts/task08-demo.mjs` | narrative + evidence files |

**The status table was not the only place.** Three distinct defects existed, at three layers:

#### D1 — `card_retrieved` was a check that could `FAIL`

```ts
// before
checks.card_retrieved = fetched.ok && fetched.bytes
  ? 'PASS'
  : fetched.failure === 'transient' ? 'INCONCLUSIVE' : 'FAIL';
```

`permanent` failures — 400/401/403/404/410, 3xx, refused URI, oversize — set `FAIL`, and
`decideTrust` turned any `FAIL` into `REJECTED`. Retrieval status was being used as an identity
check. This is the root cause: fixing the status table alone would have left the door open for any
other `permanent` classification to become an accusation.

#### D2 — `decideTrust` had no invariant tying contradiction to obtained evidence

```ts
// before
if (values.some(v => v === 'FAIL')) return 'REJECTED';
```

Nothing prevented a `FAIL` recorded without a card from producing a rejection — including a
manually constructed check map, or a future bug that set `owner_matches: 'FAIL'` when the card was
never fetched.

#### D3 — The result carried no way to tell *why* a non-TRUSTED verdict happened

`trust_decision` conflated "the agent's claims are contradicted" with "we could not check". A
consumer — the CLI, the MCP client, the demo, the README — had to guess from the check map.

### V2 — Two further semantic inconsistencies found while tracing

- **`registry record has no agent_uri`** set `card_retrieved: 'FAIL'`. A registry record missing its
  pointer is malformed *record* data, but it is still an absence of evidence, not a contradiction.
- **MCP `reasons[]`** listed only `check=FAIL` / `check=INCONCLUSIVE` strings with no statement of
  which situation applied, so an MCP client reading `REJECTED` had nothing telling it whether the
  agent was contradicted or merely unreachable.

---

## DELIVERABLE 2 — Established verdict semantics

### The four vocabularies, kept explicitly separate

| Vocabulary | Values | Answers |
|---|---|---|
| **Trust verdict** (`trust_decision`) | `TRUSTED` / `REJECTED` / `INCONCLUSIVE` | what is concluded about the agent |
| **Retrieval status** (`card_retrieved`) | `PASS` / `INCONCLUSIVE` — **never `FAIL`** | were the card bytes obtained? |
| **Check result** (`checks.*`) | `PASS` / `FAIL` / `INCONCLUSIVE` / `NOT_TESTED` | per-requirement outcome |
| **Failure kind** (`failure_kind`) | `none` / `contradiction` / `unavailable` | was evidence contradicted, or missing? |
| **Policy decision** (`code`) | `ALLOWED` / `TRUST_REJECTED` / `TRUST_INCONCLUSIVE` / `CHECK_NOT_PASS` / `AMOUNT_EXCEEDED` / … | may commerce proceed? |

Test 19 walks all three verdicts and asserts every field uses only its own vocabulary — a check
value can never appear where a verdict belongs, and `PASS` is never returned as a verdict.

### TRUSTED

Produced only when **all seven mandatory checks are `PASS`**: `agent_discovered`,
`card_retrieved`, `card_valid`, `hash_matches_on_chain`, `owner_matches`, `status_active`,
`contract_references_match`. `badge_valid` is advisory and does not gate.

Test 02 exhausts the matrix: substituting `FAIL`, `INCONCLUSIVE` or `NOT_TESTED` into **any**
mandatory check never yields TRUSTED. Partial verification cannot be trusted.

### REJECTED

Requires **obtained evidence that positively contradicts a mandatory requirement**, and always
names which one in `failed_requirements`:

| Contradiction | Check |
|---|---|
| raw-byte hash ≠ on-chain anchor | `hash_matches_on_chain` |
| card's owner claim ≠ registry owner | `owner_matches` |
| card's contract references ≠ expected contracts | `contract_references_match` |
| registration revoked / explicitly inactive | `status_active` |
| fetched document is not a valid card (invalid UTF-8, invalid JSON, not an object, missing mandatory fields, wrong types, duplicate badge extensions, malformed badge metadata) | `card_valid` |
| deterministic test failure | — |
| (advisory only, never gates) | `badge_valid` |

`failure_kind` is `contradiction` whenever any of those checks is `FAIL` on a retrieved card.

### INCONCLUSIVE

Required evidence could not be obtained or established: registry record absent, card unreachable,
transport failure, bad card content that was never served, partial or ambiguous evidence.
`failure_kind` is `unavailable`.

### A defect found during final verification and fixed

The TASK 22 DNS deadline timer used `.unref()`. That was wrong: a resolver promise that never
settles holds **no libuv handle**, so an unref'd timer is the only thing that could have kept the
event loop alive — and `unref()` told Node it could exit instead. Symptom, observed only when the
module was driven directly rather than through the test suite:

```console
Warning: Detected unsettled top-level await
const hung = await httpGetPinned('https://never.example/c.json', {...});
```

Fixed by keeping the timer **ref'd while pending** and clearing it explicitly in a `finally`:

```ts
dnsTimer = setTimeout(() => reject(new Error(`… exceeded ${timeoutMs}ms during DNS resolution`)), remaining());
...
} finally {
  if (dnsTimer) clearTimeout(dnsTimer);
}
```

Verified after the fix: `stuck DNS: ok=false kind=transient elapsed=250ms` — bounded, transient, and
the process no longer exits early. Notably the suite had *not* caught this because the test harness
was itself keeping the loop alive; a standalone probe did.

### The invariant that prevents recurrence

```ts
if (values.some(v => v === 'FAIL')) {
  // No card ⇒ nothing to contradict. Downgrade to INCONCLUSIVE rather than accuse.
  if (checks['card_retrieved'] !== 'PASS') return 'INCONCLUSIVE';
  return 'REJECTED';
}
```

A rejection is now **structurally impossible** without a retrieved card, whatever upstream code
records. Tests 13 and 14 exercise this directly: `decideTrust` returns INCONCLUSIVE for
`{card_retrieved: 'FAIL', owner_matches: 'FAIL'}` — the rogue combination that previously became a
fraud verdict.

---

## DELIVERABLE 3 — HTTP status classification

| Status | Class | `card_retrieved` | Verdict | Rationale |
|---|---|---|---|---|
| 200 + valid card | — | PASS | continue | evidence obtained |
| **400** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | the endpoint refuses the request; says nothing about the owner |
| **401** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | needs auth to serve the card; access ≠ identity |
| **403** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | forbidden to us; access ≠ identity |
| **404** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | not at this path; the record may be stale |
| **408** | transient | INCONCLUSIVE | INCONCLUSIVE | publisher could not answer in time |
| **410** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | gone; retirement is not fraud |
| **429** | transient | INCONCLUSIVE | INCONCLUSIVE | rate limited |
| **5xx** | transient | INCONCLUSIVE | INCONCLUSIVE | publisher/upstream fault |
| **3xx** | permanent | INCONCLUSIVE | **INCONCLUSIVE** | not followed ⇒ no evidence obtained |

**No status code produces REJECTED.** Every one of the eleven is asserted INCONCLUSIVE with
`failure_kind: 'unavailable'` by test 03, and the same through `verifyAgent` in task21's test 18.

### The 3xx decision, restated

Redirects are never followed (an SSRF pivot). Because nothing was served at the claimed location,
the gateway has **no evidence** — not counter-evidence. Classified `permanent` at the transport
level (retrying will not help) and `INCONCLUSIVE` at the verdict level (nothing was contradicted).
The earlier framing of this as "the card positively is not served, therefore REJECTED" was the
defect this task corrects.

### Diagnostics preserved, without leaking internals

`evidence.card` still carries `url`, `http_status`, `byte_length`, `content_type`, `error`,
`failure_class`. `failure_kind` adds the semantic classification. No internal network detail and no
secret is added; the existing `redactJson` path is untouched.

---

## DELIVERABLE 4 — Malformed vs unavailable evidence

This is the distinction the task cares about most, and it is now explicit:

| Situation | Evidence obtained? | `card_retrieved` | `card_valid` | Verdict | `failure_kind` |
|---|---|---|---|---|---|
| Card unreachable (any of the 11 statuses, DNS, TLS, timeout) | **no** | INCONCLUSIVE | NOT_TESTED | **INCONCLUSIVE** | `unavailable` |
| Empty response | no | INCONCLUSIVE | NOT_TESTED | INCONCLUSIVE | `unavailable` |
| Oversized response | no (refused) | INCONCLUSIVE | NOT_TESTED | INCONCLUSIVE | `unavailable` |
| Invalid UTF-8 | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Invalid JSON | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| JSON but not an object | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Missing mandatory fields | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Wrong field types | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Duplicate badge extensions | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Invalid badge claims | **yes** | PASS | FAIL | **REJECTED** | `contradiction` |
| Hash mismatch | **yes** | PASS | PASS | **REJECTED** | `contradiction` |
| Owner mismatch | **yes** | PASS | PASS | **REJECTED** | `contradiction` |
| Contract reference mismatch | **yes** | PASS | PASS | **REJECTED** | `contradiction` |
| Revoked agent | **yes** | PASS | PASS | **REJECTED** | `contradiction` |

The rule in one line: **bytes we received and found wanting are a contradiction; bytes we never
received are not.**

---

## DELIVERABLE 5 — Downstream behavior

Reviewed `trustPolicy` and `orchestrator`; both were already fail-closed and are unchanged:

- `evaluateTrustPolicy` checks `trust_decision === 'REJECTED'` and `=== 'INCONCLUSIVE'` **before**
  consulting per-check results, so neither verdict can be rescued by individual checks.
- Both map to `allowed: false` (`TRUST_REJECTED` / `TRUST_INCONCLUSIVE`).
- A permissive `TrustPolicy` (wider `require`, `allowBadgeNotTested`) can only *remove* checks from
  the requirement set; it cannot flip a REJECTED or INCONCLUSIVE verdict. **Test 15 proves this for
  both `STRICT_POLICY` and `PARANOID_POLICY`.**
- `orchestrator` sets `stage: 'trust_rejected'`, `granted: false` before any payment work, and the
  demo confirms `facilitator calls=0` on the rejection path.
- Amount/network/asset limits still block an otherwise-TRUSTED agent (test 18).

MCP and CLI now expose the same vocabulary:

```jsonc
// trust.verify result (added fields)
{
  "trust_decision": "INCONCLUSIVE",
  "failure_kind": "unavailable",
  "failed_requirements": [],
  "checks": { "card_retrieved": "INCONCLUSIVE", ... },
  "reasons": [
    "evidence_unavailable: the required evidence could not be obtained; this is not a finding against the agent",
    "card_retrieved=INCONCLUSIVE", ...
  ]
}
```

Exit-code contract **preserved and re-verified**: `--token-id 1004` → exit **0** (TRUSTED);
`--token-id 999999` → exit **2** (INCONCLUSIVE); usage errors → 3. No code path changed exit
mapping — an unreachable card already exited 2 via INCONCLUSIVE, and now the verdict agrees with it
instead of contradicting it.

`trust.policy` remains client-supplied-verdict only, cannot upgrade a verdict, and is labelled
`verdict_source: 'client_supplied'` — untouched.

---

## DELIVERABLE 6 — Files changed

| File | Change |
|---|---|
| `src/verify/crossAgent.ts` | `failure_kind` + `failed_requirements` on `TrustResult`; `card_retrieved` never FAIL; `agent_uri`-absent → INCONCLUSIVE; `decideTrust` invariant; `finish` derives kind/requirements |
| `src/mcp/tools.ts` | `trust.verify` exposes `failure_kind`, `failed_requirements`, and an explicit availability-vs-contradiction reason line |
| `test/task23-verdict-semantics.test.mts` | **new**, 21 tests |
| `test/task03-discovery-and-trust.test.mts` | 3 assertions corrected to the new semantics |
| `test/task19-mcp-interop.test.mjs` | test 13 corrected |
| `test/task20-card-boundary.test.mts` | A1/A5/A6/C11 corrected |
| `test/task21-ssrf-transport.test.mts` | test 18 corrected: all 11 statuses INCONCLUSIVE |
| `test/task22-phase-timeout.test.mts` | generates its own TLS cert per run instead of depending on a leftover `/tmp` file |
| `scripts/task23-verify.mjs` | **new**, verification harness proving all eight required claims through the real code paths |
| `docs/MCP-GUIDE.md`, `README.md` | verdict table rewritten with the four vocabularies |
| `docs/archive/TASK23-result.md` | this report |

**Not changed:** `trustPolicy.ts`, `orchestrator.ts`, `lock.ts`, the six MCP tools and schemas,
payment module, hashing, audit format, registry/identity architecture.

---

## DELIVERABLE 7 — Full regression

```console
$ npx tsc --noEmit   →  exit 0
$ npx tsc            →  exit 0
$ npm test           →  all suites passed   (24 suites, 960/960)
```

| Suite | Result |
|---|---|
| **task23-verdict-semantics (new)** | **21/21** |
| task22-phase-timeout | 15/15 |
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
| **Total** | **960/960 across 24 suites** |

Demo unchanged in shape: `trust TRUSTED` · agent 19 `REJECTED` (live third-party, genuinely
contradicted) · `access_granted settled=false (SIMULATED)` · `trust_rejected facilitator calls=0` ·
`audit 3/3` · `AUTHORIZATION_NOT_ACCEPTED` · `exit 0, stderr clean`.

---

## DELIVERABLE 8 — Token 1004

```console
$ npm run verify -- --token-id 1004      → exit 0
agent discovered / card retrieved / card valid / badge valid /
hash on chain / owner / status / contract references   → all PASS
TRUST DECISION             TRUSTED
card         200 · 2777 bytes · https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json
sha256 (local)     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)  3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions       0 (read-only)
```

Exact raw-byte hash unchanged. `--token-id 999999` → exit **2** (INCONCLUSIVE), matching the
documented contract. On-chain: `nonce 4`, `19943619923` microCCD. **Zero transactions, zero signing,
zero settlement.**

---

## DELIVERABLE 9 — Remaining limitations

1. **"Obtained but invalid" is still a judgement call at the boundary.** A server returning an HTML
   error page with status 200 is a contradiction under this model (bytes received, requirement
   violated) — but it is really a server misconfiguration. The verdict is REJECTED with
   `failed_requirements: ['card_valid']`, which names the truth precisely enough for a reader to
   see what happened, but an operator debugging a broken publisher will still see REJECTED. This is
   inherent: the gateway cannot distinguish "you published the wrong document" from "you meant to
   serve a card and served an error page".
2. **No retry or backoff.** A transient failure yields INCONCLUSIVE immediately; a caller must
   re-verify. Adding retries would change latency characteristics and is not in scope.
3. **`failure_kind` is derived, not independently evidenced.** It is computed from which checks
   failed, so a future check added to `CONTRADICTION_CHECKS` without thought could mislabel. The
   list is small and explicit for exactly that reason.
4. **Advisory `badge_valid` can be `FAIL` while the verdict is TRUSTED.** Deliberate — the hosted
   checker is corroboration and every gating check is re-derived locally — but a reader who sees
   `badge_valid: FAIL` beside `TRUSTED` should read §V2 of the MCP guide.
5. **Pre-existing TASK 06 audit-lock flake** remains untouched, as instructed (`lock.ts`
   unmodified, `git diff` empty). All runs in this task passed 24/24.
6. **Never proven: agent honesty.** TRUSTED still means only that the identity claim is internally
   consistent and the card bytes match the on-chain anchor.

## NOT TESTED

- A live publisher returning 200 with non-card content (covered by an injected fixture, not a real
  host).
- Registry behaviour when `agent_uri` points at a host that later starts returning 401 (state
  change mid-life).
- MCP client behaviour when `failure_kind` is absent (older clients) — the field is additive, but
  no old client was run.
- Card semantic truthfulness, as above.

## BLOCKED

Nothing. Both defects were fixable inside the existing type and decision surface; no architecture
change was needed and no module outside verdict semantics was touched.

---

## FINAL VERDICT

**VERDICT SEMANTICS CORRECTED. 960/960 green. Token 1004 still TRUSTED with the same hash.**

The defect was not just the HTTP status table. Retrieval status had been modelled as a check that
could `FAIL`, and `decideTrust` converted any `FAIL` into `REJECTED` — so an unreachable endpoint
became an accusation. Changing only the status table would have left every other `permanent`
classification as a live path back into the same bug.

Three changes close it at three layers:

- `card_retrieved` is retrieval status: `PASS` or `INCONCLUSIVE`, never `FAIL`. All eleven HTTP
  statuses, DNS, TLS, refusal, timeout, redirects and a record with no `agent_uri` now land on
  INCONCLUSIVE.
- `decideTrust` carries an invariant — **no retrieved card means no contradiction is possible** —
  so a rejection cannot be produced without evidence that was actually examined, whatever upstream
  code records.
- `TrustResult` gained `failure_kind` (`none`/`contradiction`/`unavailable`) and
  `failed_requirements`, so "the agent's claims were contradicted" and "we could not check" are
  different facts on the wire rather than the same word.

Contradictions still reject, and now name the requirement: hash mismatch, owner mismatch,
contract-reference mismatch, revocation, and invalid *content* (invalid UTF-8, invalid JSON, wrong
types, missing fields, duplicate badge extensions). The line is explicit — bytes we received and
found wanting are a contradiction; bytes we never received are not.

Policy was already fail-closed and needed no change; tests now prove a permissive policy cannot
rescue a REJECTED or INCONCLUSIVE result. The CLI exit-code contract is preserved and re-verified:
0 for TRUSTED, 2 for INCONCLUSIVE, 3 for usage.

Seven test files were updated because they encoded the superseded semantics — that was the point of
the task, not collateral damage.
