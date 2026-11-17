/**
 * API Discovery — Service Registry (MVP + persistence).
 *
 * The first layer of the Agent Network foundation: a directory of API
 * services an agent can discover, price, and pay for — before it pays.
 *
 * Design rules (deliberately narrow, matching the rest of AgentTrust):
 *   - Testnet only. Any other network is rejected at registration.
 *   - The registry logic only ever talks to the `ServiceStore` interface
 *     (`src/discovery/store.ts`). The default store is in-memory; pass a
 *     `SqliteServiceStore` for durability. Swapping the backend changes no
 *     behaviour: the same validation, duplicate handling, verification
 *     mapping and audit rules run on both.
 *   - Registration and verification are SEPARATE. Registering a service
 *     only records the claim (`providerVerification.status: 'registered'`).
 *     A provider becomes `verified` only when an injected verifier
 *     (wrapping `verifyAgent` from `src/verify/crossAgent.ts`) returns
 *     TRUSTED. Nothing here fabricates a reputation or a trust score.
 *   - ACTIVATION POLICY (the invariant this module enforces): a service
 *     is 'active' ONLY while its provider verification is TRUSTED
 *     (`providerVerification.status === 'verified'`). Registration always
 *     creates an 'inactive' service — the caller cannot choose 'active'.
 *     `setStatus` to 'active' is refused unless the provider is
 *     verified, and if the service is somehow active without valid
 *     verification (a pre-policy row, or a re-verification that came
 *     back REJECTED/INCONCLUSIVE), the attempt deactivates it instead
 *     of leaving it active. `verifyProvider` deactivates an active
 *     service whose verification stops being TRUSTED. There is no path
 *     — register, activate, onboard, verify, or the HTTP API — that
 *     leaves an unverified provider active or discoverable.
 *   - READ-PATH FAIL-CLOSED (the Discovery invariant): the projection
 *     layer (`toServiceView` + `list`) applies the same invariant to
 *     every Discovery response, even for a stored row that violates it.
 *     A service is discoverable ONLY when it is stored 'active' AND its
 *     provider verification is TRUSTED (`isDiscoverable`). A legacy row
 *     that is stored 'active' but unverified is projected as 'inactive',
 *     with `available: false` and no `paymentRequirements` — it never
 *     appears in the active list and is never retrievable as an active
 *     service. The stored record is NEVER changed by a read: no row is
 *     deactivated, deleted, or rewritten just to hide it from Discovery.
 *     (The operator can find such rows by querying the database
 *     directly, e.g. `sqlite3 discovery.db "SELECT id FROM services
 *     WHERE status='active' AND verification_status <> 'verified'"`,
 *     then fix them with `verify` + `activate` or `deactivate`.)
 *   - No payment logic. The registry builds the x402 `PaymentRequirements`
 *     a client needs to *read* before paying; it never verifies, settles,
 *     or constructs a transaction.
 *   - Registration is operator-side only. There is no HTTP write path and
 *     no MCP registration tool. Every mutation (register, activate,
 *     deactivate, verify) writes one append-only audit row naming the
 *     actor, the action and the service. A refused activation also writes
 *     an audit row (it is a security-relevant attempt).
 */

import { randomBytes } from 'node:crypto';
import type { PaymentRequirements } from '@x402/core/types';
import {
  buildPaymentRequirements,
  isConcordiumAccount,
  CCD_TESTNET_CAIP2,
} from '../payments/x402.js';
import { createMemoryServiceStore } from './memoryStore.js';
import type { AuditEntry, ServiceStore } from './store.js';

// ─── constants ────────────────────────────────────────────────────────────

/** Concordium Testnet CAIP-2. The only network this registry accepts. */
export const DISCOVERY_NETWORK = CCD_TESTNET_CAIP2;

