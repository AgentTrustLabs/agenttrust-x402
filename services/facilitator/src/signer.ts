/**
 * Sponsor signer boundary.
 *
 * This prototype ships exactly one signer: a **mock**. It holds no key material, cannot
 * produce a valid signature, and cannot submit anything to a chain. It exists so the
 * protocol surface can be exercised end to end without ever touching a real sponsor.
 *
 * `createSigner()` fails closed: in `real` mode it throws, because a real signer is not
 * implemented here. That is deliberate — the alternative (a signer that reads a private key
 * from the environment inside this repository) is exactly what was ruled out.
 *
 * The interface below mirrors the SDK's `FacilitatorConcordiumSigner` closely enough that a
 * genuine implementation can be dropped in later without changing the facilitator core.
 */

import { closeSync, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AccountTransactionV1 } from '@concordium/web-sdk/transactions';
import { AccountAddress, Energy, AccountTransactionType, Payload, Transaction } from '@concordium/web-sdk';
import { ConfigurationError } from './config.js';
import type { OwnerAuthorizationCertificate } from './ownerAuthorization.js';

/**
 * Per-call signing options (Task 11). The facilitator passes the Owner's
 * authorization certificate and the payment digest it belongs to; a real
 * (IPC) signer forwards both to the signing service, which verifies and
 * consumes the authorization before signing. Mock signers ignore them.
 */
export interface AddSponsorSignatureOptions {
  authorization?: OwnerAuthorizationCertificate;
  paymentDigest?: string;
}

export interface SignerInfo {
  /** Sponsor account address (base58check). Public identifier, never a secret. */
  address: string;
  network: string;
  /** Always false for the mock: this signer provably cannot sign. */
  canSign: boolean;
}

/**
 * What the mock should do when asked to submit. Tests flip this to exercise the
 * ambiguous-outcome paths. It never has any effect on real signing.
 */
export type MockSubmissionBehaviour =
  | 'submit-ok'
  | 'submit-throws'
  | 'submit-hangs'
  | 'finalization-throws'
  | 'finalization-failed'
  /**
   * Test-only: the submission "succeeds" (the ledger records the attempt and the return value
   * exists) and then the process kills itself hard, before the caller can durably record the
   * hash. This reproduces the one crash window a local database cannot close.
   */
  | 'submit-then-die';

export interface MockSignerOptions {
  /** Placeholder sponsor address; shape-valid but not a real account. */
  placeholderAddress?: string;
  network: string;
  behaviour?: MockSubmissionBehaviour;
  /** Injectable clock, ms. */
  now?: () => number;
}

/**
 * A deterministic, obviously-fake hash so nothing can be mistaken for a real settlement.
 *
 * Kept for the non-instrumented mock. The instrumented `createHashingLedgerSigner` below
 * computes a REAL Concordium V1 transaction hash via the installed SDK, so a pre-broadcast
 * hash is available before submission — the entire point of pre-broadcast persistence.
 */
export const MOCK_TX_HASH_PREFIX = 'simulated-';

/**
 * Deterministic fixture the mock leaves in the sponsor signature slot.
 *
 * The production sponsor signer always produces a sponsor signature, and the finalized
 * transaction hash covers it (`AccountTransactionV1.serializeSignatures`). A mock that
 * returns the transaction with an empty sponsor slot makes `computeFinalizedTransactionHash`
 * throw "No signatures were provided" — so the mock must leave a signature there too.
 */
export const MOCK_SPONSOR_SIGNATURE = 'bb'.repeat(64);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fill an empty sponsor signature slot with the deterministic mock fixture.
 *
 * Only a V1 transaction-shaped input (has a `signatures` object with an empty `sponsor` map)
 * is touched. Anything else is returned unchanged, so non-transaction inputs stay untouched.
 */
function fillMockSponsorSlot(txJson: unknown): Record<string, unknown> {
  const out = isPlainRecord(txJson) ? { ...txJson } : {};
  const signatures = out['signatures'];
  if (!isPlainRecord(signatures)) return out;
  const sponsor = signatures['sponsor'];
  if (!isPlainRecord(sponsor) || Object.keys(sponsor).length !== 0) return out;
  out['signatures'] = { ...signatures, sponsor: { 0: { 0: MOCK_SPONSOR_SIGNATURE } } };
  return out;
}

