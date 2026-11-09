/**
 * Protocol core: /supported, /verify, /settle over a mock signer.
 *
 * Wire shapes are the x402 v2 ones (see @x402/core `VerifyResponse` / `SettleResponse`), so the
 * gateway's existing `createHttpFacilitator` and `classifyCompatibility` accept them unchanged.
 *
 * Security posture, in order of execution:
 *  1. structural validation of the request envelope
 *  2. requirement/payload agreement (scheme, network, asset, amount, payTo)
 *  3. expiry (spec rule 7): not in the past, not more than 600 s ahead
 *  4. replay: the same payload may not authorise two different spends
 *  5. settle: duplicate → same hash; pending → non-terminal, never success; never auto-retried
 *
 * The signer here is a mock that provably cannot sign (`canSign: false`), so nothing in this
 * service can produce a real chain signature.
 */

import type { SponsorSigner } from './signer.js';
import { computeFinalizedTransactionHash } from './signer.js';
import { paymentDigest, requirementsKey } from './store.js';
import { SqliteSettlementRepository, evidenceDigestOf, type SettlementRepository } from './repository.js';
import type { AuthorizationClient, AuthorizationRequest } from './authorization.js';
import { LocalAuthorizationClient } from './authorization.js';
import { deriveEnergyExposure, SIMPLE_TRANSFER_BASE_COST } from './energy.js';
import { convertV2ToSdkV1 } from './wireConverter.js';
import type { SenderVerificationResult } from './senderVerifier.js';
import type { WireConversionPolicy, SdkV1SignableTransaction } from './wireConverter.js';

export const X402_VERSION = 2;
export const MAX_EXPIRY_OFFSET_SECONDS = 600;

export interface SupportedBody {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface VerifyBody {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extra?: Record<string, unknown>;
}

export interface RecoverySummary {
  scanned: number;
  finalized: number;
  failed: number;
  pending: number;
  transportErrors: number;
  skipped: number;
}

export interface SettleBody {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface CoreOptions {
  network: string;
  signer: SponsorSigner;
  store?: SettlementRepository;
  /**
   * TEST ONLY: SIGKILL the process at the named point. Used by the TASK 29 crash-window
   * harness to terminate a real OS process at an exact boundary. Never set outside tests.
   */
  dieAt?: 'after-claim' | 'after-sponsor-sign' | 'after-hash' | 'after-persist' | 'before-submit' | 'after-submit';
  /** Path to the SQLite file. Defaults to :memory: for tests. */
  dbPath?: string;
  authorization?: AuthorizationClient;
  /**
   * TASK 55: sponsor energy cap for the authorization boundary. Defaults to 1_000n.
   * The owner re-derives this from its own policy; the value here only affects the local
   * mock-only client. Aligned with FACILITATOR_MAX_ENERGY default (see config.ts).
   */
  maxAuthorizationEnergy?: bigint;
  /**
   * TASK 55: maximum execution energy accepted by the wire converter. Defaults to 1_000.
   * This is the converter's own policy cap; the authorization owner enforces the
   * authoritative cap independently. Aligned with FACILITATOR_MAX_ENERGY default.
   */
  maxWireEnergy?: number;
  /**
   * TASK 37: wire converter seam. Defaults to the real `convertV2ToSdkV1`. Tests may
   * inject an instrumented converter to prove ordering (convert-before-sign, and
   * zero conversions when authorization is refused).
   */
  wireConverter?: (input: unknown, policy: WireConversionPolicy) => ReturnType<typeof convertV2ToSdkV1>;
  /**
   * TASK 38: sender signature verifier. Defaults to a pass-through (mock-only) so existing
   * mock flows keep working. Production must inject an SDK-backed verifier with a real
   * account-info provider.
   */
  senderVerifier?: (txJson: unknown) => Promise<SenderVerificationResult>;
  /** Busy timeout for multi-process writers. */
  busyTimeoutMs?: number;
  now?: () => number;
  /** How long to wait for finalization before declaring the outcome ambiguous. */
  finalizationTimeoutMs?: number;
}

export class FacilitatorCore {
  readonly store: SettlementRepository;
  /** Read-only access to the signer, for wiring assertions and tests only. */
  getSigner(): SponsorSigner {
    return this.signer;
  }
  private readonly network: string;
  private readonly signer: SponsorSigner;
  private readonly now: () => number;
  private readonly finalizationTimeoutMs: number;
  private readonly dieAt: CoreOptions['dieAt'];
  private readonly maxWireEnergy: number;
  private readonly wireConverter: (input: unknown, policy: WireConversionPolicy) => ReturnType<typeof convertV2ToSdkV1>;
  private readonly senderVerifier: (txJson: unknown) => Promise<SenderVerificationResult>;
  private readonly authorization: AuthorizationClient;

