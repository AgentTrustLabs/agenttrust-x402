/**
 * Standalone HTTP x402 payment client.
 *
 * The other half of the loop the resource server closes:
 *
 *   GET url                 → 200: done (resource returned as-is)
 *   GET url                 → 402: parse the PaymentRequired challenge,
 *                              build a signed payment payload for the exact
 *                              requirement, retry once with `X-PAYMENT`
 *   GET url + X-PAYMENT     → 200: resource + decoded `PAYMENT-RESPONSE`
 *                              (or `X-PAYMENT-RESPONSE`) settlement header
 *                            → anything else: the failure, passed through
 *
 * The client never decides what to pay: amount, recipient, network and
 * resource all come from the server's 402 challenge. The signed payload is
 * built by an injected `createPaymentPayload` — this module never touches a
 * key, a wallet export, or a signing call. The production creator lives in
 * `scripts/x402-pay.mts` (sender wallet export + live nonce, same pattern as
 * the proven demo-payment envelope builder); tests inject a stub.
 *
 * Exactly one paid attempt. A rejected payment is never retried automatically:
 * retrying a signed payment is the facilitator's idempotency domain, not the
 * client's, and a second attempt with a fresh signature would be a second
 * payment.
 */

import { randomBytes } from 'node:crypto';
import type { PaymentRequirements } from '@x402/core/types';
import { decodePaymentResponse } from './resourceServer.js';

export interface ParsedRequirement {
  resourceUrl: string;
  requirements: PaymentRequirements;
}

/** Parse a 402 challenge body into the exact requirement + resource binding. */
export function parsePaymentRequired(body: unknown): ParsedRequirement | null {
  if (!body || typeof body !== 'object') return null;
  const c = body as Record<string, unknown>;
  if (c['x402Version'] !== 2) return null;
  const resource = c['resource'] as { url?: unknown } | undefined;
  if (!resource || typeof resource.url !== 'string' || resource.url.length === 0) return null;
  const accepts = c['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const req = accepts[0] as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object') return null;
  if (req['scheme'] !== 'exact') return null;
  if (typeof req['network'] !== 'string') return null;
  if (typeof req['amount'] !== 'string' || !/^\d+$/.test(req['amount'])) return null;
  if (typeof req['payTo'] !== 'string') return null;
  if (req['asset'] !== 'CCD') return null;
  return { resourceUrl: resource.url, requirements: req as unknown as PaymentRequirements };
}

/** Build the X-PAYMENT payload for the parsed requirement. Injected. */
export type CreatePaymentPayload = (args: {
  requirements: PaymentRequirements;
  resourceUrl: string;
  requestId: string;
}) => Promise<unknown>;

export interface PaidResourceResult {
  /** Final HTTP status of the paid (or first, when no payment was needed) request. */
  status: number;
  /** Parsed JSON body when the response was JSON, else the raw text. */
  body: unknown;
  /** Decoded settlement header on a granted access, when the server sent one. */
  paymentResponse?: Record<string, unknown>;
  /** Machine-readable failure stage, when the flow stopped before a grant. */
  error?: 'malformed_requirement' | 'payload_error' | 'http_error';
  errorDetail?: string;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Fetch a paid resource. Returns the final response; throws only on transport
 * failure (DNS/TLS/connection), never on a payment rejection.
 */
export async function fetchPaidResource(
  url: string,
  opts: {
    createPaymentPayload: CreatePaymentPayload;
    fetchImpl?: typeof fetch;
    requestIdFactory?: () => string;
  },
): Promise<PaidResourceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestIdFactory = opts.requestIdFactory ?? (() => randomBytes(16).toString('hex'));

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    return { status: 0, body: null, error: 'http_error', errorDetail: (e as Error).message };
  }
  if (res.status !== 402) {
    return { status: res.status, body: await readBody(res) };
  }

  const challenge = await readBody(res);
  const parsed = parsePaymentRequired(challenge);
  if (!parsed) {
    return { status: 402, body: challenge, error: 'malformed_requirement' };
  }

  const requestId = requestIdFactory();
  let payload: unknown;
  try {
    payload = await opts.createPaymentPayload({
      requirements: parsed.requirements,
      resourceUrl: parsed.resourceUrl,
      requestId,
    });
  } catch (e) {
    return {
      status: 402,
      body: challenge,
      error: 'payload_error',
      errorDetail: (e as Error).message,
    };
  }

  let paid: Response;
  try {
    paid = await fetchImpl(url, { headers: { 'x-payment': JSON.stringify(payload) } });
  } catch (e) {
    return { status: 0, body: null, error: 'http_error', errorDetail: (e as Error).message };
  }
  const body = await readBody(paid);
  const header = paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response');
  const paymentResponse = header ? decodePaymentResponse(header) ?? undefined : undefined;
  return {
    status: paid.status,
    body,
    ...(paymentResponse ? { paymentResponse } : {}),
  };
}
