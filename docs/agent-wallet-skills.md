# AgentTrust Agent Wallet Skills

## VERDICT: PASS WITH CONDITIONS

The Agent Wallet Skills layer is implemented, discoverable, versioned, and fully
exercised: 24/24 tests, all routed through the real permission gate and the
real `authorizePayment` pipeline. Five skills are exposed with schemas and an
authorization requirement. Every invocation is bound to the authenticated agent and
its assigned wallet; a caller cannot select a wallet, owner, agent, or network.

Conditions (documented, not faked):
1. An unfunded / locally-provisioned wallet cannot pay — `wallet_not_funded` is
   returned and no facilitator is called. This is the agentic-wallet on-chain-activation gap,
   not a skills defect.
2. The skills layer is reachable via HTTP (`/api/skills`, `/api/skills/invoke`) and
   as a library (`WalletSkills`). It is **not** registered as an MCP tool on the
   existing stdio server: that server's tool surface is fixed by its MCP contract and its
   tests assert exactly six tools. Adding a seventh would break that contract, so the
   skills are exposed through the pairing server instead. Evidence at
   `/api/skills` (manifest) and `/api/skills/invoke`.
3. Payment execution uses the shared mock facilitator in the wiring layer; no real
   facilitator or settlement is enabled.

## Available skills and schemas

Manifest name `agenttrust.wallet`, version `1.0.0`.

| Skill | Input schema | Requires |
|---|---|---|
| `wallet_get_status` | `{}` (no properties, `additionalProperties: false`) | `paired_agent_wallet` |
| `wallet_get_permissions` | `{}` | `paired_agent_wallet` |
| `wallet_request_payment` | `{ recipient: string(1..64), amountMicroCcd: string(^\d+$, ≤16), context?: string(≤128), approvalToken?: string(≤128) }`, required `recipient`,`amountMicroCcd` | `paired_agent_wallet` |
| `wallet_request_approval` | `{ recipient, amountMicroCcd, context? }`, required `recipient`,`amountMicroCcd` | `paired_agent_wallet` |
| `wallet_get_activity` | `{ limit?: integer 1..100 }` | `paired_agent_wallet` |

Every schema is `additionalProperties: false`, and the dispatcher additionally
rejects any argument named `walletId`, `ownerWalletAddress`, `agentId`, or `network`
with `invalid_arguments` — identity is never an argument.

## Agent authentication and wallet resolution

The trusted context is `SkillContext = { agentId, ownerWalletAddress, network }`:

- In the library, the caller supplies it programmatically.
- Over HTTP, `/api/skills/invoke` resolves it **server-side**: it checks the active
  pairing store for an active `paired` record matching `(agentId, ownerWalletAddress,
  network)` and rejects `403 agent_not_paired` otherwise. The client cannot assert a
  pairing it does not have.
- The wallet is resolved by `listByOwner(owner)` filtered to
  `agentId === ctx.agentId && network === ctx.network`. There is no lookup by
  wallet id anywhere in the skills layer.

Requesting another agent's wallet is structurally impossible: the lookup key is the
context, and a context for an agent with no wallet yields `no_wallet`.

## Authorization boundaries

Per invocation:

| Check | Failure code |
|---|---|
| context well-formed | `invalid_context` |
| identity arguments absent | `invalid_arguments` |
| assigned wallet exists for (owner, agent, network) | `no_wallet` |
| wallet not `revoked` | `wallet_revoked` |
| wallet not `paused` | `wallet_paused` |
| wallet not `recovery_required` | `wallet_recovery_required` |
| on-chain address present (payments only) | `wallet_not_funded` |
| funding status `funded` (payments only) | `wallet_not_funded` |
| permission service present | `service_unavailable` |
| payment service present (payments only) | `service_unavailable` |
| the permission gate passes | that reason (`no_permission`, `permission_disabled`, `permission_paused`, `permission_revoked`, `recipient_not_allowed`, `per_tx_limit_exceeded`, `daily_limit_exceeded`, `period_limit_exceeded`, `approval_required`, `approval_param_mismatch`, …) |
| skill name known | `unknown_skill` |

No skill signs, exports a key, or reaches a signer. `wallet_get_status` and
`wallet_get_activity` expose only public metadata.

## Payment and approval lifecycle

```
agent → wallet_request_payment
          ├─ resolve wallet (context only)
          ├─ lifecycle gate  (paused / revoked / recovery_required → denied)
          ├─ funding gate    (no accountAddress or not funded → wallet_not_funded)
          ├─ createPaymentGate(owner, agent, network, recipient, amount, approvalToken, context)
          │     └─ bind: recipient / amount / network must equal the gate's terms
          ├─ buildPaymentRequirements (shared x402 builder)
          ├─ createPaymentPayload   (injected)
          └─ authorizePayment { permissionCheck, onSettleSuccess/Fail/Ambiguous }
                 permissionCheck → isPaymentAllowed → checkAndReserve (synchronous)
    result: executed | approval_required | denied(code) | wallet_not_funded
```