  constructor(opts: CoreOptions) {
    this.network = opts.network;
    this.signer = opts.signer;
    this.now = opts.now ?? (() => Date.now());
    this.finalizationTimeoutMs = opts.finalizationTimeoutMs ?? 30_000;
    this.dieAt = opts.dieAt;
    // Durable by default when a path is given; `:memory:` is opt-in for tests only.
    this.store =
      opts.store ??
      new SqliteSettlementRepository(opts.dbPath ?? ':memory:', {
        now: this.now,
        ...(opts.busyTimeoutMs !== undefined ? { busyTimeoutMs: opts.busyTimeoutMs } : {}),
      });
    // TASK 34.11: the authorization boundary. When none is injected, fall back to the local
    // mock-only client bound to this facilitator's own store and the mock signer's placeholder
    // sponsor. An explicit client (e.g. IpcAuthorizationClient) is required for production.
    this.authorization =
      opts.authorization ??
      new LocalAuthorizationClient({
        policy: {
          network: this.network,
          sponsor: this.signer.info().address,
          maxEnergy: opts.maxAuthorizationEnergy ?? 1_000n,
          maxExpiryOffsetSeconds: MAX_EXPIRY_OFFSET_SECONDS,
          allowedAssets: ['CCD'],
          policyVersion: 'local-v1',
        },
        repository: this.store,
        now: this.now,
      });
    // TASK 37: wire conversion policy. The energy cap mirrors the authorization cap; the
    // authoritative energy VALUE comes from deriveEnergyExposure(), never from the client.
    this.maxWireEnergy = opts.maxWireEnergy ?? 1_000;
    this.wireConverter = opts.wireConverter ?? convertV2ToSdkV1;
    // TASK 38: default pass-through (mock-only). A real verifier must be injected.
    this.senderVerifier = opts.senderVerifier ?? (async () => ({ ok: true }));
  }

  /** `/supported`. Reads the signer's address; never constructs a signature. */
  getSupported(): SupportedBody {
    const info = this.signer.info();
    return {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: 'exact',
          network: this.network,
          extra: { feePayer: info.address },
        },
      ],
      extensions: [],
      signers: { 'ccd:*': [info.address] },
    };
  }

  async verify(body: unknown): Promise<VerifyBody> {
    const parsed = this.parseEnvelope(body);
    if (!parsed.ok) return { isValid: false, invalidReason: 'invalid_request', invalidMessage: parsed.reason };

    const { payload, requirements } = parsed;
    const agreement = this.checkAgreement(payload, requirements);
    if (!agreement.ok) return { isValid: false, invalidReason: 'requirements_mismatch', invalidMessage: agreement.reason };

    const expiry = this.checkExpiry(payload, requirements);
    if (!expiry.ok) return { isValid: false, invalidReason: 'expired', invalidMessage: expiry.reason };

    // Replay key excludes resource.url: one signed payment is one payment.
    const digest = paymentDigest(payload);
    const reqKey = requirementsKey(requirements, resourceUrlOf(payload));
    const replay = this.store.noteVerified(digest, reqKey);
    if (!replay.ok) return { isValid: false, invalidReason: 'replay', invalidMessage: replay.reason };

    return {
      isValid: true,
      payer: this.payerOf(payload),
      extra: { digest, simulated: true, canSign: this.signer.info().canSign === false ? false : true },
    };
  }

