import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = '/home/daytona/sponsored-wallet';
const env = {
  ...process.env,
  AGENTTRUST_SITE_ORIGIN: 'https://app.test.local:4592',
  AGENTTRUST_WALLET_ORIGIN: 'https://wallet.test.local:4592',
};
let pass = 0;
function run(extra) { return spawnSync(process.execPath, ['web/build.mjs'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }); }
function ok(v, name) { console.log(v ? 'PASS' : 'FAIL', name); if (v) pass++; }
const build = run({});
ok(build.status === 0, 'demo web build rc=0');
for (const f of ['index.html', 'x402-checkout.js', 'demo-wallet.js', 'three.module.js', 'wallet-context/index.html', 'wallet/parentClient.js', 'identity/callback/index.html']) {
  ok(existsSync(join(root, 'web/dist', f)), 'asset ' + f);
}
const index = readFileSync(join(root, 'web/dist/index.html'), 'utf8');
ok(!index.includes('__AGENTTRUST_WALLET_ORIGIN__'), 'wallet placeholder replaced');
ok(!index.includes('__AGENTTRUST_API_BASE_URL__'), 'api placeholder replaced');
const walletCfg = readFileSync(join(root, 'web/dist/wallet-config.js'), 'utf8');
const cbCfg = readFileSync(join(root, 'web/dist/callback-config.js'), 'utf8');
ok(walletCfg.includes('https://app.test.local:4592') && !walletCfg.includes('https://wallet.test.local:4592'), 'wallet allowlist only parent');
ok(cbCfg.includes('https://wallet.test.local:4592'), 'callback config same as wallet');
const all = ['index.html', 'wallet-context/index.html', 'identity/callback/index.html', 'demo-wallet.js', 'x402-checkout.js'].map((f) => readFileSync(join(root, 'web/dist', f), 'utf8')).join('\n');
ok(!/BEGIN PRIVATE KEY|wallet\.example|ab{128}/i.test(all), 'no secret/placeholder in static html/js');
const maps = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.map')) maps.push(p); } })(join(root, 'web/dist'));
ok(maps.length === 0, 'no source maps in web/dist');
const bad = run({ AGENTTRUST_WALLET_ORIGIN: 'https://app.test.local:4592' });
ok(bad.status !== 0, 'wallet origin equal parent fails closed');
console.log(`demo-build: ${pass} checks passed`);
process.exit(pass === 15 ? 0 : 1);
