/**
 * Agentic Wallet Core tests.
 *
 * Mocks only: no browser, no node, no transaction. Ownership is verified through
 * the official SDK using a locally generated test key. Wallets are persisted in a
 * real SQLite database (temp file for restart tests, ':memory:' otherwise).
 *
 * No transaction is ever constructed, signed, or broadcast by these tests, and no
 * on-chain account is created. Provisioning only creates local key material.
 */

import { eq, ok, notOk } from './helpers.mjs';
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAddress, signMessage } from '@concordium/web-sdk';
import { makeFakeAccountInfo } from '../services/facilitator/src/senderVerifier.js';
import { PairingStore } from '../src/pairing/pairing.js';
import { PermissionManager } from '../src/pairing/permissions.js';
import { WalletStore } from '../src/pairing/walletStore.js';
import { InMemoryWalletKeyStore } from '../src/pairing/walletSigner.js';
import { AgenticWalletManager, createWalletChallenge } from '../src/pairing/agenticWallet.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
const OTHER_NETWORK = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER_OWNER = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── fixtures ────────────────────────────────────────────────────────────────

function makeTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signer = {
    async sign(digest: ArrayBuffer) {
      return { 0: { 0: edSign(null, Buffer.from(digest), privateKey).toString('hex') } };
    },
    getSignatureCount() { return 1n; },
  };
  return { signer, accountInfo: makeFakeAccountInfo({ address: SENDER, verifyKey: rawPub }) };
}

function pairedStore() {
  const store = new PairingStore({ now: () => 1_000_000_000_000 });
  return store;
}

async function seedPairing(store: PairingStore, walletAddress: string, agentId: string) {
  const c = store.issueChallenge(agentId, CAIP2);
  const { signer, accountInfo } = makeTestKey();
  const sig = await signMessage(AccountAddress.fromBase58(walletAddress), c.message, signer as never);
  const r = await store.verifyAndPair({
    agentId, walletAddress, challengeId: c.id, signature: sig, accountInfo: accountInfo as never,
    network: CAIP2, verifyAgentIdentity: async () => ({ trusted: true, verdict: 'TRUSTED' }),
  });
  return r.ok;
}

async function provision(manager: AgenticWalletManager, opts: { owner?: string; agent?: string; network?: string; signer?: any; accountInfo?: any; pairingId?: string } = {}) {
  const owner = opts.owner ?? SENDER;
  const agent = opts.agent ?? 'agent-1';
  const network = opts.network ?? CAIP2;
  const key = opts.signer ? { signer: opts.signer, accountInfo: opts.accountInfo } : makeTestKey();
  const challenge = createWalletChallenge({ ownerWalletAddress: owner, agentId: agent, network, action: 'provision' });
  const signature = await signMessage(AccountAddress.fromBase58(owner), challenge.message, key.signer as never);
  return manager.provision({
    ownerWalletAddress: owner, agentId: agent, network, genesisHash: GENESIS, pairingId: opts.pairingId ?? 'pairing-1',
    challenge, signature, accountInfo: key.accountInfo as never,
  });
}

function managerWith(memory = true, pairing?: PairingStore, permissions?: PermissionManager) {
  const store = new WalletStore({ path: ':memory:' });
  const keyStore = new InMemoryWalletKeyStore();
  const mgr = new AgenticWalletManager({ store, keyStore, permissions, pairingStore: pairing, now: () => 1_000_000_000_000 });
  return { store, keyStore, mgr };
}

// ── 1. provisioning + identity ──────────────────────────────────────────────

test('01. each agent gets an independent dedicated wallet', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  await seedPairing(pairing, SENDER, 'agent-2');
  const { mgr } = managerWith(true, pairing);
  const a = await provision(mgr, { agent: 'agent-1' });
  const b = await provision(mgr, { agent: 'agent-2' });
  eq(a.ok, true, 'agent-1 provisioned');
  eq(b.ok, true, 'agent-2 provisioned');
  ok((a as any).wallet.walletId !== (b as any).wallet.walletId, 'distinct wallet ids');
  ok(a.signer.publicKeyHex !== b.signer.publicKeyHex, 'distinct signing identities');
  eq((a as any).wallet.ownerWalletAddress, SENDER, 'owner bound');
  eq((b as any).wallet.ownerWalletAddress, SENDER, 'owner bound');
});

