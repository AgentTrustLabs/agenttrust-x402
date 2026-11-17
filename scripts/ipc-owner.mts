/**
 * Authorization database owner process (proof of concept).
 *
 * This process is the ONLY writer of the authorization database. It:
 *   - creates the DBs in a private directory,
 *   - listens on a Unix socket,
 *   - accepts a narrow authorization request (NO decision field),
 *   - independently reads durable payment state and evaluates authorization,
 *   - returns {approved:true} or {approved:false, reason}.
 *
 * It never exposes a writable SQLite connection and never accepts a caller-supplied decision.
 *
 * split databases: the settlement database (`auth.db`) holds only
 * payment state (seeded here so the PoC has something to authorize); the
 * authorization records live in the Owner-private database (`authz.db`),
 * which only this UID can open. The signer writes through the Owner
 * repository, never through the settlement repository.
 *
 * Run: npx tsx scripts/ipc-owner.mts <db-dir> <socket-path>
 */

import { createServer } from 'node:net';
import { mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { SqliteSettlementRepository } from '../services/facilitator/src/repository.js';
import { RepositorySettlementStateReader, SqliteOwnerAuthorizationRepository } from '../services/facilitator/src/ownerAuthorizationRepository.js';
import { MockNarrowSponsorSigner } from '../services/facilitator/src/narrowSponsorMock.js';
import { decideAuthorization } from '../services/facilitator/src/narrowSponsor.js';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const SPONSOR = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const POLICY = {
  network: CAIP2,
  sponsor: SPONSOR,
  maxEnergy: 10_000n,
  maxExpiryOffsetSeconds: 600,
  allowedAssets: ['CCD'],
  policyVersion: 'v346',
};

const dir = process.argv[2];
const sock = process.argv[3];
if (!dir || !sock) {
  console.error('usage: ipc-owner.mts <db-dir> <socket-path>');
  process.exit(2);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
// Settlement state (payments) — read by the Owner through the reader below.
// Authorization records — Owner-private file, this UID only.
const settlementRepo = new SqliteSettlementRepository(`${dir}/auth.db`, { now: () => Date.now() });
const ownerRepo = new SqliteOwnerAuthorizationRepository(
  `${dir}/authz.db`,
  new RepositorySettlementStateReader(settlementRepo),
  { now: () => Date.now() },
);
const signer = new MockNarrowSponsorSigner({ policy: POLICY, repository: ownerRepo, now: () => Date.now() });

// Seed a valid payment so the PoC has something to authorize.
const d = 'a'.repeat(64);
settlementRepo.noteVerified(d, 'k');
settlementRepo.claim(d, 'k');

if (existsSync(sock)) rmSync(sock);
const server = createServer((conn) => {
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let reply: Record<string, unknown>;
      try {
        const req = JSON.parse(line) as Record<string, unknown>;
        if (typeof req.paymentDigest !== 'string' || req.decision !== undefined) {
          reply = { approved: false, reason: 'malformed_request' };
        } else {
          signer
            .authorize({
              network: req.network,
              version: req.version,
              sender: req.sender,
              sponsor: req.sponsor,
              recipient: req.recipient,
              asset: req.asset,
              amount: req.amount,
              expiry: req.expiry,
              // JSON has no bigint; the owner converts and never trusts a caller string.
              energy: BigInt(String(req.energy)),
              paymentDigest: req.paymentDigest,
            })
            .then((r) => conn.write(JSON.stringify(r) + '\n'))
            .catch((e) => conn.write(JSON.stringify({ approved: false, reason: 'internal_error', detail: (e as Error).message }) + '\n'));
          continue;
        }
      } catch (e) {
        reply = { approved: false, reason: 'malformed_request', detail: (e as Error).message };
      }
      conn.write(JSON.stringify(reply) + '\n');
    }
  });
});
server.listen(sock, () => {
  chmodSync(sock, 0o600);
  console.log(`owner listening on ${sock}`);
});
process.on('SIGTERM', () => {
  server.close();
  ownerRepo.close();
  settlementRepo.close();
  process.exit(0);
});
