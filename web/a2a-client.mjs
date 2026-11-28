/**
 * A2A client for the AgentTrust website (browser module, no SDK).
 *
 * Talks to the real backend contracts — nothing here is a mock or a
 * simulation:
 *
 *   - Agent Card: GET {a2a}/a2a/agents/<agentId>/.well-known/agent-card.json
 *     (standalone A2A server, src/a2a/server.ts).
 *   - Gateway Card: GET {resource}/.well-known/agent-card.json
 *     (resource server, src/x402/resourceServer.ts).
 *   - Task records: GET {pairing}/api/a2a/tasks[/:id] (pairing server,
 *     src/pairing/server.ts — the A2A task store on the shared state DB).
 *   - JSON-RPC: POST {a2a}/a2a/agents/<agentId>/jsonrpc — SendMessage,
 *     GetTask, ListTasks, CancelTask (SubscribeToTask sends the current
 *     task as a single SSE event and closes; there is no live push bus,
 *     so this client polls GetTask for updates and says so).
 *
 * Message shape (A2A v1.0, as in src/a2a/client.ts): the message carries
 * role ROLE_USER, parts [{ text }], and metadata
 * {'agenttrust.skillId': <skillId>}. Paid skills answer INPUT_REQUIRED
 * with the a2a-x402 payment-required metadata (x402.payment.status =
 * 'payment-required', x402.payment.required.accepts[0] = the requirement);
 * the client NEVER pays by itself — it surfaces the requirement and the
 * caller decides. A completed task carries its receipts in
 * x402.payment.receipts.
 *
 * Card validation here is display-oriented: the website only renders what
 * it validates (name, description, skills with id/name/description). The
 * gateway card uses the older shape (top-level url, no
 * supportedInterfaces), so the strict v1.0 validator
 * (src/a2a/agentCard.ts validateAgentCard) is NOT applied to it — it
 * would reject a real card. The A2A server validates its own card at
 * startup with that function; this client additionally reads
 * supportedInterfaces[0].url for the JSON-RPC endpoint when present.
 *
 * This module is pure (no DOM): the caller injects fetch and, for the
 * SHA-256 card-integrity check, the Web Crypto subtle object
 * (globalThis.crypto.subtle in the browser and in Node 19+). It is shared
 * by the website (imported by prototype-v5-6.html) and by the regression
 * suite (test/website-api-routing.test.mts).
 */

import { apiUrlFor, fetchJson } from './api-routing.mjs';

export const A2A_VERSION = '1.0';
export const A2A_X402_EXTENSION_URI =
  'https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2';
export const A2A_SKILL_ID_KEY = 'agenttrust.skillId';
export const A2A_CALLER_AGENT_ID_KEY = 'agenttrust.callerAgentId';
export const A2A_CALLER_WALLET_ID_KEY = 'agenttrust.callerWalletId';

export const X402_PAYMENT_STATUS_KEY = 'x402.payment.status';
export const X402_PAYMENT_REQUIRED_KEY = 'x402.payment.required';
export const X402_PAYMENT_RECEIPTS_KEY = 'x402.payment.receipts';
export const X402_PAYMENT_REASON_KEY = 'x402.payment.reason';

export function a2aAgentBasePath(agentId) {
  return `/a2a/agents/${agentId}`;
}

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function randomId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

/**
 * Display-oriented card validation: returns the list of problems (empty
 * when the card is renderable). Only the fields the website renders are
 * required: name, description, and a non-empty skills list whose entries
 * each have id, name and description. A skill's price is NOT in the card
 * (A2A v1.0 defines no price field); paid-ness is read from the tags
 * ('paid' / 'free') and the description.
 */
export function validateDisplayCard(card) {
  const problems = [];
  if (!isRecord(card)) return ['card is not an object'];
  if (typeof card.name !== 'string' || card.name.length === 0) problems.push('name is missing or empty');
  if (typeof card.description !== 'string' || card.description.length === 0) problems.push('description is missing or empty');
  if (!Array.isArray(card.skills) || card.skills.length === 0) {
    problems.push('skills is missing or empty');
  } else {
    card.skills.forEach((s, i) => {
      if (!isRecord(s)) {
        problems.push(`skills[${i}] is not an object`);
        return;
      }
      if (typeof s.id !== 'string' || s.id.length === 0) problems.push(`skills[${i}].id is missing or empty`);
      if (typeof s.name !== 'string' || s.name.length === 0) problems.push(`skills[${i}].name is missing or empty`);
      if (typeof s.description !== 'string' || s.description.length === 0) problems.push(`skills[${i}].description is missing or empty`);
    });
  }
  return problems;
}

