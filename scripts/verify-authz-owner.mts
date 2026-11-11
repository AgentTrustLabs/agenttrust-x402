/**
 * Verification harness for the Authorization Owner integration.
 *
 * Runs the env-configured owner (real sponsor policy, shared facilitator
 * database) against the production IpcAuthorizationClient with dummy payment
 * digests, then proves the settle ordering at the core level with a recording
 * mock signer whose submit path refuses to broadcast.
 *
 * Nothing here signs a real transaction or submits anything: the only
 * signatures produced are dummy 64-byte values inside a mock signer, and the
 * only "settlement" outcome ever observed is settlement_pending.
 *
 * Run as the service user (uid 1001) from the repo root:
 *   npx tsx scripts/verify-authz-owner.mts
 *
 * Exit 0 when every check passes, 1 otherwise.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { IpcAuthorizationClient, type AuthorizationRequest } from '../services/facilitator/src/authorization.js';
import { FacilitatorCore } from '../services/facilitator/src/core.js';

const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const FACILITATOR_UID = 1001;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

if (typeof process.getuid === 'function' && process.getuid() !== FACILITATOR_UID) {
  console.error(`run as uid ${FACILITATOR_UID} (this process is uid ${process.getuid()})`);
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'verify-authz-'));
const ownerDir = join(base, 'ownerdb');
const sharedDb = join(base, 'shared.db');
const sock = join(base, 'authz.sock');
const ownerLog = join(ownerDir, 'owner.log');
mkdirSync(ownerDir, { mode: 0o700 });
const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const nowSec = () => Math.floor(Date.now() / 1000);

const ownerEnv = (maxEnergy: string, crashAt = 0): Record<string, string> => ({
  ...process.env as Record<string, string>,
  AUTHZ_SPONSOR_ADDRESS: SPONSOR,
  AUTHZ_NETWORK: NETWORK,
  AUTHZ_MAX_ENERGY: maxEnergy,
  AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
  AUTHZ_ALLOWED_ASSETS: 'CCD',
  AUTHZ_POLICY_VERSION: 'authz-prod-v1',
  AUTHZ_DB_FILE: sharedDb,
  AUTHZ_SEED_FIXTURES: '0',
  TASK348_LOG: ownerLog,
  CRASH_AT: String(crashAt),
});

type Owner = { proc: ChildProcess };
const startOwner = (maxEnergy: string, crashAt = 0): Promise<Owner> =>
  new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', ownerScript, ownerDir, sock, String(FACILITATOR_UID)], {
      env: ownerEnv(maxEnergy, crashAt),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const t = setTimeout(() => reject(new Error('owner start timeout')), 40_000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) {
        clearTimeout(t);
        resolve({ proc });
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`owner exited early code=${code}`));
    });
  });
const stopOwner = async (o: Owner, signal: NodeJS.Signals = 'SIGTERM') => {
  if (o.proc.exitCode === null && o.proc.pid !== undefined) {
    const exited = new Promise<void>((r) => o.proc.once('exit', () => r()));
    // Kill the whole process group: SIGTERM to `npx` alone leaves the node child alive.
    try { process.kill(-o.proc.pid, signal); } catch { o.proc.kill(signal); }
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5_000))]);
  }
};
// Note: the owner does not unlink its socket file on exit; a restart removes the
// stale socket itself (lstat + rmSync when it is a socket), so no wait is needed here.

// Start an owner on an arbitrary database file + socket, with an explicit env.
// Used by the F1/F2 checks, which need owners on different databases. An
// `undefined` value in envOver deletes that variable (F1 default test).
const startOwnerOn = (dbFile: string, sockPath: string, dirPath: string, envOver: Record<string, string | undefined>): Promise<Owner> =>
  new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env as Record<string, string>,
      AUTHZ_SPONSOR_ADDRESS: SPONSOR,
      AUTHZ_NETWORK: NETWORK,
      AUTHZ_MAX_ENERGY: '1000',
      AUTHZ_MAX_EXPIRY_OFFSET_SECONDS: '600',
      AUTHZ_ALLOWED_ASSETS: 'CCD',
      AUTHZ_POLICY_VERSION: 'authz-prod-v1',
      AUTHZ_DB_FILE: dbFile,
      TASK348_LOG: join(dirPath, 'owner.log'),
      CRASH_AT: '0',
      ...envOver,
    };
    for (const [k, v] of Object.entries(envOver)) if (v === undefined) delete env[k];
    const proc = spawn('npx', ['tsx', ownerScript, dirPath, sockPath, String(FACILITATOR_UID)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const t = setTimeout(() => reject(new Error('owner start timeout')), 40_000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) {
        clearTimeout(t);
        resolve({ proc });
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`owner exited early code=${code}`));
    });
  });

// Raw v1 client with an explicit requestId — the production IpcAuthorizationClient
// generates a fresh UUID per call, so requestId replay can only be exercised raw.
import { createConnection } from 'node:net';
const rawAuthorize = (requestId: string, digest: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const envelope = {
      protocolVersion: 1,
      requestId,
      operation: 'authorize',
      paymentDigest: digest,
      context: {
        network: NETWORK,
        version: 1,
        sender: SENDER,
        sponsor: SPONSOR,
        recipient: RECIPIENT,
        asset: 'CCD',
        amount: '250000',
        expiry: nowSec() + 200,
        energy: '300',
        ...over,
      },
    };
    const conn = createConnection(sock, () => conn.write(JSON.stringify(envelope) + '\n'));
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('raw client timeout'));
    }, 10_000);
    conn.on('data', (c) => {
      buf += c.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        conn.end();
        resolve(JSON.parse(buf.slice(0, idx)) as Record<string, unknown>);
      }
    });
    conn.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

const req = (digest: string, over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  paymentDigest: digest,
  network: NETWORK,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  asset: 'CCD',
  amount: '250000',
  expiry: nowSec() + 200,
  energy: 300n,
  ...over,
});
const D = (c: string) => c.repeat(64);

// ── seed dummy payments into the SHARED database (the facilitator side) ─────
const repo = new SqliteSettlementRepository(sharedDb, { now: () => Date.now() });
for (const d of [D('a'), D('b'), D('c'), D('d'), D('e'), D('f'), D('0'), D('1'), D('2')]) {
  repo.noteVerified(d, 'k');
  repo.claim(d, 'k');
}
const approvedCount = (digest: string) =>
  repo.signEvents(digest).filter((e) => e.decision === 'approved').length;

// ── direct-client flows against the owner ────────────────────────────────────
let owner = await startOwner('1000');
const client = new IpcAuthorizationClient(sock);

const aAuthReq = req(D('a'), {});
let r = await client.authorize(aAuthReq);
check('01. valid request is approved', r.outcome === 'approved', `${r.outcome}/${r.reason ?? '-'}`);

r = await client.authorize(req(D('e'), { sponsor: SENDER }));
check('02. wrong sponsor is rejected (wrong_sponsor)', r.outcome === 'rejected' && r.reason === 'wrong_sponsor', `${r.outcome}/${r.reason ?? '-'}`);

r = await client.authorize(req(D('f'), { expiry: nowSec() - 10 }));
check('03. expired request is rejected (expired)', r.outcome === 'rejected' && r.reason === 'expired', `${r.outcome}/${r.reason ?? '-'}`);

r = await client.authorize(req(D('0'), { energy: 1001n }));
check('04. energy over cap is rejected (energy_exceeds_cap)', r.outcome === 'rejected' && r.reason === 'energy_exceeds_cap', `${r.outcome}/${r.reason ?? '-'}`);

r = await client.authorize(req(D('1'), { network: 'eip155:1' }));
check('05. wrong network is rejected (wrong_network)', r.outcome === 'rejected' && r.reason === 'wrong_network', `${r.outcome}/${r.reason ?? '-'}`);

r = await client.authorize(req(D('2'), { asset: 'USDC' }));
check('06. unsupported asset is rejected (unsupported_asset)', r.outcome === 'rejected' && r.reason === 'unsupported_asset', `${r.outcome}/${r.reason ?? '-'}`);

// Duplicate: same digest, new requestId → no second approval.
r = await client.authorize(req(D('a'), {}));
check('07. duplicate authorize is refused (authorization_already_recorded)', r.outcome === 'rejected' && r.reason === 'authorization_already_recorded', `${r.outcome}/${r.reason ?? '-'}`);
check('08. exactly one approval recorded for the payment', approvedCount(D('a')) === 1, `approved=${approvedCount(D('a'))}`);

// Replay: same requestId + same canonical → the stored outcome is returned and no
// second approval is recorded; same requestId + different canonical → conflict.
let raw = await rawAuthorize('replay-1', D('b'));
check('09. raw requestId replay returns the stored approval', raw['outcome'] === 'approved', `${String(raw['outcome'])}/${String(raw['reason'] ?? '-')}`);
check('10. replay records no second approval', approvedCount(D('b')) === 1, `approved=${approvedCount(D('b'))}`);
raw = await rawAuthorize('replay-1', D('b'), { amount: '999999' });
check('11. same requestId with different canonical is refused (request_id_conflict)', raw['outcome'] === 'rejected' && raw['reason'] === 'request_id_conflict', `${String(raw['outcome'])}/${String(raw['reason'] ?? '-')}`);

// Recovery: matching context → approved; mismatched context → unknown.
r = await client.recover(aAuthReq);
check('12. recover with matching context reports approved', r.outcome === 'approved', `${r.outcome}/${r.reason ?? '-'}`);
r = await client.recover({ ...aAuthReq, amount: '999999' });
check('13. recover with mismatched context reports unknown (context_mismatch)', r.outcome === 'unknown' && r.reason === 'context_mismatch', `${r.outcome}/${r.reason ?? '-'}`);

// Owner dead → fail closed.
await stopOwner(owner);
r = await client.authorize(req(D('c'), {}));
check('14. owner dead fails closed (owner_unavailable)', r.outcome === 'owner_unavailable', `${r.outcome}/${r.reason ?? '-'}`);

// Restart → durable state survives.
owner = await startOwner('1000');
r = await client.authorize(req(D('c'), {}));
check('15. restart keeps durable state (new payment still authorizable)', r.outcome === 'approved', `${r.outcome}/${r.reason ?? '-'}`);
check('16. earlier approval still recorded after restart', approvedCount(D('a')) === 1, `approved=${approvedCount(D('a'))}`);

// Crash window: authorize commits, then the owner dies before the idempotency
// record and the response. Restart + same requestId → authorization_already_recorded,
// then recover proves the approval.
await stopOwner(owner);
owner = await startOwner('1000', 3);
const dAuthReq = req(D('d'), {});
r = await client.authorize(dAuthReq);
check('17. crash after commit surfaces as owner_unavailable (no false approval)', r.outcome === 'owner_unavailable', `${r.outcome}/${r.reason ?? '-'}`);
await new Promise((res) => setTimeout(res, 500));
await stopOwner(owner, 'SIGKILL').catch(() => {});
owner = await startOwner('1000');
r = await client.authorize(dAuthReq);
check('18. after crash, re-authorize reports authorization_already_recorded', r.outcome === 'rejected' && r.reason === 'authorization_already_recorded', `${r.outcome}/${r.reason ?? '-'}`);
r = await client.recover(dAuthReq);
check('19. after crash, recover proves the durable approval', r.outcome === 'approved', `${r.outcome}/${r.reason ?? '-'}`);

// Socket missing → fail closed.
const missingClient = new IpcAuthorizationClient(join(base, 'no-such.sock'));
r = await missingClient.authorize(req(D('a'), {}));
check('20. missing socket fails closed (owner_unavailable)', r.outcome === 'owner_unavailable', `${r.outcome}/${r.reason ?? '-'}`);

// ── core-level ordering: authorization before any signing ────────────────────
// The signed amount must equal the accepted amount (F5): the harness used to
// carry '1' here against an accepted '250000', which is exactly the mismatch
// the invariant now refuses.
const envelope = (nonce: number, signedAmount = '250000') => {
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
          sender: SENDER,
          nonce,
          expiry: nowSec() + 200,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: SPONSOR, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: RECIPIENT, amount: signedAmount },
        signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
      },
    },
  };
  return { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
};

const recordingSigner = (calls: { sign: number; submit: number }) => ({
  info: () => ({ address: SPONSOR, canSign: true }),
  addSponsorSignature: async (tx: unknown) => {
    calls.sign++;
    const t = tx as Record<string, unknown>;
    const sigs = (t['signatures'] as Record<string, unknown>) ?? {};
    return { ...t, signatures: { ...sigs, sponsor: { 0: { 0: 'ee'.repeat(64) } } } };
  },
  submitTransaction: async () => {
    calls.submit++;
    throw new Error('mock signer never broadcasts');
  },
  waitForFinalization: async () => ({ hash: '00'.repeat(32), status: 'finalized' as const }),
  getAccountInfo: async () => { throw new Error('not used in verification'); },
  getTokenBalance: async () => { throw new Error('not used in verification'); },
  getTokenDecimals: async () => { throw new Error('not used in verification'); },
});

// Owner cap 500 < derived transfer energy (603) → the owner is the authoritative
// gate: settle fails at authorization and the signer is never called.
await stopOwner(owner);
owner = await startOwner('500');
{
  const calls = { sign: 0, submit: 0 };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer: recordingSigner(calls) as never,
    dbPath: sharedDb,
    authorization: new IpcAuthorizationClient(sock),
    senderVerifier: async () => ({ ok: true }),
    now: () => Date.now(),
  });
  const res = await core.settle(envelope(11));
  check('21. owner rejection blocks settlement (authorization_rejected)', res.success === false && res.errorReason === 'authorization_rejected', `${String(res.errorReason)}`);
  check('22. signer never called when authorization is refused', calls.sign === 0, `sign calls=${calls.sign}`);
  core.store.close();
}

// Owner cap 1000 ≥ 603 → approval, then exactly one signer call; the mock
// submitter refuses to broadcast, so the only outcome is settlement_pending.
await stopOwner(owner);
owner = await startOwner('1000');
{
  const calls = { sign: 0, submit: 0 };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer: recordingSigner(calls) as never,
    dbPath: sharedDb,
    authorization: new IpcAuthorizationClient(sock),
    senderVerifier: async () => ({ ok: true }),
    now: () => Date.now(),
  });
  const res = await core.settle(envelope(12));
  check('23. approved payment reaches the signer exactly once', calls.sign === 1, `sign calls=${calls.sign}`);
  check('24. no broadcast: outcome is settlement_pending, never success', res.success === false && res.errorReason === 'settlement_pending', `${String(res.errorReason)}`);
  check('25. sponsored hash recorded (64 hex)', typeof res.transaction === 'string' && /^[0-9a-f]{64}$/.test(res.transaction), String(res.transaction).slice(0, 16));
  core.store.close();
}

// Owner dead at settle time → fail closed before any signing.
await stopOwner(owner);
{
  const calls = { sign: 0, submit: 0 };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer: recordingSigner(calls) as never,
    dbPath: sharedDb,
    authorization: new IpcAuthorizationClient(sock),
    senderVerifier: async () => ({ ok: true }),
    now: () => Date.now(),
  });
  const res = await core.settle(envelope(13));
  check('26. owner dead at settle time fails closed (settlement_pending, owner_unavailable)', res.success === false && res.errorReason === 'settlement_pending' && (res.extra as Record<string, unknown> | undefined)?.['authorizationOutcome'] === 'owner_unavailable', `${String(res.errorReason)}/${String((res.extra as Record<string, unknown> | undefined)?.['authorizationOutcome'])}`);
  check('27. signer never called when the owner is dead', calls.sign === 0, `sign calls=${calls.sign}`);
  core.store.close();
}

// ── fixes from the independent review (F1/F2/F3/F5/F7) ───────────────────────
// The owner is currently stopped (checks 26/27). Restart it for the live checks.
owner = await startOwner('1000');

// F5: amount mismatch is refused before authorization (signer 0 calls).
{
  const calls = { sign: 0, submit: 0 };
  const core = new FacilitatorCore({
    network: NETWORK,
    signer: recordingSigner(calls) as never,
    dbPath: sharedDb,
    authorization: new IpcAuthorizationClient(sock),
    senderVerifier: async () => ({ ok: true }),
    now: () => Date.now(),
  });
  const res = await core.settle(envelope(14, '1'));
  check('28. amount mismatch is refused before authorization (requirements_mismatch)', res.success === false && res.errorReason === 'requirements_mismatch' && /amount mismatch/i.test(String(res.errorMessage)), `${String(res.errorReason)}: ${String(res.errorMessage)}`);
  check('29. signer never called on amount mismatch', calls.sign === 0, `sign calls=${calls.sign}`);
  core.store.close();
}

// F2: db_identity reports the shared database (dev+ino match the facilitator file).
{
  const probe = await client.probeDbIdentity();
  const st = statSync(sharedDb);
  check('30. db_identity reports the shared database (dev+ino match)', probe.reachable === true && probe.dbDev === st.dev && probe.dbIno === st.ino, `owner dbDev=${probe.dbDev} dbIno=${probe.dbIno} vs file dev=${st.dev} ino=${st.ino}`);
}

// F2 (second owner): an owner on a different database reports a different identity.
{
  const f2Dir = join(base, 'f2db');
  mkdirSync(f2Dir, { mode: 0o700 });
  const f2Db = join(f2Dir, 'auth.db');
  const f2Sock = join(f2Dir, 'authz.sock');
  const o2 = await startOwnerOn(f2Db, f2Sock, f2Dir, { AUTHZ_SEED_FIXTURES: '0' });
  try {
    const probe2 = await new IpcAuthorizationClient(f2Sock).probeDbIdentity();
    const st = statSync(sharedDb);
    check('31. owner on a different database reports a different identity', probe2.reachable === true && (probe2.dbDev !== st.dev || probe2.dbIno !== st.ino), `other dbDev=${probe2.dbDev} dbIno=${probe2.dbIno} vs shared dev=${st.dev} ino=${st.ino}`);
  } finally {
    await stopOwner(o2);
  }
}

// F3: concurrent duplicate requestIds do not crash the owner.
{
  // A fresh payment so the concurrent calls go through the authorize path.
  repo.noteVerified(D('3'), 'k');
  repo.claim(D('3'), 'k');
  const outs = await Promise.all(
    Array.from({ length: 8 }, () =>
      rawAuthorize('f3-dup', D('3')).catch((e) => ({ outcome: 'error', reason: String((e as Error)?.message ?? e) }))),
  );
  const allResolved = outs.every((o) => typeof o['outcome'] === 'string');
  check('32. concurrent duplicate requestIds all resolve (no crash/hang)', allResolved, outs.map((o) => String(o['outcome'])).join(','));
  check('33. exactly one approval after the concurrent duplicates', approvedCount(D('3')) === 1, `approved=${approvedCount(D('3'))}`);
  const alive = await client.authorize(req(D('4'), {}));
  // D('4') is not seeded; the owner must still answer (unknown_payment), not hang.
  check('34. owner still alive after the concurrent duplicates', alive.outcome === 'rejected' && alive.reason === 'unknown_payment', `${alive.outcome}/${alive.reason ?? '-'}`);
}

// F1: default seeding is off at the IPC level (fresh DB, no env var).
await stopOwner(owner);
{
  const f1Dir = join(base, 'f1db');
  mkdirSync(f1Dir, { mode: 0o700 });
  const f1Db = join(f1Dir, 'auth.db');
  const f1Sock = join(f1Dir, 'authz.sock');
  const f1Client = new IpcAuthorizationClient(f1Sock);
  // Default (AUTHZ_SEED_FIXTURES unset): the harness digest must be unknown.
  const o1 = await startOwnerOn(f1Db, f1Sock, f1Dir, { AUTHZ_SEED_FIXTURES: undefined });
  try {
    const r1 = await f1Client.authorize(req(D('a'), {}));
    check('35. default owner (no seed env) does not know the harness digest', r1.outcome === 'rejected' && r1.reason === 'unknown_payment', `${r1.outcome}/${r1.reason ?? '-'}`);
  } finally {
    await stopOwner(o1);
  }
  // Opt-in (AUTHZ_SEED_FIXTURES=1): the same digest is now authorizable.
  const o2 = await startOwnerOn(f1Db, f1Sock, f1Dir, { AUTHZ_SEED_FIXTURES: '1' });
  try {
    const r2 = await f1Client.authorize(req(D('a'), {}));
    check('36. opt-in owner (seed=1) authorizes the harness digest', r2.outcome === 'approved', `${r2.outcome}/${r2.reason ?? '-'}`);
  } finally {
    await stopOwner(o2);
  }
}

// F7: the shared database files are 0600.
{
  const modeOf = (p: string) => statSync(p).mode & 0o777;
  check('37. shared database files are 0600', modeOf(sharedDb) === 0o600 && modeOf(`${sharedDb}-wal`) === 0o600, `db=0o${modeOf(sharedDb).toString(8)} wal=0o${modeOf(`${sharedDb}-wal`).toString(8)}`);
}

repo.close();
const failed = results.filter(([, pass]) => !pass).length;
console.log(`\nverify-authz-owner: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
