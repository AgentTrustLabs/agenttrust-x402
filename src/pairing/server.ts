/**
 * Local pairing server (wallet connection, pairing, permissions, agent wallets, skills, x402).
 *
 * A small, local-only HTTP server that backs the Connect Wallet / Agent Pairing
 * page. It owns the pairing session, issues challenges, verifies ownership against
 * on-chain account keys, verifies the agent's CIS-8004 identity + Agent Card, and
 * records an auditable, secret-free event log.
 *
 * Boundaries:
 *   - Binds to 127.0.0.1 by default. No authentication: it is a single-user local
 *     tool and must never be exposed on a public interface.
 *   - Never constructs, signs, or broadcasts a transaction.
 *   - Never stores a private key, recovery phrase, or signature. The wallet's
 *     signature is used transiently for verification and then discarded.
 *   - Fail-closed: with no node configured, verification returns `node_unavailable`
 *     rather than a simulated success.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountInfo } from '@concordium/web-sdk';
import { AccountAddress } from '@concordium/web-sdk';
import { PairingStore, verifyOwnership, type AgentIdentityVerification } from './pairing.js';
import { createWalletChallenge } from './agenticWallet.js';
import { WalletSkills } from './walletSkills.js';
import { WalletSession } from './walletSession.js';
import type { ConcordiumWalletProvider } from './walletConnector.js';

export interface PairingServerConfig {
  /** CAIP-2 this deployment is pinned to. */
  network: string;
  /** Default agent token id offered by the page. */
  defaultAgentId: string;
  /** Host to bind. Default 127.0.0.1. */
  host?: string;
  port?: number;
  /** Root directory for the static pairing page. */
  staticRoot?: string;
  /** Full genesis hash for the configured network (TASK 73 wallet records). */
  genesisHash?: string;
}

/** Provisioning challenges issued by the wallet routes (short-lived, single-use). */
const challengeCache = new Map<string, ReturnType<typeof createWalletChallenge>>();

export interface PairingServerDeps {
  store: PairingStore;
  session: WalletSession;
  /**
   * Read-only account lookup. Return `null` when the account does not exist.
   * Throwing is a node/RPC failure and is reported as such.
   */
  getAccountInfo: (address: string) => Promise<AccountInfo | null>;
  /** CIS-8004 identity + Agent Card verification. */
  verifyAgentIdentity: (agentId: string, network: string) => Promise<AgentIdentityVerification>;
  /** TASK 72 permission manager. Optional; when absent, permission routes fail closed. */
  permissions?: import('./permissions.js').PermissionManager;
  /** TASK 73 agentic wallet manager. Optional; when absent, wallet routes fail closed. */
  walletManager?: import('./agenticWallet.js').AgenticWalletManager;
  /** TASK 74 skills layer. Optional; when absent, skills routes fail closed. */
  skills?: WalletSkills;
  /** TASK 75 x402 provider + agent-wallet client. Optional. */
  x402?: {
    provider: import('../x402/provider.js').X402Provider;
    client: import('./walletX402Client.js').AgentWalletX402Client;
  };
  config: PairingServerConfig;
}