/** Closed category set. Filtering is only meaningful on known values. */
export const SERVICE_CATEGORIES = [
  'data',
  'compute',
  'content',
  'communication',
  'utility',
  'other',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Price ceiling in microCCD (1000 CCD) — matches the MCP demo ceiling. */
export const MAX_PRICE_MICRO_CCD = '1000000000';
/** Longest a payment requirement may stay valid (spec rule 7). */
export const MAX_TIMEOUT_SECONDS = 600;
/** Bounded result sets, like the MCP search limit. */
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;

/** Service ids live in one namespace: `svc_` + slug characters. */
export const SERVICE_ID_PATTERN = /^svc_[A-Za-z0-9_-]+$/;

// ─── types ────────────────────────────────────────────────────────────────

export interface ServiceProviderIdentity {
  /** CIS-8004 token id of the provider agent. */
  tokenId: number;
  /** Provider's Concordium account (base58, exactly 50 chars). */
  ownerAccount: string;
  /**
   * Where the provider's Agent Card lives. `null` means no card is linked
   * yet — the provider can never become `verified` until one is supplied.
   */
  agentUri: string | null;
}

export interface ServicePricing {
  /** Price in microCCD, as a decimal integer string. Must be > 0. */
  amountMicroCcd: string;
  /** Always 'CCD' in this MVP (native asset only). */
  asset: 'CCD';
  /** Recipient of the payment (base58 Concordium account). */
  payTo: string;
  /** Seconds the requirement stays valid. Default 300. */
  maxTimeoutSeconds?: number;
  /** Human-readable price note, surfaced in the 402 body. */
  description?: string;
}

export interface ServiceRegistrationInput {
  /**
   * Optional client-chosen id (`svc_...`). When omitted, the registry
   * assigns one. Re-registering the SAME id with IDENTICAL content is an
   * idempotent no-op (the existing service is returned); the same id with
   * DIFFERENT content is a duplicate error. A service's id never changes.
   */
  id?: string;
  name: string;
  description: string;
  category: string;
  /** The service's own URL. Validated as a URL; never fetched by the registry. */
  endpoint: string;
  provider: ServiceProviderIdentity;
  /** Must be the Testnet CAIP-2. Anything else is rejected. */
  network: string;
  pricing: ServicePricing;
  /**
   * No status field. Registration always creates an 'inactive' service
   * (see the activation policy in the module header); the caller cannot
   * choose 'active', and activation happens only through `setStatus`
   * after a TRUSTED verification. Lifecycle changes go through
   * `setStatus` / `verifyProvider`, never through re-registration.
   */
}

export type ProviderVerificationStatus = 'registered' | 'verified' | 'rejected' | 'unverified';

export interface ProviderVerification {
  /**
   * `registered`  — listed, verification has not run yet. NOT trusted.
   * `verified`    — an injected verifier returned TRUSTED for this provider.
   * `rejected`    — verification ran and the identity was contradicted.
   * `unverified`  — verification ran but the evidence could not be
   *                 established (INCONCLUSIVE). NOT trusted, NOT accused.
   */
  status: ProviderVerificationStatus;
  /** The verifier's decision, when one has run. */
  decision?: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';
  /** ISO timestamp of the last verification attempt. */
  checkedAt?: string;
  /** Short, human-readable reason for the current status. */
  reason?: string;
}

export interface ServiceRecord {
  id: string;
  name: string;
  description: string;
  category: ServiceCategory;
  endpoint: string;
  provider: ServiceProviderIdentity;
  network: string;
  pricing: ServicePricing;
  status: 'active' | 'inactive';
  providerVerification: ProviderVerification;
  registeredAt: string;
}

export interface ServiceListFilters {
  category?: string;
  network?: string;
  /** Case-insensitive substring match on name + description. */
  q?: string;
  /**
   * 'active' | 'inactive' | 'all'. Default 'active'.
   * This is the EFFECTIVE (discoverable) status, not the stored status:
   * 'active' means discoverable (stored 'active' AND provider verified
   * TRUSTED); 'inactive' means not discoverable (stored 'inactive' OR
   * provider not verified). A legacy row stored 'active' but unverified
   * appears under 'inactive', never under 'active'. 'all' returns
   * every service regardless of discoverability.
   */
  status?: string;
  /** Max results. Default 25, cap 100. */
  limit?: number;
}

export interface RegistryMutationOptions {
  /** Who performed the action (operator name, CLI --actor). Default 'operator'. */
  actor?: string;
}

// ─── validation ───────────────────────────────────────────────────────────

/** URL shape check for endpoints and agent URIs. The registry never fetches
 *  these URLs, so this is a shape check only — it does not prove reachability
 *  or safety. An agent must validate an endpoint before calling it. */
export function isValidServiceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (/%/.test(u.hostname)) return false;
  if (!u.hostname) return false;
  return true;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate a registration input. Returns the list of problems (empty when
 * valid). Every failure names the field, so a caller can fix exactly that.
 */
export function validateServiceInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['registration input must be an object'];
  }
  const r = input as Partial<ServiceRegistrationInput>;

  if (r.id !== undefined) {
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 64 || !SERVICE_ID_PATTERN.test(r.id)) {
      errors.push("id must be a string like 'svc_<slug>' (letters, digits, '_' and '-', max 64 characters)");
    }
  }
  if (!isNonEmptyString(r.name, 128)) errors.push("name must be a non-empty string (max 128 characters)");
  if (!isNonEmptyString(r.description, 1024)) errors.push("description must be a non-empty string (max 1024 characters)");
  if (typeof r.category !== 'string' || !(SERVICE_CATEGORIES as readonly string[]).includes(r.category)) {
    errors.push(`category must be one of ${SERVICE_CATEGORIES.join(', ')}`);
  }
  if (!isValidServiceUrl(r.endpoint)) {
    errors.push('endpoint must be a valid absolute http(s) URL without userinfo');
  }
  if (r.network !== DISCOVERY_NETWORK) {
    errors.push(`network must be ${DISCOVERY_NETWORK} (Concordium Testnet only)`);
  }

  // provider identity
  const p = r.provider;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('provider must be an object');
  } else {
    const tokenId = (p as ServiceProviderIdentity).tokenId;
    if (!isPositiveInteger(tokenId) || tokenId > 4_294_967_295) {
      errors.push('provider.tokenId must be a positive integer');
    }
    if (!isConcordiumAccount((p as ServiceProviderIdentity).ownerAccount)) {
      errors.push('provider.ownerAccount must be a valid Concordium account address');
    }
    const agentUri = (p as ServiceProviderIdentity).agentUri;
    if (agentUri !== null && !isValidServiceUrl(agentUri)) {
      errors.push('provider.agentUri must be a valid absolute http(s) URL or null');
    }
  }

  // pricing
  const pr = r.pricing;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    errors.push('pricing must be an object');
  } else {
    const amount = (pr as ServicePricing).amountMicroCcd;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
      errors.push('pricing.amountMicroCcd must be a decimal integer string');
    } else if (BigInt(amount) <= 0n) {
      errors.push('pricing.amountMicroCcd must be greater than zero');
    } else if (BigInt(amount) > BigInt(MAX_PRICE_MICRO_CCD)) {
      errors.push(`pricing.amountMicroCcd exceeds the ${MAX_PRICE_MICRO_CCD} microCCD ceiling`);
    }
    if ((pr as ServicePricing).asset !== 'CCD') {
      errors.push("pricing.asset must be 'CCD'");
    }
    if (!isConcordiumAccount((pr as ServicePricing).payTo)) {
      errors.push('pricing.payTo must be a valid Concordium account address');
    }
    const timeout = (pr as ServicePricing).maxTimeoutSeconds;
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
      errors.push(`pricing.maxTimeoutSeconds must be a positive integer at most ${MAX_TIMEOUT_SECONDS}`);
    }
    if ((pr as ServicePricing).description !== undefined && !isNonEmptyString((pr as ServicePricing).description, 256)) {
      errors.push('pricing.description must be a non-empty string (max 256 characters)');
    }
  }

  return errors;
}

