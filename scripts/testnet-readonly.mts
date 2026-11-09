/**
 * TASK 31 — read-only Concordium Testnet connectivity + evidence verification.
 *
 * Authorized read-only network access to grpc.testnet.concordium.com:20000 only.
 * No signing, no submission, no private keys, no transaction construction.
 *
 * Run: npx tsx scripts/testnet-readonly.mts
 */

import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { TransactionHash } from '@concordium/web-sdk/types';
import { ConcordiumEvidenceVerifier } from '../services/facilitator/src/concordiumEvidence.js';
import { credentials } from '@grpc/grpc-js';

const HOST = 'grpc.testnet.concordium.com';
const PORT = 20000;

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Three transaction hashes recorded for token 1004 (from docs/testnet-demo.md).
// transaction 5abc7f8b: CIS-8004.register
const KNOWN_HASHES = [
  '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0', // transaction hash 1
  'c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e', // transaction hash 2
  'cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a', // transaction hash 3
];

const client = new ConcordiumGRPCNodeClient(HOST, PORT, credentials.createSsl());
console.log(`connected client to ${HOST}:${PORT}`);

console.log('\n── 1. consensus status (harmless read-only) ──');
let consensus: any = null;
try {
  consensus = await client.getConsensusStatus();
  check('getConsensusStatus succeeded', true, `bestBlock=${consensus?.bestBlock ?? '?'}`);
  console.log('   bestBlock:', String(consensus?.bestBlock ?? '?'));
  console.log('   genesisBlock:', String(consensus?.genesisBlock ?? '?'));
  check('network identified as a Concordium chain', typeof consensus?.bestBlock !== 'undefined', 'consensus returned');
} catch (e) {
  check('getConsensusStatus succeeded', false, String((e as Error).message).slice(0, 200));
}

console.log('\n── 2. getBlockItemStatus for each known token-1004 hash ──');
for (const h of KNOWN_HASHES) {
  try {
    const status = await client.getBlockItemStatus(TransactionHash.fromHexString(h));
    console.log(`   ${h.slice(0, 12)}… → ${JSON.stringify(status, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 400)}`);
    check(`hash ${h.slice(0, 12)}… queryable`, true);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.log(`   ${h.slice(0, 12)}… → ERROR: ${msg.slice(0, 200)}`);
    check(`hash ${h.slice(0, 12)}… queryable`, /not.?found/i.test(msg), msg.slice(0, 80));
  }
}

console.log('\n── 3. adapter mapping of a real response ──');
const verifier = new ConcordiumEvidenceVerifier(client as any, { timeoutMs: 15_000 });
for (const h of KNOWN_HASHES) {
  try {
    const ev = await verifier.verify({ transaction: h, paymentDigest: 'd'.repeat(64) });
    console.log(`   ${h.slice(0, 12)}… → available=${ev.available} observed=${ev.observed} error=${ev.error ?? '-'}`);
    check(`adapter ${h.slice(0, 12)}… did not throw`, true);
  } catch (e) {
    console.log(`   ${h.slice(0, 12)}… → THREW: ${String((e as Error).message).slice(0, 120)}`);
    check(`adapter ${h.slice(0, 12)}… did not throw`, false, String((e as Error).message).slice(0, 120));
  }
}

// Close the client.
try { (client as any).close?.(); } catch { /* ignore */ }

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntask31-testnet-readonly: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