  async settle(body: unknown): Promise<SettleBody> {
    const parsed = this.parseEnvelope(body);
    if (!parsed.ok) {
      return this.fail('invalid_request', parsed.reason);
    }
    const { payload, requirements } = parsed;

    const agreement = this.checkAgreement(payload, requirements);
    if (!agreement.ok) return this.fail('requirements_mismatch', agreement.reason);

    const expiry = this.checkExpiry(payload, requirements);
    if (!expiry.ok) return this.fail('expired', expiry.reason);

    const digest = paymentDigest(payload);
    const reqKey = requirementsKey(requirements, resourceUrlOf(payload));

    // Atomic claim at the storage layer. The uniqueness constraints, not this `if`, are what
    // make concurrent duplicates impossible: two processes racing here produce exactly one
    // 'fresh' claim and one 'in_progress'.
    const guard = this.store.claim(digest, reqKey);
    if (!guard.ok) {
      switch (guard.reason) {
        case 'pending':
          // TASK 29.1: if the previous process died between submitTransaction() and
          // markBroadcast(), the row is still `submitting`. The transaction may already have
          // reached the node, so the correct state is `outcome_unknown` — reconcile by hash,
          // never resubmit.
          {
            const row = this.store.get(digest);
            if (row?.state === 'submitting' && row.tx_hash) {
              try {
                this.store.markBroadcast(digest, row.tx_hash);
              } catch {
                // A concurrent recovery already advanced it. That is fine — the state is
                // `outcome_unknown` either way and no resubmission can occur.
              }
            }
          }
          return {
            success: false,
            errorReason: 'settlement_pending',
            errorMessage:
              'a previous settlement attempt for this payment is ambiguous; the transaction may still confirm. ' +
              'This is not a success. Reconcile by transaction hash before retrying.',
            transaction: guard.transaction ?? 'unknown',
            network: this.network,
            extra: { digest, nonTerminal: true },
          };
        case 'in_progress':
          return this.fail('settle_in_progress', 'a settlement for this payment is already in flight', { digest });
        case 'terminal':
          return this.fail('settle_refused', 'this payment previously failed terminally; a new payload is required', { digest });
        case 'different_authorisation':
          return this.fail('settle_refused', `payment already used for a different authorisation (${guard.recorded})`, { digest });
        default:
          return this.fail('settle_refused', 'claim refused', { digest });
      }
    }
    if (guard.claim === 'idempotent') {
      return {
        success: true,
        transaction: guard.transaction,
        network: this.network,
        payer: this.payerOf(payload),
        extra: { digest, idempotentReplay: true, simulated: true },
      };
    }

    // TASK 29: a `resumable` claim means the hash is already durable from a previous,
    // crashed attempt. Skip prepare() (it is already done) and use the persisted hash.
    const resumableHash = guard.claim === 'resumable' ? guard.transaction : null;

    // ── TASK 34.11: authorization boundary ────────────────────────────────────────────
    // ORDER: validate → expiry → replay claim → AUTHORIZE → signer. No path reaches
    // `addSponsorSignature()` without an 'approved' outcome from the owner.
    //
    // A `resumable` payment already has a durable approval (it was authorized before the
    // crash that produced the persisted hash), so re-authorizing would be refused by the
    // durable gate. It skips the boundary and continues with the persisted hash.
    // ── TASK 38: sender signature verification (BEFORE authorization) ────────────────
    // ORDER: validate → claim → SENDER VERIFY → authorize → recover → convert → signer.
    // A resumable payment already passed verification when its hash was durably persisted.
    // Verification failure fails closed: authorization and signing are never reached.
    if (!resumableHash) {
      const verifyResult = await this.senderVerifier(
        (payload['payload'] as Record<string, unknown>)?.['signedTransaction'] ?? payload['payload'],
      );
      if (!verifyResult.ok) {
        this.store.markFailed(digest, `sender verification failed: ${verifyResult.reason}`);
        return this.fail('sender_verification_failed', `sender signature verification failed: ${verifyResult.reason}`, { digest });
      }
    }

    // TASK 37: the authoritative execution energy, derived from the transaction itself by
    // the energy policy. Hoisted so the wire converter can consume the SAME value the
    // authorization boundary priced — a client-supplied energy never becomes the policy
    // decision.
    let derivedEnergy: bigint | null = null;
    if (!resumableHash) {
      const preimage = payload['payload']?.signedTransaction;
      const energy = deriveEnergyExposure(preimage, { transactionSpecificCost: SIMPLE_TRANSFER_BASE_COST });
      derivedEnergy = energy;
      if (energy === null) {
        this.store.markFailed(digest, 'authorization could not price the transaction');
        return this.fail('authorization_failed', 'could not derive energy exposure from the transaction', { digest });
      }
      const requirementsAny = requirements as Record<string, unknown>;
      const acceptedAny = (payload['accepted'] ?? {}) as Record<string, unknown>;
      const header = (preimage as Record<string, unknown>)['header'] as Record<string, unknown>;
      const authRequest: AuthorizationRequest = {
        paymentDigest: digest,
        network: this.network,
        version: 1,
        sender: String(header['sender']),
        sponsor: String((requirementsAny['extra'] as Record<string, unknown> | undefined)?.['feePayer'] ?? this.signer.info().address),
        recipient: String(acceptedAny['payTo']),
        asset: String(acceptedAny['asset']),
        amount: String(acceptedAny['amount']),
        expiry: Number(header['expiry']),
        energy,
      };

      let auth: Awaited<ReturnType<AuthorizationClient['authorize']>>;
      try {
        auth = await this.authorization.authorize(authRequest);
      } catch (e) {
        this.store.markFailed(digest, `authorization threw: ${(e as Error).message}`);
        return this.fail('authorization_failed', `authorization client error: ${(e as Error).message}`, { digest });
      }

      if (auth.outcome !== 'approved') {
        // TASK 34.13: a prior approval was recorded. Do NOT trust the reason code alone.
        // Ask the owner to verify the durable approval against the current canonical context.
        // Only continue if the owner independently confirms a matching approval.
        if (auth.reason === 'authorization_already_recorded') {
          let recovered: Awaited<ReturnType<AuthorizationClient['recover']>>;
          try {
            recovered = await this.authorization.recover(authRequest);
          } catch (e) {
            this.store.markFailed(digest, `authorization recovery threw: ${(e as Error).message}`);
            return this.fail('authorization_failed', `authorization recovery error: ${(e as Error).message}`, { digest });
          }
          if (recovered.outcome !== 'approved') {
            this.store.markFailed(digest, `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'}`);
            const nonTerminal = recovered.outcome === 'unknown' || recovered.outcome === 'owner_unavailable';
            if (nonTerminal) {
              return {
                success: false,
                errorReason: 'settlement_pending',
                errorMessage: `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'} — reconcile before retrying`,
                transaction: 'unknown',
                network: this.network,
                extra: { digest, nonTerminal: true, authorizationOutcome: recovered.outcome },
              };
            }
            return this.fail('authorization_rejected', `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'}`, {
              digest,
              authorizationOutcome: recovered.outcome,
            });
          }
          // Recovered: a matching durable approval exists. Continue with the signer.
        } else {
          // Never reach the signer. The payment is recorded as terminally rejected for this
          // payload, so a retry requires a new payload (TASK26 state machine, unchanged).
          this.store.markFailed(digest, `authorization ${auth.outcome}: ${auth.reason ?? 'no reason'}`);
          const reasonMap: Record<string, string> = {
            rejected: 'authorization_rejected',
            unknown: 'authorization_unknown',
            owner_unavailable: 'authorization_owner_unavailable',
            protocol_error: 'authorization_protocol_error',
          };
          const errorReason = reasonMap[auth.outcome] ?? 'authorization_failed';
          const nonTerminal = auth.outcome === 'unknown' || auth.outcome === 'owner_unavailable';
          if (nonTerminal) {
            // Ambiguous: the owner may or may not have recorded a decision. Fail closed and
            // leave the payment non-terminal so an operator can reconcile — never auto-retry.
            return {
              success: false,
              errorReason: 'settlement_pending',
              errorMessage: `authorization ${auth.outcome}: ${auth.reason ?? 'no reason'} — reconcile before retrying`,
              transaction: 'unknown',
              network: this.network,
              extra: { digest, nonTerminal: true, authorizationOutcome: auth.outcome },
            };
          }
          return this.fail(errorReason, `authorization ${auth.outcome}: ${auth.reason ?? 'no reason'}`, {
            digest,
            authorizationOutcome: auth.outcome,
          });
        }
      }
    }

    // TEST ONLY: terminate at the requested boundary.
    if (this.dieAt === 'after-claim') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }

