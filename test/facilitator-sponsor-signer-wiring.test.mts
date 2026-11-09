/**
 * TASK 46 — facilitator sponsor signer IPC wiring.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, notOk, ok } from './helpers.mjs';
import { ConfigurationError, loadConfig } from '../services/facilitator/src/config.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { IpcAccountSigner, probeSigningService } from '../services/facilitator/src/signingService.js';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { SponsorSigner } from '../services/facilitator/src/signer.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const FACILITATOR_UID = 1001;
const FACILITATOR_GID = 1002;
const SVC_UID = 1001; // the TASK44 harness runs as this same UID
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
  // TASK 48 wires verifyNode() into real-mode startup; the public Testnet gRPC endpoint
  // requires TLS, so the fixture must say so or the genesis check cannot connect.
  FACILITATOR_NODE_USE_TLS: '1',
  FACILITATOR_DB_PATH: '/tmp/t46-real.db',
  FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t46-sign.sock',
  FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID),
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

const digestBytes = (): ArrayBuffer => {
  const b = Buffer.from('11'.repeat(32), 'hex');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
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
        payload: { type: 'transfer', toAddress: RECIPIENT, amount: '1' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
      },
    },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

const ipcSignerFor = (sock: string, timeoutMs = 600) =>
  new IpcAccountSigner({
    socketPath: sock,
    expectedUid: SVC_UID,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs,
  });

const expectSignError = async (sock: string, re: RegExp, label: string, timeoutMs = 600) => {
  let message = '';
  try {
    await ipcSignerFor(sock, timeoutMs).sign(digestBytes());
  } catch (e) {
    message = (e as Error).message;
  }
  ok(re.test(message), `${label}: got "${message}"`);
};

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
      await signer.addSponsorSignature(envelope().paymentPayload.payload);
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
  const serviceScript = `${process.cwd()}/scripts/signing-ipc-service.mts`;

  const startService = async (allowedUid: number) => {
    const proc = spawn('npx', ['tsx', serviceScript, sock, SPONSOR, NETWORK, String(allowedUid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
    addSponsorSignature: async (tx: unknown) => {
      calls.sign++;
      return inner.addSponsorSignature(tx);
    },
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  });

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
    const proc = await startService(FACILITATOR_UID);
    const repo = new SqliteSettlementRepository(join(base, 'e02.db'), { now: () => NOW * 1000 });
    const calls = { sign: 0 };
    const core = new FacilitatorCore({
      network: NETWORK,
      signer: countedSigner(ipc(FACILITATOR_UID), calls),
      dbPath: join(base, 'e02.db'),
      now: () => NOW * 1000,
      authorization: localAuth(repo),
    });
    try {
      const res = await core.settle(envelope());
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
        await ipc(FACILITATOR_UID, 3_000).addSponsorSignature(envelope().paymentPayload.payload);
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
      await signer.addSponsorSignature(envelope().paymentPayload.payload);
    } catch (e) {
      message = (e as Error).message;
    }
    ok(/unavailable|timeout|closed the connection/i.test(message), `post-shutdown signing refused: "${message}"`);
  });

  process.on('exit', () => rmSync(base, { recursive: true, force: true }));
}

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
  console.log(`\ntask46: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