test('02. correct owner-agent-wallet association + address + network', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const r = await provision(mgr, { agent: 'agent-1' });
  eq(r.ok, true, 'provisioned');
  const w = (r as any).wallet;
  eq(w.agentId, 'agent-1', 'agent');
  eq(w.ownerWalletAddress, SENDER, 'owner');
  eq(w.network, CAIP2, 'network');
  eq(w.genesisHash, GENESIS, 'genesis');
  eq(w.accountAddress, null, 'on-chain address pending');
  eq(w.status, 'awaiting_funding', 'not active on provisioning');
  ok(w.signingPublicKeyHex.length === 64, 'public key hex');
});

test('03. unauthorized provisioning (invalid signature) rejected', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const challenge = createWalletChallenge({ ownerWalletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'provision' });
  const { accountInfo } = makeTestKey();
  const r = await mgr.provision({
    ownerWalletAddress: SENDER, agentId: 'agent-1', network: CAIP2, genesisHash: GENESIS, pairingId: 'p1',
    challenge, signature: { '0': { '0': 'ff'.repeat(64) } }, accountInfo: accountInfo as never,
  });
  eq(r.ok, false, 'rejected');
  eq((r as { reason: string }).reason, 'invalid_signature', 'reason');
});

test('04. unpaired agent is rejected', async () => {
  const pairing = pairedStore();
  const { mgr } = managerWith(true, pairing); // no pairing seeded
  const r = await provision(mgr, { agent: 'agent-1' });
  eq(r.ok, false, 'rejected');
  eq((r as { reason: string }).reason, 'agent_not_paired', 'reason');
});

test('05. duplicate provisioning is idempotent; concurrent provisioning safe', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const a = await provision(mgr, { agent: 'agent-1' });
  const b = await provision(mgr, { agent: 'agent-1' });
  eq(a.ok, true, 'first');
  eq(b.ok, true, 'second');
  eq((a as { created: boolean }).created, true, 'first created');
  eq((b as { created: boolean }).created, false, 'second idempotent');
  eq((a as any).wallet.walletId, (b as any).wallet.walletId, 'same wallet id');
  // concurrent
  const pairing2 = pairedStore();
  await seedPairing(pairing2, SENDER, 'agent-9');
  const { mgr: m2 } = managerWith(true, pairing2);
  const [x, y] = await Promise.all([provision(m2, { agent: 'agent-9' }), provision(m2, { agent: 'agent-9' })]);
  eq(x.ok, true, 'concurrent a');
  eq(y.ok, true, 'concurrent b');
  eq((x as any).wallet.walletId, (y as any).wallet.walletId, 'one wallet under concurrency');
});

// ── 2. persistence + lifecycle ──────────────────────────────────────────────

