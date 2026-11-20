// Build the Vercel-deployable frontend from prototype-v5-6.html.
//
//   AGENTTRUST_API_BASE_URL=https://api.sabokun.my.id/agenttrust node build.mjs
//   AGENTTRUST_WALLET_ORIGIN=https://wallet.example node build.mjs   (demo wallet)
//
// Output: web/dist/index.html, vendored three.module.js, checkout/demo modules,
// and (when configured) embedded Wallet Context assets.
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, '..');
const API_PLACEHOLDER = '__AGENTTRUST_API_BASE_URL__';
const WALLET_PLACEHOLDER = '__AGENTTRUST_WALLET_ORIGIN__';

const apiBase = (process.env.AGENTTRUST_API_BASE_URL ?? '').trim();
if (apiBase && !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(apiBase)) {
  throw new Error(`AGENTTRUST_API_BASE_URL must be an http(s) URL, got ${JSON.stringify(apiBase)}`);
}
const walletOrigin = (process.env.AGENTTRUST_WALLET_ORIGIN ?? '').trim();
const siteOrigin = (process.env.AGENTTRUST_SITE_ORIGIN ?? '').trim();
const parentOrigins = (process.env.AGENTTRUST_PARENT_ORIGINS ?? siteOrigin).trim();
function isHttpsOrigin(v) {
  try { const u = new URL(v); return u.protocol === 'https:' && u.origin === v && !v.includes('*'); } catch { return false; }
}
if (walletOrigin) {
  if (!isHttpsOrigin(walletOrigin)) throw new Error('AGENTTRUST_WALLET_ORIGIN must be explicit HTTPS origin');
  if (parentOrigins && walletOrigin === parentOrigins) throw new Error('AGENTTRUST_WALLET_ORIGIN must differ from parent origin');
  if (!parentOrigins) throw new Error('AGENTTRUST_PARENT_ORIGINS or AGENTTRUST_SITE_ORIGIN required with wallet origin');
  for (const p of parentOrigins.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isHttpsOrigin(p)) throw new Error(`invalid parent origin: ${p}`);
    if (p === walletOrigin) throw new Error('parent origin must differ from wallet origin');
  }
}

// Root build produces dist/wallet, wallet-context bundle, and backend assets.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootBuild = spawnSync(npm, ['run', 'build'], { cwd: repo, stdio: 'inherit' });
if (rootBuild.status !== 0) throw new Error('root build failed');

if (walletOrigin) {
  const cfg = spawnSync(process.execPath, ['scripts/build-production-config.mjs'], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, WALLET_ORIGIN: walletOrigin, WALLET_PARENT_ORIGINS: parentOrigins, WALLET_CALLBACK_ORIGIN: walletOrigin },
  });
  if (cfg.status !== 0) throw new Error('wallet context config failed');
}

const src = readFileSync(join(root, 'prototype-v5-6.html'), 'utf8');
for (const placeholder of [API_PLACEHOLDER, WALLET_PLACEHOLDER]) {
  if (!src.includes(placeholder)) throw new Error(`placeholder missing from prototype-v5-6.html: ${placeholder}`);
}
let out = src.replaceAll(API_PLACEHOLDER, apiBase.replace(/\/+$/, ''));
out = out.replaceAll(WALLET_PLACEHOLDER, walletOrigin);
if (out.includes(API_PLACEHOLDER) || out.includes(WALLET_PLACEHOLDER)) throw new Error('placeholder survived replacement: build aborted');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), out);
for (const f of ['three.module.js', 'x402-checkout.js', 'demo-wallet.js']) copyFileSync(join(root, f), join(root, 'dist', f));

if (walletOrigin) {
  const outDir = join(root, 'dist');
  mkdirSync(join(outDir, 'wallet-context'), { recursive: true });
  mkdirSync(join(outDir, 'identity/callback'), { recursive: true });
  copyFileSync(join(repo, 'dist/wallet-context-bundle.js'), join(outDir, 'wallet-context-bundle.js'));
  copyFileSync(join(repo, 'dist/wallet-context/index.html'), join(outDir, 'wallet-context/index.html'));
  copyFileSync(join(repo, 'dist/wallet-context/wallet-config.js'), join(outDir, 'wallet-config.js'));
  copyFileSync(join(repo, 'dist/wallet-context/issuance-config.js'), join(outDir, 'issuance-config.js'));
  copyFileSync(join(repo, 'dist/wallet-context/callback.js'), join(outDir, 'callback.js'));
  copyFileSync(join(repo, 'dist/wallet-context/callback-config.js'), join(outDir, 'callback-config.js'));
  copyFileSync(join(repo, 'dist/wallet-context/identity/callback/index.html'), join(outDir, 'identity/callback/index.html'));
  cpSync(join(repo, 'dist/wallet'), join(outDir, 'wallet'), { recursive: true });
}
function removeMaps(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) removeMaps(p);
    else if (name.endsWith('.map')) rmSync(p);
  }
}
removeMaps(join(root, 'dist'));
console.log(`built web/dist (api base: ${apiBase || '(same origin)'}; wallet: ${walletOrigin || 'not configured'})`);