    // ── TASK 37: wire conversion (BEFORE the signer, AFTER authorization) ──────────────
    // ORDER: validate → claim → authorize → recover → CONVERT → signer → hash → submit.
    // The converter receives the policy-derived energy, never a client-supplied value.
    // A conversion failure fails closed: the signer is never invoked.
    let converted: SdkV1SignableTransaction | null = null;
    if (!resumableHash) {
      if (derivedEnergy === null) {
        this.store.markFailed(digest, 'wire conversion has no policy-derived energy');
        return this.fail('authorization_failed', 'no policy-derived energy for wire conversion', { digest });
      }
      const sponsoredPayload = payload['payload'] as Record<string, unknown>;
      const rawSigned = sponsoredPayload?.['signedTransaction'] as Record<string, unknown> | undefined;
      if (!rawSigned || typeof rawSigned !== 'object') {
        this.store.markFailed(digest, 'wire conversion: signedTransaction missing');
        return this.fail('wire_conversion_failed', 'signedTransaction is missing from the payment payload', { digest });
      }
      // `executionEnergyAmount` is the transaction-specific base cost (C_t), NOT total energy.
      // The SDK recomputes the total from C_t + signature count + serialized sizes, so
      // passing the derived *total* here makes the node price a different transaction than the
      // client signed and the node rejects it. The policy still binds: a simple transfer is
      // priced at the known base cost (never at a client-supplied value), and any other payload
      // kind must supply a valid C_t that the converter checks against the cap.
      const payloadKind = (rawSigned['payload'] as Record<string, unknown> | undefined)?.['type'];
      const rawC_t = (rawSigned['header'] as Record<string, unknown> | undefined)?.['executionEnergyAmount'];
      const cT = payloadKind === 'transfer' || payloadKind === 'transferWithMemo' || payloadKind === 3
        ? Number(SIMPLE_TRANSFER_BASE_COST)
        : (typeof rawC_t === 'number' && Number.isSafeInteger(rawC_t) && rawC_t > 0 ? rawC_t : Number(SIMPLE_TRANSFER_BASE_COST));
      const withPolicyEnergy = {
        ...rawSigned,
        header: { ...(rawSigned['header'] as Record<string, unknown>), executionEnergyAmount: cT },
      };
      const conversion = this.wireConverter(withPolicyEnergy, {
        network: this.network,
        sponsorAddress: this.signer.info().address,
        maxExecutionEnergy: this.maxWireEnergy,
      });
      if (!conversion.ok) {
        this.store.markFailed(digest, `wire conversion failed: ${conversion.code}: ${conversion.message}`);
        return this.fail('wire_conversion_failed', `${conversion.code}: ${conversion.message}`, { digest });
      }
      converted = conversion.wire;
    }

