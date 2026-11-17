/**
 * Production signing launcher Owner-authorization wiring.
 *
 * The production launcher (scripts/sponsor-wallet-service.mts) shipped
 * without ownerAuthorization, so createSigningService threw at construction
 * and the service could never start. These tests pin the fix:
 *
 *   1. missing Owner configuration refuses startup (exit 2)
 *   2. a missing Owner public key alone refuses startup (exit 2)
 *   3. an invalid Owner public key refuses startup before listening
 *   4. full configuration reaches listening and stops cleanly
 *   5. an invalid peer identity is rejected (unauthorized_peer), no signature
 *   6. Owner socket unavailable: the consume client fails closed
 *      (owner_unavailable) — no fallback signing
 *   7. no authorization: the service rejects without signing
 *      (authorization_missing)
 *   8. valid certificate + Owner down: owner_unavailable, no signing
 *
 * Fixtures only: the wallet export is the repo's synthetic placeholder
 * (signKey 'aa', verifyKey 'bb', credential 'cc' — no real key material),
 * the Owner keypair is ephemeral per run, and the transaction is never
 * broadcast. No Owner process is spawned: cases 6–8 deliberately point the
 * consume client at a socket that does not exist, which is exactly the
 * "Owner down" condition.
 *
 * Root-UID boundary: the signing service refuses peer UID 0, so a test
 * running as root can never be a valid IPC peer. Case 5 uses that on
 * purpose (the test process IS the invalid peer); the positive IPC path
 * (a valid peer signing with a consumed authorization) is covered by the
 * uid-gated suites (separate-process-signing, ipc-signing) in CI.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@concordium/web-sdk';
import {
  generateOwnerAuthorizationKeyPair,
  issueOwnerAuthorizationCertificate,
  ownerAuthorizationPublicKeyHex,
  IpcOwnerConsumeClient,
  type OwnerAuthorizationCertificate,
  type OwnerAuthorizationFields,
} from '../services/facilitator/src/ownerAuthorization.js';
import { loadSponsorExportSigner } from '../services/facilitator/src/walletExportLoader.js';
import {
  createSigningService,
  signingDigestOf,
  type SigningRequest,
  type SigningResponse,
} from '../services/facilitator/src/signingService.js';

const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAYMENT_DIGEST = 'cc'.repeat(32);
const OWNER_UID = 1102;
const LAUNCHER = join(process.cwd(), 'scripts/sponsor-wallet-service.mts');

// ── tiny assertions (local: this file is typechecked by tsconfig.launcher,
// which must not pull in the untyped test helpers) ──────────────────────────
function ok(value: unknown, label: string): void {
  if (!value) throw new Error(`expected truthy: ${label}`);
}
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}: ${label}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── fixtures ────────────────────────────────────────────────────────────────
// Synthetic wallet export (repo's established placeholder shape): the real
// loader accepts it, no real key material anywhere.
function syntheticExport(): string {
  return JSON.stringify({
    type: 'concordium-browser-wallet-account',
    v: 0,
    environment: 'testnet',
    value: {
      accountKeys: {
        threshold: 1,
        keys: { '0': { keys: { '0': { signKey: 'aa'.repeat(32), verifyKey: 'bb'.repeat(32) } }, threshold: 1 } },
      },
      credentials: { '0': 'cc'.repeat(32) },
      address: SPONSOR,
    },
  });
}

function fixtureTx(expiry: number): Record<string, unknown> {
  return {
    version: 1,
    header: {
      sender: SENDER,
      nonce: 7,
      expiry,
      executionEnergyAmount: 300,
      numSignatures: 1,
      sponsor: { account: SPONSOR, numSignatures: 1 },
    },
    payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
    signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
  };
}

function recomputedEnergyOf(tx: unknown): bigint {
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

function certFieldsForTx(tx: Record<string, unknown>): OwnerAuthorizationFields {
  const header = tx['header'] as Record<string, unknown>;
  return {
    version: 1,
    authorizationId: randomUUID(),
    paymentDigest: PAYMENT_DIGEST,
    transactionDigest: signingDigestOf(tx),
    transactionType: 'transfer',
    network: CAIP2,
    sender: SENDER,
    sponsor: SPONSOR,
    recipient: RECIPIENT,
    asset: 'CCD',
    amount: '250000',
    expiry: Number(header['expiry']),
    energy: String(recomputedEnergyOf(tx)),
    maxEnergy: '10000',
    maxFeeMicroCcd: '10000000',
    policyVersion: 'test-v1',
    issuedAt: Date.now(),
  };
}

// ── process helpers (detached spawn + process-group kill: SIGTERM to the
// npx wrapper alone never reaches the node grandchild) ─────────────────────
interface Spawned {
  proc: ChildProcess;
  text: () => string;
  exited: Promise<number | null>;
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (proc.pid !== undefined) process.kill(-proc.pid, signal);
  } catch {
    /* already gone */
  }
}

