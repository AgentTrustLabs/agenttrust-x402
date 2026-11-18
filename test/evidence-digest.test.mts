/**
 * Evidence digest canonicalization regression tests.
 *
 * `evidenceDigestOf` must hash the CONTENT of live Concordium SDK
 * responses, which carry BigInt and rich types (BlockHash, AccountAddress,
 * CcdAmount) that plain `JSON.stringify` cannot serialize at all — it
 * throws `TypeError: Do not know how to serialize a BigInt`.
 *
 * Covers: BigInt (deterministic, full precision), SDK-shaped rich types
 * (via `toJSON` and structurally), key-order determinism, array order,
 * scalar meaning, circular references (fail-closed), unsupported values,
 * no `[object Object]`, and the exact compatibility break with legacy
 * `JSON.stringify` digests for string-only fixtures.
 *
 * Fully offline. No broadcast, no signing, no network, no live database.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq, ok, notOk } from './helpers.mjs';
import { canonicalStringify, CanonicalizationError } from '../services/facilitator/src/canonicalJson.js';
import { SqliteSettlementRepository, evidenceDigestOf } from '../services/facilitator/src/repository.js';
import { ReconciliationService } from '../services/facilitator/src/reconcile.js';
import { requirementsKey } from '../services/facilitator/src/store.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const PAY_TO = '3dX7PEbUkmarXKhPo6HwRK6YWZtmAgJdDRt5UELd7k63AsUwUB';
const BLOCK_HASH = '97b23005f364eab0f793d89b01199c5d319082beb933fcf92033fe7da863c297';
const FINAL_TX = '705ec84d292076626e623710632a1453cdf12d2aed5ac768512ed31ccfbf4497';
const FINAL_DIGEST = 'a1'.repeat(32);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Legacy digest: what `evidenceDigestOf` produced before this change. */
const legacyDigestOf = (v: unknown) => sha256(JSON.stringify(v) as string);

const throwsCanonical = (fn: () => unknown, label: string) => {
  try {
    fn();
  } catch (e) {
    ok(e instanceof CanonicalizationError, `${label} throws CanonicalizationError`);
    return e as CanonicalizationError;
  }
  throw new Error(`${label} did not throw`);
};

/**
 * Node-style `getBlockItemStatus` response for a finalized sponsored
 * transfer, shaped like the real SDK 12 response: BlockHash/AccountAddress
 * objects with `toJSON`, CcdAmount objects with `toJSON` returning the
 * microCCD integer string, BigInt costs, and an Energy-like object with
 * no `toJSON` (structural path).
 */
const SDK_RAW_FINAL = {
  status: 'finalized',
  outcome: {
    blockHash: { toJSON: () => BLOCK_HASH, toString: () => BLOCK_HASH },
    summary: {
      hash: { toJSON: () => FINAL_TX },
      type: 'accountTransaction',
      cost: 0n,
      energyCost: { value: 635n, __type: 'ccd_energy' },
      sender: { toJSON: () => SENDER },
      sponsor: {
        cost: { microCcdAmount: 4800331n, toJSON: () => '4800331', toString: () => '4.800331' },
        sponsor: { toJSON: () => SPONSOR },
      },
      transactionType: 'transfer',
      transfer: {
        tag: 'Transferred',
        amount: { microCcdAmount: 1n, toJSON: () => '1', toString: () => '0.000001' },
        to: { toJSON: () => PAY_TO },
      },
    },
  },
};

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// ═══ 1. BigInt ═══════════════════════════════════════════════════════════

test('01. bigint serializes tagged, deterministic, full precision', () => {
  eq(canonicalStringify(4800331n), '{"$bigint":"4800331"}', 'tagged decimal string');
  eq(canonicalStringify(0n), '{"$bigint":"0"}', 'zero bigint');
  eq(canonicalStringify(-5n), '{"$bigint":"-5"}', 'negative bigint');
  // Beyond Number.MAX_SAFE_INTEGER: 2^53+1 must not collapse onto 2^53.
  const big = 9007199254740993n;
  const bigMinusOne = 9007199254740992n;
  notOk(canonicalStringify(big) === canonicalStringify(bigMinusOne), 'precision preserved past 2^53');
  ok(canonicalStringify(big).includes('9007199254740993'), 'exact decimal kept');
  eq(canonicalStringify({ cost: 4800331n }), '{"cost":{"$bigint":"4800331"}}', 'nested bigint');
  // A bigint is distinct from the plain string with the same digits.
  notOk(evidenceDigestOf({ cost: 4800331n }) === evidenceDigestOf({ cost: '4800331' }), 'bigint ≠ string digest');
});

