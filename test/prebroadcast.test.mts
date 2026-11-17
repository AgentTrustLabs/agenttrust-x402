/**
 * Pre-broadcast durable transaction hash persistence.
 *
 * Ten crash boundaries, exercised with real OS processes sharing one SQLite file.
 * Submission attempts are counted at the signer boundary (append-only ledger), not from
 * HTTP responses.
 *
 * Run: npx tsx test/prebroadcast.test.mts
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { paymentDigest, requirementsKey } from '../services/facilitator/src/store.js';
import { toSdkV1Transaction, computeTransactionHash } from '../services/facilitator/src/signer.js';
import { canTransition, isTerminal } from '../services/facilitator/src/state.js';
import { LocalAuthorizationClient } from '../services/facilitator/src/authorization.js';
import { convertV2ToSdkV1 } from '../services/facilitator/src/wireConverter.js';
import { signingDigestOf, transactionEnergyOf } from '../services/facilitator/src/signingService.js';
import { SIMPLE_TRANSFER_BASE_COST } from '../services/facilitator/src/energy.js';
import { generateOwnerAuthorizationKeyPair } from '../services/facilitator/src/ownerAuthorization.js';
import { ReadOnlySettlementStateReader, RepositorySettlementStateReader, SqliteOwnerAuthorizationRepository } from '../services/facilitator/src/ownerAuthorizationRepository.js';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a: unknown, b: unknown, m: string) => check(m, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const ok = (v: unknown, m: string) => check(m, Boolean(v));

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
// W5's sponsor: the real sponsor testnet account (public address only —
// no key, no signing, no broadcast; mock mode only simulates). It must be
// a VALID Concordium account (the Owner launcher validates it with
// AccountAddress.fromBase58) and DISTINCT from both sender and recipient
// (the wire converter refuses sponsor == recipient, and the Owner refuses
// sponsor == sender). PAY_TO cannot serve: it is the transfer recipient.
const W5_SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
// The fixture's sponsor must match the mock signer's policy sponsor, or the wire
// converter refuses with `wrong_sponsor` before the signer is ever reached.
const SPONSOR = '3mockSponsorPlaceholderNotARealAccountAddress0000';
const SERVER = new URL('../services/facilitator/dist/server.js', import.meta.url).pathname;

const NOW = Math.floor(Date.now() / 1000);

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t29-'));
  return { dir, db: join(dir, 'f.db'), ledger: join(dir, 'sub.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixture(over: Record<string, unknown> = {}) {
  const reqs = {
    scheme: 'exact', network: CAIP2, asset: 'CCD', amount: '250000', payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { feePayer: '3mockSponsorPlaceholderNotARealAccountAddress0000' },
    ...(over.requirements as object ?? {}),
  };
  return {
    x402Version: 2,
    resource: { url: (over.resourceUrl as string) ?? 'agenttrust://resource/1004' },
    accepted: reqs,
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: SENDER, nonce: 7, expiry: NOW + 200, numSignatures: 1,
          sponsor: { address: SPONSOR, numSignatures: 0 },
        },
        payload: { type: 'transfer', toAddress: PAY_TO, amount: (over.amount as string) ?? '250000' },
        signatures: { sender: { 0: { 0: 'aa'.repeat(32) + '00'.repeat(32) } }, sponsor: {} },
      },
    },
  };
}
const envelope = (p: any) => ({ x402Version: 2, paymentPayload: p, paymentRequirements: p.accepted });

function readLedger(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { event: 'bad' }; } });
}
const attempts = (path: string) => readLedger(path).filter(e => e.event === 'submit_attempt').length;

async function startProc(env: Record<string, string>, asUser?: string) {
  // asUser: run the facilitator as another OS user (W5's recovery process
  // runs as ubuntu so the Owner's SO_PEERCRED gate sees a non-root peer —
  // the Owner refuses uid 0 outright). sudo strips the environment, so the
  // full env is passed explicitly via `env`, the same shape the isolation
  // suite uses for its Owner.
  const fullEnv = { ...process.env, ...env };
  const child = asUser
    ? spawn('sudo', ['-u', asUser, 'env', ...Object.entries(fullEnv).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v as string}`), process.execPath, SERVER], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    : spawn(process.execPath, [SERVER], { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => (out += String(d)));
  child.stderr.on('data', d => (err += String(d)));
  const exited = new Promise(r => child.on('exit', (c, s) => r({ c, s })));
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`start failed: ${err.slice(0, 200)}`)), 15000);
    const poll = () => {
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
      else if (child.exitCode !== null) { clearTimeout(t); reject(new Error(`exited: ${err.slice(0, 200)}`)); }
      else setTimeout(poll, 25);
    };
    poll();
  });
  return { url, child, exited, stop: async () => {
    if (child.exitCode === null) {
      // A sudo-spawned child must be killed as a GROUP: killing sudo alone
      // orphans the node server behind it.
      if (asUser && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      else child.kill('SIGKILL');
    }
    await exited;
  } };
}

async function settle(url: string, body: unknown) {
  const r = await fetch(`${url}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}

const baseEnv = (w: ReturnType<typeof ws>) => ({
  FACILITATOR_MODE: 'mock',
  FACILITATOR_HOST: '127.0.0.1',
  FACILITATOR_PORT: '0',
  FACILITATOR_DB_PATH: w.db,
  FACILITATOR_SUBMIT_LEDGER: w.ledger,
});

const repoAt = (db: string) => new SqliteSettlementRepository(db);

// ── W5 Owner harness  ────────────────────────────────────────────
// The recovery process recovers the durable approval through a REAL Owner
// over IPC. The Owner runs as authowner (not the test UID): its launcher's
// settlement-writable guard is active for a non-root Owner, so the
// settlement file must be readable but not writable by that UID (see the
// handover below). The facilitator UID comes from the same
// TEST_FACILITATOR_UID convention as the IPC suites (default 1001 = ubuntu).
const OWNER_SCRIPT = new URL('../scripts/authz-owner.mts', import.meta.url).pathname;
const PEERCRED_BIN = new URL('../scripts/authz-peercred', import.meta.url).pathname;
const FAC_UID = Number(process.env.TEST_FACILITATOR_UID ?? 1001);
const OWNER_USER = 'authowner';

// sudo helper for ownership changes the test UID cannot do itself
// (chown to another UID needs root; CI runners and local root both have it).
const sudo = (...args: string[]) => {
  const r = spawnSync('sudo', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sudo ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
};

type OwnerProc = { proc: ReturnType<typeof spawn> };
async function startW5Owner(ownerDir: string, sock: string, env: Record<string, string>): Promise<OwnerProc> {
  // No signing-service UID is passed (argv[5] omitted): W5 has no signing
  // service — the seed authorized in-process and the recovery uses
  // `recover`, never `consume` — so consume is refused outright. Passing
  // the facilitator UID as the signing-service UID would also trip the
  // launcher's default refusal (signing-service UID must differ from the
  // facilitator UID), and inventing a third UID for a service that does
  // not exist would be a lie in the harness.
  const proc = spawn('sudo', ['-u', OWNER_USER, 'env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'npx', 'tsx', OWNER_SCRIPT, ownerDir, sock, String(FAC_UID)], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let ready = false;
  let stderr = '';
  let stdout = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  proc.stdout.on('data', (c) => { stdout += c.toString(); });
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), 40000);
    proc.stdout.on('data', (c) => { if (c.toString().includes('owner listening')) { ready = true; clearTimeout(t); resolve(); } });
    proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
  if (!ready) {
    writeFileSync('/tmp/w5-owner-stderr.log', stderr);
    writeFileSync('/tmp/w5-owner-stdout.log', stdout);
    try {
      const ownerLog = join(ownerDir, 'owner.log');
      if (existsSync(ownerLog)) writeFileSync('/tmp/w5-owner-log-copy.log', readFileSync(ownerLog, 'utf8'));
    } catch { /* owner.log may not exist yet */ }
    throw new Error(`W5 owner failed to start: ${stderr.trim().split('\n').slice(-25).join(' | ')}`);
  }
  // The socket is created authowner-owned; the facilitator (ubuntu) connects
  // through it — the SO_PEERCRED gate, not the file mode, is the boundary.
  // The chmod must go through sudo: the test user is not the socket's
  // owner (the Owner created it), so a direct chmod is EPERM. This was
  // the real W5 failure in the previous run; the cleanup EACCES it
  // reported was the secondary error from the finally masking it.
  sudo('chmod', '666', sock);
  return { proc };
}
async function stopW5Owner(o: OwnerProc) {
  // Kill the whole process GROUP (detached spawn above): SIGTERM to the
  // npx process alone never reaches the node child through the npx → sh →
  // node chain, which is why earlier runs leaked Owner processes.
  const pid = o.proc.pid;
  if (pid !== undefined) { try { process.kill(-pid, 'SIGTERM'); } catch { o.proc.kill('SIGTERM'); } } else o.proc.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    if (o.proc.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), 10000);
    o.proc.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) {
    if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch { o.proc.kill('SIGKILL'); } } else o.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ═══ 1. hash binding ════════════════════════════════════════════════════

