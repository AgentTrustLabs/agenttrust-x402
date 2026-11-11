/**
 * Connect Wallet / Agent Pairing tests.
 *
 * Mocks only where wallet-provider interaction cannot run in automated tests.
 * No browser, no real wallet, no network, no transaction.
 *
 * The wallet connector is exercised through a fake provider mirroring the OFFICIAL
 * `@concordium/browser-wallet-api-helpers` 3.3.0 surface (verified against the
 * installed type definitions). Ownership is verified through the official SDK
 * using a locally generated test key: the SDK's `signMessage` prepends the
 * account address and 8 zero bytes, the same scheme the wallet uses internally,
 * so a valid test signature proves the protocol is sound.
 *
 * The pairing server is exercised end-to-end over a real loopback HTTP socket
 * with a fake account-info provider and a fake CIS-8004 verifier — no node, no
 * registry, no transaction.
 */

import { eq, ok, notOk } from './helpers.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { createChallenge, challengeStatus, verifyOwnership, PairingStore } from '../src/pairing/pairing.js';
import { WalletSession, caip2OfGenesis, GENESIS_TO_CAIP2 } from '../src/pairing/walletSession.js';
import {
  detectBrowserWallet,
  connectWallet,
  signPairingMessage,
  getSelectedChain,
  type ConcordiumWalletProvider,
} from '../src/pairing/walletConnector.js';
import { createPairingHandler } from '../src/pairing/server.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const MAINNET_GENESIS = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const fakeProvider = (over: Partial<ConcordiumWalletProvider> = {}): ConcordiumWalletProvider => ({
  requestAccounts: async () => [SENDER],
  connect: async () => SENDER,
  getMostRecentlySelectedAccount: async () => SENDER,
  getSelectedChain: async () => TESTNET_GENESIS,
  signMessage: async () => ({ '0': { '0': 'aa'.repeat(64) } }),
  ...over,
});

// ── 1. connector (official API surface) ─────────────────────────────────────

test('01. detectBrowserWallet requires signMessage and a connection entry point', () => {
  eq(detectBrowserWallet({}), null, 'no provider');
  const full = { requestAccounts: async () => [SENDER], signMessage: async () => ({}) };
  ok(detectBrowserWallet({ concordium: full }) !== null, 'provider detected');
  const legacy = { connect: async () => SENDER, signMessage: async () => ({}) };
  ok(detectBrowserWallet({ concordium: legacy }) !== null, 'legacy connect-only provider detected');
  const noSign = { requestAccounts: async () => [SENDER], connect: async () => SENDER };
  eq(detectBrowserWallet({ concordium: noSign }), null, 'signMessage is required');
});

test('02. no provider is a non-custodial failure, not a key request', async () => {
  const out = await connectWallet(null);
  eq(out.ok, false, 'no provider');
  eq((out as { reason?: string }).reason, 'no_provider', 'reason');
});

test('03. user rejection (official API rejects) maps to cancelled, not wallet_error', async () => {
  const rejecting: ConcordiumWalletProvider = {
    requestAccounts: async () => {
      throw new Error('user rejected');
    },
    signMessage: async () => ({}),
  };
  const out = await connectWallet(rejecting);
  eq(out.ok, false, 'not ok');
  eq((out as { reason?: string }).reason, 'cancelled', 'rejection is cancelled');
});

test('04. empty requestAccounts list means the user connected no account', async () => {
  const out = await connectWallet(fakeProvider({ requestAccounts: async () => [] }));
  eq(out.ok, false, 'not ok');
  eq((out as { reason?: string }).reason, 'cancelled', 'cancelled');
});

test('05. legacy connect() resolves undefined when there is no account', async () => {
  const out = await connectWallet(fakeProvider({ requestAccounts: undefined, connect: async () => undefined }));
  eq(out.ok, false, 'not ok');
  eq((out as { reason?: string }).reason, 'cancelled', 'cancelled');
});

