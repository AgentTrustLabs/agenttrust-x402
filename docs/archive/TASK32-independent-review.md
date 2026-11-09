# TASK 32 — Independent Review of TASK31 Changes

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b`

## 1. Executive verdict

**PASS.** Every TASK31 change was inspected against installed SDK source, local historical
evidence, and the running repository. No Critical, High, or Medium finding. One Low finding
(documentation inaccuracy in an SDK doc comment, already worked around). All security
invariants intact. All regression tests pass.

## 2. Actual repository state

```
git status --short (TASK31-relevant):
  ?? docs/archive/TASK31-concordium-testnet-readonly.md
  ?? docs/archive/TASK31-testnet-readonly-verification.md
  ?? scripts/task31-testnet-readonly.mts
  M services/facilitator/src/concordiumEvidence.ts   (untracked dir)
  M services/facilitator/src/config.ts                (untracked dir)
  M services/facilitator/src/server.ts                (untracked dir)
```

`git diff --stat HEAD -- services/facilitator/src/` reports nothing because the entire
`services/facilitator/` directory is untracked (created after `4c8994d`). The three
modified files are confirmed present in the working tree and typecheck cleanly.

`git rev-parse HEAD` = `4c8994db391d77796e06e49c843c42be1eae615b` (unchanged).

## 3. Adapter review

`services/facilitator/src/concordiumEvidence.ts` (192 lines).

| Check | Result |
|---|---|
| `TransactionHash.fromHexString()` used correctly | ✅ — converts the 64-hex string to the SDK type before calling the node; validated against installed source: `TransactionHash.fromHexString` throws on malformed input (verified: bad/non-hex/short all throw). |
| Invalid hash input fails safely | ✅ — `HEX64` regex rejects non-64-char / non-hex before any node call; `verify()` returns `{available:false, observed:'unknown'}`. |
| Hash conversion does not alter a different hash | ✅ — `normalizeHash` (used on the response) lowercases and validates; `fromHexString` is a parse, not a transform. Verified live: three real hashes round-tripped exactly. |
| `getBlockItemStatus()` receives the correct SDK type | ✅ — `TransactionHash.fromHexString(transaction)` (verified by the successful live query). |
| `summary.hash` compared against the exact requested hash | ✅ — `if (summaryHex !== requestedHash)` → inconclusive. |
| Finalized/failed/committed/received/NOT_FOUND/timeout/malformed correct | ✅ — all paths return inconclusive except verified finalized/failed with matching hash. |
| No exception → finalized | ✅ — every `catch` returns `{available:false, observed:'unknown'}`. |
| No regression to TASK30 fail-closed | ✅ — TASK30 suite 22/22. |

## 4. Testnet script review

`scripts/task31-testnet-readonly.mts` (verified by reading).

| Check | Result |
|---|---|
| Only official Testnet endpoint | ✅ — `HOST = 'grpc.testnet.concordium.com'`, `PORT = 20000`, hardcoded. No fallback. |
| No Mainnet | ✅ — no `9dd9ca4d…` anywhere. |
| Read-only methods only | ✅ — `getConsensusStatus()` + `getBlockItemStatus()`. No `sendTransaction`, no `waitForFinalization` against a new tx, no `getAccountInfo` mutation. |
| No signing / key loading / construction / submission / faucet / contract mutation | ✅ — grep clean for `AccountSigner`, `privateKey`, `mnemonic`, `sendTransaction`, `sign(`, `createAccount`, `deploy`. |
| Historical hashes exact and traceable | ✅ — all three from `docs/archive/TASK02-result.md` (lines 25–27). |
| Token ID vs Agent Card hash vs transaction hash not confused | ✅ — the script queries transaction hashes; the card hash (`3f614404…`) is never passed to the node. |
| Network identity validation | ✅ — `getConsensusStatus()` genesis block begins with CAIP-2 chain id `4221332d34e1694168c2a0c0b3fd0f27`. |
| Timeouts / connection failures handled | ✅ — `withTimeout` in adapter; script catches and reports errors. |
| No credential disclosure | ✅ — no env vars read, no token logged. |

## 5. Historical evidence provenance

| Fact | Source |
|---|---|
| 3 transaction hashes | `docs/archive/TASK02-result.md` lines 25–27 (local authoritative record) |
| Operation types (register / setAgentURI ×2) | same |
| Sender `4dWn8miA…Zg4d` | live node response (this task) + `docs/archive/TASK02-result.md` |
| Block hashes | live node response (this task) |
| Token 1004 owner | `docs/archive/TASK02-result.md` line: "owner `4dWn8miA…Zg4d`" |
| Agent Card URI | `docs/archive/TASK02-result.md` line 15 |
| Agent Card hash `3f614404…` | `docs/archive/TASK02-result.md` line 16 + live `verify.ts` (TRUSTED) |
| SDK versions | `node_modules/@concordium/web-sdk/package.json` = 12.0.2 |

All live facts are consistent with local records. No discrepancy found.

## 6. Packaging scanner review

`test/task15-packaging.test.mts` F5.7: a single regex with a negative lookahead
`(?![^\\n]*(?:sha256|hash|transaction|token_address))`. The TASK31 change annotates each
64-hex literal with `// transaction hash N`, putting `transaction` and `hash` on the same
line. This is a **legitimate context clarification**, not a suppression:

- The scanner still rejects any 64-hex on a line lacking those words (verified: test passes
  only with the annotation; removing it fails F5.7).
- PEM private keys and `privateKeyHex` are still detected by separate checks.
- No broad ignore rule was added. No scanner code was changed.

## 7. Security invariant review

| Invariant | TASK31 impact | Code path inspected |
|---|---|---|
| `DENY_ALL_FACILITATOR` | Untouched | `src/payments/x402.ts:411-423` — `verify()` and `settle()` both still `throw` |
| Settlement default-disabled | Untouched | `src/commerce/orchestrator.ts:370` — `settle: true` only inside the explicit simulated-commerce path; the facilitator default remains deny-all |
| Sponsor signer fail-closed | Untouched | `services/facilitator/src/signer.ts:352` — `real mode requires a separately provisioned sponsor signer` still throws |
| Durable settlement state | Untouched | `services/facilitator/src/repository.ts` — no TASK31 edit |
| Replay protection | Untouched | `services/facilitator/src/store.ts::paymentDigest` — excludes `resource.url` and `accepted`; unchanged |
| Pre-broadcast hash persistence | Untouched | `services/facilitator/src/core.ts::settle()` — ordering unchanged |
| Post-submit crash recovery | Untouched | `core.ts` `dieAt === 'after-submit'` path unchanged; TASK29.1 suite 49/49 |
| Evidence hash binding | **Strengthened** | `concordiumEvidence.ts:144` — `summaryHex !== requestedHash` → inconclusive |
| Audit integrity | Untouched | `git diff --stat HEAD -- src/audit/lock.ts` empty |

## 8. Regression results

| Suite | Result |
|---|---|
| task25-facilitator | 36/36 |
| task26-settlement-durability | 32/32 |
| task27-multiprocess-settlement | 16/16 |
| task29-prebroadcast | 65/65 |
| task29-crashboundaries | 21/21 |
| task29.1-postsubmit-crash | 49/49 |
| task30-concordium-evidence | 22/22 |
| task15-packaging (F5.7) | 13/13 |
| **full suite** | **1442/1442, 31 suites** |
| typecheck (gateway + facilitator) | OK |

Exact commands:
```
$ npx tsx test/task25-facilitator.test.mts            → 36/36
$ npx tsx test/task26-settlement-durability.test.mts  → 32/32
$ npx tsx test/task27-multiprocess-settlement.test.mts → 16/16
$ npx tsx test/task29-prebroadcast.test.mts           → 65/65
$ npx tsx test/task29-crashboundaries.test.mts        → 21/21
$ npx tsx test/task29.1-postsubmit-crash.test.mts     → 49/49
$ npx tsx test/task30-concordium-evidence.test.mts    → 22/22
$ npx tsx test/task15-packaging.test.mts              → 13/13
$ npm test                                            → all suites passed (1442/1442)
$ npx tsc --noEmit                                    → OK
$ (cd services/facilitator && npx tsc -p tsconfig.json --noEmit) → OK
```

## 9. Findings by severity

### Critical: none

### High: none

### Medium: none

### Low (1)

**L1 — SDK documentation inaccuracy (not an AgentTrust defect).**

- File: `node_modules/@concordium/web-sdk/lib/esm/grpc/GRPCClient.js:112-119`
- Doc comment: `@returns the status … or undefined if it does not exist`
- Actual code: throws for an undefined status (`translation.js:2041`) and returns a gRPC
  `NOT_FOUND` error for a missing transaction (`GRPCClient.js:1180`).
- Impact: an implementation relying on the doc comment would mis-handle missing transactions.
- Status: **worked around** in TASK31's adapter (treats `NOT_FOUND` as inconclusive, never
  success). No code change needed beyond what is already in place. No remediation required.

## 10. Recommended remediation

None. The one Low finding is an upstream documentation issue, not an AgentTrust defect.
No code changes are recommended.

## VERIFIED

- SDK adapter correctness (source-inspected, not doc-relied).
- Testnet connectivity (8/8 checks, real node).
- Network identity (genesis block = CAIP-2 chain id).
- Historical transaction hashes (3/3 finalized, hash-bound, sender = owner).
- Token 1004 consistency (TRUSTED, hash match).
- Packaging scanner (F5.7, 13/13).
- All security invariants (inspected code paths, not just test counts).
- Regression (1442/1442).

## NOT TESTED

- Failed transaction status (no historical failed tx; offline fixture covers it).
- `NOT_FOUND` / timeout against a real node (would need a synthetic hash — prohibited).
- Sponsor signing, real settlement.

## BLOCKED

- None.

## Stop condition

TASK 32 complete. No defects found. Awaiting maintainer approval before any remediation or
TASK 33. No commit, push, publish, or issue created. HEAD remains `4c8994d`.
