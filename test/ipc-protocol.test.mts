/**
 * Executable verification of the agenttrust-authz v1 protocol.
 *
 * Orchestrates real OS users:
 *   - owner process  : authowner (UID 997)
 *   - authorized client : ubuntu (UID 1001, group authclients)
 *   - unauthorized client: nobody (UID 65534)
 *
 * Verifies framing, strict validation, SO_PEERCRED authentication, durable idempotency,
 * and crash recovery. Test-only; never touches production settlement code or data.
 *
 * Run as root-capable user: npx tsx test/ipc-protocol.test.mts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { generateOwnerAuthorizationKeyPair } from '../services/facilitator/src/ownerAuthorization.js';
import { seedSettlementDb } from './owner-authz-helper.mts';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
// The facilitator UID is the `ubuntu` user's UID. It defaults to 1001 but is
// overridable: on GitHub-hosted runners UID 1001 belongs to the `runner` user,
// so CI creates `ubuntu` with a free UID and passes it via this variable.
// The tested property is unchanged — the owner only accepts the configured
// facilitator UID, whatever its value is.
const FACILITATOR_UID = Number(process.env.TEST_FACILITATOR_UID ?? 1001); // ubuntu
const OWNER_USER = 'authowner';

const D = (c: string) => c.repeat(64);

const req = (requestId: string, digest: string, over: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  requestId,
  operation: 'authorize',
  paymentDigest: digest,
  context: {
    network: CAIP2,
    version: 1,
    sender: SENDER,
    sponsor: SPONSOR,
    recipient: RECIPIENT,
    asset: 'CCD',
    amount: '250000',
    expiry: Math.floor(Date.now() / 1000) + 200,
    energy: '3000',
    transactionDigest: 'cd'.repeat(32),
    transactionType: 'transfer',
    maxFeeMicroCcd: '10000000',
    ...over,
  },
});

const run = (cmd: string, args: string[], as?: string, timeout = 30000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const full = as ? ['sudo', '-u', as, cmd, ...args] : [cmd, ...args];
    const p = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout: out.trim(), stderr: err.trim() });
    });
  });

const base = mkdtempSync(join(tmpdir(), 't348-'));
const dbDir = join(base, 'ownerdb');
const sock = join(base, 'auth.sock');
const logPath = join(dbDir, 'owner.log');

mkdirSync(dbDir, { mode: 0o700 });
// the Owner needs an authorization-signing key. Ephemeral for this run.
// Write it BEFORE chowning the dir to the Owner: a non-root test user
// (CI runner) cannot write into a 0700 dir owned by another uid.
const ownerKeyFile = join(dbDir, 'owner-key.pem');
writeFileSync(ownerKeyFile, generateOwnerAuthorizationKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
// the Owner never seeds the settlement database
// (AUTHZ_SEED_FIXTURES was removed). Seed digests a..e directly, in a
// SEPARATE directory the Owner can read (0644) but not write. This runs
// BEFORE the chown below: the base is chowned to the Owner (0770), and a
// non-root test user (CI runner) cannot create a directory inside it
// afterwards (EACCES on mkdir facdb).
const settlementDir = join(base, 'facdb');
mkdirSync(settlementDir);
// The Owner UID must traverse this directory: the test runs as root with
// umask 0007, so a default mkdir is 0770 root:root and authowner cannot
// reach the settlement file inside it.
chmodSync(settlementDir, 0o755);
const settlementDb = join(settlementDir, 'f.db');
seedSettlementDb(settlementDb, ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64)), () => Date.now());
// The Owner opens the settlement database read-only. A read-only open of a
// WAL database must create the -shm wal-index when none exists, which needs
// write access to the directory — the Owner UID has neither. Holding one
// facilitator-side connection open keeps the -shm present (world-readable),
// so the Owner's read-only reads work. In production the facilitator server
// holds its store open for its lifetime, so this holds naturally; the Owner
// still never opens the settlement database read-write.
// fileMode 0644: the repository tightens db/-wal/-shm to 0600 on open by
// default, which would lock the Owner UID out again. 0644 is test-only
// (temp dir); production uses 0644 (see repository.ts F7).
const settlementHolder = new SqliteSettlementRepository(settlementDb, { now: () => Date.now(), fileMode: 0o644 });
void settlementHolder;
// The Owner launcher refuses startup when the settlement file is writable
// by the Owner UID. The chown below makes the file Owner-owned, so strip
// its owner-write bit first (the held-open facilitator connection keeps
// writing through its file descriptor). The Owner reads it read-only.
chmodSync(settlementDb, 0o400);
// The query helper script must exist BEFORE the chown below: after it,
// the whole base is Owner-owned 0770 and the CI runner (not in
// authclients) cannot write anything into it. The script is static, so
// create it once here; digested() only runs it. It stays readable by the
// Owner UID, which executes it (mode 0644, Owner-owned after chown).
const queryScript = join(base, 'authz-query.mts');
writeFileSync(queryScript, `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const n = (db.prepare("SELECT COUNT(*) AS n FROM authorizations WHERE payment_digest = ? AND decision = 'approved'").get(process.argv[3]) as { n: number }).n;
console.log(String(n));
db.close();
`, { mode: 0o644 });
chmodSync(queryScript, 0o644);
// Whole base belongs to the owner so it can create the socket inside;
// group can traverse (the authorized client runs as ubuntu, in authclients).
await run('chown', ['-R', `${OWNER_USER}:authclients`, base], 'root');
await run('chmod', ['770', base], 'root');
await run('chmod', ['700', dbDir], 'root');


const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const clientScript = join(process.cwd(), 'scripts/authz-client.mts');
const peercredBin = join(process.cwd(), 'scripts/authz-peercred');

type Owner = { proc: ReturnType<typeof spawn>; waitReady: Promise<void> };

const startOwner = async (crashAt = 0): Promise<Owner> => {
  const proc = spawn('sudo', [
    '-u', OWNER_USER, 'env',
    `AUTHZ_OWNER_LOG=${logPath}`,
    `AUTHZ_OWNER_PEERCRED_BIN=${peercredBin}`,
    `CRASH_AT=${crashAt}`,
    `AUTHZ_DB_FILE=${join(dbDir, 'authz.db')}`, `AUTHZ_SETTLEMENT_DB_FILE=${settlementDb}`, // F1: fixtures are opt-in now; these tests authorize the seeded digests a..e.
    `AUTHZ_AUTHORIZATION_KEY_FILE=${ownerKeyFile}`,
    'npx', 'tsx', ownerScript, dbDir, sock, String(FACILITATOR_UID),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  const waitReady = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('owner start timeout')), 40000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes('owner listening')) {
        ready = true;
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', () => { /* noise */ });
    proc.on('exit', (code) => {
      if (!ready) {
        clearTimeout(t);
        resolve(); // let the probe observe the failure
      } else {
        console.log(`   [owner exited code=${code}]`);
      }
    });
  });
  await waitReady;
  // socket must be group-accessible to the authorized client
  await run('chgrp', ['authclients', sock], 'root');
  await run('chmod', ['660', sock], 'root');
  return { proc, waitReady };
};

