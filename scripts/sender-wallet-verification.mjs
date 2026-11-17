import { readFileSync, statSync } from "node:fs";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { AccountAddress, parseWallet } from "@concordium/web-sdk";

const EXPECTED_SENDER = "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d";
const SPONSOR = "3xRV448QMiTDyeAdiS9FfzZLWFUnKqTJZ2bx2aNd44zksrSxUK";
const TESTNET_GENESIS = "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796"; // genesis hash
const CAIP2 = "ccd:4221332d34e1694168c2a0c0b3fd0f27";

const path = process.env.SENDER_WALLET_FILE;
if (!path) { console.error("BLOCKED: SENDER_WALLET_FILE unset"); process.exit(2); }

// File metadata only (no contents printed).
const st = statSync(path);
console.log("file_regular:", st.isFile());
console.log("file_mode:", "0o" + (st.mode & 0o777).toString(8).padStart(3, "0"));
console.log("file_uid:", st.uid);
console.log("file_size:", st.size);

const raw = readFileSync(path, "utf8");
let wallet;
try { wallet = parseWallet(raw); } catch (e) { console.error("sdk_parse_failed"); process.exit(1); }

const wv = wallet.value || {};
const derivedAddress = typeof wv.address === "string" ? wv.address : null;
const ak = wv.accountKeys || {};
const exportCreds = wv.credentials || {};

// Collect credential thresholds and public key counts from the export (public data only).
const exportCredIndices = Object.keys(ak.keys || {}).sort();
const exportCredThresholds = exportCredIndices.map((ci) => {
  const c = (ak.keys || {})[ci] || {};
  return { index: ci, threshold: c.threshold, keyCount: Object.keys(c.keys || {}).length };
});
const exportAccountThreshold = ak.threshold;

console.log("derived_address_matches_expected:", derivedAddress === EXPECTED_SENDER);
console.log("export_account_threshold:", exportAccountThreshold);
console.log("export_credential_count:", exportCredIndices.length);
console.log("export_credential_indices:", exportCredIndices.join(","));
console.log("export_credential_thresholds:", exportCredThresholds.map((c) => `${c.index}:${c.threshold}/${c.keyCount}`).join(" "));
console.log("export_credential_ids_count:", Object.keys(exportCreds).length);

// Live Testnet queries (read-only).
const client = new ConcordiumGRPCNodeClient(
  "grpc.testnet.concordium.com",
  20000,
  credentials.createSsl(),
);
const status = await client.getConsensusStatus();
const genesisHex =
  status?.genesisBlock?.buffer instanceof Uint8Array
    ? Buffer.from(status.genesisBlock.buffer).toString("hex")
    : String(status?.genesisBlock ?? "");
console.log("genesis_hex:", genesisHex);
console.log("genesis_match:", genesisHex === TESTNET_GENESIS);
console.log("caip2_cap2:", `ccd:${TESTNET_GENESIS.slice(0, 32)}`, "match:", CAIP2 === `ccd:${TESTNET_GENESIS.slice(0, 32)}`);

const addr = AccountAddress.fromBase58(derivedAddress);
const info = await client.getAccountInfo(addr);
console.log("live_account_exists:", info !== null && info !== undefined);

const liveThreshold = info ? info.accountThreshold : null;
const liveCreds = info ? info.accountCredentials : {};
const liveCredIndices = Object.keys(liveCreds).sort();
const liveCredThresholds = liveCredIndices.map((ci) => {
  const c = liveCreds[ci];
  const contents = c && c.value && c.value.contents ? c.value.contents : {};
  const cpk = contents.credentialPublicKeys || {};
  const keys = cpk.keys || {};
  return { index: ci, threshold: cpk.threshold, keyCount: Object.keys(keys).length, scheme: Object.values(keys).map((k) => k.schemeId).join(",") };
});

console.log("live_account_threshold:", liveThreshold);
console.log("live_credential_count:", liveCredIndices.length);
console.log("live_credential_indices:", liveCredIndices.join(","));
console.log("live_credential_thresholds:", liveCredThresholds.map((c) => `${c.index}:${c.threshold}/${c.keyCount}(${c.scheme})`).join(" "));

// Compare thresholds and counts.
console.log("account_threshold_match:", exportAccountThreshold === liveThreshold);
console.log("credential_count_match:", exportCredIndices.length === liveCredIndices.length);
console.log("credential_indices_match:", exportCredIndices.join(",") === liveCredIndices.join(","));
console.log("credential_thresholds_match:", exportCredThresholds.map((c) => c.threshold).join(",") === liveCredThresholds.map((c) => c.threshold).join(","));
console.log("credential_key_counts_match:", exportCredThresholds.map((c) => c.keyCount).join(",") === liveCredThresholds.map((c) => c.keyCount).join(","));

// Compare public keys (verifyKey) without printing them.
let pubKeysMatch = true;
for (const ci of exportCredIndices) {
  const expCred = (ak.keys || {})[ci] || {};
  const expKeys = expCred.keys || {};
  const liveCred = liveCreds[ci];
  const liveContents = liveCred && liveCred.value && liveCred.value.contents ? liveCred.value.contents : {};
  const liveKeys = (liveContents.credentialPublicKeys || {}).keys || {};
  const expKeyVals = Object.keys(expKeys).sort().map((ki) => expKeys[ki] && expKeys[ki].verifyKey);
  const liveKeyVals = Object.keys(liveKeys).sort().map((ki) => liveKeys[ki] && liveKeys[ki].verifyKey);
  if (expKeyVals.length !== liveKeyVals.length) { pubKeysMatch = false; continue; }
  for (let i = 0; i < expKeyVals.length; i++) {
    if (expKeyVals[i] !== liveKeyVals[i]) pubKeysMatch = false;
  }
}
console.log("public_keys_match:", pubKeysMatch);

console.log("sender_distinct_from_sponsor:", derivedAddress !== SPONSOR);
console.log("sponsor_address:", SPONSOR);
console.log("sender_address:", derivedAddress);
