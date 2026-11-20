/**
 * Testnet Identity Issuance preparation for Wallet Context.
 * Offline only: request building, callback correlation, and structural
 * provenance checks. No HTTP, issuance, recovery, deployment, signing, or
 * broadcast. Signature verification of IdentityObjectV1 is NOT implemented.
 */
import {
  createIdentityRequest,
  type ArInfo,
  type CryptographicParameters,
  type IdObjectRequestV1,
  type IpInfo,
  type Versioned,
} from '@concordium/web-sdk';

export interface IdentityRequestInput {
  network: 'Testnet';
  seedHex: string;
  ipInfo: IpInfo;
  globalContext: CryptographicParameters;
  arsInfos: Record<string, ArInfo>;
  arThreshold: number;
  identityIndex: number;
}

export type IdentityRequestResult =
  | { ok: true; request: Versioned<IdObjectRequestV1>; binding: { ipIdentity: number; identityIndex: number; arThreshold: number; arIdentities: number[] } }
  | { ok: false; reason: string };

export function buildIdentityRequest(input: IdentityRequestInput): IdentityRequestResult {
  if (input.network !== 'Testnet') return { ok: false, reason: 'network_mismatch' };
  if (typeof input.seedHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(input.seedHex)) return { ok: false, reason: 'invalid_seed' };
  if (!Number.isSafeInteger(input.identityIndex) || input.identityIndex < 0) return { ok: false, reason: 'invalid_identity_index' };
  const ip = input.ipInfo;
  if (!ip || !Number.isSafeInteger(ip.ipIdentity) || ip.ipIdentity < 0) return { ok: false, reason: 'invalid_ip_info' };
  const arIds = Object.keys(input.arsInfos ?? {});
  if (arIds.length === 0) return { ok: false, reason: 'missing_ar_infos' };
  if (!Number.isSafeInteger(input.arThreshold) || input.arThreshold < 1 || input.arThreshold > Math.min(arIds.length, 255)) {
    return { ok: false, reason: 'invalid_ar_threshold' };
  }
  try {
    const request = createIdentityRequest({
      seed: input.seedHex,
      net: 'Testnet',
      identityIndex: input.identityIndex,
      ipInfo: ip,
      globalContext: input.globalContext,
      arsInfos: input.arsInfos,
      arThreshold: input.arThreshold,
    });
    return {
      ok: true,
      request,
      binding: { ipIdentity: ip.ipIdentity, identityIndex: input.identityIndex, arThreshold: input.arThreshold, arIdentities: arIds.map(Number).sort((a, b) => a - b) },
    };
  } catch {
    return { ok: false, reason: 'identity_request_failed' };
  }
}

export interface IssuanceSessionContext {
  network: 'Testnet';
  identityIndex: number;
  ipIdentity: number;
  ipVerifyKey: string;
  ipCdiVerifyKey: string;
  arIdentities: number[];
  arPublicKeys: Record<number, string>;
  arThreshold: number;
  globalContextHash: string;
  identityRequestHash: string;
  idCredPub: string;
}

export interface IssuanceSessionRecord {
  context: IssuanceSessionContext;
  sessionId: string;
  callbackToken: string;
  state: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  callbackOrigin: string;
  redirectUri: string;
  tabId: string | number | null;
}

export interface IssuanceControllerOptions {
  allowedCallbackOrigins: readonly string[];
  now(): number;
  randomNonce(): string;
  randomId(): string;
  sessionTtlMs?: number;
}

export type BeginResult =
  | { ok: true; sessionId: string; callbackToken: string; state: string; redirectUri: string; expiresAt: number }
  | { ok: false; reason: string };

export type CallbackResult =
  | { ok: true; sessionId: string; codeUri: string }
  | { ok: false; reason: string };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function validateContext(context: IssuanceSessionContext): string | null {
  if (!context || context.network !== 'Testnet') return 'network_mismatch';
  if (!Number.isSafeInteger(context.identityIndex) || context.identityIndex < 0) return 'invalid_identity_index';
  if (!Number.isSafeInteger(context.ipIdentity) || context.ipIdentity < 0) return 'invalid_ip_identity';
  if (typeof context.ipVerifyKey !== 'string' || context.ipVerifyKey.length === 0) return 'invalid_ip_verify_key';
  if (typeof context.ipCdiVerifyKey !== 'string' || context.ipCdiVerifyKey.length === 0) return 'invalid_ip_cdi_verify_key';
  const arIds = Array.isArray(context.arIdentities) ? context.arIdentities : [];
  if (arIds.length === 0 || arIds.some((n) => !Number.isSafeInteger(n) || n < 0)) return 'invalid_ar_identities';
  if (new Set(arIds).size !== arIds.length) return 'duplicate_ar_identity';
  if (!Number.isSafeInteger(context.arThreshold) || context.arThreshold < 1 || context.arThreshold > Math.min(arIds.length, 255)) return 'invalid_ar_threshold';
  if (!context.arPublicKeys || typeof context.arPublicKeys !== 'object') return 'invalid_ar_public_keys';
  for (const id of arIds) if (typeof context.arPublicKeys[id] !== 'string' || context.arPublicKeys[id].length === 0) return 'missing_ar_public_key';
  if (typeof context.globalContextHash !== 'string' || context.globalContextHash.length === 0) return 'invalid_global_context_hash';
  if (typeof context.identityRequestHash !== 'string' || context.identityRequestHash.length === 0) return 'invalid_identity_request_hash';
  if (typeof context.idCredPub !== 'string' || context.idCredPub.length === 0) return 'invalid_id_cred_pub';
  return null;
}

