# Provider Onboarding — AgentTrust x402

The controlled, internal path that takes a provider from a submission to a
discoverable service. This is the **only** path a new provider should enter
Discovery through.

## The flow

One command, four steps, in this order:

```
agenttrust-discovery onboard --name "..." --description "..." \
  --category data --endpoint https://provider.example/service \
  --token-id 1234 --owner <base58> --agent-uri https://provider.example/.well-known/agent-card.json \
  --amount 10 --pay-to <base58> [--max-timeout 300] [--price-description "..."] \
  [--id svc_...] [--timeout-ms 30000] [--actor NAME] [--db PATH]
```

1. **Validate.** The submission is checked the same way `register`
   checks it (name, description, category, endpoint URL, Testnet
   network, provider tokenId/owner/agentUri, pricing amount/payTo). An
   incomplete or malformed input is rejected and **nothing is
   registered**.
2. **Register as INACTIVE.** The service is stored but is not
   discoverable and not payable while its identity is unverified.
   Registration always creates an inactive service (the registration
   input has no status field), and activation is refused unless the
   provider is verified TRUSTED — see the activation policy in
   `docs/discovery.md`.
3. **Verify identity.** The provider's CIS-8004 identity is checked
   against the Concordium registry and its Agent Card
   (`createProductionVerifier` → `verifyAgent`, pinned transport). A
   provider with no Agent Card (`--agent-uri null` or omitted) is
   never verified — the verifier is not even called.
4. **Activate ONLY on TRUSTED.** When verification returns TRUSTED the
   service is activated and becomes discoverable via the Discovery API
   with payment requirements. A REJECTED or INCONCLUSIVE outcome leaves
   the service inactive. If it was somehow active before (e.g. it was
   registered by the plain `register` command), onboarding deactivates
   it — fail-closed.

Re-running `onboard` for the same provider is idempotent: an already
verified + active service is returned as already onboarded, and an
inactive service with identical content is verified again. A service id
that already exists with **different** content is a conflict, never a
silent overwrite. A failed onboarding can be retried after the provider
fixes the problem (e.g. republishes a correct Agent Card).

## Output

JSON on stdout; progress on stderr. Exit 0 when the flow completed
(register + a verification attempt ran), **even when the provider was
not verified and the service stayed inactive** — the JSON reports
`onboarded` (true/false), the `verification` object, and the `reason`.
Exit 1 only on usage, validation, storage, or duplicate-conflict
errors. This matches the `verify` command's convention (a verdict is an
outcome, not a command failure).

Example success (abridged):

```json
{
  "id": "svc_acme-price",
  "name": "Acme Price Feed",
  "status": "active",
  "providerVerification": { "status": "verified", "decision": "TRUSTED" },
  "paymentRequirements": { "scheme": "exact", "network": "ccd:4221332d…", "amount": "10", "payTo": "…" },
  "onboarded": true,
  "verification": { "status": "verified", "decision": "TRUSTED" }
}
```

Example failure (abridged):

```json
{
  "id": "svc_acme-price",
  "status": "inactive",
  "providerVerification": { "status": "rejected", "decision": "REJECTED", "reason": "…" },
  "onboarded": false,
  "verification": { "status": "rejected", "decision": "REJECTED", "reason": "…" }
}
```

Every step writes an audit row (`register`, `verify`, `activate` /
`deactivate`), visible via `agenttrust-discovery audit [--id svc_...]`.

## What the operator needs from a provider

Before running `onboard` for a real provider, collect and check:

| Field | What it must be |
|---|---|
| Name, description | The service's real name and what it does (≤128 / ≤1024 chars). |
| Category | One of: `data`, `compute`, `content`, `communication`, `utility`, `other`. |
| Endpoint | The service's real, publicly reachable HTTPS URL. |
| Token ID | The provider's CIS-8004 token id on Concordium **Testnet** (a positive integer). It must exist in the on-chain registry. |
| Owner account | The token owner's Concordium account (50-char base58). It must match the on-chain owner. |
| Agent Card URL | The provider's public Agent Card URL. It must serve the card whose SHA-256 equals the on-chain metadata hash, with the badge extension naming the same token, owner, and CIS-8004/CIS-8 contracts. |
| Pricing | Amount in microCCD (> 0, ≤ 1000 CCD), asset `CCD`, payTo (the account that receives payment). |
| Service id (`--id`, optional) | A stable id (`svc_...`). If omitted, one is generated. Use an explicit id so a re-run is idempotent. |

Operator checks that are **not** automated (do them before onboarding):

- The provider is a real, independent party that agreed to be listed
  (not a placeholder, not AgentTrust itself relabelled).
- The endpoint is live and serves the claimed service (the registry
  validates the URL shape only; it never fetches the endpoint).
