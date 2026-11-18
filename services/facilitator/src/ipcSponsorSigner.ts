/**
 * IPC-backed SponsorSigner for real mode.
 *
 * Composes the SDK sponsor adapter with the `IpcAccountSigner` so the
 * facilitator can obtain a sponsor signature from a dedicated signing service without ever
 * holding key material.
 *
 * What this DOES:
 *   - addSponsorSignature() → SDK `Transaction.sponsor()` → IPC `sign(digest)` → signature.
 *     Each call constructs a FRESH `IpcAccountSigner` bound to THAT transaction
 *     (protocol v2): the digest the SDK computes is checked against the bound
 *     transaction client-side, and the service re-verifies it from the parsed
 *     transaction before signing. A shared signer with a mutable bound transaction
 *     would be racy across concurrent settles, so there is none.
 *   - with an injected `ConcordiumTransactionSubmitter`, `submitTransaction()` and
 *     `waitForFinalization()` delegate to the adapter (V1 `finalize` + `sendTransaction`).
 *
 * What this does NOT do:
 *   - Without an injected submitter, `submitTransaction()` and `waitForFinalization()`
 *     throw: no broadcast, no finalization.
 *   - This module never constructs a gRPC client, a transport, or a private key.
 *   - The chain-query methods throw: they are only reachable through a settlement path
 *     that is disabled (`DENY_ALL_FACILITATOR` + settlement disabled by default).
 *
 * There is no local signing fallback. If the signing service is unreachable, the request
 * fails closed and no signature is produced.
 */

import { ConfigurationError } from './config.js';
import { createSdkSponsorSigner, isSignedTransactionWrapper } from './sdkSponsorSigner.js';
import { IpcAccountSigner } from './signingService.js';
import type { SponsorSigner, AddSponsorSignatureOptions } from './signer.js';
import { ConcordiumTransactionSubmitter } from './concordiumTransactionSubmitter.js';

export interface IpcSponsorSignerOptions {
  /** Sponsor account address (base58check). Public identifier, never a secret. */
  sponsorAddress: string;
  /** CAIP-2 network. */
  network: string;
  /** Unix socket path of the dedicated signing service. */
  socketPath: string;
  /** Expected signing-service UID (SO_PEERCRED, verified by the service). */
  expectedUid: number;
  /** Per-request timeout for IPC signing calls (ms). */
  timeoutMs?: number;
  /** Maximum execution energy the sponsor accepts. */
  maxEnergy: bigint;
  /** Maximum fee (microCCD) the sponsor accepts. */
  maxFeeMicroCcd: bigint;
  /** Clock. */
  now?: () => number;
  /**
   * Optional submission adapter. When provided, `submitTransaction` and
   * `waitForFinalization` delegate to the adapter (which wraps the V1 gRPC
   * transport). When omitted, both remain fail-closed: no broadcast, no finalization.
   * The caller constructs and injects this; the signer never constructs a transport.
   */
  submitter?: ConcordiumTransactionSubmitter;
}

/**
 * Build a `SponsorSigner` backed by the dedicated signing service.
 *
 * The returned object never holds key material: `addSponsorSignature` delegates the actual
 * signing to the IPC client, which delegates to the separate service process.
 */