/** Is a card skill paid? From the tags ('paid'), else 'free' tag, else unknown. */
export function skillPaidState(skill) {
  const tags = Array.isArray(skill && skill.tags) ? skill.tags : [];
  if (tags.includes('paid')) return 'paid';
  if (tags.includes('free')) return 'free';
  return 'unknown';
}

/**
 * SHA-256 hex of a UTF-8 string, via the injected Web Crypto subtle
 * object (globalThis.crypto.subtle by default). Used for the Agent Card
 * integrity check: the fetched card bytes hashed must equal the on-chain
 * metadata hash. Throws when no subtle crypto is available.
 */
export async function sha256HexText(text, subtle) {
  const s = subtle || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!s || typeof s.digest !== 'function') throw new Error('subtle_crypto_unavailable');
  const data = new TextEncoder().encode(text);
  const digest = await s.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch the provider Agent Card from the A2A server. Returns the parsed
 * card. Throws on non-200, malformed card, unreachable service, or a
 * missing A2A configuration (service_not_configured:a2a).
 */
export async function fetchAgentCard(fetchImpl, config, agentId) {
  const path = `${a2aAgentBasePath(agentId)}/.well-known/agent-card.json`;
  const { status, body } = await fetchJson(fetchImpl, config, 'a2a', path, undefined, 10000);
  if (status !== 200) throw new Error(`agent_card_http_${status}`);
  const problems = validateDisplayCard(body);
  if (problems.length > 0) throw new Error(`agent_card_invalid: ${problems.join('; ')}`);
  return body;
}

/**
 * Fetch the gateway Agent Card from the resource server as raw text (so
 * the caller can hash the exact bytes for the integrity check) plus the
 * parsed card. Returns { card, rawText }. The raw bytes are what the
 * on-chain metadata hash covers.
 */
export async function fetchGatewayCardRaw(fetchImpl, config) {
  const url = apiUrlFor(config, 'resource', '/.well-known/agent-card.json');
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (res.status !== 200) throw new Error(`gateway_card_http_${res.status}`);
    const rawText = await res.text();
    let card = null;
    try {
      card = JSON.parse(rawText);
    } catch {
      throw new Error('gateway_card_invalid: not JSON');
    }
    const problems = validateDisplayCard(card);
    if (problems.length > 0) throw new Error(`gateway_card_invalid: ${problems.join('; ')}`);
    return { card, rawText };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('request_timeout');
    if (err && err.message && (err.message.startsWith('gateway_card_') || err.message === 'request_timeout')) throw err;
    throw new Error('api_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the A2A task records from the pairing server
 * (GET /api/a2a/tasks). `params` may carry state, paymentStatus, limit,
 * offset, callerAgentId, providerAgentId. Returns { tasks, total }.
 * Throws on non-200, malformed payload, unreachable service, or a
 * missing pairing configuration. A 503 means the pairing server was
 * built without the A2A task store (a2a_tasks_unavailable); a 404 means
 * the deployment predates the /api/a2a/tasks mount.
 */
export async function listA2ATasks(fetchImpl, config, params) {
  const qs = new URLSearchParams();
  const p = params && typeof params === 'object' ? params : {};
  for (const key of ['state', 'paymentStatus', 'callerAgentId', 'providerAgentId']) {
    if (typeof p[key] === 'string' && p[key].length > 0) qs.set(key, p[key]);
  }
  if (Number.isSafeInteger(p.limit)) qs.set('limit', String(p.limit));
  if (Number.isSafeInteger(p.offset)) qs.set('offset', String(p.offset));
  const suffix = qs.toString();
  const path = suffix ? `/api/a2a/tasks?${suffix}` : '/api/a2a/tasks';
  const { status, body } = await fetchJson(fetchImpl, config, 'pairing', path, undefined, 10000);
  if (status === 503) throw new Error('a2a_tasks_unavailable');
  if (status === 404) throw new Error('a2a_tasks_not_mounted');
  if (status !== 200) throw new Error(`a2a_tasks_http_${status}`);
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.tasks) || typeof body.total !== 'number') {
    throw new Error('a2a_tasks_malformed');
  }
  return { tasks: body.tasks, total: body.total };
}