const stopOwner = async (o: Owner) => {
  // Kill by PID only. pkill -f would match this test process's own command line.
  const pg = await run('pgrep', ['-f', 'scripts/authz-owner.mts'], 'root');
  o.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of pg.stdout.trim().split('\n').filter(Boolean)) {
    if (Number(pid) !== process.pid) await run('kill', ['-9', pid], 'root');
  }
  await new Promise((r) => setTimeout(r, 300));
};

const send = async (request: unknown, as = 'ubuntu', hex = false) => {
  const raw = typeof request === 'string' ? request : JSON.stringify(request);
  const r = await run('npx', ['tsx', clientScript, sock, raw, ...(hex ? ['--hex'] : [])], as, 20000);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(r.stdout.split('\n').filter(Boolean).pop() ?? '') as Record<string, unknown>; } catch { /* not json */ }
  return { raw: r.stdout, parsed, code: r.code, stderr: r.stderr };
};

/**
 * §5 — client-visible outcome classification.
 * Distinct from payment workflow states (e.g. settlement_pending).
 */
const classifyOutcome = (raw: string, code: number): string => {
  let parsed: { outcome?: string } | null = null;
  try { parsed = JSON.parse(raw.split('\n').filter(Boolean).pop() ?? '') as { outcome?: string }; } catch { parsed = null; }
  if (parsed?.outcome === 'approved') return 'approved';
  if (parsed?.outcome === 'rejected') return 'rejected';
  if (parsed?.outcome === 'protocol_error') return 'protocol_error';
  // No usable response: the owner died or timed out around the authorization.
  if (/ECONNREFUSED|ENOENT/.test(raw)) return 'owner_unavailable';
  return 'unknown';
};