export function createIpcSponsorSigner(opts: IpcSponsorSignerOptions): SponsorSigner {
  if (!opts.socketPath || !opts.socketPath.startsWith('/')) {
    throw new ConfigurationError('signing service socket must be an absolute path');
  }
  if (!Number.isInteger(opts.expectedUid) || opts.expectedUid < 1 || opts.expectedUid > 65533) {
    throw new ConfigurationError('signing service UID must be an integer between 1 and 65533');
  }

  // The shared adapter is used ONLY for `validateContext`, which never signs.
  // Its IpcAccountSigner has no transaction bound, so any signing attempt
  // through it fails closed client-side ("no transaction bound"). Signing goes
  // through a fresh per-call bound signer in `addSponsorSignature` below.
  const ipcSigner = new IpcAccountSigner({
    socketPath: opts.socketPath,
    expectedUid: opts.expectedUid,
    sponsorAddress: opts.sponsorAddress,
    network: opts.network,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const sdkSigner = createSdkSponsorSigner({
    sponsorAddress: opts.sponsorAddress,
    network: opts.network,
    accountSigner: ipcSigner,
    maxEnergy: opts.maxEnergy,
    maxFeeMicroCcd: opts.maxFeeMicroCcd,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const noSubmit = (what: string): never => {
    throw new ConfigurationError(
      `${what} is not available in IPC signing mode: this prototype signs only and never broadcasts`,
    );
  };

  /**
   * Submission at the signer boundary.
   *
   * DECISION: delegate, do not replace. `submitTransaction` remains the single
   * `SponsorSigner` submission seam that `FacilitatorCore.settle()` already calls at step 6
   * (after the durable hash is persisted and the broadcast claim is taken), so delegation
   * preserves the ordering and the existing authorization architecture. The
   * alternative — a second, narrower submission path owned by the signer — would have
   * duplicated the pipeline's hash and claim bookkeeping outside `FacilitatorCore`.
   *
   * The submitter is INJECTED. This module never builds a gRPC client or a transport, and
   * with no submitter injected both methods stay fail-closed.
   */
  const submitter = opts.submitter;

  const submitTransaction = async (txJson: unknown, opts?: { correlationId?: string }): Promise<string> => {
    if (!submitter) return noSubmit('submitTransaction');
    // Semantics: `submit` throws on a transport rejection and never returns a hash
    // the node did not acknowledge; the hash is already lower-cased 64-hex.
    // A typed `SubmissionError` propagates unchanged (kind + correlation id
    // intact) so the caller can distinguish a local validation failure
    // (terminal, nothing broadcast) from a transport failure (unknown outcome).
    const result = await submitter.submit(txJson, { correlationId: opts?.correlationId });
    return result.hash;
  };

  const waitForFinalization = async (
    txHash: string,
    timeoutMs?: number,
  ): Promise<{
    txHash: string;
    status: 'pending' | 'committed' | 'finalized' | 'failed';
    sender: string;
    simulated: boolean;
  }> => {
    if (!submitter) return noSubmit('waitForFinalization');
    const observed = await submitter.awaitFinalization(
      txHash,
      timeoutMs !== undefined ? { timeoutMs } : {},
    );
    // Outcome → SponsorSigner status. Lossy by necessity: the shared signer
    // contract has four values. Mapping is documented in docs/architecture.md.
    // `simulated: false`: this signer settles through the real IPC service and a
    // real submitter — a finalized outcome here is a chain outcome, not a mock.
    switch (observed.status) {
      case 'finalized':
        return { txHash, status: 'finalized', sender: opts.sponsorAddress, simulated: false };
      case 'rejected':
        // A finalized rejection is terminal and is reported as `failed`, which
        // FacilitatorCore reconciles as `transaction_failed`.
        return { txHash, status: 'failed', sender: opts.sponsorAddress, simulated: false };
      case 'timeout':
        // Includes `cancelled`. Not final; the caller must treat it as pending.
        return { txHash, status: 'pending', sender: opts.sponsorAddress, simulated: false };
      case 'transport_error':
        // Ambiguous: the outcome is genuinely unknown. Throwing keeps it distinguishable
        // from a bounded timeout; FacilitatorCore marks the payment pending, never success.
        throw new Error(
          `finalization transport error: ${observed.reason ?? 'unknown'} (hash ${txHash})`,
        );
      default:
        throw new Error(`unrecognized finalization status: ${String((observed as { status?: unknown }).status)}`);
    }
  };

  return {
    info: () => ({
      address: opts.sponsorAddress,
      network: opts.network,
      // canSign is true only in the sense that the *service* can sign. The facilitator
      // itself still holds no key material.
      canSign: true,
    }),
    addSponsorSignature: (txJson: unknown, callOpts?: AddSponsorSignatureOptions) => {
      // Per-call binding (protocol v3): a FRESH IpcAccountSigner bound to THIS
      // transaction AND to the Owner authorization certificate for it. The SDK
      // computes the digest from this transaction; the bound signer checks it
      // client-side and the service re-verifies it from the parsed transaction
      // before signing. No shared mutable binding exists, so concurrent
      // settles can never cross-bind.
      //
      // Bind the BARE transaction, not the x402 `{ signedTransaction }` wrapper:
      // the SDK adapter unwraps the wrapper before calling Transaction.sponsor,
      // so the digest is computed from the bare form. Binding the wrapper would
      // make the client-side digest check fail on every call.
      const bare = isSignedTransactionWrapper(txJson) ? txJson.signedTransaction : txJson;
      const bound = new IpcAccountSigner({
        socketPath: opts.socketPath,
        expectedUid: opts.expectedUid,
        sponsorAddress: opts.sponsorAddress,
        network: opts.network,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        transaction: bare,
        // the certificate + payment digest ride with the bound
        // signer. Without them the signer refuses client-side, and the
        // service would reject the request as `authorization_missing`.
        ...(callOpts?.authorization !== undefined ? { authorization: callOpts.authorization } : {}),
        ...(callOpts?.paymentDigest !== undefined ? { paymentDigest: callOpts.paymentDigest } : {}),
      });
      const boundSdk = createSdkSponsorSigner({
        sponsorAddress: opts.sponsorAddress,
        network: opts.network,
        accountSigner: bound,
        maxEnergy: opts.maxEnergy,
        maxFeeMicroCcd: opts.maxFeeMicroCcd,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      return boundSdk.addSponsorSignature(txJson);
    },
    validateContext: (ctx) => sdkSigner.validateContext(ctx),
    submitTransaction,
    waitForFinalization,
    // This signer settles through the real IPC service: its outcomes are real,
    // never simulated. FacilitatorCore reads this flag for `extra.simulated`.
    simulated: false,
    getAccountInfo: () => noSubmit('getAccountInfo'),
    getTokenBalance: () => noSubmit('getTokenBalance'),
    getTokenDecimals: () => noSubmit('getTokenDecimals'),
  };
}