// ─── registry ─────────────────────────────────────────────────────────────

export interface ServiceRegistry {
  register(
    input: ServiceRegistrationInput,
    opts?: RegistryMutationOptions,
  ): { ok: true; service: ServiceRecord } | { ok: false; errors: string[] };
  get(id: string): ServiceRecord | undefined;
  list(filters?: ServiceListFilters): { services: ServiceRecord[]; total: number };
  /**
   * Change a service's status. Deactivation is always allowed.
   * Activation is allowed ONLY when the provider's verification is
   * TRUSTED (`providerVerification.status === 'verified'`); otherwise
   * it is refused — and if the service is somehow active without valid
   * verification, the refusal deactivates it instead of leaving it
   * active (fail-closed, self-correcting). A refusal is an error, not
   * a silent no-op, so the caller can report why activation was denied.
   */
  setStatus(
    id: string,
    status: 'active' | 'inactive',
    opts?: RegistryMutationOptions,
  ): { ok: true; service: ServiceRecord } | { ok: false; error: string };
  verifyProvider(
    id: string,
    verifier: (provider: ServiceProviderIdentity) => Promise<{
      decision: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';
      reason?: string;
    }>,
    opts?: RegistryMutationOptions,
  ): Promise<{ ok: true; service: ServiceRecord } | { ok: false; error: string }>;
  /** Audit rows, newest first. Filtered by service when an id is given. */
  auditLog(serviceId?: string): AuditEntry[];
  size(): number;
  close(): void;
}

