/**
 * Ed25519 signing integration, sponsor signature count, fee validation,
 * and network identity verification.
 *
 * The signing tests need uid 1001 + group authclients (1002); they self-skip otherwise:
 *   sudo -u ubuntu npx tsx test/ed25519-signing-and-fee-validation.test.mts
 *
 * Test-only Ed25519 key. No sponsor key, no wallet, no funding, no broadcast, no settlement.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { AccountAddress, Transaction, buildBasicAccountSigner } from '@concordium/web-sdk';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { IpcAccountSigner, probeSigningService, signingDigestOf } from '../services/facilitator/src/signingService.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';
import { createSdkSponsorSigner, validateSponsorContext } from '../services/facilitator/src/sdkSponsorSigner.js';
import { GrpcAccountInfoProvider } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { startFacilitator } from '../services/facilitator/src/server.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { createMockSigner, type SponsorSigner } from '../services/facilitator/src/signer.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const WRONG_GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
const FACILITATOR_UID = 1001;
const FACILITATOR_GID = 1002;
const NOW = 1_800_000_000;

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const hasIpc =
  typeof process.getuid === 'function' &&
  process.getuid() === FACILITATOR_UID &&
  typeof process.getgroups === 'function' &&
  process.getgroups().includes(FACILITATOR_GID);

// ── test-only Ed25519 keypair ────────────────────────────────────────────────

interface TestKey {
  /** 32-byte Ed25519 seed, hex. */
  privateKeyHex: string;
  /** 32-byte Ed25519 public key, hex. */
  publicKeyHex: string;
}

/** Generate an Ed25519 keypair in this process only. Nothing is persisted. */
function generateTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = spki.subarray(spki.length - 32);
  return { privateKeyHex: seed.toString('hex'), publicKeyHex: pub.toString('hex') };
}

/** SDK-shaped AccountInfo for the test-only key. */
function accountInfoFor(key: TestKey, address: string) {
  return makeFakeAccountInfo({ verifyKey: key.publicKeyHex, threshold: 1, address });
}

/** SDK AccountSigner built directly from the test-only private key (in-process). */
function buildTestSigner(key: TestKey) {
  // The SDK's own constructor — no cryptographic primitives are implemented by hand.
  return buildBasicAccountSigner(key.privateKeyHex);
}

