/**
 * Concordium transaction submission & finalization adapter.
 *
 * A focused, dependency-injected adapter that wraps the Concordium SDK's submission
 * and finalization primitives behind a normalized interface. It does NOT sign, does
 * NOT hold keys, and does NOT broadcast by itself: all chain contact goes through the
 * injected transport, so tests can substitute a deterministic mock.
 *
 * The SDK surfaces this adapter wraps (verified against the installed package):
 *   - GRPCClient.sendAccountTransaction(transaction, signature): Promise<TransactionHash.Type>
 *     (`@concordium/web-sdk/lib/esm/grpc/GRPCClient.d.ts:191`)
 *   - GRPCClient.getBlockItemStatus(hash): Promise<BlockItemStatus>
 *     (`GRPCClient.d.ts:94`; the union is defined in `types/blockItemSummary.d.ts`)
 *   - GRPCClient.waitForTransactionFinalization(hash, timeoutMs?): Promise<BlockItemSummaryInBlock>
 *     (`GRPCClient.d.ts:302`)
 */

/** Outcome of the submission call itself. `accepted` means the transport returned a hash. */
export type SubmissionStatus = 'accepted';

import { SubmissionError } from './submissionErrors.js';

export interface SubmissionResult {
  hash: string;
  status: SubmissionStatus;
}

/** Normalized finalization outcome. There is no ambiguous "maybe success". */
export type FinalizationStatus =
  | 'pending'
  | 'finalized'
  | 'rejected'
  | 'timeout'
  | 'transport_error';

export interface FinalizationResult {
  hash: string;
  status: FinalizationStatus;
  /** SDK reject reason, transport error message, or `cancelled` for an aborted wait. */
  reason?: string;
  /** Present only when status is 'finalized'. Never set on a failure path. */
  blockHash?: string;
}

/** What a transport must provide. The real implementation wraps `GRPCClient`. */
export interface ConcordiumTransactionTransport {
  /**
   * Submit an already-signed transaction. Returns the 64-hex transaction hash.
   * MUST throw when the node rejects the submission or the transport fails — never
   * return a hash that the node did not acknowledge.
   *
   * Throws a `SubmissionError`: `validation` for a LOCAL failure before any
   * broadcast (malformed transaction, finalize error), `transport` for a
   * failure during/after the node call (node rejection, network error).
   * `opts.correlationId` is attached to the error for tracing; it is never a secret.
   */
  submit(signedTx: unknown, opts?: { correlationId?: string }): Promise<string>;
  /**
   * Read the current status of a submitted transaction.
   * `pending` covers both `Received` and `Committed` (committed is not final).
   */
  getStatus(hash: string): Promise<TransportStatus>;
}

export interface TransportStatus {
  status: 'pending' | 'finalized' | 'rejected';
  /** SDK reject reason, preserved verbatim where available. */
  reason?: string;
  /** Block hash, present for a finalized outcome. */
  blockHash?: string;
}

export interface SubmitOptions {
  /** Abort a submission in flight. */
  signal?: AbortSignal;
  /**
   * Correlation id for tracing (payment digest / request id). Attached to
   * any `SubmissionError`; never a secret. Optional.
   */
  correlationId?: string;
}

export interface FinalizationOptions {
  /** Overall bound on the wait. Default 30_000 ms. There is no unbounded mode. */
  timeoutMs?: number;
  /** Poll interval. Default 250 ms. */
  intervalMs?: number;
  /** Cancellation. An aborted signal resolves as `timeout` with reason `cancelled`. */
  signal?: AbortSignal;
}

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Submission + finalization adapter.
 *
 * The adapter is deliberately ignorant of signing: it accepts whatever the pipeline
 * already produced (a fully-signed V1 transaction) and requires a non-empty sponsor
 * signature so an unsigned transaction can never reach the transport.
 */
export class ConcordiumTransactionSubmitter {
  private readonly transport: ConcordiumTransactionTransport;

  constructor(transport: ConcordiumTransactionTransport) {
    if (
      !transport ||
      typeof transport.submit !== 'function' ||
      typeof transport.getStatus !== 'function'
    ) {
      throw new Error(
        'ConcordiumTransactionSubmitter requires a transport with submit() and getStatus()',
      );
    }
    this.transport = transport;
  }

