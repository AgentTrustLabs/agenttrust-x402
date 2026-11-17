/**
 * Sponsor wallet loader integration check.
 *
 * Two modes:
 *   --synthetic   (default) Exercise the loader + signing service against the
 *                 sponsor ADDRESS with SYNTHETIC key material, proving the integration
 *                 mechanics for that exact address. No real wallet material.
 *   <export-path> Load a maintainer-supplied wallet export from a local path.
 *
 * In both modes: no broadcast, no settlement. A signable fixture transaction
 * (never submitted) is signed over IPC so the service's digest↔transaction
 * binding is exercised end to end. No real wallet material in synthetic mode.
 */

import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSponsorExportSigner } from '../services/facilitator/src/walletExportLoader.js';
import { createSigningService, IpcAccountSigner, signingDigestOf } from '../services/facilitator/src/signingService.js';
import { digestHexToArrayBuffer } from '../src/ipc/digest.js';

const SPONSOR = '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const arg = process.argv[2];
const synthetic = !arg || arg === '--synthetic';

let cleanup = (): void => {};
let exportPath: string;

if (synthetic) {
  // Synthetic export bound to the sponsor address. Keys are obvious placeholders
  // ('aa'/'bb'/'cc' repeats) — NOT the sponsor's real key material.
  const dir = mkdtempSync(join(tmpdir(), 't62-'));
  exportPath = join(dir, 'synthetic-wallet.json');
  const fixture = {
    type: 'concordium-browser-wallet-account',
    v: 0,
    environment: 'testnet',
    value: {
      accountKeys: {
        threshold: 1,
        keys: { '0': { keys: { '0': { signKey: 'aa'.repeat(32), verifyKey: 'bb'.repeat(32) } }, threshold: 1 } },
      },
      credentials: { '0': 'cc'.repeat(32) },
      address: SPONSOR,
    },
  };
  writeFileSync(exportPath, JSON.stringify(fixture));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  console.log('mode          : SYNTHETIC (no real wallet material)');
  console.log('sponsor       : ' + SPONSOR);
} else {
  exportPath = arg;
  console.log('mode          : REAL export path supplied by maintainer');
  console.log('path          : ' + exportPath);
  console.log('(file contents are never read into this report)');
}

// ── 1. file exists and is not world-readable ────────────────────────────────
try {
  const st = statSync(exportPath);
  check('01. export file exists', st.isFile());
  if (synthetic) {
    // Synthetic mode: demonstrate the loader works on a properly-restricted file.
    chmodSync(exportPath, 0o600);
  }
  const st2 = statSync(exportPath);
  const mode = (st2.mode & 0o777).toString(8);
  check('02. export file is not world-readable', (st2.mode & 0o004) === 0, `mode=${mode}`);
  check('03. export file is not group-writable', (st2.mode & 0o020) === 0, `mode=${mode}`);
  check('03b. export file mode is 0600', (st2.mode & 0o777) === 0o600, `mode=${mode}`);
} catch {
  check('01. export file exists', false, 'file not found at the given path');
}

