/**
 * TASK 57 / TASK 64 — sponsor signing-service launcher with secret injection.
 *
 * Configuration (preferred, environment-driven):
 *   FACILITATOR_SPONSOR_WALLET_FILE   absolute path to the wallet export
 *   FACILITATOR_SIGNING_SERVICE_SOCKET  absolute socket path
 *   FACILITATOR_SPONSOR_ADDRESS       sponsor base58check address
 *   FACILITATOR_NETWORK               CAIP-2 network
 *   FACILITATOR_SIGNING_SERVICE_UID   allowed peer UID
 *
 * Legacy positional form is still accepted for the TASK57 tests:
 *   npx tsx scripts/task57-wallet-service.mts <socket> <sponsor> <network> <uid> <export-path>
 *
 * The export is read BEFORE the socket is bound. Its contents are never logged or printed.
 * The file must be owned by the service user and must not be world-readable; otherwise the
 * service refuses to start.
 */

import { chmodSync, statSync } from 'node:fs';
import { loadWalletExportSigner } from '../services/facilitator/src/walletExportLoader.js';
import { createSigningService } from '../services/facilitator/src/signingService.js';

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

const fileProblem = validateExportFile(resolved.exportPath);
if (fileProblem !== null) {
  console.error(`refusing to start: ${fileProblem}`);
  process.exit(1);
}

// Load before binding: a failure must prevent the service from starting.
// The loader only ever emits a generic message; neither the path nor the contents are logged.
let accountSigner;
try {
  accountSigner = loadWalletExportSigner(resolved.exportPath);
} catch (e) {
  console.error(`failed to load wallet export: ${(e as Error).message}`);
  process.exit(1);
}

const svc = createSigningService({
  accountSigner,
  sponsorAddress: resolved.sponsor,
  network: resolved.network,
  allowedUid: resolved.allowedUid,
});
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
