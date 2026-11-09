import type { PaymentRequirements } from '@x402/core/types';

/**
 * TASK 70 — reusable local HTTP x402 provider (resource server).
 *
 * Reuses the existing x402 protocol layer (`src/payments/x402.ts`) and treats the
 * facilitator as an untrusted accelerator: a payment is only honoured after the provider
 * independently verifies the finalized transaction on chain.
 *
 * Nothing here holds key material, constructs transactions, or submits anything.
 */

export interface ChainTransferSummary {
  status: 'finalized' | 'pending' | 'rejected' | 'unavailable';
  sender?: string;
  sponsor?: string;
  recipient?: string;
  amount?: string;
  network?: string;
  blockHash?: string;
  /** True when the chain reports the transaction as a failed/a rejected outcome. */
  failed?: boolean;
}

/** Independent on-chain reader. Injected so tests never touch a node. */
export interface ChainVerifier {
  /** Returns the finalized transfer summary, or a non-final status. Never throws. */
  readTransfer(txHash: string): Promise<ChainTransferSummary>;
}

export interface ProviderFacilitatorPort {
  verify(payload: unknown, requirements: PaymentRequirements): Promise<{ isValid?: boolean; invalidReason?: string }>;
  settle(payload: unknown, requirements: PaymentRequirements): Promise<{
    success?: boolean;
    transaction?: string;
    network?: string;
    errorReason?: string;
    errorMessage?: string;
  }>;
}

export interface ProviderConfig {
  /** Exact requirement this provider enforces. */
  requirements: PaymentRequirements;
  /** Resource URL bound into the 402 body and the payment binding check. */
  resourceUrl: string;
  /** Description surfaced in the 402 body. */
  description?: string;
  /** Body returned on a verified payment. */
  resource: unknown;
  /** Injectable clock (ms). */
  now?: () => number;
}

export interface ProviderDeps {
  facilitator: ProviderFacilitatorPort;
  chain: ChainVerifier;
}

export type ProviderOutcome =
  | { status: 402; body: unknown; reason: 'unpaid' | 'not_finalized' | 'chain_mismatch' | 'verify' | 'settle' | 'expired' }
  | { status: 400; body: unknown; reason: 'malformed' | 'binding' }
  | { status: 409; body: unknown; reason: 'replay' }
  | { status: 503; body: unknown; reason: 'verification_unavailable' }
  | { status: 200; body: unknown; reason: 'paid'; transaction: string };

/**
 * In-memory replay store.
 *
 * Two indexes: consumed transaction hashes and consumed request identifiers. Both are
 * checked and claimed synchronously before the resource is released, so two concurrent
 * redemptions of the same proof can never both succeed.
 */
export class ReplayStore {
  private readonly hashes = new Set<string>();
  private readonly requestIds = new Set<string>();

  /** Atomically claim a (requestId, txHash) pair. Returns false when either is already used. */
  claim(requestId: string, txHash: string): boolean {
    if (this.hashes.has(txHash) || this.requestIds.has(requestId)) return false;
    this.hashes.add(txHash);
    this.requestIds.add(requestId);
    return true;
  }

  hasHash(txHash: string): boolean {
    return this.hashes.has(txHash);
  }

  hasRequestId(requestId: string): boolean {
    return this.requestIds.has(requestId);
  }
}

export interface X402Provider {
  /** Build the 402 challenge body. */
  challenge(): unknown;
  /** Handle an unpaid request. */
  handleUnpaid(): ProviderOutcome;
  /** Handle a paid request carrying an `x-payment` JSON header value. */
  handlePayment(xPaymentHeader: string | undefined): Promise<ProviderOutcome>;
}

const MAX_REQUEST_ID_LEN = 128;

/**
 * Build a provider.
 *
 * Verification order (fail-closed at every step):
 *   1. header present and JSON
 *   2. local preflight (scheme/network/asset/amount/payTo/expiry)
 *   3. request binding (payload.resource.url === config.resourceUrl)
 *   4. facilitator verify
 *   5. facilitator settle
 *   6. independent on-chain read — must be finalized and match sender/sponsor/recipient/amount
 *   7. replay claim — a second redemption of the same hash or request id is refused
 */
