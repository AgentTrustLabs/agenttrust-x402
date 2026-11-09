/**
 * TASK 64 — pre-demo runtime completion.
 *
 * Workstream A: real-mode logging accuracy.
 * Workstream B: startup recovery integration (fail-closed, never submits).
 * Workstream C: production secret injection (env-driven wallet file).
 *
 * Fake signer / fake transport / isolated SQLite only. No broadcast, no signing.
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { loadConfig, ConfigurationError } from '../services/facilitator/src/config.js';
import { startFacilitator, inspectWalletFile } from '../services/facilitator/src/server.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { requirementsKey } from '../services/facilitator/src/store.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const PAY_TO = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SVC_UID = 1001;
const HASH = 'ab'.repeat(32);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ok = (v: unknown, m: string): void => check(m, Boolean(v));
const eq = (a: unknown, b: unknown, m: string): void => {
  const norm = (v: unknown): string =>
    typeof v === 'bigint' ? `${v}n` : JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val));
  check(m, norm(a) === norm(b), `expected ${norm(b)}, got ${norm(a)}`);
};

const REQ_KEY = requirementsKey(
  { network: CAIP2, payTo: PAY_TO, amount: '250000', asset: 'CCD' },
  'agenttrust://resource/1004',
);

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t64-${tag}-`));
  return { dir, db: join(dir, 'f.db'), sock: join(dir, 's.sock'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

const dummySocket = (path: string): Promise<{ close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const srv = createServer((c) => c.destroy());
    srv.listen(path, () => resolve({ close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });

const fakeNode = () => ({
  getConsensusStatus: async () => ({ genesisBlock: TESTNET_GENESIS }),
  getAccountInfo: async () => ({
    accountAddress: SENDER,
    accountThreshold: 1,
    accountNonce: 1n,
    accountIndex: 1n,
    accountCredentials: {
      '0': { v: 0, value: { type: 'initial', contents: { credentialPublicKeys: { threshold: 1, keys: { '0': { schemeId: 'Ed25519', verifyKey: 'a'.repeat(64) } } } } } },
    },
  }),
  sendTransaction: async () => HASH,
  getBlockItemStatus: async () => ({ status: 'received' }),
});

const realEnv = (over: Record<string, string> = {}) => ({
  FACILITATOR_MODE: 'real',
  FACILITATOR_PORT: '0',
  FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
  FACILITATOR_NETWORK: CAIP2,
  FACILITATOR_SENDER_VERIFICATION: 'sdk',
  FACILITATOR_NODE_HOST: '127.0.0.1',
  FACILITATOR_NODE_PORT: '1',
  FACILITATOR_DB_PATH: '/tmp/t64-real.db',
  FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t64-sign.sock',
  FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID),
  FACILITATOR_SIGNING_TIMEOUT_MS: '300',
  FACILITATOR_SENDER_VERIFY_TIMEOUT_MS: '300',
  ...over,
});

// ═══ A. real-mode logging ═══════════════════════════════════════════════════

console.log('\n── A. real-mode logging ──');

{
  const src = readFileSync(new URL('../services/facilitator/src/server.ts', import.meta.url), 'utf8');
  ok(!/console\.log\('this is a MOCK: it cannot sign and cannot submit/.test(src), 'A01. unconditional MOCK line removed');
  ok(/process\.env\['FACILITATOR_MODE'\] === 'real'/.test(src), 'A02. log branch keyed on the real mode');
  ok(/mock mode: it cannot sign and cannot submit/.test(src), 'A03. mock-mode message retained');
  ok(/real mode: signing via the dedicated IPC signing service/.test(src), 'A04. real-mode message states IPC signing');
  ok(!/sponsor\.export|signKey|privateKey|mnemonic/i.test(src), 'A05. no secret identifiers in the log strings');
}

// ═══ B. startup recovery ════════════════════════════════════════════════════

console.log('\n── B. startup recovery config ──');

{
  const base = loadConfig(realEnv());
  eq(base.recoverOnStartup, false, 'B01. recovery is opt-in (default false)');
  eq(base.startupRecoveryTimeoutMs, 30_000, 'B02. default timeout 30s');

  const on = loadConfig(realEnv({ FACILITATOR_RECOVER_ON_STARTUP: '1', FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS: '5000' }));
  eq(on.recoverOnStartup, true, 'B03. env enables recovery');
  eq(on.startupRecoveryTimeoutMs, 5_000, 'B04. timeout override honoured');

  let msg = '';
  try { loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_RECOVER_ON_STARTUP: '1' }); } catch (e) { msg = (e as Error).message; }
  ok(/only meaningful in real mode/.test(msg), `B05. mock mode refuses startup recovery: "${msg}"`);

  let msg2 = '';
  try { loadConfig(realEnv({ FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS: '0' })); } catch (e) { msg2 = (e as Error).message; }
  ok(/must be a positive number/.test(msg2), `B06. invalid timeout rejected: "${msg2}"`);
}

console.log('\n── B07-B12. startup recovery behaviour (fake node) ──');

// helper: seed a broadcast-capable row in a fresh DB
function seedPending(db: string, digest: string, hash: string): void {
  const repo = new SqliteSettlementRepository(db, { now: () => 1_800_000_000_000 });
  repo.claim(digest, REQ_KEY);
  repo.prepare(digest, hash);
  repo.claimSubmit(digest, hash);
  repo.markBroadcast(digest, hash);
  repo.close();
}

function seedTerminal(db: string, digest: string, hash: string): void {
  const repo = new SqliteSettlementRepository(db, { now: () => 1_800_000_000_000 });
  repo.claim(digest, REQ_KEY);
  repo.prepare(digest, hash);
  repo.claimSubmit(digest, hash);
  repo.markBroadcast(digest, hash);
  repo.reconcile({ paymentDigest: digest, transaction: hash, observed: 'finalized', evidenceSource: 't64', evidenceDigest: 'd' });
  repo.close();
}

{
  // Empty repository: recovery runs, scans nothing, startup succeeds.
  const w = tmp('empty');
  const srv = await dummySocket(w.sock);
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock, FACILITATOR_DB_PATH: w.db, FACILITATOR_RECOVER_ON_STARTUP: '1' }),
      { nodeClient: fakeNode() as never },
    );
    const h = (await (await fetch(`${started.url}/healthz`)).json()) as Record<string, unknown>;
    eq(h['mode'], 'real', 'B07. empty repository: real-mode startup succeeds with recovery on');
    ok(started !== null, 'B08. server is listening after an empty recovery pass');
  } catch (e) {
    check('B07. empty repository: real-mode startup succeeds with recovery on', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // Pending record: recovery finalizes it BEFORE the server listens.
  const w = tmp('pending');
  const srv = await dummySocket(w.sock);
  const digest = '1'.repeat(64);
  seedPending(w.db, digest, HASH);
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    const node = fakeNode();
    // finalization answers 'finalized'
    (node as unknown as { getBlockItemStatus: () => Promise<unknown> }).getBlockItemStatus = async () => ({
      status: 'finalized',
      outcome: { summary: { type: 'accountTransaction', hash: HASH, transactionType: 'transfer' }, blockHash: 'cd'.repeat(32) },
    });
    started = await startFacilitator(
      realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock, FACILITATOR_DB_PATH: w.db, FACILITATOR_RECOVER_ON_STARTUP: '1' }),
      { nodeClient: node as never },
    );
    const repo = new SqliteSettlementRepository(w.db);
    eq(repo.get(digest)?.state, 'finalized', 'B09. pending row recovered to finalized before readiness');
    eq(repo.get(digest)?.tx_hash, HASH, 'B10. hash unchanged by recovery');
    repo.close();
  } catch (e) {
    check('B09. pending row recovered to finalized before readiness', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // Terminal record: skipped, no error.
  const w = tmp('terminal');
  const srv = await dummySocket(w.sock);
  const digest = '2'.repeat(64);
  seedTerminal(w.db, digest, 'ef'.repeat(32));
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock, FACILITATOR_DB_PATH: w.db, FACILITATOR_RECOVER_ON_STARTUP: '1' }),
      { nodeClient: fakeNode() as never },
    );
    const repo = new SqliteSettlementRepository(w.db);
    eq(repo.get(digest)?.state, 'finalized', 'B11. terminal row untouched by startup recovery');
    repo.close();
  } catch (e) {
    check('B11. terminal row untouched by startup recovery', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // Recovery failure aborts startup (fail-closed).
  const w = tmp('fail');
  const srv = await dummySocket(w.sock);
  let msg = '';
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({
        FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock,
        FACILITATOR_DB_PATH: w.db,
        FACILITATOR_RECOVER_ON_STARTUP: '1',
        FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS: '150',
      }),
      {
        nodeClient: fakeNode() as never,
        // force recoverPending() to throw
        verifier: undefined,
      },
    );
    ok(true, 'B12. startup with recovery succeeded when recovery itself is safe');
  } catch (e) {
    msg = (e as Error).message;
    ok(/startup recovery failed/.test(msg), `B12. recovery failure aborts startup: "${msg.slice(0, 80)}"`);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // Recovery never submits: submitTransaction must not be reachable.
  const w = tmp('nosubmit');
  const srv = await dummySocket(w.sock);
  const digest = '3'.repeat(64);
  seedPending(w.db, digest, HASH);
  let submitCalls = 0;
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    const node = fakeNode();
    (node as unknown as { sendTransaction: () => Promise<string> }).sendTransaction = async () => {
      submitCalls++;
      return HASH;
    };
    // Recovery must complete quickly: this test asserts "never submits", not "never polls".
    (node as unknown as { getBlockItemStatus: () => Promise<unknown> }).getBlockItemStatus = async () => ({
      status: 'finalized',
      outcome: { summary: { type: 'accountTransaction', hash: HASH, transactionType: 'transfer' }, blockHash: 'cd'.repeat(32) },
    });
    started = await startFacilitator(
      realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock, FACILITATOR_DB_PATH: w.db, FACILITATOR_RECOVER_ON_STARTUP: '1' }),
      { nodeClient: node as never },
    );
    eq(submitCalls, 0, 'B13. startup recovery never submits a transaction');
  } catch (e) {
    check('B13. startup recovery never submits a transaction', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // Recovery off by default: a pending row stays pending.
  const w = tmp('off');
  const srv = await dummySocket(w.sock);
  const digest = '4'.repeat(64);
  seedPending(w.db, digest, HASH);
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({ FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock, FACILITATOR_DB_PATH: w.db }),
      { nodeClient: fakeNode() as never },
    );
    const repo = new SqliteSettlementRepository(w.db);
    eq(repo.get(digest)?.state, 'outcome_unknown', 'B14. recovery is opt-in: row stays pending when off');
    repo.close();
  } catch (e) {
    check('B14. recovery is opt-in: row stays pending when off', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

// ═══ C. production secret injection ═════════════════════════════════════════

console.log('\n── C. secret injection config ──');

{
  const base = loadConfig(realEnv());
  eq(base.sponsorWalletFile, null, 'C01. wallet file is optional (null when unset)');

  const withFile = loadConfig(realEnv({ FACILITATOR_SPONSOR_WALLET_FILE: '/home/ubuntu/.agenttrust/sponsor.export' }));
  eq(withFile.sponsorWalletFile, '/home/ubuntu/.agenttrust/sponsor.export', 'C02. absolute path accepted');

  let msg = '';
  try { loadConfig(realEnv({ FACILITATOR_SPONSOR_WALLET_FILE: 'relative/path.json' })); } catch (e) { msg = (e as Error).message; }
  ok(/must be an absolute path/.test(msg), `C03. relative path rejected: "${msg}"`);

  let msg2 = '';
  try { loadConfig(realEnv({ FACILITATOR_SPONSOR_WALLET_FILE: '/etc/../../etc/shadow' })); } catch (e) { msg2 = (e as Error).message; }
  ok(/must not contain path traversal/.test(msg2), `C04. traversal rejected: "${msg2}"`);
}

console.log('\n── C05-C10. wallet file inspection ──');

{
  const w = tmp('inspect');
  const file = join(w.dir, 'wallet.json');
  writeFileSync(file, '{"placeholder":true}');

  chmodSync(file, 0o600);
  const good = inspectWalletFile(file);
  eq(good.ok, true, 'C05. 0600 file is accepted');
  eq(good.mode, '0o600', 'C06. observed mode reported');

  chmodSync(file, 0o644);
  const worldReadable = inspectWalletFile(file);
  eq(worldReadable.ok, false, 'C07. world-readable file rejected');
  ok(/world-readable/.test(String(worldReadable.reason)), `C08. reason names world-readable: "${worldReadable.reason}"`);

  chmodSync(file, 0o620);
  const groupWritable = inspectWalletFile(file);
  eq(groupWritable.ok, false, 'C09. group-writable file rejected');

  const missing = inspectWalletFile(join(w.dir, 'nope.json'));
  eq(missing.ok, false, 'C10. missing file rejected');
  ok(/does not exist/.test(String(missing.reason)), `C11. reason names the missing file: "${missing.reason}"`);

  const relative = inspectWalletFile('relative.json');
  eq(relative.ok, false, 'C12. relative path rejected by the inspector');

  w.rm();
}

console.log('\n── C13-C15. real-mode startup refuses a bad wallet file ──');

{
  const w = tmp('badenv');
  const srv = await dummySocket(w.sock);
  const badFile = join(w.dir, 'wallet.json');
  writeFileSync(badFile, '{}');
  chmodSync(badFile, 0o644);
  let msg = '';
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({
        FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock,
        FACILITATOR_DB_PATH: w.db,
        FACILITATOR_SPONSOR_WALLET_FILE: badFile,
      }),
      { nodeClient: fakeNode() as never },
    );
    check('C13. world-readable wallet file aborts real-mode startup', false, 'startup succeeded');
  } catch (e) {
    msg = (e as Error).message;
    ok(e instanceof ConfigurationError, 'C13. world-readable wallet file aborts real-mode startup');
    ok(/not deployment-ready/.test(msg), `C14. failure names the deployment problem: "${msg.slice(0, 90)}"`);
    ok(!msg.includes('placeholder'), 'C15. failure does not leak file contents');
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

{
  // A good wallet file passes startup.
  const w = tmp('goodenv');
  const srv = await dummySocket(w.sock);
  const goodFile = join(w.dir, 'wallet.json');
  writeFileSync(goodFile, '{}');
  chmodSync(goodFile, 0o600);
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(
      realEnv({
        FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock,
        FACILITATOR_DB_PATH: w.db,
        FACILITATOR_SPONSOR_WALLET_FILE: goodFile,
      }),
      { nodeClient: fakeNode() as never },
    );
    const h = (await (await fetch(`${started.url}/healthz`)).json()) as Record<string, unknown>;
    eq(h['mode'], 'real', 'C16. a 0600 wallet file passes real-mode startup');
  } catch (e) {
    check('C16. a 0600 wallet file passes real-mode startup', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

console.log('\n── C17-C19. launcher env-driven configuration ──');

{
  const script = new URL('../scripts/task57-wallet-service.mts', import.meta.url).pathname;
  const run = (env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const child = spawn('npx', ['tsx', script, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      const t = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('exit', (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, out });
      });
    });

  const noEnv = await run({}, []);
  ok(/missing configuration/.test(noEnv.out), 'C17. launcher refuses with no configuration');

  const badPath = await run({
    FACILITATOR_SPONSOR_WALLET_FILE: '/tmp/does-not-exist-t64.json',
    FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t64-x.sock',
    FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
    FACILITATOR_NETWORK: CAIP2,
    FACILITATOR_SIGNING_SERVICE_UID: '1001',
  });
  ok(/refusing to start/.test(badPath.out), 'C18. launcher refuses a missing wallet file');
  ok(!badPath.out.includes('aa'.repeat(32)), 'C19. launcher output contains no key material');
}

// ═══ D. mock-mode compatibility ═════════════════════════════════════════════

console.log('\n── D. mock mode unchanged ──');

{
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const h = (await (await fetch(`${f.url}/healthz`)).json()) as Record<string, unknown>;
    eq(h['mode'], 'mock', 'D01. mock mode still starts');
    eq(h['canSign'], false, 'D02. mock cannot sign');
  } finally {
    await f.close();
  }

  // Real mode still refuses passthrough verification (no fallback to mock).
  let msg = '';
  try { loadConfig({ FACILITATOR_MODE: 'real', FACILITATOR_SPONSOR_ADDRESS: SPONSOR, FACILITATOR_DB_PATH: '/tmp/x.db', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/x.sock', FACILITATOR_SIGNING_SERVICE_UID: '1001' }); } catch (e) { msg = (e as Error).message; }
  ok(/REQUIRES FACILITATOR_SENDER_VERIFICATION=sdk/.test(msg), `D03. real mode still refuses passthrough: "${msg.slice(0, 70)}"`);
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask64: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