console.log('\n── A. the persisted hash is the real SDK hash of the signed transaction ──');
{
  const p = fixture();
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const h = computeTransactionHash(signed);
  ok(/^[0-9a-f]{64}$/.test(h), `64-hex identifier: ${h}`);
  eq(computeTransactionHash(signed) === h, true, 'stable across recomputation');

  const changedAmount = computeTransactionHash({ ...signed, payload: { ...signed.payload, amount: '999999' } });
  check('changed amount → different identifier', changedAmount !== h);
  const changedNonce = computeTransactionHash({ ...signed, header: { ...signed.header, nonce: 8 } });
  check('changed nonce → different identifier', changedNonce !== h);
  const changedRecipient = computeTransactionHash({ ...signed, payload: { ...signed.payload, toAddress: SENDER } });
  check('changed recipient → different identifier', changedRecipient !== h);
  const changedSponsorSig = computeTransactionHash({ ...signed, signatures: { ...signed.signatures, sponsor: { 0: { 0: 'cc'.repeat(64) } } } });
  check('changed sponsor signature → different identifier', changedSponsorSig !== h);
  const changedSender = computeTransactionHash({ ...signed, header: { ...signed.header, sender: PAY_TO } });
  check('changed sender → different identifier', changedSender !== h);
}

// ═══ 2. durable ordering (in-process, deterministic) ═════════════════════

