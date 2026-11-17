/**
 * Shared Owner-authorization test helper (Task 11).
 *
 * Two layers, for two test jobs:
 *
 * 1. Lightweight certificate issuance — `makeTestOwnerKey`,
 *    `issueTestCertificate`, `certFieldsForTx`, `fakeConsumedClient`.
 *    For suites that test the SIGNING boundary (digest ↔ transaction
 *    binding, recipient/amount/energy/fee policy): the certificate is
 *    issued directly by an ephemeral test keypair and the consume client
 *    always reports 'consumed', so the test reaches the signing
 *    validation it owns. The real consume semantics live in the new
 *    `owner-authorization-binding` suite, not here.
 *
 * 2. Full real-repo Owner — `makeTestOwner`. An ephemeral keypair, a REAL
 *    `SqliteSettlementRepository` (temp file), a `LocalAuthorizationClient`
 *    (the mock Owner: durable gate + real certificates) and a consume
 *    client backed by the repository's atomic `consumeAuthorization`.
 *    Consume/revoke/single-use/restart behavior in tests built on this
 *    is the production code path, not a stub.
 *
 * No real signing, no key material on disk beyond the temp test dir
 * (removed by `close()`), no broadcast.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@concordium/web-sdk';
import {
  generateOwnerAuthorizationKeyPair,
  issueOwnerAuthorizationCertificate,
  ownerAuthorizationPublicKeyHex,
  type OwnerAuthorizationCertificate,
  type OwnerAuthorizationFields,
  type OwnerConsumeClient,
  type OwnerConsumeResponse,
} from '../services/facilitator/src/ownerAuthorization.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { signingDigestOf } from '../services/facilitator/src/signingService.js';

/** Ephemeral Owner authorization keypair (never persisted, never logged). */
export function makeTestOwnerKey() {
  const { publicKey, privateKey } = generateOwnerAuthorizationKeyPair();
  return { publicKey, privateKey, publicKeyHex: ownerAuthorizationPublicKeyHex(publicKey) };
}

/** Issue a certificate with a test keypair. The caller owns the fields. */
export function issueTestCertificate(
  privateKey: ReturnType<typeof makeTestOwnerKey>['privateKey'],
  fields: OwnerAuthorizationFields,
): OwnerAuthorizationCertificate {
  return issueOwnerAuthorizationCertificate(fields, privateKey);
}

/**
 * The signing service's recomputed energy for a fixture transaction: the
 * SDK-parsed unsigned header's energy amount. Mirrors
 * `checkTransactionBinding`'s `energyOf(unsigned.header.energyAmount)` —
 * the certificate must name EXACTLY this value, so tests that change the
 * transaction (amount, recipient, memo) must recompute it here instead of
 * reusing a stale constant.
 */
export function recomputedEnergyOf(tx: unknown): bigint {
  const signable = Transaction.signableFromJSON(tx);
  const unsigned = Transaction.preFinalized(signable);
  const v = (unsigned.header as { energyAmount?: unknown }).energyAmount;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (v && typeof v === 'object') {
    const inner = (v as { value?: unknown }).value;
    if (typeof inner === 'bigint') return inner;
    if (typeof inner === 'string' || typeof inner === 'number') return BigInt(inner);
  }
  throw new Error('cannot read recomputed energy from transaction');
}

export interface CertFieldsForTxOptions {
  /** AgentTrust payment digest the authorization belongs to, 64-hex. */
  paymentDigest: string;
  /** Recipient the authorization names (transfer-family: the tx's toAddress). */
  recipient: string;
  /** Amount the authorization names, decimal string. */
  amount: string;
  /** Override the recomputed energy (default: recomputed from the tx). */
  energy?: bigint;
  /** Energy cap the authorization was issued under (default: '10000'). */
  maxEnergy?: string;
  /** Fee cap the authorization was issued under (default: '10000000'). */
  maxFeeMicroCcd?: string;
  /** Policy version recorded in the authorization (default: 'test-v1'). */
  policyVersion?: string;
  /** Issuance time ms (default: Date.now()). */
  issuedAt?: number;
  /** Authorization id (default: a fresh uuid). */
  authorizationId?: string;
  /** Network override (default: the tx carries no network; pass it). */
  network: string;
  /** Sponsor override (default: the tx's sponsor account). */
  sponsor?: string;
}

/**
 * Build the certificate field set for a fixture transaction: digest and
 * type from the transaction itself, sender/sponsor/expiry from its header,
 * recipient/amount/paymentDigest from the caller (the facilitator's
 * authRequest derives those the same way).
 */