    // ── submission. The mock cannot sign; nothing here reaches a chain. ──
    // TASK 29 ordering (closes the TASK 27 crash window):
    //   1. complete preparation (already done — claim + agreement + expiry + replay)
    //   2. obtain the sponsor signature (the mock marks the tx; real signer would sign)
    //   3. calculate the final transaction hash from the fully signed tx
    //   4. durably persist the hash (prepared → hash bound) BEFORE any broadcast
    //   5. take the broadcast claim (prepared → submitting)
    //   6. only then call submitTransaction()
    //   7. record the broadcast (submitting → outcome_unknown)
    //   8. compare the returned hash to the persisted one; mismatch → never finalize
    let txHash: string;
    // The signer receives the canonical SDK V1 wire object (TASK36). On a resumable path
    // there is no session payload to convert, so the persisted pipeline continues with the
    // original payload — the sponsor signature is already bound into the durable hash.
    // TASK 48: fee/energy context validation, actually invoked before signing.
    // Runs only when the signer exposes validateContext (real/IPC signers); mock signers
    // omit it, so mock flows are byte-for-byte unchanged.
    if (typeof this.signer.validateContext === 'function' && !resumableHash && derivedEnergy !== null) {
      const recipient = this.payerOf(payload) ?? '';
      // Conservative fee estimate: energy * 8000 microCCD/NRG, slightly above the current
      // measured Testnet rate (7939.534 microCCD/NRG). Integer-safe (bigint).
      const feeEstimate = derivedEnergy * 8000n;
      const vctx = this.signer.validateContext({
        network: this.network,
        sponsor: this.signer.info().address,
        recipient,
        energy: derivedEnergy,
        feeMicroCcd: feeEstimate,
      });
      if (vctx !== null) {
        this.store.markFailed(digest, `fee validation failed: ${vctx}`);
        return this.fail('fee_validation_failed', vctx, { digest });
      }
    }