test('06. malformed address is rejected by the session, never stored as connected', () => {
  const s = new WalletSession();
  const r = s.connect('not-an-address', CAIP2);
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'invalid_address', 'reason');
  eq(s.snapshot().state, 'failed', 'failed state');
  eq(s.snapshot().walletConnected, false, 'not connected');
});

test('07. unknown network is rejected; known Testnet/Mainnet are accepted', () => {
  const s = new WalletSession();
  eq(s.connect(SENDER, 'ccd:00000000000000000000000000000000').ok, false, 'unknown network rejected');
  eq(s.connect(SENDER, MAINNET).ok, true, 'mainnet accepted');
  const t = new WalletSession();
  eq(t.connect(SENDER, CAIP2).ok, true, 'testnet accepted');
});

test('08. connect stores the address but does NOT grant ownership', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  const snap = s.snapshot();
  eq(snap.walletConnected, true, 'connected');
  eq(snap.ownershipVerified, false, 'not verified');
  eq(snap.agentPaired, false, 'not paired');
  eq(snap.permissionGranted, false, 'no permission');
  eq(snap.txAuthorized, false, 'no authorization');
});

test('09. wallet chain selection maps to CAIP-2 and rejects cross-network pairing', () => {
  const s = new WalletSession();
  const okRes = s.connectWithChain(SENDER, TESTNET_GENESIS, CAIP2);
  eq((okRes as { ok: boolean }).ok, true, 'testnet genesis accepted');
  eq(s.snapshot().network, CAIP2, 'network stored');
  const m = new WalletSession();
  eq((m.connectWithChain(SENDER, MAINNET_GENESIS, CAIP2) as { reason?: string }).reason, 'wrong_network', 'mainnet vs testnet rejected');
  const u = new WalletSession();
  eq((u.connectWithChain(SENDER, 'deadbeef', CAIP2) as { reason?: string }).reason, 'network_unknown', 'unknown genesis rejected');
  eq(caip2OfGenesis(TESTNET_GENESIS), CAIP2, 'mapping');
  eq(caip2OfGenesis(null), null, 'null genesis');
  eq(Object.keys(GENESIS_TO_CAIP2).length, 2, 'closed mapping');
});

test('10. getSelectedChain surfaces the wallet chain; null when locked', async () => {
  const a = await getSelectedChain(fakeProvider());
  eq(a.ok, true, 'ok');
  eq((a as { genesisHash: string | null }).genesisHash, TESTNET_GENESIS, 'genesis');
  const locked = await getSelectedChain(fakeProvider({ getSelectedChain: async () => undefined }));
  eq((locked as { genesisHash: string | null }).genesisHash, null, 'null when locked');
  const none = await getSelectedChain(null);
  eq((none as { genesisHash: string | null }).genesisHash, null, 'no provider');
});

test('11. cancel resets every derived capability', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  s.cancel();
  const snap = s.snapshot();
  eq(snap.state, 'disconnected', 'disconnected');
  eq(snap.ownershipVerified, false, 'verified cleared');
  eq(snap.agentPaired, false, 'paired cleared');
});

test('12. signPairingMessage returns the wallet signature object directly', async () => {
  const sig = { '0': { '0': 'bb'.repeat(64) } };
  const out = await signPairingMessage(fakeProvider({ signMessage: async () => sig }), SENDER, 'msg');
  eq(out.ok, true, 'ok');
  eq(JSON.stringify((out as { signature: unknown }).signature), JSON.stringify(sig), 'signature verbatim');
});

test('13. signPairingMessage maps a rejection to cancelled', async () => {
  const rejecting: ConcordiumWalletProvider = {
    signMessage: async () => {
      throw new Error('rejected');
    },
  };
  const out = await signPairingMessage(rejecting, SENDER, 'msg');
  eq(out.ok, false, 'not ok');
  eq((out as { reason?: string }).reason, 'cancelled', 'cancelled');
});

