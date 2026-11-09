# AgentTrust Agent Wallet x402 Integration

## VERDICT: PASS WITH CONDITIONS

The Agent Wallet Skills now consume real HTTP x402 requirements. The provider
(the HTTP x402 provider) is reused unchanged — its 402 challenge, local preflight, facilitator
verify/settle, **independent on-chain verification**, and atomic replay store are
all intact. The agent wallet client (the agent-wallet x402 client) resolves the assigned wallet from the
trusted context, enforces permissions, binds the payment to the provider's
exact requirement, and only then asks the provider to verify.

Conditions (documented, not faked):
1. Settlement is **mock-only**. The provider's chain verifier in the wiring layer
   returns `unavailable` (this process performs no real chain read), so the live
   server never releases the protected resource. The full 402 → wallet →
   approval/authorization → payment → verification → 200 flow is proven with a
   fake `ChainVerifier` that returns a finalized transfer.
2. Wallets provisioned by the agentic wallet manager are locally provisioned only (`accountAddress =
   null`), so the live client returns `wallet_not_funded`. No fake success.
3. No MCP tool surface change (six-tool MCP contract is asserted by its suite).

## Full flow

```
agent ──HTTP GET protected resource──► HTTP x402 provider
provider ──402 PaymentRequired──► agent
  body: { x402Version, resource: { url }, accepts: [requirements] }

agent client.requestAccess(provider, ctx)
  1. provider.challenge() → parse accepts[0] + resource.url
  2. WalletSkills.wallet_get_status(ctx)          ← trusted context, no wallet arg
  3. lifecycle gate: active? onChainAccount? not locallyProvisionedOnly?
  4. createProviderPaymentExecutor(owner, agent, network, requirement.payTo,
                                    requirement.amount, resourceUrl)
  5. build X-PAYMENT: { x402Version, accepted: requirement, payload: <signed tx>,
                       resource: { url }, requestId }
  6. authorizePayment { permissionCheck: createPaymentGate(...).permissionCheck,
                        onSettleSuccess/Fail/Ambiguous }
  7. provider.handlePayment(JSON.stringify(payload))
       → local preflight (scheme/network/asset/amount/payTo/expiry)
       → request binding (payload.resource.url === config.resourceUrl)
       → facilitator verify
       → facilitator settle
       → INDEPENDENT on-chain read: finalized + sender/sponsor/recipient/amount/network
       → atomic ReplayStore.claim(requestId, txHash)
  8. 200 { resource, payment: { transaction, ... } }
```

The agent cannot alter amount, recipient, network, or resource after approval:
those values are taken from the provider's `accepts[0]` and the challenge's
`resource.url`, never from the agent. The `requestId` is generated per request and
bound into the payload.

## Request and transaction binding

| Bound value | Source |
|---|---|
| `accepted` (scheme/network/asset/amount/payTo) | provider `accepts[0]` |
| `resource.url` | provider challenge `resource.url` |
| `requestId` | generated per request (16-byte hex) |
| `txHash` | facilitator settle output; independently verified on chain |
| agent / owner / wallet / network | trusted `SkillContext` (server-resolved pairing) |

`ReplayStore.claim(requestId, txHash)` is atomic and synchronous: two concurrent
redemptions of the same proof cannot both succeed (test 16: exactly one 200, one
409). A transaction hash already consumed cannot unlock a different request
(test 15), and a request id cannot be reused with a different hash (test 14).

## Wallet and permission boundaries

- The client resolves the wallet by `(owner, agent, network)` from the context; a
  caller cannot supply a `walletId`.
- `wallet_get_status` must report `lifecycle: active`, `onChainAccount: true`, and
  `locallyProvisionedOnly: false` before any payment is attempted.
- `createProviderPaymentExecutor` builds the gate with the **provider's** payTo,
  amount, and network; a gate mismatch (`recipient_mismatch` / `amount_mismatch` /
  `wrong_network`) refuses the call.
- `createPaymentGate` → `isPaymentAllowed` (the permission layer) → `checkAndReserve` runs before
  `authorizePayment`, so no facilitator call happens on an authorization failure
  (tests 11–13 assert `calls.length` unchanged).
- Reservations, manual approval, limits, allowlist, and network restrictions are
  the existing implementations, not copies. Ambiguous settlement is retained
  (`onAmbiguous`), never released on a timeout.
- No signing happens in the skills layer; `createProviderPaymentExecutor` reuses the
  existing `authorizePayment` path.

## Error states and retry behavior

| State | HTTP | Meaning | Retry |
|---|---|---|---|
| `unpaid` | 402 | no valid payment / authorization failed | yes, fresh request |
| `approval_required` | 402 | manual policy, no valid approval token | owner approves, retry with token |
| `wallet_not_funded` | 402 | locally provisioned only, no on-chain account | no (owner must fund/deploy) |
| `wallet_revoked` / `wallet_paused` / `wallet_recovery_required` | 402 | lifecycle gate | no (owner action) |
| `no_permission` / `permission_revoked` / `permission_paused` | 402 | permission gate | owner re-grants |
| `per_tx_limit_exceeded` / `daily_limit_exceeded` / `period_limit_exceeded` | 402 | limit | smaller amount / later period |
| `recipient_not_allowed` | 402 | allowlist | use an allowed recipient |
| `replay` | 409 | hash or request id already consumed | no (new request) |
| `not_finalized` | 402 | chain reports pending | poll/retry |
| `chain_mismatch` | 402 | recipient/amount/network/sender/sponsor mismatch or failed tx | no |
| `verification_unavailable` | 503 | facilitator or chain unavailable | retry later |
| `malformed` / `binding` | 400 | bad header or resource mismatch | fix the client |

