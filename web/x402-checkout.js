/**
 * AgentTrust browser-initiated x402 checkout (real flow, not the demo modal).
 *
 * Contracts (audited against services/facilitator/src/browserBridge.ts):
 *   POST /prepare  { requirements, resourceUrl, sender, requestId? }
 *                  → { ok:true, paymentRef, requestId, sponsoredTransaction }
 *                    | { ok:false, status, reason }
 *   POST /confirm  { paymentRef, requestId, signedTransaction, txHash }
 *                  → { ok:true, state, paymentRef, txHash, idempotent }
 *                    | { ok:false, status, reason }
 *
 * Wallet submission uses the official Concordium wallet API, which SIGNS AND
 * SUBMITS. It is never called twice: a timeout or an unrecognised result is
 * `outcome_unknown`, not a failure, and no automatic retry exists.
 *
 * NOTE (real-wallet blocker): the official `sendSponsoredTransaction` returns
 * only a txHash. `/confirm` requires the final signedTransaction. Until a
 * wallet adapter exposes it, the flow stops at outcome_unknown — it never
 * claims success or finalized.
 */

export const X402_NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
export const CHECKOUT_STAGES = ['challenge', 'wallet_approval', 'submission', 'confirmation', 'settlement'];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isAddress(v) { return typeof v === 'string' && BASE58.test(v); }
function fail(reason, extra) { return { ok: false, reason, ...(extra ?? {}) }; }

/** Validate a 402 challenge body. Fails closed on anything unexpected. */
export function parseChallenge(body, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!body || typeof body !== 'object') return fail('invalid_challenge');
  if (body.x402Version !== 2) return fail('unsupported_x402_version');
  if (!Array.isArray(body.accepts) || body.accepts.length !== 1) return fail('invalid_accepts');
  const r = body.accepts[0];
  if (!r || typeof r !== 'object') return fail('invalid_requirements');
  if (r.scheme !== 'exact') return fail('unsupported_scheme');
  if (r.network !== X402_NETWORK) return fail('network_mismatch');
  if (r.asset !== 'CCD') return fail('unsupported_asset');
  const amount = String(r.amount ?? '');
  if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) return fail('invalid_amount');
  if (!isAddress(r.payTo)) return fail('invalid_recipient');
  const timeout = Number(r.maxTimeoutSeconds ?? 300);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400) return fail('invalid_expiry_window');
  const resourceUrl = body.resource && typeof body.resource.url === 'string' ? body.resource.url : '';
  if (!resourceUrl) return fail('invalid_resource_url');
  const validUntil = body.validUntil ?? body.expiresAt ?? null;
  if (validUntil !== null && Number(validUntil) < nowSeconds) return fail('challenge_expired');
  const sponsor = r.extra && typeof r.extra.feePayer === 'string' ? r.extra.feePayer : null;
  if (sponsor !== null && !isAddress(sponsor)) return fail('invalid_sponsor');
  return { ok: true, requirements: r, resourceUrl, amount, recipient: r.payTo, network: r.network, sponsor, timeout };
}

export function buildPrepareRequest(parsed, sender, requestId) {
  const req = { requirements: parsed.requirements, resourceUrl: parsed.resourceUrl, sender };
  if (requestId) req.requestId = requestId;
  return req;
}

export function buildConfirmRequest(prepared, txHash, signedTransaction) {
  return { paymentRef: prepared.paymentRef, requestId: prepared.requestId, signedTransaction, txHash };
}

