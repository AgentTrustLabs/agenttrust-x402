# Agent Wallet Permissions & Spending Controls

## VERDICT: PASS WITH CONDITIONS

Permission management is implemented and **enforced server-side in the real payment
authorization path** (`authorizePayment`), not merely as configuration or UI state.
Twelve of the twenty-two regression cases drive the gate through
`authorizePayment` with a fake facilitator that counts calls, proving that a
rejected permission produces **zero** `verify` and **zero** `settle` calls.

Conditions:
1. Permission storage is in-memory (`PermissionManager`), not SQLite. The interface
   is narrow so a durable adapter drops in without changing callers, but a process
   restart loses permissions and spending history.
2. The UI drives the real backend, but the interactive browser path (extension
   popup signing) has not been exercised with a real wallet extension from this
   host — the same limitation documented in the Connect Wallet report.
3. Live end-to-end permission grant is blocked by the same environmental fact as
   the Connect Wallet pairing step: pairing token 1004 requires the CIS-8004 verifier to reach the Agent Card,
   and that host returns HTTP 502. The server refuses with `agent_not_paired`
   (verified live, see Evidence).

## Permission schema

`AgentPermission` (in `src/pairing/permissions.ts`), keyed by `wallet|agent|network`:

| Field | Meaning |
|---|---|
| `pairingId` | agent pairing this permission descends from |
| `agentId` | CIS-8004 token id (string) |
| `walletAddress` | Base58Check Concordium account that owns the permission |
| `network` | CAIP-2 the permission is bound to |
| `enabled` | **false until explicitly granted** |
| `paused` / `revoked` | emergency controls |
| `limits.perTxMicroCcd` | max microCCD per transaction (`null` = no cap) |
| `limits.dailyMicroCcd` | max microCCD per UTC day (`null` = no cap) |
| `limits.periodMicroCcd` / `limits.periodSeconds` | max microCCD per rolling-aligned period |
| `recipientAllowlist` | `null` = any recipient; otherwise exact Base58Check matches only |
| `policy` | `manual` or `bounded_auto` |
| `dailySpent: Map<UTC day, bigint>` | recorded spending per day |
| `periodStart` / `periodSpent` | period accounting |
| `reservations: Map<id, {amount, createdAt, status}>` | in-flight capacity |
| `approvals: Map<id, PaymentApproval>` | manual approvals |

**Money is `bigint` microCCD everywhere.** No floats, no `Number` arithmetic on
monetary values. The wire format is a decimal string; parsing rejects anything not
matching `/^\d+$/`.

## Owner authorization mechanism

Every permission mutation requires a **fresh, short-lived, single-use signed challenge**:

- `createPermissionChallenge({walletAddress, agentId, network, action})` builds
  `AgentTrust permission\nwallet=…\nagent=…\nnetwork=…\naction=…\nnonce=…\nexpires=…`
  with a 16-byte nonce and 300 s TTL. The id is a SHA-256 over all bound fields.
- The signature is verified with the official SDK `verifyMessageSignature` against
  on-chain account keys fetched from the node — never against client-supplied data.
- The challenge is consumed **only after** ownership verification succeeds, so a
  failed signature does not burn the challenge (a legitimate retry still works) but a
  successful one can never be replayed.
- Bindings: the challenge id embeds wallet + agent + network + action, so a challenge
  issued for one agent cannot authorize another.

A connected wallet session alone is **not** accepted as proof of ownership: the
session state is separate from `PermissionManager`, and `grantPermission` /
`approveApproval` / `/api/permission/control` all require a verified signature.

No private key, recovery phrase, export, or signature is stored. Signatures are used
transiently inside `verifyOwnership` and discarded. The activity log records public
identifiers and amounts only.

## Spending-limit semantics

- **Per transaction**: `amount > perTxMicroCcd` → `per_tx_limit_exceeded`.
- **Daily**: calendar day in **UTC** (`YYYY-MM-DD` from `Date.getUTC*`), no DST, no
  local timezone. `dailySpent[utcDay] + inFlightReservedForThatDay + amount >
  dailyMicroCcd` → `daily_limit_exceeded`. Spending is recorded on the
  **finalization** day, so a reservation created late in one UTC day and finalized
  the next consumes the next day's budget.
- **Period**: boundaries are **UTC-aligned fixed windows**:
  `periodStart = floor(now / periodSeconds) * periodSeconds`. This is deliberately
  not a sliding window — a fixed boundary makes the cap auditable and reproducible.
  `periodSeconds` must be an integer in `[60, 366*86400]`; the period cap is
  meaningless without it and the grant is rejected otherwise.
- Additionally: `amount <= 0` → `invalid_amount`.

## Reservation and reconciliation behavior

The enforcement contract is:

