/**
 * Canonical JSON serialization for evidence digests.
 *
 * `evidenceDigestOf` hashes evidence into the transitions audit log, so the
 * serialization must be a function of the evidence's CONTENT alone:
 * the same logical evidence always produces the same string (and therefore
 * the same digest), no matter how the value was constructed.
 *
 * Format (a strict subset of JSON, deterministic by construction):
 *
 *   - Object keys are sorted lexicographically (UTF-16 code-unit order) and
 *     the key order of the input is ignored. Array order is preserved.
 *   - `null`, booleans, and strings keep their JSON meaning. Strings are
 *     escaped with `JSON.stringify`.
 *   - Finite numbers serialize with `JSON.stringify` (so `1`, `1.5`, and
 *     `1e3` keep JSON's number grammar; `-0` serializes as `0`, as in JSON).
 *   - `bigint` serializes as a TAGGED object, `{"$bigint":"<decimal>"}`
 *     (e.g. `4800331n` → `{"$bigint":"4800331"}`). The tag keeps a bigint
 *     distinct from the plain string `"4800331"` and preserves full
 *     precision — a bigint beyond `Number.MAX_SAFE_INTEGER` never loses a
 *     bit. (A hand-crafted plain object with exactly the key `$bigint` and
 *     a string value would serialize identically; no SDK or node response
 *     produces such a shape, so the tag is unambiguous in this domain.)
 *   - `Uint8Array` (including `Buffer`) serializes as
 *     `{"$bytes":"<lowercase hex>"}`.
 *   - Objects with a `toJSON` function serialize as the canonical form of
 *     `toJSON()`'s result. This is JSON.stringify's own extension point,
 *     and it is how the Concordium SDK types normalize: `BlockHash` /
 *     `TransactionHash` → hex string, `AccountAddress` → base58 string,
 *     `CcdAmount` → its `microCcdAmount` as a decimal string (never the
 *     CCD-decimal `String()`), `Date` → ISO-8601 string. A `toJSON` result
 *     is canonicalized recursively, so a `toJSON` that returns a bigint or
 *     a nested object is still handled.
 *   - Objects without `toJSON` serialize structurally from their enumerable
 *     string-keyed entries (symbol keys are ignored, as in JSON). No value
 *     is ever rendered through `String()` / `toString()`: a plain object
 *     can never become the misleading string `"[object Object]"`, and no
 *     locale-dependent rendering (e.g. `Date.toString()`) can leak in.
 *   - `undefined`, functions, and symbols follow JSON.stringify: dropped
 *     as object properties, `null` as array elements. (Same as the repo's
 *     existing `canonicalise` in `store.ts`, which filters `undefined`.)
 *     A top-level `undefined`/function/symbol has nothing to hash and
 *     throws instead.
 *
 * Fail-closed (throws `CanonicalizationError`, never a silent lossy digest):
 *
 *   - Circular references (object or array reachable from itself), with
 *     the offending path in the message (e.g. `$.outcome.summary`).
 *   - Non-finite numbers (`NaN`, `Infinity`, `-Infinity`): JSON would
 *     silently render them as `null`, misrepresenting the evidence.
 *   - Nesting deeper than 100 levels (guards against stack exhaustion
 *     from a pathological node response).
 *   - A `toJSON` that throws propagates as a `CanonicalizationError`
 *     naming the path.
 *
 * Deliberately NOT reused from `store.ts`: that module's `canonicalise`
 * feeds `paymentDigest` (the settlement replay key) and must not change.
 * It also throws on bigint (via `JSON.stringify`) and has no circular
 * detection. Evidence digests are write-only audit pointers — stored in
 * `transitions.evidence` and read back only for display — so changing
 * this serialization affects only future rows, never historical ones and
 * never the settlement flow's behavior.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const MAX_DEPTH = 100;

const TAG_BIGINT = '$bigint';
const TAG_BYTES = '$bytes';

/**
 * Deterministic canonical serialization of any value. Throws
 * `CanonicalizationError` for values that cannot be represented
 * faithfully (circular, non-finite numbers, unhashable top level).
 */
export function canonicalStringify(value: unknown): string {
  const out = write(value, '$', 0, new Set());
  if (out === undefined) {
    throw new CanonicalizationError('cannot canonicalize a top-level undefined, function, or symbol value');
  }
  return out;
}

/**
 * Serialize one value. Returns `undefined` only for `undefined`/function/
 * symbol, meaning "omit this property" (object) or "null" (array) — the
 * caller decides. Every other input returns a string or throws.
 */
function write(value: unknown, path: string, depth: number, seen: Set<object>): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number at ${path} cannot be represented in canonical JSON`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `{"${TAG_BIGINT}":${JSON.stringify(value.toString())}}`;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
    default:
      return undefined;
  }

  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError(`nesting deeper than ${MAX_DEPTH} levels at ${path}`);
  }
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) {
    throw new CanonicalizationError(`circular reference at ${path}`);
  }

  // Uint8Array (including Buffer) → tagged lowercase hex.
  if (value instanceof Uint8Array) {
    return `{"${TAG_BYTES}":${JSON.stringify(Buffer.from(value).toString('hex'))}}`;
  }

  // toJSON is JSON.stringify's own extension point: the SDK's rich types
  // normalize through it (BlockHash → hex, AccountAddress → base58,
  // CcdAmount → microCCD decimal string, Date → ISO-8601).
  const toJson = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {
    seen.add(obj);
    try {
      const converted = (toJson as (this: unknown) => unknown).call(obj);
      return write(converted, path, depth + 1, seen);
    } catch (e) {
      if (e instanceof CanonicalizationError) throw e;
      throw new CanonicalizationError(`toJSON() failed at ${path}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      seen.delete(obj);
    }
  }

  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      // Array order is preserved. Unhashable elements become null (JSON).
      const parts = (value as unknown[]).map((el, i) => {
        const s = write(el, `${path}[${i}]`, depth + 1, seen);
        return s === undefined ? 'null' : s;
      });
      return `[${parts.join(',')}]`;
    }
    // Plain / structural objects: sorted keys, unhashable values dropped.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const s = write(obj[k], `${path}.${k}`, depth + 1, seen);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
