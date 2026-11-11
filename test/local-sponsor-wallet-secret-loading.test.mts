/**
 * Local sponsor wallet secret loading (synthetic fixtures only).
 *
 * No real wallet material is used. SDK parser/builder are exercised via test
 * doubles where the task requires, and with a synthetic in-memory export where
 * a real-ish shape is needed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWalletExportSigner, WalletExportError } from '../services/facilitator/src/walletExportLoader.js';
import { createSigningService } from '../services/facilitator/src/signingService.js';
import { createFakeSigner } from '../services/facilitator/src/signingService.js';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ok = (v: unknown, m: string) => check(m, Boolean(v));
const eq = (a: unknown, b: unknown, m: string): void => {
  const norm = (v: unknown): string =>
    typeof v === 'bigint' ? `${v}n` : JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val));
  check(m, norm(a) === norm(b), `expected ${norm(b)}, got ${norm(a)}`);
};

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `t57-${tag}-`));
  return { dir, file: join(dir, 'wallet.json'), rm: () => rmSync(dir, { recursive: true, force: true }) };
};

// A synthetic export matching the SDK's WalletExportFormat shape. No real key material.
const syntheticExport = {
  type: 'walletExport',
  v: 1,
  environment: 'testnet',
  value: {
    address: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    accountKeys: {
      threshold: 1,
      keys: {
        '0': { threshold: 1, keys: { '0': { signKey: 'aa'.repeat(32), verifyKey: 'bb'.repeat(32) } } },
      },
    },
    credentials: { '0': 'cc'.repeat(32) },
  },
};

// A test-double AccountSigner.
function doubleSigner() {
  return {
    async sign(digest: ArrayBuffer) {
      return { 0: { 0: 'dd'.repeat(64) } } as never;
    },
    getSignatureCount() {
      return 1n;
    },
  };
}

console.log('\n── 1. valid synthetic export reaches the injected parser/builder ──');

{
  const w = tmp('valid');
  const path = w.file;
  const raw = JSON.stringify(syntheticExport);
  writeFileSync(path, raw);

  let parsedCalled = 0;
  let builtCalled = 0;
  let receivedRaw = '';
  const signer = loadWalletExportSigner(path, {
    readFile: (p) => {
      ok(p === path, 'readFile called with the configured path');
      return raw;
    },
    parseWallet: (r) => {
      parsedCalled++;
      receivedRaw = r;
      return syntheticExport as never;
    },
    buildAccountSigner: (exp) => {
      builtCalled++;
      ok((exp as { value: { address: string } }).value.address === syntheticExport.value.address, 'builder received the parsed export');
      return doubleSigner() as never;
    },
  });
  ok(signer !== null, '01. signer constructed');
  ok(typeof signer.sign === 'function', '02. signer has sign()');
  ok(typeof signer.getSignatureCount === 'function', '03. signer has getSignatureCount()');
  eq(parsedCalled, 1, '04. parser called exactly once');
  eq(builtCalled, 1, '05. builder called exactly once');
  eq(receivedRaw.length, raw.length, '06. parser received the file contents verbatim (length match, contents not echoed)');
  w.rm();
}

console.log('\n── 2. SDK signer construction succeeds with a test double ──');

{
  const w = tmp('sdk');
  writeFileSync(w.file, JSON.stringify(syntheticExport));
  const signer = loadWalletExportSigner(w.file, {
    parseWallet: () => syntheticExport as never,
    buildAccountSigner: () => doubleSigner() as never,
  });
  const sig = await signer.sign(new ArrayBuffer(32));
  ok(sig !== null, '07. constructed signer can sign');
  eq(signer.getSignatureCount(), 1n, '08. signature count is 1');
  w.rm();
}

console.log('\n── 3. missing export path fails closed ──');

{
  let msg = '';
  try { loadWalletExportSigner(''); } catch (e) { msg = (e as Error).message; }
  ok(msg.length > 0 && /path is required/i.test(msg), `09. empty path rejected: "${msg}"`);
  let msg2 = '';
  try { loadWalletExportSigner('   '); } catch (e) { msg2 = (e as Error).message; }
  ok(/path is required/i.test(msg2), `10. whitespace path rejected: "${msg2}"`);
}

console.log('\n── 4. missing file fails closed ──');

{
  const w = tmp('missing');
  const missing = join(w.dir, 'does-not-exist.json');
  let msg = '';
  let threw = false;
  try { loadWalletExportSigner(missing); } catch (e) { threw = true; msg = (e as Error).message; }
  ok(threw, '11. missing file throws');
  ok(/could not be read/i.test(msg), `12. missing file error is generic: "${msg}"`);
  w.rm();
}

console.log('\n── 5. malformed export fails closed ──');

{
  const w = tmp('malformed');
  // Not JSON at all
  writeFileSync(w.file, '{ this is not json');
  let msg = '';
  try { loadWalletExportSigner(w.file, { parseWallet: () => { throw new Error('parse failed'); } }); } catch (e) { msg = (e as Error).message; }
  ok(/could not be parsed/i.test(msg), `13. malformed JSON rejected: "${msg}"`);

  // Valid JSON but wrong shape
  writeFileSync(w.file, JSON.stringify({ foo: 'bar' }));
  let msg2 = '';
  try { loadWalletExportSigner(w.file); } catch (e) { msg2 = (e as Error).message; }
  ok(msg2.length > 0, `14. wrong shape rejected: "${msg2}"`);
  w.rm();
}

console.log('\n── 6. unsupported credential / threshold fails closed ──');

{
  const w = tmp('thresh');

  const exportWith = (accountKeys: unknown) => ({
    ...syntheticExport,
    value: { ...syntheticExport.value, accountKeys },
  });

  // account threshold 2 (unsupported for the sponsor account)
  const bad1 = exportWith({ threshold: 2, keys: syntheticExport.value.accountKeys.keys });
  writeFileSync(w.file, JSON.stringify(bad1));
  let msg = '';
  try { loadWalletExportSigner(w.file); } catch (e) { msg = (e as Error).message; }
  ok(/account threshold must be 1/i.test(msg), `15. account threshold 2 rejected: "${msg}"`);

  // credential threshold 2
  const credTwo = { threshold: 2, keys: { '0': { signKey: 'aa'.repeat(32), verifyKey: 'bb'.repeat(32) } } };
  const bad2 = exportWith({ threshold: 1, keys: { '0': credTwo } });
  writeFileSync(w.file, JSON.stringify(bad2));
  let msg2 = '';
  try { loadWalletExportSigner(w.file); } catch (e) { msg2 = (e as Error).message; }
  ok(/credential threshold must be 1/i.test(msg2), `16. credential threshold 2 rejected: "${msg2}"`);

  // no credentials
  const bad3 = { ...syntheticExport, value: { ...syntheticExport.value, accountKeys: { threshold: 1, keys: {} } } };
  writeFileSync(w.file, JSON.stringify(bad3));
  let msg3 = '';
  try { loadWalletExportSigner(w.file); } catch (e) { msg3 = (e as Error).message; }
  ok(/no credentials/i.test(msg3), `17. empty credentials rejected: "${msg3}"`);

  // signer construction throws
  writeFileSync(w.file, JSON.stringify(syntheticExport));
  let msg4 = '';
  try {
    loadWalletExportSigner(w.file, {
      parseWallet: () => syntheticExport as never,
      buildAccountSigner: () => { throw new Error('boom: secret=abc123'); },
    });
  } catch (e) { msg4 = (e as Error).message; }
  ok(/signer construction failed/i.test(msg4), `18. builder throw → generic error: "${msg4}"`);
  ok(!/secret=abc123/i.test(msg4), '19. secret content is not leaked in the error');
  w.rm();
}

console.log('\n── 7. secret isolation ──');

{
  const w = tmp('secret');
  const secret = 'SUPERSECRETSEED_' + 'x'.repeat(32);
  const secretCred = { threshold: 1, keys: { '0': { signKey: secret, verifyKey: 'bb'.repeat(32) } } };
  const exportWithSecret = {
    ...syntheticExport,
    value: { ...syntheticExport.value, accountKeys: { threshold: 1, keys: { '0': secretCred } } },
  };
  writeFileSync(w.file, JSON.stringify(exportWithSecret));
  let msg = '';
  try {
    loadWalletExportSigner(w.file, {
      parseWallet: () => exportWithSecret as never,
      buildAccountSigner: () => { throw new Error(`failed: ${secret}`); },
    });
  } catch (e) { msg = (e as Error).message; }
  ok(!msg.includes(secret), '20. secret is not present in the thrown error');
  // Also confirm the generic parse path does not echo the raw file.
  let msg2 = '';
  try {
    loadWalletExportSigner(w.file, {
      parseWallet: () => { throw new Error('parse boom'); },
    });
  } catch (e) { msg2 = (e as Error).message; }
  ok(!msg2.includes(secret), '21. secret is not present in the parse error');
  w.rm();
}

console.log('\n── 8. integration with the signing service (test double) ──');

{
  const w = tmp('integ');
  writeFileSync(w.file, JSON.stringify(syntheticExport));
  const signer = loadWalletExportSigner(w.file, {
    parseWallet: () => syntheticExport as never,
    buildAccountSigner: () => doubleSigner() as never,
  });
  const svc = createSigningService({
    accountSigner: signer as never,
    sponsorAddress: syntheticExport.value.address,
    network: CAIP2,
    allowedUid: 1001,
  });
  const res = await svc.sign({
    protocolVersion: 1,
    requestId: 'r1',
    operation: 'sign',
    digest: 'a'.repeat(64),
    sponsor: syntheticExport.value.address,
    network: CAIP2,
  });
  ok(res.outcome === 'signed', `22. signing service signs with the loaded signer: ${res.outcome}`);
  ok(res.signature !== null, '23. a signature was produced');
  w.rm();
}

console.log('\n── 9. signing service does not start with a failed load ──');

{
  const w = tmp('failstart');
  // No file at all → loadWalletExportSigner throws → no signer → no service.
  let signer: unknown;
  let threw = false;
  try {
    signer = loadWalletExportSigner(join(w.dir, 'missing.json'));
  } catch {
    threw = true;
  }
  ok(threw, '24. load fails closed');
  ok(signer === undefined, '25. no signer object is produced on failure');
  w.rm();
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\nlocal-sponsor-wallet-secret-loading: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
