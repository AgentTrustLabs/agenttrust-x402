/** Pure Wallet Vault v2 descriptor validator tests (offline, no secrets). */
import { readFileSync } from 'node:fs';
import { eq, ok, notOk } from './helpers.mjs';
import { validateV2WalletDescriptor, type V2WalletDescriptor, type ValidationResult } from '../src/wallet/v2DescriptorValidator.js';

const SEED = 'ab'.repeat(64);        // synthetic test seed, 128 hex
const WALLET_ID = 'cd'.repeat(32);   // 64 hex
const VERIFY_KEY = 'ef'.repeat(32);  // synthetic public key, 64 hex
const AAD = `agenttrust|2|testnet|${WALLET_ID}`;

function valid(): V2WalletDescriptor {
  const credential = { credIndex: 0, publicKeys: { 0: { schemeId: 'Ed25519' as const, verifyKey: VERIFY_KEY } }, threshold: 1 };
  return {
    schemaVersion: 2,
    kind: 'v2-hd',
    network: 'testnet',
    walletId: WALLET_ID,
    seedHex: SEED,
    aad: AAD,
    identity: { idpIndex: 3, identityIndex: 0 },
    credentials: [{ ...credential, publicKeys: { ...credential.publicKeys } }],
    metadata: {
      walletId: WALLET_ID, schemaVersion: 2, network: 'testnet',
      identity: { idpIndex: 3, identityIndex: 0 },
      credentials: [{ ...credential, publicKeys: { ...credential.publicKeys } }],
    },
  };
}

const codes = (r: ValidationResult): string[] => r.ok ? [] : r.errors.map(e => e.code);
const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('01. valid descriptor returns ok', () => {
  const r = validateV2WalletDescriptor(valid());
  ok(r.ok, 'valid');
});

test('02. seed length and hex validation', () => {
  const short = valid(); short.seedHex = 'ab'.repeat(32);
  const long = valid(); long.seedHex = 'ab'.repeat(65);
  const badHex = valid(); badHex.seedHex = 'g'.repeat(128);
  notOk(validateV2WalletDescriptor(short).ok, 'short seed');
  eq(codes(validateV2WalletDescriptor(short))[0], 'INVALID_SEED_HEX', 'short code');
  notOk(validateV2WalletDescriptor(long).ok, 'long seed');
  notOk(validateV2WalletDescriptor(badHex).ok, 'non-hex seed');
});

test('03. network mismatch', () => {
  const d = valid(); d.network = 'mainnet'; d.metadata.network = 'mainnet';
  const r = validateV2WalletDescriptor(d);
  eq(codes(r).includes('NETWORK_MISMATCH'), true, 'network code');
});

test('04. wallet id / AAD mismatch', () => {
  const d = valid(); d.aad = `agenttrust|2|testnet|${'e'.repeat(64)}`;
  eq(codes(validateV2WalletDescriptor(d)).includes('AAD_MISMATCH'), true, 'aad mismatch');
  const badId = valid(); badId.walletId = 'x'.repeat(64); badId.metadata.walletId = badId.walletId;
  eq(codes(validateV2WalletDescriptor(badId)).includes('INVALID_WALLET_ID'), true, 'wallet id');
});

test('05. indices must be non-negative integers', () => {
  for (const [field, value] of [['idpIndex', -1], ['identityIndex', 1.5], ['idpIndex', '3']]) {
    const d = valid() as any; d.identity[field] = value; d.metadata.identity[field] = value;
    const r = validateV2WalletDescriptor(d);
    notOk(r.ok, 'bad ' + field + '=' + String(value));
  }
});

test('06. duplicate credential index rejected', () => {
  const d = valid() as any;
  d.credentials.push({ ...d.credentials[0] });
  d.metadata.credentials.push({ ...d.metadata.credentials[0] });
  eq(codes(validateV2WalletDescriptor(d)).includes('DUPLICATE_CREDENTIAL_INDEX'), true, 'duplicate');
});

test('07. invalid public key / scheme rejected', () => {
  const badKey = valid() as any;
  badKey.credentials[0].publicKeys['0'].verifyKey = 'ef'.repeat(31) + '0';
  badKey.metadata.credentials[0].publicKeys['0'].verifyKey = badKey.credentials[0].publicKeys['0'].verifyKey;
  notOk(validateV2WalletDescriptor(badKey).ok, 'bad key length');
  const badScheme = valid() as any;
  badScheme.credentials[0].publicKeys['0'].schemeId = 'Secp256k1';
  badScheme.metadata.credentials[0].publicKeys['0'].schemeId = 'Secp256k1';
  eq(codes(validateV2WalletDescriptor(badScheme)).includes('INVALID_SCHEME'), true, 'scheme');
});

test('08. threshold validation', () => {
  const zero = valid() as any; zero.credentials[0].threshold = 0; zero.metadata.credentials[0].threshold = 0;
  eq(codes(validateV2WalletDescriptor(zero)).includes('INVALID_THRESHOLD'), true, 'zero');
  const big = valid() as any; big.credentials[0].threshold = 2; big.metadata.credentials[0].threshold = 2;
  eq(codes(validateV2WalletDescriptor(big)).includes('THRESHOLD_EXCEEDS_KEYS'), true, 'too large');
  const frac = valid() as any; frac.credentials[0].threshold = 1.5; frac.metadata.credentials[0].threshold = 1.5;
  eq(codes(validateV2WalletDescriptor(frac)).includes('INVALID_THRESHOLD'), true, 'non-int');
});

test('09. metadata tampering rejected', () => {
  const d = valid() as any; d.metadata.credentials[0].credIndex = 7;
  const r = validateV2WalletDescriptor(d);
  eq(codes(r).includes('METADATA_CREDENTIALS_MISMATCH'), true, 'credentials mismatch');
  const d2 = valid() as any; d2.metadata.schemaVersion = 3;
  eq(codes(validateV2WalletDescriptor(d2)).includes('METADATA_SCHEMA_MISMATCH'), true, 'schema mismatch');
});

test('10. errors never contain seed or verify key values', () => {
  const d = valid() as any; d.seedHex = 'g'.repeat(128); d.credentials[0].publicKeys['0'].verifyKey = 'bad';
  const json = JSON.stringify(validateV2WalletDescriptor(d));
  notOk(json.includes(SEED), 'no synthetic seed value');
  notOk(json.includes(VERIFY_KEY), 'no verify key value');
  notOk(json.includes('privateKey'), 'no privateKey label');
  ok(!json.includes('abab'), 'no seed bytes in errors');
});

test('11. validator is pure / offline', () => {
  const src = readFileSync(new URL('../src/wallet/v2DescriptorValidator.ts', import.meta.url), 'utf8');
  for (const needle of ['fetch(', 'grpc', 'sendTransaction', 'indexedDB', 'crypto.subtle', 'localStorage']) {
    notOk(src.includes(needle), 'no ' + needle);
  }
});

let failed = 0; let n = 0;
for (const [name, fn] of tests) {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error)?.stack ?? String(e)}`); }
}
console.log(`\nv2-descriptor-validator: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
