/**
 * Regression and unit tests for IPC digest hex-to-ArrayBuffer conversion.
 */

import { eq, ok, throws } from './helpers.mjs';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';

console.log('── ipc-digest ──');

// 1. Regression: shared Buffer pool contamination when byteOffset > 0
{
  const poison = Buffer.from('aa'.repeat(64), 'hex');
  const digestHex = '1234567890abcdef'.repeat(4);
  const pooled = Buffer.from(digestHex, 'hex');
  ok(pooled.buffer === poison.buffer && pooled.byteOffset > 0, 'test setup allocates from shared slab at non-zero byteOffset');

  // Old buggy expression: slices [0, 32] of the underlying pool ArrayBuffer instead of [byteOffset, byteOffset + 32]
  const buggySlice = pooled.buffer.slice(0, 32);
  const buggyHex = Buffer.from(buggySlice).toString('hex');
  ok(buggyHex !== digestHex, 'old .buffer.slice(0, 32) reads contaminated pool prefix instead of digest');

  // Fixed helper: slices exact [byteOffset, byteOffset + byteLength]
  const fixed = digestHexToArrayBuffer(digestHex);
  eq(fixed.byteLength, 32, 'helper returns 32-byte ArrayBuffer');
  eq(Buffer.from(fixed).toString('hex'), digestHex, 'helper preserves exact digest bytes despite pool offset');
}

// 2. Valid 64-hex digests (lowercase, uppercase, mixed) round-trip byte-exactly
{
  const lower = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const upper = lower.toUpperCase();
  const mixed = '0123456789AbCdEf0123456789aBcDeF0123456789ABCDEF0123456789abcdef';

  for (const candidate of [lower, upper, mixed]) {
    const ab = digestHexToArrayBuffer(candidate);
    eq(ab.byteLength, 32, `valid digest (${candidate.slice(0, 6)}...) has byteLength 32`);
    eq(Buffer.from(ab).toString('hex'), lower, 'round-trips byte-exactly to canonical hex');
  }
}

// 3. Invalid inputs rejected
{
  const invalidInputs: unknown[] = [
    '',
    'abc',
    '00'.repeat(31), // 62 chars
    '00'.repeat(33), // 66 chars
    '0'.repeat(63),  // odd length
    'zz'.repeat(32), // non-hex chars
    '00'.repeat(31) + '0g',
    null,
    undefined,
    12345,
    {},
    [],
  ];
  for (const bad of invalidInputs) {
    throws(
      () => digestHexToArrayBuffer(bad as string),
      '64-character hex',
      `rejects invalid digest input: ${JSON.stringify(bad)}`,
    );
  }
}

// 4. Edge cases: all-zero, all-ff, and digest coinciding with pool prefix bytes
{
  const zeroHex = '00'.repeat(32);
  const ffHex = 'ff'.repeat(32);
  const poolMatchHex = 'aa'.repeat(32);

  for (const hex of [zeroHex, ffHex, poolMatchHex]) {
    const ab = digestHexToArrayBuffer(hex);
    eq(ab.byteLength, 32, `edge digest ${hex.slice(0, 4)}... length is 32`);
    eq(Buffer.from(ab).toString('hex'), hex, `edge digest ${hex.slice(0, 4)}... matches byte-for-byte`);
  }
}

console.log("ipc-digest: 4 sections passed");