test('02. bigint inside arrays and nested objects', () => {
  eq(canonicalStringify([1n, 2n]), '[{"$bigint":"1"},{"$bigint":"2"}]', 'array of bigints');
  eq(evidenceDigestOf([4800331n]), evidenceDigestOf([4800331n]), 'digest stable across calls');
});

// ═══ 2. Rich SDK types ═══════════════════════════════════════════════════

test('03. SDK-shaped raw normalizes through toJSON, never [object Object]', () => {
  const s = canonicalStringify({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL });
  notOk(s.includes('[object Object]'), 'no [object Object] anywhere');
  ok(s.includes(BLOCK_HASH), 'block hash hex present');
  ok(s.includes(SENDER), 'sender base58 present');
  ok(s.includes(SPONSOR), 'sponsor base58 present');
  ok(s.includes('"4800331"'), 'fee as microCCD integer string');
  notOk(s.includes('4.800331'), 'fee never as CCD decimal String()');
  ok(s.includes('"$bigint":"635"'), 'energy value as tagged bigint');
  ok(s.includes('"ccd_energy"'), 'Energy __type kept structurally');
  eq(evidenceDigestOf({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }), evidenceDigestOf({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }), 'digest stable');
});

test('04. SDK-shaped raw equals its plain-JSON equivalent', () => {
  // The same evidence, written out as plain JSON values, must hash
  // identically — that is what "normalization" means.
  const plain = {
    source: 'concordium-grpc',
    observed: 'finalized',
    raw: {
      status: 'finalized',
      outcome: {
        blockHash: BLOCK_HASH,
        summary: {
          hash: FINAL_TX,
          type: 'accountTransaction',
          cost: { $bigint: '0' },
          energyCost: { __type: 'ccd_energy', value: { $bigint: '635' } },
          sender: SENDER,
          sponsor: { cost: '4800331', sponsor: SPONSOR },
          transactionType: 'transfer',
          transfer: { amount: '1', tag: 'Transferred', to: PAY_TO },
        },
      },
    },
  };
  eq(
    canonicalStringify({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }),
    canonicalStringify(plain),
    'SDK-shaped ≡ plain equivalent',
  );
  eq(
    evidenceDigestOf({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }),
    evidenceDigestOf(plain),
    'digests match',
  );
});

test('05. amount object without toJSON serializes structurally (microCcdAmount kept)', () => {
  const s = canonicalStringify({ cost: { microCcdAmount: 4800331n, __type: 'ccd_amount' } });
  ok(s.includes('"microCcdAmount":{"$bigint":"4800331"}'), 'microCcdAmount as tagged bigint');
  notOk(s.includes('4.800331'), 'no CCD decimal');
});

test('06. toString is never used: custom toString without toJSON serializes structurally', () => {
  const s = canonicalStringify({ label: { toString: () => 'CUSTOM', x: 1 } });
  eq(s, '{"label":{"x":1}}', 'function-valued toString dropped, structure kept');
  notOk(s.includes('CUSTOM'), 'toString output never appears');
});

test('07. Date normalizes via toJSON (ISO-8601), Uint8Array as tagged hex', () => {
  eq(canonicalStringify(new Date('2026-11-18T11:01:24.585Z')), '"2026-11-18T11:01:24.585Z"', 'Date → ISO string');
  eq(canonicalStringify(new Uint8Array([0x97, 0xb2])), '{"$bytes":"97b2"}', 'bytes → tagged hex');
  eq(canonicalStringify(Buffer.from([0x00, 0xff])), '{"$bytes":"00ff"}', 'Buffer → tagged hex');
});

// ═══ 3. Determinism ══════════════════════════════════════════════════════

