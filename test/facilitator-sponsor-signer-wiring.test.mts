/**
 * Facilitator sponsor signer IPC wiring.
 *
 * Proves: strict config validation, IpcAccountSigner construction through startup wiring,
 * fake signing across a real process boundary, fail-closed lifecycle behaviour, and that no
 * local signing fallback exists.
 *
 * Sections A–C and D–F need no privileges. Section E touches SO_PEERCRED and needs uid 1001 +
 * group authclients (1002); it self-skips otherwise:
 *   sudo -u ubuntu npx tsx test/facilitator-sponsor-signer-wiring.test.mts
 *
 * Fake signer only. No key material, no chain, no broadcast.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, notOk, ok } from './helpers.mjs';
import { ConfigurationError, loadConfig } from '../services/facilitator/src/config.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { IpcAccountSigner, probeSigningService, signingDigestOf } from '../services/facilitator/src/signingService.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient, IpcAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { SponsorSigner, AddSponsorSignatureOptions } from '../services/facilitator/src/signer.js';
import { makeTestOwnerKey, issueTestCertificate, certFieldsForTx } from './owner-authz-helper.mjs';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const FACILITATOR_UID = 1001;
const FACILITATOR_GID = 1002;
const SVC_UID = 1001; // the harness runs as this same UID
const WRONG_UID = 1005;
const NOW = 1_800_000_000;

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const realEnv = (over: Record<string, string> = {}) => ({
  FACILITATOR_MODE: 'real',
  FACILITATOR_PORT: '0',
  FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
  FACILITATOR_NETWORK: NETWORK,
  FACILITATOR_SENDER_VERIFICATION: 'sdk',
  FACILITATOR_NODE_HOST: 'grpc.testnet.concordium.com',
  FACILITATOR_NODE_PORT: '20000',
  // verifyNode() is wired into real-mode startup; the public Testnet gRPC endpoint
  // requires TLS, so the fixture must say so or the genesis check cannot connect.
  FACILITATOR_NODE_USE_TLS: '1',
  FACILITATOR_DB_PATH: '/tmp/t46-real.db',
  FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock',
  FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID),
  FACILITATOR_AUTHZ_SOCKET: '/tmp/t46-authz.sock',
  ...over,
});

const mockEnv = (over: Record<string, string> = {}) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_PORT: '0',
  ...over,
});

const throwsConfig = (fn: () => unknown, re: RegExp, label: string): void => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  ok(err instanceof ConfigurationError, `${label}: expected ConfigurationError`);
  ok(re.test((err as Error).message), `${label}: message was "${(err as Error).message}"`);
};

const tmpsock = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t46-${tag}-`));
  return { dir, sock: join(dir, 's.sock'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * A server that accepts connections and hands each one to `handler`.
 *
 * `close()` destroys any connection still open first: `net.Server.close()` waits for existing
 * connections, and a deliberately silent handler would otherwise hang the suite forever.
 */