const MAX_BODY = 8 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validAddress(address: unknown): address is string {
  if (typeof address !== 'string' || address.length < 1 || address.length > 64) return false;
  try {
    AccountAddress.fromBase58(address);
    return true;
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/** Read a JSON body with a bounded size. Returns null on malformed input. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface PairingHandlerOptions {
  /** Static file handler. Return true when it answered the request. */
  staticHandler?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

/**
 * The pairing request handler. Composed into an `http.createServer` by the wiring
 * layer so the static page and the API share one origin (no CORS, no second port).
 */
export function createPairingHandler(
  deps: PairingServerDeps,
  opts: PairingHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const api = createApiHandler(deps);
  return (req, res) => {
    if (opts.staticHandler?.(req, res)) return;
    api(req, res).catch(() => {
      // Never leak a stack trace across the boundary.
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_error' });
    });
  };
}

function createApiHandler(deps: PairingServerDeps) {
  const { store, session, config } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '/').split('?')[0]!;
    const method = req.method ?? 'GET';

    if (method === 'GET' && url === '/api/config') {
      json(res, 200, {
        ok: true,
        network: config.network,
        defaultAgentId: config.defaultAgentId,
        nodeConfigured: true,
        registryConfigured: true,
      });
      return;
    }

    if (method === 'GET' && url === '/api/status') {
      json(res, 200, { ok: true, session: session.snapshot() });
      return;
    }

    if (method === 'POST' && url === '/api/challenge') {
      const body = await readJson(req);
      const agentId = body?.['agentId'];
      if (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64) {
        json(res, 400, { ok: false, error: 'invalid agentId' });
        return;
      }
      const challenge = store.issueChallenge(agentId, config.network);
      json(res, 200, {
        ok: true,
        challengeId: challenge.id,
        message: challenge.message,
        network: challenge.network,
        expiresAt: challenge.expiresAt,
      });
      return;
    }

    if (method === 'POST' && url === '/api/verify') {
      const body = await readJson(req);
      const challengeId = body?.['challengeId'];
      const walletAddress = body?.['walletAddress'];
      if (!validId(challengeId) || !validAddress(walletAddress)) {
        json(res, 400, { ok: false, error: 'invalid challengeId or walletAddress' });
        return;
      }
      const challenge = store.getChallenge(challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const signature = body?.['signature'];
      if (signature === undefined || signature === null) {
        json(res, 400, { ok: false, error: 'missing signature' });
        return;
      }
      let accountInfo: AccountInfo | null;
      try {
        accountInfo = await deps.getAccountInfo(walletAddress);
      } catch {
        json(res, 502, { ok: false, error: 'node_unavailable' });
        return;
      }
      if (accountInfo === null) {
        json(res, 422, { ok: false, error: 'account_not_found' });
        return;
      }
      const result = await verifyOwnership({
        walletAddress,
        challenge,
        signature,
        accountInfo,
        network: config.network,
        nowSeconds: store.nowSeconds(),
      });
      if (!result.ok) {
        json(res, 422, { ok: false, error: result.reason ?? 'verification_failed' });
        return;
      }
      json(res, 200, { ok: true, verified: true });
      return;
    }

    if (method === 'POST' && url === '/api/pair') {
      const body = await readJson(req);
      const agentId = body?.['agentId'];
      const challengeId = body?.['challengeId'];
      const walletAddress = body?.['walletAddress'];
      if (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64 || !validId(challengeId) || !validAddress(walletAddress)) {
        json(res, 400, { ok: false, error: 'invalid agentId, challengeId, or walletAddress' });
        return;
      }
      let accountInfo: AccountInfo | null;
      try {
        accountInfo = await deps.getAccountInfo(walletAddress);
      } catch {
        json(res, 502, { ok: false, error: 'node_unavailable' });
        return;
      }
      const result = await store.verifyAndPair({
        agentId,
        walletAddress,
        challengeId,
        signature: body?.['signature'],
        accountInfo,
        network: config.network,
        verifyAgentIdentity: (a, n) => deps.verifyAgentIdentity(a, n),
      });
      if (!result.ok) {
        const status = result.reason === 'already_paired' || result.reason === 'agent_rejected' ? 409 : 422;
        json(res, status, { ok: false, error: result.reason });
        return;
      }
      json(res, 200, { ok: true, pairing: result.pairing });
      return;
    }

    if (method === 'POST' && url === '/api/unlink') {
      const body = await readJson(req);
      const pairingId = body?.['pairingId'];
      if (!validId(pairingId)) {
        json(res, 400, { ok: false, error: 'invalid pairingId' });
        return;
      }
      const revoked = store.revoke(pairingId);
      session.unlinkAgent();
      json(res, 200, { ok: revoked, revoked });
      return;
    }

    if (method === 'POST' && url === '/api/disconnect') {
      const walletAddress = session.snapshot().address;
      store.disconnect(session.snapshot().pairingId ?? '');
      session.disconnect();
      // TASK 72: unlinking a wallet invalidates every permission derived from it.
      if (walletAddress) deps.permissions?.invalidateWallet(walletAddress);
      json(res, 200, { ok: true, session: session.snapshot() });
      return;
    }

    // ── TASK 72: permission routes ──────────────────────────────────────
    const perms = deps.permissions;

    if (method === 'GET' && url === '/api/permission') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const wallet = new URL(req.url ?? '/', 'http://x').searchParams.get('wallet');
      const agent = new URL(req.url ?? '/', 'http://x').searchParams.get('agent');
      if (!wallet || !agent) {
        json(res, 400, { ok: false, error: 'wallet and agent query params required' });
        return;
      }
      const p = perms.getPermission(wallet, agent, config.network);
      json(res, 200, { ok: true, permission: p ? serialisePermission(p) : null, network: config.network });
      return;
    }

    if (method === 'POST' && url === '/api/permission/challenge') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const walletAddress = body?.['walletAddress'];
      const agentId = body?.['agentId'];
      if (!validAddress(walletAddress) || typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64) {
        json(res, 400, { ok: false, error: 'invalid walletAddress or agentId' });
        return;
      }
      const c = perms.issueChallenge({ walletAddress, agentId, network: config.network, action: 'grant' });
      json(res, 200, { ok: true, challengeId: c.id, message: c.message, network: c.network, expiresAt: c.expiresAt });
      return;
    }

    if (method === 'POST' && url === '/api/permission/grant') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const parsed = parseGrantInput(body);
      if (!parsed.ok) {
        json(res, 400, { ok: false, error: parsed.reason });
        return;
      }
      const accountInfo = await loadAccount(deps, parsed.walletAddress, res);
      if (accountInfo === undefined) return;
      const challenge = perms.getChallenge(parsed.challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const pairing = store.listPairings(parsed.agentId).find((p) => p.state === 'paired' && p.walletAddress === parsed.walletAddress);
      if (!pairing) {
        json(res, 422, { ok: false, error: 'agent_not_paired' });
        return;
      }
      const result = await perms.grantPermission({
        walletAddress: parsed.walletAddress,
        agentId: parsed.agentId,
        network: config.network,
        pairingId: pairing.id,
        limits: parsed.limits,
        recipientAllowlist: parsed.recipientAllowlist,
        policy: parsed.policy,
        challenge,
        signature: body?.['signature'],
        accountInfo,
      });
      if (!result.ok) {
        json(res, 422, { ok: false, error: result.reason });
        return;
      }
      json(res, 200, { ok: true, permission: serialisePermission(result.permission!) });
      return;
    }

    if (method === 'POST' && url === '/api/permission/control') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const walletAddress = body?.['walletAddress'];
      const agentId = body?.['agentId'];
      const action = body?.['action'];
      if (!validAddress(walletAddress) || typeof agentId !== 'string' || typeof action !== 'string') {
        json(res, 400, { ok: false, error: 'invalid walletAddress, agentId, or action' });
        return;
      }
      // Control actions need a fresh owner challenge: pausing is a permission change.
      const challengeId = body?.['challengeId'];
      if (!validId(challengeId)) {
        json(res, 400, { ok: false, error: 'invalid challengeId' });
        return;
      }
      const challenge = perms.getChallenge(challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const accountInfo = await loadAccount(deps, walletAddress, res);
      if (accountInfo === undefined) return;
      const owned = await verifyOwnership({
        walletAddress,
        challenge,
        signature: body?.['signature'],
        accountInfo,
        network: config.network,
        nowSeconds: perms.nowSecondsPublic(),
      });
      if (!owned.ok) {
        json(res, 403, { ok: false, error: owned.reason ?? 'invalid_signature' });
        return;
      }
      if (!perms.consumeChallenge(challengeId)) {
        json(res, 409, { ok: false, error: 'challenge_used' });
        return;
      }
      let okRes = false;
      if (action === 'pause') okRes = perms.pausePermission(walletAddress, agentId, config.network);
      else if (action === 'resume') okRes = perms.resumePermission(walletAddress, agentId, config.network);
      else if (action === 'revoke') okRes = perms.revokePermission(walletAddress, agentId, config.network);
      else {
        json(res, 400, { ok: false, error: 'unknown action' });
        return;
      }
      json(res, okRes ? 200 : 404, { ok: okRes, action });
      return;
    }

    if (method === 'GET' && url === '/api/approvals') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const wallet = q.get('wallet');
      const agent = q.get('agent');
      if (!wallet || !agent) {
        json(res, 400, { ok: false, error: 'wallet and agent query params required' });
        return;
      }
      json(res, 200, { ok: true, approvals: perms.listApprovals(wallet, agent, config.network) });
      return;
    }

    if (method === 'POST' && url === '/api/approval/request') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const walletAddress = body?.['walletAddress'];
      const agentId = body?.['agentId'];
      const recipient = body?.['recipient'];
      const amountMicroCcd = body?.['amountMicroCcd'];
      const context = body?.['context'];
      if (!validAddress(walletAddress) || typeof agentId !== 'string' || !validAddress(recipient)) {
        json(res, 400, { ok: false, error: 'invalid walletAddress, agentId, or recipient' });
        return;
      }
      if (typeof amountMicroCcd !== 'string' || !/^\d+$/.test(amountMicroCcd) || typeof context !== 'string') {
        json(res, 400, { ok: false, error: 'invalid amountMicroCcd or context' });
        return;
      }
      const approval = perms.requestApproval({ walletAddress, agentId, network: config.network, recipient, amountMicroCcd, context });
      json(res, 200, { ok: true, approval });
      return;
    }

    if (method === 'POST' && (url === '/api/approval/approve' || url === '/api/approval/reject')) {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const approvalId = body?.['approvalId'];
      const walletAddress = body?.['walletAddress'];
      const agentId = body?.['agentId'];
      const challengeId = body?.['challengeId'];
      if (!validId(approvalId) || !validAddress(walletAddress) || typeof agentId !== 'string' || !validId(challengeId)) {
        json(res, 400, { ok: false, error: 'invalid approvalId, walletAddress, agentId, or challengeId' });
        return;
      }
      const challenge = perms.getChallenge(challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const accountInfo = await loadAccount(deps, walletAddress, res);
      if (accountInfo === undefined) return;
      const approval = perms.getApproval(approvalId);
      if (!approval) {
        json(res, 404, { ok: false, error: 'unknown_approval' });
        return;
      }
      if (url === '/api/approval/approve') {
        const result = await perms.approveApproval({
          approvalId,
          walletAddress,
          agentId,
          network: config.network,
          recipient: approval.recipient,
          amountMicroCcd: approval.amountMicroCcd,
          context: approval.context,
          challenge,
          signature: body?.['signature'],
          accountInfo,
        });
        if (!result.ok) {
          json(res, 422, { ok: false, error: result.reason });
          return;
        }
        json(res, 200, { ok: true, token: result.token });
        return;
      }
      const result = await perms.rejectApproval({ approvalId, walletAddress, agentId, network: config.network, challenge, signature: body?.['signature'], accountInfo });
      json(res, result.ok ? 200 : 422, { ok: result.ok, error: result.ok ? undefined : result.reason });
      return;
    }

    if (method === 'GET' && url === '/api/activity') {
      if (!perms) {
        json(res, 503, { ok: false, error: 'permission_store_unavailable' });
        return;
      }
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const wallet = q.get('wallet');
      const limit = Number(q.get('limit') ?? '50');
      const events = perms.activity(Number.isSafeInteger(limit) && limit > 0 && limit <= 200 ? limit : 50);
      json(res, 200, { ok: true, events: wallet ? events.filter((e) => e.walletAddress === wallet) : events });
      return;
    }

    // ── TASK 73: agentic wallet routes ──────────────────────────────────
    const wallets = deps.walletManager;

    if (method === 'GET' && url === '/api/wallets') {
      if (!wallets) {
        json(res, 503, { ok: false, error: 'wallet_store_unavailable' });
        return;
      }
      const owner = new URL(req.url ?? '/', 'http://x').searchParams.get('owner');
      if (!owner) {
        json(res, 400, { ok: false, error: 'owner query param required' });
        return;
      }
      json(res, 200, { ok: true, network: config.network, wallets: wallets.listByOwner(owner).map(serialiseWallet) });
      return;
    }

    if (method === 'GET' && url === '/api/wallet') {
      if (!wallets) {
        json(res, 503, { ok: false, error: 'wallet_store_unavailable' });
        return;
      }
      const walletId = new URL(req.url ?? '/', 'http://x').searchParams.get('walletId');
      if (!walletId) {
        json(res, 400, { ok: false, error: 'walletId query param required' });
        return;
      }
      const w = wallets.get(walletId);
      if (!w) {
        json(res, 404, { ok: false, error: 'wallet_not_found' });
        return;
      }
      json(res, 200, { ok: true, wallet: serialiseWallet(w), events: wallets.events(walletId, 50) });
      return;
    }

    if (method === 'POST' && (url === '/api/wallet/challenge' || url === '/api/wallet/provision')) {
      if (!wallets) {
        json(res, 503, { ok: false, error: 'wallet_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const ownerWalletAddress = body?.['ownerWalletAddress'];
      const agentId = body?.['agentId'];
      if (!validAddress(ownerWalletAddress) || typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64) {
        json(res, 400, { ok: false, error: 'invalid ownerWalletAddress or agentId' });
        return;
      }
      if (url === '/api/wallet/challenge') {
        const c = createWalletChallenge({ ownerWalletAddress, agentId, network: config.network, action: 'provision' });
        challengeCache.set(c.id, c);
        json(res, 200, { ok: true, challengeId: c.id, message: c.message, network: c.network, expiresAt: c.expiresAt });
        return;
      }
      const challengeId = body?.['challengeId'];
      if (!validId(challengeId)) {
        json(res, 400, { ok: false, error: 'invalid challengeId' });
        return;
      }
      const challenge = challengeCache.get(challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const accountInfo = await loadAccount(deps, ownerWalletAddress, res);
      if (accountInfo === undefined) return;
      const result = await wallets.provision({
        ownerWalletAddress,
        agentId,
        network: config.network,
        genesisHash: config.genesisHash ?? '',
        pairingId: (store.listPairings(agentId).find((p) => p.state === 'paired' && p.walletAddress === ownerWalletAddress)?.id) ?? '',
        challenge,
        signature: body?.['signature'],
        accountInfo,
      });
      if (!result.ok) {
        json(res, 422, { ok: false, error: result.reason });
        return;
      }
      json(res, 200, { ok: true, created: result.created, wallet: serialiseWallet(result.wallet) });
      return;
    }

    if (method === 'POST' && url === '/api/wallet/control') {
      if (!wallets) {
        json(res, 503, { ok: false, error: 'wallet_store_unavailable' });
        return;
      }
      const body = await readJson(req);
      const walletId = body?.['walletId'];
      const ownerWalletAddress = body?.['ownerWalletAddress'];
      const action = body?.['action'];
      const challengeId = body?.['challengeId'];
      if (typeof walletId !== 'string' || !validAddress(ownerWalletAddress) || typeof action !== 'string' || !validId(challengeId)) {
        json(res, 400, { ok: false, error: 'invalid walletId, ownerWalletAddress, action, or challengeId' });
        return;
      }
      const w = wallets.get(walletId);
      if (!w) {
        json(res, 404, { ok: false, error: 'wallet_not_found' });
        return;
      }
      if (w.ownerWalletAddress !== ownerWalletAddress) {
        json(res, 403, { ok: false, error: 'owner_mismatch' });
        return;
      }
      const challenge = challengeCache.get(challengeId);
      if (!challenge) {
        json(res, 404, { ok: false, error: 'unknown challenge' });
        return;
      }
      const accountInfo = await loadAccount(deps, ownerWalletAddress, res);
      if (accountInfo === undefined) return;
      const owned = await verifyOwnership({
        walletAddress: ownerWalletAddress,
        challenge,
        signature: body?.['signature'],
        accountInfo,
        network: config.network,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!owned.ok) {
        json(res, 403, { ok: false, error: owned.reason ?? 'invalid_signature' });
        return;
      }
      challenge.used = true;
      let r: { ok: boolean; reason?: string };
      if (action === 'pause') r = wallets.pause(walletId);
      else if (action === 'resume') r = wallets.resume(walletId);
      else if (action === 'revoke') r = wallets.revoke(walletId);
      else {
        json(res, 400, { ok: false, error: 'unknown action' });
        return;
      }
      json(res, r.ok ? 200 : 422, { ok: r.ok, error: r.ok ? undefined : r.reason, wallet: serialiseWallet(wallets.get(walletId)!) });
      return;
    }

    // ── TASK 75: x402 routes ────────────────────────────────────────────
    const x402 = deps.x402;
    if (method === 'GET' && url === '/api/x402/requirement') {
      if (!x402) {
        json(res, 503, { ok: false, error: 'x402_unavailable' });
        return;
      }
      json(res, 402, { ok: true, challenge: x402.provider.challenge() });
      return;
    }

    if (method === 'POST' && url === '/api/x402/access') {
      if (!x402) {
        json(res, 503, { ok: false, error: 'x402_unavailable' });
        return;
      }
      const body = await readJson(req);
      const agentId = body?.['agentId'];
      const ownerWalletAddress = body?.['ownerWalletAddress'];
      const network = body?.['network'];
      if (typeof agentId !== 'string' || !validAddress(ownerWalletAddress) || typeof network !== 'string') {
        json(res, 400, { ok: false, error: 'invalid agentId, ownerWalletAddress, or network' });
        return;
      }
      const paired = store.listPairings(agentId).some(
        (p) => p.state === 'paired' && p.walletAddress === ownerWalletAddress && p.network === network,
      );
      if (!paired) {
        json(res, 403, { ok: false, error: 'agent_not_paired' });
        return;
      }
      const outcome = await x402.client.requestAccess(x402.provider, { agentId, ownerWalletAddress, network });
      json(res, outcome.status, { ok: outcome.status === 200, outcome });
      return;
    }

    // ── TASK 74: skills routes ───────────────────────────────────────────
    if (method === 'GET' && url === '/api/skills') {
      const skills = deps.skills;
      if (!skills) {
        json(res, 503, { ok: false, error: 'skills_unavailable' });
        return;
      }
      json(res, 200, { ok: true, manifest: skills.manifest() });
      return;
    }

    if (method === 'POST' && url === '/api/skills/invoke') {
      const skills = deps.skills;
      if (!skills) {
        json(res, 503, { ok: false, error: 'skills_unavailable' });
        return;
      }
      const body = await readJson(req);
      const agentId = body?.['agentId'];
      const ownerWalletAddress = body?.['ownerWalletAddress'];
      const network = body?.['network'];
      const skillName = body?.['skill'];
      const args = body?.['args'];
      if (typeof agentId !== 'string' || !validAddress(ownerWalletAddress) || typeof network !== 'string' || typeof skillName !== 'string') {
        json(res, 400, { ok: false, error: 'invalid agentId, ownerWalletAddress, network, or skill' });
        return;
      }
      // The trusted context is resolved server-side from the verified pairing.
      const paired = store.listPairings(agentId).some(
        (p) => p.state === 'paired' && p.walletAddress === ownerWalletAddress && p.network === network,
      );
      if (!paired) {
        json(res, 403, { ok: false, error: 'agent_not_paired' });
        return;
      }
      const result = await skills.invoke({ agentId, ownerWalletAddress, network }, skillName, args);
      json(res, result.ok ? 200 : 422, { ok: result.ok, result });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  };
}

/** Serialise a wallet record for the wire: BigInt → decimal string. */
function serialiseWallet(w: import('./walletStore.js').WalletRecord) {
  return {
    walletId: w.walletId,
    agentId: w.agentId,
    ownerWalletAddress: w.ownerWalletAddress,
    network: w.network,
    genesisHash: w.genesisHash,
    accountAddress: w.accountAddress,
    signingPublicKeyHex: w.signingPublicKeyHex,
    status: w.status,
    fundingStatus: w.fundingStatus,
    balanceMicroCcd: w.balanceMicroCcd,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/** Serialise a permission for the wire: BigInt → decimal string, Maps → counts. */
function serialisePermission(p: import('./permissions.js').AgentPermission) {
  const dayTotals: Record<string, string> = {};
  for (const [k, v] of p.dailySpent) dayTotals[k] = v.toString();
  const reservations = [...p.reservations.entries()].map(([id, r]) => ({
    id,
    amount: r.amount.toString(),
    status: r.status,
    createdAt: r.createdAt,
  }));
  return {
    agentId: p.agentId,
    walletAddress: p.walletAddress,
    network: p.network,
    pairingId: p.pairingId,
    enabled: p.enabled,
    paused: p.paused,
    revoked: p.revoked,
    policy: p.policy,
    limits: {
      perTxMicroCcd: p.limits.perTxMicroCcd === null ? null : p.limits.perTxMicroCcd.toString(),
      dailyMicroCcd: p.limits.dailyMicroCcd === null ? null : p.limits.dailyMicroCcd.toString(),
      periodMicroCcd: p.limits.periodMicroCcd === null ? null : p.limits.periodMicroCcd.toString(),
      periodSeconds: p.limits.periodSeconds,
    },
    recipientAllowlist: p.recipientAllowlist,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    dailySpent: dayTotals,
    periodSpent: p.periodSpent.toString(),
    periodStart: p.periodStart,
    reservations,
  };
}

/** Parse + validate a grant body into typed limits. */
function parseGrantInput(body: Record<string, unknown> | null):
  | { ok: true; walletAddress: string; agentId: string; challengeId: string; limits: import('./permissions.js').SpendingLimits; recipientAllowlist: string[] | null; policy: 'manual' | 'bounded_auto' }
  | { ok: false; reason: string } {
  if (!body) return { ok: false, reason: 'invalid body' };
  const walletAddress = body['walletAddress'];
  const agentId = body['agentId'];
  const challengeId = body['challengeId'];
  if (!validAddress(walletAddress)) return { ok: false, reason: 'invalid walletAddress' };
  if (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 64) return { ok: false, reason: 'invalid agentId' };
  if (!validId(challengeId)) return { ok: false, reason: 'invalid challengeId' };

  const policy = body['policy'] ?? 'manual';
  if (policy !== 'manual' && policy !== 'bounded_auto') return { ok: false, reason: 'invalid policy' };

  const limitsRaw = (body['limits'] ?? {}) as Record<string, unknown>;
  const parseLimit = (v: unknown, name: string): { ok: true; value: bigint | null } | { ok: false; reason: string } => {
    if (v === undefined || v === null) return { ok: true, value: null };
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return { ok: false, reason: `invalid limits.${name}` };
    return { ok: true, value: BigInt(v) };
  };
  const perTx = parseLimit(limitsRaw['perTxMicroCcd'], 'perTxMicroCcd');
  if (!perTx.ok) return perTx;
  const daily = parseLimit(limitsRaw['dailyMicroCcd'], 'dailyMicroCcd');
  if (!daily.ok) return daily;
  const period = parseLimit(limitsRaw['periodMicroCcd'], 'periodMicroCcd');
  if (!period.ok) return period;

  let periodSeconds: number | null = null;
  const psRaw = limitsRaw['periodSeconds'];
  if (period.value !== null) {
    if (typeof psRaw !== 'number' || !Number.isSafeInteger(psRaw) || psRaw < 60 || psRaw > 366 * 86400) {
      return { ok: false, reason: 'invalid limits.periodSeconds' };
    }
    periodSeconds = psRaw;
  }

  let recipientAllowlist: string[] | null = null;
  const alRaw = body['recipientAllowlist'];
  if (alRaw !== undefined && alRaw !== null) {
    if (!Array.isArray(alRaw) || alRaw.length > 50) return { ok: false, reason: 'invalid recipientAllowlist' };
    for (const a of alRaw) {
      if (!validAddress(a)) return { ok: false, reason: 'recipientAllowlist has an invalid address' };
    }
    recipientAllowlist = alRaw as string[];
  }

  return {
    ok: true,
    walletAddress,
    agentId,
    challengeId,
    limits: { perTxMicroCcd: perTx.value, dailyMicroCcd: daily.value, periodMicroCcd: period.value, periodSeconds },
    recipientAllowlist,
    policy,
  };
}

/** Load account info, answering 502/422 on failure. Returns undefined when answered. */
async function loadAccount(deps: PairingServerDeps, address: string, res: ServerResponse): Promise<AccountInfo | null | undefined> {
  try {
    const info = await deps.getAccountInfo(address);
    if (info === null) {
      json(res, 422, { ok: false, error: 'account_not_found' });
      return undefined;
    }
    return info;
  } catch {
    json(res, 502, { ok: false, error: 'node_unavailable' });
    return undefined;
  }
}

export type { ConcordiumWalletProvider };