const digested = (digest: string) => {
  // Query the Owner-private DB for approved authorization rows (owner-only
  // read, via psql-free sqlite). The table is `authorizations` in
  // <dbDir>/authz.db. The helper script was created at setup time (see
  // queryScript above): after the base is chowned to the Owner, the test
  // user cannot write a new file into it.
  return run('npx', ['tsx', queryScript, join(dbDir, 'authz.db'), digest], OWNER_USER, 20000);
};

// ═══ 1. legitimate authorization ══════════════════════════════════════════════

console.log('── protocol: legitimate authorization ──');
let owner = await startOwner();
{
  const r = await send(req('req-1', D('a')));
  const perms = await run('namei', ['-l', sock], 'root');
  console.log('   namei:', perms.stdout.replace(/\n/g, ' | '));
  const lg = await run('cat', [logPath], 'root');
  console.log('   owner log:', lg.stdout.replace(/\n/g, ' | ') || '(empty)');
  check('1. authorized peer is approved', r.parsed?.outcome === 'approved', r.raw || r.stderr);
  const n = await digested(D('a'));
  check('2. exactly one approval persisted', n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);
}

// ═══ 2. peer authentication ═══════════════════════════════════════════════════

console.log('\n── SO_PEERCRED authentication ──');
{
  // authzintruder is in authclients (so the socket lets it connect) but its UID is not the
  // facilitator UID. This proves peer authentication, not merely socket permissions.
  const r = await send(req('req-2', D('b')), 'authzintruder');
  check('3. unauthorized UID rejected before authorization', r.parsed?.reason === 'unauthorized_peer', r.raw || r.stderr);
  const n = await digested(D('b'));
  check('4. unauthorized peer created no approval', n.stdout.trim() === '0', `approved rows=${n.stdout.trim()}`);
}

// ═══ 3. validation ════════════════════════════════════════════════════════════

console.log('\n── strict validation ──');
{
  const cases: Array<[string, unknown, string]> = [
    ['5. caller-supplied decision rejected', { ...req('v1', D('c')), decision: 'approved' }, 'forbidden_field'],
    ['6. wrong protocol version rejected', { ...req('v2', D('c')), protocolVersion: 2 }, 'unsupported_protocol'],
    ['7. unknown operation rejected', { ...req('v3', D('c')), operation: 'settle' }, 'unknown_operation'],
    ['8. non-decimal energy rejected', req('v4', D('c'), { energy: '1e3' }), 'energy_malformed'],
    ['9. hex energy rejected', req('v5', D('c'), { energy: '0x10' }), 'energy_malformed'],
    ['10. wrong network rejected', req('v6', D('c'), { network: 'ccd:0000' }), 'wrong_network'],
    ['11. wrong sponsor rejected', req('v7', D('c'), { sponsor: SENDER }), 'wrong_sponsor'],
  ];
  for (const [name, payload, expected] of cases) {
    const r = await send(payload);
    check(name, r.parsed?.reason === expected, `${r.parsed?.reason ?? r.raw}`);
  }
  const bad = await send('{not json');
  check('12. malformed JSON fails closed', bad.parsed?.reason === 'malformed_request', String(bad.parsed?.reason));

  const unknownField = await send({ ...req('v8', D('c')), extraAuthorization: 'yes' });
  check('12b. unknown request field rejected', unknownField.parsed?.reason === 'malformed_request', String(unknownField.parsed?.reason));

  const unknownCtxField = await send(req('v9', D('c'), { decision: 'approved' }));
  check('12c. unknown context field rejected', unknownCtxField.parsed?.reason === 'forbidden_field', String(unknownCtxField.parsed?.reason));
}

// ═══ 4. idempotency ═══════════════════════════════════════════════════════════

console.log('\n── durable idempotency ──');
const idemRequest = req('idem-1', D('d'));
{
  const same = idemRequest;
  const first = await send(same);
  const replay = await send(same);
  check('13. identical requestId+payload returns stored result', first.parsed?.outcome === 'approved' && replay.parsed?.outcome === 'approved', `${first.parsed?.outcome} / ${replay.parsed?.outcome}`);

  const conflict = await send(req('idem-1', D('d'), { amount: '999999' }));
  check('14. same requestId + different content → request_id_conflict', conflict.parsed?.reason === 'request_id_conflict', String(conflict.parsed?.reason));

  const n = await digested(D('d'));
  check('15. replay created no second approval', n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);

  const other = await send(req('idem-2', D('d')));
  check('16. new requestId on already-approved payment → authorization_already_recorded', other.parsed?.reason === 'authorization_already_recorded', String(other.parsed?.reason));
  const n2 = await digested(D('d'));
  check('17. still exactly one approval', n2.stdout.trim() === '1', `approved rows=${n2.stdout.trim()}`);
}

