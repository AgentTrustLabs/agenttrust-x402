# TASK 34 — Mock-Only Narrow Sponsor Signer Adapter

Date: 2026-11-05 · Baseline HEAD `4c8994db391d77796e06e49c843c42be1eae615b` · Mock-only, no signing.

## 1. Architecture and trust boundary

```
Client (untrusted) ──► Facilitator (trusted) ──► NarrowSponsorSigner.authorize() ──► MockNarrowSponsorSigner
        │                       │                           │
        │                       │                           ├── decideAuthorization()  [pure, no I/O]
        │                       │                           └── repo.recordSignEvent()    [durable audit]
        │                       │
        │                       └── (future) sponsor sign → hash → persist → submit → reconcile
        │
        └── never reaches any signing function
```

The `NarrowSponsorSigner` interface exposes **only** `authorize()`. There is no `sign()`,
no `AccountSigner`, no private key, no wallet. The SDK's general-purpose signer is never
imported or referenced in `narrowSponsorMock.ts` (verified by test 26).

## 2. Interface definition

`services/facilitator/src/narrowSponsor.ts`:

```typescript
interface SponsorAuthorizationRequest {
  network, version, sender, sponsor, recipient, asset, amount,
  expiry, energy, paymentDigest, paymentState
}

interface NarrowSponsorSigner {
  readonly policyVersion: string;
  authorize(request): Promise<SponsorAuthorizationResult>;
}
```

`authorize()` returns `{approved, reason?, detail?}`. No signature is ever produced.

## 3. Validation rules

`decideAuthorization()` checks (in order):

1. Policy validity (network, sponsor, maxEnergy, maxExpiryOffset, allowedAssets).
2. Network identity.
3. Transaction version = 1.
4. Asset in allowed list.
5. Sender / recipient / sponsor presence.
6. Sender / recipient / sponsor address validity (canonical base58check).
7. Sponsor == configured sponsor.
8. Sponsor != sender.
9. Sponsor != recipient.
10. Expiry: safe integer, not expired, within maxExpiryOffset.
11. Energy: bigint type, non-negative, no int64 overflow, <= cap.

All fail closed. Missing limits reject. Malformed values reject.

## 4. Energy/fee policy

- `maxEnergy` is a `bigint` (not a number) to avoid precision loss.
- Overflow guard: `energy > 0x7fffffffffffffffn` → `energy_overflow`.
- Negative → `energy_negative`.
- Non-bigint → `energy_malformed`.
- Missing (undefined) → `missing_energy_limit`.
- Fee exposure is documented as **unresolved** (§9): the exact CCD fee depends on network
  constants not available in the transaction context. The energy cap is the enforced proxy.

## 5. Sponsor identity rules

- Sponsor must equal the configured sponsor address (canonical comparison via
  `AccountAddress.fromBase58`).
- Sponsor must not equal sender.
- Sponsor must not equal recipient.
- All addresses validated for base58check shape before comparison.

## 6. Audit schema and durability

`sign_events` table (SQLite, WAL + `synchronous=FULL`):

```sql
CREATE TABLE IF NOT EXISTS sign_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_digest TEXT NOT NULL,
  decided_at     INTEGER NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason         TEXT,
  network        TEXT NOT NULL,
  sender         TEXT NOT NULL,
  sponsor        TEXT NOT NULL,
  recipient      TEXT NOT NULL,
  energy         TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  FOREIGN KEY (payment_digest) REFERENCES payments(payment_digest)
);
```

- Append-only: only `INSERT`, no `UPDATE` or `DELETE`.
- Atomic: wrapped in `BEGIN IMMEDIATE … COMMIT`.
- Audit write failure → `authorize()` returns `{approved:false, reason:'audit_write_failed'}`.
  Approval is **never** granted without a durable event.
- No private keys, signing digests, secret material, full transaction payloads, or auth
  tokens stored. Only identity fields, energy, policy version, and decision.

## 7. Sixteen-case test matrix (all fail closed)

| # | Case | Expected |
|---|---|---|
| 1 | Valid context | approved |
| 2 | Wrong network | wrong_network |
| 3 | Wrong sponsor | wrong_sponsor |
| 4 | Sponsor = sender | sponsor_is_sender |
| 5 | Sponsor = recipient | sponsor_is_recipient |
| 6 | Missing sender | missing_sender |
| 7 | Missing recipient | missing_recipient |
| 8 | Invalid address | invalid_sender |
| 9 | Expired | expired |
| 10 | Excessive expiry | expiry_excessive |
| 11 | Missing energy limit | missing_energy_limit |
| 12 | Energy above cap | energy_exceeds_cap |
| 13 | Energy at cap | approved |
| 14 | Malformed energy | energy_malformed |
| 15 | Terminal payment | duplicate_payment |
| 16 | Audit write failure | audit_write_failed |

Additional: negative energy, int64 overflow, negative policy, unsupported asset, wrong
version, invalid recipient, missing sponsor, concurrent authorization, restart survival,
prototype isolation, determinism, audit field completeness.

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
| task34-narrow-sponsor-auth | 28/28 |
| **full suite** | **1498/1498, 32 suites** |
| typecheck (gateway + facilitator) | OK |

## 9. Remaining limitations

1. **Fee exposure is not precisely calculable.** The energy cap is enforced, but the
   conversion from energy to CCD depends on network constants not available in the
   transaction context. Fee exposure is documented as unresolved.
2. **No real signing.** `NarrowSponsorSigner` has no `sign()` method. No `AccountSigner`.
3. **No durable hash before authorization.** The authorization audit event is recorded, but
   the transaction hash (which requires the sponsor signature) cannot be computed until
   after authorization. The ordering is: authorize → sign → hash → persist → submit.
4. **Sponsor identity is a string comparison.** Canonical comparison uses
   `AccountAddress.fromBase58`, which normalizes, but the configured sponsor is not
   verified on-chain (no node query). This is acceptable for a mock adapter.

## 10. Recommended next bounded task

**TASK 35 — Real Sponsor Signer Adapter (Testnet Only, Mock-Backed Signing).**

Scope:
- Implement a real `AccountSigner`-compatible adapter that delegates to a
  `NarrowSponsorSigner` for authorization, then signs with a testnet-only key.
- Add energy cap and sponsor≠recipient validation to `FacilitatorCore::settle()`.
- Test the full authorize → sign → hash → persist → submit → reconcile flow with
  deterministic fixtures.
- Do not provision a real sponsor account. Do not enable real settlement.

## Constraints honoured

- No private-key access, generation, or wallet access.
- No sponsor account provisioning.
- No real signer implementation.
- No actual signing.
- No transaction construction for broadcast.
- No transaction submission.
- No faucet.
- No Mainnet interaction.
- No real settlement.
- Token 1004 untouched.
- Settlement not enabled.
- `DENY_ALL_FACILITATOR` not disabled.
- Replay protection and crash recovery not weakened.
- No commit, push, publish, or GitHub issue.
- HEAD remains `4c8994d`.

## Stop condition

TASK 34 complete. 28/28, 1498/1498 full suite. Awaiting explicit maintainer approval before
TASK 35 or any sponsor provisioning.