test('08. object key order is deterministic (sorted), nested too', () => {
  eq(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}', 'top-level keys sorted');
  const one = { source: 'concordium-grpc', observed: 'finalized', raw: { z: 1, a: { y: 2, b: 3 } } };
  const two = { raw: { a: { b: 3, y: 2 }, z: 1 }, observed: 'finalized', source: 'concordium-grpc' };
  eq(canonicalStringify(one), canonicalStringify(two), 'same content, different key order → same string');
  eq(evidenceDigestOf(one), evidenceDigestOf(two), 'same digest');
  eq(evidenceDigestOf({ b: 1, a: 2 }), sha256('{"a":2,"b":1}'), 'digest is sha256 of the sorted canonical string');
});

test('09. array order is preserved', () => {
  notOk(canonicalStringify([1, 2, 3]) === canonicalStringify([3, 2, 1]), 'reordered array differs');
  notOk(evidenceDigestOf([1, 2, 3]) === evidenceDigestOf([3, 2, 1]), 'array digest differs');
  eq(canonicalStringify([1, 2, 3]), '[1,2,3]', 'array order kept');
});

test('10. scalars keep their meaning', () => {
  eq(canonicalStringify(null), 'null', 'null');
  eq(canonicalStringify(true), 'true', 'true');
  eq(canonicalStringify(false), 'false', 'false');
  eq(canonicalStringify('x'), '"x"', 'string');
  eq(canonicalStringify(42), '42', 'integer');
  eq(canonicalStringify(1.5), '1.5', 'float');
  eq(canonicalStringify(-0), '0', 'negative zero is 0 in JSON');
  eq(canonicalStringify('a"b\\c'), '"a\\"b\\\\c"', 'string escaping');
});

// ═══ 4. Circular + unsupported (fail-closed) ═════════════════════════════

test('11. circular references throw with the offending path', () => {
  const selfObj: Record<string, unknown> = { a: 1 };
  selfObj.self = selfObj;
  const e1 = throwsCanonical(() => canonicalStringify(selfObj), 'self-referencing object');
  ok(e1.message.includes('$.self'), `path named: ${e1.message}`);

  const selfArr: unknown[] = [1];
  selfArr.push(selfArr);
  const e2 = throwsCanonical(() => canonicalStringify(selfArr), 'self-referencing array');
  ok(e2.message.includes('$[1]'), `path named: ${e2.message}`);

  const nested = { outcome: { summary: {} as Record<string, unknown> } };
  (nested.outcome.summary as Record<string, unknown>).back = nested;
  const e3 = throwsCanonical(() => canonicalStringify(nested), 'nested circular');
  ok(e3.message.includes('$.outcome.summary.back'), `path named: ${e3.message}`);

  throwsCanonical(() => evidenceDigestOf(selfObj), 'evidenceDigestOf circular');
});

test('12. unsupported values: dropped in objects, null in arrays, throw at top level', () => {
  eq(canonicalStringify({ a: 1, b: undefined }), '{"a":1}', 'undefined property dropped');
  eq(canonicalStringify({ a: 1, b: () => 1 }), '{"a":1}', 'function property dropped');
  eq(canonicalStringify({ a: 1, b: Symbol('s') }), '{"a":1}', 'symbol property dropped');
  eq(canonicalStringify([1, undefined, 2]), '[1,null,2]', 'undefined array element → null');
  eq(canonicalStringify([1, () => 1]), '[1,null]', 'function array element → null');
  throwsCanonical(() => canonicalStringify(undefined), 'top-level undefined');
  throwsCanonical(() => canonicalStringify(() => 1), 'top-level function');
  throwsCanonical(() => canonicalStringify(Symbol('s')), 'top-level symbol');
});

test('13. non-finite numbers throw (never silently null)', () => {
  throwsCanonical(() => canonicalStringify(NaN), 'NaN');
  throwsCanonical(() => canonicalStringify(Infinity), 'Infinity');
  throwsCanonical(() => canonicalStringify({ x: -Infinity }), 'nested -Infinity');
  throwsCanonical(() => evidenceDigestOf({ x: NaN }), 'evidenceDigestOf NaN');
});

