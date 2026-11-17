/**
 * F1/F7/F8 — Authorization Owner startup configuration (no IPC needed).
 *
 * AUTHZ_SEED_FIXTURES was REMOVED — the Owner never writes
 * the settlement database, so fixture seeding moved to the test harness.
 * F1: setting AUTHZ_SEED_FIXTURES at all refuses startup (exit 3); a
 *     default start creates the Owner-private database (<dir>/authz.db)
 *     and does not touch the settlement database.
 * F7: the files the owner opens/creates (owner-private authz.db and
 *     idem.db) are tightened to 0600 on open.
 * F8: an unusable AUTHZ_MAX_ENERGY refuses to start with a clean exit-3
 *     message, not an uncaught SyntaxError stack trace.
 *
 * The owner is spawned as a real subprocess (npx tsx). No peer ever connects,
 * so no UID boundary is involved and these tests run as root.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { generateOwnerAuthorizationKeyPair } from '../services/facilitator/src/ownerAuthorization.js';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok } from './helpers.mjs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';

const ownerScript = join(process.cwd(), 'scripts/authz-owner.mts');
const DIGESTS = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(64));

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const ws = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `agenttrust-owncfg-${tag}-`));
  // the Owner needs an authorization-signing key. Ephemeral for this run.
  const keyFile = join(dir, 'owner-key.pem');
  writeFileSync(keyFile, generateOwnerAuthorizationKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  // the settlement database lives in a SEPARATE directory (the
  // launcher refuses it inside the Owner directory) and must exist before
  // startup — the legacy-state gate refuses an unreadable settlement DB.
  // It is presented read-only (0400): this harness runs the Owner as the
  // test UID, so a 0600 file would trip the launcher's writable guard.
  const settlementDir = join(dir, 'settlement');
  mkdirSync(settlementDir);
  const settlementDb = join(settlementDir, 'f.db');
  const seed = new SqliteSettlementRepository(settlementDb, { now: () => Date.now() });
  seed.close();
  chmodSync(settlementDb, 0o400);
  return { dir, db: join(dir, 'authz.db'), settlementDb, sock: join(dir, 'authz.sock'), keyFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const startOwner = (w: ReturnType<typeof ws>, extraEnv: Record<string, string> = {}): { proc: ChildProcess; ready: Promise<boolean> } => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTHZ_AUTHORIZATION_KEY_FILE: w.keyFile,
    AUTHZ_SETTLEMENT_DB_FILE: w.settlementDb,
    // Same-UID harness: this suite spawns the Owner as the test process
    // itself (facilitatorUid 1001), which the launcher now refuses by
    // default. The opt-out is explicit here and never set in production.
    AUTHZ_ALLOW_SAME_UID_HARNESS: '1',
    ...extraEnv,
  };
  const proc = spawn('npx', ['tsx', ownerScript, w.dir, w.sock, '1001'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 30_000);
    proc.stdout?.on('data', (c) => {
      if (c.toString().includes('owner listening')) {
        clearTimeout(t);
        resolve(true);
      }
    });
    proc.on('exit', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  return { proc, ready };
};

const stopOwner = async (proc: ChildProcess): Promise<number | null> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
  proc.kill('SIGTERM');
  return new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(null);
    }, 5_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
};

test('F1. default start creates the Owner-private database and does not touch the settlement database', async () => {
  const w = ws('f1-default');
  const { proc, ready } = startOwner(w);
  try {
    ok(await ready, 'owner started');
    await stopOwner(proc);
    // The Owner-private database was created by the Owner process.
    ok(statSync(w.db).isFile(), 'authz.db exists');
    // The settlement database holds no harness digests — the Owner never seeds it.
    const repo = new SqliteSettlementRepository(w.settlementDb, { now: () => Date.now() });
    try {
      for (const d of DIGESTS) {
        eq(repo.get(d), undefined, `no seeded row for ${d.slice(0, 8)}…`);
      }
    } finally {
      repo.close();
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    w.cleanup();
  }
});

test('F1. AUTHZ_SEED_FIXTURES refuses startup (exit 3)', async () => {
  const w = ws('f1-refuse');
  let stderr = '';
  const proc = spawn('npx', ['tsx', ownerScript, w.dir, w.sock, '1001'], {
    env: {
      ...process.env,
      AUTHZ_AUTHORIZATION_KEY_FILE: w.keyFile,
      AUTHZ_SETTLEMENT_DB_FILE: w.settlementDb,
      AUTHZ_SEED_FIXTURES: '1',
      AUTHZ_ALLOW_SAME_UID_HARNESS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (c) => { stderr += c.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 30_000);
    proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  try {
    eq(code, 3, `exit 3 (got ${code})`);
    ok(/AUTHZ_SEED_FIXTURES was removed/.test(stderr), `clean message, got: ${stderr.slice(0, 200)}`);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    w.cleanup();
  }
});

// Distinct-UID enforcement is ON by default: the Owner refuses to start
// when the facilitator UID equals its own UID. The harness opt-out is
// what the same-UID spawns in this suite use; without it, startup must
// fail closed with exit 3. The spawn below runs as the test process, so
// argv[4] must be the test process's own UID for the refusal to trigger.
test('F1. same-UID Owner refuses startup by default (exit 3)', async () => {
  const w = ws('f1-sameuid');
  let stderr = '';
  const selfUid = String(process.getuid?.() ?? 1001);
  const proc = spawn('npx', ['tsx', ownerScript, w.dir, w.sock, selfUid], {
    env: {
      ...process.env,
      AUTHZ_AUTHORIZATION_KEY_FILE: w.keyFile,
      AUTHZ_SETTLEMENT_DB_FILE: w.settlementDb,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (c) => { stderr += c.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 30_000);
    proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  try {
    eq(code, 3, `exit 3 (got ${code})`);
    ok(/facilitator UID equals the Owner UID/.test(stderr), `clean message, got: ${stderr.slice(0, 200)}`);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    w.cleanup();
  }
});

test('F7. owner database files are 0600 after the owner opens them', async () => {
  const w = ws('f7');
  const { proc, ready } = startOwner(w);
  try {
    ok(await ready, 'owner started');
    await stopOwner(proc);
    for (const f of [w.db, join(w.dir, 'idem.db')]) {
      const mode = statSync(f).mode & 0o777;
      eq(mode, 0o600, `${f.split('/').pop()} is 0600 (got 0o${mode.toString(8)})`);
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    w.cleanup();
  }
});

test('F8. invalid AUTHZ_MAX_ENERGY refuses to start (exit 3, clean message)', async () => {
  for (const bad of ['abc', '', '10.5']) {
    const w = ws(`f8-${bad === '' ? 'empty' : bad.replace('.', '_')}`);
    const proc = spawn('npx', ['tsx', ownerScript, w.dir, w.sock, '1001'], {
      env: { ...process.env, AUTHZ_MAX_ENERGY: bad, AUTHZ_ALLOW_SAME_UID_HARNESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString(); });
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, 30_000);
      proc.on('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    try {
      eq(code, 3, `exit 3 for AUTHZ_MAX_ENERGY='${bad}' (got ${code})`);
      ok(/refusing to start: AUTHZ_MAX_ENERGY must be a positive integer/.test(stderr), `clean message, got: ${stderr.slice(0, 200)}`);
      ok(!/SyntaxError/.test(stderr), 'no uncaught SyntaxError trace');
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      w.cleanup();
    }
  }
});

// ═══ runner ═════════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nauthz-owner-config: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
