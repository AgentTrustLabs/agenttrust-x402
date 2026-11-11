/**
 * TASK 55 — production Testnet wiring corrections (SDK 12.0.2).
 *
 * Focused regression coverage for:
 *   - B3: real-mode submitter injection into `createIpcSponsorSigner`
 *   - B4: `buildVerifier` uses `ConcordiumGRPCNodeClient` (not the nonexistent `GRPCClient`)
 *   - fee/energy cap consistency
 *
 * Every test uses a fake signer / fake transport / stub client. No real signing, no
 * transaction construction for broadcast, no submission, no chain writes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig, ConfigurationError, TESTNET_CAIP2 } from '../services/facilitator/src/config.js';
import { createIpcSponsorSigner } from '../services/facilitator/src/ipcSponsorSigner.js';
import { ConcordiumTransactionSubmitter } from '../services/facilitator/src/concordiumTransactionSubmitter.js';
import { GrpcConcordiumTransport } from '../services/facilitator/src/grpcConcordiumTransport.js';
import { GrpcAccountInfoProvider, AccountInfoProviderError } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { validateSponsorContext } from '../services/facilitator/src/sdkSponsorSigner.js';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { startFacilitator } from '../services/facilitator/src/server.js';

const CAIP2 = TESTNET_CAIP2;
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const SVC_UID = 1001;
const HASH = 'ab'.repeat(32);

// ── assertion helpers (same shape the other suites use) ─────────────────────

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

// ── fixtures ────────────────────────────────────────────────────────────────

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t55-${tag}-`));
  return { dir, db: join(dir, 'f.db'), sock: join(dir, 's.sock'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A unix socket that accepts and immediately closes — satisfies the startup probe only. */
const dummySocket = (path: string): Promise<{ close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const srv = createServer((c) => c.destroy());
    srv.listen(path, () => resolve({ close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });

/** A fake submitter that records delegation and never touches a chain. */
function fakeSubmitter(behaviour: 'ok' | 'throw' = 'ok') {
  const calls = { submit: 0, finalize: 0 };
  const submitter = {
    async submit(): Promise<{ hash: string; status: string }> {
      calls.submit++;
      if (behaviour === 'throw') throw new Error('stub transport refused');
      return { hash: HASH, status: 'accepted' };
    },
    async awaitFinalization(): Promise<{ hash: string; status: string }> {
      calls.finalize++;
      return { hash: HASH, status: 'finalized' };
    },
  } as unknown as ConcordiumTransactionSubmitter;
  return { submitter, calls };
}

const realEnv = (over: Record<string, string> = {}) => ({
  FACILITATOR_MODE: 'real',
  FACILITATOR_PORT: '0',
  FACILITATOR_SPONSOR_ADDRESS: SPONSOR,
  FACILITATOR_NETWORK: CAIP2,
  FACILITATOR_SENDER_VERIFICATION: 'sdk',
  FACILITATOR_NODE_HOST: '127.0.0.1',
  FACILITATOR_NODE_PORT: '1',
  FACILITATOR_DB_PATH: '/tmp/t55-real.db',
  FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/t55-sign.sock',
  FACILITATOR_SIGNING_SERVICE_UID: String(SVC_UID),
  FACILITATOR_AUTHZ_SOCKET: '/tmp/t55-authz.sock',
  FACILITATOR_SIGNING_TIMEOUT_MS: '300',
  FACILITATOR_SENDER_VERIFY_TIMEOUT_MS: '300',
  ...over,
});

// ═══ A. B3 — submitter injection at the signer boundary ═════════════════════

console.log('\n── A. B3 — submitter injection ──');

{
  const { submitter, calls } = fakeSubmitter();
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    socketPath: '/tmp/t55-unused.sock',
    expectedUid: SVC_UID,
    maxEnergy: 1_000n,
    maxFeeMicroCcd: 10_000_000n,
    submitter,
  });

  const hash = await signer.submitTransaction({ version: 1 });
  eq(hash, HASH, 'A01. submitTransaction delegates to the injected submitter');
  eq(calls.submit, 1, 'A02. exactly one delegation');

  const fin = await signer.waitForFinalization(HASH, 100);
  eq(fin.status, 'finalized', 'A03. waitForFinalization delegates and maps finalized');
  eq(fin.txHash, HASH, 'A04. finalization is bound to the requested hash');
  eq(calls.finalize, 1, 'A05. exactly one finalization delegation');
  eq(fin.sender, SPONSOR, 'A06. finalization is attributed to the configured sponsor');
}

