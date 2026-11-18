/**
 * Payment detail: verifiable settlement evidence for one payment.
 *
 * Read-only. This module never writes to the database, never signs, never
 * submits, and never changes a payment's state. It assembles what a user
 * needs to verify a payment:
 *
 *   - the stored record (payment digest, state, transaction hash, the
 *     requirements the payment was authorised for, the transition trail
 *     including the tamper-evident evidence pointer recorded when the
 *     payment finalized),
 *   - a fresh, live observation of the recorded transaction hash from the
 *     evidence verifier — the same trusted source reconciliation uses —
 *     with the block height resolved from the same node when available.
 *
 * Two display rules are enforced here, not left to the caller:
 *
 *   - `finalized` is true ONLY when the STORED state is `finalized`. A live
 *     observation of "finalized" for a payment whose stored state is
 *     `outcome_unknown` (or anything else) is reported as the chain status,
 *     never as a finalized payment: the stored state is the only thing
 *     reconciliation may advance, and the detail must not get ahead of it.
 *   - When the verifier cannot answer (mock mode, node down, hash unknown
 *     to the node), the verification section says so explicitly instead of
 *     repeating the stored state as if it had been checked.
 *
 * The identifier is either the payment digest or the recorded transaction
 * hash (both 64-char hex). Digest lookup wins: a value is first tried as a
 * payment digest, then as a transaction hash. A value that is neither is
 * `unknown_payment`, never a guess.
 */

import type { EvidenceVerifier } from './evidence.js';
import type { SettlementRepository } from './repository.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** What the payment was authorised for, parsed from the stored requirements key. */
export interface PaymentDetailRequirements {
  /** CAIP-2 network, e.g. `ccd:4221332d34e1694168c2a0c0b3fd0f27`. Null when the key does not parse. */
  network: string | null;
  /** Recipient account (payTo). */
  payTo: string | null;
  /** Transfer amount in the asset's smallest unit, as recorded. */
  amount: string | null;
  /** Asset identifier, e.g. `CCD`. */
  asset: string | null;
  /** Canonical resource URL the payment was bound to. */
  resourceUrl: string | null;
  /** The raw key as stored, for audit when it does not parse. */
  raw: string;
}

export interface PaymentDetailTransition {
  from: string | null;
  to: string;
  reason: string;
  /** ms since epoch. */
  at: number;
  /** Tamper-evident evidence pointer recorded with the transition, if any. */
  evidence: { source: string; digest: string } | null;
}

/**
 * Live verification of the recorded transaction hash.
 *
 * `finalized` here is the CHAIN's observation only — it never, on its own,
 * makes the payment finalized. See `PaymentDetail.finalized` for the stored
 * state, which is the only finalized verdict the detail reports.
 */
export interface PaymentDetailVerification {
  /** Whether the verifier could establish anything at all. */
  available: boolean;
  /** Chain-reported status, verbatim (`finalized`, `committed`, `pending`, `unknown`). */
  observed: string;
  /** Provenance of the observation, e.g. `concordium-grpc`. */
  source: string;
  /** True only when the chain reports this exact hash as finalized. */
  finalized: boolean;
  /** Block the transaction finalized in, when the chain reported one. */
  blockHash: string | null;
  /** Block height, from the same node. Null when the node could not answer. */
  blockHeight: string | null;
  /** Block slot time (ISO-8601), when the node reported one. */
  blockSlotTime: string | null;
  /** Sender account, from the on-chain summary. */
  sender: string | null;
  /** Sponsor / fee-payer account, from the on-chain summary. */
  sponsor: string | null;
  /** Actual transaction fee in microCCD, from the on-chain summary. */
  feeMicroCcd: string | null;
  /** Execution energy (NRG), from the on-chain summary. */
  energy: string | null;
  /** Transfer recipient, from the on-chain summary. */
  recipient: string | null;
  /** Transferred amount in the asset's smallest unit, from the on-chain summary. */
  transferAmount: string | null;
  /** Set when the verifier failed or could not be asked. */
  error: string | null;
}

export interface PaymentDetail {
  paymentDigest: string;
  /** Stored settlement state (`finalized`, `outcome_unknown`, …). */
  state: string;
  /** True ONLY when the stored state is `finalized`. */
  finalized: boolean;
  transactionHash: string | null;
  requirements: PaymentDetailRequirements;
  attempted: number;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch. */
  updatedAt: number;
  transitions: PaymentDetailTransition[];
  verification: PaymentDetailVerification;
}

