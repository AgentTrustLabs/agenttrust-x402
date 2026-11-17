/**
 * Shared Owner-authorization test helper .
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
 *    `SqliteSettlementRepository` (temp file, facilitator settlement state),
 *    a REAL `SqliteOwnerAuthorizationRepository` (separate temp file,
 *    Owner-private authorization state — the split), a
 *    `LocalAuthorizationClient` (the mock Owner: durable gate + real
 *    certificates) and a consume client backed by the Owner repository's
 *    atomic `consumeAuthorization`. Consume/revoke/single-use/restart
 *    behavior in tests built on this is the production code path, not a stub.
 *    The Owner repository reads settlement state through an in-process
 *    read-only view of the settlement repository — the same interface the
 *    production Owner uses over its read-only SQLite open.
 *
 * No real signing, no key material on disk beyond the temp test dir
 * (removed by `close()`), no broadcast.
 */
import { mkdtempSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
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
import {
  RepositorySettlementStateReader,
  SqliteOwnerAuthorizationRepository,
  type OwnerAuthorizationRepository,
} from '../services/facilitator/src/ownerAuthorizationRepository.js';
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

/**
 * Open the Owner-private repository paired with a settlement database
 * file . The Owner file is derived deterministically
 * from the settlement path (`<settlement-db>.owner.db`) so a reopen finds
 * the same authorization state. The reader is an in-process read-only
 * view of the given settlement repository — the same interface the
 * production Owner uses over its read-only SQLite open.
 */
export function ownerRepoFor(
  dbPath: string,
  settlementRepo: SqliteSettlementRepository,
  now: () => number,
): SqliteOwnerAuthorizationRepository {
  return new SqliteOwnerAuthorizationRepository(`${dbPath}.owner.db`, new RepositorySettlementStateReader(settlementRepo), { now });
}

/**
 * seed a facilitator settlement database directly (the Owner
 * never writes it; AUTHZ_SEED_FIXTURES was removed). Opens the settlement
 * repository, drives each digest to `created` (verified → claimed, NULL
 * hash), then closes. Closing the last connection checkpoints the WAL and
 * removes the -wal/-shm files, so a different-UID Owner process can open
 * the file read-only without -shm write access. `fileMode` (default 0o644)
 * is applied to the database file after close so the Owner UID can read it
 * without being able to write it.
 */
export function seedSettlementDb(
  dbPath: string,
  digests: string[],
  now: () => number,
  fileMode = 0o644,
): void {
  const repo = new SqliteSettlementRepository(dbPath, { now });
  for (const d of digests) {
    repo.noteVerified(d, 'k');
    repo.claim(d, 'k');
  }
  repo.close();
  chmodSync(dbPath, fileMode);
}
export function fakeConsumedClient(): OwnerConsumeClient {
  return {
    async consume(): Promise<OwnerConsumeResponse> {
      return { outcome: 'consumed', reason: null, detail: 'consumed (test fake)' };
    },
  };
}

/**
 * A consume client backed by a REAL Owner repository: the production atomic
 * consume path. The response mapping is the Owner launcher's mapping.
 */
export function repositoryConsumeClient(repo: OwnerAuthorizationRepository): OwnerConsumeClient {
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
 * A full test Owner: ephemeral keypair, real settlement repository (temp
 * file) + real Owner-private repository (separate temp file),
 * LocalAuthorizationClient (durable gate + real certificates), and a
 * repository-backed consume client. `ownerAuthorization` is exactly what
 * `createSigningService` needs.
 */
export function makeTestOwner(opts: TestOwnerOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-authz-'));
  const dbPath = join(dir, 'test.db');
  // the Owner-private database lives in its own subdirectory so
  // a real Owner process can serve it (the launcher requires the Owner DB
  // inside the Owner dir and the settlement DB in a DIFFERENT directory).
  const ownerDir = join(dir, 'owner');
  mkdirSync(ownerDir, { mode: 0o700 });
  const ownerDbPath = join(ownerDir, 'owner.db');
  const now = opts.now ?? (() => Date.now());
  const repo = new SqliteSettlementRepository(dbPath, { now });
  const ownerRepo = new SqliteOwnerAuthorizationRepository(ownerDbPath, new RepositorySettlementStateReader(repo), { now });
  const authorization = new LocalAuthorizationClient({
    policy: {
      network: opts.network,
      sponsor: opts.sponsor,
      maxEnergy: opts.maxEnergy ?? 10000n,
      maxExpiryOffsetSeconds: 600,
      allowedAssets: ['CCD'],
      policyVersion: opts.policyVersion ?? 'test-v1',
    },
    repository: ownerRepo,
    now,
  });
  const consume = repositoryConsumeClient(ownerRepo);
  return {
    dir,
    dbPath,
    ownerDir,
    ownerDbPath,
    repo,
    ownerRepo,
    authorization,
    consume,
    ownerAuthorization: { publicKey: authorization.authorizationPublicKeyHex(), consume },
    /** Seed a payment the way the facilitator does (verified → claimed). */
    seedPayment(paymentDigest: string) {
      repo.noteVerified(paymentDigest, 'k');
      repo.claim(paymentDigest, 'k');
    },
    close() {
      try { ownerRepo.close(); } catch { /* already closed */ }
      try { repo.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type TestOwner = ReturnType<typeof makeTestOwner>;