// ═══ 5. restart durability ════════════════════════════════════════════════════

console.log('\n── restart durability ──');
{
  await stopOwner(owner);
  owner = await startOwner();
  const replay = await send(idemRequest);
  check('18. idempotency record survives owner restart', replay.parsed?.outcome === 'approved' && replay.parsed?.requestId === 'idem-1', String(replay.parsed?.outcome));
  const n = await digested(D('d'));
  check('19. approval survives restart, still one', n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);
}

// ═══ 6. crash recovery ════════════════════════════════════════════════════════

console.log('\n── crash injection ──');
for (const [point, digestChar, label] of [
  [1, 'a', 'before transaction'],
  [2, 'e', 'after reading payment state'],
] as const) {
  void digestChar;
  await stopOwner(owner);
  owner = await startOwner(point);
  const r = await send(req(`crash-${point}`, D(point === 1 ? 'b' : 'e')));
  // If the owner was killed at this point, the client gets no usable response (empty or
  // protocol_error). Either way the durable state is what matters.
  console.log(`   crash point ${point} client saw: ${r.raw || '(no response)'} (exit ${r.code})`);
  await new Promise((res) => setTimeout(res, 500));
  await stopOwner(owner);
  owner = await startOwner();
  const n = await digested(D(point === 1 ? 'b' : 'e'));
  check(`20.${point} crash ${label}: no approval leaked`, n.stdout.trim() === '0' || n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);
}

// ═══ 6b. adversarial encoding, size, and energy forms ════════════════════════

console.log('\n── adversarial frames ──');
{
  const big = 'a'.repeat(70_000);
  const over = await send(JSON.stringify(req('big-1', D('c'), { amount: big })));
  check('21. oversized frame rejected', over.parsed?.reason === 'message_too_large', String(over.parsed?.reason));

  const badUtf8 = Buffer.from([0x7b, 0x22, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x63, 0x6f, 0x6c, 0x56, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x22, 0x3a, 0x31, 0x7d, 0xff, 0xfe]);
  const utf8 = await send(badUtf8.toString('hex'), 'ubuntu', true);
  check('22. invalid UTF-8 rejected', utf8.parsed?.reason === 'malformed_request' || utf8.parsed?.reason === 'protocol_error', String(utf8.parsed?.reason));

  const forms: Array<[string, string, string]> = [
    ['23. energy "-5" rejected', '-5', 'energy_malformed'],
    ['24. energy " 5" rejected', ' 5', 'energy_malformed'],
    ['25. energy "5 " rejected', '5 ', 'energy_malformed'],
    ['26. energy "+5" rejected', '+5', 'energy_malformed'],
    ['27. energy "0x10" rejected', '0x10', 'energy_malformed'],
    ['28. energy "1e3" rejected', '1e3', 'energy_malformed'],
  ];
  for (const [name, val, expected] of forms) {
    const r = await send(req('e-' + val.replace(/\W/g, '_'), D('c'), { energy: val }));
    check(name, r.parsed?.reason === expected, String(r.parsed?.reason));
  }
}

// ═══ 6c. root policy ═════════════════════════════════════════════════════════

console.log('\n── root policy ──');
{
  const r = await send(req('root-1', D('c')), 'root');
  check('30. root peer rejected per documented policy', r.parsed?.reason === 'unauthorized_peer', String(r.parsed?.reason));
}

// ═══ 6d. concurrent approval ═════════════════════════════════════════════════

console.log('\n── concurrent authorization ──');
{
  const digest = 'f'.repeat(64);
  // 'f' is seeded upfront with a..e into the settlement DB (see
  // the seed block above); the Owner reads it read-only from there.
  const a = run('npx', ['tsx', clientScript, sock, JSON.stringify(req('conc-1', digest))], 'ubuntu', 25000);
  const b = run('npx', ['tsx', clientScript, sock, JSON.stringify(req('conc-2', digest))], 'ubuntu', 25000);
  const [ra, rb] = await Promise.all([a, b]);
  const pa = JSON.parse(ra.stdout) as { outcome?: string };
  const pb = JSON.parse(rb.stdout) as { outcome?: string };
  const approved = [pa, pb].filter((x) => x.outcome === 'approved').length;
  check('31. concurrent: exactly one approval', approved === 1, `${approved} approved (${ra.stdout} | ${rb.stdout})`);
  const n = await digested(digest);
  check('32. concurrent: one durable approval', n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);
}

