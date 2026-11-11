/**
 * Real Concordium Testnet chain verifier for the x402 provider.
 *
 * Read-only: it only calls `getBlockItemStatus` on the configured Testnet node.
 * It never signs, submits, constructs transactions, or holds keys.
 *
 * Network identity is bound at construction (CAIP-2 + genesis hash); the verifier
 * refuses to start against an unknown network and `verifyNode()` rejects a node
 * whose genesis hash does not match. There is no silent fallback to mock data.
 */
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { TransactionHash } from '@concordium/web-sdk';
import type { BlockItemStatus } from '@concordium/web-sdk';
import type { ChainVerifier, ChainTransferSummary } from './provider.js';

// ─── network identity ──────────────────────────────────────────────────────
// Testnet only. Mainnet is deliberately absent so a misconfiguration cannot
// silently point the verifier at Mainnet.
const TESTNET_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

const KNOWN_GENESIS: Record<string, string> = {
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': TESTNET_GENESIS_HASH,
};


const HEX64 = /^[0-9a-f]{64}$/;

export interface ConcordiumChainVerifierOptions {
  /** Node host (bare, no scheme). */
  host: string;
  /** Node port. */
  port: number;
  /** CAIP-2 network id, must be a known Testnet identity. */
  network: string;
  /** Use TLS. Default true. */
  useTls?: boolean;
  /** Per-query timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Test seam: pre-built client. Production constructs its own. */
  client?: Pick<ConcordiumGRPCNodeClient, 'getBlockItemStatus' | 'getConsensusStatus'>;
}

export class ConcordiumChainVerifier implements ChainVerifier {
  private readonly host: string;
  private readonly port: number;
  private readonly network: string;
  private readonly genesisHash: string;
  private readonly timeoutMs: number;
  private readonly client: Pick<ConcordiumGRPCNodeClient, 'getBlockItemStatus' | 'getConsensusStatus'>;
  private verified = false;

  constructor(opts: ConcordiumChainVerifierOptions) {
    const genesis = KNOWN_GENESIS[opts.network];
    if (!genesis) {
      throw new Error(`unknown network: ${opts.network} (Mainnet is not configured)`);
    }
    this.host = opts.host;
    this.port = opts.port;
    this.network = opts.network;
    this.genesisHash = genesis;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.client =
      opts.client ??
      new ConcordiumGRPCNodeClient(
        opts.host,
        opts.port,
        opts.useTls === false ? credentials.createInsecure() : credentials.createSsl(),
      );
  }

  /** CAIP-2 network this verifier is bound to. */
  getNetwork(): string {
    return this.network;
  }

  /** Verify the node's genesis hash matches the configured network. */
  async verifyNode(): Promise<void> {
    let consensus: any;
    try {
      consensus = await withTimeout(this.client.getConsensusStatus(), this.timeoutMs);
    } catch (e) {
      throw new Error(`node unavailable: ${(e as Error)?.message ?? e}`);
    }
    const genesis = normalizeHash(consensus?.genesisBlock);
    if (!genesis) {
      throw new Error('malformed consensus status: no genesisBlock');
    }
    if (genesis !== this.genesisHash) {
      throw new Error(`network mismatch: node genesis ${genesis} != configured ${this.genesisHash}`);
    }
    this.verified = true;
  }