{
  // No submitter → fail closed (unchanged from TASK 46).
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    socketPath: '/tmp/t55-unused.sock',
    expectedUid: SVC_UID,
    maxEnergy: 1_000n,
    maxFeeMicroCcd: 10_000_000n,
  });
  let submitMsg = '';
  try {
    await signer.submitTransaction({ version: 1 });
  } catch (e) {
    submitMsg = (e as Error).message;
  }
  ok(/not available in IPC signing mode/i.test(submitMsg), `A07. missing submitter fails closed: "${submitMsg}"`);

  let finMsg = '';
  try {
    await signer.waitForFinalization(HASH, 100);
  } catch (e) {
    finMsg = (e as Error).message;
  }
  ok(/not available in IPC signing mode/i.test(finMsg), `A08. missing submitter fails finalization closed: "${finMsg}"`);
}

{
  // A throwing submitter must propagate as an error, never as a hash.
  const { submitter } = fakeSubmitter('throw');
  const signer = createIpcSponsorSigner({
    sponsorAddress: SPONSOR,
    network: CAIP2,
    socketPath: '/tmp/t55-unused.sock',
    expectedUid: SVC_UID,
    maxEnergy: 1_000n,
    maxFeeMicroCcd: 10_000_000n,
    submitter,
  });
  let msg = '';
  try {
    await signer.submitTransaction({ version: 1 });
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/stub transport refused/.test(msg), `A09. submitter error propagates, no hash invented: "${msg}"`);
}

console.log('\n── A10-A13. real-mode server wiring (fake signer, fake node client) ──');