const rawServer = async (sock: string, handler: (conn: Socket) => void) => {
  const live = new Set<Socket>();
  const server = createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    handler(conn);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve());
  });
  return {
    server,
    close: async (): Promise<void> => {
      for (const conn of live) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** The digest of the envelope's signed transaction (protocol v2 binding). */
const envelopeDigest = (): ArrayBuffer =>
  digestHexToArrayBuffer(signingDigestOf(envelope().paymentPayload.payload.signedTransaction));

const ipcSignerFor = (sock: string, timeoutMs = 600) =>
  new IpcAccountSigner({
    socketPath: sock,
    expectedUid: SVC_UID,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs,
    transaction: envelope().paymentPayload.payload.signedTransaction,
    // Task 11: the client refuses to send a request without Owner
    // authorization evidence. These transport tests use a certificate
    // issued by an ephemeral test keypair for the envelope transaction;
    // the raw stub servers never validate it — it only gets the request
    // onto the socket so the transport failure under test can happen.
    authorization: envelopeCert(),
    paymentDigest: PAYMENT_DIGEST,
  });

const expectSignError = async (sock: string, re: RegExp, label: string, timeoutMs = 600) => {
  let message = '';
  try {
    await ipcSignerFor(sock, timeoutMs).sign(envelopeDigest());
  } catch (e) {
    message = (e as Error).message;
  }
  ok(re.test(message), `${label}: got "${message}"`);
};

/** x402 V2 envelope in the SDK signable shape, sponsor slot pre-declared. */
const envelope = () => {
  const payload = {
    x402Version: 2,
    resource: { url: 'agenttrust://resource/1004' },
    accepted: {
      scheme: 'exact',
      network: NETWORK,
      asset: 'CCD',
      amount: '250000',
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { feePayer: SPONSOR },
    },
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: RECIPIENT,
          nonce: 7,
          expiry: NOW + 200,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: SPONSOR, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
      },
    },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

// Task 11 — one payment digest and one ephemeral Owner keypair for the
// whole suite. `envelopeCert()` issues a certificate for the envelope
// transaction, so signing requests carry the authorization evidence the
// client-side guard requires. Transport tests (B02/D01–D05) send it to raw
// stub servers that never validate it; the cross-process tests (E) send it
// to the real signing service, whose public key is this keypair's.
const PAYMENT_DIGEST = 'cd'.repeat(32);
const ownerKey = makeTestOwnerKey();
const envelopeCert = () =>
  issueTestCertificate(
    ownerKey.privateKey,
    certFieldsForTx(envelope().paymentPayload.payload.signedTransaction, {
      paymentDigest: PAYMENT_DIGEST,
      recipient: RECIPIENT,
      amount: '250000',
      network: NETWORK,
      issuedAt: NOW * 1000,
    }),
  );

// ═══ A. configuration contract ══════════════════════════════════════════════

test('A01. mock mode needs no signing-service config and keeps the default timeout', () => {
  const cfg = loadConfig(mockEnv());
  eq(cfg.signingServiceSocket, null, 'socket null');
  eq(cfg.signingServiceUid, null, 'uid null');
  eq(cfg.signingServiceTimeoutMs, 10_000, 'timeout default');
});

test('A02. mock mode rejects a signing-service socket', () => {
  throwsConfig(
    () => loadConfig(mockEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/x.sock' })),
    /mock mode must not configure the signing service/i,
    'mock + socket',
  );
});

test('A03. mock mode rejects a signing-service UID', () => {
  throwsConfig(
    () => loadConfig(mockEnv({ FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID) })),
    /mock mode must not configure the signing service/i,
    'mock + uid',
  );
});

test('A04. real mode without a socket fails closed', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: '' })),
    /requires FACILITATOR_SIGNING_SERVICE_SOCKET/i,
    'missing socket',
  );
});

test('A05. real mode without a UID fails closed', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_UID: '' })),
    /requires FACILITATOR_SIGNING_SERVICE_UID/i,
    'missing uid',
  );
});

test('A06. real mode rejects a relative socket path', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: 'relative/sock' })),
    /absolute Unix socket path/i,
    'relative socket',
  );
});

test('A07. real mode rejects a non-integer UID', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_UID: 'abc' })),
    /integer UID/i,
    'non-integer uid',
  );
});

test('A08. real mode rejects UID 0 (root is never a signing service)', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_UID: '0' })),
    /must not be 0/i,
    'uid 0',
  );
});

test('A09. real mode rejects an out-of-range UID', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_SIGNING_SERVICE_UID: '70000' })),
    /between 1 and 65533/i,
    'uid 70000',
  );
});

test('A10. real mode accepts a valid socket + UID, substituting no default', () => {
  const cfg = loadConfig(realEnv());
  eq(cfg.mode, 'real', 'mode');
  eq(cfg.signingServiceSocket, '/tmp/t46-sign.sock', 'socket');
  eq(cfg.signingServiceUid, SVC_UID, 'uid');
  notOk(cfg.signingServiceSocket === null, 'socket never silently defaulted');
});

test('A11. real mode without an Authorization Owner socket fails closed', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_AUTHZ_SOCKET: '' })),
    /requires FACILITATOR_AUTHZ_SOCKET/i,
    'missing owner socket',
  );
});

test('A12. real mode rejects a relative Authorization Owner socket path', () => {
  throwsConfig(
    () => loadConfig(realEnv({ FACILITATOR_AUTHZ_SOCKET: 'relative/authz.sock' })),
    /FACILITATOR_AUTHZ_SOCKET must be an absolute Unix socket path/i,
    'relative owner socket',
  );
});

test('A13. real mode accepts a valid Authorization Owner socket', () => {
  const cfg = loadConfig(realEnv());
  eq(cfg.authorizationSocket, '/tmp/t46-authz.sock', 'owner socket');
});

// ═══ B. signer construction ═════════════════════════════════════════════════

