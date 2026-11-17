/**
 * Signing service client process (test harness).
 *
 * A real separate OS process that uses IpcAccountSigner to sign a transaction.
 * Prints the signature (or error) as JSON on stdout and exits.
 *
 * Usage: npx tsx scripts/signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <tx-json-file> [cert-json-file] [payment-digest]
 *
 * The transaction file holds a signable V1 transaction JSON. Its digest is
 * recomputed here (protocol v2 binding) and the transaction is bound to the IPC
 * signer, so the service validates the digest against the transaction it parses.
 * No bare digest is ever sent.
 *
 * Protocol v3: signing also requires an Owner authorization
 * certificate and the payment digest it belongs to. Pass the certificate as a
 * JSON file ([cert-json-file]); the payment digest defaults to the
 * certificate's paymentDigest. Without a certificate the signer refuses
 * client-side, before any IPC.
 */

import { readFileSync } from 'node:fs';
import { IpcAccountSigner, signingDigestOf } from '../services/facilitator/src/signingService.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';
import type { OwnerAuthorizationCertificate } from '../services/facilitator/src/ownerAuthorization.js';

const [socketPath, sponsor, network, expectedUidRaw, txFile, certFile, paymentDigestArg] = process.argv.slice(2);
if (!socketPath || !sponsor || !network || !expectedUidRaw || !txFile) {
  console.error('usage: signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <tx-json-file> [cert-json-file] [payment-digest]');
  process.exit(2);
}

let transaction: unknown;
try {
  transaction = JSON.parse(readFileSync(txFile, 'utf8'));
} catch {
  console.error('usage: signing-ipc-client.mts <socket-path> <sponsor> <network> <expected-uid> <tx-json-file> [cert-json-file] [payment-digest]');
  process.exit(2);
}

let authorization: OwnerAuthorizationCertificate | undefined;
let paymentDigest: string | undefined = paymentDigestArg;
if (certFile) {
  try {
    authorization = JSON.parse(readFileSync(certFile, 'utf8')) as OwnerAuthorizationCertificate;
  } catch {
    console.error('cert file is not valid JSON');
    process.exit(2);
  }
  paymentDigest ??= authorization.paymentDigest;
}

let digestBuffer: ArrayBuffer;
try {
  digestBuffer = digestHexToArrayBuffer(signingDigestOf(transaction));
} catch {
  console.error('tx file is not a valid signable V1 transaction');
  process.exit(2);
}

const client = new IpcAccountSigner({
  socketPath,
  expectedUid: Number(expectedUidRaw),
  sponsorAddress: sponsor,
  network,
  timeoutMs: 5_000,
  transaction,
  ...(authorization !== undefined ? { authorization } : {}),
  ...(paymentDigest !== undefined ? { paymentDigest } : {}),
});

try {
  const sig = await client.sign(digestBuffer);
  console.log(JSON.stringify({ ok: true, signature: sig[0]?.[0], pid: process.pid, uid: process.getuid?.() ?? null }));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: (e as Error).message, pid: process.pid, uid: process.getuid?.() ?? null }));
  process.exit(1);
}