- The Agent Card URL serves the real card (fetch it and compare the
  SHA-256 to the on-chain metadata hash; `agenttrust-verify` can do
  the full check for a token).
- The price and payTo are what the provider actually charges and
  receives.

## Onboarding a real provider (procedure)

1. Collect the fields above and run the operator checks.
2. Run `onboard` with the provider's real values (use `--id` for a
   stable, re-runnable id). Confirm the JSON says `"onboarded": true`
   and `verification.status` is `"verified"`.
3. Confirm discoverability: `GET /api/services` on the running
   resource server lists the service, and
   `GET /api/services/<id>` returns it with `providerVerification.status`
   `"verified"` and `paymentRequirements` present.
4. If `onboarded` is false, read `verification.reason`, fix the cause
   with the provider (usually a wrong tokenId/owner, a card that does
   not match the on-chain hash, or a card URL that does not serve the
   card), and re-run `onboard` with the same `--id`.
5. Record the onboarding in the audit log (`agenttrust-discovery audit
   --id <id>`). Keep the provider's contact and the date of the checks
   outside the registry (the registry stores only service metadata).

A real onboarding needs a deployed Discovery API for step 3 to be
meaningful in public. On this VM the resource server runs on loopback
only; the public endpoint is a separate deployment step (see Gaps).

## The fixture (for testing only)

`test/fixtures/discovery/fixture-provider.json` is a pretend provider
used by `test/provider-onboarding.test.mts`. It is marked
`"fixture": true` and its note says so. Its tokenId (999999) does not
exist on the Concordium registry, its endpoint and Agent Card URL are
`.example` addresses that resolve nowhere, and its price is not a real
offer. **Do not register it in a production database and do not present
it as a real provider.** Its only purpose is to prove the flow works
end to end (with a stub verifier standing in for the production
verifier's verdicts) and that the production verifier correctly refuses
to verify it.

## What onboarding does NOT do

- No public registration. There is no POST endpoint and no MCP
  registration tool. A provider can only enter through this operator
  CLI, on the operator's own machine.
- No signing, settlement, broadcast, or payment. Onboarding only
  writes service metadata and audit rows. The first real payment is a
  separate, separately authorized step.
- No service health check. A listed service is "verified" (identity)
  and "active" (operator activated it); the registry does not prove
  the endpoint is up. That is the service trust dimension, still
  missing (see Gaps).
- No change to token 1004, its owner, URI, metadata, hash, registry,
  or the active Agent Card. Onboarding a new provider does not touch
  AgentTrust's own identity.

## Gaps (need a user decision or data)

1. **No real independent provider yet.** The fixture is not one. To
   onboard the first real provider, the user must supply a provider
   that meets the table above (real token, real card, real endpoint,
   agreed to be listed) — or confirm that AgentTrust itself (token
   1004) should be the first provider, labelled self-operated (the
   registration values for that were prepared earlier, not executed).
2. **Activation policy — RESOLVED 2026-11-13.** Registration now
   always creates an `inactive` service and `activate` is refused
   unless the provider is verified TRUSTED (see
   `test/provider-activation-policy.test.mts` and the activation
   policy in `docs/discovery.md`). There is no longer a fail-open
   hole via `register` or manual `activate`.
3. **No service health check.** The registry never fetches the
   endpoint. A provider whose service is down stays listed as active.
   Needs a liveness check (separate feature).
4. **No per-service payment evidence.** The facilitator DB holds
   payment/settlement rows, but there is no per-service payment
   evidence endpoint. (Blueprint trust dimension 3, still missing.)
5. **No public endpoint deployed.** An onboarded service is only
   discoverable where the Discovery API runs. The public endpoint
   (origin deployment + nginx routing) is a separate step, blocked on
   the origin deployment decision and Hermes's review.
6. **The production verifier needs network egress** (registry MCP +
   Agent Card fetch). It works on this VM via the egress proxy (after
   the pinned-transport fix); on the origin it needs the same egress
   (direct or proxy) to those hosts.
7. **The code is committed locally but not yet published.** The
   implementation is recorded in local commits `dd02c85` and `6b2a74c`
   on branch `integrate/provider-policy-bundle` (the provider-policy
   bundle plus the pinned-transport fix), but the branch has not been
   pushed to the remote. It reaches the origin only via push (and a
   PR) or a direct copy — a user decision (push is currently not
   authorized).

## Files

- `src/discovery/onboarding.ts` — `onboardProvider` (the flow).
- `src/discovery/registry.ts` — `serviceInputMatches` no longer
  compares status (status is lifecycle state, not content; this is
  what makes re-onboarding idempotent).
- `src/cli/discovery.ts` — `onboard` subcommand (+ a shared
  `buildRegistrationInput` helper used by `register` and `onboard`).
- `test/fixtures/discovery/fixture-provider.json` — the fixture.
- `test/provider-onboarding.test.mts` — 12 tests.