/**
 * Fetch one A2A task record (GET /api/a2a/tasks/:id). Returns the record
 * (with its embedded task + events). Throws Error('task_not_found') on
 * 404, and the same routing/availability errors as listA2ATasks.
 */
export async function getA2ATask(fetchImpl, config, taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('invalid_task_id');
  const { status, body } = await fetchJson(
    fetchImpl, config, 'pairing', `/api/a2a/tasks/${encodeURIComponent(taskId)}`, undefined, 10000,
  );
  if (status === 503) throw new Error('a2a_tasks_unavailable');
  if (status === 404) throw new Error('task_not_found');
  if (status !== 200) throw new Error(`a2a_task_http_${status}`);
  if (!isRecord(body) || body.ok !== true || typeof body.taskId !== 'string') {
    throw new Error('a2a_task_malformed');
  }
  return body;
}

/** The JSON-RPC endpoint for an agent: the card's declared URL when known, else the base convention. */
export function a2aJsonRpcPath(agentId, card) {
  const fromCard = card && Array.isArray(card.supportedInterfaces) && card.supportedInterfaces[0]
    ? card.supportedInterfaces[0].url
    : null;
  if (typeof fromCard === 'string' && fromCard.length > 0) return fromCard;
  return `${a2aAgentBasePath(agentId)}/jsonrpc`;
}

/**
 * One JSON-RPC call to the A2A server. `rpcUrl` is a full URL or a path
 * (resolved against the A2A base when it starts with '/a2a/'). Returns the
 * result object. Throws on HTTP non-200, malformed JSON-RPC, a JSON-RPC
 * error object, or an unreachable / unconfigured A2A service.
 */
export async function a2aRpc(fetchImpl, config, agentId, method, params, rpcUrl) {
  const path = typeof rpcUrl === 'string' && rpcUrl.length > 0 ? rpcUrl : `${a2aAgentBasePath(agentId)}/jsonrpc`;
  let url;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    url = path;
  } else if (path.startsWith('/')) {
    url = apiUrlFor(config, 'a2a', path);
  } else {
    throw new Error('invalid_rpc_url');
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const body = { jsonrpc: '2.0', id: randomId(), method, params };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': A2A_VERSION,
        'a2a-extensions': A2A_X402_EXTENSION_URI,
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('request_timeout');
    throw new Error('api_unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`a2a_${method}_http_${res.status}`);
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') throw new Error(`a2a_${method}_malformed`);
  if (parsed.error) {
    const code = typeof parsed.error.code === 'number' ? parsed.error.code : '?';
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown error';
    throw new Error(`a2a_${method}_error_${code}: ${message}`);
  }
  return parsed.result;
}

/**
 * Send a message to a skill (SendMessage). `opts` may carry callerAgentId
 * and callerWalletId (recorded as caller-asserted attribution). Returns
 * the SendMessage result ({ task } or { message }). The caller inspects
 * the task: COMPLETED carries artifacts; INPUT_REQUIRED carries the
 * payment requirement (see parsePaymentRequiredFromTask); FAILED means
 * the skill refused (e.g. no funded on-chain account). This function
 * never pays — a payment-required task is returned as-is.
 */
export async function sendA2AMessage(fetchImpl, config, agentId, text, skillId, opts, card) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('invalid_message_text');
  const metadata = {};
  if (typeof skillId === 'string' && skillId.length > 0) metadata[A2A_SKILL_ID_KEY] = skillId;
  if (opts && typeof opts.callerAgentId === 'string') metadata[A2A_CALLER_AGENT_ID_KEY] = opts.callerAgentId;
  if (opts && typeof opts.callerWalletId === 'string') metadata[A2A_CALLER_WALLET_ID_KEY] = opts.callerWalletId;
  const message = {
    messageId: randomId(),
    role: 'ROLE_USER',
    parts: [{ text }],
    metadata,
  };
  const rpcUrl = a2aJsonRpcPath(agentId, card || null);
  const result = await a2aRpc(fetchImpl, config, agentId, 'SendMessage', { message }, rpcUrl);
  if (!isRecord(result) || (!('task' in result) && !('message' in result))) {
    throw new Error('send_message_malformed');
  }
  return result;
}

