// Build the Vercel-deployable frontend from prototype-v5-6.html.
//
//   AGENTTRUST_API_BASE_URL=https://api.sabokun.my.id/agenttrust node build.mjs
//
// Output: dist/index.html + dist/three.module.js (vendored, already in web/).
// The API base URL is injected into the __AGENTTRUST_API_BASE_URL__
// placeholder. Empty/unset means same origin (local dev / same-origin
// backend). The value must be an http(s) origin + optional path prefix;
// a trailing slash is stripped. No secrets are involved: the base URL is
// a public API origin, and the build reads only this directory.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = '__AGENTTRUST_API_BASE_URL__';

const apiBase = (process.env.AGENTTRUST_API_BASE_URL ?? '').trim();
if (apiBase && !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(apiBase)) {
  throw new Error(
    `AGENTTRUST_API_BASE_URL must be an http(s) URL, got ${JSON.stringify(apiBase)}`,
  );
}

const src = readFileSync(join(root, 'prototype-v5-6.html'), 'utf8');
if (!src.includes(PLACEHOLDER)) {
  throw new Error('placeholder missing from prototype-v5-6.html: build aborted');
}
const out = src.replaceAll(PLACEHOLDER, apiBase.replace(/\/+$/, ''));
if (out.includes(PLACEHOLDER)) {
  throw new Error('placeholder survived replacement: build aborted');
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), out);
copyFileSync(join(root, 'three.module.js'), join(root, 'dist', 'three.module.js'));
console.log(`built dist/index.html (api base: ${apiBase || '(same origin)'})`);
console.log('built dist/three.module.js (vendored)');
