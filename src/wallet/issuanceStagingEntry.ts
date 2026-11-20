import { createIssuanceController } from './identityIssuance.js';

const cfg = (globalThis as unknown as { __WALLET_ISSUANCE_CONFIG__?: Record<string, unknown> }).__WALLET_ISSUANCE_CONFIG__;
if (!cfg || typeof cfg.callbackOrigin !== 'string') throw new Error('issuance config missing');
const rand = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const controller = createIssuanceController({
  allowedCallbackOrigins: [cfg.callbackOrigin],
  now: () => Date.now(), randomNonce: () => rand(32), randomId: () => rand(32),
});
(globalThis as unknown as { __issuanceStaging: unknown }).__issuanceStaging = {
  begin(context: Record<string, unknown>) { return controller.begin(context as never, cfg.callbackOrigin as string); },
  handle(event: { origin: string; data: unknown; source?: unknown }, expectedSource?: unknown) {
    if (event.origin !== cfg.callbackOrigin) return { ok: false, reason: 'callback_origin_not_allowed' };
    if (expectedSource !== undefined && event.source !== expectedSource) return { ok: false, reason: 'source_mismatch' };
    const msg = event.data as { type?: unknown; url?: unknown } | null;
    if (!msg || msg.type !== 'wallet.identity.callback' || typeof msg.url !== 'string') return { ok: false, reason: 'invalid_callback_message' };
    return controller.handleCallback({ origin: cfg.callbackOrigin as string, url: msg.url });
  },
};