console.log('\n── B. the database cannot reach a broadcast-eligible state without a hash ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  const d = 'd'.repeat(64);
  try {
    repo.noteVerified(d, 'k');
    const c = repo.claim(d, 'k');
    eq(c.claim, 'fresh', 'claimed');
    eq(repo.get(d)!.state, 'created', 'still created — no hash yet');
    eq(repo.get(d)!.tx_hash, null, 'no hash recorded');

    // Submitting without prepare() must be refused.
    const noHash = (repo as any).claimSubmit(d, 'deadbeef');
    eq(noHash.ok, false, 'claimSubmit without a durable hash is refused');

    repo.prepare(d, 'tx-1');
    eq(repo.get(d)!.state, 'prepared', 'prepared after prepare()');
    eq(repo.get(d)!.tx_hash, 'tx-1', 'hash durable');

    // A different hash cannot take the claim.
    const wrong = repo.claimSubmit(d, 'tx-other');
    eq(wrong.ok, false, 'claimSubmit with a mismatched hash is refused');
    eq(repo.get(d)!.state, 'prepared', 'still prepared after the refusal');

    const good = repo.claimSubmit(d, 'tx-1');
    eq(good.ok, true, 'claimSubmit with the persisted hash succeeds');
    eq(repo.get(d)!.state, 'submitting', 'submitting');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── C. a hash survives a real restart ──');
{
  const w = ws();
  const d = 'e'.repeat(64);
  const a = repoAt(w.db);
  a.noteVerified(d, 'k');
  a.claim(d, 'k');
  a.prepare(d, 'tx-durable');
  a.close();

  const b = repoAt(w.db);
  try {
    eq(b.get(d)!.tx_hash, 'tx-durable', 'hash survived the restart');
    eq(b.get(d)!.state, 'prepared', 'state survived the restart');
  } finally {
    b.close();
    w.cleanup();
  }
}

console.log('\n── D. a recorded hash cannot be substituted ──');
{
  const w = ws();
  const d = 'f'.repeat(64);
  const repo = repoAt(w.db);
  try {
    repo.noteVerified(d, 'k');
    repo.claim(d, 'k');
    repo.prepare(d, 'tx-a');
    let threw = false;
    try { repo.prepare(d, 'tx-b'); } catch { threw = true; }
    eq(threw, true, 'prepare with a different hash throws');
    eq(repo.get(d)!.tx_hash, 'tx-a', 'original hash intact');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── E. state machine integrity ──');
{
  eq(canTransition('created', 'prepared'), true, 'created → prepared');
  eq(canTransition('prepared', 'submitting'), true, 'prepared → submitting');
  eq(canTransition('submitting', 'outcome_unknown'), true, 'submitting → outcome_unknown');
  eq(canTransition('outcome_unknown', 'finalized'), true, 'outcome_unknown → finalized');
  eq(canTransition('outcome_unknown', 'rejected'), true, 'outcome_unknown → rejected');
  eq(canTransition('observed', 'finalized'), true, 'observed → finalized');
  eq(canTransition('prepared', 'finalized'), false, 'prepared cannot skip to finalized');
  eq(canTransition('rejected', 'finalized'), false, 'rejection is terminal');
  eq(canTransition('finalized', 'rejected'), false, 'finalized is terminal');
  eq(isTerminal('finalized') && isTerminal('rejected'), true, 'both terminal');
  eq(isTerminal('outcome_unknown'), false, 'outcome_unknown is not terminal');
}

// ═══ 3. crash windows over real processes ═══════════════════════════════

console.log('\n── W1. crash before transaction preparation ──');
{
  const w = ws();
  const doomed = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'doomed' });
  await doomed.stop(); // killed before handling anything
  const survivor = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'survivor' });
  try {
    const p = fixture();
    const r = await settle(survivor.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 100));
    eq(r.body.success, true, 'the payment is still settleable');
    eq(attempts(w.ledger), 1, 'exactly one submission');
  } finally {
    await survivor.stop();
    w.cleanup();
  }
}

