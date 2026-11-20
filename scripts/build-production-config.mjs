/** Fail-closed production config generation for Wallet Context. No DNS/deploy. */
import { readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const walletOrigin = process.env.WALLET_ORIGIN;
const parentOrigins = (process.env.WALLET_PARENT_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const callbackOrigin = process.env.WALLET_CALLBACK_ORIGIN ?? walletOrigin;
const chainPath = process.env.WALLET_CHAIN_CONFIG ?? join(root, 'web/wallet-context/issuance-config.json');

function fail(reason) { console.error(`production-config: ${reason}`); process.exit(1); }
function isHttpsOrigin(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !value.includes('*'); }
  catch { return false; }
}
if (!walletOrigin || !isHttpsOrigin(walletOrigin)) fail('WALLET_ORIGIN must be an explicit HTTPS origin');
if (parentOrigins.length === 0) fail('WALLET_PARENT_ORIGINS is required');
for (const p of parentOrigins) {
  if (!isHttpsOrigin(p)) fail(`invalid parent origin: ${p}`);
  if (p === walletOrigin) fail('parent origin must differ from wallet origin');
}
if (!callbackOrigin || callbackOrigin !== walletOrigin) fail('callback origin must equal wallet origin exactly');
if (!existsSync(chainPath)) fail('chain config missing');
const chain = JSON.parse(readFileSync(chainPath, 'utf8'));
if (chain.network !== 'Testnet') fail('network must be Testnet');
if (!String(chain.globalContext?.genesisString ?? '').startsWith('Concordium Testnet')) fail('genesisString not Testnet');
if (!chain.ipInfo?.ipVerifyKey || !chain.ipInfo?.ipCdiVerifyKey) fail('IP metadata incomplete');
if (!chain.arsInfos || Object.keys(chain.arsInfos).length === 0) fail('AR metadata incomplete');
if (!chain.globalContext?.onChainCommitmentKey || !chain.globalContext?.bulletproofGenerators) fail('global context incomplete');

const outDir = join(root, 'dist/wallet-context');
mkdirSync(join(outDir, 'identity/callback'), { recursive: true });
const srcDir = join(root, 'web/wallet-context');
copyFileSync(join(srcDir, 'index.html'), join(outDir, 'index.html'));
copyFileSync(join(srcDir, 'callback.js'), join(outDir, 'callback.js'));
copyFileSync(join(srcDir, 'identity/callback/index.html'), join(outDir, 'identity/callback/index.html'));
writeFileSync(join(outDir, 'wallet-config.js'), `window.__WALLET_CONFIG__ = ${JSON.stringify({ allowedParentOrigins: parentOrigins })};\n`);
writeFileSync(join(outDir, 'callback-config.js'), `window.__CALLBACK_CONFIG__ = ${JSON.stringify({ walletOrigin })};\n`);
const issuanceConfig = {
  network: chain.network,
  ipInfo: chain.ipInfo,
  ipMetadata: chain.ipMetadata,
  globalContext: chain.globalContext,
  arsInfos: chain.arsInfos,
  arThreshold: chain.arThreshold,
  identityIndex: chain.identityIndex,
  callbackOrigin,
};
writeFileSync(join(outDir, 'issuance-config.js'), `window.__WALLET_ISSUANCE_CONFIG__ = ${JSON.stringify(issuanceConfig)};\n`);
// Remove source maps from static output.
function removeMaps(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) removeMaps(p);
    else if (name.endsWith('.map')) rmSync(p);
  }
}
removeMaps(join(root, 'dist'));
console.log(`production-config: wallet=${walletOrigin} parents=${parentOrigins.join(',')} callback=${callbackOrigin}`);
