/**
 * Live Concordium Testnet account verification (read-only).
 *
 * Read-only gRPC only. No signing, no transaction construction, no submission.
 *
 * Run: npx tsx scripts/account-verify-live.mts
 */

import { GrpcAccountInfoProvider, AccountInfoProviderError } from '../services/facilitator/src/grpcAccountInfoProvider.js';
import { SdkSenderVerifier } from '../services/facilitator/src/senderVerifier.js';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { Transaction, AccountAddress } from '@concordium/web-sdk';

const HOST = 'grpc.testnet.concordium.com';
const PORT = 20000;
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
// Publicly known AgentTrust Testnet account (see docs/testnet-demo.md: token 1004 owner).
const ACCOUNT = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

const out: string[] = [];
const log = (s: string) => { out.push(s); console.log(s); };

log('══ live Testnet account verification (read-only) ══');
log('');
log('── 1. provider construction ──');
log(`  endpoint: ${HOST}:${PORT} (TLS)`);
log(`  network:  ${CAIP2}`);
log(`  account:  ${ACCOUNT}`);

const provider = new GrpcAccountInfoProvider({
  host: HOST,
  port: PORT,
  useTls: true,
  network: CAIP2,
  timeoutMs: 20_000,
});

log('');
log('── 2. verifyNode(): genesis hash vs configured identity ──');
try {
  const identity = await provider.verifyNode();
  log(`  ✅ VERIFIED  genesisHash = ${identity.genesisHash}`);
  log(`  ✅ VERIFIED  caip2       = ${identity.caip2}`);
} catch (e) {
  const err = e as AccountInfoProviderError;
  log(`  ❌ FAILED    ${err.failure ?? 'unknown'}: ${err.message}`);
  log('');
  log('BLOCKED: node identity could not be verified. No account query attempted.');
  process.exit(2);
}

log('');
log('── 3. getAccountInfo() live RPC ──');
let info: Awaited<ReturnType<typeof provider.getAccountInfo>>;
try {
  info = await provider.getAccountInfo(ACCOUNT, CAIP2);
} catch (e) {
  const err = e as AccountInfoProviderError;
  log(`  ❌ FAILED    ${err.failure ?? 'unknown'}: ${err.message}`);
  log('');
  log('BLOCKED: live account query failed. No further validation possible.');
  process.exit(3);
}

if (info === null) {
  log('  ❌ NOT FOUND  account does not exist on Testnet');
  log('');
  log('BLOCKED: no suitable public Testnet account available at this address.');
  process.exit(4);
}

log(`  ✅ VERIFIED  account returned (type available)`);
log(`  accountAddress : ${String(info.accountAddress)}`);
log(`  accountThreshold: ${info.accountThreshold}`);
log(`  accountNonce   : ${String(info.accountNonce)}`);
log(`  accountIndex   : ${String(info.accountIndex)}`);
log(`  credentials    : ${Object.keys(info.accountCredentials).length}`);

log('');
log('── 4. identity validation ──');
const returnedAddr = String(info.accountAddress);
const match = returnedAddr === ACCOUNT;
log(`  ✅ ${match ? 'PASS' : 'FAIL'}  returned address === requested address`);
if (!match) {
  log(`     requested: ${ACCOUNT}`);
  log(`     returned : ${returnedAddr}`);
}

log('');
log('── 5. threshold validation ──');
const threshOk = typeof info.accountThreshold === 'number' && Number.isSafeInteger(info.accountThreshold) && info.accountThreshold >= 1;
log(`  ✅ ${threshOk ? 'PASS' : 'FAIL'}  accountThreshold = ${info.accountThreshold} (positive integer)`);

