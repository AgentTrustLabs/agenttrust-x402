(function () {
  var status = document.getElementById('callback-status');
  var cfg = window.__CALLBACK_CONFIG__ || {};
  if (location.protocol !== 'https:') { status.textContent = 'callback_requires_https'; return; }
  if (!cfg.walletOrigin || location.origin !== cfg.walletOrigin) { status.textContent = 'callback_origin_not_allowed'; return; }
  if (!window.opener) { status.textContent = 'no_internal_channel'; return; }
  try { if (window.opener.location.origin !== cfg.walletOrigin) { status.textContent = 'opener_origin_not_allowed'; return; } } catch { status.textContent = 'opener_origin_not_allowed'; return; }
  var hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  var codeUri = new URLSearchParams(hash).get('code_uri');
  if (!codeUri) { status.textContent = 'missing_code_uri'; return; }
  var url = location.origin + location.pathname + (location.search || '') + location.hash;
  var sanitized = location.origin + location.pathname + (location.search || '');
  window.opener.postMessage({ type: 'wallet.identity.callback', url: url, sanitizedUrl: sanitized }, cfg.walletOrigin);
  history.replaceState(null, '', sanitized);
  status.textContent = 'callback_forwarded';
})();
