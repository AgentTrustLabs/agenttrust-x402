/**
 * Signing service child process (test harness).
 *
 * A real separate OS process that owns the Unix socket and holds the fake signer.
 * It never has key material — `createFakeSigner()` returns a deterministic signature.
 *
 * Task 11: the service verifies an Owner authorization certificate and consumes
 * the authorization at the Owner before signing. The Owner's public key, socket
 * and UID are REQUIRED (exit 2 when unset).
 *
 * Usage: npx tsx scripts/signing-ipc-service.mts <socket-path> <sponsor> <network> <allowed-uid>
 * Env:   SIGNING_OWNER_PUBLIC_KEY=<SPKI DER hex>  (required)
 *        SIGNING_OWNER_SOCKET=<owner socket path> (required)
 *        SIGNING_OWNER_UID=<owner uid>            (required)
 */

import { createSigningService, createFakeSigner } from '../services/facilitator/src/signingService.js';
import { IpcOwnerConsumeClient } from '../services/facilitator/src/ownerAuthorization.js';
import { chmodSync } from 'node:fs';

const [socketPath, sponsor, network, allowedUidRaw] = process.argv.slice(2);
if (!socketPath || !sponsor || !network || !allowedUidRaw) {
  console.error('usage: signing-ipc-service.mts <socket-path> <sponsor> <network> <allowed-uid>');
  process.exit(2);
}
const allowedUid = Number(allowedUidRaw);

const ownerPublicKey = process.env['SIGNING_OWNER_PUBLIC_KEY'];
const ownerSocket = process.env['SIGNING_OWNER_SOCKET'];
const ownerUidRaw = process.env['SIGNING_OWNER_UID'];
if (!ownerPublicKey || !ownerSocket || !ownerUidRaw) {
  console.error('refusing to start: SIGNING_OWNER_PUBLIC_KEY, SIGNING_OWNER_SOCKET and SIGNING_OWNER_UID are required (Task 11)');
  process.exit(2);
}
const ownerConsume = new IpcOwnerConsumeClient({ socketPath: ownerSocket, ownerUid: Number(ownerUidRaw) });

const signer = createFakeSigner({ signature: 'ee'.repeat(64) });
const svc = createSigningService({
  accountSigner: signer,
  sponsorAddress: sponsor,
  network,
  allowedUid,
  ownerAuthorization: { publicKey: ownerPublicKey, consume: ownerConsume },
});

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