export function createIssuanceController(opts: IssuanceControllerOptions) {
  const allowed = new Set(opts.allowedCallbackOrigins);
  const sessions = new Map<string, IssuanceSessionRecord>();
  const ttl = opts.sessionTtlMs ?? 10 * 60_000;

  const begin = (context: IssuanceSessionContext, callbackOrigin: string, tabId: string | number | null = null): BeginResult => {
    if (!allowed.has(callbackOrigin)) return { ok: false, reason: 'callback_origin_not_allowed' };
    const invalid = validateContext(context);
    if (invalid) return { ok: false, reason: invalid };
    const callbackToken = opts.randomId();
    const state = opts.randomId();
    const now = opts.now();
    const frozenContext: IssuanceSessionContext = deepFreeze({
      ...context,
      arIdentities: [...context.arIdentities].sort((a, b) => a - b),
      arPublicKeys: { ...context.arPublicKeys },
    });
    const record: IssuanceSessionRecord = {
      context: frozenContext,
      sessionId: opts.randomId(),
      callbackToken,
      state,
      createdAt: now,
      expiresAt: now + ttl,
      used: false,
      callbackOrigin,
      redirectUri: `${callbackOrigin.replace(/\/$/, '')}/identity/callback/${callbackToken}`,
      tabId,
    };
    sessions.set(record.sessionId, record);
    return { ok: true, sessionId: record.sessionId, callbackToken, state, redirectUri: record.redirectUri, expiresAt: record.expiresAt };
  };

  const getContext = (sessionId: string): IssuanceSessionContext | null => {
    const s = sessions.get(sessionId);
    if (!s) return null;
    const c = s.context;
    return deepFreeze({ ...c, arIdentities: [...c.arIdentities], arPublicKeys: { ...c.arPublicKeys } });
  };

  const handleCallback = (event: { origin: string; url: string; tabId?: string | number | null }): CallbackResult => {
    if (!allowed.has(event.origin)) return { ok: false, reason: 'callback_origin_not_allowed' };
    let url: URL;
    try { url = new URL(event.url); }
    catch { return { ok: false, reason: 'malformed_callback_url' }; }
    if (url.origin !== event.origin) return { ok: false, reason: 'origin_mismatch' };
    const state = url.searchParams.get('state');
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const codeUri = new URLSearchParams(hash).get('code_uri');
    if (!codeUri) return { ok: false, reason: 'missing_code_uri' };
    let found: IssuanceSessionRecord | undefined;
    for (const s of sessions.values()) {
      const token = url.pathname.split('/').filter(Boolean).pop();
      if (token === s.callbackToken && url.origin === new URL(s.redirectUri).origin && url.pathname === new URL(s.redirectUri).pathname) { found = s; break; }
    }
    if (!found) return { ok: false, reason: 'callback_token_mismatch' };
    if (state !== null && state !== found.state) return { ok: false, reason: 'state_mismatch' };
    if (found.tabId !== null && event.tabId !== undefined && event.tabId !== found.tabId) return { ok: false, reason: 'tab_mismatch' };
    if (found.used) return { ok: false, reason: 'callback_replayed' };
    if (opts.now() > found.expiresAt) return { ok: false, reason: 'session_expired' };
    found.used = true;
    return { ok: true, sessionId: found.sessionId, codeUri };
  };

  const getSessionByCallbackToken = (token: string): IssuanceSessionRecord | null => {
    for (const s of sessions.values()) if (s.callbackToken === token) return s;
    return null;
  };

  const invalidate = (sessionId: string): void => { sessions.delete(sessionId); };
  const invalidateAll = (): void => { sessions.clear(); };
  return { begin, handleCallback, getContext, getSessionByCallbackToken, invalidate, invalidateAll, get sessionCount(): number { return sessions.size; } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateIdentityObjectStructure(io: unknown): { ok: true; identityObject: Record<string, unknown> } | { ok: false; reason: string } {
  if (!isRecord(io)) return { ok: false, reason: 'invalid_identity_object' };
  const pre = io['preIdentityObject'];
  if (!isRecord(pre) || typeof pre['idCredPub'] !== 'string' || typeof pre['idCredSecCommitment'] !== 'string'
    || typeof pre['prfKeyCommitmentWithIP'] !== 'string' || typeof pre['proofsOfKnowledge'] !== 'string'
    || !Array.isArray(pre['prfKeySharingCoeffCommitments']) || !isRecord(pre['choiceArData'])
    || !Array.isArray(pre['choiceArData']['arIdentities']) || !Number.isInteger(pre['choiceArData']['threshold'])
    || !Number.isInteger(pre['choiceArData']['threshold']) || (pre['choiceArData']['threshold'] as number) < 1
    || (pre['choiceArData']['threshold'] as number) > (pre['choiceArData']['arIdentities'] as unknown[]).length) {
    return { ok: false, reason: 'invalid_pre_identity_object' };
  }
  const arData = pre['ipArData'];
  if (!isRecord(arData)) return { ok: false, reason: 'invalid_ip_ar_data' };
  const arIds = pre['choiceArData']['arIdentities'] as number[];
  if (new Set(arIds).size !== arIds.length) return { ok: false, reason: 'duplicate_ar_identity' };
  if (Object.keys(arData).length !== arIds.length) return { ok: false, reason: 'ip_ar_data_mismatch' };
  for (const id of arIds) {
    const entry = arData[String(id)];
    if (!isRecord(entry) || typeof entry['encPrfKeyShare'] !== 'string' || typeof entry['proofComEncEq'] !== 'string') return { ok: false, reason: 'invalid_ip_ar_entry' };
  }
  const alist = io['attributeList'];
  if (!isRecord(alist) || typeof alist['validTo'] !== 'string' || typeof alist['createdAt'] !== 'string'
    || !isRecord(alist['chosenAttributes']) || !Number.isInteger(alist['maxAccounts']) || (alist['maxAccounts'] as number) < 1) {
    return { ok: false, reason: 'invalid_attribute_list' };
  }
  if (typeof io['signature'] !== 'string' || io['signature'].length === 0) return { ok: false, reason: 'invalid_signature' };
  return { ok: true, identityObject: io };
}

/** Parse IdentityTokenContainer; only status=done is accepted. */
export function parseIdentityTokenContainer(input: unknown):
  | { ok: true; identityObject: Record<string, unknown>; version: number }
  | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: 'invalid_container' };
  const status = input['status'];
  if (status === 'pending') return { ok: false, reason: 'issuance_pending' };
  if (status === 'error') return { ok: false, reason: 'issuance_error' };
  if (status !== 'done') return { ok: false, reason: 'invalid_status' };
  const token = input['token'];
  if (!isRecord(token)) return { ok: false, reason: 'missing_token' };
  const versioned = token['identityObject'];
  if (!isRecord(versioned)) return { ok: false, reason: 'missing_identity_object' };
  if (!Number.isInteger(versioned['v']) || (versioned['v'] as number) < 0) return { ok: false, reason: 'invalid_identity_version' };
  const io = versioned['value'];
  const structure = validateIdentityObjectStructure(io);
  if (!structure.ok) return { ok: false, reason: structure.reason };
  return { ok: true, identityObject: structure.identityObject, version: versioned['v'] as number };
}

