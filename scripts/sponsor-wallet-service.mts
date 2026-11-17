/**
 * Sponsor signing-service launcher with secret injection.
 *
 * Configuration (preferred, environment-driven):
 *   FACILITATOR_SPONSOR_WALLET_FILE   absolute path to the wallet export
 *   FACILITATOR_SIGNING_SERVICE_SOCKET  absolute socket path
 *   FACILITATOR_SPONSOR_ADDRESS       sponsor base58check address
 *   FACILITATOR_NETWORK               CAIP-2 network
 *   FACILITATOR_SIGNING_SERVICE_UID   allowed peer UID
 *   FACILITATOR_MAX_ENERGY            optional: max energy (NRG) per signed tx (default 1000)
 *   FACILITATOR_MAX_FEE_MICROCCD      optional: max ESTIMATED sponsor fee (microCCD) per signed tx (default 10000000) — estimate-based policy only, not a guaranteed maximum actual chain fee (see energy.ts)
 *   SIGNING_OWNER_PUBLIC_KEY          required: Owner authorization public key (SPKI DER hex)
 *   SIGNING_OWNER_SOCKET              required: absolute path of the Owner authorization socket
 *   SIGNING_OWNER_UID                 required: Owner service UID (SO_PEERCRED peer check)
 *
 * The Owner authorization configuration is REQUIRED, not optional: the service
 * verifies an Owner authorization certificate and consumes the authorization
 * at the Owner before signing, and createSigningService throws without a
 * consume client. A missing/invalid Owner configuration refuses startup
 * (exit 2) before the wallet export is touched. Signing only ever happens
 * after a consumed Owner authorization — there is no fallback path that
 * signs without the Owner. If the Owner socket is unreachable or its peer
 * identity does not match SIGNING_OWNER_UID, every consume fails closed
 * (owner_unavailable / protocol_error) and no signing occurs.
 *
 * Legacy positional form is still accepted for the tests:
 *   npx tsx scripts/sponsor-wallet-service.mts <socket> <sponsor> <network> <uid> <export-path>
 *
 * The export is read BEFORE the socket is bound. Its contents are never logged or printed.
 * The file must be owned by the service user and must not be world-readable; otherwise the
 * service refuses to start. The export's address is cross-checked against
 * FACILITATOR_SPONSOR_ADDRESS before the signer is built: a mismatched export refuses
 * startup, so the service can never sign for an account it was not configured for.
 */

import { chmodSync, statSync } from 'node:fs';
import { loadSponsorExportSigner } from '../services/facilitator/src/walletExportLoader.js';
import { createSigningService, type SigningService } from '../services/facilitator/src/signingService.js';
import { IpcOwnerConsumeClient } from '../services/facilitator/src/ownerAuthorization.js';

interface Resolved {
  socketPath: string;
  sponsor: string;
  network: string;
  allowedUid: number;
  exportPath: string;
  source: 'env' | 'argv';
}

function fromEnv(env: Record<string, string | undefined>): Resolved | null {
  const socketPath = env['FACILITATOR_SIGNING_SERVICE_SOCKET'];
  const sponsor = env['FACILITATOR_SPONSOR_ADDRESS'];
  const network = env['FACILITATOR_NETWORK'];
  const uidRaw = env['FACILITATOR_SIGNING_SERVICE_UID'];
  const exportPath = env['FACILITATOR_SPONSOR_WALLET_FILE'];
  if (!socketPath || !sponsor || !network || !uidRaw || !exportPath) return null;
  return { socketPath, sponsor, network, allowedUid: Number(uidRaw), exportPath, source: 'env' };
}

function fromArgv(argv: string[]): Resolved | null {
  const [, , socketPath, sponsor, network, uidRaw, exportPath] = argv;
  if (!socketPath || !sponsor || !network || !uidRaw || !exportPath) return null;
  return { socketPath, sponsor, network, allowedUid: Number(uidRaw), exportPath, source: 'argv' };
}

function validateExportFile(path: string): string | null {
  if (!path.startsWith('/')) return 'wallet export path must be absolute';
  if (path.split('/').includes('..')) return 'wallet export path must not traverse';
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return 'wallet export file does not exist or is not readable';
  }
  if (!st.isFile()) return 'wallet export path is not a regular file';
  const mode = st.mode & 0o777;
  if (mode & 0o004) return `wallet export file is world-readable (mode=0o${mode.toString(8)})`;
  if (mode & 0o020) return `wallet export file is group-writable (mode=0o${mode.toString(8)})`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid && st.uid !== 0) {
    return 'wallet export file is not owned by the service user';
  }
  return null;
}

