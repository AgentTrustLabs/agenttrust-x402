/**
 * Cross-UID signing-service helper for the owner-storage-isolation suite.
 *
 * Hosts ONE signing-service call as the CALLER's UID, so the suite can sign
 * as the signing-service UID (authsigner) while the suite itself runs as root.
 *
 * This indirection is REQUIRED, not incidental: the Owner refuses `consume`
 * from uid 0 outright (scripts/authz-owner.mts: peerUid === 0 is rejected
 * even when the configured signing-service UID is 0), so an in-process
 * signing service running as root can never consume — every sign fails
 * `protocol_error/unauthorized_peer` before any signer is invoked. The
 * helper runs as authsigner, the UID the suite configures as the signing
 * service, and the Owner accepts its consume.
 *
 *   npx tsx test/iso-sign.mts <sock> <ownerUid> <ownerPubHex> <signerMode> <requestJson>
 *
 * signerMode: counting (fake signer returns 0xff.. signatures) or throwing
 * (fake signer throws after consume, simulating a crash between consume and
 * signing). Prints {"outcome","reason","detail","signerCalls"} on stdout;
 * exit 0 on a received signing response, exit 1 on a transport/setup failure.
 *
 * The helper builds a FRESH service per invocation: the exactly-once
 * guarantee under test lives in the Owner's atomic consumption, not in the
 * service's in-memory replay map, so per-invocation services are sound here
 * (each request also carries a fresh requestId).
 */
import { createSigningService } from '../services/facilitator/src/signingService.js';
import type { SigningRequest } from '../services/facilitator/src/signingService.js';
import type { AccountSigner } from '@concordium/web-sdk';
import { IpcOwnerConsumeClient } from '../services/facilitator/src/ownerAuthorization.js';

const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

const [sock, ownerUidRaw, ownerPubHex, mode, reqJson] = process.argv.slice(2);
if (!sock || !ownerUidRaw || !ownerPubHex || !mode || !reqJson) {
  console.error('usage: iso-sign.mts <sock> <ownerUid> <ownerPubHex> <signerMode> <requestJson>');
  process.exit(2);
}
const ownerUid = Number(ownerUidRaw);
if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0) {
  console.error(`refusing to run: ownerUid must be a positive integer, got ${ownerUidRaw}`);
  process.exit(2);
}

let calls = 0;
const counting: AccountSigner = {
  async sign(_digest: ArrayBuffer) {
    calls++;
    return { 0: { 0: 'ff'.repeat(64) } } as never;
  },
  getSignatureCount(): bigint {
    return 1n;
  },
};
const throwing: AccountSigner = {
  async sign(_digest: ArrayBuffer): Promise<never> {
    calls++;
    throw new Error('simulated crash after consume');
  },
  getSignatureCount(): bigint {
    return 1n;
  },
};
if (mode !== 'counting' && mode !== 'throwing') {
  console.error(`unknown signerMode: ${mode}`);
  process.exit(2);
}

const service = createSigningService({
  accountSigner: mode === 'throwing' ? throwing : counting,
  sponsorAddress: SPONSOR,
  network: NETWORK,
  allowedUid: typeof process.getuid === 'function' ? process.getuid() : -1,
  now: () => Date.now(),
  ownerAuthorization: {
    publicKey: ownerPubHex,
    consume: new IpcOwnerConsumeClient({ socketPath: sock, ownerUid }),
  },
});

try {
  const req = JSON.parse(reqJson) as SigningRequest;
  const res = await service.sign(req);
  console.log(JSON.stringify({ outcome: res.outcome, reason: res.reason, detail: res.detail, signerCalls: calls }));
} catch (e) {
  console.error(JSON.stringify({ error: (e as Error)?.message ?? String(e) }));
  process.exit(1);
}
