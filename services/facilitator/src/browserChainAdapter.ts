/** Read-only chain adapter for the browser bridge, built on the facilitator's
 *  existing gRPC node client and the hash-binding mapStatus helper.
 *
 *  Finality is trusted only when `mapStatus` confirms a finalized outcome whose
 *  summary names the requested hash. Transfer fields are read from the NODE
 *  response, never from the browser-supplied transaction, so the bridge's
 *  field comparison is an independent check.
 */
import { TransactionHash } from '@concordium/web-sdk/types';
import { mapStatus } from './concordiumEvidence.js';
import type { BrowserChainVerifier } from './browserBridge.js';

interface StatusClient { getBlockItemStatus(hash: unknown): Promise<unknown> }


/** Normalize an SDK address value (string or AccountAddress-like object) to base58, or null. */
function addressString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = String(value);
    return text.length > 0 && text !== '[object Object]' ? text : null;
  }
  return null;
}


/** Normalize a node block hash (hex string or SDK Buffer-backed object) to lowercase hex, or null. */
function hashString(value: unknown): string | null {
  const is64hex = (t: string) => /^[0-9a-f]{64}$/.test(t);
  if (typeof value === 'string') {
    const t = value.toLowerCase();
    return is64hex(t) ? t : null;
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.toString('hex');
    return is64hex(hex) ? hex : null;
  }
  if (value && typeof value === 'object' && 'buffer' in value) {
    try {
      const b = value as { buffer: Uint8Array | ArrayBuffer; byteOffset?: number; byteLength?: number };
      const bytes = b.buffer instanceof Uint8Array
        ? b.buffer
        : new Uint8Array(b.buffer, b.byteOffset ?? 0, b.byteLength ?? (b.buffer as ArrayBuffer).byteLength);
      const hex = Buffer.from(bytes).toString('hex');
      return is64hex(hex) ? hex : null;
    } catch {
      return null;
    }
  }
  return null;
}


/** Normalize an SDK transfer amount (CcdAmount object, bigint, or decimal string) to micro-CCD string, or null. */
function amountString(value: unknown): string | null {
  if (typeof value === 'string') return /^[0-9]+$/.test(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && 'microCcdAmount' in value) {
    const micro = (value as { microCcdAmount?: unknown }).microCcdAmount;
    if (typeof micro === 'bigint' || typeof micro === 'number') return String(micro);
    if (typeof micro === 'string' && /^[0-9]+$/.test(micro)) return micro;
  }
  return null;
}

export function createBrowserChainVerifier(client: StatusClient, network: string): BrowserChainVerifier {
  return {
    async readTransfer(txHash: string) {
      let raw: unknown;
      try {
        raw = await client.getBlockItemStatus(TransactionHash.fromHexString(txHash));
      } catch { return null; }
      const mapped = mapStatus(raw, txHash.toLowerCase(), 'grpc-browser');
      if (!mapped.available) return null;
      const outcome = (raw as { outcome?: { blockHash?: unknown; summary?: Record<string, unknown> } }).outcome;
      const summary = outcome?.summary;
      if (!summary) return null;
      const transfer = (summary['transfer'] ?? summary['transferWithMemo'] ?? {}) as Record<string, unknown>;
      const sponsor = (summary['sponsor'] ?? {}) as Record<string, unknown>;
      // SDK 12.0.2 returns addresses as AccountAddress objects (not strings).
      // String(AccountAddress) yields the canonical base58 form; missing or
      // non-address values stay null so the caller fails closed.
      const sender = addressString(summary['sender'] ?? transfer['sender']);
      const recipient = addressString(transfer['to'] ?? transfer['toAddress'] ?? summary['to']);
      const amount = amountString(transfer['amount']);
      const sponsorAddress = addressString(sponsor['sponsor'] ?? sponsor['account']);
      if (sender === null || recipient === null || amount === null || sponsorAddress === null) return null;
      const blockHash = hashString(outcome?.blockHash);
      // A finalized observation must carry a verifiable block hash.
      if (mapped.observed === 'finalized' && blockHash === null) return null;
      return {
        status: mapped.observed === 'finalized' ? 'finalized' : mapped.observed === 'pending' || mapped.observed === 'committed' ? 'pending' : 'rejected',
        sender, sponsor: sponsorAddress, recipient, amount,
        network,
        failed: mapped.observed === 'failed' || summary['transactionType'] === 'failed',
        ...(blockHash ? { blockHash } : {}),
      };
    },
  };
}