Manual approval:

```
agent → wallet_request_approval → { approvalId, status: pending, expiresAt }
owner → signs a challenge → API approve → { token }     (owner-only)
agent → wallet_request_payment { approvalToken: token }        (exact params only)
```

An approval request is **not** authorization: test 13 asserts that after creating an
approval the payment still returns `approval_required` and the approval remains
`pending`. Test 14 asserts a tampered amount returns `approval_param_mismatch` and a
replay of the consumed token is rejected.

Reservation semantics are unchanged: success → finalized spending,
definite failure → released, ambiguous settlement → retained.

## Error codes and expected responses

Success: `{ ok: true, skill, data }`; failure: `{ ok: false, skill, error, code }`.
HTTP: `200` on success, `422` on a skill-level failure, `403 agent_not_paired` when
the pairing check fails, `400` on malformed request body, `503 skills_unavailable`
when the layer is not wired.

`wallet_get_status` data:

```json
{ "walletId": "w_…", "agentId": "agent-1", "ownerWalletAddress": "4dWn…",
  "network": "ccd:4221…", "genesisHash": "4221332d…f796",
  "accountAddress": null, "lifecycle": "awaiting_funding",
  "fundingStatus": "unknown", "balanceMicroCcd": null,
  "onChainAccount": false, "locallyProvisionedOnly": true,
  "createdAt": 1000000000, "updatedAt": 1000000000 }
```

`wallet_get_permissions` data (no grant):

```json
{ "agentId": "agent-1", "network": "ccd:4221…", "granted": false, "enabled": false,
  "paused": false, "revoked": false, "policy": null, "limits": null,
  "recipientAllowlist": null,
  "note": "payment permission is disabled until the owner explicitly grants it" }
```

With a grant it adds `policy`, `limits{perTxMicroCcd,dailyMicroCcd,periodMicroCcd,periodSeconds}`,
`recipientAllowlist`, `spentTodayMicroCcd`, `dailyRemainingMicroCcd`.

`wallet_request_payment` success data: `{ "state": "executed", "receipt": {…} }`.
`wallet_request_approval` data: `{ "approvalId": "…", "status": "pending", "expiresAt": 1000000300 }`.
`wallet_get_activity` data: `{ "walletId": "w_…", "events": [{ at, walletId, agentId, network, event, detail }] }`.

## Example skill calls

```bash
curl -s localhost:4522/api/skills | jq .manifest.version        # → "1.0.0"

curl -s -X POST localhost:4522/api/skills/invoke \
  -H 'content-type: application/json' \
  -d '{"agentId":"1004","ownerWalletAddress":"4dWn…","network":"ccd:4221…",
       "skill":"wallet_get_status","args":{}}'
# → {"ok":true,"result":{"ok":true,"skill":"wallet_get_status","data":{…}}}

curl -s -X POST localhost:4522/api/skills/invoke \
  -H 'content-type: application/json' \
  -d '{"agentId":"1004","ownerWalletAddress":"4dWn…","network":"ccd:4221…",
       "skill":"wallet_request_payment",
       "args":{"recipient":"3whd…","amountMicroCcd":"500"}}'
# → {"ok":false,"result":{"ok":false,"skill":"wallet_request_payment",
#      "error":"wallet_not_funded","code":"wallet_not_funded"}}   (unfunded wallet)
```

## Tests and results

`test/task74-agent-wallet-skills.test.mts` — **24/24 passed**, offline.

| # | Case | Result |
|---|---|---|
| 01 | manifest discoverable, versioned, 5 skills, schemas valid | pass |
| 02 | unknown skill rejected | pass |
| 03 | walletId / owner / agent / network arguments rejected | pass |
| 04 | status for the authenticated agent; local vs on-chain distinguished | pass |
| 05 | agent isolation across two wallets | pass |
| 06 | unpaired agent → `no_wallet` | pass |
| 07 | wrong owner → `no_wallet` | pass |
| 08 | wrong network → `no_wallet` | pass |
| 09 | paused / revoked rejection (and resume restores) | pass |
| 10 | permissions disabled by default | pass |
| 11 | limits, policy, remaining allowance reported | pass |
| 12 | another agent's permission never exposed | pass |
| 13 | manual policy → `approval_required`; approval request is not authorization | pass |
| 14 | owner approval required; tampering rejected; replay rejected; exact params execute | pass |
| 15 | bounded_auto payment executes through the pipeline (verify+settle) | pass |
| 16 | per-tx limit enforced, zero facilitator calls | pass |
| 17 | recipient allowlist enforced, zero facilitator calls on rejection | pass |
| 18 | daily limit blocks the second payment, zero calls on the blocked one | pass |
| 19 | permission denial never reaches the facilitator | pass |
| 20 | unfunded / locally-provisioned wallet → `wallet_not_funded`, zero calls | pass |
| 21 | activity isolated to the assigned wallet and redacted | pass |
| 22 | activity pagination bounded and clamped | pass |
| 23 | permission/skills service unavailable fails closed | pass |
| 24 | no private key or signing material in any skill result | pass |