  /** Structural validation. Returns an error message, or null when acceptable. */
  private static validate(signedTx: unknown): string | null {
    if (typeof signedTx !== 'object' || signedTx === null || Array.isArray(signedTx)) {
      return 'transaction must be a JSON object';
    }
    const t = signedTx as Record<string, unknown>;
    if (t['version'] !== 1) return 'only V1 sponsored transactions are supported';
    const header = t['header'];
    if (typeof header !== 'object' || header === null) return 'header is required';
    const payload = t['payload'];
    if (typeof payload !== 'object' || payload === null) return 'payload is required';
    const sigs = t['signatures'];
    if (typeof sigs !== 'object' || sigs === null) return 'signatures is required';
    const sender = (sigs as Record<string, unknown>)['sender'];
    const sponsor = (sigs as Record<string, unknown>)['sponsor'];
    if (typeof sender !== 'object' || sender === null) return 'signatures.sender is required';
    if (typeof sponsor !== 'object' || sponsor === null) return 'signatures.sponsor is required';
    if (Object.keys(sponsor as Record<string, unknown>).length === 0) {
      return 'a sponsor signature is required before submission';
    }
    return null;
  }

  /**
   * Submit a signed transaction.
   *
   * Never reports success unless the transport returned a well-formed hash. Malformed
   * input throws before the transport is touched.
   *
   * Throws a `SubmissionError`: `validation` for a LOCAL failure (nothing was
   * broadcast — terminal), `transport` for a failure during/after the node
   * call (outcome unknown — reconcile by hash, never retry blindly).
   * `opts.correlationId` is attached to the error for tracing.
   */
  async submit(signedTx: unknown, opts: SubmitOptions = {}): Promise<SubmissionResult> {
    const correlationId = opts.correlationId;
    const invalid = ConcordiumTransactionSubmitter.validate(signedTx);
    if (invalid !== null) {
      throw new SubmissionError('validation', `malformed transaction: ${invalid}`, correlationId);
    }
    if (opts.signal?.aborted) {
      throw new SubmissionError('validation', 'submission cancelled before it was attempted', correlationId);
    }
    let hash: unknown;
    try {
      hash = await this.transport.submit(signedTx, { correlationId });
    } catch (e) {
      // Preserve a typed error unchanged (kind + correlation id intact).
      // A non-typed error from the transport is a transport failure: the
      // submitter called the transport, so the node may have been reached.
      if (e instanceof SubmissionError) throw e;
      throw new SubmissionError(
        'transport',
        `submission rejected: ${(e as Error)?.message ?? String(e)}`,
        correlationId,
      );
    }
    if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) {
      // The send happened but the reply is not a usable hash: outcome UNKNOWN.
      throw new SubmissionError(
        'transport',
        `submission returned an invalid transaction hash: ${String(hash)}`,
        correlationId,
      );
    }
    return { hash: hash.toLowerCase(), status: 'accepted' };
  }

  /**
   * Wait for a submitted transaction to reach a terminal state.
   *
   * Bounded by `timeoutMs`; poll interval is clamped so the loop cannot spin. A
   * `pending`/unknown answer is never upgraded to success.
   */
  async awaitFinalization(
    hash: string,
    opts: FinalizationOptions = {},
  ): Promise<FinalizationResult> {
    if (typeof hash !== 'string' || !TX_HASH_RE.test(hash)) {
      throw new Error('awaitFinalization requires a 64-hex transaction hash');
    }
    const normalizedHash = hash.toLowerCase();
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = Math.max(1, opts.intervalMs ?? 250);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
    const signal = opts.signal;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (signal?.aborted) {
        return { hash: normalizedHash, status: 'timeout', reason: 'cancelled' };
      }
      let observed: TransportStatus;
      try {
        observed = await this.transport.getStatus(normalizedHash);
      } catch (e) {
        return {
          hash: normalizedHash,
          status: 'transport_error',
          reason: (e as Error)?.message ?? String(e),
        };
      }
      // Fail closed on anything unrecognized: an unknown status is NOT success.
      const status = observed?.status;
      if (status === 'finalized') {
        return {
          hash: normalizedHash,
          status: 'finalized',
          ...(observed.blockHash !== undefined ? { blockHash: observed.blockHash } : {}),
        };
      }
      if (status === 'rejected') {
        return {
          hash: normalizedHash,
          status: 'rejected',
          reason: observed.reason ?? 'rejected (no reason supplied)',
        };
      }
      if (status !== 'pending') {
        return {
          hash: normalizedHash,
          status: 'transport_error',
          reason: `unrecognized finalization status: ${String(status)}`,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { hash: normalizedHash, status: 'timeout', reason: 'finalization timeout' };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    }
  }
}