/**
 * Does a stored record carry exactly the content of a registration input?
 *
 * Status is deliberately NOT compared: it is lifecycle state, not
 * registration content. The onboarding flow registers a service as
 * 'inactive' and activates it only after verification, so re-onboarding
 * an already-active service with otherwise identical content must be an
 * idempotent no-op, not a duplicate conflict. Lifecycle changes go
 * through `setStatus` / `verifyProvider`, never through re-registration.
 */
function serviceInputMatches(record: ServiceRecord, input: ServiceRegistrationInput): boolean {
  return (
    record.name === input.name.trim() &&
    record.description === input.description.trim() &&
    record.category === input.category &&
    record.endpoint === input.endpoint &&
    record.provider.tokenId === input.provider.tokenId &&
    record.provider.ownerAccount === input.provider.ownerAccount &&
    record.provider.agentUri === input.provider.agentUri &&
    record.network === input.network &&
    record.pricing.amountMicroCcd === input.pricing.amountMicroCcd &&
    record.pricing.payTo === input.pricing.payTo &&
    (record.pricing.maxTimeoutSeconds ?? undefined) === (input.pricing.maxTimeoutSeconds ?? undefined) &&
    (record.pricing.description ?? undefined) === (input.pricing.description ?? undefined)
  );
}

/**
 * Create a service registry over any `ServiceStore`.
 *
 * The verifier is injected per call (never stored), so the registry itself
 * stays pure and the caller controls where verification truth comes from.
 * In production the verifier wraps `verifyAgent` from
 * `src/verify/crossAgent.ts` (see `src/discovery/verify.ts`); in tests it
 * is a stub.
 */
