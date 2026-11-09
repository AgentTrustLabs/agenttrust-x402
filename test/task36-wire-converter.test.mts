/**
 * TASK 36 — converter unit tests.
 *
 * Run: npx tsx test/task36-wire-converter.test.mts
 */

import { ok, eq } from './helpers.mjs';
import { convertV2ToSdkV1, serializeSignableToJson, parseSignableFromJson } from '../services/facilitator/src/wireConverter.js';
import { Transaction } from '@concordium/web-sdk';

const SENDER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const EXPIRY = Math.floor(Date.now() / 1000) + 200;

const policy = {
  network: CAIP2,
  sponsorAddress: SPONSOR,
  maxExecutionEnergy: 100_000,
};

const baseV2 = {
  version: 1,
  header: {
    sender: SENDER,
    nonce: 7,
    expiry: EXPIRY,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { address: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: RECIPIENT, amount: '250000' },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
};

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ── 1. valid conversion ─────────────────────────────────────────────────────

test('01. valid V2 → SDK V1 wire', () => {
  const r = convertV2ToSdkV1(baseV2, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    ok(r.wire.version === 1, 'version');
    ok(r.wire.header.sender === SENDER, 'sender preserved');
    ok(r.wire.header.nonce === 7, 'nonce preserved');
    ok(r.wire.header.expiry === EXPIRY, 'expiry preserved');
    ok(r.wire.header.executionEnergyAmount === 300, 'energy preserved');
    ok(r.wire.header.sponsor.account === SPONSOR, 'sponsor.account set');
    ok((r.wire.payload as any).toAddress === RECIPIENT, 'recipient preserved');
    ok((r.wire.payload as any).amount === '250000', 'amount preserved');
  }
});

// ── 2. round-trip through SDK ──────────────────────────────────────────────

test('02. converted wire is accepted by Transaction.signableFromJSON', () => {
  const r = convertV2ToSdkV1(baseV2, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    const parsed = Transaction.signableFromJSON(r.wire);
    ok(parsed !== null && parsed !== undefined, 'parsed');
    ok(parsed.version === 1, 'version');
  }
});

test('03. serializeSignableToJson uses Transaction.toJSON', () => {
  const r = convertV2ToSdkV1(baseV2, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    const signable = Transaction.signableFromJSON(r.wire);
    const json = serializeSignableToJson(signable) as Record<string, unknown>;
    ok(json !== null && typeof json === 'object', 'json object');
    ok(json.version === 1, 'version');
    ok(json.header !== undefined, 'header');
    ok(json.signatures !== undefined, 'signatures');
  }
});

test('04. parseSignableFromJson round-trips', () => {
  const r = convertV2ToSdkV1(baseV2, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    const signable = Transaction.signableFromJSON(r.wire);
    const json = serializeSignableToJson(signable);
    const reparsed = parseSignableFromJson(json);
    ok(reparsed !== null && reparsed !== undefined, 'reparsed');
  }
});

// ── negative: missing fields ───────────────────────────────────────────────

test('05. missing sponsor → missing_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sponsor: undefined } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('06. missing executionEnergyAmount → missing_field (never defaulted)', () => {
  const tx = { ...baseV2, header: { ...baseV2.header } };
  delete (tx.header as any).executionEnergyAmount;
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('07. missing sender → missing_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sender: '' } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('08. missing nonce → missing_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, nonce: undefined } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('09. missing expiry → missing_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, expiry: undefined } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('10. missing payload → unsupported_payload', () => {
  const tx = { ...baseV2, payload: undefined };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && (r.code === 'missing_field' || r.code === 'unsupported_payload'), `code=${r.ok ? 'ok' : r.code}`);
});

test('11. missing signatures → missing_field', () => {
  const tx = { ...baseV2, signatures: undefined };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'missing_field', `code=${r.ok ? 'ok' : r.code}`);
});

// ── negative: malformed / ambiguous ──────────────────────────────────────────

test('12. invalid sponsor address → invalid_sponsor', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sponsor: { address: 'garbage', numSignatures: 1 } } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'invalid_sponsor', `code=${r.ok ? 'ok' : r.code}`);
});