    const signerInput = converted ?? payload.payload;
    const sponsored = await this.signer.addSponsorSignature(signerInput);
    if (this.dieAt === 'after-sponsor-sign') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    // Step 3: the hash covers the sponsor signature, so it can only be computed now.
    let persistedHash: string;
    if (resumableHash) {
      persistedHash = resumableHash;
    } else {
      try {
        persistedHash = computeFinalizedTransactionHash(sponsored);
      } catch (e) {
        this.store.markFailed(digest, `hash computation failed: ${(e as Error).message}`);
        return this.fail('hash_computation_failed', `could not compute transaction hash: ${(e as Error).message}`, { digest });
      }
      if (this.dieAt === 'after-hash') {
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      }
      // Step 4: durable persistence BEFORE any broadcast. If this throws, no submission has
      // happened and the payment is not broadcast-eligible.
      try {
        this.store.prepare(digest, persistedHash);
      } catch (e) {
        this.store.markFailed(digest, `hash persistence failed: ${(e as Error).message}`, persistedHash);
        return this.fail('hash_persistence_failed', `could not persist transaction hash: ${(e as Error).message}`, { digest });
      }
    }
    if (this.dieAt === 'after-persist') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    // Step 5: take the broadcast claim against the exact persisted hash.
    const submitClaim = this.store.claimSubmit(digest, persistedHash);
    if (!submitClaim.ok) {
      // TASK 29.1: a `submitting` row means the previous process took the broadcast claim
      // but may or may not have reached the node. Transition it to `outcome_unknown` so
      // recovery can reconcile it — never resubmit.
      if (submitClaim.reason === 'not prepared (state=submitting)' || submitClaim.reason.startsWith('not prepared')) {
        const row = this.store.get(digest);
        if (row?.tx_hash) this.store.markBroadcast(digest, row.tx_hash);
      }
      return this.fail('settle_in_progress', `broadcast claim refused: ${submitClaim.reason}`, { digest, transaction: persistedHash });
    }
    if (this.dieAt === 'before-submit') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    try {
      txHash = await this.signer.submitTransaction(sponsored);
    } catch (e) {
      // Submission threw: we do not know whether anything was broadcast. Treat as pending,
      // never as failure-with-retry, because retrying could double-spend. The hash is already
      // durable, so recovery can use it.
      this.store.markPending(digest, persistedHash, 'submission outcome unknown');
      return {
        success: false,
        errorReason: 'settlement_pending',
        errorMessage: `submission outcome unknown: ${(e as Error).message}`,
        transaction: persistedHash,
        network: this.network,
        extra: { digest, nonTerminal: true },
      };
    }
    if (this.dieAt === 'after-submit') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    // Step 7: record the broadcast. submitting → outcome_unknown.
    this.store.markBroadcast(digest, persistedHash);
    // Step 8: the returned hash must equal the persisted one. A mismatch is a hard failure:
    // we never finalize, never report success, and leave the payment pending for recovery.
    if (txHash !== persistedHash) {
      this.store.markPending(digest, persistedHash, `returned hash ${txHash} != persisted ${persistedHash}`);
      return {
        success: false,
        errorReason: 'settlement_pending',
        errorMessage: `returned hash ${txHash} does not match persisted hash ${persistedHash}`,
        transaction: persistedHash,
        network: this.network,
        extra: { digest, nonTerminal: true, hashMismatch: true },
      };
    }

    // ── finalization. Bounded: an unbounded wait is an availability bug. ──
    let status: { status: string };
    try {
      status = await withTimeout(
        this.signer.waitForFinalization(txHash, this.finalizationTimeoutMs),
        this.finalizationTimeoutMs,
      );
    } catch (e) {
      // Broadcast happened, confirmation did not. Ambiguous → pending with the real hash.
      this.store.markPending(digest, txHash, 'broadcast, not confirmed');
      return {
        success: false,
        errorReason: 'settlement_pending',
        errorMessage: `broadcast but not confirmed: ${(e as Error).message}`,
        transaction: txHash,
        network: this.network,
        extra: { digest, nonTerminal: true },
      };
    }

    if (status.status === 'finalized') {
      // The hash is already durable (prepare). Apply evidence through the reconcile path.
      this.store.reconcile({
        paymentDigest: digest,
        transaction: txHash,
        observed: 'finalized',
        evidenceSource: `${this.signer.info().address}/signer-finalization`,
        evidenceDigest: evidenceDigestOf({ txHash, status: status.status }),
      });
      return {
        success: true,
        transaction: txHash,
        network: this.network,
        payer: this.payerOf(payload),
        extra: { digest, simulated: true, finality: 'finalized' },
      };
    }