export function createServiceRegistry(store: ServiceStore = createMemoryServiceStore()): ServiceRegistry {
  function newId(): string {
    return `svc_${randomBytes(8).toString('hex')}`;
  }

  function audit(actor: string, action: AuditEntry['action'], serviceId: string, detail: string): void {
    try {
      store.appendAudit({ at: new Date().toISOString(), actor, action, serviceId, detail });
    } catch {
      // Audit is best-effort on top of the mutation: a failed audit write must
      // not roll back a mutation that already committed. The mutation itself
      // is the durable fact; the audit is its annotation.
    }
  }

  return {
    register(input, opts = {}) {
      const actor = opts.actor ?? 'operator';
      const errors = validateServiceInput(input);
      if (errors.length > 0) return { ok: false, errors };
      const id = input.id ?? newId();

      // Duplicate id: an identical re-registration is an idempotent no-op
      // (the existing service is returned, nothing is rewritten); the same
      // id with different content is a conflict, never a silent overwrite.
      const existing = store.get(id);
      if (existing) {
        if (serviceInputMatches(existing, input)) return { ok: true, service: existing };
        return { ok: false, errors: [`service id ${id} already exists with different content`] };
      }

      const now = new Date().toISOString();
      const service: ServiceRecord = {
        id,
        name: (input.name as string).trim(),
        description: (input.description as string).trim(),
        category: input.category as ServiceCategory,
        endpoint: input.endpoint as string,
        provider: {
          tokenId: input.provider.tokenId,
          ownerAccount: input.provider.ownerAccount,
          agentUri: input.provider.agentUri,
        },
        network: input.network,
        pricing: {
          amountMicroCcd: input.pricing.amountMicroCcd,
          asset: 'CCD',
          payTo: input.pricing.payTo,
          ...(input.pricing.maxTimeoutSeconds !== undefined
            ? { maxTimeoutSeconds: input.pricing.maxTimeoutSeconds }
            : {}),
          ...(input.pricing.description !== undefined
            ? { description: input.pricing.description }
            : {}),
        },
        // Always 'inactive'. A service is not discoverable or payable
        // until its provider is verified TRUSTED and it is activated
        // through `setStatus` (see the activation policy in the module
        // header). The registration input carries no status field, so
        // there is no value that could smuggle an active service in.
        status: 'inactive',
        // Registered, NOT verified. Trust is earned by a verification run.
        providerVerification: { status: 'registered', reason: 'registered; provider verification has not run yet' },
        registeredAt: now,
      };
      let inserted: { ok: true } | { ok: false; reason: string };
      try {
        inserted = store.insert(service);
      } catch (e) {
        // Storage failure (read-only file, full disk, I/O error): fail closed.
        // No service is created, and the caller is told exactly why.
        return { ok: false, errors: [`storage failure: ${(e as Error).message}`] };
      }
      if (!inserted.ok) {
        // A concurrent writer inserted the id between our get and our insert.
        // Re-read: identical content is still an idempotent hit.
        const raced = store.get(id);
        if (raced && serviceInputMatches(raced, input)) return { ok: true, service: raced };
        return { ok: false, errors: [`service id ${id} already exists with different content`] };
      }
      audit(actor, 'register', id, `registered '${service.name}' (${service.category}, ${service.pricing.amountMicroCcd} microCCD)`);
      return { ok: true, service };
    },

    get(id) {
      return store.get(id);
    },

    list(filters = {}) {
      const status = filters.status ?? 'active';
      if (status !== 'active' && status !== 'inactive' && status !== 'all') {
        throw new Error("status filter must be 'active', 'inactive', or 'all'");
      }
      if (filters.category !== undefined && !(SERVICE_CATEGORIES as readonly string[]).includes(filters.category)) {
        throw new Error(`category filter must be one of ${SERVICE_CATEGORIES.join(', ')}`);
      }
      if (filters.network !== undefined && filters.network !== DISCOVERY_NETWORK) {
        throw new Error(`network filter must be ${DISCOVERY_NETWORK} (Concordium Testnet only)`);
      }
      const limit = filters.limit ?? DEFAULT_LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new Error(`limit must be an integer 1..${MAX_LIST_LIMIT}`);
      }
      const q = filters.q?.trim().toLowerCase() ?? '';
      const out: ServiceRecord[] = [];
      for (const s of store.listAll()) {
        // The status filter is the EFFECTIVE (discoverable) status, not
        // the stored status: 'active' means discoverable (stored 'active'
        // AND provider verified TRUSTED); 'inactive' means not
        // discoverable. A legacy row stored 'active' but unverified is
        // excluded from the active list and appears under 'inactive'.
        if (status !== 'all') {
          const discoverable = isDiscoverable(s);
          if (status === 'active' && !discoverable) continue;
          if (status === 'inactive' && discoverable) continue;
        }
        if (filters.category !== undefined && s.category !== filters.category) continue;
        if (filters.network !== undefined && s.network !== filters.network) continue;
        if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))) continue;
        out.push(s);
      }
      const total = out.length;
      return { services: out.slice(0, limit), total };
    },

    setStatus(id, status, opts = {}) {
      const actor = opts.actor ?? 'operator';
      const s = store.get(id);
      if (!s) return { ok: false as const, error: `service not found: ${id}` };
      if (status === 'active') {
        // Activation is the guarded transition: only a provider whose
        // verification is TRUSTED may become active. Anything else —
        // 'registered' (never verified), 'unverified' (INCONCLUSIVE),
        // 'rejected' — is refused. The refusal is fail-closed and
        // self-correcting: if the service is somehow active without
        // valid verification (a pre-policy row), the attempt
        // deactivates it instead of leaving it active, and the audit
        // row records the refusal.
        if (s.providerVerification.status !== 'verified') {
          const v = s.providerVerification.status;
          if (s.status === 'active') {
            s.status = 'inactive';
            try {
              store.update(s);
            } catch {
              return { ok: false as const, error: `cannot activate ${id}: provider verification is ${v} (not TRUSTED) — and the service could not be deactivated (storage failure)` };
            }
            audit(actor, 'activate', id, `activation refused: provider verification is ${v} (not TRUSTED) — service deactivated`);
            return { ok: false as const, error: `cannot activate ${id}: provider verification is ${v} (not TRUSTED) — service deactivated` };
          }
          audit(actor, 'activate', id, `activation refused: provider verification is ${v} (not TRUSTED)`);
          return { ok: false as const, error: `cannot activate ${id}: provider verification is ${v} (not TRUSTED)` };
        }
        if (s.status === 'active') return { ok: true as const, service: s }; // already active: no-op
      } else {
        // Deactivation is always allowed (fail-closed direction).
        if (s.status === 'inactive') return { ok: true as const, service: s }; // already inactive: no-op
      }
      s.status = status;
      try {
        store.update(s);
      } catch {
        return { ok: false as const, error: `storage failure while setting status for ${id}` };
      }
      audit(actor, status === 'active' ? 'activate' : 'deactivate', id, `status → ${status}`);
      return { ok: true as const, service: s };
    },

    async verifyProvider(id, verifier, opts = {}) {
      const actor = opts.actor ?? 'operator';
      const s = store.get(id);
      if (!s) return { ok: false, error: 'service not found' };
      const persist = (detail: string): { ok: true; service: ServiceRecord } | { ok: false; error: string } => {
        // If verification stopped being TRUSTED and the service is
        // active, deactivate it now: an active service must always be
        // verified. This only fires when a previously-verified service
        // is re-verified and comes back REJECTED/INCONCLUSIVE (or had
        // no card) — the invariant "active ⟹ verified" is restored at
        // the moment the evidence changes, not at the next activation
        // attempt.
        let deactivated = false;
        if (s.providerVerification.status !== 'verified' && s.status === 'active') {
          s.status = 'inactive';
          deactivated = true;
        }
        try {
          store.update(s);
        } catch (e) {
          // L2: a persistence failure must NOT be reported as success.
          // The in-memory `s` carries the new verification state, but
          // the durable state is unchanged — reporting `{ok: true}`
          // here would present a result that was never saved as a
          // persisted fact (and would make the audit diverge from the
          // database). Fail closed, like `register` and `setStatus`
          // do on a storage failure. The audit row records the
          // failure itself (best-effort), never a success.
          audit(actor, 'verify', id, `${detail} — PERSISTENCE FAILED: ${(e as Error).message}`);
          return { ok: false, error: `verification result could not be saved: ${(e as Error).message}` };
        }
        audit(actor, 'verify', id, deactivated ? `${detail} — service deactivated (verification no longer TRUSTED)` : detail);
        return { ok: true, service: s };
      };
      if (s.provider.agentUri === null) {
        // No card to verify against. This is missing evidence, not a
        // contradiction — the provider stays unverified, never verified.
        s.providerVerification = {
          status: 'unverified',
          decision: 'INCONCLUSIVE',
          checkedAt: new Date().toISOString(),
          reason: 'provider has no agentUri: no Agent Card to verify against',
        };
        return persist('verification: unverified (no agentUri)');
      }
      let result: { decision: 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE'; reason?: string };
      try {
        result = await verifier(s.provider);
      } catch (e) {
        s.providerVerification = {
          status: 'unverified',
          decision: 'INCONCLUSIVE',
          checkedAt: new Date().toISOString(),
          reason: `verification could not run: ${(e as Error).message}`,
        };
        return persist('verification: unverified (verifier error)');
      }
      const checkedAt = new Date().toISOString();
      if (result.decision === 'TRUSTED') {
        s.providerVerification = {
          status: 'verified',
          decision: 'TRUSTED',
          checkedAt,
          reason: result.reason ?? 'provider Agent Card passed full verification (TRUSTED)',
        };
        return persist('verification: verified (TRUSTED)');
      }
      if (result.decision === 'REJECTED') {
        s.providerVerification = {
          status: 'rejected',
          decision: 'REJECTED',
          checkedAt,
          reason: result.reason ?? 'provider identity was contradicted by verification',
        };
        return persist('verification: rejected (REJECTED)');
      }
      s.providerVerification = {
        status: 'unverified',
        decision: 'INCONCLUSIVE',
        checkedAt,
        reason: result.reason ?? 'verification evidence could not be established',
      };
      return persist('verification: unverified (INCONCLUSIVE)');
    },

    auditLog(serviceId) {
      return store.auditLog(serviceId);
    },

    size() {
      return store.listAll().length;
    },

    close() {
      store.close();
    },
  };
}