/** Pure status → label mapping. No finality claim without backend evidence. */
export function checkoutStatus(state) {
  if (!state) return { label: 'NOT STARTED', verified: false };
  if (state.status === 'finalized' && typeof state.txHash === 'string' && HEX64.test(state.txHash)) {
    return { label: 'FINALIZED — VERIFIED', verified: true };
  }
  switch (state.status) {
    case 'pending_confirmation': return { label: 'PENDING CONFIRMATION', verified: false };
    case 'submitted': return { label: 'SUBMITTED — NOT SETTLED', verified: false };
    case 'failed': return { label: 'FAILED', verified: false };
    case 'outcome_unknown': return { label: 'OUTCOME UNKNOWN — DO NOT RETRY', verified: false };
    case 'awaiting_wallet': return { label: 'AWAITING WALLET', verified: false };
    case 'preparing': return { label: 'PREPARING', verified: false };
    case 'awaiting_approval': return { label: 'AWAITING APPROVAL', verified: false };
    case 'rejected': return { label: 'REJECTED', verified: false };
    case 'submitting': return { label: 'SUBMITTING', verified: false };
    default: return { label: 'IN PROGRESS', verified: false };
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render the checkout modal body. Stages + explicit status, never a fake %. */
export function renderCheckout(state) {
  const status = checkoutStatus(state);
  const stage = state?.stage ?? 'challenge';
  const idx = CHECKOUT_STAGES.indexOf(stage);
  const steps = CHECKOUT_STAGES.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    return `<li class="x402-step ${cls}">${esc(s.replace('_', ' '))}</li>`;
  }).join('');
  const details = state?.details ?? {};
  const rows = [
    ['Amount', details.amount ? `${esc(details.amount)} µCCD` : '—'],
    ['Recipient', esc(details.recipient ?? '—')],
    ['Network', esc(details.network ?? X402_NETWORK)],
    ['Sponsor', esc(details.sponsor ?? 'facilitator sponsor')],
    ['Tx hash', esc(state?.txHash ?? '—')],
  ].map(([k, v]) => `<div class="x402-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
  const reason = state?.reason ? `<p class="x402-reason">${esc(state.reason)}</p>` : '';
  const verified = status.verified ? ' <span class="badge-live">VERIFIED</span>' : '';
  return `<div class="x402-checkout"><ol class="x402-steps">${steps}</ol>${rows}` +
    `<p class="x402-status">${esc(status.label)}${verified}</p>${reason}</div>`;
}

/**
 * Run the whole checkout. Every dependency is injected so the flow can be
 * exercised offline with a mocked wallet and mocked HTTP. No retry anywhere.
 */
export async function runCheckout(deps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const emit = (state) => { deps.onState?.(state); return state; };
  const terminal = (status, reason, extra) => emit({ status, reason, stage: extra?.stage ?? 'settlement', ...(extra ?? {}) });

  // 1. challenge
  emit({ status: 'in_progress', stage: 'challenge' });
  let res;
  try { res = await deps.fetchResource(); } catch { return terminal('failed', 'resource_unreachable', { stage: 'challenge' }); }
  if (res.status !== 402) return terminal('failed', `challenge_status_${res.status}`, { stage: 'challenge' });
  let body;
  try { body = await res.json(); } catch { return terminal('failed', 'challenge_not_json', { stage: 'challenge' }); }
  const parsed = parseChallenge(body, now());
  if (!parsed.ok) return terminal('failed', parsed.reason, { stage: 'challenge' });
  const details = { amount: parsed.amount, recipient: parsed.recipient, network: parsed.network, sponsor: parsed.sponsor };
  if (deps.attemptStore?.has?.(parsed.resourceUrl)) {
    return terminal('outcome_unknown', 'duplicate_submit', { stage: 'challenge', details });
  }
  deps.attemptStore?.mark?.(parsed.resourceUrl);

  // 2. wallet connection + account/network validation
  emit({ status: 'awaiting_wallet', stage: 'wallet_approval', details });
  const conn = await deps.wallet.connect();
  if (!conn || conn.ok !== true) {
    const r = conn?.reason;
    const reason = r === 'rejected' || r === 'cancelled' ? 'wallet_rejected' : r === 'no_provider' ? 'wallet_unavailable' : (r ?? 'wallet_unavailable');
    return terminal('failed', reason, { stage: 'wallet_approval', details });
  }
  const account = await deps.wallet.getAccount();
  const chain = await deps.wallet.getChain();
  if (!isAddress(account)) return terminal('failed', 'invalid_wallet_account', { stage: 'wallet_approval', details });
  if (chain !== parsed.network) return terminal('failed', 'wallet_network_mismatch', { stage: 'wallet_approval', details });

  // 3. prepare
  emit({ status: 'preparing', stage: 'wallet_approval', details });
  let prepareRes;
  try {
    prepareRes = await deps.fetchImpl(deps.prepareUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPrepareRequest(parsed, account, deps.requestIdFactory?.())),
    });
  } catch { return terminal('failed', 'prepare_unreachable', { stage: 'wallet_approval', details }); }
  let prepared;
  try { prepared = await prepareRes.json(); } catch { return terminal('failed', 'prepare_not_json', { stage: 'wallet_approval', details }); }
  if (!prepared || prepared.ok !== true) {
    const reason = String(prepared?.reason ?? `prepare_status_${prepareRes.status}`);
    const mapped = reason.startsWith('authorization_') ? 'authorization_refused'
      : reason.includes('sign') ? 'sponsor_signing_failed' : reason;
    return terminal('failed', mapped, { stage: 'wallet_approval', details });
  }

  let signedTransaction = null;
  let txHash = null;

  if (typeof deps.wallet.sign === 'function') {
    // Wallet Context: parent only receives signedTransaction; approval is in the iframe.
    emit({ status: 'awaiting_approval', stage: 'wallet_approval', details });
    let signed;
    try { signed = await deps.wallet.sign(prepared); }
    catch (e) {
      const reason = (e && e.message) || 'signing_failed';
      return terminal('failed', reason === 'user_rejected' ? 'user_rejected' : 'wallet_sign_failed', { stage: 'wallet_approval', details });
    }
    if (!signed || signed.ok !== true) {
      const reason = String(signed?.reason ?? 'signing_failed');
      const mapped = reason === 'user_rejected' || reason === 'wallet_locked' ? reason : 'wallet_sign_failed';
      return terminal('failed', mapped, { stage: 'wallet_approval', details });
    }
    signedTransaction = signed.signedTransaction;
    emit({ status: 'submitting', stage: 'submission', details });
    const sub = await deps.wallet.submit(account, signedTransaction);
    if (!sub || sub.ok !== true) {
      if (sub?.reason === 'cancelled') return terminal('failed', 'wallet_rejected', { stage: 'submission', details });
      return terminal('outcome_unknown', 'submission_ambiguous', { stage: 'submission', details });
    }
    if (typeof sub.txHash !== 'string' || !HEX64.test(sub.txHash.toLowerCase())) {
      return terminal('outcome_unknown', 'wallet_returned_invalid_hash', { stage: 'submission', details });
    }
    txHash = sub.txHash.toLowerCase();
  } else {
    let signable;
    try { signable = deps.sdkFromJSON(prepared.sponsoredTransaction); }
    catch { return terminal('failed', 'invalid_sponsored_transaction', { stage: 'submission', details }); }
    emit({ status: 'submitting', stage: 'submission', details });
    const sub = await deps.wallet.submit(account, signable);
    if (!sub || sub.ok !== true) {
      if (sub?.reason === 'cancelled') return terminal('failed', 'wallet_rejected', { stage: 'submission', details });
      return terminal('outcome_unknown', 'wallet_submission_ambiguous', { stage: 'submission', details });
    }
    if (typeof sub.txHash !== 'string' || !HEX64.test(sub.txHash.toLowerCase())) {
      return terminal('outcome_unknown', 'wallet_returned_invalid_hash', { stage: 'submission', details });
    }
    txHash = sub.txHash.toLowerCase();
    signedTransaction = sub.signedTransaction ? deps.toJSON(sub.signedTransaction) : null;
    if (!signedTransaction) {
      return terminal('outcome_unknown', 'signed_transaction_unavailable', { stage: 'confirmation', details, txHash });
    }
  }

  // 6. confirm — backend evidence only
  emit({ status: 'in_progress', stage: 'confirmation', details, txHash });
  let confirmRes;
  try {
    confirmRes = await deps.fetchImpl(deps.confirmUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildConfirmRequest(prepared, txHash, signedTransaction)),
    });
  } catch { return terminal('outcome_unknown', 'confirm_unreachable', { stage: 'confirmation', details, txHash }); }
  let confirmed;
  try { confirmed = await confirmRes.json(); } catch { return terminal('outcome_unknown', 'confirm_not_json', { stage: 'confirmation', details, txHash }); }
  if (!confirmed || confirmed.ok !== true) {
    const reason = String(confirmed?.reason ?? `confirm_status_${confirmRes.status}`);
    const status = confirmRes.status >= 500 ? 'outcome_unknown' : 'failed';
    return terminal(status, reason, { stage: 'confirmation', details, txHash });
  }
  if (confirmed.txHash !== txHash) return terminal('outcome_unknown', 'confirm_hash_mismatch', { stage: 'confirmation', details, txHash });
  const state = confirmed.state === 'finalized' ? 'finalized'
    : confirmed.state === 'pending_confirmation' || confirmed.state === 'submitted' ? 'pending_confirmation'
    : confirmed.state === 'failed' ? 'failed' : 'outcome_unknown';
  return terminal(state, state === 'finalized' ? null : `chain_${confirmed.state}`, { stage: 'settlement', details, txHash });
}

/**
 * Bind the real checkout to the page. Wallet/SDK adapters must be supplied by
 * the host page; without them the modal reports BLOCKED instead of faking a
 * payment. The demo-only modal is replaced by this flow.
 */
export function installCheckout(opts) {
  const buttons = opts.querySelectorAll('.open-pay-modal');
  const openModal = opts.openModal;
  const renderInto = opts.renderInto;
  const deps = opts.deps;
  buttons.forEach(btn => {
    btn.onclick = async () => {
      const svc = btn.dataset.service ? ` (${btn.dataset.service})` : '';
      if (!deps) {
        openModal(`Pay with x402${svc}`, 'BLOCKED — browser wallet/SDK adapter not loaded. No payment was attempted.');
        return;
      }
      openModal(`Pay with x402${svc}`, '');
      const state = await runCheckout({ ...deps, onState: s => renderInto(renderCheckout(s)) });
      renderInto(renderCheckout(state));
    };
  });
}