export type ProvenanceResult =
  | { ok: true; status: 'STRUCTURAL PROVENANCE VERIFIED — SIGNATURE NOT VERIFIED' }
  | { ok: false; reason: string };

/** Structural/context binding only. Does NOT verify the IP signature. */
export function verifyProvenance(identityObject: unknown, context: IssuanceSessionContext): ProvenanceResult {
  if (!context || context.network !== 'Testnet') return { ok: false, reason: 'network_mismatch' };
  const structure = validateIdentityObjectStructure(identityObject);
  if (!structure.ok) return { ok: false, reason: structure.reason };
  const io = structure.identityObject;
  const pre = io['preIdentityObject'] as Record<string, unknown>;
  if (typeof pre['idCredPub'] !== 'string' || pre['idCredPub'] !== context.idCredPub) return { ok: false, reason: 'id_cred_pub_mismatch' };
  const arIds = (pre['choiceArData'] as Record<string, unknown>)['arIdentities'] as number[];
  const threshold = (pre['choiceArData'] as Record<string, unknown>)['threshold'] as number;
  const ctxAr = [...context.arIdentities].sort((a, b) => a - b);
  if (JSON.stringify([...arIds].sort((a, b) => a - b)) !== JSON.stringify(ctxAr)) return { ok: false, reason: 'ar_identity_mismatch' };
  if (threshold !== context.arThreshold) return { ok: false, reason: 'ar_threshold_mismatch' };
  const arData = pre['ipArData'] as Record<string, unknown>;
  for (const id of ctxAr) {
    const entry = arData[String(id)];
    if (!isRecord(entry)) return { ok: false, reason: 'missing_ip_ar_entry' };
  }
  // IP keys/global context are trusted at session creation; binding to the
  // object itself is limited to AR/idCredPub without signature verification.
  if (typeof context.ipVerifyKey !== 'string' || context.ipVerifyKey.length === 0) return { ok: false, reason: 'invalid_ip_context' };
  if (typeof context.globalContextHash !== 'string' || context.globalContextHash.length === 0) return { ok: false, reason: 'invalid_global_context' };
  return { ok: true, status: 'STRUCTURAL PROVENANCE VERIFIED — SIGNATURE NOT VERIFIED' };
}
