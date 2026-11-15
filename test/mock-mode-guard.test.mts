/**
 * Mock production guard — regression tests.
 *
 * Covers `AGENTTRUST_X402_ALLOW_MOCK`, `NODE_ENV`, and the bind host
 * (src/x402/mockModeGuard.ts) and the launcher check
 * (scripts/x402-resource-server.mts): mock facilitator mode requires
 * ALL of these, so it can only ever run as a loopback-only test
 * harness and never in production or on the network:
 *
 *   1. `resolveMockAllowed`: only an explicit `1` or `true`
 *      (case-insensitive, whitespace ignored) allows mock mode.
 *      Everything else — unset, empty, `0`, `false`, `yes`, garbage —
 *      is false. There is no implicit opt-in.
 *   2. `isLoopbackHost`: only `127.0.0.1`, `::1`, `localhost`
 *      (case-insensitive for the hostname, whitespace ignored) count
 *      as loopback. `0.0.0.0`, a LAN/public IP, a hostname, an empty
 *      string, undefined, a shorthand like `127.1`, a bracketed
 *      `[::1]`, or a trailing-dot `localhost.` are all rejected.
 *   3. `assertMockModeAllowed`: real mode always passes (it never
 *      needs the opt-in, the host check, or the environment check);
 *      mock mode passes only with the opt-in AND a non-production
 *      `NODE_ENV` AND a loopback host, and throws a clear error naming
 *      the exact variable that caused the rejection otherwise.
 *   4. Launcher (subprocess): `FACILITATOR_MODE=mock` WITHOUT the
 *      opt-in refuses to start (exit 1, stderr names
 *      `AGENTTRUST_X402_ALLOW_MOCK`), before any network I/O.
 *   5. Launcher: `FACILITATOR_MODE=mock` WITH `ALLOW_MOCK=1` on
 *      loopback in a non-production environment starts and serves the
 *      402 challenge + Discovery (the mock mode itself is unchanged —
 *      the guard only gates entry to it).
 *   6. Launcher: `ALLOW_MOCK=0` does not allow mock mode (exit 1).
 *   7. Launcher: `NODE_ENV=production` refuses mock mode (exit 1),
 *      even with the opt-in.
 *   8. Launcher: a non-loopback host (`0.0.0.0`, a LAN IP) refuses
 *      mock mode (exit 1), even with the opt-in.
 *   9. Launcher: an empty or whitespace-only host is normalized to
 *      the loopback default (`127.0.0.1`) before the guard runs, so
 *      mock mode starts and binds loopback (M1: an empty host must
 *      fail-safe to loopback, never bind `::`). The guard itself is
 *      unchanged — it still rejects an empty host when called
 *      directly, and still rejects non-loopback hosts at the
 *      launcher level (8).
 *  10. Launcher: real mode (the default, no mode set) is unaffected
 *      by the guard — it still fails closed with exit 2 on a dead
 *      facilitator, with or without the opt-in set.
 *
 * Mandatory cases from the brief, mapped:
 *   mock + opt-in + loopback + non-production → allowed (3, 5)
 *   mock without opt-in → rejected (3, 4)
 *   mock with NODE_ENV=production → rejected (3, 7)
 *   mock with 0.0.0.0 / non-loopback → rejected (2, 3, 8)
 *   mock with empty/invalid host → rejected at the guard library
 *   level (2, 3); at the launcher level an empty/whitespace host is
 *   normalized to the loopback default first, so mock mode starts
 *   and binds loopback (9) — the guard still sees the effective
 *   (loopback) host, and non-loopback hosts are still rejected (8)
 *   real mode unaffected (3, 10)
 *   rejection before network I/O (4, 7, 8, 9 — the guard fires before
 *   the facilitator probe; stderr never contains 'facilitator probe
 *   failed' on a guard rejection)
 *
 * Offline: the launcher subprocesses run on loopback with a temp DB and
 * a closed-port facilitator URL. No signing, no transactions, no wallet,
 * no real facilitator, no chain node, no CCD spend anywhere in this file.
 *
 * Run with: npm test  (tsx)
 */

import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, throws } from './helpers.mjs';
import { resolveMockAllowed, isLoopbackHost, assertMockModeAllowed } from '../src/x402/mockModeGuard.js';

const SCRIPT = new URL('../scripts/x402-resource-server.mts', import.meta.url).pathname;
const RESOURCE_PATH = '/protected';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// The input that allows mock mode: opt-in + loopback + non-production.
const ALLOW = { allowMock: '1', host: '127.0.0.1', nodeEnv: 'test' };