console.log('\n── W2/W3/W4. crash before the hash is durably committed ──');
{
  // Model: the process dies while the transaction is being prepared. Nothing is broadcast,
  // so no hash exists — and crucially the payment must not be broadcast-eligible.
  const w = ws();
  const repo = repoAt(w.db);
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    // Crash here: before prepare().
    const row = repo.get(d)!;
    eq(row.state, 'created', 'state is created — never broadcast-eligible');
    eq(row.tx_hash, null, 'no hash persisted');
    const attempt = repo.claimSubmit(d, 'anything');
    eq(attempt.ok, false, 'submission cannot start without a persisted hash');
  } finally {
    repo.close();
    w.cleanup();
  }
}

console.log('\n── W5. crash immediately after durable hash persistence, before submission ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  const p = fixture();
  // W5 sponsors with W5_SPONSOR, not the mock placeholder. The
  // real Owner validates EVERY request's sponsor against its policy
  // sponsor (validateRequest: wrong_sponsor) and the launcher refuses a
  // policy sponsor that is not a valid Concordium account — the placeholder
  // is not one (it contains '0', outside the base58 alphabet). So the
  // seed, the envelope, and the recovery facilitator's mock signer must all
  // present the same valid sponsor (W5_SPONSOR); the recovery process gets
  // it via FACILITATOR_MOCK_SPONSOR_ADDRESS below.
  const p5 = JSON.parse(JSON.stringify(p)) as typeof p;
  p5.payload.signedTransaction.header.sponsor.address = W5_SPONSOR;
  // The core sources the authorization request's sponsor from
  // requirements.extra.feePayer (not from the transaction header), so the
  // feePayer must agree with the sponsor everywhere else, or the Owner
  // rejects the recovery with wrong_sponsor. Both overrides land before
  // the digest is computed, so the digest binds the W5 variant.
  p5.accepted.extra.feePayer = W5_SPONSOR;
  const d = paymentDigest(p5);
  const k = requirementsKey(p5.accepted, p5.resource.url);
  let txHash = '';
  // the seeded approval lives in an Owner-private database,
  // and the recovery process recovers it through a REAL Owner process over
  // IPC (the facilitator's in-memory default client could never see a
  // durable approval). The Owner directory holds the private database and
  // the authorization key; the socket lives in its own world-traversable
  // directory so the facilitator UID can reach it.
  const ownerDir = join(w.dir, 'owner');
  mkdirSync(ownerDir, { mode: 0o700 });
  const ownerDb = join(ownerDir, 'authz.db');
  const ownerKey = generateOwnerAuthorizationKeyPair();
  const ownerKeyFile = join(ownerDir, 'owner-key.pem');
  writeFileSync(ownerKeyFile, ownerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const sockDir = join(w.dir, 'sock');
  mkdirSync(sockDir, { mode: 0o755 });
  // The suite runs under umask 0007, so the mkdir above actually yields
  // 0750 — the facilitator UID could not traverse to the socket (EACCES on
  // connect). Set the mode explicitly, like the IPC suites do. The
  // directory is owned by the Owner UID so it can create the socket inside.
  // The chmod must go through sudo: after the chown above, the test user
  // no longer owns the directory and a direct chmod is EPERM.
  sudo('chown', OWNER_USER, sockDir);
  sudo('chmod', '755', sockDir);
  const sock = join(sockDir, 'authz.sock');
  let ownerProc: OwnerProc | null = null;
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    // a persisted hash implies a prior approval: the first attempt
    // authorized the exact transaction before signing it. Seed that approval
    // (unconsumed — the mock signer never consumes) so the recovery process
    // can recover its certificate; without it the resume fails closed. The
    // approval binds the exact converted transaction the server will
    // authorize for, under the server's default authorization policy.
    {
      const raw = p5.payload.signedTransaction;
      const withPolicyEnergy = {
        ...raw,
        header: { ...raw.header, executionEnergyAmount: Number(SIMPLE_TRANSFER_BASE_COST) },
      };
      const conversion = convertV2ToSdkV1(withPolicyEnergy, {
        network: CAIP2,
        sponsorAddress: W5_SPONSOR,
        maxExecutionEnergy: 1_000,
      });
      if (!conversion.ok) throw new Error(`W5 seed conversion failed: ${conversion.message}`);
      const wire = conversion.wire;
      const energy = transactionEnergyOf(wire);
      if (energy === null) throw new Error('W5 seed: no recomputed energy');
      // the approval lives in the Owner-private database, not
      // the settlement database: the settlement repository no longer has
      // (or creates) the authorization tables.
      const ownerRepo = new SqliteOwnerAuthorizationRepository(ownerDb, new RepositorySettlementStateReader(repo), { now: () => Date.now() });
      try {
        const owner = new LocalAuthorizationClient({
          policy: {
            network: CAIP2,
            sponsor: W5_SPONSOR,
            maxEnergy: 1_000n,
            maxExpiryOffsetSeconds: 600,
            allowedAssets: ['CCD'],
            policyVersion: 'local-v1',
          },
          repository: ownerRepo,
          now: () => Date.now(),
        });
        const auth = await owner.authorize({
          paymentDigest: d,
          network: CAIP2,
          version: 1,
          sender: SENDER,
          sponsor: W5_SPONSOR,
          recipient: PAY_TO,
          asset: 'CCD',
          amount: '250000',
          expiry: NOW + 200,
          energy,
          transactionDigest: signingDigestOf(wire),
          transactionType: 'transfer',
          maxFeeMicroCcd: '10000000',
        });
        if (auth.outcome !== 'approved') throw new Error(`W5 seed authorization failed: ${auth.outcome}/${auth.reason}`);
      } finally {
        ownerRepo.close();
      }
    }
    const signed = { ...p5.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
    txHash = computeTransactionHash(signed);
    repo.prepare(d, txHash);
    // Crash now: hash is durable, nothing was submitted.
  } finally {
    repo.close();
  }

  // The Owner directory must be owned by the Owner UID (0700). This runs
  // AFTER the seed above: the seed creates authz.db as the test UID, and
  // the Owner cannot open a root-owned 0600 database. The key was written
  // before the seed, so nothing here needs the test UID to write into the
  // directory afterwards.
  sudo('chown', '-R', OWNER_USER, ownerDir);
  sudo('chmod', '700', ownerDir);

  // Cross-UID handover for the recovery: the recovery facilitator runs as
  // ubuntu (its store is the settlement database), so the workspace must be
  // traversable and the database + submit ledger writable by that UID
  // before it starts. The facilitator opens the database FIRST — it creates
  // the WAL -shm as ubuntu-owned; the Owner (authowner) then reads it fine.
  // Starting the Owner first would create an Owner-owned -shm the
  // facilitator could not use.
  chmodSync(w.dir, 0o777);
  writeFileSync(w.ledger, '');
  // The settlement database must be writable by the facilitator (ubuntu)
  // and readable — but not writable — by the Owner (authowner): the Owner
  // launcher refuses a settlement file writable by its UID. Owner-owned
  // 0644 does all three (ubuntu writes as owner; authowner and the test
  // read through the world-read bit). The recovery facilitator runs its
  // store with the same fileMode so the WAL -shm it creates is readable
  // by the Owner too.
  sudo('chown', 'ubuntu', w.db);
  sudo('chmod', '644', w.db);
  chmodSync(w.ledger, 0o666);

  // Recovery process: the hash is there, the payment is prepared, and a settle must NOT
  // submit again — it reports pending with the durable identifier.
  // the mock signer must present the same valid sponsor the
  // Owner's policy holds (W5_SPONSOR): without FACILITATOR_MOCK_SPONSOR_ADDRESS
  // it would sponsor with the placeholder and the Owner would reject the
  // recovery with wrong_sponsor.
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'recovery', FACILITATOR_AUTHZ_SOCKET: sock, FACILITATOR_MOCK_SPONSOR_ADDRESS: W5_SPONSOR, FACILITATOR_DB_FILE_MODE: '0644' }, 'ubuntu');
  try {
    // the recovery process recovers the durable approval
    // through the real Owner. The Owner's policy sponsor is W5_SPONSOR (a
    // valid Concordium account); the seed approval binds the same sponsor,
    // and only policyVersion must match the seed ('local-v1').
    ownerProc = await startW5Owner(ownerDir, sock, {
      AUTHZ_OWNER_LOG: join(ownerDir, 'owner.log'),
      AUTHZ_OWNER_PEERCRED_BIN: PEERCRED_BIN,
      AUTHZ_SPONSOR_ADDRESS: W5_SPONSOR,
      AUTHZ_NETWORK: CAIP2,
      AUTHZ_POLICY_VERSION: 'local-v1',
      AUTHZ_DB_FILE: ownerDb,
      AUTHZ_SETTLEMENT_DB_FILE: w.db,
      AUTHZ_AUTHORIZATION_KEY_FILE: ownerKeyFile,
    });
    const r = await settle(proc.url, envelope(p5));
    await new Promise(r2 => setTimeout(r2, 120));
    // Pre-broadcast persistence makes a prepared row resumable: a recovery process MAY take the claim and
    // submit. The invariant is at-most-one, not zero.
    eq(attempts(w.ledger), 1, 'exactly one submission total (by the recovery process)');
    eq(r.body.transaction, txHash, 'the durable hash is reported back');

    // The settlement file is ubuntu-owned now; the test reads it through
    // the read-only reader (a read-write open would fail for a non-owner).
    const again = new ReadOnlySettlementStateReader(w.db);
    const st = again.getPaymentState(d);
    eq(st?.txHash, txHash, 'hash still durable');
    ok(['outcome_unknown', 'prepared', 'submitting'].includes(st?.state ?? ''), `state advanced: ${st?.state}`);
  } finally {
    await proc.stop();
    if (ownerProc) await stopW5Owner(ownerProc);
    // The Owner directory is Owner-owned 0700 (chowned after the seed so
    // the Owner can open its own database) and the socket directory is
    // Owner-owned 0755. A non-root test user cannot scandir the first or
    // unlink the socket inside the second, so rmSync in cleanup throws
    // EACCES. Hand the whole temp dir back to the test UID first. Both
    // processes are stopped by now, so nothing writes into it anymore.
    sudo('chown', '-R', String(process.getuid()), w.dir);
    w.cleanup();
  }
}