On any non-200 outcome the provider body contains **no** `resource` field
(tests 17, 18, 20, 21, 22). Ambiguous settlement (`settle-nohash`) is treated as
not-released and returns `402 settle` (test 21).

## Mock versus real settlement

| Component | Mock | Real |
|---|---|---|
| facilitator verify/settle | `mockFacilitator('ok')` (offline) | not wired |
| chain read | fake `ChainVerifier` returning a finalized summary for the simulated hash | not wired; the wiring layer returns `unavailable` |
| protected content release | test-only | never released in the live server |
| wallet on-chain account | none (local wallet provisioning) | requires credential deployment (out of scope) |

The mock's simulated transaction hash is deterministic
(`simulated:${payTo}:${amount}:${asset}`), so the test's chain verifier can map it
to a finalized transfer. This is explicitly **not** a chain hash and is never
submitted.

## Tests and results

`test/task75-agent-wallet-x402.test.mts` — **23/23 passed**, offline.

| # | Case | Result |
|---|---|---|
| 01 | challenge parses into requirement + resource binding | pass |
| 02 | malformed challenge rejected | pass |
| 03 | provider returns HTTP 402 with a valid requirement | pass |
| 04 | valid bounded-auto flow returns the protected resource | pass |
| 05 | manual approval-required flow | pass |
| 06 | owner approval then payment + provider verification | pass |
| 07 | approval parameter tampering rejected | pass |
| 08 | wrong recipient / amount / resource binding rejected | pass |
| 09 | wrong wallet / agent / owner / network rejected | pass |
| 10 | unfunded (locally provisioned only) rejected | pass |
| 11 | disabled permissions reject, no facilitator call | pass |
| 12 | revoked permission rejects, no facilitator call | pass |
| 13 | spending-limit rejection, no facilitator call | pass |
| 14 | replay against the same request refused (409) | pass |
| 15 | replay of same tx against a different request refused | pass |
| 16 | concurrent duplicates: exactly one 200, one 409 | pass |
| 17 | finalized-but-failed transaction rejected, no release | pass |
| 18 | unfinalized transaction rejected (`not_finalized`) | pass |
| 19 | on-chain amount / recipient mismatch rejected | pass |
| 20 | chain unavailable → 503, no release | pass |
| 21 | ambiguous settlement (`settle-nohash`) → 402, no release | pass |
| 22 | protected resource never present on a non-200 outcome | pass |
| 23 | no private key or signing material in outcomes/skills | pass |

Regression (all green): task70 21/21, task71 30/30, task72 22/22, task73 19/19,
task74 24/24, task04 44/44, task05 36/36, task25 36/36, task26 32/32, task37 15/15,
task08 39/39, task15 13/13, task12 11/11. Typecheck 0, build 0.

**Pre-existing flaky suites** (unchanged): task06 test 11 and task14 test 15
(concurrent writers; pass standalone); task3413 requires uid 1001 + group 1002.

## Live smoke test

`npx tsx scripts/pairing-server.mts` on `127.0.0.1:4523`:

- `GET /api/x402/requirement` → **HTTP 402** with a parseable
  `{ x402Version, resource: { url }, accepts: [{ scheme, network, asset, amount, payTo }] }`.
- `POST /api/x402/access` without a agent pairing → `403 agent_not_paired` — the
  context is resolved server-side.

Because the wiring-layer chain verifier returns `unavailable`, the live provider
never releases content; the full 200 path is proven only in the offline suite.

## Remaining limitations

1. **No real on-chain verification or settlement.** The live provider's chain
   verifier is a fail-closed `unavailable` stub; a production deployment needs a
   real `ChainVerifier` backed by the configured node and a real facilitator.
2. **No on-chain wallet account.** agent wallets are locally provisioned; the
   client returns `wallet_not_funded` until the owner records a deployed address
   and funding. No fake success.
3. **MCP registration deferred** (six-tool MCP contract).
4. **In-memory replay store.** `ReplayStore` is per-process; a multi-instance
   deployment needs a durable replay store. Documented, not built.
5. **No request signing by the agent.** The client binds the request id and sends
   the provider's requirement; it does not produce a signed HTTP request. The
   provider trusts the pairing-checked context.
6. **Approval is owner-side.** `wallet_request_approval` creates a request; only
   the owner's signed approval produces a token.

## Non-negotiables — confirmation

- CIS-8004 token 1004 and its Agent Card: untouched, unmodified.
- HTTP x402 provider security and replay protections: unchanged (21/21).
- identity, permission, wallet, and signing boundaries: preserved.
- No Testnet account created or funded; no transaction constructed, signed, or
  broadcast; no CCD spent; no faucet call.
- No real settlement or unrestricted facilitator mode.
- No automatic permission grant.
- No private-key, recovery-phrase, or wallet-export access through the skills.
- No commits, no pushes.
