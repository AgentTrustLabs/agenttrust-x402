// generate-owner-key.mts — one-time Owner authorization key generation.
//
// Generates a fresh Ed25519 Owner authorization key pair and writes the
// private key as PKCS8 PEM to the given absolute path (mode 0600). Prints
// only the public-key hex (needed for SIGNING_OWNER_PUBLIC_KEY) and the
// public-key fingerprint. The private key is never printed.
//
// Refuses to overwrite an existing file: regenerating the Owner key changes
// the Owner's identity and invalidates the pinned public key the signing
// service verifies against. If the key is lost, generate a new one under a
// new path and re-pin its public key — never overwrite in place.
//
// The file must end up owned by the Owner service user (mode 0600). Run it
// AS that user so ownership is correct by construction — chown does not work
// on the /home/hatch subvolume, so a root-created file there would stay
// root-owned and the Owner launcher would refuse to start.
//
// Usage (from the repo root, as the Owner user):
//   runuser -u agenttrust-owner -- node_modules/.bin/tsx scripts/generate-owner-key.mts /home/hatch/agenttrust-state/owner-authorization-key.pem
import { existsSync, writeFileSync } from 'node:fs';
import {
  generateOwnerAuthorizationKeyPair,
  ownerAuthorizationKeyFingerprint,
  ownerAuthorizationPublicKeyHex,
} from '../services/facilitator/src/ownerAuthorization.js';

const out = process.argv[2];
if (!out || !out.startsWith('/')) {
  console.error('usage: generate-owner-key.mts <absolute-output-path>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`refusing to overwrite existing key file: ${out}`);
  process.exit(1);
}
const pair = generateOwnerAuthorizationKeyPair();
writeFileSync(out, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`owner key written: ${out} (0600)`);
console.log(`public key hex: ${ownerAuthorizationPublicKeyHex(pair.publicKey)}`);
console.log(`fingerprint: ${ownerAuthorizationKeyFingerprint(pair.publicKey)}`);