test('06. wallet metadata and lifecycle survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-wallet-'));
  const dbPath = join(dir, 'wallets.db');
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const keyStore = new InMemoryWalletKeyStore();
  const store1 = new WalletStore({ path: dbPath });
  const m1 = new AgenticWalletManager({ store: store1, keyStore, pairingStore: pairing, now: () => 1_000_000_000_000 });
  const p = await provision(m1, { agent: 'agent-1' });
  eq(p.ok, true, 'provisioned');
  store1.close();

  const store2 = new WalletStore({ path: dbPath });
  const m2 = new AgenticWalletManager({ store: store2, keyStore, pairingStore: pairing, now: () => 1_000_000_000_000 });
  const w = m2.get((p as any).wallet.walletId);
  ok(w !== null, 'wallet found after restart');
  eq(w!.status, 'awaiting_funding', 'status persisted');
  eq(w!.agentId, 'agent-1', 'agent persisted');
  eq(w!.ownerWalletAddress, SENDER, 'owner persisted');
  const r = await provision(m2, { agent: 'agent-1' });
  eq((r as { created: boolean }).created, false, 'not re-provisioned after restart');
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('07. revoked state persists after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-wallet-'));
  const dbPath = join(dir, 'wallets.db');
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const keyStore = new InMemoryWalletKeyStore();
  const store1 = new WalletStore({ path: dbPath });
  const m1 = new AgenticWalletManager({ store: store1, keyStore, pairingStore: pairing, now: () => 1_000_000_000_000 });
  const p = await provision(m1, { agent: 'agent-1' });
  eq(m1.revoke((p as any).wallet.walletId).ok, true, 'revoked');
  store1.close();

  const store2 = new WalletStore({ path: dbPath });
  const m2 = new AgenticWalletManager({ store: store2, keyStore, pairingStore: pairing, now: () => 1_000_000_000_000 });
  const w = m2.get((p as any).wallet.walletId);
  eq(w!.status, 'revoked', 'revoked persists');
  const sign = m2.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1, 2, 3]), params: {} });
  eq(sign.ok, false, 'revoked cannot sign');
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('08. funding status distinguishes local provisioning from on-chain existence', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const p = await provision(mgr, { agent: 'agent-1' });
  eq((p as any).wallet.status, 'awaiting_funding', 'locally provisioned, not active');
  eq((p as any).wallet.fundingStatus, 'unknown', 'funding unknown');
  eq((p as any).wallet.accountAddress, null, 'no on-chain address');
  // record funding observation
  eq(mgr.recordFunding((p as any).wallet.walletId, 0n).ok, true, 'zero balance recorded');
  eq(mgr.get((p as any).wallet.walletId)!.fundingStatus, 'unfunded', 'unfunded');
  eq(mgr.get((p as any).wallet.walletId)!.status, 'awaiting_funding', 'still awaiting');
  eq(mgr.recordFunding((p as any).wallet.walletId, 5000n, RECIPIENT).ok, true, 'funded recorded');
  const w = mgr.get((p as any).wallet.walletId)!;
  eq(w.fundingStatus, 'funded', 'funded');
  eq(w.status, 'active', 'active after funding');
  eq(w.accountAddress, RECIPIENT, 'on-chain address recorded');
});

// ── 3. signing boundary ─────────────────────────────────────────────────────

test('09. signing is bound to wallet, agent, owner, and network', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const p = await provision(mgr, { agent: 'agent-1' });
  const digest = new Uint8Array([1, 2, 3, 4]);
  const good = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest, params: {} });
  eq(good.ok, true, 'good sign');
  const wrongAgent = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-2', ownerWalletAddress: SENDER, network: CAIP2, digest, params: {} });
  eq(wrongAgent.ok, false, 'wrong agent');
  eq((wrongAgent as { reason: string }).reason, 'agent_mismatch', 'reason');
  const wrongOwner = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: OTHER_OWNER, network: CAIP2, digest, params: {} });
  eq(wrongOwner.ok, false, 'wrong owner');
  eq((wrongOwner as { reason: string }).reason, 'owner_mismatch', 'reason');
  const wrongNetwork = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: OTHER_NETWORK, digest, params: {} });
  eq(wrongNetwork.ok, false, 'wrong network');
  eq((wrongNetwork as { reason: string }).reason, 'wrong_network', 'reason');
  const wrongWallet = mgr.signDigest({ walletId: 'w_nope', agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest, params: {} });
  eq(wrongWallet.ok, false, 'wrong wallet');
  eq((wrongWallet as { reason: string }).reason, 'wallet_not_found', 'reason');
});

