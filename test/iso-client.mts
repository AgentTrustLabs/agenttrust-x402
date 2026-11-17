/**
 * Cross-UID Owner IPC client helper for the owner-storage-isolation suite.
 *
 * Runs IpcAuthorizationClient operations as the CALLER's UID, so the suite
 * can drive authorize/revoke/recover as the facilitator UID (ubuntu) via
 * sudo while the suite itself runs as root.
 *
 *   npx tsx test/iso-client.mts <sock> <op> <paymentDigest> [contextJson]
 *
 * Ops: authorize, recover, probe (via IpcAuthorizationClient), and revoke
 * (raw socket: the Owner's revoke op carries only the authorization id,
 * which IpcAuthorizationClient does not expose). For revoke, the third
 * argument is the authorization id, not a payment digest.
 *
 * Prints the JSON response on stdout; exit 0 on a received response,
 * exit 1 on a transport failure.
 */
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { IpcAuthorizationClient } from '../services/facilitator/src/authorization.js';
import type { AuthorizationRequest } from '../services/facilitator/src/authorization.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
// Must match the isolation suite's constants (owner-authorization-binding
// fixtures): sponsor 4Efg…, recipient 3whd….
const SENDER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const SPONSOR = '4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5';
const RECIPIENT = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const [sock, op, digest, contextJson] = process.argv.slice(2);
if (!sock || !op || !digest) {
  console.error('usage: iso-client.mts <sock> <op> <paymentDigest> [contextJson]');
  process.exit(2);
}
const over = contextJson ? (JSON.parse(contextJson) as Record<string, unknown>) : {};
const req = (): AuthorizationRequest => ({
  paymentDigest: digest,
  network: CAIP2,
  version: 1,
  sender: SENDER,
  sponsor: SPONSOR,
  recipient: RECIPIENT,
  asset: 'CCD',
  amount: '250000',
  expiry: Math.floor(Date.now() / 1000) + 200,
  energy: 3000n,
  transactionDigest: 'cd'.repeat(32),
  transactionType: 'transfer',
  maxFeeMicroCcd: '10000000',
  ...(over as Partial<AuthorizationRequest>),
  ...(typeof over.energy === 'string' ? { energy: BigInt(over.energy as string) } : {}),
});

const client = new IpcAuthorizationClient(sock);
try {
  let res: unknown;
  if (op === 'authorize') res = await client.authorize(req());
  else if (op === 'recover') res = await client.recover(req());
  else if (op === 'probe') res = await client.probeDbIdentity();
  else if (op === 'revoke') {
    // Raw revoke: {protocolVersion, requestId, operation, authorizationId}.
    res = await new Promise<unknown>((resolve, reject) => {
      const envelope = { protocolVersion: 1, requestId: randomUUID(), operation: 'revoke', authorizationId: digest };
      const conn = createConnection(sock, () => conn.write(JSON.stringify(envelope) + '\n'));
      let buf = '';
      const timer = setTimeout(() => { conn.destroy(); reject(new Error('revoke timeout')); }, 10_000);
      conn.on('data', (c) => {
        buf += c.toString();
        const idx = buf.indexOf('\n');
        if (idx >= 0) {
          clearTimeout(timer);
          conn.end();
          resolve(JSON.parse(buf.slice(0, idx)) as unknown);
        }
      });
      conn.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } else throw new Error(`unknown op: ${op}`);
  console.log(JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
} catch (e) {
  console.error(JSON.stringify({ error: (e as Error)?.message ?? String(e) }));
  process.exit(1);
}