log('');
log('── 6. credential key mapping (SDK-compatible structure) ──');
let allKeysValid = true;
let totalKeys = 0;
for (const [credIdx, cred] of Object.entries(info.accountCredentials)) {
  const keys = (cred as any)?.value?.contents?.credentialPublicKeys;
  if (!keys) {
    log(`  ❌ credential ${credIdx}: no credentialPublicKeys`);
    allKeysValid = false;
    continue;
  }
  log(`  credential ${credIdx}: threshold=${keys.threshold}, keys=${Object.keys(keys.keys ?? {}).length}`);
  for (const [keyIdx, k] of Object.entries(keys.keys ?? {})) {
    totalKeys++;
    const vk = (k as any)?.verifyKey;
    const isHex32 = typeof vk === 'string' && /^[0-9a-fA-F]{64}$/.test(vk);
    const scheme = (k as any)?.schemeId;
    log(`    key ${credIdx}/${keyIdx}: schemeId=${scheme} verifyKey=${isHex32 ? `${vk.slice(0, 8)}…${vk.slice(-8)} (32 bytes)` : 'INVALID'}`);
    if (!isHex32) allKeysValid = false;
  }
}
log(`  ✅ ${allKeysValid ? 'PASS' : 'FAIL'}  all ${totalKeys} verifyKeys are 32-byte hex`);

log('');
log('── 7. SDK verifier compatibility (deterministic fixture) ──');
// The live account's real keys cannot verify a locally-generated test signature (we hold no
// account key). Instead we prove COMPATIBILITY: the provider's structure is accepted by
// Transaction.verifySignature and correctly REJECTS a signature made with a different key.
try {
  const txJson = {
    version: 1,
    header: {
      sender: ACCOUNT,
      nonce: Number(info.accountNonce ?? 0n),
      expiry: Math.floor(Date.now() / 1000) + 300,
      executionEnergyAmount: 300,
      numSignatures: 1,
      sponsor: { account: ACCOUNT, numSignatures: 1 },
    },
    payload: { type: 'transfer', toAddress: ACCOUNT, amount: '1' },
    signatures: { sender: {}, sponsor: {} },
  };
  const signable = Transaction.signableFromJSON(txJson);
  const { privateKey } = generateKeyPairSync('ed25519');
  const signed = await Transaction.sign(signable, {
    async sign(digest: ArrayBuffer) {
      return { 0: { 0: edSign(null, Buffer.from(digest), privateKey).toString('hex') } } as any;
    },
    getSignatureCount() { return 1n; },
  });
  const signedJson = Transaction.toJSON(signed) as any;

  // Direct SDK call with the LIVE account info — proves structural compatibility.
  const structurallyAccepted = await Transaction.verifySignature(
    Transaction.signableFromJSON(signedJson),
    signedJson.signatures.sender,
    {
      accountThreshold: info.accountThreshold,
      accountCredentials: info.accountCredentials,
      accountAddress: info.accountAddress,
    },
  );
  log(`  ✅ PASS  SDK accepted the live AccountInfo structure (result=${structurallyAccepted})`);
  log(`     (result=false is CORRECT: the fixture signature was made with a key this account does not hold)`);

  // Full verifier path: must fail closed (signature not from the account's keys).
  const verifier = new SdkSenderVerifier({ network: CAIP2, accountInfoProvider: provider });
  const vr = await verifier.verify(signedJson);
  log(`  ✅ ${vr.ok === false ? 'PASS' : 'FAIL'}  SdkSenderVerifier failed closed on a foreign signature (${vr.ok ? 'ok' : (vr as any).reason})`);
} catch (e) {
  log(`  ❌ FAILED  ${(e as Error).message}`);
}

log('');
log('── 8. error behaviour (negative, read-only) ──');
try {
  const missing = await provider.getAccountInfo(
    '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4e', // one char differs (invalid checksum)
    CAIP2,
  );
  log(`  ${missing === null ? 'account returned null' : 'UNEXPECTED: returned info'}`);
} catch (e) {
  log(`  ${(e as AccountInfoProviderError).failure ?? 'error'}: ${(e as Error).message.slice(0, 90)}`);
}

log('');
log('── done ──');
