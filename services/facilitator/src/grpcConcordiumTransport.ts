/**
 * Concrete Concordium gRPC transport for the adapter.
 *
 * Wraps the installed SDK's `GRPCClient` behind the `ConcordiumTransactionTransport`
 * interface. The transport is injected with a client (real or fake); it never
 * constructs one itself, and it never signs, holds keys, or activates settlement.
 *
 * SDK evidence (installed `@concordium/web-sdk` 12.0.2):
 *   - `GRPCClient.sendAccountTransaction(transaction, signature): Promise<TransactionHash.Type>`
 *     (`lib/esm/grpc/GRPCClient.d.ts:191`)
 *   - `GRPCClient.getBlockItemStatus(hash): Promise<BlockItemStatus>`
 *     (`GRPCClient.d.ts:94`; expects `TransactionHash.Type`, not a raw string)
 *   - `GRPCClient.waitForTransactionFinalization(hash, timeoutTime?): Promise<BlockItemSummaryInBlock>`
 *     (`GRPCClient.d.ts:302`)
 *   - `TransactionHash.Type` is a class instance; `toString()` / `TransactionHash.toHexString`
 *     produce the 64-hex form.
 *   - `BlockItemStatus` = `PendingBlockItem | CommittedBlockItem | FinalizedBlockItem`
 *     (`types/blockItemSummary.d.ts`).
 *   - `isRejectTransaction` / `getTransactionRejectReason` (`types/blockItemSummary.d.ts`).
 *
 * Safest finalization API: `getBlockItemStatus`. It returns an explicit status union and
 * does not throw on a non-finalized transaction, so pending/committed can be distinguished
 * from an RPC failure. `waitForTransactionFinalization` conflates a timeout with an RPC
 * error and is therefore not used here.
 *
 * Fake GRPCClient only in tests. No live RPC is contacted by any test in this suite.
 */

import { Transaction, TransactionHash, isRejectTransaction, getTransactionRejectReason } from '@concordium/web-sdk';
import type { BlockItemStatus } from '@concordium/web-sdk';
import type { ConcordiumTransactionTransport, TransportStatus } from './concordiumTransactionSubmitter.js';

/**
 * Minimal shape of the SDK client this transport depends on. The real client is
 * `ConcordiumGRPCNodeClient` / `ConcordiumGRPCWebClient`; tests inject a fake.
 */
export interface ConcordiumGrpcClientLike {
  /**
   * V1 submission path (preferred). Accepts a finalized transaction (V0 or V1)
   * and returns a `TransactionHash.Type` (or hex string). This is the only path
   * that can submit a V1 sponsored transaction.
   */
  sendTransaction?(transaction: unknown): Promise<unknown>;
  /**
   * Deprecated V0-only path. Retained as a compatibility seam for fakes
   * and legacy clients; production V1 sponsored submission must not use it.
   */
  sendAccountTransaction?(transaction: unknown, signature: unknown): Promise<unknown>;
  getBlockItemStatus(hash: unknown): Promise<BlockItemStatus>;
  waitForTransactionFinalization?(hash: unknown, timeoutMs?: number): Promise<unknown>;
}

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** Normalize a `TransactionHash.Type`, hex string, or JSON string to 64-hex. */
function toHex(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return String((value as { toHexString: () => string }).toHexString());
    }
    if (typeof (value as { toString?: unknown }).toString === 'function') {
      return String(value);
    }
  }
  return String(value);
}

/** Preserve a rejection reason verbatim, without inventing structure. */
function rejectReasonToText(reason: unknown): string {
  if (reason === null || reason === undefined) {
    return 'rejected (no reason supplied)';
  }
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object') {
    const tag = (reason as { tag?: unknown }).tag;
    if (tag !== undefined && tag !== null) return String(tag);
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
  return String(reason);
}

export class GrpcConcordiumTransport implements ConcordiumTransactionTransport {
  private readonly client: ConcordiumGrpcClientLike;