function spawnLauncher(env: Record<string, string | undefined>): Spawned {
  const proc = spawn('npx', ['tsx', LAUNCHER], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  proc.stdout?.on('data', (d) => {
    out += String(d);
  });
  proc.stderr?.on('data', (d) => {
    out += String(d);
  });
  const exited = new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      killGroup(proc, 'SIGKILL');
      resolve(null);
    }, 30_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  return { proc, text: () => out, exited };
}

async function waitListening(s: Spawned, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (s.text().includes('service listening')) return true;
    const code = await Promise.race([s.exited, sleep(100).then(() => null)]);
    if (code !== null) return false;
  }
  return false;
}

async function stopLauncher(s: Spawned): Promise<number | null> {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return s.proc.exitCode;
  killGroup(s.proc, 'SIGTERM');
  const code = await Promise.race([s.exited, sleep(5_000).then(() => null)]);
  if (code !== null) return code;
  killGroup(s.proc, 'SIGKILL');
  return s.exited;
}

function ws(tag: string): { dir: string; exportPath: string; sock: string; ownerSock: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `sponsor-owner-${tag}-`));
  const exportPath = join(dir, 'synthetic-wallet.json');
  writeFileSync(exportPath, syntheticExport());
  chmodSync(exportPath, 0o600);
  return {
    dir,
    exportPath,
    sock: join(dir, 'sign.sock'),
    ownerSock: join(dir, 'owner.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function sponsorEnv(w: ReturnType<typeof ws>, allowedUid: number): Record<string, string> {
  return {
    FACILITATOR_SPONSOR_WALLET_FILE: w.exportPath,
    FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock,
    FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
    FACILITATOR_NETWORK: CAIP2,
    FACILITATOR_SIGNING_SERVICE_UID: String(allowedUid),
  };
}

function ownerEnv(w: ReturnType<typeof ws>, publicKeyHex: string, ownerUid = OWNER_UID): Record<string, string> {
  return {
    SIGNING_OWNER_PUBLIC_KEY: publicKeyHex,
    SIGNING_OWNER_SOCKET: w.ownerSock,
    SIGNING_OWNER_UID: String(ownerUid),
  };
}

// A bare connect (the service's own reachability probe does the same).
// Resolves true only while the server accepts connections.
function socketAccepts(sock: string, timeoutMs = 3_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const conn = createConnection(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, timeoutMs);
    conn.on('connect', () => {
      clearTimeout(timer);
      conn.end();
      resolve(true);
    });
    conn.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
// Raw JSON-lines request over the signing socket (the IPC client refuses to
// send a request without authorization, so the unevidenced cases need the
// raw socket).
function sendRawRequest(sock: string, request: Record<string, unknown>, timeoutMs = 5_000): Promise<SigningResponse> {
  return new Promise<SigningResponse>((resolve, reject) => {
    const conn = createConnection(sock);
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('raw request timeout'));
    }, timeoutMs);
    const fail = (message: string): void => {
      clearTimeout(timer);
      conn.destroy();
      reject(new Error(message));
    };
    conn.on('connect', () => {
      conn.write(JSON.stringify(request) + '\n');
    });
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      conn.end();
      try {
        resolve(JSON.parse(buf.slice(0, idx)) as SigningResponse);
      } catch {
        fail('malformed response from signing service');
      }
    });
    conn.on('error', (e) => fail(`signing service unavailable: ${e.message}`));
    conn.on('close', () => fail('signing service closed the connection before responding'));
  });
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('1. missing Owner configuration refuses startup (exit 2)', async () => {
  const w = ws('missing-owner');
  const s = spawnLauncher(sponsorEnv(w, 1101));
  try {
    const code = await s.exited;
    eq(code, 2, `exit 2 (got ${String(code)})`);
    ok(s.text().includes('SIGNING_OWNER_PUBLIC_KEY'), 'refusal names the Owner configuration');
    ok(!s.text().includes('service listening'), 'never reaches listening');
  } finally {
    if (s.proc.exitCode === null && s.proc.signalCode === null) killGroup(s.proc, 'SIGKILL');
    w.cleanup();
  }
});