export function createX402Provider(
  config: ProviderConfig,
  deps: ProviderDeps,
  opts: {
    /** Injectable preflight so the provider and the protocol layer cannot diverge. */
    preflight: (payload: unknown, requirements: PaymentRequirements, nowSeconds: number) => { ok: true } | { ok: false; reason: string };
    /** Build the 402 body. */
    buildRequired: (requirements: PaymentRequirements, cfg: { resourceUrl: string; description?: string }) => unknown;
    /** Sender the payment must come from, when the caller wants to pin one. */
    expectSender?: string;
    /** Sponsor the payment must be sponsored by, when the caller wants to pin one. */
    expectSponsor?: string;
    replayStore?: ReplayStore;
  },
): X402Provider {
  const now = config.now ?? (() => Date.now());
  const replay = opts.replayStore ?? new ReplayStore();
  const requirements = config.requirements;

  const challenge = (): unknown =>
    opts.buildRequired(requirements, {
      resourceUrl: config.resourceUrl,
      ...(config.description ? { description: config.description } : {}),
    });

  const handleUnpaid = (): ProviderOutcome => ({
    status: 402,
    body: challenge(),
    reason: 'unpaid',
  });

  const handlePayment = async (xPaymentHeader: string | undefined): Promise<ProviderOutcome> => {
    // 1. header
    if (typeof xPaymentHeader !== 'string' || xPaymentHeader.trim() === '') {
      return { status: 400, body: { error: 'missing X-PAYMENT header' }, reason: 'malformed' };
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(xPaymentHeader);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 400, body: { error: 'X-PAYMENT is not an object' }, reason: 'malformed' };
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: 'X-PAYMENT is not valid JSON' }, reason: 'malformed' };
    }

    // 2. preflight (includes expiry, amount, recipient, network, asset)
    const pre = opts.preflight(payload, requirements, Math.floor(now() / 1000));
    if (!pre.ok) {
      const expired = /expired/i.test(pre.reason);
      return {
        status: 402,
        body: { error: 'payment rejected', reason: pre.reason },
        reason: expired ? 'expired' : 'verify',
      };
    }

    // 3. request binding: the payment must be for THIS resource
    const resource = payload['resource'] as { url?: unknown } | undefined;
    if (!resource || typeof resource.url !== 'string' || resource.url !== config.resourceUrl) {
      return {
        status: 400,
        body: { error: 'payment is not bound to this resource', expected: config.resourceUrl },
        reason: 'binding',
      };
    }

    const requestId = payload['requestId'];
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LEN)) {
      return { status: 400, body: { error: 'invalid requestId' }, reason: 'malformed' };
    }

    // 4. facilitator verify
    let verify: { isValid?: boolean; invalidReason?: string };
    try {
      verify = await deps.facilitator.verify(payload, requirements);
    } catch {
      return { status: 503, body: { error: 'payment verification unavailable' }, reason: 'verification_unavailable' };
    }
    if (!verify?.isValid) {
      return { status: 402, body: { error: 'payment invalid', reason: verify?.invalidReason ?? 'unknown' }, reason: 'verify' };
    }

    // 5. facilitator settle (never retried)
    let settle: { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string };
    try {
      settle = await deps.facilitator.settle(payload, requirements);
    } catch {
      return { status: 503, body: { error: 'payment settlement unavailable' }, reason: 'verification_unavailable' };
    }
    // The facilitator may report a non-success status while still returning a hash
    // (e.g. its local hash disagrees with the node's). We never trust the status:
    // if a hash exists, independently verify it against the chain.
    if (typeof settle.transaction !== 'string' || settle.transaction === '') {
      return {
        status: 402,
        body: {
          error: 'settlement did not succeed',
          reason: settle?.errorReason ?? 'unknown',
          ...(typeof settle?.errorMessage === 'string' && settle.errorMessage ? { message: settle.errorMessage } : {}),
        },
        reason: 'settle',
      };
    }
    const txHash = settle.transaction;

    // replay pre-check (cheap) — the authoritative claim happens after chain verification
    if (replay.hasHash(txHash) || (typeof requestId === 'string' && replay.hasRequestId(requestId))) {
      return { status: 409, body: { error: 'payment already consumed' }, reason: 'replay' };
    }

    // 6. INDEPENDENT on-chain verification — the facilitator's word is not enough
    let chain: ChainTransferSummary;
    try {
      chain = await deps.chain.readTransfer(txHash);
    } catch {
      return { status: 503, body: { error: 'on-chain verification unavailable' }, reason: 'verification_unavailable' };
    }
    if (chain.status === 'unavailable') {
      return { status: 503, body: { error: 'on-chain verification unavailable' }, reason: 'verification_unavailable' };
    }
    if (chain.status !== 'finalized') {
      return { status: 402, body: { error: 'transaction not finalized', status: chain.status }, reason: 'not_finalized' };
    }
    if (chain.failed === true) {
      return { status: 402, body: { error: 'transaction rejected on chain' }, reason: 'chain_mismatch' };
    }
    if (chain.recipient !== requirements.payTo) {
      return { status: 402, body: { error: 'recipient mismatch' }, reason: 'chain_mismatch' };
    }
    if (String(chain.amount) !== String(requirements.amount)) {
      return { status: 402, body: { error: 'amount mismatch' }, reason: 'chain_mismatch' };
    }
    if (chain.network !== undefined && chain.network !== requirements.network) {
      return { status: 402, body: { error: 'network mismatch' }, reason: 'chain_mismatch' };
    }
    if (opts.expectSender !== undefined && chain.sender !== opts.expectSender) {
      return { status: 402, body: { error: 'sender mismatch' }, reason: 'chain_mismatch' };
    }
    if (opts.expectSponsor !== undefined && chain.sponsor !== opts.expectSponsor) {
      return { status: 402, body: { error: 'sponsor mismatch' }, reason: 'chain_mismatch' };
    }

    // 7. atomic replay claim — concurrent duplicate redemption loses here
    const rid = typeof requestId === 'string' ? requestId : `${config.resourceUrl}:${txHash}`;
    if (!replay.claim(rid, txHash)) {
      return { status: 409, body: { error: 'payment already consumed' }, reason: 'replay' };
    }

    return {
      status: 200,
      body: {
        resource: config.resource,
        payment: {
          transaction: txHash,
          blockHash: chain.blockHash ?? null,
          amount: requirements.amount,
          asset: requirements.asset,
          payTo: requirements.payTo,
          network: requirements.network,
        },
      },
      reason: 'paid',
      transaction: txHash,
    };
  };

  return { challenge, handleUnpaid, handlePayment };
}
