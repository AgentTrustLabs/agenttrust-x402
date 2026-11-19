#!/usr/bin/env node
/**
 * Isolated x402 Concordium facilitator prototype — HTTP surface.
 *
 * Run:  FACILITATOR_MODE=mock node services/facilitator/src/server.ts
 *   or: FACILITATOR_MODE=mock npx tsx services/facilitator/src/server.ts
 *
 * Endpoints: GET /supported, POST /verify, POST /settle, POST /reconcile, GET /healthz
 *
 * This process is deliberately separate from AgentTrust x402. It holds no gateway
 * state and the gateway holds none of its state. In `mock` mode it cannot sign, cannot
 * submit, and binds to loopback only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { statSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { loadConfig, ConfigurationError } from './config.js';
import { GrpcAccountInfoProvider } from './grpcAccountInfoProvider.js';
import { SdkSenderVerifier, type SenderVerificationResult } from './senderVerifier.js';
import { createIpcSponsorSigner } from './ipcSponsorSigner.js';
import { ConcordiumTransactionSubmitter } from './concordiumTransactionSubmitter.js';
import { GrpcConcordiumTransport } from './grpcConcordiumTransport.js';
import type { ConcordiumGrpcClientLike } from './grpcConcordiumTransport.js';
import { probeSigningService } from './signingService.js';
import { createMockSigner, createLedgerSigner, type MockSubmissionBehaviour, type SponsorSigner } from './signer.js';
import { IpcAuthorizationClient } from './authorization.js';
import { FacilitatorCore, type CoreOptions } from './core.js';
import { buildOperatorAuth } from './auth.js';
import { ReconciliationService } from './reconcile.js';
import { getPaymentDetail } from './paymentDetail.js';
import { FixtureEvidenceVerifier, type EvidenceVerifier } from './evidence.js';
import { ConcordiumEvidenceVerifier, type ConcordiumStatusClient } from './concordiumEvidence.js';
import type { FacilitatorConfig } from './config.js';

const MAX_BODY_BYTES = 256 * 1024;

/** Reject an oversized body without buffering it. */
function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  return new Promise(resolve => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // Resolve first and let the caller write the response; destroying here would reset the
      // connection before the client could read the 413. The unread body is drained below.
      resolve({ ok: false, status: 413, message: `body exceeds ${MAX_BODY_BYTES} bytes` });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        // Streaming cap: stop buffering and let the caller answer 413. `pause()` stops reading
        // without resetting the socket, so the client still receives the response.
        done = true;
        req.pause();
        resolve({ ok: false, status: 413, message: `body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({ ok: false, status: 400, message: 'empty body' });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(text) });
      } catch {
        resolve({ ok: false, status: 400, message: 'body is not valid JSON' });
      }
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve({ ok: false, status: 400, message: 'request stream error' });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export interface StartedFacilitator {
  url: string;
  core: FacilitatorCore;
  close: () => Promise<void>;
}

/**
 * Result of inspecting the sponsor wallet export file.
 *
 * Only metadata is inspected. The file contents are never read here and never logged.
 */
export interface WalletFileInspection {
  ok: boolean;
  /** Stable reason code. Never includes file contents or key material. */
  reason?: string;
  /** Observed mode, e.g. "0o600". Safe to log. */
  mode?: string;
}

/**
 * Bound a startup recovery pass so a stalled node cannot delay readiness indefinitely.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Inspect the sponsor wallet export file for safe deployment properties.
 *
 * Enforced:
 *   - the path is absolute and traversal-free (already checked by loadConfig)
 *   - the file exists and is a regular file
 *   - the file is not world-readable and not group-writable
 *   - the file is owned by the current process user (or root, in a root-started deploy)
 *
 * Only `stat` is used. Contents are never opened, so nothing here can leak key material.
 */
export function inspectWalletFile(path: string): WalletFileInspection {
  if (!path.startsWith('/')) return { ok: false, reason: 'wallet file path must be absolute' };
  if (path.split('/').includes('..')) return { ok: false, reason: 'wallet file path must not traverse' };

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, reason: 'wallet file does not exist or is not readable' };
  }
  if (!st.isFile()) return { ok: false, reason: 'wallet file path is not a regular file' };

  const mode = st.mode & 0o777;
  const modeStr = `0o${mode.toString(8).padStart(3, '0')}`;
  if (mode & 0o004) return { ok: false, reason: 'wallet file is world-readable', mode: modeStr };
  if (mode & 0o020) return { ok: false, reason: 'wallet file is group-writable', mode: modeStr };

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid && st.uid !== 0) {
    return { ok: false, reason: 'wallet file is not owned by the service user', mode: modeStr };
  }
  return { ok: true, mode: modeStr };
}

/**
 * F2/F6 — Authorization Owner readiness + storage separation .
 *
 * The owner and the facilitator must authorize against DIFFERENT SQLite
 * files in DIFFERENT directories, owned by different UIDs. The owner
 * reports the resolved path + device + inode of the Owner-private file it
 * opened (db_identity: read-only, creates no state); this compares them
 * with the facilitator's own settlement database file. A MATCH means the
 * shared-database configuration survived — the facilitator could rewrite
 * Owner authorization state — so startup fails closed. An unreachable
 * owner does not fail startup (the owner may legitimately start after
 * the facilitator), but readiness stays unhealthy until it appears.
 *
 * Only file identity is compared and logged (device + inode + resolved
 * path). No payment data, digest, or decision ever leaves either process here.
 */
async function checkOwnerDbSeparation(
  authorization: IpcAuthorizationClient,
  facilitatorDbPath: string,
  timeoutMs: number,
  signingServiceUid: number | null = null,
): Promise<{ reachable: boolean; separated: boolean; ownerDbPath?: string; reason?: string }> {
  const probe = await authorization.probeDbIdentity(timeoutMs);
  if (!probe.reachable) return { reachable: false, separated: false, reason: probe.reason };
  let own: { dev: number; ino: number; dir: string };
  try {
    const resolved = realpathSync(facilitatorDbPath);
    const st = statSync(resolved);
    own = { dev: st.dev, ino: st.ino, dir: dirname(resolved) };
  } catch (e) {
    return { reachable: true, separated: false, ownerDbPath: probe.dbPath, reason: `cannot stat facilitator database: ${(e as Error)?.message ?? e}` };
  }
  const ownerPath = probe.dbPath;
  if (ownerPath === undefined || probe.dbDev === undefined || probe.dbIno === undefined) {
    return { reachable: true, separated: false, ownerDbPath: ownerPath, reason: 'owner db_identity response is missing the database identity' };
  }
  // Same file (same device + inode) is the shared-database configuration.
  if (probe.dbDev === own.dev && probe.dbIno === own.ino) {
    return {
      reachable: true,
      separated: false,
      ownerDbPath: ownerPath,
      reason: 'owner database IS the facilitator database (shared file) — run the the storage migration',
    };
  }
  // Same directory is not separation either: a directory the facilitator
  // can write lets it replace or relink the Owner file.
  if (dirname(ownerPath) === own.dir) {
    return {
      reachable: true,
      separated: false,
      ownerDbPath: ownerPath,
      reason: `owner database lives in the facilitator database directory (${own.dir})`,
    };
  }
  // Distinct UIDs are part of separation, not a separate concern: a
  // facilitator that shares the Owner's UID can read the Owner key and
  // database no matter what the file modes say. The Owner process reports
  // its own UID in db_identity; a missing UID means the deployment cannot
  // be verified, so it fails closed too.
  if (probe.ownerUid === undefined) {
    return {
      reachable: true,
      separated: false,
      ownerDbPath: ownerPath,
      reason: 'owner db_identity response is missing the owner UID — cannot verify UID separation',
    };
  }
  const facilitatorUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (facilitatorUid !== null && probe.ownerUid === facilitatorUid) {
    return {
      reachable: true,
      separated: false,
      ownerDbPath: ownerPath,
      reason: 'owner runs as the facilitator UID — run the Owner as a distinct user',
    };
  }
  if (signingServiceUid !== null && probe.ownerUid === signingServiceUid) {
    return {
      reachable: true,
      separated: false,
      ownerDbPath: ownerPath,
      reason: 'owner runs as the signing-service UID — run the Owner as a distinct user',
    };
  }
  return { reachable: true, separated: true, ownerDbPath: ownerPath };
}

/**
 * Build and start the facilitator. Returns the bound URL so tests can point the gateway's
 * `createHttpFacilitator({ url })` at it.
 */
export async function startFacilitator(
  env: Record<string, string | undefined>,
  opts: {
    behaviour?: MockSubmissionBehaviour;
    /** Evidence verifier for reconciliation. Defaults to an empty fixture table. */
    verifier?: EvidenceVerifier;
    now?: () => number;
    /**
     * TEST ONLY: override the gRPC node client used for the sender-verification
     * account provider and for the V1 submitter. Never used in production; lets wiring
     * tests exercise real-mode startup without contacting a node or broadcasting.
     */
    nodeClient?: ConcordiumGrpcClientLike &
      Pick<ConcordiumGRPCNodeClient, 'getAccountInfo' | 'getConsensusStatus'>;
    /**
     * TEST ONLY: override the wallet-export file inspector so startup tests can
     * exercise ownership/permission checks without real secret material on disk.
     */
    walletFileInspector?: (path: string) => WalletFileInspection;
  } = {},
): Promise<StartedFacilitator> {
  const config = loadConfig(env);
  // The behaviour switch only configures the mock signer, so it cannot change what the
  // IPC-backed signer does. It never enables signing.
  const behaviourFromEnv = process.env['FACILITATOR_BEHAVIOUR'] as MockSubmissionBehaviour | undefined;
  const behaviour = opts.behaviour ?? behaviourFromEnv;

  // Fail closed at startup when the signing service is not reachable. Real mode has
  // no local signing fallback, so booting without the service would only move the failure to
  // the first settlement request.
  if (config.mode === 'real') {
    // If a sponsor wallet export path is configured, verify its deployment
    // properties before anything else. Contents are never read.
    if (config.sponsorWalletFile !== null) {
      const insp = (opts.walletFileInspector ?? inspectWalletFile)(config.sponsorWalletFile);
      if (!insp.ok) {
        throw new ConfigurationError(
          `sponsor wallet file is not deployment-ready: ${insp.reason} (mode=${insp.mode ?? 'unknown'})`,
        );
      }
    }

    const unreachable = await probeSigningService(
      config.signingServiceSocket!,
      config.signingServiceTimeoutMs,
    );
    if (unreachable !== null) {
      throw new ConfigurationError(`${unreachable} (${config.signingServiceSocket})`);
    }
  }

  // Real mode signs through the dedicated signing service over IPC. The
  // facilitator holds no key material in either mode.
  // The V1 submitter is injected here. The signer never builds a transport
  // itself (see ipcSponsorSigner.ts); with no submitter it stays fail-closed, which is
  // exactly the behaviour we want when the node endpoint is absent.
  const submitter =
    config.mode === 'real' && config.nodeHost !== null && config.nodePort !== null
      ? new ConcordiumTransactionSubmitter(
          new GrpcConcordiumTransport(
            opts.nodeClient ??
              (new ConcordiumGRPCNodeClient(
                config.nodeHost,
                config.nodePort,
                config.nodeUseTls ? credentials.createSsl() : credentials.createInsecure(),
              ) as never),
          ),
        )
      : undefined;

  const signer: SponsorSigner =
    config.mode === 'real'
      ? createIpcSponsorSigner({
          sponsorAddress: config.sponsorAddress!,
          network: config.network,
          socketPath: config.signingServiceSocket!,
          expectedUid: config.signingServiceUid!,
          timeoutMs: config.signingServiceTimeoutMs,
          maxEnergy: config.maxEnergy,
          maxFeeMicroCcd: config.maxFeeMicroCcd,
          ...(submitter ? { submitter } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        })
      : config.submitLedgerPath
        // Instrumented variant: identical behaviour, plus an append-only record of every
        // actual submission attempt so multi-process counting is possible.
        ? createLedgerSigner({
            ledgerPath: config.submitLedgerPath,
            network: config.network,
            // same mock-sponsor override as the plain mock
            // signer below (W5's recovery process counts submissions
            // through the ledger, so it takes this branch).
            ...(config.mockSponsorAddress ? { placeholderAddress: config.mockSponsorAddress } : {}),
            ...(config.processLabel ? { label: config.processLabel } : {}),
            ...(behaviour ? { behaviour } : {}),
          })
        : createMockSigner({
            network: config.network,
            // mock-mode test hook (see config): lets a mock-mode
            // facilitator present a valid sponsor address so a real Owner
            // can authorize its simulated settlements (prebroadcast W5).
            // Unset, the mock signer derives its own placeholder as before.
            ...(config.mockSponsorAddress ? { placeholderAddress: config.mockSponsorAddress } : {}),
            ...(behaviour ? { behaviour } : {}),
          });
  // When an Authorization Owner socket is configured, the facilitator speaks the
  // IPC protocol and never opens the authorization database. Real mode requires
  // the socket (loadConfig enforces it), so the local mock-only client is only
  // reachable in mock/test mode. When unset in mock mode the core falls back to
  // the local client, which can never authorize a real settlement.
  const authorization = config.authorizationSocket
    ? new IpcAuthorizationClient(config.authorizationSocket)
    : undefined;

  // ── Production sender verification wiring ────────────────────────
  // Selection rule (fail-closed):
  //   - `real` mode: config.senderVerification MUST be 'sdk' (loadConfig enforced).
  //   - `mock` mode: 'passthrough' is the default; 'sdk' is allowed but never implied.
  // There is no implicit environment fallback that selects passthrough in production.
  let senderVerifier: ((txJson: unknown) => Promise<SenderVerificationResult>) | undefined;
  if (config.senderVerification === 'sdk') {
    if (config.nodeHost === null || config.nodePort === null) {
      throw new ConfigurationError(
        'sdk sender verification requires FACILITATOR_NODE_HOST and FACILITATOR_NODE_PORT',
      );
    }
    let provider: GrpcAccountInfoProvider;
    try {
      provider = new GrpcAccountInfoProvider({
        ...(opts.nodeClient ? { client: opts.nodeClient } : {}),
        host: config.nodeHost,
        port: config.nodePort,
        useTls: config.nodeUseTls,
        network: config.network,
        timeoutMs: config.senderVerificationTimeoutMs,
      });
    } catch (e) {
      throw new ConfigurationError(`failed to construct AccountInfoProvider: ${(e as Error).message}`);
    }
    // Verify the node's genesis hash at startup in real mode. No opt-out.
    // Mock mode never reaches here (senderVerification defaults to passthrough).
    if (config.mode === 'real') {
      try {
        await provider.verifyNode();
      } catch (e) {
        throw new ConfigurationError(`network identity verification failed: ${(e as Error).message}`);
      }
    }
    // verifyNode() is an operator startup concern, not a per-request cost. The provider's
    // getAccountInfo() already validates the returned account identity.
    const sdkVerifier = new SdkSenderVerifier({
      network: config.network,
      accountInfoProvider: provider,
      timeoutMs: config.senderVerificationTimeoutMs,
    });
    senderVerifier = (txJson: unknown) => sdkVerifier.verify(txJson);
  }
  // `passthrough` (mock only): senderVerifier stays undefined and FacilitatorCore uses its
  // pass-through default. `real` mode cannot reach this state — loadConfig rejects it.

  // The wire converter's cap is a JS number (executionEnergyAmount is numeric in the
  // SDK wire shape). A configured cap above the safe-integer range cannot be
  // represented exactly; fail closed rather than silently round it.
  if (config.maxEnergy > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigurationError('FACILITATOR_MAX_ENERGY exceeds the wire converter numeric range');
  }

  const core = new FacilitatorCore({
    network: config.network,
    signer,
    dbPath: config.dbPath,
    ...(config.dbFileMode !== null ? { dbFileMode: config.dbFileMode } : {}),
    ...(authorization ? { authorization } : {}),
    ...(senderVerifier ? { senderVerifier } : {}),
    busyTimeoutMs: config.busyTimeoutMs,
    // Configured caps, propagated into the core's own validation path. Before this
    // change the core silently used its hardcoded defaults (1_000 NRG / 1_000 / 10 CCD)
    // no matter what the operator configured: lowering FACILITATOR_MAX_ENERGY or
    // FACILITATOR_MAX_FEE_MICROCCD had no effect on the authorization client, the
    // wire converter, or the core-level fee check.
    maxAuthorizationEnergy: config.maxEnergy,
    maxWireEnergy: Number(config.maxEnergy),
    maxFeeMicroCcd: config.maxFeeMicroCcd,
    ...(opts.now ? { now: opts.now } : {}),
    ...(process.env['FACILITATOR_DIE_AT'] as CoreOptions['dieAt']
      ? { dieAt: process.env['FACILITATOR_DIE_AT'] as CoreOptions['dieAt'] }
      : {}),
  });

  // F2/F6 — startup probe of the Authorization Owner (real mode only). Runs
  // after the core opened the database, so the facilitator's file exists and
  // its identity is stable. A reachable owner on a SHARED database (or in the
  // same directory) fails startup (fail-closed): the facilitator could
  // rewrite Owner authorization state. An unreachable owner does not fail
  // startup — it makes readiness unhealthy until it appears (see /healthz).
  if (config.mode === 'real' && authorization) {
    const check = await checkOwnerDbSeparation(authorization, config.dbPath, 10_000, config.signingServiceUid);
    if (check.reachable && !check.separated) {
      throw new ConfigurationError(
        `authorization owner database not separated: ${check.reason} (owner db: ${check.ownerDbPath ?? 'unknown'})`,
      );
    }
    if (check.reachable) {
      const resolved = realpathSync(config.dbPath);
      const st = statSync(resolved);
      console.log(`authorization owner reachable; separate owner database ${check.ownerDbPath} (facilitator db ${resolved} dev=${st.dev} ino=${st.ino})`);
    } else {
      console.log(`WARNING: authorization owner unreachable at startup (${check.reason}); readiness will report unhealthy until it appears`);
    }
  }

  // Reconciliation is opt-in. When disabled the route does not exist at all, so there is no
  // unauthenticated endpoint that can change settlement state.
  const operatorAuth = buildOperatorAuth(
    {
      reconcileEnabled: config.reconcileEnabled,
      tokenSha256: config.operatorTokenSha256 ?? undefined,
      expiresAt: config.operatorTokenExpiresAt,
    },
    opts.now ? { now: opts.now } : {},
  );
  const verifier = opts.verifier ?? (await buildVerifier(config));
  const reconciler = new ReconciliationService({ repository: core.store, verifier });

  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && url === '/healthz') {
        // F6: in real mode, readiness reflects the Authorization Owner live: the
        // probe checks reachability AND storage separation . A dead
        // owner, or one restarted on a shared database, makes readiness
        // unhealthy (503). The probe is read-only and creates no approval,
        // signature, or settlement. Mock mode has no external owner; the
        // in-process local client is always reachable.
        if (config.mode === 'real' && authorization) {
          const check = await checkOwnerDbSeparation(authorization, config.dbPath, 2000, config.signingServiceUid);
          const reachable = check.reachable && check.separated;
          json(res, reachable ? 200 : 503, {
            ok: reachable,
            mode: config.mode,
            network: config.network,
            canSign: signer.info().canSign,
            ownerReachable: reachable,
            ...(reachable ? {} : { ownerReason: check.reason ?? 'unreachable' }),
          });
          return;
        }
        json(res, 200, { ok: true, mode: config.mode, network: config.network, canSign: signer.info().canSign, ownerReachable: true });
        return;
      }
      if (method === 'GET' && url === '/supported') {
        json(res, 200, core.getSupported());
        return;
      }
      if (method === 'POST' && url === '/verify') {
        const body = await readBody(req);
        if (!body.ok) {
          json(res, body.status, { isValid: false, invalidReason: 'invalid_request', invalidMessage: body.message });
          return;
        }
        json(res, 200, await core.verify(body.value));
        return;
      }
      if (method === 'POST' && url === '/settle') {
        const body = await readBody(req);
        if (!body.ok) {
          json(res, 400, { success: false, errorReason: 'invalid_request', errorMessage: body.message, transaction: '', network: config.network });
          return;
        }
        json(res, 200, await core.settle(body.value));
        return;
      }
      if (method === 'POST' && url === '/reconcile') {
        // Disabled ⇒ 404, exactly as if the route did not exist.
        if (!operatorAuth) {
          json(res, 404, { ok: false, reason: 'not found' });
          return;
        }
        const auth = operatorAuth.check(req.headers['authorization']);
        if (!auth.ok) {
          // The reason is logged; the credential never is.
          json(res, auth.code === 'missing' || auth.code === 'malformed' ? 401 : 403, {
            ok: false,
            code: auth.code,
            reason: `reconciliation requires a valid operator credential (${auth.code})`,
          });
          return;
        }

        const body = await readBody(req);
        if (!body.ok) {
          json(res, body.status, { ok: false, reason: body.message });
          return;
        }
        const b = body.value as { paymentDigest?: string; transaction?: string };
        if (typeof b !== 'object' || b === null || typeof b.paymentDigest !== 'string') {
          json(res, 400, { ok: false, reason: 'paymentDigest is required' });
          return;
        }
        // NOTE: no `status` field is read. A caller cannot supply finality; the verifier is
        // the only source, and the recorded hash is the only subject.
        const outcome = await reconciler.reconcile({
          paymentDigest: b.paymentDigest,
          ...(typeof b.transaction === 'string' ? { transaction: b.transaction } : {}),
        });
        const status = outcome.ok ? 200 : outcome.code === 'unknown_payment' ? 404 : 409;
        json(res, status, outcome);
        return;
      }
      if (method === 'GET' && (url === '/payments' || url.startsWith('/payments?'))) {
        // Read-only payment list: stored rows only, newest first.
        // No live verification is performed per item — the detail endpoint
        // (`GET /payment/:id`) is the only source of live evidence.
        // Public fields only: no requirements key, no rejection counters,
        // no signatures. `limit` is bounded (default 50, max 100); an
        // invalid limit is a 400, never silently clamped.
        const rawLimit = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '').get('limit');
        let limit = 50;
        if (rawLimit !== null) {
          if (!/^\d+$/.test(rawLimit)) {
            json(res, 400, { error: 'invalid_request', reason: 'limit must be an integer' });
            return;
          }
          limit = Number(rawLimit);
          if (limit < 1 || limit > 100) {
            json(res, 400, { error: 'invalid_request', reason: 'limit must be between 1 and 100' });
            return;
          }
        }
        const rows = core.store.listPayments(limit);
        json(res, 200, {
          payments: rows.map((r) => ({
            paymentDigest: r.payment_digest,
            state: r.state,
            transactionHash: r.tx_hash,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            attempted: r.attempted,
          })),
          count: rows.length,
          limit,
        });
        return;
      }
      if (method === 'GET' && url.startsWith('/payment/')) {
        // Read-only payment detail: the stored record + a fresh live
        // observation of the recorded transaction hash. No state is
        // written, nothing is signed or submitted. The identifier is a
        // payment digest or a transaction hash (both 64-char hex).
        const segment = url.slice('/payment/'.length).split('?')[0]!;
        if (!segment || segment.includes('/')) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const result = await getPaymentDetail({ repository: core.store, verifier }, segment);
        if (!result.ok) {
          json(res, result.code === 'invalid_request' ? 400 : 404, {
            ok: false,
            code: result.code,
            reason: result.reason,
          });
          return;
        }
        json(res, 200, result.detail);
        return;
      }

      json(res, 404, { error: 'not found' });
    })().catch(e => {
      json(res, 500, { error: String((e as Error).message ?? e).slice(0, 200) });
    });
  });

  // Bounded startup recovery, before the socket is opened.
  //
  // Runs `recoverPending()` once so persisted hashes are reconciled before the facilitator
  // advertises readiness. Recovery only ever polls by hash — it can never submit or broadcast
  // A failure aborts startup (fail-closed); an incomplete-but-non-terminal
  // result is reported and startup continues, because those rows are already safe.
  if (config.recoverOnStartup && config.mode === 'real') {
    try {
      const summary = await withTimeout(
        core.recoverPending(),
        config.startupRecoveryTimeoutMs,
        'startup recovery',
      );
      console.log(`startup recovery: ${JSON.stringify(summary)}`);
    } catch (e) {
      throw new ConfigurationError(`startup recovery failed: ${(e as Error).message}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  return {
    url: `http://${config.host === '::1' ? '[::1]' : config.host}:${port}`,
    core,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

// ─── verifier construction ─────────────────────────────────────────────
/**
 * Build the evidence verifier from configuration.
 *
 * Default (`none`) is an EMPTY fixture table: reconciliation answers "unavailable" for every
 * hash, so nothing can ever finalize. That is the default-deny behaviour the whole design
 * depends on. `fixture` and `grpc` must be explicitly configured.
 */
async function buildVerifier(config: FacilitatorConfig): Promise<EvidenceVerifier> {
  switch (config.evidenceMode) {
    case 'none':
      return new FixtureEvidenceVerifier({});
    case 'fixture':
      return new FixtureEvidenceVerifier({});
    case 'grpc': {
      // SDK 12.0.2 exports `ConcordiumGRPCNodeClient` from
      // `@concordium/web-sdk/nodejs`; there is no `GRPCClient` export. Verified declaration:
      //   lib/esm/nodejs/grpc.d.ts:17
      //     export declare class ConcordiumGRPCNodeClient extends ConcordiumGRPCClient {
      //       constructor(address: string, port: number, credentials: ChannelCredentials,
      //                   options?: Partial<GrpcOptions>);
      //     }
      // Same constructor shape `GrpcAccountInfoProvider` already uses.
      const client = new ConcordiumGRPCNodeClient(
        config.nodeHost!,
        config.nodePort!,
        config.nodeUseTls ? credentials.createSsl() : credentials.createInsecure(),
      );
      return new ConcordiumEvidenceVerifier(client as unknown as ConcordiumStatusClient);
    }
    default:
      return new FixtureEvidenceVerifier({});
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    const started = await startFacilitator(process.env);
    console.log(`facilitator listening on ${started.url} (mode=${process.env['FACILITATOR_MODE']})`);
    if (process.env['FACILITATOR_MODE'] === 'real') {
      // Accurate real-mode logging. The facilitator signs through the dedicated
      // signing service over IPC and submits through the V1 gRPC transport; no local key
      // material is held. Only non-secret operational facts are logged.
      console.log(
        'real mode: signing via the dedicated IPC signing service; submission via Concordium gRPC.',
      );
      console.log(
        'real mode: this process holds no private keys and does not contact a node for its own account.',
      );
    } else {
      console.log('mock mode: it cannot sign and cannot submit. No chain is contacted.');
    }
  } catch (e) {
    if (e instanceof ConfigurationError) {
      console.error(`configuration error: ${e.message}`);
      process.exit(2);
    }
    console.error(`failed to start: ${String((e as Error)?.message ?? e)}`);
    process.exit(1);
  }
}