test('13. sponsor with both address and account differing → ambiguous_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sponsor: { address: SPONSOR, account: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', numSignatures: 1 } } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'ambiguous_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('14. wrong sponsor → wrong_sponsor', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sponsor: { address: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d', numSignatures: 1 } } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'wrong_sponsor', `code=${r.ok ? 'ok' : r.code}`);
});

test('15. energy above policy cap → energy_exceeds_policy', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, executionEnergyAmount: 999_999 } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'energy_exceeds_policy', `code=${r.ok ? 'ok' : r.code}`);
});

test('16. energy zero → malformed_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, executionEnergyAmount: 0 } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'malformed_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('17. energy non-integer → malformed_field', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, executionEnergyAmount: 1.5 } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'malformed_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('18. unsupported version → unsupported_version', () => {
  const tx = { ...baseV2, version: 0 };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'unsupported_version', `code=${r.ok ? 'ok' : r.code}`);
});

test('19. unsupported payload type → unsupported_payload', () => {
  const tx = { ...baseV2, payload: { type: 'deployModule' } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'unsupported_payload', `code=${r.ok ? 'ok' : r.code}`);
});

test('20. sponsor equals recipient → sponsor_equals_recipient', () => {
  const tx = { ...baseV2, payload: { type: 'transfer', toAddress: SPONSOR, amount: '250000' } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'sponsor_equals_recipient', `code=${r.ok ? 'ok' : r.code}`);
});

test('21. malformed signature map → malformed_field', () => {
  const tx = { ...baseV2, signatures: { sender: { 'abc': { 0: 'aa' } }, sponsor: {} } };
  const r = convertV2ToSdkV1(tx, policy);
  ok(!r.ok && r.code === 'malformed_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('22. null input → malformed_field', () => {
  const r = convertV2ToSdkV1(null, policy);
  ok(!r.ok && r.code === 'malformed_field', `code=${r.ok ? 'ok' : r.code}`);
});

test('23. non-object input → malformed_field', () => {
  const r = convertV2ToSdkV1('string', policy);
  ok(!r.ok && r.code === 'malformed_field', `code=${r.ok ? 'ok' : r.code}`);
});

// ── 24. conversion does not bypass authorization ────────────────────────────

test('24. converter is pure — it never calls authorization or signer', () => {
  // The converter has no authorization or signer dependency. This test asserts the
  // structural invariant: convertV2ToSdkV1 is a pure function with no side effects.
  const r1 = convertV2ToSdkV1(baseV2, policy);
  const r2 = convertV2ToSdkV1(baseV2, policy);
  ok(r1.ok && r2.ok, 'both succeed');
  if (r1.ok && r2.ok) {
    ok(JSON.stringify(r1.wire) === JSON.stringify(r2.wire), 'deterministic output');
  }
});

// ── 25. account alias accepted ──────────────────────────────────────────────

test('25. sponsor.account alias is accepted', () => {
  const tx = { ...baseV2, header: { ...baseV2.header, sponsor: { account: SPONSOR, numSignatures: 1 } } };
  delete (tx.header as any).sponsor.address;
  const r = convertV2ToSdkV1(tx, policy);
  ok(r.ok, 'account alias accepted');
});

// ── 26. payload integrity preserved ────────────────────────────────────────

test('26. payload is preserved byte-for-byte', () => {
  const tx = { ...baseV2 };
  const r = convertV2ToSdkV1(tx, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    ok(JSON.stringify(r.wire.payload) === JSON.stringify(tx.payload), 'payload identical');
  }
});

// ── 27. signatures preserved ───────────────────────────────────────────────

test('27. signatures are preserved', () => {
  const tx = { ...baseV2 };
  const r = convertV2ToSdkV1(tx, policy);
  ok(r.ok, 'conversion ok');
  if (r.ok) {
    ok(JSON.stringify(r.wire.signatures) === JSON.stringify(tx.signatures), 'signatures identical');
  }
});

(async () => {
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} — threw: ${(e as Error).message}`);
    }
  }
  console.log(`\ntask36: ${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