// ─── 1. resolveMockAllowed ──────────────────────────────────────────────────

test('1. resolveMockAllowed: only an explicit 1 or true allows mock mode', () => {
  ok(resolveMockAllowed('1'), "'1' allows");
  ok(resolveMockAllowed('true'), "'true' allows");
  ok(resolveMockAllowed('TRUE'), "'TRUE' allows (case-insensitive)");
  ok(resolveMockAllowed('True'), "'True' allows");
  ok(resolveMockAllowed('  1  '), "'  1  ' allows (whitespace ignored)");
  ok(!resolveMockAllowed(undefined), 'unset does not allow');
  ok(!resolveMockAllowed(''), 'empty does not allow');
  ok(!resolveMockAllowed('   '), 'whitespace-only does not allow');
  ok(!resolveMockAllowed('0'), "'0' does not allow");
  ok(!resolveMockAllowed('false'), "'false' does not allow");
  ok(!resolveMockAllowed('FALSE'), "'FALSE' does not allow");
  ok(!resolveMockAllowed('yes'), "'yes' does not allow (not an explicit truthy value)");
  ok(!resolveMockAllowed('on'), "'on' does not allow");
  ok(!resolveMockAllowed('mock'), "'mock' does not allow");
  ok(!resolveMockAllowed('1x'), "'1x' does not allow");
});

// ─── 2. isLoopbackHost ──────────────────────────────────────────────────────

test('2. isLoopbackHost: only 127.0.0.1, ::1, localhost count as loopback', () => {
  ok(isLoopbackHost('127.0.0.1'), '127.0.0.1 is loopback');
  ok(isLoopbackHost('::1'), '::1 is loopback');
  ok(isLoopbackHost('localhost'), 'localhost is loopback');
  ok(isLoopbackHost('LOCALHOST'), 'LOCALHOST is loopback (hostname case-insensitive)');
  ok(isLoopbackHost('  127.0.0.1  '), 'whitespace-padded 127.0.0.1 is loopback');
  ok(!isLoopbackHost('0.0.0.0'), '0.0.0.0 is not loopback (all interfaces)');
  ok(!isLoopbackHost('192.168.1.10'), 'a LAN IP is not loopback');
  ok(!isLoopbackHost('8.8.8.8'), 'a public IP is not loopback');
  ok(!isLoopbackHost('example.com'), 'a hostname is not loopback');
  ok(!isLoopbackHost(''), 'an empty host is not loopback');
  ok(!isLoopbackHost('   '), 'a whitespace-only host is not loopback');
  ok(!isLoopbackHost(undefined), 'an unset host is not loopback');
  ok(!isLoopbackHost('127.1'), "a shorthand '127.1' is not loopback (ambiguous)");
  ok(!isLoopbackHost('[::1]'), "a bracketed '[::1]' is not loopback (ambiguous)");
  ok(!isLoopbackHost('localhost.'), "a trailing-dot 'localhost.' is not loopback (ambiguous)");
});

// ─── 3. assertMockModeAllowed ───────────────────────────────────────────────

test('3. assertMockModeAllowed: mock needs opt-in + non-production + loopback; real always passes', () => {
  // Mock + opt-in + loopback + non-production → allowed.
  assertMockModeAllowed('mock', ALLOW);
  assertMockModeAllowed('mock', { allowMock: 'true', host: '::1', nodeEnv: 'development' });
  assertMockModeAllowed('mock', { allowMock: '1', host: 'localhost', nodeEnv: undefined });
  assertMockModeAllowed('mock', { allowMock: 'TRUE', host: 'LOCALHOST', nodeEnv: 'test' });
  // Mock without the opt-in → rejected, naming the opt-in variable.
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, allowMock: undefined }),
    'AGENTTRUST_X402_ALLOW_MOCK',
    'mock without the opt-in throws and names the opt-in variable',
  );
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, allowMock: '0' }),
    'AGENTTRUST_X402_ALLOW_MOCK',
    "mock with ALLOW_MOCK=0 throws",
  );
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, allowMock: 'yes' }),
    'AGENTTRUST_X402_ALLOW_MOCK',
    "mock with ALLOW_MOCK=yes throws",
  );
  // Mock with NODE_ENV=production → rejected, naming NODE_ENV.
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, nodeEnv: 'production' }),
    'NODE_ENV=production',
    'mock with NODE_ENV=production throws',
  );
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, nodeEnv: 'Production' }),
    'NODE_ENV=production',
    'mock with NODE_ENV=Production throws (case-insensitive)',
  );
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, nodeEnv: '  production  ' }),
    'NODE_ENV=production',
    'mock with whitespace-padded NODE_ENV=production throws',
  );
  // Mock with a non-loopback host → rejected, naming the host variable.
  for (const host of ['0.0.0.0', '192.168.1.10', '8.8.8.8', 'example.com', '127.1', '[::1]', 'localhost.']) {
    throws(
      () => assertMockModeAllowed('mock', { ...ALLOW, host }),
      'AGENTTRUST_X402_HOST',
      `mock with host ${host} throws`,
    );
  }
  // Mock with an empty or unset host → rejected (fail-closed).
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, host: '' }),
    'AGENTTRUST_X402_HOST',
    'mock with an empty host throws',
  );
  throws(
    () => assertMockModeAllowed('mock', { ...ALLOW, host: undefined }),
    'AGENTTRUST_X402_HOST',
    'mock with an unset host throws',
  );
  // Real mode always passes — no opt-in, no host check, no environment
  // check. (The launcher supplies its own default host for real mode.)
  assertMockModeAllowed('real', {});
  assertMockModeAllowed('real', { allowMock: undefined, host: '0.0.0.0', nodeEnv: 'production' });
  assertMockModeAllowed('real', { allowMock: '1', host: '127.0.0.1', nodeEnv: 'production' });
});

