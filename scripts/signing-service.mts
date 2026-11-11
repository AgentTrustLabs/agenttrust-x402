/**
 * Signing service child process (test harness, real Ed25519 capable).
 *
 * A real separate OS process that owns the Unix socket and holds either the fake signer
 * (default, backward-compatible) or a real Ed25519 signer when
 * `TEST_SIGNING_SEED_HEX` is set to a 64-hex-char (32-byte) seed.
 *
 * The key is supplied out-of-band by the test process via the environment. It is never
 * logged, never written to disk by this script, and never appears in any output.
 *
 * Usage: npx tsx scripts/signing-service.mts <socket-path> <sponsor> <network> <allowed-uid>
 * Env:   TEST_SIGNING_SEED_HEX=<64 hex>   (optional; enables the real Ed25519 signer)
 */
import { createSigningService, createFakeSigner } from '../services/facilitator/src/signingService.js';
import { buildBasicAccountSigner } from '@concordium/web-sdk';
import { chmodSync } from 'node:fs';

const [socketPath, sponsor, network, allowedUidRaw] = process.argv.slice(2);
if (!socketPath || !sponsor || !network || !allowedUidRaw) {
  console.error('usage: signing-service.mts <socket-path> <sponsor> <network> <allowed-uid>');
  process.exit(2);
}
const allowedUid = Number(allowedUidRaw);

const testKey = process.env['TEST_SIGNING_SEED_HEX'];
let accountSigner: any;
let mode = 'fake';
if (testKey && /^[0-9a-fA-F]{64}$/.test(testKey)) {
  accountSigner = buildBasicAccountSigner(testKey as any);
  mode = 'ed25519';
} else {
  accountSigner = createFakeSigner({ signature: 'ee'.repeat(64) });
}

const svc = createSigningService({ accountSigner, sponsorAddress: sponsor, network, allowedUid });

await svc.listen(socketPath);
try {
  chmodSync(socketPath, 0o660);
} catch {
  /* non-fatal */
}
console.log(`service listening pid=${process.pid} uid=${process.getuid?.() ?? '?'} socket=${socketPath} mode=${mode}`);

const shutdown = async () => {
  try {
    await svc.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await new Promise(() => {});