// ── 2. challenge ─────────────────────────────────────────────────────────────

test('14. challenge is unique, single-use, and network-bound', () => {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c1 = store.issueChallenge('agent-1', CAIP2);
  const c2 = store.issueChallenge('agent-1', CAIP2);
  ok(c1.id !== c2.id, 'unique');
  ok(c1.message.includes('agent-1'), 'agent bound');
  ok(c1.message.includes(CAIP2), 'network bound');
  eq(challengeStatus(c1, CAIP2, 1_000_000_000).ok, true, 'valid');
  eq(challengeStatus(c1, MAINNET, 1_000_000_000).ok, false, 'wrong network');
  eq(challengeStatus(c1, CAIP2, 1_000_000_400).ok, false, 'expired');
});

async function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signer = {
    async sign(digest: ArrayBuffer) {
      const sig = sign(null, Buffer.from(digest), privateKey);
      return { 0: { 0: sig.toString('hex') } };
    },
    getSignatureCount() {
      return 1n;
    },
  };
  return { signer, accountInfo: makeFakeAccountInfo({ address: SENDER, verifyKey: rawPub }) };
}

test('15. invalid signature is rejected', async () => {
  const { accountInfo } = await makeTestKey();
  const c = createChallenge('agent-1', { network: CAIP2, now: () => 1_000_000_000_000 });
  const r = await verifyOwnership({
    walletAddress: SENDER,
    challenge: c,
    signature: { '0': { '0': 'ff'.repeat(64) } },
    accountInfo: accountInfo as never,
    network: CAIP2,
    nowSeconds: 1_000_000_000,
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'invalid_signature', 'reason');
});

// ── 3. pairing store ─────────────────────────────────────────────────────────

test('16. pairing with an untrusted (rejected) agent is refused', async () => {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c = store.issueChallenge('agent-1', CAIP2);
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: {},
    accountInfo: null,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: false, verdict: 'REJECTED', reason: 'x' }),
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'agent_rejected', 'reason');
});

test('17. pairing with no verifier fails closed', async () => {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c = store.issueChallenge('agent-1', CAIP2);
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: {},
    accountInfo: null,
    network: CAIP2,
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'untrusted_agent', 'reason');
});

test('18. expired challenge cannot pair', async () => {
  let clock = 1_000_000_000_000;
  const store = new PairingStore({ now: () => clock });
  const c = store.issueChallenge('agent-1', CAIP2, 60);
  clock += 120_000;
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: {},
    accountInfo: null,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'challenge_expired', 'reason');
});

test('19. replay of a consumed challenge is rejected', async () => {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c = store.issueChallenge('agent-1', CAIP2);
  store.consumeChallenge(c.id);
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: {},
    accountInfo: null,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(r.ok, false, 'reject');
  eq((r as { reason?: string }).reason, 'challenge_used', 'reason');
});

test('20. audit log contains no secrets and pairing can be revoked', async () => {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c = store.issueChallenge('agent-1', CAIP2);
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: { '0': { '0': 'aa'.repeat(64) } },
    accountInfo: null,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(r.ok, false, 'unpaired');
  const events = store.audit();
  ok(events.length >= 1, 'events recorded');
  const blob = JSON.stringify(events);
  notOk(/privateKey|signKey|seed|mnemonic/i.test(blob), 'no secret labels in audit');
  notOk(/"00000000000000000000000000000000"/.test(blob), 'no raw key material');
});

test('21. a successful pairing is bound to the verified address and revocable', async () => {
  const { signer, accountInfo } = await makeTestKey();
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c = store.issueChallenge('agent-1', CAIP2);
  const sig = await signMessage(AccountAddress.fromBase58(SENDER), c.message, signer as never);
  const r = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c.id,
    signature: sig,
    accountInfo: accountInfo as never,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(r.ok, true, 'paired');
  eq((r as { pairing: { state: string } }).pairing.state, 'paired', 'paired state');
  eq(store.revoke((r as { pairing: { id: string } }).pairing.id), true, 'revoke ok');
  eq(store.getPairing((r as { pairing: { id: string } }).pairing.id)?.state, 'revoked', 'revoked');
});

