/**
 * Standalone HTTP x402 payment client (operator demo script).
 *
 * Pays a protected resource served by `scripts/x402-resource-server.mts`:
 *
 *   GET url                 → 402: parse the challenge, build a signed V1
 *                              sponsored transaction for the exact requirement,
 *                              retry once with `X-PAYMENT`
 *   GET url + X-PAYMENT     → 200: resource + PAYMENT-RESPONSE settlement
 *
 * Signing reuses the proven envelope pattern (sender wallet export +
 * `loadWalletExportSigner` + live nonce + `Transaction.signableFromJSON` /
 * `Transaction.sign` / `Transaction.toJSON`). The sender signs only the
 * sender part; the sponsor signature is added by the facilitator's signing
 * service during settlement. The sponsor account is read from the
 * requirement's `extra.feePayer` — never configured locally.
 *
 * ⚠️  LIVE — this script signs a real transaction and pays real (test) CCD
 * through the facilitator. Run ONLY with a separate, explicit operator
 * authorization for one payment, after the resource server and the
 * facilitator are up and the preflight (balances, nonces, health) matches.
 * It is never run by automated verification, tests, or any other script.
 *
 * Env:
 *   AGENTTRUST_X402_RESOURCE_URL   required, e.g. http://127.0.0.1:4590/protected
 *   AGENTTRUST_SENDER_EXPORT       required, path to the sender wallet export (0600)
 *   AGENTTRUST_SENDER_ADDRESS      required, expected sender account; the export
 *                                  address must match it or the script refuses
 *   AGENTTRUST_NODE_HOST           default grpc.testnet.concordium.com
 *   AGENTTRUST_NODE_PORT           default 20000
 *   AGENTTRUST_X402_SAVE_PAYMENT_HEADER  optional path; when set, the exact
 *                                  `X-PAYMENT` header sent is written there
 *                                  (0600) so a later replay test can resend
 *                                  the SAME envelope. The header holds the
 *                                  signed transaction, never the key.
 *
 * Run: npx tsx scripts/x402-pay.mts
 * Exit 0: access granted (200 + settlement). Exit 1: any other outcome.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseWallet, Transaction } from '@concordium/web-sdk';
import { TESTNET } from '../src/core/types.js';
import { fetchPaidResource } from '../src/x402/client.js';
import { loadWalletExportSigner } from '../services/facilitator/src/walletExportLoader.js';
import { GrpcAccountInfoProvider } from '../services/facilitator/src/grpcAccountInfoProvider.js';

const RESOURCE_URL = process.env.AGENTTRUST_X402_RESOURCE_URL;
const EXPORT_PATH = process.env.AGENTTRUST_SENDER_EXPORT;
const SENDER = process.env.AGENTTRUST_SENDER_ADDRESS;
const SAVE_HEADER_PATH = process.env.AGENTTRUST_X402_SAVE_PAYMENT_HEADER;
const NODE_HOST_RAW = process.env.AGENTTRUST_NODE_HOST ?? TESTNET.grpcHost;
const NODE_HOST = NODE_HOST_RAW.replace(/^https?:\/\//, '');
const NODE_PORT = Number(process.env.AGENTTRUST_NODE_PORT ?? TESTNET.grpcPort);
const NETWORK = TESTNET.caip2;

function fail(message: string): never {
  console.error(`x402-pay: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!RESOURCE_URL) fail('AGENTTRUST_X402_RESOURCE_URL is required');
  if (!EXPORT_PATH) fail('AGENTTRUST_SENDER_EXPORT is required');
  if (!SENDER) fail('AGENTTRUST_SENDER_ADDRESS is required');

  // The export address is public (it is the account address); only it is
  // read here for the match check. Key material is never logged.
  let exportAddress: string;
  try {
    const parsed = parseWallet(readFileSync(EXPORT_PATH, 'utf8'));
    const value = (parsed as { value?: { address?: unknown } }).value;
    if (typeof value?.address !== 'string') fail('wallet export has no address');
    exportAddress = value.address;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('x402-pay:')) throw e;
    fail('wallet export could not be read or parsed');
  }
  if (exportAddress !== SENDER) {
    fail('wallet export address does not match AGENTTRUST_SENDER_ADDRESS — refusing to sign');
  }

  const signer = loadWalletExportSigner(EXPORT_PATH);
  const provider = new GrpcAccountInfoProvider({ host: NODE_HOST, port: NODE_PORT, network: NETWORK, useTls: NODE_HOST_RAW.startsWith('https') });
  await provider.verifyNode();

  const info = await provider.getAccountInfo(SENDER, NETWORK);
  if (info === null) fail('sender account not found on Testnet');
  const nonce = Number(info.accountNonce ?? 0n);

  console.log(`x402-pay: resource=${RESOURCE_URL} sender nonce=${nonce} network=${NETWORK}`);

  const result = await fetchPaidResource(RESOURCE_URL, {
    // Capturing transport: records the exact X-PAYMENT header when (and only
    // when) the operator asked to save it for the replay test. The payment
    // path is unchanged; this wrapper only observes.
    fetchImpl: (async (url, init) => {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
      const xp = headers?.['x-payment'];
      if (SAVE_HEADER_PATH && typeof xp === 'string') {
        writeFileSync(SAVE_HEADER_PATH, xp, { mode: 0o600 });
      }
      return fetch(url, init);
    }) as typeof fetch,
    createPaymentPayload: async ({ requirements, resourceUrl, requestId }) => {
      const feePayer = (requirements.extra as Record<string, unknown> | undefined)?.['feePayer'];
      if (typeof feePayer !== 'string' || feePayer.length === 0) {
        throw new Error('requirement carries no extra.feePayer; cannot build a sponsored transaction');
      }
      const txJson = {
        version: 1,
        header: {
          sender: SENDER,
          nonce,
          expiry: Math.floor(Date.now() / 1000) + 300,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: feePayer, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: requirements.payTo, amount: requirements.amount },
        signatures: { sender: {}, sponsor: {} },
      };
      const signable = Transaction.signableFromJSON(txJson);
      const signed = await Transaction.sign(signable, signer);
      const signedJson = Transaction.toJSON(signed) as Record<string, any>;
      // SDK 12 `Transaction.toJSON` returns header.nonce and
      // header.executionEnergyAmount as BigInt — convert before stringifying,
      // or JSON.stringify throws.
      signedJson.header.nonce = Number(signedJson.header.nonce);
      signedJson.header.executionEnergyAmount = Number(signedJson.header.executionEnergyAmount);
      return {
        x402Version: 2,
        accepted: requirements,
        payload: { signedTransaction: signedJson },
        resource: { url: resourceUrl },
        requestId,
      };
    },
  });

  console.log(`x402-pay: status=${result.status}`);
  console.log(JSON.stringify(result.body, null, 2));
  if (result.paymentResponse) {
    console.log(`settlement: ${JSON.stringify(result.paymentResponse)}`);
  }
  if (result.error) {
    console.log(`failed at stage: ${result.error}${result.errorDetail ? ` — ${result.errorDetail}` : ''}`);
  }
  process.exit(result.status === 200 ? 0 : 1);
}

main().catch((e) => {
  console.error('x402-pay failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