export type PaymentDetailResult =
  | { ok: true; detail: PaymentDetail }
  | { ok: false; code: 'invalid_request' | 'unknown_payment'; reason: string };

/** Optional block-header lookup, provided by verifiers backed by a real node. */
export interface BlockInfoProvider {
  blockInfo(blockHash: string): Promise<{ blockHeight: string; blockSlotTime: string | null } | null>;
}

export interface PaymentDetailDeps {
  repository: SettlementRepository;
  /** Evidence verifier; may additionally resolve block headers (see `BlockInfoProvider`). */
  verifier: EvidenceVerifier & Partial<BlockInfoProvider>;
}

/**
 * Parse a stored requirements key (`network|payTo|amount|asset|resourceUrl`).
 * A key that does not split into exactly those five fields yields nulls —
 * the caller shows the raw key instead of inventing values.
 */
export function parseRequirementsKey(key: string): PaymentDetailRequirements {
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (parts.length !== 5) {
    return { network: null, payTo: null, amount: null, asset: null, resourceUrl: null, raw: key };
  }
  const [network, payTo, amount, asset, resourceUrl] = parts as [string, string, string, string, string];
  return { network, payTo, amount, asset, resourceUrl, raw: key };
}

/**
 * Extract the verification fields from a raw `getBlockItemStatus` response.
 * Pure and defensive: any malformed shape yields nulls, never a throw.
 * The fee is the SPONSOR's charge (`summary.sponsor.cost`) when present —
 * for a sponsored transfer the sender's own `summary.cost` is 0 — falling
 * back to `summary.cost` for non-sponsored transactions.
 *
 * The live SDK response uses rich types, not plain strings: block/transaction
 * hashes are `BlockHash`/`TransactionHash` objects, accounts are
 * `AccountAddress` objects, and amounts are `CcdAmount` objects whose
 * `String()` is the CCD decimal ('4.800331') while `microCcdAmount` holds
 * the microCCD integer. `displayString` normalises all of these to the
 * display form the detail needs (hex / base58 / microCCD integer string),
 * preferring `microCcdAmount` for amounts so a fee is never rendered as a
 * decimal. Plain objects without a custom `toString` yield null, never
 * '[object Object]'.
 */
export function extractNodeVerification(raw: unknown): Omit<PaymentDetailVerification, 'available' | 'observed' | 'source' | 'error'> {
  const empty = {
    finalized: false,
    blockHash: null,
    blockHeight: null,
    blockSlotTime: null,
    sender: null,
    sponsor: null,
    feeMicroCcd: null,
    energy: null,
    recipient: null,
    transferAmount: null,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as { status?: unknown; outcome?: unknown };
  const status = typeof r.status === 'string' ? r.status : '';
  const outcome = r.outcome && typeof r.outcome === 'object' ? (r.outcome as Record<string, unknown>) : null;
  if (!outcome) return empty;
  const blockHashRaw = displayString(outcome.blockHash);
  const blockHash = blockHashRaw !== null && HEX64.test(blockHashRaw.toLowerCase())
    ? blockHashRaw.toLowerCase()
    : null;
  const summary = outcome.summary && typeof outcome.summary === 'object'
    ? (outcome.summary as Record<string, unknown>)
    : null;
  if (!summary) return { ...empty, finalized: status === 'finalized', blockHash };
  const energyRaw = summary.energyCost;
  const energy =
    energyRaw && typeof energyRaw === 'object'
      ? displayString((energyRaw as Record<string, unknown>).value) ?? displayString(energyRaw)
      : displayString(energyRaw);
  const sponsorObj = summary.sponsor && typeof summary.sponsor === 'object'
    ? (summary.sponsor as Record<string, unknown>)
    : null;
  const transferObj = summary.transfer && typeof summary.transfer === 'object'
    ? (summary.transfer as Record<string, unknown>)
    : null;
  return {
    finalized: status === 'finalized',
    blockHash,
    blockHeight: null,
    blockSlotTime: null,
    sender: displayString(summary.sender),
    sponsor: sponsorObj ? displayString(sponsorObj.sponsor) : null,
    feeMicroCcd: sponsorObj ? displayString(sponsorObj.cost) : displayString(summary.cost),
    energy,
    recipient: transferObj ? displayString(transferObj.to) : null,
    transferAmount: transferObj ? displayString(transferObj.amount) : null,
  };
}

/**
 * Normalise one SDK-shaped value to its display string, or null when it
 * carries nothing displayable. Amount objects (`CcdAmount`) resolve to
 * their `microCcdAmount` integer, never the CCD-decimal `String()`.
 */
function displayString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const micro = o.microCcdAmount;
    if (typeof micro === 'string' || typeof micro === 'number' || typeof micro === 'bigint') {
      return String(micro);
    }
    if (typeof o.toString === 'function' && o.toString !== Object.prototype.toString) {
      return String(v);
    }
  }
  return null;
}