{
  const w = tmp('a10');
  const srv = await dummySocket(w.sock);
  const nodeCalls = { submit: 0, status: 0 };
  const fakeNode = {
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
    sendTransaction: async () => { nodeCalls.submit++; return HASH; },
    getBlockItemStatus: async () => { nodeCalls.status++; return { status: 'finalized', outcome: { summary: { hash: HASH, transactionType: 'transfer' }, blockHash: 'cd'.repeat(32) } }; },
  };
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator(realEnv({
      FACILITATOR_SIGNING_SERVICE_SOCKET: w.sock,
      FACILITATOR_DB_PATH: w.db,
      FACILITATOR_SPONSOR_ADDRESS: SENDER,
    }), { nodeClient: fakeNode as never });
    ok(true, 'A10. real-mode facilitator starts with the injected submitter');

    const signer = started.core.getSigner();
    eq(signer.info().address, SENDER, 'A11. signer is the IPC signer bound to the sponsor');

    // submitTransaction must reach the injected submitter instead of throwing
    // "not available in IPC signing mode". With the fake node client it returns the
    // fake hash — proving delegation without any real broadcast.
    const signedTx = {
      version: 1,
      header: { sender: SENDER, nonce: 1, expiry: Math.floor(Date.now() / 1000) + 300, executionEnergyAmount: 603, numSignatures: 1, sponsor: { account: SPONSOR, numSignatures: 1 } },
      payload: { type: 'transfer', toAddress: RECIPIENT, amount: '1' },
      signatures: { sender: { 0: { 0: 'a'.repeat(64) } }, sponsor: { 0: { 0: 'b'.repeat(64) } } },
    };
    const h = await signer.submitTransaction(signedTx);
    eq(h, HASH, 'A12. submitTransaction delegates to the injected submitter');
    eq(nodeCalls.submit, 1, 'A12b. submit reached the injected node client exactly once');
    const fin = await signer.waitForFinalization(HASH, 100);
    eq(fin.status, 'finalized', 'A13. waitForFinalization delegates to the injected submitter');
    eq(nodeCalls.status >= 1, true, 'A13b. finalization polled the injected node client');
  } catch (e) {
    check('A10. real-mode facilitator starts with the injected submitter', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

console.log('\n── B. B4 — SDK 12.0.2 client construction ──');

{
  const nodejs = await import('@concordium/web-sdk/nodejs');
  const exported = nodejs as unknown as Record<string, unknown>;
  eq(typeof exported['ConcordiumGRPCNodeClient'], 'function', 'B01. ConcordiumGRPCNodeClient is exported');
  eq(exported['GRPCClient'], undefined, 'B02. GRPCClient is NOT exported (the TASK54 defect)');

  const creds = (nodejs as unknown as { credentials: { createSsl: () => unknown; createInsecure: () => unknown } }).credentials;
  ok(typeof creds.createSsl === 'function', 'B03. credentials.createSsl is available');
  ok(typeof creds.createInsecure === 'function', 'B04. credentials.createInsecure is available');

  const ClientCtor = exported['ConcordiumGRPCNodeClient'] as new (a: string, p: number, c: unknown) => Record<string, unknown>;
  const client = new ClientCtor('127.0.0.1', 1, creds.createInsecure());
  for (const m of ['sendTransaction', 'getBlockItemStatus', 'waitForTransactionFinalization', 'getAccountInfo', 'getConsensusStatus']) {
    eq(typeof client[m], 'function', `B05. client.${m} exists`);
  }
}

console.log('\n── B06-B09. grpc evidence mode constructs a real client ──');

{
  const w = tmp('b4');
  const srv = await dummySocket(w.sock);
  const token = createHash('sha256').update('t55-operator-token').digest('hex');
  let started: Awaited<ReturnType<typeof startFacilitator>> | null = null;
  try {
    started = await startFacilitator({
      FACILITATOR_MODE: 'mock',
      FACILITATOR_PORT: '0',
      FACILITATOR_DB_PATH: w.db,
      FACILITATOR_EVIDENCE_MODE: 'grpc',
      FACILITATOR_NODE_HOST: '127.0.0.1',
      FACILITATOR_NODE_PORT: '1',
      FACILITATOR_RECONCILE_ENABLED: '1',
      FACILITATOR_OPERATOR_TOKEN_SHA256: token,
    });
    ok(true, 'B06. grpc evidence mode starts without a constructor TypeError');

    // Seed a payment that has a recorded hash and is reconcilable.
    const repo = new SqliteSettlementRepository(w.db);
    const digest = 'd'.repeat(64);
    repo.claim(digest, 'req-key');
    repo.prepare(digest, HASH);
    repo.claimSubmit(digest, HASH);
    repo.markBroadcast(digest, HASH);
    repo.close();

    const res = await fetch(`${started.url}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer t55-operator-token` },
      body: JSON.stringify({ paymentDigest: digest }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    eq(res.status, 200, 'B07. reconcile answered by the real verifier');
    eq(body['changed'], false, 'B08. unreachable node retains pending (never success)');
    ok(
      /evidence unavailable/i.test(String(body['reason'])),
      `B09. verifier reached the node boundary: "${String(body['reason'])}"`,
    );

    // The stored state must still be non-terminal.
    const after = new SqliteSettlementRepository(w.db);
    eq(after.get(digest)?.state, 'outcome_unknown', 'B10. state unchanged after inconclusive evidence');
    after.close();
  } catch (e) {
    check('B06. grpc evidence mode starts without a constructor TypeError', false, (e as Error).message);
  } finally {
    if (started) await started.close();
    await srv.close();
    w.rm();
  }
}

// ═══ C. genesis / network verification preserved ═════════════════════════════

console.log('\n── C. genesis verification ──');

{
  const goodClient = {
    getConsensusStatus: async () => ({ genesisBlock: TESTNET_GENESIS }),
    getAccountInfo: async () => ({}),
  } as never;
  const p = new GrpcAccountInfoProvider({ host: 'x', port: 1, network: CAIP2, client: goodClient });
  const id = await p.verifyNode();
  eq(id.genesisHash, TESTNET_GENESIS, 'C01. matching genesis accepted');
  eq(id.caip2, CAIP2, 'C02. identity binds the CAIP-2 network');

  const badClient = {
    getConsensusStatus: async () => ({ genesisBlock: 'f'.repeat(64) }),
    getAccountInfo: async () => ({}),
  } as never;
  const p2 = new GrpcAccountInfoProvider({ host: 'x', port: 1, network: CAIP2, client: badClient });
  let failure = '';
  let message = '';
  try {
    await p2.verifyNode();
  } catch (e) {
    failure = (e as AccountInfoProviderError).failure ?? '';
    message = (e as Error).message;
  }
  eq(failure, 'network_mismatch', 'C03. mismatched genesis rejected');
  ok(/genesis/i.test(message), `C04. rejection names the genesis mismatch: "${message}"`);

  const deadClient = {
    getConsensusStatus: async () => { throw new Error('UNAVAILABLE'); },
    getAccountInfo: async () => ({}),
  } as never;
  const p3 = new GrpcAccountInfoProvider({ host: 'x', port: 1, network: CAIP2, client: deadClient });
  let f3 = '';
  try { await p3.verifyNode(); } catch (e) { f3 = (e as AccountInfoProviderError).failure ?? ''; }
  eq(f3, 'rpc_unavailable', 'C05. unreachable node fails closed as rpc_unavailable');
}

// ═══ D. fee / energy configuration ══════════════════════════════════════════

console.log('\n── D. fee / energy configuration ──');

{
  const cfg = loadConfig(realEnv());
  eq(cfg.maxEnergy, 1_000n, 'D01. default maxEnergy is 1000 NRG');
  eq(cfg.maxFeeMicroCcd, 10_000_000n, 'D02. default maxFeeMicroCcd is 10 CCD');

  // Live Testnet rate (getBlockChainParameters, protocol 10): 7172.71359466307 microCCD/NRG.
  // The in-code conservative estimate is 8000 microCCD/NRG (core.ts validateContext).
  const CONSERVATIVE = 8000n;
  const worstCaseAtDefault = cfg.maxEnergy * CONSERVATIVE;
  ok(
    worstCaseAtDefault <= cfg.maxFeeMicroCcd,
    `D03. caps are consistent: ${cfg.maxEnergy} NRG x ${CONSERVATIVE} = ${worstCaseAtDefault} <= ${cfg.maxFeeMicroCcd}`,
  );

  // Measured sponsored simple transfer: 603 NRG (2 sigs, 94-byte sponsored header, 41-byte
  // SDK transfer payload, 300 base cost).
  const MEASURED_SPONSORED_TRANSFER = 603n;
  ok(
    cfg.maxEnergy >= MEASURED_SPONSORED_TRANSFER,
    `D04. default cap covers the measured 603 NRG transfer (margin ${cfg.maxEnergy / MEASURED_SPONSORED_TRANSFER}x)`,
  );
  ok(
    cfg.maxEnergy > MEASURED_SPONSORED_TRANSFER,
    'D05. default cap leaves headroom above the measured cost',
  );

  // The exact upper bound under the conservative rate.
  const maxEnergyWithinFeeCap = cfg.maxFeeMicroCcd / CONSERVATIVE;
  eq(maxEnergyWithinFeeCap, 1_250n, 'D06. 10 CCD buys 1250 NRG at the conservative rate');

  // Env override still works and is honoured.
  const over = loadConfig(realEnv({ FACILITATOR_MAX_ENERGY: '2000' }));
  eq(over.maxEnergy, 2_000n, 'D07. FACILITATOR_MAX_ENERGY override honoured');

  // Malformed values still rejected.
  let msg = '';
  try { loadConfig(realEnv({ FACILITATOR_MAX_ENERGY: '-1' })); } catch (e) { msg = (e as Error).message; }
  ok(/non-negative integer/.test(msg), `D08. negative energy rejected: "${msg}"`);
}

console.log('\n── D09-D14. cap enforcement at the signer boundary ──');

{
  const base = { sponsorAddress: SPONSOR, network: CAIP2, maxEnergy: 1_000n, maxFeeMicroCcd: 10_000_000n };
  const ctx = (over: Record<string, unknown> = {}) => ({
    network: CAIP2, sponsor: SPONSOR, recipient: RECIPIENT,
    energy: 603n, feeMicroCcd: 4_824_000n, ...over,
  });

  eq(validateSponsorContext(base, ctx()), null, 'D09. measured transfer (603 NRG, 4.824 CCD) accepted');
  ok(
    /energy 1001 exceeds cap 1000/.test(String(validateSponsorContext(base, ctx({ energy: 1_001n })))),
    'D10. one NRG above the cap is refused',
  );
  ok(
    /fee .* exceeds cap/.test(String(validateSponsorContext(base, ctx({ feeMicroCcd: 10_000_001n })))),
    'D11. one microCCD above the fee cap is refused',
  );
  ok(
    /wrong sponsor/.test(String(validateSponsorContext(base, ctx({ sponsor: SENDER })))),
    'D12. a different sponsor is refused',
  );
  ok(
    /wrong network/.test(String(validateSponsorContext(base, ctx({ network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' })))),
    'D13. a different network is refused',
  );
  ok(
    /malformed fee\/energy/.test(String(validateSponsorContext(base, ctx({ energy: 0n })))),
    'D14. zero energy is refused as malformed',
  );
}

// ═══ E. mock-mode compatibility ═════════════════════════════════════════════

console.log('\n── E. mock-mode compatibility ──');

{
  const f = await startFacilitator({ FACILITATOR_MODE: 'mock', FACILITATOR_PORT: '0' });
  try {
    const h = (await (await fetch(`${f.url}/healthz`)).json()) as Record<string, unknown>;
    eq(h['mode'], 'mock', 'E01. mock mode still starts');
    eq(h['canSign'], false, 'E02. mock cannot sign');
    // The injection is real-mode only: mock configs cannot even name a node endpoint
    // without sender verification, and never construct a submitter.
    eq(loadConfig({ FACILITATOR_MODE: 'mock' }).maxEnergy, 1_000n, 'E03. mock config inherits the same cap default');
  } finally {
    await f.close();
  }

  // mock + signing service is still rejected
  let msg = '';
  try {
    loadConfig({ FACILITATOR_MODE: 'mock', FACILITATOR_SIGNING_SERVICE_SOCKET: '/tmp/x.sock' });
  } catch (e) {
    msg = (e as Error).message;
  }
  ok(/mock mode must not configure the signing service/i.test(msg), `E04. mock rejects a signing socket: "${msg}"`);
}

// ── summary ─────────────────────────────────────────────────────────────────

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask55: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
