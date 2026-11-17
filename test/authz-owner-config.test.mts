/**
 * F1/F7/F8 — Authorization Owner startup configuration (no IPC needed).
 *
 * F1: fixture seeding defaults to OFF. An owner started without
 *     AUTHZ_SEED_FIXTURES must not write the harness digests a..e into its
 *     database; only an explicit AUTHZ_SEED_FIXTURES=1 seeds them.
 * F7: the files the owner opens/creates (shared auth.db, owner-private
 *     idem.db) are tightened to 0600 on open.
 * F8: an unusable AUTHZ_MAX_ENERGY refuses to start with a clean exit-3
 *     message, not an uncaught SyntaxError stack trace.
 *
 * The owner is spawned as a real subprocess (npx tsx). No peer ever connects,
 * so no UID boundary is involved and these tests run as root.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  // Task 11: the Owner needs an authorization-signing key. Ephemeral for this run.
  const keyFile = join(dir, 'owner-key.pem');
  writeFileSync(keyFile, generateOwnerAuthorizationKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { dir, db: join(dir, 'auth.db'), sock: join(dir, 'authz.sock'), keyFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const startOwner = (w: ReturnType<typeof ws>, extraEnv: Record<string, string> = {}): { proc: ChildProcess; ready: Promise<boolean> } => {
  // Unless the test opts in explicitly, the child must NOT inherit a seeding
  // variable from the ambient environment: the default (unset) is what is
  // under test.
  const env: Record<string, string | undefined> = { ...process.env, AUTHZ_AUTHORIZATION_KEY_FILE: w.keyFile, ...extraEnv };
  if (!('AUTHZ_SEED_FIXTURES' in extraEnv)) delete env.AUTHZ_SEED_FIXTURES;
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

test('F1. default (no AUTHZ_SEED_FIXTURES) seeds nothing into the database', async () => {
  const w = ws('f1-default');
  const { proc, ready } = startOwner(w);
  try {
    ok(await ready, 'owner started');
    await stopOwner(proc);
    const repo = new SqliteSettlementRepository(w.db, { now: () => Date.now() });
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

test('F1. explicit AUTHZ_SEED_FIXTURES=1 seeds the harness digests', async () => {
  const w = ws('f1-optin');
  const { proc, ready } = startOwner(w, { AUTHZ_SEED_FIXTURES: '1' });
  try {
    ok(await ready, 'owner started');
    await stopOwner(proc);
    const repo = new SqliteSettlementRepository(w.db, { now: () => Date.now() });
    try {
      for (const d of DIGESTS) {
        const row = repo.get(d);
        ok(row !== undefined, `seeded row exists for ${d.slice(0, 8)}…`);
        eq(row?.state, 'created', 'seeded payment is created');
      }
    } finally {
      repo.close();
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    w.cleanup();
  }
});

test('F7. owner database files are 0600 after the owner opens them', async () => {
  const w = ws('f7');
  const { proc, ready } = startOwner(w, { AUTHZ_SEED_FIXTURES: '1' });
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
      env: { ...process.env, AUTHZ_MAX_ENERGY: bad },
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