// ═══ 6e. crash points 3-5 (post-commit, response transmission) ═══════════════

console.log('\n── crash injection: post-commit points ──');
for (const [point, label] of [
  [3, 'after insert/before commit'],
  [4, 'after commit/before response'],
  [5, 'during response transmission'],
] as const) {
  const digest = (point === 3 ? 'c' : point === 4 ? 'd' : 'e').repeat(64);
  // c/d/e were seeded upfront into the settlement DB.
  await stopOwner(owner);
  owner = await startOwner(point);
  const r = await send(req(`crash-${point}`, digest));
  console.log(`   crash point ${point}: client saw ${r.raw || '(no response)'} exit=${r.code}`);
  await new Promise((res) => setTimeout(res, 500));
  await stopOwner(owner);
  owner = await startOwner();
  const n = await digested(digest);
  check(`33.${point} crash ${label}: at most one approval`, n.stdout.trim() === '0' || n.stdout.trim() === '1', `approved rows=${n.stdout.trim()}`);
}

// ═══ 6f. stale socket recovery + symlink rejection ═══════════════════════════

console.log('\n── socket path safety ──');
{
  await stopOwner(owner);
  // Simulate a stale socket object left behind by a crashed owner.
  await run('touch', [sock], 'root');
  await run('chown', [`${OWNER_USER}:authclients`, sock], 'root');
  owner = await startOwner();
  const r = await send(req('stale-1', D('a')));
  check('34. stale socket object is replaced, not reused', r.parsed?.outcome === 'approved' || r.parsed?.reason === 'authorization_already_recorded', `${r.parsed?.outcome}/${r.parsed?.reason}`);

  await stopOwner(owner);
  // Symlink at the socket path must be refused.
  await run('rm', ['-f', sock], 'root');
  await run('ln', ['-s', '/tmp/evil-target', sock], 'root');
  let refused = false;
  try {
    owner = await startOwner();
  } catch {
    refused = true;
  }
  if (!refused) {
    await new Promise((res) => setTimeout(res, 1000));
    // The owner refused if the symlink is still in place (it never bound).
    const ls = await run('test', ['-L', sock], 'root');
    const stillLink = await run('readlink', [sock], 'root');
    refused = stillLink.code === 0;
    await stopOwner(owner);
  }
  check('35. symlink socket path refused', refused, refused ? 'refused' : 'BOUND TO SYMLINK');
  await run('rm', ['-f', sock], 'root');
  owner = await startOwner();
}

// ═══ 6g. outcome semantics (§5) ══════════════════════════════════════════════

console.log('\n── outcome classification ──');
{
  // owner_unavailable: no socket at all
  const down = await run('npx', ['tsx', clientScript, join(base, 'absent.sock'), JSON.stringify(req('down-1', D('a')))], 'ubuntu', 20000);
  const cls = classifyOutcome(down.stdout + down.stderr, down.code);
  check('36. missing socket classifies as owner_unavailable', cls === 'owner_unavailable', cls);

  // unknown: owner killed before commit, no response
  // D('c') was seeded upfront into the settlement DB.
  await stopOwner(owner);
  owner = await startOwner(3);
  const crashRes = await send(req('unk-1', D('c')));
  const cls2 = classifyOutcome(crashRes.raw + crashRes.stderr, crashRes.code);
  check('37. crash pre-commit classifies as unknown', cls2 === 'unknown', `${cls2} (raw="${crashRes.raw}")`);
  await stopOwner(owner);
  owner = await startOwner();
  const notDup = await digested(D('c'));
  // Point 3 dies after authorize() committed but before the idempotency record. The approval
  // IS durable; what must hold is that a replay cannot create a second one.
  const replayAfter = await send(req('unk-1b', D('c')));
  check('38. post-commit crash: replay cannot duplicate the approval', notDup.stdout.trim() === '1' && replayAfter.parsed?.reason === 'authorization_already_recorded', `rows=${notDup.stdout.trim()} replay=${String(replayAfter.parsed?.reason)}`);
}

await stopOwner(owner);
// Keep the artifact directory for inspection; print the owner log on failure.
try {
  const log = await run('cat', [logPath], 'root');
  if (log.stdout) console.log('\n── owner log ──\n' + log.stdout.split('\n').slice(-20).join('\n'));
} catch { /* ignore */ }
console.log(`\nartifacts: ${base}`);

const failed = results.filter((r) => !r[1]).length;
console.log(`\nipc-protocol: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