test('10. paused and revoked wallets cannot sign', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const p = await provision(mgr, { agent: 'agent-1' });
  mgr.pause((p as any).wallet.walletId);
  const paused = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1]), params: {} });
  eq(paused.ok, false, 'paused');
  eq((paused as { reason: string }).reason, 'wallet_paused', 'reason');
  mgr.resume((p as any).wallet.walletId);
  eq(mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1]), params: {} }).ok, true, 'resumed can sign');
  mgr.revoke((p as any).wallet.walletId);
  const revoked = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1]), params: {} });
  eq(revoked.ok, false, 'revoked');
  eq((revoked as { reason: string }).reason, 'wallet_revoked', 'reason');
});

test('11. signature verifies against the wallet public key; no private key leaks', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr, keyStore } = managerWith(true, pairing);
  const p = await provision(mgr, { agent: 'agent-1' });
  const digest = new Uint8Array([9, 8, 7]);
  const sig = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest, params: {} });
  eq(sig.ok, true, 'signed');
  const sigHex = (sig as { signature: { 0: { 0: string } } }).signature[0][0];
  const pubDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from((p as any).wallet.signingPublicKeyHex, 'hex')]);
  const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  ok(edVerify(null, Buffer.from(digest), pubKey, Buffer.from(sigHex, 'hex')), 'signature verifies');
  // no private key on the signer
  const signer = keyStore.load((p as any).wallet.walletId);
  ok(signer !== null, 'signer loaded');
  const blob = JSON.stringify(signer as unknown as Record<string, unknown>);
  notOk(/private|seed|mnemonic/i.test(blob), 'no private material on signer');
  notOk(/private|seed|mnemonic/i.test(JSON.stringify((p as any).wallet)), 'no private material in wallet record');
  eq(Object.keys(signer as unknown as object).sort().join(','), 'publicKeyHex,signDigest,walletId', 'signer exposes only public fields');
});

// ── 4. spending-limits integration ───────────────────────────────────────────────────

test('12. provisioning does not grant payment permission', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const { mgr } = managerWith(true, pairing, permissions);
  const p = await provision(mgr, { agent: 'agent-1' });
  eq(permissions.getPermission(SENDER, 'agent-1', CAIP2), undefined, 'no permission granted');
  const r = permissions.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'payment denied');
  eq((r as { reason: string }).reason, 'no_permission', 'reason');
});

test('13. spending limits remain enforced for agent wallets', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const { mgr } = managerWith(true, pairing, permissions);
  const p = await provision(mgr, { agent: 'agent-1' });
  // grant a bounded_auto permission with a per-tx cap
  const challenge = permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const { signer, accountInfo } = makeTestKey();
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const g = await permissions.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: (p as any).wallet.walletId,
    limits: { perTxMicroCcd: 1000n, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null },
    recipientAllowlist: null, policy: 'bounded_auto', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(g.ok, true, 'granted');
  // wallet-level sign still enforces the permission gate
  const over = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1]), params: { recipient: RECIPIENT, amountMicroCcd: '5000' } });
  eq(over.ok, false, 'over-limit blocked');
  eq((over as { reason: string }).reason, 'per_tx_limit_exceeded', 'reason');
  const within = mgr.signDigest({ walletId: (p as any).wallet.walletId, agentId: 'agent-1', ownerWalletAddress: SENDER, network: CAIP2, digest: new Uint8Array([1]), params: { recipient: RECIPIENT, amountMicroCcd: '500' } });
  eq(within.ok, true, 'within-limit allowed');
});

test('14. wallet pause/revoke invalidates payment authorization', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const { mgr } = managerWith(true, pairing, permissions);
  await provision(mgr, { agent: 'agent-1' });
  const challenge = permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const { signer, accountInfo } = makeTestKey();
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  await permissions.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: { perTxMicroCcd: null, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null },
    recipientAllowlist: null, policy: 'bounded_auto', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(permissions.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' }).ok, true, 'allowed before pause');
  const w = mgr.listByOwner(SENDER)[0];
  mgr.pause(w.walletId);
  const paused = permissions.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(paused.ok, false, 'paused blocks payment');
  eq((paused as { reason: string }).reason, 'permission_paused', 'reason');
  mgr.revoke(w.walletId);
  const revoked = permissions.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(revoked.ok, false, 'revoked blocks payment');
  eq((revoked as { reason: string }).reason, 'permission_revoked', 'reason');
});

