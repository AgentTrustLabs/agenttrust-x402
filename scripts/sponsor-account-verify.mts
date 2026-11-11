/**
 * Read-only sponsor-account verification (no writes, no signing).
 *
 * Usage:
 *   npx tsx scripts/sponsor-account-verify.mts <base58check-address>
 *
 * Defaults to grpc.testnet.concordium.com:20000. Verifies, against the live
 * Testnet node and the configured network identity:
 *   - address shape (base58check)
 *   - genesis / CAIP-2 match
 *   - account existence
 *   - credential count and scheme
 *   - account + credential thresholds
 *   - balance
 *   - nonce
 *
 * Prints a compact report. Never prints keys or secrets.
 */

import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { AccountAddress } from '@concordium/web-sdk';
import { isConcordiumAccount, TESTNET_CAIP2 } from '../services/facilitator/src/config.js';

const HOST = process.env['FACILITATOR_NODE_HOST'] ?? 'grpc.testnet.concordium.com';
const PORT = Number(process.env['FACILITATOR_NODE_PORT'] ?? 20_000);
// Public Testnet genesisHash (network identity, not a secret).
const EXPECTED_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

const address = process.argv[2];
if (!address) {
  console.error('usage: sponsor-account-verify.mts <base58check-address>');
  process.exit(2);
}

const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  console.log(s);
};

log(`address       : ${address}`);
log(`node          : ${HOST}:${PORT}`);

// 1. address shape
if (!isConcordiumAccount(address)) {
  log('address shape : INVALID (not a Concordium base58check account)');
  process.exit(2);
}
log('address shape : valid base58check');

const client = new ConcordiumGRPCNodeClient(HOST, PORT, credentials.createSsl());

// 2. genesis / network identity
const consensus: any = await client.getConsensusStatus();
const genesis = String(consensus.genesisBlock);
log(`genesis       : ${genesis}`);
log(`genesis match : ${genesis === EXPECTED_GENESIS_HASH ? 'YES (testnet)' : 'NO — WRONG NETWORK'}`);
log(`caip2         : ${TESTNET_CAIP2}`);

// 3-7. account existence, credentials, thresholds, balance, nonce
let info: any;
try {
  info = await client.getAccountInfo(AccountAddress.fromBase58(address));
} catch (e) {
  log(`account       : NOT FOUND (${(e as Error).message})`);
  process.exit(3);
}
if (!info) {
  log('account       : NOT FOUND');
  process.exit(3);
}

log('account       : EXISTS');
log(`balance       : ${String(info.accountAmount)} microCCD (${Number(info.accountAmount.microCcdAmount) / 1e6} CCD)`);
log(`nonce         : ${String(info.accountNonce)}`);
log(`index         : ${String(info.accountIndex)}`);
log(`account threshold : ${info.accountThreshold}`);

const creds = info.accountCredentials ?? {};
const credCount = Object.keys(creds).length;
log(`credentials   : ${credCount}`);
for (const [ci, c] of Object.entries(creds)) {
  const pk = (c as any).value?.contents?.credentialPublicKeys;
  const keys = pk?.keys ?? {};
  const schemes = Object.values(keys).map((k: any) => k.schemeId);
  log(`  cred ${ci}: threshold=${pk?.threshold} keys=${Object.keys(keys).length} schemes=[${schemes.join(',')}]`);
}

// Expected sponsor shape check
const accountThresholdOk = info.accountThreshold === 1;
const credOk = credCount >= 1 && Object.values(creds).every((c: any) => c?.value?.contents?.credentialPublicKeys?.threshold === 1);
log('');
log(`sponsor shape : accountThreshold===1 ? ${accountThresholdOk} ; credentialThreshold===1 ? ${credOk}`);
log(`ready for loader: ${accountThresholdOk && credOk ? 'YES': 'NO'}`);
log('');
log('DONE');
