/**
 * Internal issuance bridge: Vault v2 seed (operation-scoped), issuance
 * controller, callback/result handling. No HTTP, no IDP, no storage of
 * IdentityObject, no credential deployment.
 */
import {
  buildIdentityRequest, createIssuanceController, parseIdentityTokenContainer, verifyProvenance,
  type IssuanceControllerOptions, type IssuanceSessionContext,
} from './identityIssuance.js';
import type { ArInfo, CryptographicParameters, IpInfo } from '@concordium/web-sdk';

export interface IssuanceParams {
  ipInfo: IpInfo;
  globalContext: CryptographicParameters;
  arsInfos: Record<string, ArInfo>;
  arThreshold: number;
  identityIndex: number;
}

export interface IssuanceBridgeOptions {
  vault: {
    status(): { state: 'locked' | 'unlocked' };
    withSeed<T>(operation: (seedHex: string) => T | Promise<T>): Promise<T>;
  };
  callbackOrigin: string;
  params: IssuanceParams;
  controller?: ReturnType<typeof createIssuanceController>;
  controllerOptions?: Omit<IssuanceControllerOptions, 'allowedCallbackOrigins'>;
  openPopup?: (url: string) => unknown | null;
  crypto?: Crypto;
}

async function sha256Hex(text: string, crypto?: Crypto): Promise<string> {
  const subtle = crypto?.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new Error('webcrypto_unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createIssuanceBridge(opts: IssuanceBridgeOptions) {
  const controller = opts.controller ?? createIssuanceController({
    allowedCallbackOrigins: [opts.callbackOrigin],
    ...(opts.controllerOptions ?? { now: () => Date.now(), randomNonce: () => cryptoRandom(32), randomId: () => cryptoRandom(32) }),
  });

  const prepareIssuance = async (tabId: string | number | null = null) => {
    return opts.vault.withSeed(async (seedHex) => {
      const req = buildIdentityRequest({
        network: 'Testnet', seedHex,
        ipInfo: opts.params.ipInfo, globalContext: opts.params.globalContext,
        arsInfos: opts.params.arsInfos, arThreshold: opts.params.arThreshold,
        identityIndex: opts.params.identityIndex,
      });
      if (!req.ok) return { ok: false as const, reason: req.reason };
      const arIds = Object.keys(opts.params.arsInfos).map(Number).sort((a, b) => a - b);
      const context: IssuanceSessionContext = {
        network: 'Testnet',
        identityIndex: opts.params.identityIndex,
        ipIdentity: opts.params.ipInfo.ipIdentity,
        ipVerifyKey: opts.params.ipInfo.ipVerifyKey,
        ipCdiVerifyKey: opts.params.ipInfo.ipCdiVerifyKey,
        arIdentities: arIds,
        arPublicKeys: Object.fromEntries(arIds.map((id) => [id, (opts.params.arsInfos[String(id)] as ArInfo).arPublicKey])),
        arThreshold: opts.params.arThreshold,
        globalContextHash: await sha256Hex(JSON.stringify(opts.params.globalContext), opts.crypto),
        identityRequestHash: await sha256Hex(JSON.stringify(req.request), opts.crypto),
        idCredPub: String(req.request.value.idCredPub),
      };
      return controller.begin(context, opts.callbackOrigin, tabId);
    });
  };

  const handleCallback = (event: { origin: string; url: string; tabId?: string | number | null }) => controller.handleCallback(event);

  /** Internal channel from the callback page; parent website is never accepted. */
  const boundSources = new Map<string, { source: unknown; tabId: string | number | null }>();
  const popupClosed = new Set<string>();
  const popupRefs = new Map<string, unknown>();

  const attachCallbackWindow = (sessionId: string, source: unknown, tabId: string | number | null = null) => {
    boundSources.set(sessionId, { source, tabId });
  };
  const detachCallbackWindow = (sessionId: string) => { boundSources.delete(sessionId); popupRefs.delete(sessionId); };

  const openCallbackPopup = (sessionId: string, redirectUri: string, tabId: string | number | null = null): { ok: true; popup: unknown } | { ok: false; reason: string } => {
    if (!opts.openPopup) return { ok: false, reason: 'popup_unavailable' };
    const popup = opts.openPopup(redirectUri);
    if (!popup) return { ok: false, reason: 'popup_blocked' };
    popupRefs.set(sessionId, popup);
    boundSources.set(sessionId, { source: popup, tabId });
    return { ok: true, popup };
  };

  const markPopupClosed = (sessionId: string): void => {
    popupClosed.add(sessionId);
    popupRefs.delete(sessionId);
    boundSources.delete(sessionId);
    controller.invalidate(sessionId);
  };

  const cancelIssuance = (sessionId: string): void => {
    const popup = popupRefs.get(sessionId);
    if (popup) { try { (popup as { close?: () => void }).close?.(); } catch { /* ignore */ } }
    markPopupClosed(sessionId);
  };

  const handleCallbackMessage = (
    event: { origin: string; data: unknown; source?: unknown },
  ): { ok: true; sessionId: string; codeUri: string } | { ok: false; reason: string } => {
    if (event.origin !== opts.callbackOrigin) return { ok: false, reason: 'callback_origin_not_allowed' };
    const msg = event.data as { type?: unknown; url?: unknown } | null;
    if (!msg || msg.type !== 'wallet.identity.callback' || typeof msg.url !== 'string') return { ok: false, reason: 'invalid_callback_message' };
    let url: URL;
    try { url = new URL(msg.url); } catch { return { ok: false, reason: 'malformed_callback_url' }; }
    const token = url.pathname.split('/').filter(Boolean).pop();
    const session = token ? controller.getSessionByCallbackToken(token) : null;
    if (!session) return { ok: false, reason: 'callback_token_mismatch' };
    if (session.used) return controller.handleCallback({ origin: opts.callbackOrigin, url: msg.url, tabId: session.tabId ?? undefined });
    if (popupClosed.has(session.sessionId)) return { ok: false, reason: 'popup_closed' };
    const bound = boundSources.get(session.sessionId);
    if (!bound) return { ok: false, reason: 'source_not_bound' };
    if (event.source !== bound.source) return { ok: false, reason: 'source_mismatch' };
    const result = controller.handleCallback({ origin: opts.callbackOrigin, url: msg.url, tabId: bound.tabId ?? undefined });
    if (result.ok) {
      boundSources.delete(session.sessionId);
      popupRefs.delete(session.sessionId);
      popupClosed.delete(session.sessionId);
    }
    return result;
  };

  const handleResult = (container: unknown, sessionId: string) => {
    const context = controller.getContext(sessionId);
    if (!context) return { ok: false as const, reason: 'unknown_session' };
    const parsed = parseIdentityTokenContainer(container);
    if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
    const provenance = verifyProvenance(parsed.identityObject, context);
    if (!provenance.ok) return { ok: false as const, reason: provenance.reason };
    return { ok: true as const, status: provenance.status };
  };

  const lock = (): void => {
    for (const popup of popupRefs.values()) { try { (popup as { close?: () => void }).close?.(); } catch { /* ignore */ } }
    popupRefs.clear(); boundSources.clear(); popupClosed.clear(); controller.invalidateAll();
  };

  return { prepareIssuance, handleCallback, handleCallbackMessage, handleResult, attachCallbackWindow, detachCallbackWindow, openCallbackPopup, markPopupClosed, cancelIssuance, lock, controller };
}

function cryptoRandom(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
