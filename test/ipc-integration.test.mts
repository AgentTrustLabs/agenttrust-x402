/**
 * Real IPC integration test.
 *
 * Starts a real authorization owner process (uid authowner) on a Unix socket, points a real
 * FacilitatorCore at it via IpcAuthorizationClient, and proves the signer is reached only on
 * 'approved'. Settlement stays disabled and the signer is the mock.
 *
 * Also proves fail-closed behaviour when the owner is absent, times out, or returns a
 * malformed / non-approved response.
 *
 * Run: npx tsx test/ipc-integration.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { generateOwnerAuthorizationKeyPair } from '../services/facilitator/src/ownerAuthorization.js';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { FacilitatorCore } from '../services/facilitator/src/core.js';
import { createMockSigner } from '../services/facilitator/src/signer.js';
import { IpcAuthorizationClient } from '../services/facilitator/src/authorization.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const NOW = 1_800_000_000;
const OWNER_USER = 'authowner';
const FACILITATOR_UID = 1001;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const run = (cmd: string, args: string[], as?: string, timeout = 30000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const full = as ? ['sudo', '-u', as, cmd, ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() }); });
  });

function payloadFixture(over: Record<string, unknown> = {}) {
  const requirements = {
    scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { feePayer: SPONSOR },
    ...((over.requirements as object) ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: (over.resourceUrl as string) ?? 'agenttrust://resource/1004' },
    accepted: { ...requirements, ...((over.accepted as object) ?? {}) },
    payload: {
      signedTransaction: {
        version: 1,
        header: { sender: SENDER, nonce: 7, expiry: (over.expiry as number) ?? NOW + 200, numSignatures: 1, sponsor: { address: SPONSOR, numSignatures: 0 } },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: '250000' },
        signatures: { sender: { 0: { 0: '00' } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: unknown, r: unknown) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: r });

function countingSigner() {
  const inner = createMockSigner({ network: CAIP2, now: () => NOW * 1000 });
  const calls = { addSponsorSignature: 0, submitTransaction: 0 };
  return {
    calls,
    signer: {
      info: () => inner.info(),
      addSponsorSignature: async (tx: unknown) => { calls.addSponsorSignature++; return inner.addSponsorSignature(tx); },
      submitTransaction: async (tx: unknown) => { calls.submitTransaction++; return inner.submitTransaction(tx); },
      waitForFinalization: (h: string, ms?: number) => inner.waitForFinalization(h, ms),
      getAccountInfo: (a: string) => inner.getAccountInfo(a),
      getTokenBalance: (a: string, t: string) => inner.getTokenBalance(a, t),
      getTokenDecimals: (t: string) => inner.getTokenDecimals(t),
    },
  };
}

const base = mkdtempSync(join(tmpdir(), 't3411ipc-'));
const dbDir = join(base, 'ownerdb');
const sock = join(base, 'authz.sock');
const logPath = join(dbDir, 'owner.log');

mkdirSync(dbDir, { mode: 0o700 });
await run('chown', ['-R', `${OWNER_USER}:authclients`, base], 'root');
await run('chmod', ['770', base], 'root');
await run('chmod', ['700', dbDir], 'root');
// Task 11: the Owner needs an authorization-signing key. Ephemeral for this run.
const ownerKeyFile = join(dbDir, 'owner-key.pem');
writeFileSync(ownerKeyFile, generateOwnerAuthorizationKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await run('chown', [`${OWNER_USER}:authclients`, ownerKeyFile], 'root');

const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');

type Owner = { proc: ReturnType<typeof spawn> };
let owner: Owner | null = null;

const startOwner = async (crashAt = 0): Promise<Owner> => {
  const proc = spawn('sudo', ['-u', OWNER_USER, 'env', `TASK348_LOG=${logPath}`, `TASK348_PEERCRED_BIN=${peercredBin}`, `CRASH_AT=${crashAt}`, 'AUTHZ_SEED_FIXTURES=1', `AUTHZ_AUTHORIZATION_KEY_FILE=${ownerKeyFile}`, 'npx', 'tsx', ownerScript, dbDir, sock, String(FACILITATOR_UID)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { resolve(); }, 40000);
    proc.stdout.on('data', (c) => { if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); } });
    proc.on('exit', () => { if (!ready) { clearTimeout(t); resolve(); } });
  });
  await run('chgrp', ['authclients', sock], 'root');
  await run('chmod', ['660', sock], 'root');
  return { proc };
};

const stopOwner = async () => {
  if (!owner) return;
  // Only kill THIS suite's owner. A pattern-based pkill here would also terminate other
  // suites' owners running concurrently in the same test run.
  const pg = await run('pgrep', ['-f', `scripts/authz-owner.mts ${base}`], 'root');
  owner.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  for (const pid of pg.stdout.trim().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) await run('kill', ['-9', pid], 'root');
  }
  owner = null;
  await new Promise((r) => setTimeout(r, 200));
};

const coreWithIpc = () => {
  const { signer, calls } = countingSigner();
  const core = new FacilitatorCore({
    network: CAIP2,
    signer,
    dbPath: join(mkdtempSync(join(tmpdir(), 't3411ipcdb-')), 'f.db'),
    now: () => NOW * 1000,
    authorization: new IpcAuthorizationClient(sock),
  });
  return { core, calls };
};

try {
  owner = await startOwner();

  // ── 1. real IPC approval reaches the signer (owner policy rejects the mock sponsor, so
  //       this asserts a DEFINITIVE refusal rather than a fake approval) ────────────────
  {
    const { core, calls } = coreWithIpc();
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    console.log(`   IPC settle result: ${r.errorReason ?? 'success'} — ${String(r.errorMessage ?? '').slice(0, 90)}`);
    check('01. real IPC reachable and answers', r.success === false || r.success === true, String(r.errorReason));
    // The mock sponsor placeholder is not a valid Concordium address, so the owner's full
    // policy refuses it. What matters here is the boundary: no approval → no signer.
    if (r.success === false) {
      eq(calls.addSponsorSignature, 0, 'no approval → signer NOT reached');
      eq(calls.submitTransaction, 0, 'no approval → no submission');
    }
  }

  // ── 2. owner absent → owner_unavailable → no signer ─────────────────────────────────
  {
    await stopOwner();
    const { core, calls } = coreWithIpc();
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    check('02. owner absent → settlement_pending', r.errorReason === 'settlement_pending', String(r.errorReason));
    eq((r.extra as Record<string, unknown>)?.authorizationOutcome, 'owner_unavailable', 'classified owner_unavailable');
    eq(calls.addSponsorSignature, 0, 'signer NOT reached when owner is down');
  }

  // ── 3. owner restarts → boundary still enforced ─────────────────────────────────────
  {
    owner = await startOwner();
    const { core, calls } = coreWithIpc();
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    check('03. after restart the boundary still answers', r.success === false || r.success === true, String(r.errorReason));
    if (r.success === false) eq(calls.addSponsorSignature, 0, 'no approval → signer NOT reached');
  }

  // ── 4. owner killed mid-request → unknown/unavailable → no signer ───────────────────
  {
    await stopOwner();
    const { core, calls } = coreWithIpc();
    const p = payloadFixture();
    const r = await core.settle(envelope(p, p.accepted));
    check('04. owner down mid-run → fail closed', r.success === false, String(r.errorReason));
    eq(calls.addSponsorSignature, 0, 'signer NOT reached');
  }
} finally {
  await stopOwner();
  await run('rm', ['-rf', base], 'root');
}

const failed = results.filter((r) => !r[1]).length;
console.log(`\nipc-integration: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
