/**
 * Signing service child process (test harness).
 *
 * A real separate OS process that owns the Unix socket and holds the fake signer.
 * It never has key material — `createFakeSigner()` returns a deterministic signature.
 *
 * Usage: npx tsx scripts/signing-ipc-service.mts <socket-path> <sponsor> <network> <allowed-uid>
 */

import { createSigningService, createFakeSigner } from '../services/facilitator/src/signingService.js';
import { chmodSync } from 'node:fs';

const [socketPath, sponsor, network, allowedUidRaw] = process.argv.slice(2);
if (!socketPath || !sponsor || !network || !allowedUidRaw) {
  console.error('usage: signing-ipc-service.mts <socket-path> <sponsor> <network> <allowed-uid>');
  process.exit(2);
}
const allowedUid = Number(allowedUidRaw);

const signer = createFakeSigner({ signature: 'ee'.repeat(64) });
const svc = createSigningService({ accountSigner: signer, sponsorAddress: sponsor, network, allowedUid });

await svc.listen(socketPath);
try {
  chmodSync(socketPath, 0o660);
} catch {
  /* non-fatal */
}
console.log(`service listening pid=${process.pid} uid=${process.getuid?.() ?? '?'} socket=${socketPath}`);

const shutdown = async () => {
  try {
    await svc.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Healthy until killed.
await new Promise(() => {});
