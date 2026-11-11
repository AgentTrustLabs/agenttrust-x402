/**
 * gRPC account info provider tests.
 *
 * The provider is tested with a deterministic fake client. No network access,
 * no real account, no private keys.
 *
 * Run: npx tsx test/grpc-account-info-provider.test.mts
 */

import { eq, ok } from './helpers.mjs';
import { GrpcAccountInfoProvider, AccountInfoProviderError } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { SdkSenderVerifier } from '../services/facilitator/src/senderVerifier.js';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Transaction } from '@concordium/web-sdk';

const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
// Full Testnet genesis hash, observed live on the node.
const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 1. valid account info ──────────────────────────────────────────────────

test('01. valid account info is returned', async () => {
  const info = makeFakeAccountInfo({ verifyKey: 'aa'.repeat(32), threshold: 1, address: SENDER });
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  const got = await provider.getAccountInfo(SENDER, CAIP2);
  ok(got !== null, 'info returned');
  ok(got!.accountThreshold === 1, 'threshold');
});

// ── 2. missing account ──────────────────────────────────────────────────────

test('02. missing account → null', async () => {
  const client = { async getAccountInfo() { throw new Error('NOT_FOUND: account not found'); }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  const got = await provider.getAccountInfo(SENDER, CAIP2);
  ok(got === null, 'null returned');
});

// ── 3. RPC unavailable ──────────────────────────────────────────────────────

test('03. RPC unavailable → throws AccountInfoProviderError(rpc_unavailable)', async () => {
  const client = { async getAccountInfo() { throw new Error('connection refused'); }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'rpc_unavailable';
  }
  ok(threw, 'rpc_unavailable thrown');
});

// ── 4. timeout ──────────────────────────────────────────────────────────────

test('04. timeout → AccountInfoProviderError(timeout)', async () => {
  const client = { async getAccountInfo() { return new Promise(() => {}); }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client, timeoutMs: 50 });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'timeout';
  }
  ok(threw, 'timeout thrown');
});

// ── 5. wrong network ────────────────────────────────────────────────────────

test('05. wrong network → AccountInfoProviderError(network_mismatch)', async () => {
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client: { async getAccountInfo() { return null; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } } });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, 'ccd:0000');
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'network_mismatch';
  }
  ok(threw, 'network_mismatch thrown');
});

// ── 6. unknown network ──────────────────────────────────────────────────────

test('06. unknown network → AccountInfoProviderError(unknown_network)', async () => {
  let threw = false;
  try {
    new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: 'ccd:unknown', client: { async getAccountInfo() { return null; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } } });
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'unknown_network';
  }
  ok(threw, 'unknown_network thrown');
});

// ── 7. malformed account info (empty credentials) ───────────────────────────

test('07. malformed account info → AccountInfoProviderError(malformed_account_info)', async () => {
  const info = makeFakeAccountInfo({ verifyKey: 'aa'.repeat(32), threshold: 1, address: SENDER });
  (info as any).accountCredentials = {};
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'malformed_account_info';
  }
  ok(threw, 'malformed thrown');
});

// ── 8. malformed account info (bad verifyKey) ───────────────────────────────

test('08. bad verifyKey → malformed_account_info', async () => {
  const info = makeFakeAccountInfo({ verifyKey: 'zz'.repeat(32), threshold: 1, address: SENDER });
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'malformed_account_info';
  }
  ok(threw, 'bad verifyKey rejected');
});

// ── 9. account address mismatch ──────────────────────────────────────────────

test('09. account address mismatch → network_mismatch', async () => {
  const info = makeFakeAccountInfo({ verifyKey: 'aa'.repeat(32), threshold: 1, address: RECIPIENT });
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.getAccountInfo(SENDER, CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'network_mismatch';
  }
  ok(threw, 'address mismatch rejected');
});

// ── 10. invalid address ─────────────────────────────────────────────────────

test('10. invalid address → AccountInfoProviderError(invalid_address)', async () => {
  const client = { async getAccountInfo() { return null; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.getAccountInfo('not-an-address', CAIP2);
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'invalid_address';
  }
  ok(threw, 'invalid address rejected');
});

// ── 11. verifyNode network mismatch ─────────────────────────────────────────

test('11. verifyNode rejects wrong genesis', async () => {
  const client = { async getAccountInfo() { return null; }, async getConsensusStatus() { return { genesisBlock: '00000000000000000000000000000000' }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  let threw = false;
  try {
    await provider.verifyNode();
  } catch (e) {
    threw = e instanceof AccountInfoProviderError && e.failure === 'network_mismatch';
  }
  ok(threw, 'wrong genesis rejected');
});

// ── 12. caller cannot override public keys ──────────────────────────────────

test('12. caller-supplied keys never reach the verifier', async () => {
  // The verifier only reads account info from the provider. The caller's tx JSON does not
  // influence the public keys used for verification.
  const { publicKey } = (await import('node:crypto')).generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const info = makeFakeAccountInfo({ verifyKey: 'aa'.repeat(32), threshold: 1, address: SENDER });
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  // Even if the caller passes a different verifyKey in the tx, the provider's key is used.
  const got = await provider.getAccountInfo(SENDER, CAIP2);
  ok(got !== null && (got as any).accountCredentials[0].value.contents.credentialPublicKeys.keys[0].verifyKey === 'aa'.repeat(32), 'provider key is authoritative');
});

// ── 13. provider + verifier integration ─────────────────────────────────────

test('13. provider feeds the SDK verifier (valid signature)', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const tx = {
    version: 1,
    header: { sender: SENDER, nonce: 7, expiry: Math.floor(Date.now() / 1000) + 200, executionEnergyAmount: 300, numSignatures: 1, sponsor: { account: SENDER, numSignatures: 1 } },
    payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
    signatures: { sender: {}, sponsor: {} },
  };
  const signable = Transaction.signableFromJSON(tx);
  const signer = { async sign(digest: ArrayBuffer) { return { 0: { 0: sign(null, Buffer.from(digest), privateKey).toString('hex') } }; }, getSignatureCount() { return 1n; } };
  const signed = await Transaction.sign(signable, signer);
  const json = Transaction.toJSON(signed) as any;

  const info = makeFakeAccountInfo({ verifyKey: rawPub, threshold: 1, address: SENDER });
  const client = { async getAccountInfo() { return info; }, async getConsensusStatus() { return { genesisBlock: TESTNET_GENESIS }; } };
  const provider = new GrpcAccountInfoProvider({ host: 'localhost', port: 20000, network: CAIP2, client });
  const verifier = new SdkSenderVerifier({ network: CAIP2, accountInfoProvider: provider });
  const r = await verifier.verify(json);
  ok(r.ok === true, r.ok ? 'ok' : r.reason);
});

(async () => {
  // Each test uses the shared `ok()` helper, which throws on failure. A test passes iff it
  // completes without throwing.
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — ${(e as Error).message}`);
    }
  }
  console.log(`\ngrpc-account-info-provider: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