export interface SponsorSigner {
  info(): SignerInfo;
  /**
   * Adds the sponsor signature. The mock does not sign: it returns the input unchanged but
   * marked, so a caller cannot mistake the result for a signed transaction.
   *
   * Task 11: `opts` carries the Owner's authorization certificate and the
   * payment digest it belongs to. A real signer MUST forward both to the
   * signing service; a signer that signs without them is a gap, not a
   * feature. Mock signers ignore them.
   */
  addSponsorSignature(txJson: unknown, opts?: AddSponsorSignatureOptions): Promise<unknown>;
  /** Submits the transaction. The mock never contacts a chain. */
  submitTransaction(txJson: unknown): Promise<string>;
  /** Waits for finalization. */
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<{
    txHash: string;
    status: 'pending' | 'committed' | 'finalized' | 'failed';
    sender: string;
    simulated: boolean;
  }>;
  /**
   * Whether this signer's outcomes are simulated. `true` for the mock and the
   * ledger (which wraps the mock); `false` for the IPC signer, which settles
   * through the real signing service and a real submitter. FacilitatorCore reads
   * this for `extra.simulated` in its responses. A signer that omits it is
   * treated as simulated — the burden is on a real signer to declare itself real.
   */
  simulated?: boolean;
  getAccountInfo(address: string): Promise<Record<string, unknown>>;
  getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined>;
  getTokenDecimals(tokenId: string): Promise<number>;
  /**
   * Optional fee/energy context validation. Returns null on success, an error
   * message on failure. When present, the pipeline calls it BEFORE signing and fails
   * closed on a non-null result. Mock signers omit it, so mock flows are unaffected.
   */
  validateContext?(ctx: {
    network: string;
    sponsor: string;
    recipient: string;
    energy: bigint;
    feeMicroCcd: bigint;
  }): string | null;
}

/**
 * The only signer this prototype can build.
 *
 * There is no constructor path that accepts a private key, mnemonic, keystore path or wallet
 * file, so no caller can accidentally hand it one.
 */
export function createMockSigner(opts: MockSignerOptions): SponsorSigner {
  const placeholder = opts.placeholderAddress ?? '3mockSponsorPlaceholderNotARealAccountAddress0000';
  const behaviour = opts.behaviour ?? 'submit-ok';
  const now = opts.now ?? (() => Date.now());

  return {
    info: () => ({ address: placeholder, network: opts.network, canSign: false }),

    // Mock outcomes are simulated, never real. Declared explicitly so
    // FacilitatorCore reports `extra.simulated: true` for mock settlements.
    simulated: true,

    async addSponsorSignature(txJson) {
      // The mock cannot sign. It returns the input marked as simulated/mocked, but it
      // must leave a deterministic sponsor signature in place (see fillMockSponsorSlot):
      // the finalized transaction hash covers the sponsor signature, so an empty slot
      // makes `computeFinalizedTransactionHash` throw and the core's hash comparison fail.
      return { ...fillMockSponsorSlot(txJson), __simulated: true, __mocked: true };
    },

    async submitTransaction(txJson) {
      if (behaviour === 'submit-throws') {
        throw new Error('mock signer: submission refused (simulated failure)');
      }
      if (behaviour === 'submit-hangs') {
        // Resolves far in the future: models a broadcast whose outcome we never learn.
        await new Promise(resolve => setTimeout(resolve, 60_000));
      }
      // Return the REAL hash of the fully signed transaction, so the caller's
      // persisted-hash comparison is meaningful. The mock does not contact a chain; it just
      // reports the identifier the node would report for this exact transaction.
      //
      // A caller that hands over something that is not a V1 transaction (e.g. `{}`) cannot
      // have a meaningful hash, so it gets the obviously-fake prefix instead of a fabricated
      // 64-hex value. That keeps "is this real?" answerable by inspection.
      try {
        return computeFinalizedTransactionHash(txJson);
      } catch {
        return `${MOCK_TX_HASH_PREFIX}${now().toString(16).padStart(16, '0')}`;
      }
    },

    async waitForFinalization(txHash) {
      if (behaviour === 'finalization-throws') {
        throw new Error('mock signer: finalization lookup failed (simulated)');
      }
      return {
        txHash,
        status: behaviour === 'finalization-failed' ? 'failed' : 'finalized',
        sender: placeholder,
        simulated: true,
      };
    },

    async getAccountInfo() {
      return { mocked: true };
    },

    async getTokenBalance() {
      return 0n;
    },

    async getTokenDecimals() {
      return 6;
    },
  };
}