console.log('\n── W6/W7. crash immediately before / after submission ──');
{
  const w = ws();
  const p = fixture();
  const proc = await startProc({ ...baseEnv(w), FACILITATOR_BEHAVIOUR: 'submit-then-die', FACILITATOR_PROCESS_LABEL: 'dies' });
  await settle(proc.url, envelope(p)).catch(() => null);
  await proc.exited;
  await new Promise(r2 => setTimeout(r2, 150));

  const events = readLedger(w.ledger).map(e => e.event);
  eq(attempts(w.ledger), 1, 'exactly one submission attempt before the crash');
  ok(events.includes('crash_after_submit'), 'the crash happened after submission');

  const repo = repoAt(w.db);
  const d = paymentDigest(p);
  try {
    const row = repo.get(d)!;
    // The hash was persisted BEFORE the broadcast, so the crash did not lose it.
    ok(/^[0-9a-f]{64}$/.test(row.tx_hash ?? ''), `durable hash survived the crash: ${row.tx_hash}`);
    // Outcome is explicitly ambiguous, never success.
    ok(['outcome_unknown', 'submitting'].includes(row.state), `ambiguous state: ${row.state}`);
  } finally {
    repo.close();
  }

  // A healthy process must not resubmit.
  const healthy = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'healthy' });
  try {
    const r = await settle(healthy.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 150));
    eq(r.body.success, false, 'not converted to success');
    eq(attempts(w.ledger), 1, 'no second submission after the crash');
  } finally {
    await healthy.stop();
    w.cleanup();
  }
}