| Outcome | Reservation | Reason |
|---|---|---|
| Permission denied | none created | gate runs before any facilitator call |
| Preflight / verify rejected | **released** | capacity restored |
| `settle` throws | **retained** | a throw may have submitted; never release on ambiguity |
| `settle` reports `timeout`/`ambiguous`/`unknown` | **retained** | explicit ambiguity signal |
| `settle` reports success with no hash | **retained** | unauditable success is not a success |
| `settle` success with hash | **finalized** | capacity becomes recorded spending |
| `settle:false` (verify-only) | **released** | nothing spent |

Concurrency: `permissionCheck` is a **synchronous** callback executed inside
`authorizePayment` before any `await`. Two concurrent calls therefore cannot
interleave between the limit check and the reservation — the second observes the
first's pending reservation and is rejected. Proven by test 16: two
`Promise.all` `authorizePayment` calls at 600 microCCD against a 1000 daily cap yield
**exactly one** grant.

Client-supplied totals are never trusted: the gate takes only
`{recipient, amount, network}` from the caller and reads limits, spending, and
allowlist from the server-side store.

## Approval lifecycle

```
requestApproval(...)        → status pending, paramHash = sha256(wallet|agent|network|recipient|amount|context), 300 s TTL
approveApproval(...)        → owner signs a fresh challenge → status approved, single-use token issued
rejectApproval(...)         → owner signs → status rejected
consumeApproval(token, p)   → token + exact params must match → status consumed
expiry                      → status expired; token unusable
revoke / unlink             → all pending+approved approvals become expired
```

`paramHash` is recomputed on every consume from the **attempted** payment parameters
and compared to the stored one, so changing amount, recipient, network, or context
invalidates the approval. The token is kept after consumption so a replay returns
`approval_not_approved` rather than an indistinguishable "unknown token".

No approval → no payment, under `manual` policy. `manual` is never silently
converted to automatic execution: the check is
`if (policy === 'manual') { require token }` and there is no fallback branch.

## Payment enforcement integration

Three integration points, all minimal:

1. **`authorizePayment` (src/payments/x402.ts)** — new optional
   `permissionCheck` callback plus `onSettleSuccess` / `onSettleFail` / `onAmbiguous`
   hooks. The permission gate runs **first**, before `preflightPaymentPayload` and
   before `facilitator.verify`. Verified by call counters (test 21: rejected
   permission ⇒ `verify=0, settle=0`).
2. **`runCommerce` (src/commerce/orchestrator.ts)** — the same hooks are forwarded
   from `OrchestratorDeps`, so the existing commerce pipeline gains enforcement
   without a new code path.
3. **`createPaymentGate` (src/pairing/paymentGate.ts)** — binds a
   `PermissionManager` to one `(wallet, agent)` attempt, refuses a call whose
   recipient/amount/network differs from the one the gate was built for
   (`recipient_mismatch` / `amount_mismatch` / `wrong_network`), and maps the three
   settlement outcomes onto finalize/release/retain.

Fail-closed: `PermissionManager.setAvailable(false)` makes `isPaymentAllowed`,
`checkAndReserve`, and `createPaymentGate` all refuse with
`permission_store_unavailable`. A missing permission is `no_permission`, never an
implicit allow.

## UI behavior

`signing-site/pair.html` (served by `scripts/pairing-server.mts`) gained an
**Agent permissions** card driven entirely by backend endpoints:

- `GET  /api/permission?wallet&agent` — actual permission state, limits, allowlist,
  policy, daily totals, reservations (BigInt → decimal strings).
- `POST /api/permission/challenge` — issue the owner challenge.
- `POST /api/permission/grant` — requires a signed challenge **and** an active
  agent pairing.
- `POST /api/permission/control` — `pause` / `resume` / `revoke`, each requiring a
  fresh signed challenge.
- `GET  /api/approvals` — pending approvals.
- `POST /api/approval/request|approve|reject` — the manual approval flow.
- `GET  /api/activity` — secret-free permission and payment history.

The page distinguishes the seven states the task requires: connected wallet
(`v-state` pill), verified owner (`v-owner`), paired agent (`v-agent`), permission
granted (`v-permstatus`), approval state (`v-approvals`), and executed/finalized
payments (`v-activity`). Every value is read back from the server after each action;
nothing is computed client-side to look authorized.

Granting UI state alone authorizes nothing: the buttons call endpoints that
re-verify the signature server-side.

## Test evidence

`test/task72-agent-wallet-permissions.test.mts` — **22/22 passed**, offline
(no browser, no node, no transaction). Ownership uses a locally generated Ed25519 key
and the official SDK `signMessage`.