// ─── payment requirements for a service ───────────────────────────────────

/**
 * Build the x402 `PaymentRequirements` an agent reads *before* paying for
 * this service. Uses the service's own pricing and its endpoint as the
 * resource URL, so the requirement the agent sees is the requirement the
 * service actually enforces.
 *
 * `extra.feePayer` is deliberately ABSENT: the sponsor is a property of the
 * facilitator (announced via its `/supported`), not of the service. A
 * discovery response must never invent a fee payer.
 */
export function buildServicePaymentRequirements(
  service: ServiceRecord,
  resourceUrl?: string,
): PaymentRequirements {
  return buildPaymentRequirements({
    payTo: service.pricing.payTo,
    amountMicroCcd: service.pricing.amountMicroCcd,
    maxTimeoutSeconds: service.pricing.maxTimeoutSeconds ?? 300,
    ...(service.pricing.description ? { description: service.pricing.description } : {}),
    resourceUrl: resourceUrl ?? service.endpoint,
    network: service.network,
  });
}

/**
 * The shape a discovering agent receives for one service.
 *
 * `paymentRequirements` is present only for ACTIVE services: an inactive
 * service still shows its price (a fact), but it is not payable, so no
 * requirement is offered. `available` is the same fact in one boolean.
 */
export function toServiceView(service: ServiceRecord): Record<string, unknown> {
  // The Discovery invariant, applied at the projection layer: a service
  // is presented as active, available, and payable ONLY when it is
  // stored 'active' AND its provider verification is TRUSTED. A legacy
  // row that is stored 'active' but unverified is projected as
  // 'inactive' with `available: false` and no `paymentRequirements` —
  // it is never revealed as an active service. The stored record is
  // never changed here; only the projection is fail-closed.
  const discoverable = isDiscoverable(service);
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    endpoint: service.endpoint,
    provider: {
      tokenId: service.provider.tokenId,
      ownerAccount: service.provider.ownerAccount,
      agentUri: service.provider.agentUri,
    },
    network: service.network,
    pricing: {
      amountMicroCcd: service.pricing.amountMicroCcd,
      asset: service.pricing.asset,
      payTo: service.pricing.payTo,
      maxTimeoutSeconds: service.pricing.maxTimeoutSeconds ?? 300,
      ...(service.pricing.description ? { description: service.pricing.description } : {}),
    },
    // The public status is the EFFECTIVE (discoverable) status, not the
    // stored status: a legacy row stored 'active' but unverified is
    // shown as 'inactive'. The stored status is unchanged in the
    // database; only this projection hides it from Discovery.
    status: discoverable ? 'active' : 'inactive',
    available: discoverable,
    providerVerification: { ...service.providerVerification },
    registeredAt: service.registeredAt,
    ...(discoverable ? { paymentRequirements: buildServicePaymentRequirements(service) } : {}),
  };
}

/**
 * The Discovery invariant: a service is discoverable (listed as active,
 * retrievable as active, payable) ONLY when it is stored 'active' AND
 * its provider verification is TRUSTED. Every Discovery response —
 * list, detail, CLI output — is projected through `toServiceView`,
 * which applies this predicate, so a stored row that violates the
 * invariant (a legacy pre-policy row) can never appear as an active
 * service. This function never changes the stored record.
 */
export function isDiscoverable(service: ServiceRecord): boolean {
  // Optional chaining: a stored row whose verification evidence is
  // missing or null is NOT discoverable (fail-closed), and it must not
  // throw. Only a present, TRUSTED verification counts.
  return service.status === 'active' && service.providerVerification?.status === 'verified';
}
