import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = '/home/daytona/sponsored-wallet';
const WALLET = 'https://wallet.test.local';
const PARENT = 'https://app.test.local';
let pass = 0;
function run(env, extra = {}) {
  return spawnSync(process.execPath, ['scripts/build-production-config.mjs'], { cwd: root, env: { ...process.env, ...env, ...extra }, encoding: 'utf8' });
}
function expectFail(name, env, reasonFragment) {
  const r = run(env);
  const ok = r.status !== 0 && (!reasonFragment || (r.stderr || '').includes(reasonFragment));
  console.log(ok ? 'PASS' : 'FAIL', name);
  if (ok) pass++;
}
expectFail('missing env fails', {}, 'WALLET_ORIGIN');
expectFail('http origin fails', { WALLET_ORIGIN: 'http://wallet.test.local', WALLET_PARENT_ORIGINS: PARENT }, 'explicit HTTPS');
expectFail('wildcard fails', { WALLET_ORIGIN: 'https://*.test.local', WALLET_PARENT_ORIGINS: PARENT }, 'explicit HTTPS');
expectFail('parent equals wallet fails', { WALLET_ORIGIN: WALLET, WALLET_PARENT_ORIGINS: WALLET }, 'differ from wallet');
expectFail('callback differs fails', { WALLET_ORIGIN: WALLET, WALLET_PARENT_ORIGINS: PARENT, WALLET_CALLBACK_ORIGIN: 'https://cb.test.local' }, 'equal wallet origin');
const tmp = mkdtempSync(join(tmpdir(), 'ccd-chain-'));
const badChain = join(tmp, 'bad.json');
import('node:fs').then(fs => {
  fs.writeFileSync(badChain, JSON.stringify({ network: 'Mainnet', globalContext: { genesisString: 'x' } }));
  expectFail('non-testnet chain fails', { WALLET_ORIGIN: WALLET, WALLET_PARENT_ORIGINS: PARENT, WALLET_CHAIN_CONFIG: badChain }, 'Testnet');

  const r = run({ WALLET_ORIGIN: WALLET, WALLET_PARENT_ORIGINS: PARENT, WALLET_CALLBACK_ORIGIN: WALLET });
  console.log(r.status === 0 ? 'PASS valid config builds' : 'FAIL valid config builds');
  if (r.status === 0) pass++;
  const files = ['wallet-config.js', 'callback-config.js', 'issuance-config.js', 'callback.js', 'index.html', 'identity/callback/index.html'];
  for (const f of files) {
    const ok = existsSync(join(root, 'dist/wallet-context', f));
    console.log(ok ? 'PASS' : 'FAIL', 'output exists', f);
    if (ok) pass++;
  }
  const all = files.map(f => readFileSync(join(root, 'dist/wallet-context', f), 'utf8')).join('\n');
  const secretScan = !/wallet\.example|BEGIN PRIVATE KEY|seedHex|ab{128}/i.test(all);
  console.log(secretScan ? 'PASS no secret/placeholder in output' : 'FAIL secret/placeholder in output');
  if (secretScan) pass++;
  const cb = readFileSync(join(root, 'dist/wallet-context/callback-config.js'), 'utf8');
  const cbOk = cb.includes(WALLET) && cb.includes('window.__CALLBACK_CONFIG__');
  console.log(cbOk ? 'PASS callback config exact origin' : 'FAIL callback config');
  if (cbOk) pass++;
  const maps = [];
  (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.map')) maps.push(p); } })(join(root, 'dist'));
  console.log(maps.length === 0 ? 'PASS no source maps in dist' : 'FAIL source maps');
  if (maps.length === 0) pass++;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`wallet-production-build: ${pass} checks passed`);
  process.exit(0);
});