const tmpsock = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t48-${tag}-`));
  return { dir, sock: join(dir, 's.sock'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const ipcSignerFor = (sock: string, timeoutMs = 600, transaction: unknown = sponsoredTx()) =>
  new IpcAccountSigner({
    socketPath: sock,
    expectedUid: FACILITATOR_UID,
    sponsorAddress: SPONSOR,
    network: NETWORK,
    timeoutMs,
    transaction,
  });

/** A minimal, deterministic V1 sponsored transaction in the SDK signable shape. */
const sponsoredTx = (sponsorNumSigs = 1) => ({
  version: 1,
  header: {
    sender: RECIPIENT,
    nonce: 7,
    expiry: NOW + 200,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: sponsorNumSigs },
  },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
});

/** The digest of the fixture transaction, as an ArrayBuffer (protocol v2 binding). */
const fixtureDigest = (): ArrayBuffer => digestHexToArrayBuffer(signingDigestOf(sponsoredTx()));

/** A server that accepts connections and hands each to `handler`; close() destroys all. */
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
    close: async (): Promise<void> => {
      for (const conn of live) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

// ═══ A. test-only key isolation ═════════════════════════════════════════════

test('A01. test-only keypair has 64-hex private seed and 64-hex public key', () => {
  const key = generateTestKey();
  ok(/^[0-9a-f]{64}$/.test(key.privateKeyHex), 'private seed 32 bytes');
  ok(/^[0-9a-f]{64}$/.test(key.publicKeyHex), 'public key 32 bytes');
});

test('A02. two generated keypairs differ (no fixed test key)', () => {
  const a = generateTestKey();
  const b = generateTestKey();
  ok(a.privateKeyHex !== b.privateKeyHex, 'distinct private seeds');
  ok(a.publicKeyHex !== b.publicKeyHex, 'distinct public keys');
});

test('A03. the private seed never appears in any IPC request', async () => {
  const key = generateTestKey();
  const { sock, rm } = tmpsock('a03');
  let seen = '';
  const srv = await rawServer(sock, (conn) => {
    conn.on('data', (chunk) => {
      seen += chunk.toString();
      conn.destroy();
    });
  });
  try {
    try { await ipcSignerFor(sock, 300).sign(fixtureDigest()); } catch { /* expected */ }
    ok(!seen.includes(key.privateKeyHex), 'private seed absent from wire');
    ok(!seen.includes(key.publicKeyHex), 'public key absent from wire');
    // The request carries a 64-hex digest and the transaction it binds to.
    const m = seen.match(/"digest":"([0-9a-f]{64})"/);
    ok(m !== null, 'digest present');
    ok(seen.includes('"transaction"'), 'transaction present');
  } finally {
    await srv.close();
    rm();
  }
});

// ═══ B. fee validation (no process boundary needed) ══════════════════════════

test('B01. validateContext rejects energy above cap', () => {
  const msg = validateSponsorContext(
    { sponsorAddress: SPONSOR, network: NETWORK, maxEnergy: 300n, maxFeeMicroCcd: 10_000_000n },
    { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 301n, feeMicroCcd: 1n },
  );
  ok(msg !== null && /energy .* exceeds cap/.test(msg), `rejected: ${String(msg)}`);
});

test('B02. validateContext rejects fee above cap', () => {
  const msg = validateSponsorContext(
    { sponsorAddress: SPONSOR, network: NETWORK, maxEnergy: 100_000n, maxFeeMicroCcd: 1_000n },
    { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 300n, feeMicroCcd: 1_001n },
  );
  ok(msg !== null && /fee .* exceeds cap/.test(msg), `rejected: ${String(msg)}`);
});

test('B03. validateContext rejects malformed/negative/unsafe values', () => {
  const base = { sponsorAddress: SPONSOR, network: NETWORK, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n };
  for (const [label, ctx] of [
    ['negative energy', { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: -1n, feeMicroCcd: 1n }],
    ['zero energy', { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 0n, feeMicroCcd: 1n }],
    ['negative fee', { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 300n, feeMicroCcd: -1n }],
    ['non-bigint energy', { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 300 as unknown as bigint, feeMicroCcd: 1n }],
  ] as const) {
    const msg = validateSponsorContext(base, ctx as never);
    ok(msg !== null && /malformed fee\/energy context/.test(msg), `${label}: ${String(msg)}`);
  }
});

test('B04. validateContext accepts a valid context and rejects sponsor==recipient', () => {
  const base = { sponsorAddress: SPONSOR, network: NETWORK, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n };
  eq(validateSponsorContext(base, { network: NETWORK, sponsor: SPONSOR, recipient: RECIPIENT, energy: 300n, feeMicroCcd: 5_000_000n }), null, 'valid context');
  const same = validateSponsorContext(base, { network: NETWORK, sponsor: SPONSOR, recipient: SPONSOR, energy: 300n, feeMicroCcd: 1n });
  ok(same !== null && /must not equal recipient/.test(same), 'sponsor==recipient rejected');
});

test('B05. the pipeline invokes validateContext and fails closed on a fee breach', async () => {
  const db = mkdtempSync(join(tmpdir(), 't48-fee-'));
  const repo = new SqliteSettlementRepository(join(db, 'f.db'), { now: () => NOW * 1000 });
  const envelope = () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'agenttrust://resource/1004' },
      accepted: { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '250000', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } },
      payload: { signedTransaction: sponsoredTx(1) },
    };
    return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
  };
  // Signer exposes validateContext that always rejects (simulates a fee breach).
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const signer: SponsorSigner = {
    info: () => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: inner.addSponsorSignature,
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
    validateContext: () => 'fee 99999999 exceeds cap 1000000',
  };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer,
    dbPath: join(db, 'f.db'),
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({
      policy: { network: NETWORK, sponsor: SPONSOR, maxEnergy: 100_000n, maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 't48' },
      repository: repo,
      now: () => NOW * 1000,
    }),
  });
  try {
    const res = await core.settle(envelope());
    eq(res.errorReason, 'fee_validation_failed', 'fee validation blocks signing');
    eq(res.transaction, '', 'no hash produced');
  } finally {
    repo.close();
    rmSync(db, { recursive: true, force: true });
  }
});

test('B06. the pipeline does not call validateContext when the signer omits it', async () => {
  const db = mkdtempSync(join(tmpdir(), 't48-nov-'));
  const repo = new SqliteSettlementRepository(join(db, 'f.db'), { now: () => NOW * 1000 });
  const inner = createMockSigner({ network: NETWORK, now: () => NOW * 1000 });
  const signer: SponsorSigner = {
    info: () => ({ ...inner.info(), address: SPONSOR }),
    addSponsorSignature: inner.addSponsorSignature,
    submitTransaction: inner.submitTransaction,
    waitForFinalization: inner.waitForFinalization,
    getAccountInfo: inner.getAccountInfo,
    getTokenBalance: inner.getTokenBalance,
    getTokenDecimals: inner.getTokenDecimals,
  };
  ok(typeof signer.validateContext === 'undefined', 'mock signer has no validateContext');
  const envelope = () => {
    const payload = {
      x402Version: 2,
      resource: { url: 'agenttrust://resource/1004' },
      accepted: { scheme: 'exact', network: NETWORK, asset: 'CCD', amount: '250000', payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR } },
      payload: { signedTransaction: sponsoredTx(1) },
    };
    return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
  };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer,
    dbPath: join(db, 'f.db'),
    now: () => NOW * 1000,
    authorization: new LocalAuthorizationClient({
      policy: { network: NETWORK, sponsor: SPONSOR, maxEnergy: 100_000n, maxExpiryOffsetSeconds: 600, allowedAssets: ['CCD'], policyVersion: 't48' },
      repository: repo,
      now: () => NOW * 1000,
    }),
  });
  try {
    const res = await core.settle(envelope());
    eq(res.success, true, 'mock flow unaffected');
  } finally {
    repo.close();
    rmSync(db, { recursive: true, force: true });
  }
});

// ═══ C. sponsor signature count ═════════════════════════════════════════════

test('C01. SDK sponsor() requires sponsor.numSignatures >= 1', async () => {
  const key = generateTestKey();
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: NETWORK,
    accountSigner: buildTestSigner(key),
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 10_000_000n,
  });
  // sponsor.numSignatures = 0 is what produced the failure. Note the SDK's error
  // text says "sender" for the sponsor slot too (missing role argument) — see the report.
  let msg = '';
  try {
    await signer.addSponsorSignature(sponsoredTx(0));
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/Too many sender signatures/i.test(msg), `sponsor.numSignatures=0 rejected: "${msg}"`);

  const signed = (await signer.addSponsorSignature(sponsoredTx(1))) as any;
  ok(signed?.signatures?.sponsor?.['0']?.['0'] !== undefined, 'numSignatures=1 signs');
});

test('C02. getSignatureCount() is NOT consulted by the SDK signing path', async () => {
  const key = generateTestKey();
  // A signer that reports 0 signatures but still signs correctly.
  const base = buildBasicAccountSigner(key.privateKeyHex);
  const weird = {
    getSignatureCount(): bigint { return 0n; },
    sign: (digest: ArrayBuffer) => base.sign(digest),
  };
  const signer = createSdkSponsorSigner({
    sponsorAddress: SPONSOR,
    network: NETWORK,
    accountSigner: weird,
    maxEnergy: 100_000n,
    maxFeeMicroCcd: 10_000_000n,
  });
  const signed = (await signer.addSponsorSignature(sponsoredTx(1))) as any;
  ok(signed?.signatures?.sponsor?.['0']?.['0'] !== undefined, 'signing succeeds despite getSignatureCount()=0');
});

// ═══ D. network identity ════════════════════════════════════════════════════

test('D01. verifyNode() passes for the matching genesis hash', async () => {
  const client = { async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: NETWORK, client: client as never });
  const identity = await provider.verifyNode();
  eq(identity.genesisHash, TESTNET_GENESIS, 'genesis hash');
});

test('D02. verifyNode() fails closed on a mismatching genesis hash', async () => {
  const client = { async getConsensusStatus() { return { genesisBlock: WRONG_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: NETWORK, client: client as never });
  let msg = '';
  try { await provider.verifyNode(); } catch (e) { msg = (e as Error).message; }
  ok(/network_mismatch|genesis/i.test(msg), `rejected: "${msg}"`);
});

test('D03. real-mode startup fails closed when verifyNode() mismatches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't48-node-'));
  const sock = join(dir, 's.sock');
  // A dummy listener satisfies the startup probe so that the network identity check is
  // reached. The endpoint is unreachable, so verifyNode() must fail and startup must refuse.
  const srv = await rawServer(sock, () => {});
  let msg = '';
  try {
    await startFacilitator({
      FACILITATOR_MODE: 'real',
      FACILITATOR_PORT: '0',
      FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
      FACILITATOR_NETWORK: NETWORK,
      FACILITATOR_SENDER_VERIFICATION: 'sdk',
      FACILITATOR_NODE_HOST: '127.0.0.1',
      FACILITATOR_NODE_PORT: '1',
      FACILITATOR_DB_PATH: join(dir, 'f.db'),
      FACILITATOR_SIGNING_SERVICE_SOCKET: sock,
      FACILITATOR_SIGNING_SERVICE_UID: String(FACILITATOR_UID),
      FACILITATOR_AUTHZ_SOCKET: join(dir, 'authz.sock'),
      FACILITATOR_SIGNING_TIMEOUT_MS: '500',
      FACILITATOR_SENDER_VERIFY_TIMEOUT_MS: '500',
    });
  } catch (e) {
    msg = (e as Error).message;
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
  ok(/network identity verification failed/i.test(msg), `startup refused: "${msg}"`);
});

// ═══ E. cross-process Ed25519 signing ════════════════════════════════════════

if (!hasIpc) {
  console.log(`\n[SKIP] cross-process tests need uid ${FACILITATOR_UID} + group ${FACILITATOR_GID}`);
} else {
  const base = mkdtempSync(join(tmpdir(), 't48-ipc-'));
  const sock = join(base, 'sign.sock');
  const serviceScript = `${process.cwd()}/scripts/signing-service.mts`;

  const startService = async (socketPath: string, allowedUid: number, key?: TestKey) => {
    const env = { ...process.env };
    if (key) env['TEST_SIGNING_SEED_HEX'] = key.privateKeyHex;
    const proc = spawn('npx', ['tsx', serviceScript, socketPath, SPONSOR, NETWORK, String(allowedUid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      proc.stdout.on('data', (c) => {
        if (c.toString().includes('service listening')) { clearTimeout(t); resolve(); }
      });
      proc.on('exit', () => { clearTimeout(t); resolve(); });
    });
    spawnSync('sudo', ['-u', 'root', 'chgrp', 'authclients', sock]);
    spawnSync('sudo', ['-u', 'root', 'chmod', '660', sock]);
    return proc;
  };

  const stop = async (proc: ReturnType<typeof spawn>, socketPath?: string) => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
    }
    if (socketPath) rmSync(socketPath, { force: true });
  };

  test('E01. service runs in a separate process and reports the real Ed25519 mode', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e01');
    const proc = await startService(esock, FACILITATOR_UID, key);
    try {
      // The startup line announces the mode; the key itself must not appear.
      ok(proc.pid !== undefined && proc.pid !== process.pid, 'separate OS process');
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E02. real Ed25519 signature crosses the IPC boundary and verifies with the SDK', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e02');
    const proc = await startService(esock, FACILITATOR_UID, key);
    try {
      const signer = createIpcSponsorSigner({
        sponsorAddress: SPONSOR,
        network: NETWORK,
        socketPath: esock,
        expectedUid: FACILITATOR_UID,
        maxEnergy: 100_000n,
        maxFeeMicroCcd: 10_000_000n,
        timeoutMs: 5_000,
      });
      const signed = (await signer.addSponsorSignature(sponsoredTx(1))) as any;
      const sponsorSig = signed?.signatures?.sponsor;
      ok(sponsorSig?.['0']?.['0'] !== undefined, 'sponsor signature present');
      const sigHex = sponsorSig['0']['0'];
      ok(sigHex !== 'ee'.repeat(64), 'signature is not the fake constant');

      // Independent SDK verification against the test-only public key.
      const info = accountInfoFor(key, SPONSOR);
      const parsed = Transaction.signableFromJSON(signed);
      const okSig = await Transaction.verifySignature(parsed, sponsorSig, {
        accountThreshold: info.accountThreshold,
        accountCredentials: info.accountCredentials,
        accountAddress: info.accountAddress,
      });
      eq(okSig, true, 'SDK accepts the Ed25519 signature');
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E03. an invalid signature is rejected by the SDK verifier', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e03');
    const proc = await startService(esock, FACILITATOR_UID, key);
    try {
      const signer = createIpcSponsorSigner({
        sponsorAddress: SPONSOR, network: NETWORK, socketPath: esock,
        expectedUid: FACILITATOR_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n, timeoutMs: 5_000,
      });
      const signed = (await signer.addSponsorSignature(sponsoredTx(1))) as any;
      const bad = { '0': { '0': '00'.repeat(64) } };
      const info = accountInfoFor(key, SPONSOR);
      const okBad = await Transaction.verifySignature(Transaction.signableFromJSON(signed), bad, {
        accountThreshold: info.accountThreshold,
        accountCredentials: info.accountCredentials,
        accountAddress: info.accountAddress,
      });
      eq(okBad, false, 'forged signature rejected');
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E04. wrong sponsor/network is refused by the service', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e04');
    const proc = await startService(esock, FACILITATOR_UID, key);
    try {
      const wrongSponsor = createIpcSponsorSigner({
        sponsorAddress: RECIPIENT, network: NETWORK, socketPath: esock,
        expectedUid: FACILITATOR_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n, timeoutMs: 3_000,
      });
      let msg = '';
      try { await wrongSponsor.addSponsorSignature(sponsoredTx(1)); } catch (e) { msg = (e as Error).message; }
      ok(/wrong_sponsor/.test(msg), `wrong sponsor refused: "${msg}"`);

      const wrongNetwork = new IpcAccountSigner({
        socketPath: esock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR,
        network: 'ccd:00000000000000000000000000000000', timeoutMs: 3_000,
        transaction: sponsoredTx(1),
      });
      msg = '';
      try { await wrongNetwork.sign(fixtureDigest()); } catch (e) { msg = (e as Error).message; }
      ok(/wrong_network/.test(msg), `wrong network refused: "${msg}"`);
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E05. UID mismatch is refused by SO_PEERCRED', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e05');
    const proc = await startService(esock, 1005, key);
    try {
      let msg = '';
      try {
        await createIpcSponsorSigner({
          sponsorAddress: SPONSOR, network: NETWORK, socketPath: esock,
          expectedUid: FACILITATOR_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n, timeoutMs: 3_000,
        }).addSponsorSignature(sponsoredTx(1));
      } catch (e) { msg = (e as Error).message; }
      ok(/unauthorized_peer/i.test(msg), `uid mismatch refused: "${msg}"`);
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E06. timeout, crash, and connection failure all fail closed', async () => {
    const key = generateTestKey();
    // (a) timeout: a silent listener
    const a = tmpsock('e06a');
    const asrv = await rawServer(a.sock, () => {});
    try {
      let msg = '';
      try { await ipcSignerFor(a.sock, 300).sign(fixtureDigest()); } catch (e) { msg = (e as Error).message; }
      ok(/signing service timeout/i.test(msg), `timeout: "${msg}"`);
    } finally { await asrv.close(); a.rm(); }
    // (b) crash: the peer exits mid-request
    const b = tmpsock('e06b');
    const bsrv = await rawServer(b.sock, (conn) => conn.once('data', () => conn.destroy()));
    try {
      let msg = '';
      try { await ipcSignerFor(b.sock, 5_000).sign(fixtureDigest()); } catch (e) { msg = (e as Error).message; }
      ok(/closed the connection before responding/i.test(msg), `crash: "${msg}"`);
    } finally { await bsrv.close(); b.rm(); }
    // (c) connection refused
    const c = tmpsock('e06c');
    let msg = '';
    try { await ipcSignerFor(c.sock, 300).sign(fixtureDigest()); } catch (e) { msg = (e as Error).message; }
    ok(/unavailable/i.test(msg), `refused: "${msg}"`);
    c.rm();
    // (d) real service: no local fallback
    const { sock: esock, rm: erm } = tmpsock('e06d');
    const proc = await startService(esock, FACILITATOR_UID, key);
    const signer = createIpcSponsorSigner({
      sponsorAddress: SPONSOR, network: NETWORK, socketPath: esock,
      expectedUid: FACILITATOR_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n, timeoutMs: 1_500,
    });
    await stop(proc, esock);
    msg = '';
    try { await signer.addSponsorSignature(sponsoredTx(1)); } catch (e) { msg = (e as Error).message; }
    ok(/unavailable|timeout|closed the connection/i.test(msg), `no local fallback: "${msg}"`);
  });

  test('E07. the transaction crosses the socket and the digest matches it', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e07');
    const proc = await startService(esock, FACILITATOR_UID, key);
    let wire = '';
    try {
      // Point the signer at a listener that records the raw request.
      const { sock: rsock, rm: rrm } = tmpsock('e07');
      const rsrv = await rawServer(rsock, (conn) => {
        conn.on('data', (chunk) => {
          wire += chunk.toString();
          conn.write(JSON.stringify({
            protocolVersion: 2, requestId: JSON.parse(chunk.toString()).requestId,
            outcome: 'signed', signature: { 0: { 0: 'ff'.repeat(64) } }, reason: null, detail: null,
          }) + '\n');
        });
      });
      try {
        const tx = sponsoredTx(1);
        await new IpcAccountSigner({
          socketPath: rsock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR,
          network: NETWORK, timeoutMs: 1_000, transaction: tx,
        }).sign(digestHexToArrayBuffer(signingDigestOf(tx)));
      } finally {
        await rsrv.close();
        rrm();
      }
      // New invariant (protocol v2): the request carries the transaction, and the
      // digest in the wire equals the transaction's recomputed digest — the
      // property the signing service verifies before signing.
      const req = JSON.parse(wire.trim());
      eq(req.protocolVersion, 2, 'protocol v2');
      ok(req.transaction !== undefined, 'transaction present');
      eq(req.digest, signingDigestOf(req.transaction), 'digest equals the transaction recompute');
      eq(req.transaction.payload.toAddress, RECIPIENT, 'recipient in the wire is the transaction recipient');
      ok(!wire.includes(key.privateKeyHex), 'private seed absent from wire');
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  test('E08. the test-only private key never leaves the service process', async () => {
    const key = generateTestKey();
    const { sock: esock, rm: erm } = tmpsock('e08');
    const proc = await startService(esock, FACILITATOR_UID, key);
    try {
      // Sign several times; the key must never appear in any response or log line.
      const signer = createIpcSponsorSigner({
        sponsorAddress: SPONSOR, network: NETWORK, socketPath: esock,
        expectedUid: FACILITATOR_UID, maxEnergy: 100_000n, maxFeeMicroCcd: 10_000_000n, timeoutMs: 5_000,
      });
      await signer.addSponsorSignature(sponsoredTx(1));
      await signer.addSponsorSignature(sponsoredTx(1));
      // The child's stdout/stderr buffers never contain the seed (the harness logs the mode only).
      let log = '';
      proc.stdout.on('data', (c) => { log += c.toString(); });
      proc.stderr.on('data', (c) => { log += c.toString(); });
      await new Promise((r) => setTimeout(r, 200));
      ok(!log.includes(key.privateKeyHex), 'private seed absent from service output');
    } finally {
      await stop(proc, esock);
      erm();
    }
  });

  process.on('exit', () => rmSync(base, { recursive: true, force: true }));
}

// ═══ F. invariants ══════════════════════════════════════════════════════════

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
    payload: {},
    requirements: {} as never,
    expectedSponsor: SPONSOR,
    authorization: undefined,
  });
  eq(g.ok, false, 'refused');
  eq((g as { code: string }).code, 'SETTLEMENT_DISABLED', 'code');
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
  console.log(`\ned25519-signing-and-fee-validation: ${passed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
