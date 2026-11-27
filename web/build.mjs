// Build the Vercel-deployable frontend.
//   AGENTTRUST_PAIRING_API_BASE_URL=http://127.0.0.1:4518 \
//   AGENTTRUST_RESOURCE_API_BASE_URL=https://api.sabokun.my.id/agenttrust \
//   AGENTTRUST_A2A_API_BASE_URL=http://127.0.0.1:4020 \
//   node build.mjs
//
// The website talks to three backend services (see web/api-routing.mjs):
// pairing (control plane), resource (data plane) and a2a (Agent Card +
// JSON-RPC). Each has its own base URL, injected into its placeholder.
// A value must be an http(s) URL, the literal 'same-origin', or empty.
// Empty means: pairing → same origin (the pairing server serves this
// website); resource / a2a → not configured (calls to that service fail
// closed with a named error — never a silent fallback to another service
// or to a production endpoint). The legacy AGENTTRUST_API_BASE_URL is
// honoured only as the resource base when the resource base itself is
// not configured; it is deprecated.
//
// Output: dist/index.html (landing page, from landing.html) +
// dist/app.html (the SPA, from prototype-v5-6.html, placeholders replaced)
// + dist/hero.webp (landing hero) + dist/three.module.js (vendored, already in web/)
// + dist/wallet-connect.mjs + dist/concordiumHelpers.min.js (vendored,
// official Concordium Browser Wallet helper 3.3.0)
// + dist/api-routing.mjs + dist/a2a-client.mjs (website modules).
// The base URLs are public API origins; no secrets are involved, and the
// build reads only this directory.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function readBase(name) {
  const value = (process.env[name] ?? '').trim();
  if (value !== '' && value !== 'same-origin' && !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(value)) {
    throw new Error(`${name} must be an http(s) URL, 'same-origin', or empty, got ${JSON.stringify(value)}`);
  }
  return value;
}

const pairingBase = readBase('AGENTTRUST_PAIRING_API_BASE_URL');
const resourceBase = readBase('AGENTTRUST_RESOURCE_API_BASE_URL');
const a2aBase = readBase('AGENTTRUST_A2A_API_BASE_URL');
const legacyBase = readBase('AGENTTRUST_API_BASE_URL');

// The landing page carries no API placeholders: it links to the app
// (app.html) and to public URLs only. It must reference hero.webp.
const landing = readFileSync(join(root, 'landing.html'), 'utf8');
if (landing.includes('__AGENTTRUST_')) {
  throw new Error('landing.html must not contain API placeholders');
}
if (!landing.includes('hero.webp')) {
  throw new Error('landing.html must reference hero.webp');
}

const src = readFileSync(join(root, 'prototype-v5-6.html'), 'utf8');
const placeholders = [
  ['__AGENTTRUST_PAIRING_API_BASE_URL__', pairingBase],
  ['__AGENTTRUST_RESOURCE_API_BASE_URL__', resourceBase],
  ['__AGENTTRUST_A2A_API_BASE_URL__', a2aBase],
  ['__AGENTTRUST_API_BASE_URL__', legacyBase],
];
let out = src;
for (const [placeholder, value] of placeholders) {
  if (!out.includes(placeholder)) {
    throw new Error(`placeholder missing from prototype-v5-6.html: ${placeholder} — build aborted`);
  }
  out = out.replaceAll(placeholder, value.replace(/\/+$/, ''));
  if (out.includes(placeholder)) {
    throw new Error(`placeholder survived replacement: ${placeholder} — build aborted`);
  }
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), landing);
writeFileSync(join(root, 'dist', 'app.html'), out);
copyFileSync(join(root, 'hero.webp'), join(root, 'dist', 'hero.webp'));
copyFileSync(join(root, 'three.module.js'), join(root, 'dist', 'three.module.js'));
copyFileSync(join(root, 'wallet-connect.mjs'), join(root, 'dist', 'wallet-connect.mjs'));
copyFileSync(join(root, 'concordiumHelpers.min.js'), join(root, 'dist', 'concordiumHelpers.min.js'));
copyFileSync(join(root, 'api-routing.mjs'), join(root, 'dist', 'api-routing.mjs'));
copyFileSync(join(root, 'a2a-client.mjs'), join(root, 'dist', 'a2a-client.mjs'));
console.log('built dist/index.html (landing)');
console.log(`built dist/app.html (pairing: ${pairingBase || '(same origin)'}, resource: ${resourceBase || legacyBase || '(not configured)'}, a2a: ${a2aBase || '(not configured)'})`);
console.log('built dist/hero.webp');
console.log('built dist/three.module.js (vendored)');
console.log('built dist/wallet-connect.mjs (vendored)');
console.log('built dist/concordiumHelpers.min.js (vendored, official helper 3.3.0)');
console.log('built dist/api-routing.mjs (API service routing layer)');
console.log('built dist/a2a-client.mjs (A2A client)');