  /** Independent on-chain read. Never throws. */
  async readTransfer(txHash: string): Promise<ChainTransferSummary> {
    const hash = (typeof txHash === 'string' ? txHash.toLowerCase() : txHash);
    if (typeof hash !== 'string' || !HEX64.test(hash)) {
      return { status: 'unavailable' };
    }

    // Lazily verify the node identity on first read; a mismatch fails closed.
    if (!this.verified) {
      try {
        await this.verifyNode();
      } catch {
        return { status: 'unavailable' };
      }
    }

    let hashArg: unknown;
    try {
      hashArg = TransactionHash.fromHexString(hash);
    } catch {
      return { status: 'unavailable' };
    }

    let status: BlockItemStatus;
    try {
      status = await withTimeout(this.client.getBlockItemStatus(hashArg as TransactionHash.Type), this.timeoutMs);
    } catch {
      // NOT_FOUND and every other RPC failure are the same answer: this hash is not
      // independently confirmed on this node, so nothing may be released.
      return { status: 'unavailable' };
    }

    if (!status || typeof status !== 'object') {
      return { status: 'unavailable' };
    }
    const s = status as { status?: unknown; outcome?: unknown };
    if (typeof s.status !== 'string') {
      return { status: 'unavailable' };
    }

    if (s.status === 'received' || s.status === 'committed') {
      return { status: 'pending' };
    }
    if (s.status !== 'finalized') {
      return { status: 'unavailable' };
    }

    const outcome = s.outcome as
      | { blockHash?: unknown; summary?: unknown }
      | undefined;
    if (!outcome || typeof outcome !== 'object') {
      return { status: 'unavailable' };
    }

    const summary = outcome.summary as
      | {
          hash?: unknown;
          transactionType?: unknown;
          sender?: unknown;
          sponsor?: { sponsor?: unknown };
          transfer?: { to?: unknown; amount?: unknown };
          transactionKind?: unknown;
        }
      | undefined;
    if (!summary || typeof summary !== 'object') {
      return { status: 'unavailable' };
    }

    // Hash binding: the node must report the exact transaction we asked about.
    const summaryHash = normalizeHash(summary.hash);
    if (summaryHash === null || summaryHash !== hash) {
      return { status: 'unavailable' };
    }

    const blockHash = normalizeHash(outcome.blockHash);

    // Failed transaction → finalized but failed.
    const txType = summary.transactionType;
    const failed = txType === 'failed' || txType === 'Failed';

    // Extract transfer details when present.
    let sender: string | undefined;
    let sponsor: string | undefined;
    let recipient: string | undefined;
    let amount: string | undefined;

    if (summary.sender !== undefined && summary.sender !== null) {
      const s = safeAddressString(summary.sender);
      if (s) sender = s;
    }
    if (summary.sponsor && typeof summary.sponsor === 'object') {
      const sp = (summary.sponsor as { sponsor?: unknown }).sponsor;
      const ss = safeAddressString(sp);
      if (ss) sponsor = ss;
    }
    const transfer = summary.transfer as { to?: unknown; amount?: unknown } | undefined;
    if (transfer && typeof transfer === 'object') {
      const r = safeAddressString(transfer.to);
      if (r) recipient = r;
      if (transfer.amount !== undefined && transfer.amount !== null) {
        const a = amountToMicroCcd(transfer.amount);
        if (a !== null) amount = a;
      }
    }

    return {
      status: 'finalized',
      failed,
      ...(sender ? { sender } : {}),
      ...(sponsor ? { sponsor } : {}),
      ...(recipient ? { recipient } : {}),
      ...(amount !== undefined ? { amount } : {}),
      network: this.network,
      ...(blockHash ? { blockHash } : {}),
    };
  }
}

function safeAddressString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const o = value as { toString?: () => string; address?: unknown };
    if (typeof o.toString === 'function') {
      const s = o.toString();
      if (s && s !== '[object Object]') return s;
    }
    if (typeof o.address === 'string') return o.address;
  }
  return undefined;
}

function amountToMicroCcd(value: unknown): string | null {
  // CcdAmount (micro CCD) may be an object with `microCcdAmount`, a plain
  // `{ value }`, or a `toMicroCcd()` method. All represent integer micro CCD.
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'object') {
    const o = value as {
      microCcdAmount?: unknown;
      value?: unknown;
      toMicroCcd?: () => unknown;
    };
    if (o.microCcdAmount !== undefined && o.microCcdAmount !== null) {
      const r = amountToMicroCcd(o.microCcdAmount);
      if (r !== null) return r;
    }
    if (o.value !== undefined && o.value !== null) {
      const r = amountToMicroCcd(o.value);
      if (r !== null) return r;
    }
    if (typeof o.toMicroCcd === 'function') {
      try {
        const r = o.toMicroCcd();
        if (typeof r === 'bigint') return r.toString();
        if (typeof r === 'string') return r;
        if (typeof r === 'number' && Number.isSafeInteger(r)) return String(r);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeHash(value: unknown): string | null {
  if (typeof value === 'string') {
    return HEX64.test(value.toLowerCase()) ? value.toLowerCase() : null;
  }
  if (value && typeof value === 'object') {
    const o = value as { toHexString?: () => string; toString?: () => string };
    if (typeof o.toHexString === 'function') {
      const s = o.toHexString();
      if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
    }
    if (typeof o.toString === 'function') {
      const s = o.toString();
      if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
    }
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`node query exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