console.log('\n── W8. crash after the submission response, before the final state transition ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  // Seed exactly that state: hash durable, broadcast recorded, no evidence applied yet.
  const repo = repoAt(w.db);
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const txHash = computeTransactionHash(signed);
  try {
    repo.noteVerified(d, k);
    repo.claim(d, k);
    repo.prepare(d, txHash);
    repo.claimSubmit(d, txHash);
    repo.markBroadcast(d, txHash);
  } finally {
    repo.close();
  }

  const proc = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'after-response' });
  try {
    const r = await settle(proc.url, envelope(p));
    await new Promise(r2 => setTimeout(r2, 120));
    eq(r.body.success, false, 'not finalized without evidence');
    eq(r.body.errorReason, 'settlement_pending', 'explicitly pending');
    eq(r.body.transaction, txHash, 'durable hash reported');
    eq(attempts(w.ledger), 0, 'no resubmission');
  } finally {
    await proc.stop();
    w.cleanup();
  }
}

console.log('\n── W9/W10. recovery from another process, and two recovering concurrently ──');
{
  const w = ws();
  const p = fixture();
  const d = paymentDigest(p);
  const k = requirementsKey(p.accepted, p.resource.url);
  const signed = { ...p.payload.signedTransaction, signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: { 0: { 0: 'bb'.repeat(64) } } } };
  const txHash = computeTransactionHash(signed);
  const seed = repoAt(w.db);
  try {
    seed.noteVerified(d, k);
    seed.claim(d, k);
    seed.prepare(d, txHash);
    seed.claimSubmit(d, txHash);
    seed.markBroadcast(d, txHash);
  } finally {
    seed.close();
  }

  const a = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-a' });
  const b = await startProc({ ...baseEnv(w), FACILITATOR_PROCESS_LABEL: 'rec-b' });
  try {
    const [ra, rb] = await Promise.all([settle(a.url, envelope(p)), settle(b.url, envelope(p))]);
    await new Promise(r2 => setTimeout(r2, 150));

    eq(attempts(w.ledger), 0, 'concurrent recovery produced no submission');
    for (const r of [ra, rb]) {
      eq(r.body.success, false, 'neither recovery reports success');
      eq(r.body.errorReason, 'settlement_pending', 'both report pending');
      eq(r.body.transaction, txHash, 'both report the same durable hash');
    }

    const after = repoAt(w.db);
    try {
      eq(after.get(d)!.state, 'outcome_unknown', 'state unchanged by concurrent recovery');
      eq(after.get(d)!.tx_hash, txHash, 'hash unchanged');
    } finally {
      after.close();
    }
  } finally {
    await a.stop();
    await b.stop();
    w.cleanup();
  }
}