    if (status.status === 'failed') {
      this.store.reconcile({
        paymentDigest: digest,
        transaction: txHash,
        observed: 'failed',
        evidenceSource: `${this.signer.info().address}/signer-finalization`,
        evidenceDigest: evidenceDigestOf({ txHash, status: status.status }),
      });
      return this.fail('transaction_failed', 'the transaction was finalized as failed', { digest, transaction: txHash });
    }

    // committed / pending: not final. Non-terminal, no retry.
    this.store.markPending(digest, txHash, `observed ${status.status}`);
    return {
      success: false,
      errorReason: 'settlement_pending',
      errorMessage: `transaction ${txHash} is ${status.status}, not finalized`,
      transaction: txHash,
      network: this.network,
      extra: { digest, nonTerminal: true },
    };
  }

  // ─── TASK 52: restart recovery ────────────────────────────────────────

  /**
   * Recover payments that have a persisted transaction hash but no confirmed finalization.
   *
   * Rules, in order:
   *   1. Never call `submitTransaction`. Recovery only polls the node by hash.
   *   2. A `submitting` row is first advanced to `outcome_unknown` (broadcast may or may not
   *      have reached the node). This is the same transition the normal settle path uses when
   *      it sees a `submitting` row after a crash.
   *   3. Only the recorded hash is polled; a caller-supplied hash can never override it.
   *   4. `finalized` is applied only through `reconcile()` (the only path to `finalized`).
   *   5. A transport error, timeout, or malformed status is non-terminal: the row stays
   *      pending/observed/recovery_unavailable and is never reported as success.
   *   6. Repeated recovery is idempotent: terminal rows are skipped; non-terminal rows are
   *      re-polled and never create a new submission record.
   */
  async recoverPending(): Promise<RecoverySummary> {
    const summary: RecoverySummary = {
      scanned: 0,
      finalized: 0,
      failed: 0,
      pending: 0,
      transportErrors: 0,
      skipped: 0,
    };
    const rows = this.store.listRecoverable();
    for (const row of rows) {
      summary.scanned++;
      const hash = row.tx_hash;
      if (!hash) {
        summary.skipped++;
        continue;
      }
      // A crash between claimSubmit() and markBroadcast() leaves `submitting`. The broadcast
      // may or may not have happened; the correct durable interpretation is ambiguous.
      if (row.state === 'submitting') {
        try {
          this.store.markBroadcast(row.payment_digest, hash);
        } catch {
          // A concurrent recovery already advanced it; continue with the hash.
        }
      }

      let observed:
        | { txHash: string; status: 'pending' | 'committed' | 'finalized' | 'failed'; sender: string; simulated: true }
        | { txHash: string; status: 'finalized' | 'failed'; sender: string; simulated: true };
      try {
        observed = await this.signer.waitForFinalization(hash, this.finalizationTimeoutMs);
      } catch (e) {
        // Ambiguous outcome: the node may still have the transaction. Never resubmit.
        try {
          this.store.markPending(
            row.payment_digest,
            hash,
            `recovery transport error: ${(e as Error)?.message ?? String(e)}`,
          );
        } catch {
          // A concurrent recovery already advanced it; leave the state as it is.
        }
        summary.transportErrors++;
        continue;
      }

      try {
        if (observed.status === 'finalized') {
          const r = this.store.reconcile({
            paymentDigest: row.payment_digest,
            transaction: hash,
            observed: 'finalized',
            evidenceSource: `${this.signer.info().address}/recovery`,
            evidenceDigest: evidenceDigestOf({ txHash: hash, status: 'finalized' }),
          });
          if (r.ok) summary.finalized++;
        } else if (observed.status === 'failed') {
          const r = this.store.reconcile({
            paymentDigest: row.payment_digest,
            transaction: hash,
            observed: 'failed',
            evidenceSource: `${this.signer.info().address}/recovery`,
            evidenceDigest: evidenceDigestOf({ txHash: hash, status: 'failed' }),
          });
          // TASK 59: only count the rejection as terminal when the confirmation gate
          // actually advanced the state. A recorded-but-unconfirmed observation is
          // evidence, not a terminal failure.
          if (r.ok && r.changed) summary.failed++;
        } else {
          // pending / committed: not final. Record the observation without advancing state.
          this.store.markPending(
            row.payment_digest,
            hash,
            `recovery observed ${observed.status}`,
          );
          summary.pending++;
        }
      } catch {
        // Illegal transition or concurrent change: never convert an ambiguity into success.
        summary.skipped++;
      }
    }
    return summary;
  }

  /** Alias for callers that prefer the shorter name. */
  async recover(): Promise<RecoverySummary> {
    return this.recoverPending();
  }

  /** Alias for callers that prefer the explicit name. */
  async recoverSettlements(): Promise<RecoverySummary> {
    return this.recoverPending();
  }

  /**
   * Reconciliation is NOT exposed here. It requires authenticate → verify evidence → apply,
   * which lives in `ReconciliationService`. Kept as a private reference so nothing can call a
   * bare "set finalized" shortcut.
   */
  private unreachableReconcile(digest: string) {
    return digest;
  }

  // ─── validation helpers ───────────────────────────────────────────────

  private parseEnvelope(body: unknown):
    | { ok: true; payload: Record<string, any>; requirements: Record<string, any> }
    | { ok: false; reason: string } {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'body is not an object' };
    const b = body as Record<string, unknown>;
    if (b['x402Version'] !== X402_VERSION) {
      return { ok: false, reason: `unsupported x402Version ${String(b['x402Version'])} (expected ${X402_VERSION})` };
    }
    const payload = b['paymentPayload'];
    const requirements = b['paymentRequirements'];
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'paymentPayload is missing or not an object' };
    if (!requirements || typeof requirements !== 'object') return { ok: false, reason: 'paymentRequirements is missing or not an object' };
    if (!(payload as Record<string, unknown>)['payload'] || typeof (payload as Record<string, unknown>)['payload'] !== 'object') {
      return { ok: false, reason: 'paymentPayload.payload is missing or not an object' };
    }
    return { ok: true, payload: payload as Record<string, any>, requirements: requirements as Record<string, any> };
  }

  private checkAgreement(payload: Record<string, any>, requirements: Record<string, any>): { ok: true } | { ok: false; reason: string } {
    const accepted = payload['accepted'];
    if (!accepted || typeof accepted !== 'object') return { ok: false, reason: 'paymentPayload.accepted is missing' };

    if (requirements['scheme'] !== 'exact') return { ok: false, reason: `unsupported scheme '${String(requirements['scheme'])}'` };
    if (requirements['network'] !== this.network) {
      return { ok: false, reason: `network '${String(requirements['network'])}' is not served here (${this.network})` };
    }
    for (const field of ['scheme', 'network', 'asset', 'amount', 'payTo'] as const) {
      if (String(accepted[field]) !== String(requirements[field])) {
        return { ok: false, reason: `${field} mismatch: accepted=${String(accepted[field])} required=${String(requirements[field])}` };
      }
    }
    return { ok: true };
  }

  private checkExpiry(payload: Record<string, any>, requirements: Record<string, any>): { ok: true } | { ok: false; reason: string } {
    const nowSec = Math.floor(this.now() / 1000);
    const raw = payload?.['payload']?.signedTransaction?.header?.expiry;
    if (raw === undefined || raw === null) return { ok: true };
    const expiry = Number(raw);
    if (!Number.isFinite(expiry)) return { ok: false, reason: `expiry is not a number: ${String(raw)}` };
    if (expiry <= nowSec) return { ok: false, reason: `payment expired at ${expiry} (now ${nowSec})` };

    const maxTimeout = Number(requirements['maxTimeoutSeconds'] ?? MAX_EXPIRY_OFFSET_SECONDS);
    const bound = Math.min(MAX_EXPIRY_OFFSET_SECONDS, Number.isFinite(maxTimeout) ? maxTimeout : MAX_EXPIRY_OFFSET_SECONDS);
    if (expiry > nowSec + bound) {
      return { ok: false, reason: `expiry ${expiry} is more than ${bound}s in the future (spec rule 7)` };
    }
    return { ok: true };
  }

  private payerOf(payload: Record<string, any>): string | undefined {
    const sender = payload?.['payload']?.signedTransaction?.header?.sender;
    return typeof sender === 'string' ? sender : undefined;
  }

  private fail(errorReason: string, errorMessage: string, extra: Record<string, unknown> = {}): SettleBody {
    return { success: false, errorReason, errorMessage, transaction: '', network: this.network, extra: { simulated: true, ...extra } };
  }
}

function resourceUrlOf(payload: Record<string, any>): string | undefined {
  const url = payload?.['resource']?.url;
  return typeof url === 'string' ? url : undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`finalization exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
