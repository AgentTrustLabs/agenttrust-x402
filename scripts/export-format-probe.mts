/**
 * Export-format compatibility probe (read-only, synthetic fixtures only).
 *
 * Confirms, against the REAL SDK 12.0.2 `parseWallet` / `buildAccountSigner`, which
 * documented export shapes are accepted by `loadWalletExportSigner` and which are not.
 * No real wallet material is used.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWallet } from '@concordium/web-sdk';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 't60-'));
const file = join(dir, 'w.json');

/** Documented single-account export from Concordium Wallet for Web / mobile. */
const webExport = {
  type: 'concordium-browser-wallet-account',
  v: 0,
  environment: 'testnet',
  value: {
    accountKeys: {
      threshold: 1,
      keys: { '0': { keys: { '0': { signKey: 'aa'.repeat(32), verifyKey: 'bb'.repeat(32) } }, threshold: 1 } },
    },
    credentials: { '0': 'cc'.repeat(32) },
    address: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
  },
};

console.log('── A. parseWallet accepts the documented web/mobile single-account export ──');
try {
  const parsed = parseWallet(JSON.stringify(webExport)) as Record<string, unknown>;
  check('A1. parseWallet accepts concordium-browser-wallet-account', true);
  check('A2. parsed type preserved', parsed['type'] === 'concordium-browser-wallet-account');
  check('A3. parsed environment is testnet', parsed['environment'] === 'testnet');
  const value = parsed['value'] as Record<string, unknown>;
  check('A4. parsed address present', typeof value['address'] === 'string');
  check('A5. parsed accountKeys present', typeof value['accountKeys'] === 'object');
  check('A6. parsed credentials present', typeof value['credentials'] === 'object');
} catch (e) {
  check('A1. parseWallet accepts concordium-browser-wallet-account', false, (e as Error).message);
}

console.log('\n── B. plain {address, credentials, accountKeys} (concordium-client shape) ──');
try {
  parseWallet(JSON.stringify({ address: webExport.value.address, credentials: { '0': 'cc'.repeat(32) }, accountKeys: webExport.value.accountKeys }));
  check('B1. parseWallet accepts a bare account object', false, 'unexpectedly accepted');
} catch (e) {
  check('B1. parseWallet rejects a bare account object (use parseSimpleWallet + buildAccountSigner)', true);
}

console.log('\n── C. Desktop Wallet encrypted backup shape is rejected ──');
{
  // Desktop Wallet "Export/Import" backup: encrypted, identities + accounts, no top-level type/v.
  const desktopBackup = {
    v: 1,
    type: 'concordium-desktop-wallet-backup',
    cipherText: 'deadbeef',
    metadata: { encryptionMethod: 'AES-256', keyDerivationMethod: 'PBKDF2WithHmacSHA256' },
    accounts: [],
  };
  let message = '';
  let threw = false;
  try {
    parseWallet(JSON.stringify(desktopBackup));
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  check('C1. Desktop encrypted backup is rejected by parseWallet', threw, message.slice(0, 90));
}

console.log('\n── D. multi-sig credentials file shape is rejected ──');
{
  const credsFile = { keys: { '0': { verifyKey: 'bb'.repeat(32) } }, threshold: 2 };
  let threw = false;
  let message = '';
  try {
    parseWallet(JSON.stringify(credsFile));
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  check('D1. credentials file rejected (no value/type)', threw, message.slice(0, 90));
}

console.log('\n── E. private-key hex is not a wallet export ──');
{
  let threw = false;
  try {
    parseWallet(JSON.stringify('aa'.repeat(32)));
  } catch (e) {
    threw = true;
  }
  check('E1. a bare hex string is rejected by parseWallet', threw);
}

console.log('\n── F. loadWalletExportSigner end-to-end with the documented shape ──');
{
  const { loadWalletExportSigner } = await import('../services/facilitator/src/walletExportLoader.js');
  writeFileSync(file, JSON.stringify(webExport));
  try {
    const signer = loadWalletExportSigner(file);
    check('F1. loader constructs a signer from the documented export', typeof signer.sign === 'function');
    check('F2. getSignatureCount is 1 for a single-key sponsor', signer.getSignatureCount() === 1n);
  } catch (e) {
    check('F1. loader constructs a signer from the documented export', false, (e as Error).message);
  }
}

console.log('\n── G. loader rejects a desktop-backup file ──');
{
  const { loadWalletExportSigner } = await import('../services/facilitator/src/walletExportLoader.js');
  writeFileSync(file, JSON.stringify({ v: 1, type: 'x', cipherText: 'deadbeef', accounts: [] }));
  let threw = false;
  let message = '';
  try {
    loadWalletExportSigner(file);
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  check('G1. loader rejects an incompatible export', threw, message);
  check('G2. rejection message is generic (no contents)', !/deadbeef/.test(message));
}

rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, p]) => !p).length;
console.log(`\nexport-format-probe: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
