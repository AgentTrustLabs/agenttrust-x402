/**
 * Typed submission errors — the distinction that decides whether a failed
 * submission is terminal or genuinely ambiguous.
 *
 * A submission can fail in two places with opposite consequences:
 *
 *   - `validation`: a LOCAL failure before any broadcast (malformed
 *     transaction, missing sponsor signature, `signableFromJSON` /
 *     `finalize` error, invalid hash). Nothing reached the node, so the
 *     outcome is KNOWN: nothing was broadcast. This is terminal — the
 *     payment may be marked failed and the caller may fix and retry with a
 *     NEW transaction. It must NEVER be reported as `outcome_unknown`.
 *
 *   - `transport`: a failure DURING or AFTER the node call
 *     (`sendTransaction` threw: node rejection, network error, timeout).
 *     The node may or may not have received the transaction, so the
 *     outcome is genuinely UNKNOWN. This must be reported as pending and
 *     reconciled by hash — never retried blindly, never marked failed.
 *
 * Both kinds carry a `correlationId` (the payment digest / request id the
 * caller supplies) so a failure can be traced end-to-end, and a safe
 * diagnostic (kind + message + correlation id only). Error messages come
 * from the SDK / node / local validation and must never contain key
 * material; no secret is ever attached to these errors.
 */

/** Local failure before broadcast (terminal) vs node/transport failure (unknown outcome). */
export type SubmissionErrorKind = 'validation' | 'transport';

export class SubmissionError extends Error {
  readonly kind: SubmissionErrorKind;
  /** Caller-supplied correlation id (payment digest / request id). Never a secret. */
  readonly correlationId?: string;

  constructor(kind: SubmissionErrorKind, message: string, correlationId?: string) {
    super(message);
    this.name = 'SubmissionError';
    this.kind = kind;
    if (correlationId !== undefined) this.correlationId = correlationId;
  }

  /**
   * Safe diagnostic line for logs and API responses. Contains only the
   * kind, the message, and the correlation id — never key material.
   */
  toDiagnostic(): string {
    const corr = this.correlationId !== undefined ? ` correlation=${this.correlationId}` : '';
    return `submission ${this.kind}: ${this.message}${corr}`;
  }
}

/** Type guard: true when `e` is a `SubmissionError` (of either kind). */
export function isSubmissionError(e: unknown): e is SubmissionError {
  return e instanceof SubmissionError;
}

/** True only for a LOCAL validation failure — terminal, nothing broadcast. */
export function isSubmissionValidationError(e: unknown): e is SubmissionError {
  return e instanceof SubmissionError && e.kind === 'validation';
}

/** True only for a node/transport failure — outcome genuinely unknown. */
export function isSubmissionTransportError(e: unknown): e is SubmissionError {
  return e instanceof SubmissionError && e.kind === 'transport';
}
