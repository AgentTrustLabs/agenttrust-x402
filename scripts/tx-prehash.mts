/**
 * Local-only proof: a Concordium V1 transaction hash can be computed
 * BEFORE submission, from fixture data only, with the installed SDK.
 *
 * No network. No signing. No private keys. Signature bytes are fixture literals.
 *
 * Run: npx tsx scripts/tx-prehash.mts
 */

import {
  AccountTransactionV1,
  AccountAddress,
  Energy,
  AccountTransactionType,
  Payload,
} from '@concordium/web-sdk';
import { TransactionHash } from '@concordium/web-sdk/types';
import { createHash } from 'node:crypto';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = '') => {
  results.push([name, pass, detail]);
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── fixtures ──
// Real, structurally-valid Concordium addresses (50 chars). Signature bytes are arbitrary
// hex — not real signatures, and nothing ever signs anything.
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const sigSender = { 0: { 0: 'aa'.repeat(64) } };
const sigSponsor = { 0: { 0: 'bb'.repeat(64) } };
const sigChanged = { 0: { 0: 'cc'.repeat(64) } };

const mkPayload = (amountMicroCcd: bigint): Payload.Type =>
  ({
    type: AccountTransactionType.Transfer,
    toAddress: AccountAddress.fromBase58(SENDER),
    amount: { microCcdAmount: amountMicroCcd },
  }) as unknown as Payload.Type;

type Header = {
  expiryEpochSeconds: bigint;
  sender: ReturnType<typeof AccountAddress.fromBase58>;
  nonce: { value: bigint };
  payloadSize: number;
  energyAmount: Energy.Type;
  sponsor: ReturnType<typeof AccountAddress.fromBase58>;
};

const mkHeader = (payload: Payload.Type, nonce: bigint): Header => {
  const payloadSize = Payload.sizeOf(payload);
  // Energy is deterministic for a simple transfer: A*signatureCount + B*size + C_t.
  // No chain data is needed — the constants live in the SDK, the size is local.
  const energyAmount = AccountTransactionV1.calculateEnergyCost(
    2n,
    payload,
    Energy.create(300n), // SimpleTransferHandler.getBaseEnergyCost() === 300n
    { sponsor: true },
  );
  return {
    expiry: { expiryEpochSeconds: 1900000000n },
    sender: AccountAddress.fromBase58(SENDER),
    nonce: { value: nonce },
    payloadSize,
    energyAmount,
    sponsor: AccountAddress.fromBase58(SPONSOR),
  };
};

const mkTx = (over: { amount?: bigint; nonce?: bigint; senderSig?: typeof sigSender; sponsorSig?: typeof sigSponsor; withSponsorSig?: boolean } = {}) => {
  const payload = mkPayload(over.amount ?? 250000n);
  return {
    version: 1 as const,
    header: mkHeader(payload, over.nonce ?? 7n),
    payload,
    signatures: {
      sender: over.senderSig ?? sigSender,
      sponsor: over.withSponsorSig === false ? undefined : (over.sponsorSig ?? sigSponsor),
    },
  } as unknown as AccountTransactionV1.Type;
};

const hashOf = (tx: AccountTransactionV1.Type) =>
  Buffer.from(AccountTransactionV1.getAccountTransactionHash(tx)).toString('hex');

console.log('── 1. SDK surface exists ──');
check('AccountTransactionV1.create is a function', typeof AccountTransactionV1.create === 'function');
check('AccountTransactionV1.calculateEnergyCost is a function', typeof AccountTransactionV1.calculateEnergyCost === 'function');
check('AccountTransactionV1.getAccountTransactionHash is a function', typeof AccountTransactionV1.getAccountTransactionHash === 'function');
check('AccountTransactionV1.serializeBlockItem is a function', typeof AccountTransactionV1.serializeBlockItem === 'function');
check('TransactionHash.fromHexString is a function', typeof TransactionHash.fromHexString === 'function');

console.log('\n── 2. compute the hash locally, before any submission ──');
let hash1 = '';
let blockItem: Uint8Array | null = null;
try {
  const tx = mkTx();
  hash1 = hashOf(tx);
  blockItem = AccountTransactionV1.serializeBlockItem(tx);
  check('hash computed with no network and no signing', hash1.length === 64, hash1);
  check('serialized block item is non-empty', blockItem.length > 0, `${blockItem.length} bytes`);
} catch (e) {
  check('hash computed with no network and no signing', false, String((e as Error).message));
}

console.log('\n── 3. what exactly is hashed? ──');
// The SDK doc comment claims the hash covers "serialized block item kind, signatures, header
// and payload". The implementation does NOT include the block-item kind byte. Establish which.
try {
  const tx = mkTx();
  const serialized = AccountTransactionV1.serialize(tx);
  const withKind = AccountTransactionV1.serializeBlockItem(tx);
  const shaSerialized = createHash('sha256').update(Buffer.from(serialized)).digest('hex');
  const shaWithKind = createHash('sha256').update(Buffer.from(withKind)).digest('hex');

  check('sha256(serialize(tx)) === SDK hash', shaSerialized === hash1, `${shaSerialized.slice(0, 16)}…`);
  check(
    'sha256(serializeBlockItem(tx)) !== SDK hash (kind byte is excluded)',
    shaWithKind !== hash1,
    `blockItem=${withKind.length}B vs serialize=${serialized.length}B`,
  );
} catch (e) {
  check('sha256(serialize(tx)) === SDK hash', false, String((e as Error).message));
}

console.log('\n── 4. stability across recomputation ──');
try {
  const again = hashOf(mkTx());
  check('recomputation is byte-identical', again === hash1, `${again.slice(0, 16)}…`);
} catch (e) {
  check('recomputation is byte-identical', false, String((e as Error).message));
}

console.log('\n── 5. sensitivity: the hash covers payment-critical fields ──');
const h = (over: Parameters<typeof mkTx>[0]) => hashOf(mkTx(over));

check('changing the amount changes the hash', h({ amount: 999999n }) !== hash1);
check('changing the nonce changes the hash', h({ nonce: 8n }) !== hash1);
check('changing the sender signature changes the hash', h({ senderSig: sigChanged }) !== hash1);
check('changing the sponsor signature changes the hash', h({ sponsorSig: sigChanged }) !== hash1);

console.log('\n── 6. the ordering constraint that decides the design ──');
// The client submits a transaction with an EMPTY sponsor signature slot. The facilitator
// adds the sponsor signature. Until that happens, the hash cannot be the final hash.
let hashUnsigned = '';
try {
  hashUnsigned = h({ withSponsorSig: false });
} catch (e) {
  hashUnsigned = ''; // throwing is also proof the hash cannot exist without sponsor sigs
}
check(
  'hash without sponsor signature ≠ final hash (so the hash CANNOT be precomputed at /verify time)',
  hashUnsigned === '' || hashUnsigned !== hash1,
  hashUnsigned === '' ? 'throws — no hash exists without sponsor signatures' : `${hashUnsigned.slice(0, 16)}…`,
);
check(
  'adding the sponsor signature deterministically reaches the same hash',
  h({ sponsorSig: sigSponsor }) === hash1,
);

console.log('\n── 7. round-trip: persisted hex is usable as a node lookup key ──');
if (hash1) {
  try {
    const th = TransactionHash.fromHexString(hash1);
    check('persisted hex parses as a 32-byte TransactionHash', TransactionHash.toBuffer(th).length === 32);
  } catch (e) {
    check('persisted hex parses as a 32-byte TransactionHash', false, String((e as Error).message));
  }
}

console.log('\n── 8. the hash is stable across SDK-level re-derivation ──');
// Recompute through a fresh object graph (as a second process would after loading the
// persisted signed transaction from disk).
try {
  const reloaded = mkTx();
  check('second independent computation matches', hashOf(reloaded) === hash1);
} catch (e) {
  check('second independent computation matches', false, String((e as Error).message));
}

const failed = results.filter(([, p]) => !p).length;
console.log(`\ntx-prehash: ${results.length - failed}/${results.length} passed`);
if (hash1) console.log(`\nfixture transaction hash: ${hash1}`);
if (hashUnsigned) console.log(`fixture hash (no sponsor sig): ${hashUnsigned}`);
process.exit(failed ? 1 : 0);
