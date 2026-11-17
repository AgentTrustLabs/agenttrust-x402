/**
 * Facilitator OS identity for the IPC suites.
 *
 * The IPC suites must run as the facilitator OS user (ubuntu) AND hold the
 * `authclients` supplementary group: the Owner authorizes only the
 * facilitator UID over SO_PEERCRED, and the Owner socket lives in a
 * group-gated directory. The UID/GID are NOT constants: on GitHub-hosted
 * runners uid 1001 is the `runner` user, so `ubuntu` gets a free UID and
 * `authclients` gets a free GID. Resolve both at runtime (environment
 * override first, OS lookup second) so the gate means the same thing in
 * every environment.
 *
 * Skip convention: a suite that cannot run in this process exits with code
 * 3. test/run.mjs treats 3 as SKIPPED (a separate status, never PASS) and
 * fails CI when any suite skips.
 */

import { execSync } from 'node:child_process';

const toInt = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const execOut = (cmd: string): string | null => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

/** UID of the facilitator OS user (ubuntu). */
export const facilitatorUid = (): number | null => {
  const fromEnv = toInt(process.env.TEST_FACILITATOR_UID);
  if (fromEnv !== null) return fromEnv;
  return toInt(execOut('id -u ubuntu') ?? undefined);
};

/** GID of the `authclients` group. */
export const authclientsGid = (): number | null => {
  const fromEnv = toInt(process.env.TEST_AUTHCLIENTS_GID);
  if (fromEnv !== null) return fromEnv;
  const out = execOut('getent group authclients');
  if (out === null) return null;
  return toInt(out.split(':')[2] ?? '');
};

/**
 * Exit(3) with a SKIPPED line unless this process runs as the facilitator
 * UID with the `authclients` group. Returns the resolved facilitator UID
 * for the Owner's peer checks. Call at the top of an IPC suite, before
 * any setup that assumes the identity.
 */
export const requireFacilitatorProcess = (suite: string): number => {
  const wantUid = facilitatorUid();
  const wantGid = authclientsGid();
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const gids = typeof process.getgroups === 'function' ? process.getgroups() : [];
  if (wantUid === null || wantGid === null || uid !== wantUid || !gids.includes(wantGid)) {
    console.log(
      `${suite}: SKIPPED — requires the facilitator OS user (ubuntu, uid=${wantUid ?? 'unresolved'}) + authclients group (gid=${wantGid ?? 'unresolved'}) (uid=${uid}, groups=${gids.join(',')})`,
    );
    console.log(`  run: sudo -u ubuntu npx tsx test/${suite}.test.mts`);
    process.exit(3);
  }
  return wantUid;
};