test('22. unauthorized reassignment of an existing agent is refused', async () => {
  const { signer, accountInfo } = await makeTestKey();
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const c1 = store.issueChallenge('agent-1', CAIP2);
  const c2 = store.issueChallenge('agent-1', CAIP2);
  const s1 = await signMessage(AccountAddress.fromBase58(SENDER), c1.message, signer as never);
  const first = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c1.id,
    signature: s1,
    accountInfo: accountInfo as never,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(first.ok, true, 'first pairing');
  const s2 = await signMessage(AccountAddress.fromBase58(SENDER), c2.message, signer as never);
  const second = await store.verifyAndPair({
    agentId: 'agent-1',
    walletAddress: SENDER,
    challengeId: c2.id,
    signature: s2,
    accountInfo: accountInfo as never,
    network: CAIP2,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  eq(second.ok, false, 'reassignment refused');
  eq((second as { reason?: string }).reason, 'already_paired', 'reason');
});

// ── 4. permission foundation ─────────────────────────────────────────────────

test('23. connecting never grants permission or transaction authorization', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  const snap = s.snapshot();
  eq(snap.permissionGranted, false, 'no permission');
  eq(snap.txAuthorized, false, 'no authorization');
  const grant = s.grantPermission(['x402:spend']);
  eq(grant.ok, false, 'grant requires pairing');
  eq((grant.reason as string), 'agent_not_paired', 'reason');
});

test('24. pairing does not imply spending permission', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  eq(s.markAgentPaired('pairing-1', 'agent-1', SENDER), true, 'paired');
  eq(s.snapshot().agentPaired, true, 'paired');
  eq(s.snapshot().permissionGranted, false, 'still no permission');
  eq(s.snapshot().txAuthorized, false, 'still no authorization');
  eq(s.authorizeTransaction().ok, false, 'cannot authorize without grant');
});

test('25. markAgentPaired refuses an address that is not the connected one', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  eq(s.markAgentPaired('pairing-1', 'agent-1', '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB'), false, 'refused');
  eq(s.snapshot().agentPaired, false, 'not paired');
});

test('26. an explicit grant is required before any authorization', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  s.markAgentPaired('pairing-1', 'agent-1', SENDER);
  eq(s.grantPermission(['x402:spend'], 60).ok, true, 'grant');
  eq(s.snapshot().permissionGranted, true, 'permission granted');
  eq(s.authorizeTransaction().ok, true, 'explicit authorization');
  eq(s.snapshot().txAuthorized, true, 'authorized');
  s.revokePermission();
  eq(s.snapshot().txAuthorized, false, 'authorization revoked');
});

test('27. unlink keeps the wallet verified but drops the pairing and permission', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  s.markAgentPaired('pairing-1', 'agent-1', SENDER);
  s.grantPermission(['x402:spend']);
  s.unlinkAgent();
  const snap = s.snapshot();
  eq(snap.walletConnected, true, 'still connected');
  eq(snap.ownershipVerified, true, 'still verified');
  eq(snap.agentPaired, false, 'pairing dropped');
  eq(snap.permissionGranted, false, 'permission dropped');
  eq(snap.txAuthorized, false, 'authorization dropped');
});

test('28. disconnect drops the address and every derived capability', () => {
  const s = new WalletSession();
  s.connect(SENDER, CAIP2);
  s.markOwnershipVerified();
  s.markAgentPaired('pairing-1', 'agent-1', SENDER);
  s.disconnect();
  const snap = s.snapshot();
  eq(snap.state, 'disconnected', 'disconnected');
  eq(snap.address, null, 'address dropped');
  eq(snap.walletConnected, false, 'not connected');
  eq(snap.ownershipVerified, false, 'not verified');
});