test('14. a throwing toJSON fails closed with the path', () => {
  const bad = { v: { toJSON: () => { throw new Error('boom'); } } };
  const e = throwsCanonical(() => canonicalStringify(bad), 'throwing toJSON');
  ok(e.message.includes('$.v'), `path named: ${e.message}`);
});

test('15. nesting deeper than the cap throws', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 150; i++) deep = { next: deep };
  throwsCanonical(() => canonicalStringify(deep), '150-deep nesting');
});

// ═══ 5. Legacy compatibility (exact break, documented) ══════════════════

test('16. legacy compat: already-sorted string-only fixtures are IDENTICAL', () => {
  const sorted = { a: 1, b: 2 };
  eq(evidenceDigestOf(sorted), legacyDigestOf(sorted), 'sorted keys → identical digest');
  const nestedSorted = { a: { x: 1, y: 2 }, b: [1, 2] };
  eq(evidenceDigestOf(nestedSorted), legacyDigestOf(nestedSorted), 'nested sorted → identical');
});

test('17. legacy compat: unsorted string-only fixtures DIFFER (sorted keys change them)', () => {
  // core.ts shape: { txHash, status } — insertion order is NOT sorted.
  const coreShape = { txHash: 'ab'.repeat(32), status: 'finalized' };
  notOk(evidenceDigestOf(coreShape) === legacyDigestOf(coreShape), 'core.ts shape digest changes');
  // The new digest equals the legacy digest of the ALREADY-SORTED form.
  eq(evidenceDigestOf(coreShape), legacyDigestOf({ status: 'finalized', txHash: 'ab'.repeat(32) }), 'new ≡ legacy-of-sorted-form');
  // reconcile.ts shape: { source, observed, raw } — also not sorted.
  const reconcileShape = { source: 'concordium-grpc', observed: 'finalized', raw: null };
  notOk(evidenceDigestOf(reconcileShape) === legacyDigestOf(reconcileShape), 'reconcile shape digest changes');
  eq(evidenceDigestOf(reconcileShape), legacyDigestOf({ observed: 'finalized', raw: null, source: 'concordium-grpc' }), 'new ≡ legacy-of-sorted-form');
});

// ═══ 6. Reconcile path no longer throws on live SDK responses ═══════════

test('18. ReconciliationService finalizes with a BigInt/rich-type raw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-digest-'));
  try {
    const db = join(dir, 'f.db');
    const repo = new SqliteSettlementRepository(db);
    const reqKey = requirementsKey(
      { network: CAIP2, payTo: PAY_TO, amount: '1', asset: 'CCD' },
      'http://127.0.0.1:4590/protected',
    );
    repo.claim(FINAL_DIGEST, reqKey);
    repo.prepare(FINAL_DIGEST, FINAL_TX);
    repo.claimSubmit(FINAL_DIGEST, FINAL_TX);
    repo.markBroadcast(FINAL_DIGEST, FINAL_TX);
    const verifier = {
      name: 'test-fake',
      verify: async () => ({
        available: true as const,
        observed: 'finalized' as const,
        source: 'concordium-grpc',
        raw: SDK_RAW_FINAL,
      }),
    };
    const svc = new ReconciliationService({ repository: repo, verifier });
    const out = await svc.reconcile({ paymentDigest: FINAL_DIGEST });
    ok(out.ok, `reconcile ok: ${JSON.stringify(out)}`);
    if (out.ok) {
      eq(out.state, 'finalized', 'state finalized');
      eq(out.changed, true, 'changed');
      eq(
        out.evidence.digest,
        evidenceDigestOf({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }),
        'stored digest is the canonical digest of the live-shaped evidence',
      );
    }
    const fin = repo.transitions(FINAL_DIGEST).find((t) => t.to_state === 'finalized');
    ok(fin, 'finalize transition recorded');
    if (fin && typeof fin.evidence === 'string') {
      const parsed = JSON.parse(fin.evidence) as { source: string; digest: string };
      eq(parsed.source, 'concordium-grpc', 'evidence source stored');
      eq(parsed.digest, evidenceDigestOf({ source: 'concordium-grpc', observed: 'finalized', raw: SDK_RAW_FINAL }), 'evidence digest stored');
    }
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
console.log(`\nevidence-digest: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