function unavailableVerification(source: string, error: string | null): PaymentDetailVerification {
  return {
    available: false,
    observed: 'unknown',
    source,
    finalized: false,
    blockHash: null,
    blockHeight: null,
    blockSlotTime: null,
    sender: null,
    sponsor: null,
    feeMicroCcd: null,
    energy: null,
    recipient: null,
    transferAmount: null,
    error,
  };
}

/** Assemble the payment detail for a digest or a transaction hash. Read-only. */
export async function getPaymentDetail(deps: PaymentDetailDeps, id: string): Promise<PaymentDetailResult> {
  const normalized = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!HEX64.test(normalized)) {
    return { ok: false, code: 'invalid_request', reason: 'payment identifier must be a 64-char hex digest or transaction hash' };
  }
  const row = deps.repository.get(normalized) ?? deps.repository.getByTransaction(normalized);
  if (!row) {
    return { ok: false, code: 'unknown_payment', reason: 'no payment with this digest or transaction hash' };
  }

  const transitions = deps.repository.transitions(row.payment_digest).map((t) => {
    let evidence: { source: string; digest: string } | null = null;
    if (typeof t.evidence === 'string' && t.evidence) {
      try {
        const parsed: unknown = JSON.parse(t.evidence);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as Record<string, unknown>).source === 'string' &&
          typeof (parsed as Record<string, unknown>).digest === 'string'
        ) {
          const p = parsed as { source: string; digest: string };
          evidence = { source: p.source, digest: p.digest };
        }
      } catch {
        evidence = null;
      }
    }
    return {
      from: t.from_state,
      to: t.to_state,
      reason: t.reason,
      at: t.at,
      evidence,
    };
  });

  let verification: PaymentDetailVerification;
  if (!row.tx_hash) {
    verification = unavailableVerification('none', 'no transaction hash recorded for this payment');
  } else {
    let ev;
    try {
      ev = await deps.verifier.verify({ transaction: row.tx_hash, paymentDigest: row.payment_digest });
    } catch (e) {
      verification = unavailableVerification(
        deps.verifier.name,
        `verifier failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
      return finish(row, verification, transitions);
    }
    if (!ev.available) {
      verification = unavailableVerification(ev.source, ev.error ?? 'evidence unavailable');
    } else {
      const extracted = extractNodeVerification(ev.raw);
      verification = {
        available: true,
        observed: ev.observed,
        source: ev.source,
        ...extracted,
        error: null,
      };
      // Block height comes from the same node, only for a finalized
      // observation that named a block. Any failure leaves it null.
      if (extracted.finalized && extracted.blockHash && typeof deps.verifier.blockInfo === 'function') {
        try {
          const info = await deps.verifier.blockInfo(extracted.blockHash);
          if (info) {
            verification.blockHeight = info.blockHeight;
            verification.blockSlotTime = info.blockSlotTime;
          }
        } catch {
          // Height stays null; the rest of the evidence stands.
        }
      }
    }
  }

  return finish(row, verification, transitions);
}

function finish(
  row: { payment_digest: string; requirements_key: string; state: string; tx_hash: string | null; attempted: number; created_at: number; updated_at: number },
  verification: PaymentDetailVerification,
  transitions: PaymentDetailTransition[],
): PaymentDetailResult {
  return {
    ok: true,
    detail: {
      paymentDigest: row.payment_digest,
      state: row.state,
      finalized: row.state === 'finalized',
      transactionHash: row.tx_hash,
      requirements: parseRequirementsKey(row.requirements_key),
      attempted: row.attempted,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      transitions,
      verification,
    },
  };
}
