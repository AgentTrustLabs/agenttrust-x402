/**
 * Live registry card contract (frontend): the provider card rendered from
 * GET /api/services must describe the registry's RECORDED verification
 * decision and its checkedAt timestamp, never imply a fresh verification
 * performed by the page, and never throw when a service's verification
 * fields are absent.
 *
 * Static analysis + extracted-function probes only — no browser, no server,
 * no live API. The loader and its schema validator are not exercised here;
 * the card is the unit under test.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, notOk } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web', 'prototype-v5-6.html'), 'utf8');

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

function extractFunctionSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  ok(start >= 0, `function ${name} exists`);
  let depth = 0;
  for (let j = html.indexOf('{', start); j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const escapeHtml = new Function(`return ${extractFunctionSource('escapeHtml')}`)() as unknown as (s: unknown) => string;
const getServiceVerificationBadge = new Function(
  `return ${extractFunctionSource('getServiceVerificationBadge')}`,
)() as unknown as (s: unknown) => { badgeHtml: string; labelText: string };
const buildLiveServiceCardHTML = new Function(
  'escapeHtml', 'getServiceVerificationBadge',
  `return ${extractFunctionSource('buildLiveServiceCardHTML')}`,
)(escapeHtml, getServiceVerificationBadge) as unknown as (s: unknown) => string;

// The live registered service, shaped like the GET /api/services record.
const liveService = {
  id: 'svc_agenttrust_x402',
  name: 'AgentTrust',
  category: 'utility',
  description: 'AgentTrust x402 service.',
  endpoint: 'https://api.sabokun.my.id/agenttrust/protected',
  provider: { tokenId: 1004, ownerAccount: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', agentUri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json' },
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  pricing: { amountMicroCcd: '1', asset: 'CCD', payTo: '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB', maxTimeoutSeconds: 300 },
  status: 'active',
  available: true,
  providerVerification: { status: 'verified', decision: 'TRUSTED', checkedAt: '2026-11-21T12:51:25.791Z', reason: 'provider Agent Card passed full verification (TRUSTED)' },
};

test('01. a verified service shows the recorded decision and timestamp, not a fresh check', () => {
  const card = buildLiveServiceCardHTML(liveService);
  ok(card.includes('TRUSTED'), 'card shows the recorded decision');
  ok(card.includes('2026-11-21T12:51:25.791Z'), 'card shows the recorded checkedAt');
  ok(card.includes('VERIFIED · RECORDED'), 'badge says recorded, not live');
  ok(card.includes('does not perform a fresh provider verification'), 'card states no fresh verification happens here');
  notOk(card.includes('VERIFIED · LIVE'), 'no live-verification badge');
});

test('02. a service without providerVerification renders "not recorded" instead of throwing (Sol v3 regression)', () => {
  const bare = { ...liveService, providerVerification: null };
  let card: string;
  try {
    card = buildLiveServiceCardHTML(bare);
  } catch (e) {
    throw new Error(`card render threw on a missing providerVerification: ${String(e)}`);
  }
  ok(card.includes('not recorded'), 'missing verification decision renders as not recorded');
  notOk(card.includes('undefined'), 'no raw undefined in the card');
});

test('03. a service with verification present but decision/checkedAt absent renders "not recorded"', () => {
  const partial = { ...liveService, providerVerification: { status: 'verified' } };
  const card = buildLiveServiceCardHTML(partial);
  eq((card.match(/not recorded/g) ?? []).length, 2, 'decision and checkedAt both read not recorded');
  notOk(card.includes('undefined'), 'no raw undefined in the card');
});

test('04. the verification badge never claims a live check for a verified service', () => {
  const badge = getServiceVerificationBadge(liveService);
  eq(badge.labelText, 'VERIFIED — RECORDED STATUS', 'badge label names recorded status');
  ok(badge.badgeHtml.includes('VERIFIED · RECORDED'), 'badge HTML names recorded status');
});

// ═══ runner ═════════════════════════════════════════════════════════════

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error)?.message ?? e).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nlive-registry-card: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
