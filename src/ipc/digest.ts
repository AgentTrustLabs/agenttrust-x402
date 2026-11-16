/**
 * Safe hex-digest to ArrayBuffer conversion for IPC signing requests.
 *
 * `Buffer.from(hex, 'hex')` allocates small buffers from Node's shared slab pool,
 * so `bytes.buffer` is the underlying pool ArrayBuffer with a non-zero `byteOffset`.
 * Slicing must bound by `[byteOffset, byteOffset + byteLength]`, never `[0, 32]`.
 */

const DIGEST_HEX_RE = /^[0-9a-fA-F]{64}$/;

export function digestHexToArrayBuffer(digestHex: string): ArrayBuffer {
  if (typeof digestHex !== 'string' || !DIGEST_HEX_RE.test(digestHex)) {
    throw new Error('digest must be a 64-character hex string (32 bytes)');
  }
  const bytes = Buffer.from(digestHex, 'hex');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
