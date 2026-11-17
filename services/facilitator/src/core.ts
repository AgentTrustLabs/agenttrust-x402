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
import {
  RepositorySettlementStateReader,
  SqliteOwnerAuthorizationRepository,
} from './ownerAuthorizationRepository.js';
import { SIMPLE_TRANSFER_BASE_COST, ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG } from './energy.js';
import { convertV2ToSdkV1 } from './wireConverter.js';
import { signingDigestOf, transactionEnergyOf } from './signingService.js';
import type { OwnerAuthorizationCertificate } from './ownerAuthorization.js';
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
   * TEST ONLY: SIGKILL the process at the named point. Used by the crash-window
   * harness to terminate a real OS process at an exact boundary. Never set outside tests.
   */
  dieAt?: 'after-claim' | 'after-sponsor-sign' | 'after-hash' | 'after-persist' | 'before-submit' | 'after-submit';
  /** Path to the SQLite file. Defaults to :memory: for tests. */
  dbPath?: string;
  /** Permission bits for the settlement database file (and WAL/-shm). Defaults to 0600. */
  dbFileMode?: number;
  authorization?: AuthorizationClient;
  /**
   * Sponsor energy cap for the authorization boundary. Defaults to 1_000n.
   * The owner re-derives this from its own policy; the value here only affects the local
   * mock-only client. Aligned with FACILITATOR_MAX_ENERGY default (see config.ts).
   */
  maxAuthorizationEnergy?: bigint;
  /**
   * Maximum execution energy accepted by the wire converter. Defaults to 1_000.
   * This is the converter's own policy cap; the authorization owner enforces the
   * authoritative cap independently. Aligned with FACILITATOR_MAX_ENERGY default.
   */
  maxWireEnergy?: number;
  /**
   * Maximum sponsor fee (microCCD) accepted per settlement, as an ESTIMATE-based
   * policy (recomputed energy x the fixed estimate rate — see `energy.ts`).
   * Defaults to 10_000_000n (10 CCD). This is NOT a guaranteed maximum actual
   * chain fee. Enforced by the core itself, in the facilitator's own validation
   * path, against the same conservative fee estimate handed to the signer — so
   * the cap binds even when the signer omits validateContext (mock signers).
   * Aligned with FACILITATOR_MAX_FEE_MICROCCD default (see config.ts).
   */
  maxFeeMicroCcd?: bigint;
  /**
   * Wire converter seam. Defaults to the real `convertV2ToSdkV1`. Tests may
   * inject an instrumented converter to prove ordering (convert-before-sign, and
   * zero conversions when authorization is refused).
   */
  wireConverter?: (input: unknown, policy: WireConversionPolicy) => ReturnType<typeof convertV2ToSdkV1>;
  /**
   * Sender signature verifier. Defaults to a pass-through (mock-only) so existing
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

  /**
   * Whether this core's settlements are simulated. Read from the signer's
   * `simulated` flag; a signer that omits it is treated as simulated — the
   * burden is on a real signer to declare itself real. Mock and ledger signers
   * declare `true`; the IPC signer declares `false`.
   */
  private simulatedFlag(): boolean {
    return this.signer.simulated ?? true;
  }
  private readonly network: string;
  private readonly signer: SponsorSigner;
  private readonly now: () => number;
  private readonly finalizationTimeoutMs: number;
  private readonly dieAt: CoreOptions['dieAt'];
  private readonly maxWireEnergy: number;
  private readonly maxFeeMicroCcd: bigint;
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
        ...(opts.dbFileMode !== undefined ? { fileMode: opts.dbFileMode } : {}),
      });
    // The authorization boundary. When none is injected, fall back to the local
    // mock-only client bound to an ephemeral in-memory Owner-private repository
    // and a read-only view of this facilitator's own store. An explicit client
    // (e.g. IpcAuthorizationClient) is required for production.
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
        repository: new SqliteOwnerAuthorizationRepository(
          ':memory:',
          new RepositorySettlementStateReader(this.store),
          { now: this.now },
        ),
        now: this.now,
      });
    // Wire conversion policy. The energy cap mirrors the authorization cap; the
    // authoritative energy VALUE comes from the SDK recomputation
    // (`transactionEnergyOf`), never from the client — and never from the
    // JSON-length estimate either (it disagrees with the recomputation).
    this.maxWireEnergy = opts.maxWireEnergy ?? 1_000;
    // Fee cap. Same default as FACILITATOR_MAX_FEE_MICROCCD (10 CCD); the server
    // passes the configured value. Enforced in settle() before signing.
    this.maxFeeMicroCcd = opts.maxFeeMicroCcd ?? 10_000_000n;
    this.wireConverter = opts.wireConverter ?? convertV2ToSdkV1;
    // Default pass-through (mock-only). A real verifier must be injected.
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
      extra: { digest, simulated: this.simulatedFlag(), canSign: this.signer.info().canSign === false ? false : true },
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
          // If the previous process died between submitTransaction() and
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
            extra: { digest, nonTerminal: true, simulated: this.simulatedFlag() },
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
        extra: { digest, idempotentReplay: true, simulated: this.simulatedFlag() },
      };
    }

    // A `resumable` claim means the hash is already durable from a previous,
    // crashed attempt. Skip prepare() (it is already done) and use the persisted hash.
    const resumableHash = guard.claim === 'resumable' ? guard.transaction : null;

    // ── Authorization boundary ────────────────────────────────────────────
    // ORDER: validate → expiry → replay claim → AUTHORIZE → signer. No path reaches
    // `addSponsorSignature()` without an 'approved' outcome from the owner.
    //
    // A `resumable` payment already has a durable approval (it was authorized before the
    // crash that produced the persisted hash), so re-authorizing would be refused by the
    // durable gate. It RECOVERS that approval instead (below): recovery re-validates
    // the approval against the exact transaction context and re-issues its
    // certificate. A consumed approval cannot be recovered — the payment is
    // then stuck in `prepared` until an operator intervenes (see the
    // report's known limitations).
    // ── Sender signature verification (BEFORE authorization) ────────────────
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

    // The authoritative execution energy, derived from the transaction itself by
    // the energy policy. Hoisted so the wire converter can consume the SAME value the
    // authorization boundary priced — a client-supplied energy never becomes the policy
    // decision.
    // ── Wire conversion (BEFORE authorization) ────────────────────────────────
    // ORDER: validate → claim → sender-verify → CONVERT → authorize → signer →
    // hash → submit. (conversion moved BEFORE the authorization
    // boundary.) The authorization must bind the EXACT transaction — its digest
    // and type exist only after conversion — so a conversion failure fails
    // closed here: the signer is never invoked and no authorization is recorded.
    // The converter receives the policy-derived energy, never a client-supplied value.
    // conversion runs on the RESUMABLE path too: the bare envelope
    // transaction is V2-shaped (no executionEnergyAmount, sponsor as
    // `{address}`), which the SDK cannot parse, so no digest or energy could
    // be computed from it. Converting first makes the authorization bind the
    // same canonical transaction the signer will sign on both paths.
    let converted: SdkV1SignableTransaction | null = null;
    {
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

    // ── The exact transaction the signer will sign ───────────────────────────
    // Both paths: the converted SDK transaction. The signer receives the same
    // canonical transaction the authorization binds, so the digest the
    // signing service recomputes is the digest the Owner certified.
    //
    // the energy is the SDK-RECOMPUTED energy of that exact
    // transaction (`transactionEnergyOf`), on BOTH paths. The resumable path
    // needs it too: recovery re-validates the durable approval against the
    // full transaction context, and the energy is part of that context. It
    // must NOT be `deriveEnergyExposure`'s JSON-length estimate — that value
    // disagrees with the recomputation (596 vs 635 NRG for the standard
    // transfer), and the certificate must bind the energy the signing
    // service actually enforces.
    let txDigest: string;
    let txType: string;
    let txEnergy: bigint;
    try {
      if (converted === null) {
        throw new Error('wire conversion produced no transaction');
      }
      const txForAuth = converted as unknown as Record<string, unknown>;
      txDigest = signingDigestOf(converted);
      txEnergy = transactionEnergyOf(converted) ?? (() => { throw new Error('transaction has no recomputed energy'); })();
      txType = String((txForAuth['payload'] as Record<string, unknown> | undefined)?.['type'] ?? '');
    } catch (e) {
      this.store.markFailed(digest, `authorization digest failed: ${(e as Error).message}`);
      return this.fail('authorization_failed', `could not compute the transaction digest for authorization: ${(e as Error).message}`, { digest });
    }
    if (txType === '') {
      this.store.markFailed(digest, 'authorization: transaction type missing');
      return this.fail('authorization_failed', 'transaction type is missing from the transaction', { digest });
    }

    // ── Authorization boundary ────────────────────────────────────────────────
    // The Owner must explicitly approve THIS exact transaction: the
    // authorization is bound to the transaction digest, sender, sponsor,
    // recipient, amount, network, type, energy and fee policy .
    // The approval is recorded durably BEFORE the signer is invoked, and the
    // certificate the Owner issues is the verifiable evidence the signing
    // service verifies and consumes before signing.
    const requirementsAny = requirements as Record<string, unknown>;
    const acceptedAny = (payload['accepted'] ?? {}) as Record<string, unknown>;
    const preimage = payload['payload']?.signedTransaction;
    const header = (preimage as Record<string, unknown>)['header'] as Record<string, unknown>;
    const authRequest: AuthorizationRequest = {
      paymentDigest: digest,
      network: this.network,
      version: 1,
      sender: String(header['sender']),
      sponsor: String((requirementsAny['extra'] as Record<string, unknown> | undefined)?.['feePayer'] ?? this.signer.info().address),
      // The authorization must name the recipient the signed transaction actually
      // pays — not merely the claimed one. checkAgreement already binds the two for
      // transfer-family payloads; using the signed recipient here keeps the durable
      // authorization record bound to the ground truth even if the agreement check
      // is ever bypassed. Non-transfer payloads have no signed recipient; fall back
      // to the accepted payTo (the x402 payee).
      recipient: String(this.signedRecipientOf(payload) ?? acceptedAny['payTo']),
      asset: String(acceptedAny['asset']),
      amount: String(acceptedAny['amount']),
      expiry: Number(header['expiry']),
      energy: txEnergy,
      // the authorization binds the exact transaction.
      transactionDigest: txDigest,
      transactionType: txType,
      maxFeeMicroCcd: String(this.maxFeeMicroCcd),
    };

    // A recovery that did not approve returns the failure result; a matching
    // approval returns null so the caller continues. Shared by the resumable
    // path and by the already-recorded branch below.
    const handleRecoverOutcome = (
      recovered: Awaited<ReturnType<AuthorizationClient['recover']>>,
    ): SettleBody | null => {
      if (recovered.outcome === 'approved') return null;
      this.store.markFailed(digest, `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'}`);
      const nonTerminal = recovered.outcome === 'unknown' || recovered.outcome === 'owner_unavailable';
      if (nonTerminal) {
        return {
          success: false,
          errorReason: 'settlement_pending',
          errorMessage: `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'} — reconcile before retrying`,
          transaction: 'unknown',
          network: this.network,
          extra: { digest, nonTerminal: true, authorizationOutcome: recovered.outcome, simulated: this.simulatedFlag() },
        };
      }
      return this.fail('authorization_rejected', `authorization recovery ${recovered.outcome}: ${recovered.reason ?? 'no reason'}`, {
        digest,
        authorizationOutcome: recovered.outcome,
      });
    };

    let certificate: OwnerAuthorizationCertificate | undefined;
    if (resumableHash) {
      // A resumable payment already has a durable approval: recover it (and
      // its certificate) instead of authorizing anew. Recovery re-validates
      // the approval against the exact transaction context, so a tampered or
      // different transaction cannot reuse the first attempt's approval.
      let recovered: Awaited<ReturnType<AuthorizationClient['recover']>>;
      try {
        recovered = await this.authorization.recover(authRequest);
      } catch (e) {
        this.store.markFailed(digest, `authorization recovery threw: ${(e as Error).message}`);
        return this.fail('authorization_failed', `authorization recovery error: ${(e as Error).message}`, { digest });
      }
      const recoverFailure = handleRecoverOutcome(recovered);
      if (recoverFailure !== null) return recoverFailure;
      certificate = recovered.certificate ?? undefined;
    } else {
      let auth: Awaited<ReturnType<AuthorizationClient['authorize']>>;
      try {
        auth = await this.authorization.authorize(authRequest);
      } catch (e) {
        this.store.markFailed(digest, `authorization threw: ${(e as Error).message}`);
        return this.fail('authorization_failed', `authorization client error: ${(e as Error).message}`, { digest });
      }

      if (auth.outcome !== 'approved') {
        // A prior approval was recorded. Do NOT trust the reason code alone.
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
          const recoverFailure = handleRecoverOutcome(recovered);
          if (recoverFailure !== null) return recoverFailure;
          // Recovered: a matching durable approval exists. Continue with the signer.
          certificate = recovered.certificate ?? undefined;
        } else {
          // Never reach the signer. The payment is recorded as terminally rejected for this
          // payload, so a retry requires a new payload.
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
              extra: { digest, nonTerminal: true, authorizationOutcome: auth.outcome, simulated: this.simulatedFlag() },
            };
          }
          return this.fail(errorReason, `authorization ${auth.outcome}: ${auth.reason ?? 'no reason'}`, {
            digest,
            authorizationOutcome: auth.outcome,
          });
        }
      } else {
        certificate = auth.certificate ?? undefined;
      }
    }

    // an approval without a certificate is a gap, not an approval.
    // The signing service verifies and consumes the certificate; without it
    // there is no verifiable authorization evidence to hand the signer.
    if (!certificate) {
      this.store.markFailed(digest, 'authorization approved without a certificate');
      return this.fail('authorization_failed', 'Owner approved without an authorization certificate', { digest });
    }

    // TEST ONLY: terminate at the requested boundary.
    if (this.dieAt === 'after-claim') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }

    // ── submission. The mock cannot sign; nothing here reaches a chain. ──
    // Ordering (closes the crash window):
    //   1. complete preparation (already done — claim + agreement + expiry + replay)
    //   2. obtain the sponsor signature (the mock marks the tx; real signer would sign)
    //   3. calculate the final transaction hash from the fully signed tx
    //   4. durably persist the hash (prepared → hash bound) BEFORE any broadcast
    //   5. take the broadcast claim (prepared → submitting)
    //   6. only then call submitTransaction()
    //   7. record the broadcast (submitting → outcome_unknown)
    //   8. compare the returned hash to the persisted one; mismatch → never finalize
    let txHash: string;
    // The signer receives the canonical SDK V1 wire object (`converted`), on
    // both paths — the resumable path converts the envelope the same way, so
    // the re-sign reproduces the transaction the persisted hash commits to.
    // Fee/energy context validation, actually invoked before signing.
    // The core-level fee cap binds here, in the facilitator's own validation path,
    // whether or not the signer exposes validateContext (mock signers omit it, so
    // without this check the configured fee cap would be unenforced in mock flows).
    // The signer's own validateContext (real/IPC signers) then re-checks the same
    // estimate against the same configured cap — the two can never disagree.
    if (!resumableHash) {
      // Fee estimate — ESTIMATE-based policy only (see `energy.ts`): energy x the
      // fixed estimate rate, slightly above the measured Testnet rate
      // (7939.534 microCCD/NRG). This is NOT a guaranteed maximum actual chain
      // fee: the actual fee is energy x the chain's EUR-denominated energy price,
      // which moves with the CCD/EUR exchange rate, and no current rate is
      // available at this boundary. The cap therefore refuses transactions whose
      // ESTIMATED fee exceeds it; passing the estimate does not prove the
      // on-chain fee stays under the cap. Integer-safe (bigint). The signing
      // service re-derives the same estimate from the transaction it hashes, so
      // the two can never disagree about the fee model.
      const feeEstimate = txEnergy * ESTIMATED_SPONSOR_FEE_MICROCCD_PER_NRG;
      if (feeEstimate > this.maxFeeMicroCcd) {
        this.store.markFailed(digest, `estimated fee ${feeEstimate} exceeds cap ${this.maxFeeMicroCcd}`);
        return this.fail('fee_validation_failed', `estimated fee ${feeEstimate} exceeds cap ${this.maxFeeMicroCcd}`, { digest });
      }
      if (typeof this.signer.validateContext === 'function') {
        // The recipient validated here is the PAYEE of the signed transaction — the
        // account that actually receives the funds — never the sender. The sender is
        // validated separately (sender signature verification above, and the
        // authorization boundary's sponsor!=sender check). Passing the sender here
        // made the signer's sponsor!=recipient check compare the wrong pair of
        // parties: it could pass a payment whose real recipient IS the sponsor, and
        // it could fail a payment whose sender merely equals the sponsor (already
        // rejected at authorization). Non-transfer payloads carry no signed
        // recipient; fall back to the accepted payTo (the x402 payee).
        const accepted = (payload['accepted'] ?? {}) as Record<string, unknown>;
        const recipient =
          this.signedRecipientOf(payload) ??
          (typeof accepted['payTo'] === 'string' ? accepted['payTo'] : '');
        if (recipient === '') {
          this.store.markFailed(digest, 'no usable recipient for fee validation');
          return this.fail('fee_validation_failed', 'no usable recipient for fee validation', { digest });
        }
        const vctx = this.signer.validateContext({
          network: this.network,
          sponsor: this.signer.info().address,
          recipient,
          energy: txEnergy,
          feeMicroCcd: feeEstimate,
        });
        if (vctx !== null) {
          this.store.markFailed(digest, `fee validation failed: ${vctx}`);
          return this.fail('fee_validation_failed', vctx, { digest });
        }
      }
    }

    const signerInput = converted ?? payload.payload;
    // the Owner authorization certificate and its payment digest
    // ride with the signing call. A real signer forwards both to the signing
    // service, which verifies and consumes the authorization before signing.
    // The digest passed here is the digest of the exact transaction above —
    // the service re-computes it from the parsed transaction and rejects any
    // mismatch. On the resumable path `converted` is the same canonical
    // transaction the first attempt signed, so the re-sign is deterministic
    // and reproduces the persisted hash.
    const sponsored = await this.signer.addSponsorSignature(signerInput, {
      authorization: certificate,
      paymentDigest: digest,
    });
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
      // A `submitting` row means the previous process took the broadcast claim
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
        extra: { digest, nonTerminal: true, simulated: this.simulatedFlag() },
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
        extra: { digest, nonTerminal: true, hashMismatch: true, simulated: this.simulatedFlag() },
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
        extra: { digest, nonTerminal: true, simulated: this.simulatedFlag() },
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
        extra: { digest, simulated: this.simulatedFlag(), finality: 'finalized' },
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
      extra: { digest, nonTerminal: true, simulated: this.simulatedFlag() },
    };
  }

  // ─── Restart recovery ────────────────────────────────────────

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
        | { txHash: string; status: 'pending' | 'committed' | 'finalized' | 'failed'; sender: string; simulated: boolean }
        | { txHash: string; status: 'finalized' | 'failed'; sender: string; simulated: boolean };
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
          // Only count the rejection as terminal when the confirmation gate
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
    // F5 — amount binding. `accepted` and `requirements` are both client-supplied,
    // so their agreement proves nothing about what the sender actually signed. The
    // signed transaction is the only source of truth for the transfer value: bind
    // the amount recorded in the sign event (and later in the authorization
    // request) to the amount in the signed transaction. Only transfer-family
    // payloads carry a transfer amount; other transaction kinds have no amount
    // to bind, so the check is skipped for them (documented limit: the recorded
    // amount for a non-transfer payment is the asserted amount). Comparison is
    // numeric (BigInt), so leading zeros do not matter.
    const signedTx = payload?.['payload']?.signedTransaction;
    const signedPayload = signedTx?.['payload'];
    const kind = signedPayload?.['type'];
    if (signedTx && typeof signedTx === 'object' && signedPayload && typeof signedPayload === 'object'
        && (kind === 'transfer' || kind === 'transferWithMemo' || kind === 3)) {
      const asDigits = (v: unknown): string | null => {
        if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v;
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
        return null;
      };
      const signedAmount = asDigits(signedPayload['amount']);
      const acceptedAmount = asDigits(accepted['amount']);
      if (signedAmount === null) {
        return { ok: false, reason: 'signed transaction has no usable transfer amount' };
      }
      if (acceptedAmount === null) {
        return { ok: false, reason: 'accepted amount is not a non-negative integer' };
      }
      if (BigInt(signedAmount) !== BigInt(acceptedAmount)) {
        return { ok: false, reason: `amount mismatch: signed=${signedAmount} accepted=${acceptedAmount}` };
      }
    }
    // F5b — recipient binding. Same reasoning as the amount binding (F5): `accepted`
    // and `requirements` are both client-supplied, so their agreement proves nothing
    // about where the sender's signed transaction actually sends the funds. Bind the
    // recipient in the signed transaction to the accepted payTo (which the loop above
    // already bound to the required payTo). Without this, a payload whose signed
    // `toAddress` differs from `payTo` passes agreement, gets authorized for the
    // claimed recipient, and settles to the wrong address — the sponsor fee is
    // burned on a transfer the provider never asked for. Only transfer-family
    // payloads carry a transfer recipient; other transaction kinds have no recipient
    // to bind, so the check is skipped for them (same documented limit as F5).
    // Comparison is exact-string: a Concordium base58check address has one canonical
    // form, and the provider's published payTo IS that form, so any other string —
    // including a case/whitespace variant — is a different (or malformed) recipient
    // and fails closed here.
    if (signedTx && typeof signedTx === 'object' && signedPayload && typeof signedPayload === 'object'
        && (kind === 'transfer' || kind === 'transferWithMemo' || kind === 3)) {
      const toAddress = signedPayload['toAddress'];
      if (typeof toAddress !== 'string' || toAddress.length === 0) {
        return { ok: false, reason: 'signed transaction has no usable transfer recipient' };
      }
      const acceptedPayTo = accepted['payTo'];
      if (typeof acceptedPayTo !== 'string' || acceptedPayTo.length === 0) {
        return { ok: false, reason: 'accepted payTo is not a usable recipient' };
      }
      if (toAddress !== acceptedPayTo) {
        return { ok: false, reason: `recipient mismatch: signed=${toAddress} accepted=${acceptedPayTo}` };
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

  /**
   * The recipient the signed transaction actually pays, for transfer-family
   * payloads. Returns undefined when the signed payload is absent, is not an
   * object, is not transfer-family, or carries no usable string toAddress.
   * Callers that need a recipient for non-transfer payloads fall back to the
   * accepted payTo (the x402 payee). This is the ground truth for "who receives
   * the funds"; the accepted payTo is only the claim.
   */
  private signedRecipientOf(payload: Record<string, any>): string | undefined {
    const signedPayload = payload?.['payload']?.signedTransaction?.['payload'];
    if (!signedPayload || typeof signedPayload !== 'object') return undefined;
    const kind = signedPayload['type'];
    if (kind !== 'transfer' && kind !== 'transferWithMemo' && kind !== 3) return undefined;
    const toAddress = signedPayload['toAddress'];
    return typeof toAddress === 'string' && toAddress.length > 0 ? toAddress : undefined;
  }

  private fail(errorReason: string, errorMessage: string, extra: Record<string, unknown> = {}): SettleBody {
    return { success: false, errorReason, errorMessage, transaction: '', network: this.network, extra: { simulated: this.simulatedFlag(), ...extra } };
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