test('2. missing Owner public key alone refuses startup (exit 2)', async () => {
  const w = ws('missing-key');
  const s = spawnLauncher({
    ...sponsorEnv(w, 1101),
    SIGNING_OWNER_SOCKET: w.ownerSock,
    SIGNING_OWNER_UID: String(OWNER_UID),
  });
  try {
    const code = await s.exited;
    eq(code, 2, `exit 2 (got ${String(code)})`);
    ok(s.text().includes('SIGNING_OWNER_PUBLIC_KEY'), 'refusal names the missing public key');
  } finally {
    if (s.proc.exitCode === null && s.proc.signalCode === null) killGroup(s.proc, 'SIGKILL');
    w.cleanup();
  }
});

test('3. invalid Owner public key refuses startup before listening', async () => {
  const w = ws('bad-key');
  const s = spawnLauncher({ ...sponsorEnv(w, 1101), ...ownerEnv(w, 'zz-not-hex') });
  try {
    const code = await s.exited;
    ok(code !== null && code !== 0, `non-zero exit (got ${String(code)})`);
    ok(s.text().includes('refusing to start'), 'clean refusal message, not a bare stack trace');
    ok(!s.text().includes('service listening'), 'never reaches listening');
  } finally {
    if (s.proc.exitCode === null && s.proc.signalCode === null) killGroup(s.proc, 'SIGKILL');
    w.cleanup();
  }
});

test('4. full configuration reaches listening and stops cleanly', async () => {
  const w = ws('full');
  const key = generateOwnerAuthorizationKeyPair();
  const s = spawnLauncher({ ...sponsorEnv(w, 1101), ...ownerEnv(w, ownerAuthorizationPublicKeyHex(key.publicKey)) });
  try {
    ok(await waitListening(s), 'launcher reaches listening');
    ok(existsSync(w.sock), 'signing socket exists');
    ok(await socketAccepts(w.sock), 'socket accepts a connection while running');
    const code = await stopLauncher(s);
    // The parent only sees the npx wrapper: a group SIGTERM kills the
    // wrapper by the signal (exit code null, signal SIGTERM), so the
    // service's own exit code is not observable through it. What IS
    // observable — and what this test pins — is that the service stopped
    // and released the socket (a bare SIGTERM to the wrapper alone would
    // leave the service orphaned and still listening).
    eq(code, null, 'wrapper exits by the group signal');
    eq(s.proc.signalCode, 'SIGTERM', 'group SIGTERM landed');
    ok(!(await socketAccepts(w.sock)), 'socket no longer accepts connections after stop');
  } finally {
    if (s.proc.exitCode === null && s.proc.signalCode === null) killGroup(s.proc, 'SIGKILL');
    w.cleanup();
  }
});

test('5. invalid peer identity is rejected (unauthorized_peer), no signature', async () => {
  const w = ws('bad-peer');
  const key = generateOwnerAuthorizationKeyPair();
  const publicKeyHex = ownerAuthorizationPublicKeyHex(key.publicKey);
  // The test process's own UID can never be a valid peer here: pick a
  // different UID so the request is refused by the peer gate.
  const myUid = typeof process.getuid === 'function' ? process.getuid() : 1001;
  const allowedUid = myUid + 1000;
  const s = spawnLauncher({ ...sponsorEnv(w, allowedUid), ...ownerEnv(w, publicKeyHex) });
  try {
    ok(await waitListening(s), 'launcher reaches listening');
    const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
    const cert = issueOwnerAuthorizationCertificate(certFieldsForTx(tx), key.privateKey);
    const res = await sendRawRequest(w.sock, {
      protocolVersion: 3,
      requestId: randomUUID(),
      operation: 'sign',
      digest: signingDigestOf(tx),
      transaction: tx,
      sponsor: SPONSOR,
      network: CAIP2,
      authorization: cert,
      paymentDigest: PAYMENT_DIGEST,
    });
    eq(res.outcome, 'protocol_error', `peer gate fires first (got ${res.outcome})`);
    eq(res.reason, 'unauthorized_peer', 'rejection names the peer, not the certificate');
    eq(res.signature, null, 'no signature is produced');
    // The rejection must not kill the service.
    ok(s.proc.exitCode === null && s.proc.signalCode === null, 'service stays alive after the rejected peer');
  } finally {
    await stopLauncher(s);
    w.cleanup();
  }
});