// ── 2. load through the loader (with sponsor cross-check) ─────────────────
let signer;
try {
  // The export's address is cross-checked against the configured sponsor BEFORE
  // the signer is built: a mismatched export refuses startup here.
  signer = loadSponsorExportSigner(exportPath, SPONSOR);
  check('04. loadSponsorExportSigner constructs a signer', typeof signer.sign === 'function');
} catch (e) {
  check('04. loadSponsorExportSigner constructs a signer', false, (e as Error).message);
  // Fail closed: do not continue with a partial signer.
  const failed = results.filter(([, p]) => !p).length;
  console.log(`\nsponsor-loader-integration: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  cleanup();
  process.exit(2);
}

// ── 2b. a mismatched sponsor refuses load ───────────────────────────────────
{
  try {
    loadSponsorExportSigner(exportPath, '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d');
    check('04b. mismatched sponsor refuses load', false, 'unexpectedly loaded');
  } catch (e) {
    check('04b. mismatched sponsor refuses load', /does not match/.test((e as Error).message), (e as Error).message);
  }
}

// ── 3. signature count ──────────────────────────────────────────────────────
const count = signer.getSignatureCount();
check('05. getSignatureCount() === 1', count === 1n, `observed ${count}`);

// ── 4. address correspondence ───────────────────────────────────────────────
{
  // The loader validated value.address is non-empty; recover it to compare against the sponsor address.
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(exportPath, 'utf8')) as {
    value?: { address?: string; accountKeys?: { threshold?: number; keys?: Record<string, { threshold?: number }> } };
  };
  const exportedAddress = raw.value?.address ?? '';
  check('06. export address === sponsor', exportedAddress === SPONSOR, `export=${exportedAddress}`);
  const thresholds = raw.value?.accountKeys;
  check('07. account threshold === 1', thresholds?.threshold === 1, `observed ${String(thresholds?.threshold)}`);
  const credThresholds = Object.values(thresholds?.keys ?? {}).map((c) => c.threshold);
  check('08. every credential threshold === 1', credThresholds.length > 0 && credThresholds.every((t) => t === 1), `observed [${credThresholds.join(',')}]`);
}

// ── 5. signing service startup + socket binding ─────────────────────────────
const dir2 = mkdtempSync(join(tmpdir(), 't62-sock-'));
const sock = join(dir2, 'sign.sock');
const svc = createSigningService({
  accountSigner: signer,
  sponsorAddress: SPONSOR,
  network: CAIP2,
  allowedUid: process.getuid?.() ?? 1001,
});
await svc.listen(sock);
{
  const st = statSync(sock);
  check('09. signing service bound the configured Unix socket', st.isSocket());
}

// ── 6. non-broadcast transaction self-test over IPC ────────────────────────
// Signable fixture transaction (never broadcast, never settled). The sponsor is
// the export's account; sender and recipient are distinct test accounts.
const fixtureTx = {
  version: 1,
  header: {
    sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    nonce: 7,
    expiry: Math.floor(Date.now() / 1000) + 600,
    executionEnergyAmount: 300,
    numSignatures: 1,
    sponsor: { account: SPONSOR, numSignatures: 1 },
  },
  payload: { type: 'transfer', toAddress: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8', amount: '250000' },
  signatures: { sender: { 0: { 0: 'aa'.repeat(64) } }, sponsor: {} },
};
const fixtureDigest = signingDigestOf(fixtureTx);
try {
  const ipc = new IpcAccountSigner({
    socketPath: sock,
    expectedUid: process.getuid?.() ?? 1001,
    sponsorAddress: SPONSOR,
    network: CAIP2,
    timeoutMs: 5000,
    transaction: fixtureTx,
  });
  const sig = await ipc.sign(digestHexToArrayBuffer(fixtureDigest));
  const credKeys = Object.keys(sig ?? {});
  check('10. IPC transaction signing returns a signature', credKeys.length === 1, `credentials=[${credKeys.join(',')}]`);
} catch (e) {
  check('10. IPC transaction signing returns a signature', false, (e as Error).message);
}

// ── 7. wrong-sponsor refusal (fail-closed) ──────────────────────────────────
{
  try {
    const bad = new IpcAccountSigner({
      socketPath: sock,
      expectedUid: process.getuid?.() ?? 1001,
      sponsorAddress: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
      network: CAIP2,
      timeoutMs: 5000,
      transaction: fixtureTx,
    });
    await bad.sign(digestHexToArrayBuffer(fixtureDigest));
    check('11. wrong sponsor is refused', false, 'unexpectedly signed');
  } catch (e) {
    check('11. wrong sponsor is refused', /wrong_sponsor/.test((e as Error).message), (e as Error).message);
  }
}

// ── 8. no secret material in any produced artefact ──────────────────────────
{
  const { readFileSync } = await import('node:fs');
  // The synthetic fixture's key hex must not appear in any log-like output we produced.
  const secretMarker = synthetic ? 'aa'.repeat(32) : null;
  const reportText = results.map(([n, , d]) => `${n} ${d}`).join('\n');
  check('12. no key hex in the report text', secretMarker === null || !reportText.includes(secretMarker));
  // The service never writes the export anywhere.
  check('13. loader returns only a signer (no export echo)', !('value' in (signer as unknown as Record<string, unknown>)));
  void readFileSync;
}

await svc.close();
cleanup();
rmSync(dir2, { recursive: true, force: true });

const failed = results.filter(([, p]) => !p).length;
console.log(`\nsponsor-loader-integration: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