console.log('\n── W11. two processes cannot both claim the broadcast ──');
{
  const w = ws();
  const d = '1'.repeat(64);
  const a = repoAt(w.db);
  a.noteVerified(d, 'k');
  a.claim(d, 'k');
  a.prepare(d, 'tx-x');
  const r1 = a.claimSubmit(d, 'tx-x');
  const r2 = a.claimSubmit(d, 'tx-x');
  eq(r1.ok, true, 'first claim wins');
  eq(r2.ok, false, 'second claim refused');
  a.close();
  w.cleanup();
}

// ═══ 4. durability configuration ════════════════════════════════════════

console.log('\n── durability configuration ──');
{
  const w = ws();
  const repo = repoAt(w.db);
  try {
    const jm = repo['db'].prepare('PRAGMA journal_mode').get() as any;
    const sy = repo['db'].prepare('PRAGMA synchronous').get() as any;
    const bt = repo['db'].prepare('PRAGMA busy_timeout').get() as any;
    eq(String(jm.journal_mode).toLowerCase(), 'wal', 'journal_mode = WAL');
    // synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
    eq(Number(sy.synchronous), 2, 'synchronous = FULL (2)');
    ok(Number(bt.timeout) >= 1000, `busy_timeout = ${bt.timeout}ms`);
  } finally {
    repo.close();
    w.cleanup();
  }
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\nprebroadcast: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
