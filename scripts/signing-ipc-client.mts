/**
 * Signing service client process (test harness).
 *
 * A real separate OS process that uses IpcAccountSigner to sign a digest. Prints the
 * signature (or error) as JSON on stdout and exits.
 *
 * Usage: npx tsx scripts/signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <hex-digest>
 */

import { IpcAccountSigner } from '../services/facilitator/src/signingService.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';

const [socketPath, sponsor, network, expectedUidRaw, digestHex] = process.argv.slice(2);
if (!socketPath || !sponsor || !network || !expectedUidRaw || !digestHex) {
  console.error('usage: signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <hex-digest>');
  process.exit(2);
}

let digestBuffer: ArrayBuffer;
try {
  digestBuffer = digestHexToArrayBuffer(digestHex);
} catch {
  console.error('usage: signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <hex-digest>');
  process.exit(2);
}

const client = new IpcAccountSigner({
  socketPath,
  expectedUid: Number(expectedUidRaw),
  sponsorAddress: sponsor,
  network,
  timeoutMs: 5_000,
});

try {
  const sig = await client.sign(digestBuffer);
  console.log(JSON.stringify({ ok: true, signature: sig[0]?.[0], pid: process.pid, uid: process.getuid?.() ?? null }));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: (e as Error).message, pid: process.pid, uid: process.getuid?.() ?? null }));
  process.exit(1);
}