Regression (all green after the change): task71 30/30, task72 22/22, task73 19/19,
task15 packaging 13/13, task12 hygiene 11/11. Previously verified in this session and
unaffected: task04 44/44, task05 36/36, task25 36/36, task26 32/32, task37 15/15,
task08 39/39, task70 21/21.

Typecheck `tsc --noEmit`: 0 errors. Build `tsc`: 0 errors.

**Pre-existing flaky suites** (unchanged, not caused by this task): task06 test 11 and
task14 test 15 (concurrent writers under load — both pass standalone); task3413
requires uid 1001 + group 1002 and self-skips otherwise.

## Live smoke test

`npx tsx scripts/pairing-server.mts` on `127.0.0.1:4522`:

- `GET /api/skills` → `{"ok":true,"manifest":{"name":"agenttrust.wallet","version":"1.0.0",…}}`
- `POST /api/skills/invoke` for `wallet_get_status` without an active pairing →
  `403 {"ok":false,"error":"agent_not_paired"}` — the context is genuinely resolved
  server-side and refuses an unpaired caller.

No transaction was attempted; no wallet was funded; no account created.

## Integration evidence with the wallet stack

- **Connect Wallet / pairing**: `/api/skills/invoke` requires an active pairing from `PairingStore`;
  `403 agent_not_paired` otherwise (live-verified). The skills layer never re-verifies
  ownership itself — it relies on the pairing that the Connect Wallet flow established.
- **the permission layer**: `wallet_request_payment` goes through `createPaymentGate` →
  `isPaymentAllowed` → `checkAndReserve`; limits, allowlist, network binding, manual
  approval, and reservation semantics are the existing implementations, not copies.
  `wallet_request_approval` calls `PermissionManager.requestApproval`.
- **the agentic wallet manager**: the wallet is resolved from `AgenticWalletManager.listByOwner`; status
  and activity come from the durable SQLite store; lifecycle gates mirror the manager's.
- The payment path is the existing `authorizePayment` in `src/payments/x402.ts` —
  no second settlement path was created.

## Implemented files

- `src/pairing/walletSkills.ts` — `WalletSkills`, `WALLET_SKILLS_MANIFEST`, serialisers, redaction.
- `src/pairing/walletPaymentPipeline.ts` — `createWalletPaymentExecutor`: the seam into
  `createPaymentGate` + `buildPaymentRequirements` + `authorizePayment`.
- `src/pairing/server.ts` — `GET /api/skills`, `POST /api/skills/invoke`, optional `skills` dep.
- `scripts/pairing-server.mts` — wires `WalletSkills` with the shared mock facilitator.
- `test/task74-agent-wallet-skills.test.mts` — 24 cases.
- `docs/agent-wallet-skills.md` — this document.

## Current limitations

1. **MCP registration deferred.** The six-tool MCP surface from is asserted by
   its own suite; adding wallet skills there is a contract change that belongs to a
   dedicated task. The skills are exposed over the pairing server's HTTP API instead.
2. **No on-chain account activation.** Wallets provisioned by the agentic wallet manager have
   `accountAddress = null` until the owner records a deployed address and funding.
   Payment skills return `wallet_not_funded` for those wallets — no fake success.
3. **Payment execution uses the mock facilitator** in the wiring layer. Enabling a
   real facilitator is out of scope and remains disabled.
4. **No MCP-side authentication channel.** Over HTTP the pairing store is the
   authority; there is no bearer-token layer. The server binds to `127.0.0.1` and must
   not be exposed publicly.
5. **Approval discovery is owner-side only.** An agent can create an approval and
   poll its status by id, but `/api/approvals` is owner-scoped; there is no
   agent-push notification.
6. **No per-skill rate limiting.** Bounded inputs exist (amount length, activity
   limit, context length) but no request-rate control.

## Non-negotiables — confirmation

- CIS-8004 token 1004 and its Agent Card: untouched, unmodified.
- wallet, permission, and signing boundaries: preserved; their suites pass unchanged.
- No private key, recovery phrase, wallet export, or signing material is exposed by
  any skill (test 24 asserts this across all skill results).
- No Testnet account created or funded; no transaction constructed, signed, or
  broadcast; no CCD spent; no faucet call.
- Settlement remains restricted (mock only); no unrestricted facilitator enabled.
- No automatic permission grant — `wallet_get_permissions` reports `granted: false`
  by default and payments are denied with `no_permission`.
- No new signer; the existing pipeline is reused.
- No commits, no pushes.