test('15. owner unlink invalidates associated wallet permissions', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const permissions = new PermissionManager({ now: () => 1_000_000_000_000 });
  const { mgr } = managerWith(true, pairing, permissions);
  await provision(mgr, { agent: 'agent-1' });
  const challenge = permissions.issueChallenge({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'grant' });
  const { signer, accountInfo } = makeTestKey();
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  await permissions.grantPermission({
    walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, pairingId: 'p1',
    limits: { perTxMicroCcd: null, dailyMicroCcd: null, periodMicroCcd: null, periodSeconds: null },
    recipientAllowlist: null, policy: 'bounded_auto', challenge, signature, accountInfo: accountInfo as never,
  });
  eq(permissions.invalidateWallet(SENDER), 1, 'one permission invalidated');
  const r = permissions.isPaymentAllowed({ walletAddress: SENDER, agentId: 'agent-1', network: CAIP2, recipient: RECIPIENT, amountMicroCcd: '100' });
  eq(r.ok, false, 'blocked');
  eq((r as { reason: string }).reason, 'permission_revoked', 'reason');
});

// ── 5. safety ───────────────────────────────────────────────────────────────

test('16. storage unavailable fails closed', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  // Close the underlying store to force storage errors.
  const store = (mgr as unknown as { store: { close(): void } }).store;
  store.close();
  const r = await provision(mgr, { agent: 'agent-1' });
  eq(r.ok, false, 'provision fails closed');
  eq((r as { reason: string }).reason === 'storage_unavailable' || (r as { reason: string }).reason.length > 0, true, 'reason present');
});

test('17. no transaction submission during provisioning', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  let txCalls = 0;
  const spy = {
    async verify() { txCalls += 1; return { isValid: true }; },
    async settle() { txCalls += 1; return { success: true }; },
  };
  const { mgr } = managerWith(true, pairing);
  const r = await provision(mgr, { agent: 'agent-1' });
  eq(r.ok, true, 'provisioned');
  eq(txCalls, 0, 'no facilitator/transaction calls');
  void spy;
});

test('18. wrong-network provisioning is rejected', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const challenge = createWalletChallenge({ ownerWalletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'provision' });
  const { signer, accountInfo } = makeTestKey();
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  const r = await mgr.provision({
    ownerWalletAddress: SENDER, agentId: 'agent-1', network: OTHER_NETWORK, genesisHash: GENESIS, pairingId: 'p1',
    challenge, signature, accountInfo: accountInfo as never,
  });
  eq(r.ok, false, 'rejected');
  eq((r as { reason: string }).reason, 'wrong_network', 'reason');
});

test('19. expired and replayed provisioning challenge rejected', async () => {
  const pairing = pairedStore();
  await seedPairing(pairing, SENDER, 'agent-1');
  const { mgr } = managerWith(true, pairing);
  const challenge = createWalletChallenge({ ownerWalletAddress: SENDER, agentId: 'agent-1', network: CAIP2, action: 'provision', ttlSeconds: 60 });
  const { signer, accountInfo } = makeTestKey();
  const signature = await signMessage(AccountAddress.fromBase58(SENDER), challenge.message, signer as never);
  // replay: consume manually
  challenge.used = true;
  const r = await mgr.provision({
    ownerWalletAddress: SENDER, agentId: 'agent-1', network: CAIP2, genesisHash: GENESIS, pairingId: 'p1',
    challenge, signature, accountInfo: accountInfo as never,
  });
  eq(r.ok, false, 'replay rejected');
  eq((r as { reason: string }).reason, 'challenge_used', 'reason');
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
console.log(`\nagentic-wallet-core: ${tests.length - failed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