/** Poll a task's current state (GetTask). Returns the task object. */
export async function getA2ATaskViaRpc(fetchImpl, config, agentId, taskId, card) {
  if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('invalid_task_id');
  const rpcUrl = a2aJsonRpcPath(agentId, card || null);
  const result = await a2aRpc(fetchImpl, config, agentId, 'GetTask', { id: taskId }, rpcUrl);
  if (!isRecord(result) || !isRecord(result.task)) throw new Error('get_task_malformed');
  return result.task;
}

/** List tasks via JSON-RPC (ListTasks). Returns the result object. */
export async function listA2ATasksViaRpc(fetchImpl, config, agentId, params, card) {
  const rpcUrl = a2aJsonRpcPath(agentId, card || null);
  return a2aRpc(fetchImpl, config, agentId, 'ListTasks', params || {}, rpcUrl);
}

/** Cancel a task (CancelTask). Returns the result object. */
export async function cancelA2ATask(fetchImpl, config, agentId, taskId, card) {
  if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('invalid_task_id');
  const rpcUrl = a2aJsonRpcPath(agentId, card || null);
  return a2aRpc(fetchImpl, config, agentId, 'CancelTask', { id: taskId }, rpcUrl);
}

/**
 * Extract the payment requirement from a task (the a2a-x402
 * payment-required metadata on the task's status message). Returns the
 * first accepted requirement object, or null when the task does not carry
 * one. The requirement has { scheme, network, asset, amount, payTo,
 * maxTimeoutSeconds, extra }.
 */
export function parsePaymentRequiredFromTask(task) {
  if (!isRecord(task) || !isRecord(task.status) || !isRecord(task.status.message)) return null;
  const metadata = task.status.message.metadata;
  if (!isRecord(metadata)) return null;
  if (metadata[X402_PAYMENT_STATUS_KEY] !== 'payment-required') return null;
  const required = metadata[X402_PAYMENT_REQUIRED_KEY];
  if (!isRecord(required)) return null;
  const accepts = required.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  return isRecord(accepts[0]) ? accepts[0] : null;
}

/**
 * The A2A v1.0 task state lives at task.status.state (e.g.
 * TASK_STATE_COMPLETED); a flat task.state is accepted as a fallback.
 * Returns the state string, or null.
 */
export function taskState(task) {
  if (!isRecord(task)) return null;
  const fromStatus = isRecord(task.status) ? task.status.state : null;
  if (typeof fromStatus === 'string' && fromStatus.length > 0) return fromStatus;
  return typeof task.state === 'string' && task.state.length > 0 ? task.state : null;
}

export const A2A_TERMINAL_STATES = [
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
  'COMPLETED', 'FAILED', 'CANCELED',
];

/** True when the task is in a terminal state (no further polling). */
export function taskIsTerminal(task) {
  const s = taskState(task);
  return s !== null && A2A_TERMINAL_STATES.includes(s);
}

/**
 * Extract the settlement receipts from a completed task (the
 * x402.payment.receipts metadata on the task's status message).
 * Returns the receipts array, or null.
 */
export function parseReceiptsFromTask(task) {
  if (!isRecord(task) || !isRecord(task.status) || !isRecord(task.status.message)) return null;
  const metadata = task.status.message.metadata;
  if (!isRecord(metadata)) return null;
  const receipts = metadata[X402_PAYMENT_RECEIPTS_KEY];
  return Array.isArray(receipts) ? receipts : null;
}

/**
 * Extract the artifact texts from a task (for display). Returns an array
 * of { name, text, data } — text from text parts, data from data parts.
 */
export function taskArtifacts(task) {
  if (!isRecord(task) || !Array.isArray(task.artifacts)) return [];
  const out = [];
  for (const artifact of task.artifacts) {
    if (!isRecord(artifact) || !Array.isArray(artifact.parts)) continue;
    let text = '';
    let data = null;
    for (const part of artifact.parts) {
      if (isRecord(part) && typeof part.text === 'string') text += part.text;
      if (isRecord(part) && part.data !== undefined) data = part.data;
    }
    out.push({ name: typeof artifact.name === 'string' ? artifact.name : '', text, data });
  }
  return out;
}
