/**
 * Runner for the regression suite: node test/run.mjs   (or: npm test)
 *
 * .test.mjs  → run with plain node (no TypeScript)
 * .test.mts  → run with tsx (these import TypeScript modules from src/)
 *
 * Requirements: the MCP transport tests spawn `node dist/mcp/server.js`,
 * so the project must be compiled first. `npm test` does this via the `pretest`
 * script (`tsc`); running this file directly requires `npm run build` beforehand.
 *
 * No network access, no chain calls: every fetch is an injected mock and no live
 * host is contacted. The MCP server IS exercised, as a local subprocess over stdio.
 *
 * Exit codes per suite: 0 = PASS, 3 = SKIPPED (the suite did not run), anything
 * else (including killed-by-signal, status null) = FAIL. A SKIPPED suite is a
 * separate status, never PASS: the run fails and never prints "all suites
 * passed" while any suite skipped. This is deliberate — the IPC and
 * storage-isolation suites are the security boundary, and a green run that
 * never executed them is a false green.
 *
 * Per-suite identity: most suites run as the invoking user. The IPC suites
 * must run as the facilitator OS user (ubuntu) with the authclients group,
 * and the storage-isolation suite must run as root — the runner invokes
 * them through sudo, which gives each child process its real groups fresh
 * (group membership added to the runner itself never applies to the
 * already-running runner process, so the suites cannot rely on it).
 * Exit code 1 if any suite fails or skips.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// Preflight: the MCP transport suites need compiled output. Fail loudly instead of
// letting them report "no output; stderr: …MODULE_NOT_FOUND" five times over.
const required = 'dist/mcp/server.js';
if (!existsSync(required)) {
  console.error(
    `${required} is missing — the test suite exercises the compiled MCP server.\n` +
      `Run \`npm run build\` (or \`npm test\`, which builds first via pretest), then retry.`,
  );
  process.exit(1);
}

const dir = new URL('.', import.meta.url).pathname;
const root = new URL('..', import.meta.url).pathname;
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.mts'))
  .sort();

// Suites that must execute under a different OS identity. The runner has
// passwordless sudo in CI (and locally when run as root); the child process
// gets the target user's groups fresh at exec time.
const RUN_AS = {
  'owner-storage-isolation.test.mts': ['sudo'],
  'ipc-context.test.mts': ['sudo', '-u', 'ubuntu'],
  'ipc-recovery.test.mts': ['sudo', '-u', 'ubuntu'],
  'ipc-signing.test.mts': ['sudo', '-u', 'ubuntu'],
  'response-loss.test.mts': ['sudo', '-u', 'ubuntu'],
  'separate-process-signing.test.mts': ['sudo', '-u', 'ubuntu'],
  // The wiring suite's cross-process section needs the facilitator
  // identity too; without it the section skips and the suite exits 3.
  'facilitator-sponsor-signer-wiring.test.mts': ['sudo', '-u', 'ubuntu'],
};

const SKIP_EXIT = 3;

let passedSuites = 0;
let skippedSuites = 0;
let failedSuites = 0;
const results = [];

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const isTs = file.endsWith('.mts');
  const argv = isTs ? ['tsx', `${dir}${file}`] : [`${dir}${file}`];
  const prefix = RUN_AS[file] ?? [];
  const cmd = prefix.length > 0 ? prefix[0] : isTs ? 'npx' : process.execPath;
  const args = prefix.length > 0 ? [...prefix.slice(1), ...(isTs ? ['npx', ...argv] : [process.execPath, ...argv])] : argv;
  let r;
  try {
    r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root });
  } catch (e) {
    // spawnSync itself failed (bad command, no npx): loud per-suite failure.
    results.push({ file, status: 'FAIL', summary: `runner could not spawn this suite: ${e instanceof Error ? e.message : String(e)}` });
    failedSuites++;
    continue;
  }
  process.stdout.write(r.stdout ?? '');
  if (r.stderr) process.stderr.write(String(r.stderr).replace(/.*DeprecationWarning.*\n?/g, ''));
  const summary = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  if (r.error) {
    results.push({ file, status: 'FAIL', summary: `spawn error: ${r.error.message}` });
    failedSuites++;
  } else if (r.status === 0) {
    results.push({ file, status: 'PASS', summary });
    passedSuites++;
  } else if (r.status === SKIP_EXIT) {
    results.push({ file, status: 'SKIPPED', summary });
    skippedSuites++;
  } else {
    // status null = killed by signal; any other non-zero = failed.
    results.push({ file, status: 'FAIL', summary: r.status === null ? `${summary} (killed by signal ${r.signal ?? '?'})` : summary });
    failedSuites++;
  }
}

console.log('\n' + '─'.repeat(64));
for (const r of results) {
  console.log(`${r.status.padEnd(7)}  ${r.file.padEnd(46)} ${r.summary}`);
}
console.log('─'.repeat(64));
console.log(`${passedSuites} passed, ${skippedSuites} skipped, ${failedSuites} failed (of ${results.length} suites)`);
if (failedSuites > 0) console.log(`${failedSuites} suite(s) failed`);
if (skippedSuites > 0) console.log(`${skippedSuites} suite(s) skipped — a skipped suite is not a pass; the run fails until every suite executes`);
if (failedSuites === 0 && skippedSuites === 0) console.log('all suites passed');
process.exit(failedSuites > 0 || skippedSuites > 0 ? 1 : 0);