// ── 5. pairing server over a real loopback socket ────────────────────────────

interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

async function startServer(deps: Parameters<typeof createPairingHandler>[0]): Promise<ServerHandle> {
  const server = createServer(createPairingHandler(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function api(port: number, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

test('29. server: connect→verify→pair→unlink→disconnect over loopback', async () => {
  const { signer, accountInfo } = await makeTestKey();
  let accountInfoCalls = 0;
  const session = new WalletSession();
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  const h = await startServer({
    store,
    session,
    config: { network: CAIP2, defaultAgentId: '1004' },
    getAccountInfo: async () => {
      accountInfoCalls += 1;
      return accountInfo as never;
    },
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  try {
    const cfg = await api(h.port, '/api/config');
    eq(cfg.json.ok, true, 'config ok');
    eq(cfg.json.network, CAIP2, 'network');

    const ch = await api(h.port, '/api/challenge', { agentId: '1004' });
    eq(ch.status, 200, 'challenge status');
    eq(ch.json.ok, true, 'challenge ok');
    eq(ch.json.message.includes('agent=1004'), true, 'agent bound');

    const sig = await signMessage(AccountAddress.fromBase58(SENDER), ch.json.message, signer as never);
    const ver = await api(h.port, '/api/verify', {
      challengeId: ch.json.challengeId,
      walletAddress: SENDER,
      signature: sig,
    });
    eq(ver.status, 200, 'verify status');
    eq(ver.json.ok, true, 'verified');

    const sig2 = await signMessage(AccountAddress.fromBase58(SENDER), ch.json.message, signer as never);
    const pair = await api(h.port, '/api/pair', {
      agentId: '1004',
      challengeId: ch.json.challengeId,
      walletAddress: SENDER,
      signature: sig2,
    });
    eq(pair.status, 200, 'pair status');
    eq(pair.json.ok, true, 'paired');
    const pairingId = pair.json.pairing.id;

    const un = await api(h.port, '/api/unlink', { pairingId });
    eq(un.json.ok, true, 'unlink ok');
    eq(store.getPairing(pairingId)?.state, 'revoked', 'revoked');

    const dis = await api(h.port, '/api/disconnect', {});
    eq(dis.json.ok, true, 'disconnect ok');
    eq(session.snapshot().state, 'disconnected', 'session disconnected');
    ok(accountInfoCalls >= 2, 'account info fetched from provider, not client');
  } finally {
    await h.close();
  }
});

test('30. server: invalid address, unknown challenge, and bad input are rejected', async () => {
  const h = await startServer({
    store: new PairingStore({ now: () => 1_000_000_000_000 }),
    session: new WalletSession(),
    config: { network: CAIP2, defaultAgentId: '1004' },
    getAccountInfo: async () => null,
    verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  try {
    const badAddr = await api(h.port, '/api/verify', {
      challengeId: 'a'.repeat(64),
      walletAddress: 'not-an-address',
      signature: {},
    });
    eq(badAddr.status, 400, 'invalid address rejected');

    const unknown = await api(h.port, '/api/verify', {
      challengeId: 'b'.repeat(64),
      walletAddress: SENDER,
      signature: {},
    });
    eq(unknown.status, 404, 'unknown challenge rejected');

    const badPair = await api(h.port, '/api/pair', { agentId: 'x'.repeat(100), challengeId: 'c'.repeat(64), walletAddress: SENDER });
    eq(badPair.status, 400, 'oversized agentId rejected');

    const notFound = await api(h.port, '/api/nope');
    eq(notFound.status, 404, 'unknown route');
  } finally {
    await h.close();
  }
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} — ${(e as Error).message}`);
  }
}
console.log(`\nconnect-wallet-pairing: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