test('6. Owner socket unavailable: consume fails closed (owner_unavailable)', async () => {
  const w = ws('owner-down');
  try {
    const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
    const fields = certFieldsForTx(tx);
    const client = new IpcOwnerConsumeClient({ socketPath: w.ownerSock, ownerUid: OWNER_UID });
    const res = await client.consume({
      authorizationId: fields.authorizationId,
      transactionDigest: fields.transactionDigest,
      context: {
        paymentDigest: fields.paymentDigest,
        network: fields.network,
        sender: fields.sender,
        sponsor: fields.sponsor,
        recipient: fields.recipient,
        asset: fields.asset,
        amount: fields.amount,
        expiry: fields.expiry,
        energy: fields.energy,
        transactionType: fields.transactionType,
        maxEnergy: fields.maxEnergy,
        maxFeeMicroCcd: fields.maxFeeMicroCcd,
      },
    });
    eq(res.outcome, 'owner_unavailable', `no fallback when the Owner is down (got ${res.outcome})`);
  } finally {
    w.cleanup();
  }
});

test('7. no authorization: service rejects without signing (authorization_missing)', async () => {
  const w = ws('no-authz');
  try {
    const key = generateOwnerAuthorizationKeyPair();
    const signer = loadSponsorExportSigner(w.exportPath, SPONSOR);
    const svc = createSigningService({
      accountSigner: signer,
      sponsorAddress: SPONSOR,
      network: CAIP2,
      allowedUid: 1101,
      ownerAuthorization: {
        publicKey: ownerAuthorizationPublicKeyHex(key.publicKey),
        consume: new IpcOwnerConsumeClient({ socketPath: w.ownerSock, ownerUid: OWNER_UID }),
      },
    });
    try {
      const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
      // Deliberately unevidenced: no authorization, no payment digest.
      const req = {
        protocolVersion: 3,
        requestId: randomUUID(),
        operation: 'sign',
        digest: signingDigestOf(tx),
        transaction: tx,
        sponsor: SPONSOR,
        network: CAIP2,
      } as unknown as SigningRequest;
      const res = await svc.sign(req);
      eq(res.outcome, 'protocol_error', `unevidenced request refused (got ${res.outcome})`);
      eq(res.reason, 'authorization_missing', 'refusal names the missing authorization');
      eq(res.signature, null, 'no signature is produced');
    } finally {
      await svc.close();
    }
  } finally {
    w.cleanup();
  }
});

test('8. valid certificate + Owner down: owner_unavailable, no signing', async () => {
  const w = ws('valid-cert-owner-down');
  try {
    const key = generateOwnerAuthorizationKeyPair();
    const publicKeyHex = ownerAuthorizationPublicKeyHex(key.publicKey);
    const signer = loadSponsorExportSigner(w.exportPath, SPONSOR);
    const svc = createSigningService({
      accountSigner: signer,
      sponsorAddress: SPONSOR,
      network: CAIP2,
      allowedUid: 1101,
      ownerAuthorization: {
        publicKey: publicKeyHex,
        consume: new IpcOwnerConsumeClient({ socketPath: w.ownerSock, ownerUid: OWNER_UID }),
      },
    });
    try {
      const tx = fixtureTx(Math.floor(Date.now() / 1000) + 200);
      const cert: OwnerAuthorizationCertificate = issueOwnerAuthorizationCertificate(
        certFieldsForTx(tx),
        key.privateKey,
      );
      const res = await svc.sign({
        protocolVersion: 3,
        requestId: randomUUID(),
        operation: 'sign',
        digest: signingDigestOf(tx),
        transaction: tx,
        sponsor: SPONSOR,
        network: CAIP2,
        authorization: cert,
        paymentDigest: PAYMENT_DIGEST,
      });
      // The certificate verifies (otherwise the reason would name the
      // certificate), then consumption fails because the Owner is down.
      eq(res.outcome, 'owner_unavailable', `no signing without a consumed authorization (got ${res.outcome})`);
      eq(res.reason, 'owner_unavailable', 'failure names the unavailable Owner');
      eq(res.signature, null, 'no signature is produced');
    } finally {
      await svc.close();
    }
  } finally {
    w.cleanup();
  }
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${(e as Error).message}`);
  }
}
console.log(`\nsponsor-wallet-service-owner: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