test('B01. createIpcSponsorSigner rejects a relative socket and UID 0', () => {
  throwsConfig(
    () => createIpcSponsorSigner({ sponsorAddress: SPONSOR, network: NETWORK, socketPath: 'rel', expectedUid: SVC_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 1_000_000n }),
    /absolute path/i,
    'relative socket',
  );
  throwsConfig(
    () => createIpcSponsorSigner({ sponsorAddress: SPONSOR, network: NETWORK, socketPath: '/tmp/x.sock', expectedUid: 0, maxEnergy: 100_000n, maxFeeMicroCcd: 1_000_000n }),
    /UID must be an integer/i,
    'uid 0',
  );
});

test('B02. a valid config builds a SponsorSigner that signs REMOTELY, not locally', async () => {
  const { sock, rm } = tmpsock('b02');
  // A silent listener: the signing call must reach the socket and time out there. A local
  // signer would have produced a signature without touching any socket.
  const srv = await rawServer(sock, () => {});
  try {
    const signer = createIpcSponsorSigner({
      sponsorAddress: SPONSOR,
      network: NETWORK,
      socketPath: sock,
      expectedUid: SVC_UID,
      maxEnergy: 100_000n,
      maxFeeMicroCcd: 1_000_000n,
      timeoutMs: 400,
    });
    eq(signer.info().address, SPONSOR, 'address');
    eq(signer.info().network, NETWORK, 'network');
    let message = '';
    try {
      // Task 11: the signing call carries the Owner authorization evidence.
      await signer.addSponsorSignature(envelope().paymentPayload.payload, {
        authorization: envelopeCert(),
        paymentDigest: PAYMENT_DIGEST,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/signing service timeout/i.test(message), `expected IPC timeout, got "${message}"`);
  } finally {
    await srv.close();
    rm();
  }
});

test('B03. the IPC signer never submits or queries a chain', async () => {
  const signer = createIpcSponsorSigner({ sponsorAddress: SPONSOR, network: NETWORK, socketPath: '/tmp/x.sock', expectedUid: SVC_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 1_000_000n });
  for (const fn of ['submitTransaction', 'waitForFinalization', 'getAccountInfo', 'getTokenBalance', 'getTokenDecimals'] as const) {
    let message = '';
    try {
      await (signer[fn] as unknown as (arg: unknown) => Promise<unknown>)({});
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/never broadcasts/i.test(message), `${fn} refuses`);
  }
});

test('B04. the signer exposes no key material', () => {
  const signer = createIpcSponsorSigner({ sponsorAddress: SPONSOR, network: NETWORK, socketPath: '/tmp/x.sock', expectedUid: SVC_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 1_000_000n });
  const blob = JSON.stringify(Object.keys(signer)) + JSON.stringify(Object.getOwnPropertyNames(signer));
  for (const forbidden of ['privateKey', 'mnemonic', 'keystore', 'seed', 'secretKey', 'wallet']) {
    ok(!new RegExp(forbidden, 'i').test(blob), `no ${forbidden} on the signer`);
  }
});

// ═══ C. startup fail-closed ═════════════════════════════════════════════════

test('C01. real-mode startup refuses when the signing service is absent', async () => {
  const { dir, sock, rm } = tmpsock('c01');
  let message = '';
  try {
    await startFacilitator(realEnv({
      FACILITATOR_SIGNING_SERVICE_SOCKET: sock,
      FACILITATOR_DB_PATH: join(dir, 'f.db'),
    }));
  } catch (e) {
    message = (e as Error).message;
  } finally {
    rm();
  }
  ok(/signing service unreachable/i.test(message), `startup refused: "${message}"`);
});

test('C02. mock-mode startup is unchanged and still cannot sign', async () => {
  const f = await startFacilitator(mockEnv());
  try {
    const h = await (await fetch(`${f.url}/healthz`)).json();
    eq(h.mode, 'mock', 'mode');
    eq(h.canSign, false, 'mock cannot sign');
  } finally {
    await f.close();
  }
});

// ═══ D. lifecycle against a misbehaving socket ══════════════════════════════

test('D01. timeout fails closed', async () => {
  const { sock, rm } = tmpsock('d01');
  const srv = await rawServer(sock, () => {});
  try {
    await expectSignError(sock, /signing service timeout/i, 'timeout');
  } finally {
    await srv.close();
    rm();
  }
});

test('D02. service exits during a signing request → fails closed without waiting', async () => {
  const { sock, rm } = tmpsock('d02');
  const srv = await rawServer(sock, (conn) => {
    conn.once('data', () => conn.destroy());
  });
  try {
    const started = Date.now();
    await expectSignError(sock, /closed the connection before responding/i, 'service exit', 10_000);
    ok(Date.now() - started < 5_000, 'failed immediately rather than waiting out the timeout');
  } finally {
    await srv.close();
    rm();
  }
});

test('D03. invalid response fails closed', async () => {
  const { sock, rm } = tmpsock('d03');
  const srv = await rawServer(sock, (conn) => {
    conn.once('data', () => conn.end('not json\n'));
  });
  try {
    await expectSignError(sock, /malformed response/i, 'invalid response');
  } finally {
    await srv.close();
    rm();
  }
});

test('D04. response carrying a foreign request ID fails closed', async () => {
  const { sock, rm } = tmpsock('d04');
  const srv = await rawServer(sock, (conn) => {
    conn.once('data', () => {
      conn.end(JSON.stringify({
        protocolVersion: 1,
        requestId: 'someone-else',
        outcome: 'signed',
        signature: { 0: { 0: 'ee'.repeat(64) } },
        reason: null,
        detail: null,
      }) + '\n');
    });
  });
  try {
    await expectSignError(sock, /request ID mismatch/i, 'foreign request id');
  } finally {
    await srv.close();
    rm();
  }
});

test('D05. connection refused fails closed', async () => {
  const { sock, rm } = tmpsock('d05');
  // A regular file where a socket is expected: connect() is refused by the kernel.
  writeFileSync(sock, 'not a socket');
  try {
    await expectSignError(sock, /unavailable/i, 'connection refused');
  } finally {
    rm();
  }
});

test('D06. the startup probe distinguishes reachable from unreachable, without signing', async () => {
  const { sock, rm } = tmpsock('d06');
  const srv = await rawServer(sock, () => {});
  try {
    eq(await probeSigningService(sock, 1000), null, 'reachable');
  } finally {
    await srv.close();
  }
  const reason = await probeSigningService(sock, 1000);
  ok(reason !== null && /unreachable/i.test(reason), `unreachable reported: ${String(reason)}`);
  rm();
});

// ═══ F. invariants that need no service ═════════════════════════════════════

test('F01. DENY_ALL_FACILITATOR still refuses verify and settle', async () => {
  const { DENY_ALL_FACILITATOR } = await import('../src/payments/x402.js');
  ok(DENY_ALL_FACILITATOR !== undefined, 'exported');
  const verifyThrew = await DENY_ALL_FACILITATOR.verify({} as never, {} as never).then(() => false, () => true);
  const settleThrew = await DENY_ALL_FACILITATOR.settle({} as never, {} as never).then(() => false, () => true);
  ok(verifyThrew, 'verify refuses');
  ok(settleThrew, 'settle refuses');
});

test('F02. settlement stays disabled by default (guardSettlement)', async () => {
  const { guardSettlement } = await import('../src/payments/operatorSigning.js');
  const g = guardSettlement({
    allowSettlement: false,
    payload: envelope().paymentPayload,
    requirements: envelope().paymentRequirements as never,
    expectedSponsor: SPONSOR,
    authorization: undefined,
  });
  eq(g.ok, false, 'refused');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
});

// ═══ E. cross-process (uid 1001 + authclients group) ════════════════════════

const hasIpc =
  typeof process.getuid === 'function' &&
  process.getuid() === FACILITATOR_UID &&
  typeof process.getgroups === 'function' &&
  process.getgroups().includes(FACILITATOR_GID);

if (!hasIpc) {
  console.log(`\n[SKIP] cross-process tests need uid ${FACILITATOR_UID} + group ${FACILITATOR_GID}`);
} else {
  const base = mkdtempSync(join(tmpdir(), 't46-ipc-'));
  const sock = join(base, 'sign.sock');
  // Task 11: the signing service verifies Owner certificates and consumes
  // them at the Owner. The service is started with this keypair's public
  // key and the Owner socket; E02 runs a real Owner on `ownerSock`, the
  // other E tests only need the env set (no consume ever happens there).
  const ownerSock = join(base, 'owner.sock');
  const ownerScript = `${process.cwd()}/scripts/authz-owner.mts`;
  const serviceScript = `${process.cwd()}/scripts/signing-ipc-service.mts`;

  const startService = async (allowedUid: number) => {
    const proc = spawn('npx', ['tsx', serviceScript, sock, SPONSOR, NETWORK, String(allowedUid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SIGNING_OWNER_PUBLIC_KEY: ownerKey.publicKeyHex,
        SIGNING_OWNER_SOCKET: ownerSock,
        SIGNING_OWNER_UID: String(FACILITATOR_UID),
      },
    });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      proc.stdout.on('data', (c) => {
        if (c.toString().includes('service listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      proc.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    spawnSync('sudo', ['-u', 'root', 'chgrp', 'authclients', sock]);
    spawnSync('sudo', ['-u', 'root', 'chmod', '660', sock]);
    return proc;
  };

  /** SIGTERM, then wait for a real exit so the next service can bind the same path. */
  const stop = async (proc: ReturnType<typeof spawn>) => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
    }
    // Remove the socket path so the next service binds a fresh one and no client can reach a
    // service left over from an earlier test.
    rmSync(sock, { force: true });
  };

  const ipc = (uid: number, timeoutMs = 5_000) =>
    createIpcSponsorSigner({
      sponsorAddress: SPONSOR,
      network: NETWORK,
      socketPath: sock,
      expectedUid: uid,
      maxEnergy: 100_000n,
      maxFeeMicroCcd: 1_000_000n,
      timeoutMs,
    });

  const countedSigner = (inner: SponsorSigner, calls: { sign: number }): SponsorSigner => ({
    info: inner.info,
    // Task 11: forward the per-call signing options (the Owner certificate
    // and payment digest) — dropping them would make the inner IPC signer
    // refuse client-side before any socket activity.
    addSponsorSignature: async (tx: unknown, opts?: AddSponsorSignatureOptions) => {
      calls.sign++;
      return inner.addSponsorSignature(tx, opts);
    },
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  });

  /** Start a real Owner process on `ownerSock` (Task 11, for E02). */
  const startOwner = async (dbPath: string) => {
    const ownerDir = join(base, 'e02-owner');
    mkdirSync(ownerDir, { mode: 0o700 });
    const ownerKeyFile = join(ownerDir, 'owner-key.pem');
    writeFileSync(ownerKeyFile, ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const proc = spawn('npx', ['tsx', ownerScript, ownerDir, ownerSock, String(FACILITATOR_UID), String(FACILITATOR_UID)], {
      env: {
        ...process.env,
        AUTHZ_SPONSOR_ADDRESS: SPONSOR,
        AUTHZ_NETWORK: NETWORK,
        AUTHZ_MAX_ENERGY: '100000',
        AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
        AUTHZ_ALLOWED_ASSETS: 'CCD',
        AUTHZ_POLICY_VERSION: 't46',
        AUTHZ_DB_FILE: dbPath,
        AUTHZ_SEED_FIXTURES: '0',
        AUTHZ_AUTHORIZATION_KEY_FILE: ownerKeyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('owner start timeout')), 30_000);
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.stdout.on('data', (c) => {
        if (c.toString().includes('owner listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`owner exited early code=${code}: ${stderr.trim().split('\n').slice(-15).join(' | ')}`));
      });
    });
    return proc;
  };
  const stopOwner = async (proc: ReturnType<typeof spawn>) => {
    if (proc.exitCode === null && proc.pid !== undefined) {
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
    }
  };

  const localAuth = (repo: SqliteSettlementRepository) =>
    new LocalAuthorizationClient({
      policy: {
        network: NETWORK,
        sponsor: SPONSOR,
        maxEnergy: 100_000n,
        maxExpiryOffsetSeconds: 600,
        allowedAssets: ['CCD'],
        policyVersion: 't46',
      },
      repository: repo,
      now: () => NOW * 1000,
    });

  test('E01. signing service available → real-mode facilitator starts', async () => {
    const proc = await startService(FACILITATOR_UID);
    let f: Awaited<ReturnType<typeof startFacilitator>> | null = null;
    try {
      f = await startFacilitator(realEnv({
        FACILITATOR_SIGNING_SERVICE_SOCKET: sock,
        FACILITATOR_SIGNING_SERVICE_UID: String(FACILITATOR_UID),
        FACILITATOR_DB_PATH: join(base, 'e01.db'),
      }));
      const h = await (await fetch(`${f.url}/healthz`)).json();
      eq(h.mode, 'real', 'mode');
      // `canSign` describes the service, not the facilitator: no key material is in-process.
      eq(h.canSign, true, 'the remote signing service can sign');
    } finally {
      if (f) await f.close();
      await stop(proc);
    }
  });

  test('E02. the facilitator obtains a fake sponsor signature through the IPC path', async () => {
    // Task 11: the full Owner chain — a real Owner process issues the
    // certificate (shared DB with the core) and the signing service
    // consumes it there before signing. The core authorizes through the
    // real Owner client, not the local mock.
    //
    // Clock note: the Owner and signing-service processes run on REAL time,
    // while this suite's fixtures use a fixed future clock. E02 therefore
    // runs on real time throughout (envelope expiry, core clock, repo
    // clock) — a fixed-future expiry would be rejected by the Owner as
    // expiry_excessive, and a real-time expiry would look expired to the
    // fixed-clock consume gate.
    const realNowSec = Math.floor(Date.now() / 1000);
    const env = envelope();
    (env.paymentPayload.payload.signedTransaction.header as Record<string, unknown>)['expiry'] = realNowSec + 200;
    const repo = new SqliteSettlementRepository(join(base, 'e02.db'), { now: () => Date.now() });
    const ownerProc = await startOwner(join(base, 'e02.db'));
    const proc = await startService(FACILITATOR_UID);
    const calls = { sign: 0 };
    const core = new FacilitatorCore({
      network: NETWORK,
      signer: countedSigner(ipc(FACILITATOR_UID), calls),
      dbPath: join(base, 'e02.db'),
      now: () => Date.now(),
      authorization: new IpcAuthorizationClient(ownerSock),
    });
    try {
      const res = await core.settle(env);
      eq(calls.sign, 1, 'sponsor signer called once');
      // Signing crossed the process boundary; broadcast is deliberately absent, so the only
      // honest outcome is the ambiguous/pending one — never success.
      eq(res.success, false, 'never reports success');
      eq(res.errorReason, 'settlement_pending', 'pending, not settled');
      ok(/never broadcasts/i.test(String(res.errorMessage)), `submission refused: ${String(res.errorMessage)}`);
      ok(/^[0-9a-f]{64}$/.test(res.transaction), 'sponsored hash recorded');
    } finally {
      repo.close();
      await stop(proc);
      await stopOwner(ownerProc);
    }
  });

  test('E03. missing service → real-mode startup fails closed', async () => {
    let message = '';
    try {
      await startFacilitator(realEnv({
        FACILITATOR_SIGNING_SERVICE_SOCKET: join(base, 'absent.sock'),
        FACILITATOR_SIGNING_SERVICE_UID: String(FACILITATOR_UID),
        FACILITATOR_DB_PATH: join(base, 'e03.db'),
      }));
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/unreachable/i.test(message), `startup refused: "${message}"`);
  });

  test('E04. UID mismatch is refused by SO_PEERCRED, not by the client', async () => {
    const proc = await startService(WRONG_UID);
    try {
      let message = '';
      try {
        // Task 11: the request carries the Owner authorization evidence, so
        // it reaches the service — which then refuses on the peer UID.
        await ipc(FACILITATOR_UID, 3_000).addSponsorSignature(envelope().paymentPayload.payload, {
          authorization: envelopeCert(),
          paymentDigest: PAYMENT_DIGEST,
        });
      } catch (e) {
        message = (e as Error).message;
      }
      ok(/unauthorized_peer/i.test(message), `uid mismatch refused: "${message}"`);
    } finally {
      await stop(proc);
    }
  });

  test('E05. sender verification rejection still blocks signing through the IPC path', async () => {
    const proc = await startService(FACILITATOR_UID);
    const repo = new SqliteSettlementRepository(join(base, 'e05.db'), { now: () => NOW * 1000 });
    const calls = { sign: 0, verify: 0 };
    const core = new FacilitatorCore({
      network: NETWORK,
      signer: countedSigner(ipc(FACILITATOR_UID, 3_000), calls),
      dbPath: join(base, 'e05.db'),
      now: () => NOW * 1000,
      senderVerifier: async () => {
        calls.verify++;
        return { ok: false, reason: 'invalid_signature' } as never;
      },
      authorization: localAuth(repo),
    });
    try {
      const res = await core.settle(envelope());
      eq(calls.verify, 1, 'verifier ran');
      eq(calls.sign, 0, 'signer never reached');
      eq(res.errorReason, 'sender_verification_failed', 'reason');
      eq(res.transaction, '', 'no sponsored hash');
    } finally {
      repo.close();
      await stop(proc);
    }
  });

  test('E06. clean shutdown: SIGTERM stops the service and signing then fails closed', async () => {
    const proc = await startService(FACILITATOR_UID);
    const signer = ipc(FACILITATOR_UID, 1_500);
    await stop(proc);
    // Exit CODE is not asserted: `npx` is the direct child and it forwards the signal, so the
    // observable is "the process is gone", which is what the lifecycle depends on.
    ok(proc.exitCode !== null || proc.signalCode !== null, 'service process exited');
    let message = '';
    try {
      // Task 11: the request carries the Owner authorization evidence, so
      // the failure is the dead socket — not the client-side guard.
      await signer.addSponsorSignature(envelope().paymentPayload.payload, {
        authorization: envelopeCert(),
        paymentDigest: PAYMENT_DIGEST,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/unavailable|timeout|closed the connection/i.test(message), `post-shutdown signing refused: "${message}"`);
  });

  process.on('exit', () => rmSync(base, { recursive: true, force: true }));
}

// ═══ F. Authorization Owner readiness + shared-database identity (F2/F6/F9) ═══
// Runs as root: the owner here is a stub socket (no SO_PEERCRED), and the signing
// service is a dummy listener that only needs to accept the probe connection.

const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const fakeNode = () => ({
  getConsensusStatus: async () => ({ genesisBlock: TESTNET_GENESIS }),
  getAccountInfo: async () => ({
    accountAddress: SENDER,
    accountThreshold: 1,
    accountNonce: 1n,
    accountIndex: 1n,
    accountCredentials: {
      '0': { v: 0, value: { type: 'initial', contents: { credentialPublicKeys: { threshold: 1, keys: { '0': { schemeId: 'Ed25519', verifyKey: 'a'.repeat(64) } } } } } },
    },
  }),
  sendTransaction: async () => 'a'.repeat(64),
  getBlockItemStatus: async () => ({ status: 'received' }),
});

/** A stub Authorization Owner that answers db_identity with a fixed identity. */
const stubOwner = async (sock: string, identity: { dev: number; ino: number; path: string }) =>
  rawServer(sock, (conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(buf.slice(0, idx));
      } catch {
        conn.destroy();
        return;
      }
      if (req.operation === 'db_identity') {
        conn.write(JSON.stringify({ protocolVersion: 1, requestId: req.requestId, outcome: 'ok', dbPath: identity.path, dbDev: identity.dev, dbIno: identity.ino }) + '\n');
      } else {
        conn.write(JSON.stringify({ protocolVersion: 1, requestId: req.requestId, outcome: 'protocol_error', reason: 'unknown_operation' }) + '\n');
      }
    });
  });

/** A dummy signing service: accepts connections (probe passes) and destroys them. */
const dummySigningService = async (sock: string) => rawServer(sock, (conn) => conn.destroy());

const fws = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t46-f-${tag}-`));
  return { dir, db: join(dir, 'f.db'), signSock: join(dir, 'sign.sock'), authzSock: join(dir, 'authz.sock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Pre-create the facilitator DB so its device+inode are stable before startup. */
const dbIdentityOf = (dbPath: string) => {
  const repo = new SqliteSettlementRepository(dbPath, { now: () => NOW * 1000 });
  repo.close();
  const resolved = realpathSync(dbPath);
  const st = statSync(resolved);
  return { dev: st.dev, ino: st.ino, path: resolved };
};

const realEnvF = (w: ReturnType<typeof fws>) =>
  realEnv({
    FACILITATOR_SIGNING_SERVICE_SOCKET: w.signSock,
    FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID),
    FACILITATOR_AUTHZ_SOCKET: w.authzSock,
    FACILITATOR_DB_PATH: w.db,
    FACILITATOR_NODE_HOST: '127.0.0.1',
    FACILITATOR_NODE_PORT: '1',
  });

test('F01. owner on the same database → startup succeeds, /healthz reports ownerReachable', async () => {
  const w = fws('same');
  const identity = dbIdentityOf(w.db);
  const sign = await dummySigningService(w.signSock);
  const owner = await stubOwner(w.authzSock, identity);
  let f: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    f = await startFacilitator(realEnvF(w), { nodeClient: fakeNode() as never });
    const res = await fetch(`${f.url}/healthz`);
    eq(res.status, 200, 'healthy');
    const h = await res.json();
    eq(h.mode, 'real', 'mode');
    eq(h.ok, true, 'ok');
    eq(h.ownerReachable, true, 'owner reachable');
  } finally {
    if (f) await f.close();
    await owner.close();
    await sign.close();
    w.cleanup();
  }
});

test('F02. owner on a different database → startup fails closed', async () => {
  const w = fws('different');
  const other = fws('other');
  const identity = dbIdentityOf(other.db); // a different file
  const sign = await dummySigningService(w.signSock);
  const owner = await stubOwner(w.authzSock, identity);
  try {
    let message = '';
    try {
      await startFacilitator(realEnvF(w), { nodeClient: fakeNode() as never });
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/database mismatch/i.test(message), `startup refused: "${message}"`);
  } finally {
    await owner.close();
    await sign.close();
    w.cleanup();
    other.cleanup();
  }
});

test('F03. owner unreachable at startup → facilitator starts, /healthz reports unhealthy', async () => {
  const w = fws('down');
  const sign = await dummySigningService(w.signSock);
  let f: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    f = await startFacilitator(realEnvF(w), { nodeClient: fakeNode() as never });
    const res = await fetch(`${f.url}/healthz`);
    eq(res.status, 503, 'unhealthy status');
    const h = await res.json();
    eq(h.ok, false, 'not ok');
    eq(h.ownerReachable, false, 'owner unreachable');
    ok(typeof h.ownerReason === 'string' && h.ownerReason.length > 0, 'a reason is given');
  } finally {
    if (f) await f.close();
    await sign.close();
    w.cleanup();
  }
});

test('F04. owner dies after startup → /healthz becomes unhealthy', async () => {
  const w = fws('dies');
  const identity = dbIdentityOf(w.db);
  const sign = await dummySigningService(w.signSock);
  const owner = await stubOwner(w.authzSock, identity);
  let f: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    f = await startFacilitator(realEnvF(w), { nodeClient: fakeNode() as never });
    const h1 = await (await fetch(`${f.url}/healthz`)).json();
    eq(h1.ownerReachable, true, 'healthy while owner is up');
    await owner.close();
    const res = await fetch(`${f.url}/healthz`);
    eq(res.status, 503, 'unhealthy after owner death');
    const h2 = await res.json();
    eq(h2.ownerReachable, false, 'owner unreachable');
  } finally {
    if (f) await f.close();
    await sign.close();
    w.cleanup();
  }
});

test('F05. owner closing mid-request resolves owner_unavailable without the full timeout', async () => {
  const { sock, rm } = tmpsock('f05');
  // A server that accepts and immediately destroys the connection: no response.
  const srv = await rawServer(sock, (conn) => conn.destroy());
  try {
    const client = new IpcAuthorizationClient(sock);
    const started = Date.now();
    const r = await client.authorize({
      paymentDigest: 'a'.repeat(64),
      network: NETWORK,
      version: 1,
      sender: SENDER,
      sponsor: SPONSOR,
      recipient: RECIPIENT,
      asset: 'CCD',
      amount: '250000',
      expiry: NOW + 200,
      energy: 300n,
    });
    const elapsed = Date.now() - started;
    eq(r.outcome, 'owner_unavailable', 'owner unavailable');
    ok(elapsed < 5_000, `resolved in ${elapsed}ms, not the 10s timeout`);
  } finally {
    await srv.close();
    rm();
  }
});

test('F06. facilitator database files are 0600 after startup', async () => {
  const w = fws('perm');
  const identity = dbIdentityOf(w.db);
  const sign = await dummySigningService(w.signSock);
  const owner = await stubOwner(w.authzSock, identity);
  let f: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    f = await startFacilitator(realEnvF(w), { nodeClient: fakeNode() as never });
    const mode = statSync(w.db).mode & 0o777;
    eq(mode, 0o600, `db is 0600 (got 0o${mode.toString(8)})`);
    for (const suffix of ['-wal', '-shm']) {
      const p = `${w.db}${suffix}`;
      if (existsSync(p)) {
        const m = statSync(p).mode & 0o777;
        eq(m, 0o600, `${suffix} is 0600 (got 0o${m.toString(8)})`);
      }
    }
  } finally {
    if (f) await f.close();
    await owner.close();
    await sign.close();
    w.cleanup();
  }
});

// ═══ runner ═════════════════════════════════════════════════════════════════

(async () => {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\nfacilitator-sponsor-signer-wiring: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