export function certFieldsForTx(
  tx: Record<string, unknown>,
  opts: CertFieldsForTxOptions,
): OwnerAuthorizationFields {
  const header = tx['header'] as Record<string, unknown>;
  const payload = tx['payload'] as Record<string, unknown>;
  const sponsorObj = header['sponsor'] as Record<string, unknown>;
  return {
    version: 1,
    authorizationId: opts.authorizationId ?? randomUUID(),
    paymentDigest: opts.paymentDigest,
    transactionDigest: signingDigestOf(tx),
    transactionType: String(payload['type']),
    network: opts.network,
    sender: String(header['sender']),
    sponsor: opts.sponsor ?? String(sponsorObj['account']),
    recipient: opts.recipient,
    asset: 'CCD',
    amount: opts.amount,
    expiry: Number(header['expiry']),
    energy: String(opts.energy ?? recomputedEnergyOf(tx)),
    maxEnergy: opts.maxEnergy ?? '10000',
    maxFeeMicroCcd: opts.maxFeeMicroCcd ?? '10000000',
    policyVersion: opts.policyVersion ?? 'test-v1',
    issuedAt: opts.issuedAt ?? Date.now(),
  };
}

/** A consume client that always reports 'consumed' (signing-boundary tests). */
export function fakeConsumedClient(): OwnerConsumeClient {
  return {
    async consume(): Promise<OwnerConsumeResponse> {
      return { outcome: 'consumed', reason: null, detail: 'consumed (test fake)' };
    },
  };
}

/**
 * A consume client backed by a REAL repository: the production atomic
 * consume path. The response mapping is the Owner launcher's mapping.
 */
export function repositoryConsumeClient(repo: SqliteSettlementRepository): OwnerConsumeClient {
  return {
    async consume(req): Promise<OwnerConsumeResponse> {
      const result = repo.consumeAuthorization({
        authorizationId: req.authorizationId,
        transactionDigest: req.transactionDigest,
        paymentDigest: req.context.paymentDigest,
        network: req.context.network,
        sender: req.context.sender,
        sponsor: req.context.sponsor,
        recipient: req.context.recipient,
        asset: req.context.asset,
        amount: req.context.amount,
        expiry: req.context.expiry,
        energy: req.context.energy,
        transactionType: req.context.transactionType,
        maxEnergy: req.context.maxEnergy,
        maxFeeMicroCcd: req.context.maxFeeMicroCcd,
      });
      if (result.ok) return { outcome: 'consumed', reason: null, detail: 'authorization consumed' };
      if (result.reason === 'unknown_authorization') {
        return { outcome: 'unknown', reason: result.reason, detail: 'no such authorization' };
      }
      return { outcome: 'rejected', reason: result.reason, detail: 'authorization cannot be consumed' };
    },
  };
}

export interface TestOwnerOptions {
  sponsor: string;
  network: string;
  maxEnergy?: bigint;
  policyVersion?: string;
  now?: () => number;
}

/**
 * A full test Owner: ephemeral keypair, real repository (temp file),
 * LocalAuthorizationClient (durable gate + real certificates), and a
 * repository-backed consume client. `ownerAuthorization` is exactly what
 * `createSigningService` needs.
 */
export function makeTestOwner(opts: TestOwnerOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'task11-owner-'));
  const dbPath = join(dir, 'test.db');
  const now = opts.now ?? (() => Date.now());
  const repo = new SqliteSettlementRepository(dbPath, { now });
  const authorization = new LocalAuthorizationClient({
    policy: {
      network: opts.network,
      sponsor: opts.sponsor,
      maxEnergy: opts.maxEnergy ?? 10000n,
      maxExpiryOffsetSeconds: 600,
      allowedAssets: ['CCD'],
      policyVersion: opts.policyVersion ?? 'test-v1',
    },
    repository: repo,
    now,
  });
  const consume = repositoryConsumeClient(repo);
  return {
    dir,
    dbPath,
    repo,
    authorization,
    consume,
    ownerAuthorization: { publicKey: authorization.authorizationPublicKeyHex(), consume },
    /** Seed a payment the way the facilitator does (verified → claimed). */
    seedPayment(paymentDigest: string) {
      repo.noteVerified(paymentDigest, 'k');
      repo.claim(paymentDigest, 'k');
    },
    close() {
      try { repo.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type TestOwner = ReturnType<typeof makeTestOwner>;