// ─── launcher subprocess helpers ────────────────────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess, deadlineMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() - started > deadlineMs) {
        throw new Error(`server did not answer ${url} within ${deadlineMs}ms`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function waitForExit(child: ChildProcess, deadlineMs: number): Promise<number | null> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) return child.exitCode;
    if (Date.now() - started > deadlineMs) return null;
    await new Promise(r => setTimeout(r, 100));
  }
}

function spawnLauncher(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', d => { stdout += String(d); });
  child.stderr?.on('data', d => { stderr += String(d); });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

async function launcherEnv(over: Record<string, string | undefined> = {}): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-guard-'));
  const dbPath = join(dir, 'discovery.db');
  const port = await freePort();
  const deadFacilitatorPort = await freePort();
  const env: Record<string, string> = {
    AGENTTRUST_X402_FACILITATOR_MODE: 'mock',
    AGENTTRUST_X402_ALLOW_MOCK: '1',
    AGENTTRUST_X402_HOST: '127.0.0.1',
    AGENTTRUST_X402_PORT: String(port),
    AGENTTRUST_FACILITATOR_URL: `http://127.0.0.1:${deadFacilitatorPort}`,
    AGENTTRUST_DISCOVERY_DB: dbPath,
    NODE_ENV: 'test',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { ...env, __dir: dir, __port: String(port) };
}

// ─── 4–10. Launcher ─────────────────────────────────────────────────────────

test('4. launcher: mock mode WITHOUT the opt-in refuses to start (exit 1, before any probe)', async () => {
  const env = await launcherEnv({ AGENTTRUST_X402_ALLOW_MOCK: undefined });
  const dir = env['__dir']!;
  const { child, getStderr } = spawnLauncher(env);
  try {
    const code = await waitForExit(child, 20_000);
    eq(code, 1, 'exits 1 (startup refusal, not a probe failure)');
    const stderr = getStderr();
    ok(stderr.includes('AGENTTRUST_X402_ALLOW_MOCK'), 'stderr names the opt-in variable');
    ok(stderr.includes('AGENTTRUST_X402_FACILITATOR_MODE=mock'), 'stderr names the mode variable');
    ok(!stderr.includes('facilitator probe failed'), 'no facilitator probe ran — the guard fired first');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('5. launcher: mock mode WITH ALLOW_MOCK=1 on loopback, non-production, starts and serves 402 + Discovery', async () => {
  const env = await launcherEnv();
  const dir = env['__dir']!;
  const port = env['__port']!;
  const { child, getStdout } = spawnLauncher(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}${RESOURCE_PATH}`, child, 20_000);
    ok(child.exitCode === null, 'server is still running');
    const challenge = await fetch(`${base}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    const list = await fetch(`${base}/api/services`);
    eq(list.status, 200, 'Discovery list status');
    ok(getStdout().includes('mock'), 'startup log names mock mode');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('6. launcher: ALLOW_MOCK=0 does not allow mock mode (exit 1)', async () => {
  const env = await launcherEnv({ AGENTTRUST_X402_ALLOW_MOCK: '0' });
  const dir = env['__dir']!;
  const { child, getStderr } = spawnLauncher(env);
  try {
    const code = await waitForExit(child, 20_000);
    eq(code, 1, 'exits 1');
    ok(getStderr().includes('AGENTTRUST_X402_ALLOW_MOCK'), 'stderr names the opt-in variable');
    ok(!getStderr().includes('facilitator probe failed'), 'no facilitator probe ran — the guard fired first');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('7. launcher: NODE_ENV=production refuses mock mode (exit 1), even with the opt-in', async () => {
  const env = await launcherEnv({ NODE_ENV: 'production' });
  const dir = env['__dir']!;
  const { child, getStderr } = spawnLauncher(env);
  try {
    const code = await waitForExit(child, 20_000);
    eq(code, 1, 'exits 1');
    const stderr = getStderr();
    ok(stderr.includes('NODE_ENV=production'), 'stderr names NODE_ENV=production');
    ok(!stderr.includes('facilitator probe failed'), 'no facilitator probe ran — the guard fired first');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('8. launcher: a non-loopback host refuses mock mode (exit 1), even with the opt-in', async () => {
  for (const host of ['0.0.0.0', '192.168.1.10']) {
    const env = await launcherEnv({ AGENTTRUST_X402_HOST: host });
    const dir = env['__dir']!;
    const { child, getStderr } = spawnLauncher(env);
    try {
      const code = await waitForExit(child, 20_000);
      eq(code, 1, `host ${host}: exits 1`);
      const stderr = getStderr();
      ok(stderr.includes('AGENTTRUST_X402_HOST'), `host ${host}: stderr names the host variable`);
      ok(stderr.includes('loopback'), `host ${host}: stderr names the loopback requirement`);
      ok(!stderr.includes('facilitator probe failed'), `host ${host}: no facilitator probe ran — the guard fired first`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('9. launcher: an empty host is normalized to loopback and mock mode starts (M1 fail-safe)', async () => {
  // M1: AGENTTRUST_X402_HOST='' must fail-safe to 127.0.0.1, never bind
  // `::`. The launcher normalizes the host before the guard runs, so
  // the guard sees the effective (loopback) host and mock mode starts.
  // The startup log names the loopback URL, proving the bind address.
  const env = await launcherEnv({ AGENTTRUST_X402_HOST: '' });
  const dir = env['__dir']!;
  const port = env['__port']!;
  const { child, getStdout } = spawnLauncher(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}${RESOURCE_PATH}`, child, 20_000);
    ok(child.exitCode === null, 'server is still running');
    const challenge = await fetch(`${base}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    const list = await fetch(`${base}/api/services`);
    eq(list.status, 200, 'Discovery list status');
    ok(getStdout().includes(`http://127.0.0.1:${port}`), 'startup log names the loopback URL (bind address is loopback, not ::)');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9b. launcher: a whitespace-only host is normalized to loopback and mock mode starts', async () => {
  const env = await launcherEnv({ AGENTTRUST_X402_HOST: '   ' });
  const dir = env['__dir']!;
  const port = env['__port']!;
  const { child, getStdout } = spawnLauncher(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}${RESOURCE_PATH}`, child, 20_000);
    ok(child.exitCode === null, 'server is still running');
    const challenge = await fetch(`${base}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    ok(getStdout().includes(`http://127.0.0.1:${port}`), 'startup log names the loopback URL');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9c. launcher: an unset host defaults to loopback and mock mode starts', async () => {
  const env = await launcherEnv({ AGENTTRUST_X402_HOST: undefined });
  const dir = env['__dir']!;
  const port = env['__port']!;
  const { child, getStdout } = spawnLauncher(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}${RESOURCE_PATH}`, child, 20_000);
    ok(child.exitCode === null, 'server is still running');
    const challenge = await fetch(`${base}${RESOURCE_PATH}`);
    eq(challenge.status, 402, 'challenge status');
    ok(getStdout().includes(`http://127.0.0.1:${port}`), 'startup log names the loopback URL');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10. launcher: real mode is unaffected by the guard (still exit 2 on a dead facilitator)', async () => {
  const env = await launcherEnv({
    AGENTTRUST_X402_FACILITATOR_MODE: undefined,
    AGENTTRUST_X402_ALLOW_MOCK: undefined,
    NODE_ENV: undefined,
  });
  const dir = env['__dir']!;
  const { child, getStderr } = spawnLauncher(env);
  try {
    const code = await waitForExit(child, 20_000);
    eq(code, 2, 'exits 2 (facilitator probe failed — real mode, unchanged)');
    ok(getStderr().includes('facilitator probe failed'), 'the probe ran and failed');
    ok(!getStderr().includes('AGENTTRUST_X402_ALLOW_MOCK'), 'the guard did not fire for real mode');
    ok(!getStderr().includes('NODE_ENV=production'), 'no production check for real mode');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\nmock-mode-guard: ${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