  constructor(client: ConcordiumGrpcClientLike) {
    if (
      !client ||
      typeof client.getBlockItemStatus !== 'function' ||
      (typeof client.sendTransaction !== 'function' &&
        typeof client.sendAccountTransaction !== 'function')
    ) {
      throw new Error(
        'GrpcConcordiumTransport requires a client with sendTransaction() (or legacy sendAccountTransaction()) and getBlockItemStatus()',
      );
    }
    this.client = client;
  }

  async submit(signedTx: unknown): Promise<string> {
    // Convert the signed pipeline JSON into the SDK's signable form.
    let signable: unknown;
    try {
      signable = Transaction.signableFromJSON(signedTx);
    } catch (e) {
      throw new Error(`malformed signed transaction: ${(e as Error)?.message ?? e}`);
    }
    const version = (signable as { version?: unknown }).version;
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported transaction version: ${String(version)}`);
    }

    // V1 sponsored transactions must use `finalize` + `sendTransaction`; the
    // deprecated V0-only `sendAccountTransaction` cannot carry a sponsor signature.
    let finalized: unknown;
    try {
      finalized = Transaction.finalize(signable as never);
    } catch (e) {
      throw new Error(`cannot finalize transaction: ${(e as Error)?.message ?? e}`);
    }

    let hash: unknown;
    try {
      if (typeof this.client.sendTransaction === 'function') {
        hash = await this.client.sendTransaction(finalized);
      } else {
        // Compatibility seam for legacy V0 fakes. Production clients always
        // expose `sendTransaction`, which is the SDK-supported V1 path.
        const accountTransaction = Transaction.toLegacyAccountTransaction(signable as never);
        const signature =
          version === 0
            ? (signable as { signature?: unknown }).signature
            : (signable as { signatures?: { sender?: unknown } }).signatures?.sender;
        if (signature === undefined || signature === null) {
          throw new Error('cannot submit transaction: missing signature');
        }
        hash = await this.client.sendAccountTransaction?.(accountTransaction, signature);
      }
    } catch (e) {
      throw new Error(`submission rejected: ${(e as Error)?.message ?? String(e)}`);
    }
    const hex = toHex(hash);
    if (!TX_HASH_RE.test(hex)) {
      throw new Error(`submission returned an invalid transaction hash: ${String(hash)}`);
    }
    return hex.toLowerCase();
  }

  async getStatus(hash: string): Promise<TransportStatus> {
    // The real SDK client expects a TransactionHash.Type, not a raw hex string.
    let hashArg: unknown = hash;
    try {
      hashArg = TransactionHash.fromHexString(hash);
    } catch {
      // Fail closed: an unparseable hash is never sent to the client.
      throw new Error(`invalid transaction hash: ${String(hash)}`);
    }

    let status: BlockItemStatus;
    try {
      status = await this.client.getBlockItemStatus(hashArg);
    } catch (e) {
      throw new Error(`status lookup failed: ${(e as Error)?.message ?? String(e)}`);
    }
    if (!status || typeof status !== 'object') {
      throw new Error('malformed BlockItemStatus response: not an object');
    }
    const s = status as { status?: unknown; outcome?: unknown };
    if (typeof s.status !== 'string') {
      throw new Error('malformed BlockItemStatus response: missing status');
    }

    switch (s.status) {
      case 'received':
        return { status: 'pending' };
      case 'committed':
        // Committed is NOT finalized; keep polling.
        return { status: 'pending' };
      case 'finalized': {
        const outcome = s.outcome;
        if (!outcome || typeof outcome !== 'object') {
          throw new Error('malformed BlockItemStatus response: missing outcome');
        }
        const o = outcome as { summary?: unknown; blockHash?: unknown };
        const summary = o.summary;
        if (!summary || typeof summary !== 'object') {
          throw new Error('malformed BlockItemStatus response: missing summary');
        }
        if (isRejectTransaction(summary as never)) {
          const reason = getTransactionRejectReason(summary as never);
          return { status: 'rejected', reason: rejectReasonToText(reason) };
        }
        return {
          status: 'finalized',
          ...(o.blockHash !== undefined ? { blockHash: toHex(o.blockHash) } : {}),
        };
      }
      default:
        throw new Error(`unrecognized BlockItemStatus: ${String(s.status)}`);
    }
  }
}