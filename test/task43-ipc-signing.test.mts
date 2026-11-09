/**
 * TASK 43 — IPC signing service integration test.
 *
 * Starts a real signing service on a Unix socket, then drives `IpcAccountSigner` against
 * it. Uses a deterministic fake signer. No real signing, no key material.
 *
 * Run (as the facilitator UID so the socket is reachable):
 *   sudo -u ubuntu npx tsx test/task43-ipc-signing.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { createSigningService, createFakeSigner, IpcAccountSigner } from '../services/facilitator/src/signingService.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const DIGEST = 'a'.repeat(64);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const FACILITATOR_UID = 1001;
const FACILITATOR_GID = 1002;

const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
const gids = typeof process.getgroups === 'function' ? process.getgroups() : [];
if (uid !== FACILITATOR_UID || !gids.includes(FACILITATOR_GID)) {
  console.log(`task43 IPC: SKIPPED — requires uid ${FACILITATOR_UID} + group ${FACILITATOR_GID}`);
  process.exit(0);
}

const base = mkdtempSync(join(tmpdir(), 't43ipc-'));
const dbDir = join(base, 'svc');
const sock = join(base, 'sign.sock');
mkdirSync(dbDir, { mode: 0o700 });

const run = (cmd: string, args: string[], as?: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const full = as ? ['sudo', '-u', as, cmd, ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() }));
  });

test('01. IpcAccountSigner signs through the IPC service', async () => {
  const signer = createFakeSigner({ signature: 'ee'.repeat(64) });
  const svc = createSigningService({ accountSigner: signer, sponsorAddress: SPONSOR, network: NETWORK, allowedUid: FACILITATOR_UID });
  await svc.listen(sock);
  try {
    const client = new IpcAccountSigner({ socketPath: sock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR, network: NETWORK });
    const sig = await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
    eq(sig[0]?.[0], 'ee'.repeat(64), 'signature from fake signer');
  } finally {
    await svc.close();
  }
});

test('02. wrong sponsor rejected by the service', async () => {
  const signer = createFakeSigner({ signature: 'ee'.repeat(64) });
  const svc = createSigningService({ accountSigner: signer, sponsorAddress: SPONSOR, network: NETWORK, allowedUid: FACILITATOR_UID });
  await svc.listen(sock);
  try {
    const client = new IpcAccountSigner({ socketPath: sock, expectedUid: FACILITATOR_UID, sponsorAddress: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', network: NETWORK });
    let threw = false;
    try {
      await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
    } catch (e) {
      threw = /wrong_sponsor/i.test((e as Error).message);
    }
    ok(threw, 'wrong sponsor rejected');
  } finally {
    await svc.close();
  }
});

test('03. wrong network rejected by the service', async () => {
  const signer = createFakeSigner({ signature: 'ee'.repeat(64) });
  const svc = createSigningService({ accountSigner: signer, sponsorAddress: SPONSOR, network: NETWORK, allowedUid: FACILITATOR_UID });
  await svc.listen(sock);
  try {
    const client = new IpcAccountSigner({ socketPath: sock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR, network: 'ccd:0000' });
    let threw = false;
    try {
      await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
    } catch (e) {
      threw = /wrong_network/i.test((e as Error).message);
    }
    ok(threw, 'wrong network rejected');
  } finally {
    await svc.close();
  }
});

test('04. signer failure propagates as a rejection', async () => {
  const signer = createFakeSigner({ behaviour: 'sign-throws' });
  const svc = createSigningService({ accountSigner: signer, sponsorAddress: SPONSOR, network: NETWORK, allowedUid: FACILITATOR_UID });
  await svc.listen(sock);
  try {
    const client = new IpcAccountSigner({ socketPath: sock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR, network: NETWORK });
    let threw = false;
    try {
      await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
    } catch (e) {
      threw = /signer_error|refused/i.test((e as Error).message);
    }
    ok(threw, 'signer failure propagated');
  } finally {
    await svc.close();
  }
});

test('05. service unavailable → error (no local fallback)', async () => {
  const client = new IpcAccountSigner({ socketPath: join(base, 'missing.sock'), expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR, network: NETWORK, timeoutMs: 1000 });
  let threw = false;
  try {
    await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
  } catch (e) {
    threw = /unavailable/i.test((e as Error).message);
  }
  ok(threw, 'no local fallback');
});

test('06. timeout → error', async () => {
  const signer = createFakeSigner({ behaviour: 'sign-hangs' });
  const svc = createSigningService({ accountSigner: signer, sponsorAddress: SPONSOR, network: NETWORK, allowedUid: FACILITATOR_UID });
  await svc.listen(sock);
  try {
    const client = new IpcAccountSigner({ socketPath: sock, expectedUid: FACILITATOR_UID, sponsorAddress: SPONSOR, network: NETWORK, timeoutMs: 200 });
    let threw = false;
    try {
      await client.sign(Buffer.from(DIGEST, 'hex').buffer.slice(0, 32) as ArrayBuffer);
    } catch (e) {
      threw = /timeout/i.test((e as Error).message);
    }
    ok(threw, 'timeout enforced');
  } finally {
    await svc.close();
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  rmSync(base, { recursive: true, force: true });
  console.log(`\ntask43 IPC: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
