/** Callback page helpers. No HTTP, no logging of code_uri. */
export interface CallbackLocation {
  protocol: string;
  origin: string;
  pathname: string;
  search?: string;
  hash?: string;
}

export type CallbackRead = { ok: true; url: string; sanitizedUrl: string } | { ok: false; reason: string };

/** Requires HTTPS and an explicit callback origin; fragment is preserved only for the controller. */
export function readCallback(location: CallbackLocation, expectedOrigin: string): CallbackRead {
  if (location.protocol !== 'https:') return { ok: false, reason: 'callback_requires_https' };
  if (!expectedOrigin || location.origin !== expectedOrigin) return { ok: false, reason: 'callback_origin_not_allowed' };
  const search = location.search ?? '';
  const hash = location.hash ?? '';
  return {
    ok: true,
    url: `${location.origin}${location.pathname}${search}${hash}`,
    sanitizedUrl: `${location.origin}${location.pathname}${search}`,
  };
}

/** Message sent only to the Wallet Context opener; targetOrigin must be exact. */
export function prepareCallbackMessage(location: CallbackLocation, expectedOrigin: string):
  | { ok: true; message: { type: 'wallet.identity.callback'; url: string; sanitizedUrl: string }; targetOrigin: string }
  | { ok: false; reason: string } {
  const r = readCallback(location, expectedOrigin);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, message: { type: 'wallet.identity.callback', url: r.url, sanitizedUrl: r.sanitizedUrl }, targetOrigin: expectedOrigin };
}
