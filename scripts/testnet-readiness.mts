/**
 * Read-only Testnet readiness probe. No signing, no construction for broadcast,
 * no submission, no faucet, no private-key access. Public chain queries only.
 *
 * Run: npx tsx scripts/testnet-readiness.mts
 */
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { AccountAddress } from '@concordium/web-sdk';

const HOST = 'grpc.testnet.concordium.com';
const PORT = 20000;
// Public Testnet genesisHash (network identity, not a secret).
const EXPECTED_GENESIS_HASH = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';

const client = new ConcordiumGRPCNodeClient(HOST, PORT, credentials.createSsl());

// 1. node identity
const consensus: any = await client.getConsensusStatus();
const genesis = String(consensus.genesisBlock);
console.log('endpoint        :', `${HOST}:${PORT} (TLS)`);
console.log('genesisBlock    :', genesis);
console.log('genesis match   :', genesis === EXPECTED_GENESIS_HASH ? 'YES (testnet)' : 'NO — WRONG NETWORK');
console.log('lastFinalized   :', String(consensus.lastFinalizedBlock));
const bi: any = await client.getBlockInfo();
console.log('protocolVersion :', String(bi.protocolVersion));
console.log('');

// 2. accounts
const accounts: Array<[string, string]> = [
  ['sponsor (verified live Testnet)', '3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK'],
  ['operator / sender (token 1004)',     '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d'],
];
for (const [label, addr] of accounts) {
  console.log(`=== ${label}`);
  console.log(`  address: ${addr}`);
  try {
    const info: any = await client.getAccountInfo(AccountAddress.fromBase58(addr));
    console.log(`  exists : YES`);
    console.log(`  balance: ${String(info.accountAmount)} (microCCD) = ${Number(info.accountAmount.microCcdAmount) / 1e6} CCD`);
    console.log(`  available: ${Number(info.accountAvailableBalance.microCcdAmount) / 1e6} CCD`);
    console.log(`  nonce  : ${String(info.accountNonce)}`);
    console.log(`  index  : ${String(info.accountIndex)}`);
    console.log(`  threshold: ${info.accountThreshold}`);
    const creds = info.accountCredentials ?? {};
    for (const [ci, c] of Object.entries(creds)) {
      const pk = (c as any).value?.contents?.credentialPublicKeys;
      console.log(`  cred ${ci}: threshold=${pk?.threshold} keys=${Object.keys(pk?.keys ?? {}).length}`);
      for (const [ki, k] of Object.entries(pk?.keys ?? {})) {
        const key = k as { schemeId: string; verifyKey: string };
        console.log(`    key ${ki}: schemeId=${key.schemeId} (${String(key.verifyKey).length / 2} bytes)`);
      }
    }
  } catch (e) {
    console.log(`  exists : NO — ${(e as Error).message}`);
  }
  console.log('');
}

// 3. fee model
console.log('=== fee model (Testnet, protocol 10) ===');
const RATE = 8000n;
const CAP_FEE = 10_000_000n;
const CAP_ENERGY = 100_000n;
for (const [label, nrg] of [['simple transfer (1 sig)', 300n], ['2 sigs', 600n], ['contract init', 5000n], ['contract update', 10000n]] as Array<[string, bigint]>) {
  const fee = nrg * RATE;
  console.log(`  ${label.padEnd(26)} energy=${String(nrg).padStart(6)} NRG  worst-case fee=${String(Number(fee) / 1e6).padStart(8)} CCD  ${fee <= CAP_FEE ? 'within cap' : 'EXCEEDS cap'}`);
}
console.log(`  maxFeeMicroCcd default : ${CAP_FEE} microCCD = 10 CCD`);
console.log(`  maxEnergy default      : ${CAP_ENERGY} NRG  -> worst-case ${Number(CAP_ENERGY * RATE) / 1e6} CCD`);
console.log(`  headroom at max caps   : ${Number(CAP_FEE - CAP_ENERGY * RATE) / 1e6} CCD  (negative = inconsistent caps)`);
console.log('\nDONE');