| # | Case | Result |
|---|---|---|
| 01 | permission disabled by default (`no_permission`) | pass |
| 02 | unauthorized owner (invalid signature) cannot grant | pass |
| 03 | expired permission challenge rejected | pass |
| 04 | replayed permission challenge rejected | pass |
| 05 | successful grant + revocation blocks payment | pass |
| 06 | per-transaction limit enforced (at-limit ok, over rejected) | pass |
| 07 | daily limit enforced across reservations | pass |
| 08 | period limit enforced | pass |
| 09 | recipient allowlist enforced | pass |
| 10 | wrong network/genesis rejected | pass |
| 11 | `manual` policy requires approval | pass |
| 12 | approval bound to exact params; amount/recipient tamper rejected; correct params consume it | pass |
| 13 | replayed approval rejected (`approval_not_approved`) | pass |
| 14 | paused agent blocked; resume restores | pass |
| 15 | wallet unlink invalidates all permissions | pass |
| 16 | concurrent reservations cannot bypass limits (exactly one grant) | pass |
| 17 | failed payment releases its reservation | pass |
| 18 | ambiguous submission retains its reservation | pass |
| 19 | finalized payment becomes recorded spending | pass |
| 20 | permission store unavailable fails closed | pass |
| 21 | no facilitator call when permission fails (`verify=0`, `settle=0`) | pass |
| 22 | network binding rejects cross-network payment (`settle=0`) | pass |

Also re-run green after the changes (no regressions):
`task71` 30/30 · `task04-x402-exact` 44/44 · `task05-commerce` 36/36 ·
`task25-facilitator` 36/36 · `task26-settlement-durability` 32/32 ·
`task37-pipeline-wire-integration` 15/15 · `task08-mcp-interface` 39/39.

Typecheck `tsc --noEmit`: 0 errors. Build `tsc`: 0 errors.

### Live server evidence (read-only, no transaction)

`npx tsx scripts/pairing-server.mts` on `127.0.0.1:4520`:

- `GET /api/permission?wallet=…&agent=agent-1` → `{"ok":true,"permission":null}`
  — permission is absent by default.
- `POST /api/permission/challenge` → challenge issued with the bound message.
- `POST /api/permission/grant` with a bad signature → `422 agent_not_paired`
  (the active agent pairing is required *and* the signature must verify; earlier gate
  fires first on this unpaired server).
- `POST /api/permission/control` without a challenge → `400 invalid challengeId`
  — control actions cannot be performed unsigned.
- `POST /api/approval/request` → approval created `status: pending`, `token: null`,
  `paramHash` populated; visible via `GET /api/approvals`; the
  `approval_requested` event appears in `GET /api/activity`.

### Known pre-existing flaky suites (not caused by this task)

- `task06-audit-integrity` test 11 and `task14-audit-strictness` test 15 — concurrent
  writers under load. Both pass standalone (25/25 and 18/18).
- `task3413-ipc-recovery` requires uid 1001 + supplementary group 1002; it self-skips
  otherwise.
- A whole-suite `npm test` run takes >20 min on this host and was observed hitting its
  own `timeout` wrapper at `task53`; every suite from `task53` onward was then run
  individually and passed. That is a runner artifact, not a failure.

## Remaining limitations

1. **In-memory persistence.** Permissions, reservations, approvals, and the activity
   log live in `PermissionManager`. A restart loses them. A SQLite adapter is the
   obvious next step; the public interface is designed for it.
2. **`bounded_auto` and `manual` are the only policies.** There is no
   per-recipient-per-limit matrix, no velocity limit, no time-of-day window.
3. **Approval request creation is unauthenticated.** Any caller that knows a
   (wallet, agent) pair can *request* an approval; only the owner can *approve* or
   *reject* it. This is intentional — the requester is normally the agent — but it
   means an attacker can spam the pending-approval list.
4. **No reconciliation worker.** A `retained` reservation stays retained until an
   operator or a future reconciliation job resolves it. There is no automatic
   expiry-based release, deliberately: releasing on time would defeat the point.
5. **UI wallet interaction unexercised.** The page drives real endpoints, but no
   Concordium browser extension was available on this host to complete the popup
   signing flow. All signing logic in the page is the same `signMessage` call verified
   verified against the official API surface.
6. **Live grant is blocked environmentally.** Granting a permission requires an
   active agent pairing for the agent; pairing token 1004 fails closed because its
   Agent Card host returns HTTP 502. Permission enforcement itself is fully exercised
   by the offline suite, which injects a paired agent.
7. **No Agent Skills.** Out of scope for this report.

## Non-negotiables — confirmation

- CIS-8004 token 1004 and its Agent Card URI/hash: untouched.
- Connect Wallet pairing behavior: preserved; the pairing suite passes 30/30.
- Sender and sponsor signing boundaries: untouched; no signing code was modified.
- No private key, recovery phrase, or wallet export requested or stored.
- No real Testnet transaction, no CCD spent, no faucet/funding operation.
- Facilitator settlement remains disabled by default; nothing here activates it.
- Payment permission is **not** auto-granted to existing paired agents: a permission
  only exists after a signed grant (`no_permission` is the default, verified live).
- No commits, no pushes.