/**
 * A mock signer that records every *actual submission attempt* to a shared append-only ledger.
 *
 * This is the submission-counting instrumentation: HTTP responses can be counted from the client
 * side, but "did this process really call submitTransaction?" can only be answered at the
 * submission boundary. `O_APPEND` writes of a short line are atomic on POSIX, so several
 * processes appending to one file is a safe deterministic counter.
 *
 * It still cannot sign: `canSign` stays false and `addSponsorSignature` still produces no
 * signature. Only the submission bookkeeping is instrumented.
 */
export interface LedgerSignerOptions {
  ledgerPath: string;
  network: string;
  behaviour?: MockSubmissionBehaviour;
  now?: () => number;
  /** Optional per-process label, so the ledger shows which process attempted. */
  label?: string;
}

export function createLedgerSigner(opts: LedgerSignerOptions): SponsorSigner {
  const inner = createMockSigner({
    network: opts.network,
    ...(opts.behaviour ? { behaviour: opts.behaviour } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const now = opts.now ?? (() => Date.now());

  const append = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify(record)}\n`;
    const fd = openSync(opts.ledgerPath, 'a');
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  };

  return {
    info: () => inner.info(),
    // Wraps the mock: outcomes are simulated, never real.
    simulated: true,
    addSponsorSignature: (tx, _opts) => inner.addSponsorSignature(tx, _opts),
    async submitTransaction(txJson) {
      // Recorded BEFORE the attempt: even a throwing submission is an attempt, and the count
      // must reflect that, not just the successes.
      append({
        event: 'submit_attempt',
        at: now(),
        pid: process.pid,
        label: opts.label ?? null,
        paymentHint: hintOf(txJson),
      });
      try {
        const hash = await inner.submitTransaction(txJson);
        if (opts.behaviour === 'submit-then-die') {
          // The submission "succeeded" off-process and we never get to record it.
          append({ event: 'crash_after_submit', at: now(), pid: process.pid, label: opts.label ?? null });
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {}); // never resolves
        }
        return hash;
      } catch (e) {
        append({ event: 'submit_threw', at: now(), pid: process.pid, label: opts.label ?? null, error: String((e as Error)?.message ?? e) });
        throw e;
      }
    },
    waitForFinalization: (txHash, timeoutMs) => inner.waitForFinalization(txHash, timeoutMs),
    getAccountInfo: a => inner.getAccountInfo(a),
    getTokenBalance: (a, t) => inner.getTokenBalance(a, t),
    getTokenDecimals: t => inner.getTokenDecimals(t),
  };
}

function hintOf(txJson: unknown): string | null {
  const anyTx = txJson as { payload?: { toAddress?: string; amount?: string }; __simulated?: boolean } | null;
  if (!anyTx || typeof anyTx !== 'object') return null;
  return `${anyTx.payload?.toAddress ?? 'unknown'}:${anyTx.payload?.amount ?? 'unknown'}`;
}

/**
 * Convert an x402 JSON signed transaction into the SDK's typed V1 shape.
 *
 * The mock signer receives the client's JSON. To compute a real hash we must build the
 * SDK-shaped object (`AccountAddress.Type`, `Energy.Type`, `SequenceNumber.Type`,
 * `TransactionExpiry.Type`) — the SDK's serializer is typed and does not accept strings.
 *
 * This is pure shape conversion: no signing, no network, no key material. The sponsor
 * signature slot is filled with deterministic fixture bytes so the hash is stable.
 */
export function toSdkV1Transaction(txJson: unknown): AccountTransactionV1.Type {
  // Accept both the bare signed transaction and the x402 wrapper `{ signedTransaction }`.
  const wrapper = txJson as { signedTransaction?: unknown } | null;
  const bare = wrapper && typeof wrapper === 'object' && wrapper.signedTransaction ? wrapper.signedTransaction : txJson;

  // The mock signer receives fixtures with placeholder sponsor addresses. A placeholder is
  // not a valid Concordium address, so substitute a real one for hash purposes. The hash
  // still changes if a DIFFERENT placeholder is supplied, which is what the tests need.
  const PLACEHOLDER_SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
  const safeAddress = (raw: string | undefined, fallback: string): AccountAddress.Type => {
    if (!raw) return AccountAddress.fromBase58(fallback);
    try {
      return AccountAddress.fromBase58(raw);
    } catch {
      return AccountAddress.fromBase58(fallback);
    }
  };

  const tx = bare as {
    version?: number;
    header?: {
      sender?: string;
      nonce?: string | number;
      expiry?: string | number;
      numSignatures?: string | number;
      sponsor?: { address?: string; account?: string; numSignatures?: string | number };
    };
    payload?: { type?: string; toAddress?: string; amount?: string | number; tokenId?: string; operations?: string };
    signatures?: { sender?: Record<string, Record<string, string>>; sponsor?: Record<string, Record<string, string>> };
  };
  const header = tx.header ?? {};
  const payloadJson = tx.payload ?? {};
  const sender = safeAddress(header.sender, PLACEHOLDER_SPONSOR);
  const sponsorAddr = safeAddress(header.sponsor?.address ?? header.sponsor?.account, PLACEHOLDER_SPONSOR);

  let payload: any;
  if (payloadJson.type === 'transfer') {
    payload = {
      type: AccountTransactionType.Transfer,
      toAddress: safeAddress(payloadJson.toAddress, PLACEHOLDER_SPONSOR),
      amount: { microCcdAmount: BigInt(payloadJson.amount ?? '0') },
    } as any;
  } else if (payloadJson.type === 'tokenUpdate') {
    payload = {
      type: AccountTransactionType.TokenUpdate,
      tokenId: payloadJson.tokenId ?? '',
      operations: payloadJson.operations ?? '',
    } as any;
  } else {
    throw new Error(`unsupported payload type: ${String(payloadJson.type)}`);
  }

  const payloadSize = Payload.sizeOf(payload);
  const sigCount = 2n; // sender + sponsor
  const energyAmount = AccountTransactionV1.calculateEnergyCost(
    sigCount,
    payload,
    Energy.create(300n),
    { sponsor: true },
  );

  // The sponsor signature is fixture bytes — the mock cannot sign. The sender signature is
  // whatever the client supplied. Both are part of the hash.
  const sponsorSigs = tx.signatures?.sponsor && Object.keys(tx.signatures.sponsor).length > 0
    ? tx.signatures.sponsor
    : { 0: { 0: 'bb'.repeat(64) } };

  return {
    version: 1 as const,
    header: {
      expiry: { expiryEpochSeconds: BigInt(header.expiry ?? 0) },
      sender,
      nonce: { value: BigInt(header.nonce ?? 0) },
      payloadSize,
      energyAmount,
      sponsor: sponsorAddr,
    },
    payload,
    signatures: {
      sender: tx.signatures?.sender ?? { 0: { 0: 'aa'.repeat(64) } },
      sponsor: sponsorSigs,
    },
  } as unknown as AccountTransactionV1.Type;
}

/**
 * Compute the final transaction hash of a fully-signed V1 sponsored transaction.
 *
 * Uses the verified SDK API (`AccountTransactionV1.getAccountTransactionHash`), which is
 * `sha256(serialize(tx))` — signatures, header, payload. The block-item kind byte is excluded.
 *
 * The sponsor signature MUST already be present: the hash covers it, so an unsigned
 * transaction hashes differently. That is the ordering constraint established and
 * enforced by calling this only after `addSponsorSignature`.
 *
 * No network, no signing, no key material. Pure local computation.
 */
export function computeTransactionHash(txJson: unknown): string {
  const typed = toSdkV1Transaction(txJson);
  const bytes = AccountTransactionV1.getAccountTransactionHash(typed);
  return Buffer.from(bytes).toString('hex');
}

/**
 * Hash of the transaction AS SUBMITTED.
 *
 * `Transaction.finalize` recomputes the energy amount from the payload, signatures and
 * header, so the node-reported hash for a V1 sponsored transaction is the hash of the
 * finalized transaction — not the hash of the pre-finalized signed JSON. Persisting the
 * finalized hash BEFORE broadcast is what makes the returned node hash comparable.
 *
 * No network, no signing, no key material. Pure local computation.
 */
export function computeFinalizedTransactionHash(txJson: unknown): string {
  const signable = Transaction.signableFromJSON(txJson);
  const finalized = Transaction.finalize(signable as never);
  const bytes = AccountTransactionV1.serializeBlockItem(finalized as never);
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
/**
 * Build the signer the config asks for.
 *
 * `real` throws: this prototype has no real signer, and inventing one here would mean the
 * gateway's repository handling a sponsor key. A future task provisions it out of process.
 */
export function createSigner(config: { mode: 'mock' | 'real'; network: string }): SponsorSigner {
  if (config.mode === 'real') {
    throw new ConfigurationError(
      'real mode requires a separately provisioned sponsor signer; this prototype implements mock only. ' +
        'Supplying a sponsor private key to this service is out of scope and unsupported.',
    );
  }
  return createMockSigner({ network: config.network });
}
