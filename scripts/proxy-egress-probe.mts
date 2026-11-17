// proxy-egress-probe.mts — real TLS egress check for a proxy credential.
//
// Reads the proxy variables from its own environment (HTTPS_PROXY etc. plus
// NODE_USE_ENV_PROXY=1) and runs a genesis-bound node identity check through
// the same gRPC client the facilitator uses. Prints only `ok` or a short
// failure reason; it never prints credential values.
//
// Exit 0 = the credential in the environment can reach the Testnet node
// through the egress proxy. Exit 1 = it cannot (expired/invalid credential,
// proxy unreachable, node unreachable — the message says which).
//
// Usage (from the repo root):
//   env -i PATH=... NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<candidate> \
//     node_modules/.bin/tsx scripts/proxy-egress-probe.mts
import { GrpcAccountInfoProvider } from '../services/facilitator/src/grpcAccountInfoProvider.js';

const provider = new GrpcAccountInfoProvider({
  host: 'grpc.testnet.concordium.com',
  port: 20000,
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  useTls: true,
});

try {
  const id = await provider.verifyNode();
  console.log(`ok genesis=${id.genesisHash.slice(0, 12)}…`);
} catch (e) {
  console.log(`fail: ${(e as Error).message.slice(0, 160).replace(/\s+/g, ' ')}`);
  process.exit(1);
}