const resolved = fromEnv(process.env) ?? fromArgv(process.argv);
if (!resolved) {
  console.error(
    'missing configuration: set FACILITATOR_SPONSOR_WALLET_FILE, FACILITATOR_SIGNING_SERVICE_SOCKET, ' +
      'FACILITATOR_SPONSOR_ADDRESS, FACILITATOR_NETWORK, FACILITATOR_SIGNING_SERVICE_UID ' +
      '(or use the legacy positional form)',
  );
  process.exit(2);
}
if (!Number.isInteger(resolved.allowedUid) || resolved.allowedUid < 1) {
  console.error('allowed UID must be a positive integer');
  process.exit(2);
}
if (!resolved.socketPath.startsWith('/')) {
  console.error('socket path must be absolute');
  process.exit(2);
}

// Owner authorization verification is required, not optional. The service
// cannot verify authorization evidence without the Owner's public key,
// socket and UID, and createSigningService throws without a consume client —
// so refuse here, before the wallet export is touched. The Owner UID is the
// identity the consume client verifies client-side (SO_PEERCRED) on the
// Owner socket; the signing service itself never signs without a consumed
// authorization, and there is no fallback around the Owner.
const ownerPublicKey = process.env['SIGNING_OWNER_PUBLIC_KEY'];
const ownerSocket = process.env['SIGNING_OWNER_SOCKET'];
const ownerUidRaw = process.env['SIGNING_OWNER_UID'];
if (!ownerPublicKey || !ownerSocket || !ownerUidRaw) {
  console.error(
    'refusing to start: SIGNING_OWNER_PUBLIC_KEY, SIGNING_OWNER_SOCKET and SIGNING_OWNER_UID are required',
  );
  process.exit(2);
}
const ownerUid = Number(ownerUidRaw);
if (!Number.isInteger(ownerUid) || ownerUid < 1) {
  console.error('SIGNING_OWNER_UID must be a positive integer');
  process.exit(2);
}
if (!ownerSocket.startsWith('/')) {
  console.error('SIGNING_OWNER_SOCKET must be an absolute path');
  process.exit(2);
}
const ownerConsume = new IpcOwnerConsumeClient({ socketPath: ownerSocket, ownerUid });

const fileProblem = validateExportFile(resolved.exportPath);
if (fileProblem !== null) {
  console.error(`refusing to start: ${fileProblem}`);
  process.exit(1);
}

// Load before binding: a failure must prevent the service from starting.
// The loader only ever emits a generic message; neither the path nor the contents are logged.
// The export's address is cross-checked against the configured sponsor BEFORE the signer
// is built: a mismatched export refuses startup (exit 1).
let accountSigner;
try {
  accountSigner = loadSponsorExportSigner(resolved.exportPath, resolved.sponsor);
} catch (e) {
  console.error(`failed to load wallet export: ${(e as Error).message}`);
  process.exit(1);
}

// Optional caps for the signing service, mirroring the facilitator config defaults.
// Unset or empty means the default; a malformed value refuses startup (exit 2).
function parseCap(raw: string | undefined, name: string, fallback: bigint): bigint {
  if (raw === undefined || raw === '') return fallback;
  try {
    const v = BigInt(raw);
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    console.error(`${name} must be a non-negative integer`);
    process.exit(2);
  }
}

// Construction throws without a consume client and on an invalid Owner
// public key — refuse startup with a clean message, not an uncaught stack
// trace. A service that cannot verify Owner authorization must never reach
// listen().
let svc: SigningService;
try {
  svc = createSigningService({
    accountSigner,
    sponsorAddress: resolved.sponsor,
    network: resolved.network,
    allowedUid: resolved.allowedUid,
    maxEnergy: parseCap(process.env['FACILITATOR_MAX_ENERGY'], 'FACILITATOR_MAX_ENERGY', 1000n),
    maxFeeMicroCcd: parseCap(process.env['FACILITATOR_MAX_FEE_MICROCCD'], 'FACILITATOR_MAX_FEE_MICROCCD', 10_000_000n),
    ownerAuthorization: { publicKey: ownerPublicKey, consume: ownerConsume },
  });
} catch (e) {
  console.error(`refusing to start: ${(e as Error).message}`);
  process.exit(2);
}
await svc.listen(resolved.socketPath);
try {
  chmodSync(resolved.socketPath, 0o660);
} catch {
  /* non-fatal */
}

console.log(
  `service listening pid=${process.pid} uid=${process.getuid?.() ?? '?'} socket=${resolved.socketPath} signer=loaded source=${resolved.source}`,
);

const shutdown = async (): Promise<void> => {
  try {
    await svc.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await new Promise(() => {});
