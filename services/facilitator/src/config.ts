/**
 * Facilitator prototype — runtime configuration.
 *
 * Everything here is validated before the service can answer a single request. There is no
 * fallback and no default that quietly enables settlement.
 */

export type FacilitatorMode = 'mock' | 'real';

export interface FacilitatorConfig {
  mode: FacilitatorMode;
  host: string;
  port: number;
  /**
   * Sponsor account that will pay transaction fees, once a real signer is provisioned.
   * Never a secret. Validated for shape only.
   */
  sponsorAddress: string | null;
  /**
   * Mock-mode-only override for the address the mock signer reports as the
   * sponsor . The mock signer normally derives its own obviously-
   * fake placeholder, and a real Owner refuses to authorize that: the
   * launcher validates its policy sponsor with AccountAddress.fromBase58
   * and every request must match it. Without this knob no mock-mode
   * facilitator can ever talk to a real Owner, so the cross-process
   * recovery path (prebroadcast W5) would be untestable. Validated as a
   * Concordium account; rejected outright in real mode. Never a secret.
   */
  mockSponsorAddress: string | null;
  /** CAIP-2 network this facilitator serves. Testnet only in this prototype. */
  network: string;
  /** How long a submitted transaction may be considered `pending` before it is terminal. */
  pendingTtlMs: number;
  /** Idle TTL for replay entries. */
  replayTtlMs: number;
  /** SQLite file for durable settlement state. `:memory:` only for tests. */
  dbPath: string;
  /**
   * Permission bits for the settlement database file (and its WAL/-shm),
   * e.g. `0644`. Default `0600` (single-UID deployment). A deployment that
   * shares the file across two UIDs — facilitator writes, Owner reads —
   * must pass `0644`: the Owner reads through the world-read bit and the
   * launcher refuses startup if the file is writable by the Owner UID, so
   * the mode must never grant group or world write.
   */
  dbFileMode: number | null;
  /** Whether /reconcile is exposed at all. Off unless explicitly enabled. */
  reconcileEnabled: boolean;
  /** SHA-256 digest of the operator token. Never the token itself. */
  operatorTokenSha256: string | null;
  /** Optional absolute expiry for the operator credential, epoch ms. */
  operatorTokenExpiresAt: number | null;
  /** Optional append-only ledger path for instrumented submission counting (tests). */
  submitLedgerPath: string | null;
  /** Per-process label recorded in the ledger. */
  processLabel: string | null;
  /**
   * Unix socket path to the Authorization Owner. The facilitator speaks the
   * agenttrust-authz v1 IPC protocol over it and never opens the authorization
   * database directly.
   *
   * REQUIRED in real mode: without it the core would fall back to the local
   * mock-only client, which must never authorize a real settlement. In mock
   * mode it may be set (the IPC client is then constructed but never used to
   * sign anything, since the mock signer cannot sign).
   */
  authorizationSocket: string | null;
  /** Busy timeout for SQLite writers under multi-process contention. */
  busyTimeoutMs: number;
  /**
   * Which evidence verifier reconciliation uses.
   *
   * - `none`   → no trusted verifier configured. Reconciliation cannot finalize anything.
   *              This is the default and must stay the default.
   * - `fixture`→ deterministic offline verifier. Tests only.
   * - `grpc`   → real read-only Concordium node query. Requires an explicit endpoint.
   */
  evidenceMode: EvidenceMode;
  /** gRPC endpoint for the `grpc` evidence mode. Host only, no credentials. */
  nodeHost: string | null;
  /** gRPC port. */
  nodePort: number | null;
  /** Whether the node connection uses TLS. */
  nodeUseTls: boolean;
  /** Sender signature verification mode. */
  senderVerification: SenderVerificationMode;
  /** Per-request timeout for account info lookups (ms). */
  senderVerificationTimeoutMs: number;
  /**
   * Unix socket path of the dedicated sponsor signing service. Required in real
   * mode; must be absent in mock mode (the mock signer never uses IPC).
   */
  signingServiceSocket: string | null;
  /** Expected signing-service UID for SO_PEERCRED. Required in real mode. */
  signingServiceUid: number | null;
  /** Per-request timeout for signing IPC calls (ms). */
  signingServiceTimeoutMs: number;
  /**
   * Maximum sponsor fee (microCCD) accepted per settlement. Validated as a
   * non-negative integer. Default 10_000_000 (10 CCD). This is an ESTIMATE-based
   * policy (see `energy.ts`), NOT a guaranteed maximum actual chain fee.
   *
   * Evidence (live Testnet, protocol 10, `getBlockChainParameters`):
   *   exchange rate = euroPerEnergy(1/50000) × microGTUPerEuro(1316758697067716096/3671577513)
   *                 = 7172.71359466307 microCCD/NRG.
   *   Sponsored simple transfer energy = 603 NRG → 4.325 CCD at the live rate.
   *   The 10 CCD cap therefore covers up to ~1394 NRG with real headroom, and the
   *   conservative in-code estimate (8000 microCCD/NRG, see `core.ts`) covers ~1250 NRG.
   *
   * A protocol rate source EXISTS (chain parameters, above), but it does not make
   * the signing boundary able to guarantee an actual fee: the signing service has
   * no node transport and cannot fetch or validate a current rate at signing time,
   * and a rate fetched at signing time can go stale before execution (the fee is
   * settled at the execution-time rate). An actual fee guarantee therefore needs
   * a separate design and remains UNRESOLVED; the energy cap is the hard bound.
   */
  maxFeeMicroCcd: bigint;
  /**
   * Maximum sponsor execution energy accepted per settlement.
   *
   * Default changed from the placeholder `100_000` to `1_000` NRG. The old value implied a
   * worst-case fee of 800 CCD at the conservative rate (717 CCD at the live rate), which
   * contradicted the 10 CCD fee cap — the two caps were not internally consistent.
   *
   * `1_000` NRG is defensible: the measured sponsored simple transfer costs 603 NRG, so it
   * leaves ~1.66× margin; at the conservative 8000 microCCD/NRG estimate it costs 8 CCD
   * (20% under the 10 CCD fee cap); at the live 7172.71 rate it costs 7.17 CCD.
   * Any value above 1_250 NRG would exceed the 10 CCD fee cap under the conservative rate.
   *
   * Compatibility: an operator who relied on the old 100_000 default must set
   * `FACILITATOR_MAX_ENERGY` explicitly for anything above 1_000 NRG. Tests that construct
   * the signer/core directly pass their own values and are unaffected.
   */
  maxEnergy: bigint;
  /**
   * Absolute path to the sponsor wallet export used by the signing service.
   *
   * This is a *path*, never the contents. The facilitator never reads it — it exists so
   * the signing-service launcher and the deployment can be validated from one config
   * source, and so an operator can see which file is expected without inspecting it.
   * Validated: absolute path, no traversal, file must exist and be readable.
   */
  sponsorWalletFile: string | null;
  /**
   * Run `recoverPending()` once at startup, before advertising readiness.
   * Default `false` (opt-in) so existing mock-mode tests are unaffected.
   */
  recoverOnStartup: boolean;
  /** Bounded timeout for the startup recovery pass (ms). Default 30_000. */
  startupRecoveryTimeoutMs: number;
}

export type EvidenceMode = 'none' | 'fixture' | 'grpc';

/**
 * Sender signature verification mode.
 *
 * - `passthrough` → mock/test only. No signature check. MUST NOT be selected in real mode.
 * - `sdk`         → real SDK verification via GrpcAccountInfoProvider + SdkSenderVerifier.
 *                   Requires a configured Concordium node endpoint.
 *
 * There is no implicit default in real mode: an unset value is an initialization error.
 */
export type SenderVerificationMode = 'passthrough' | 'sdk';

export const TESTNET_CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
export const MAINNET_CAIP2 = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';

/** Concordium base58check account shape. 45–55 chars, no 0/O/I/l. */
const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/;

export function isConcordiumAccount(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_RE.test(value);
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Build a config from an environment-like record.
 *
 * Fail-closed rules:
 *  - `FACILITATOR_MODE` must be explicit. There is no implicit `real`.
 *  - `mock` never needs a sponsor and never signs anything.
 *  - `real` requires a sponsor address, the IPC signing service (socket + UID),
 *    the Authorization Owner socket, and `sdk` sender verification. Any of them
 *    missing is an initialization error; there is no silent fallback.
 *  - mainnet is refused outright: this prototype is testnet-scoped.
 */
export function loadConfig(env: Record<string, string | undefined>): FacilitatorConfig {
  const rawMode = env['FACILITATOR_MODE'];
  if (rawMode !== 'mock' && rawMode !== 'real') {
    throw new ConfigurationError(
      "FACILITATOR_MODE must be set explicitly to 'mock' or 'real' — refusing to guess",
    );
  }
  const mode: FacilitatorMode = rawMode;

  const network = env['FACILITATOR_NETWORK'] ?? TESTNET_CAIP2;
  if (network === MAINNET_CAIP2) {
    throw new ConfigurationError('mainnet is out of scope for this prototype');
  }
  if (network !== TESTNET_CAIP2) {
    throw new ConfigurationError(`unsupported network '${network}' (testnet only in this prototype)`);
  }

  const host = env['FACILITATOR_HOST'] ?? '127.0.0.1';
  if (mode === 'mock' && host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new ConfigurationError(
      'mock mode must bind to loopback: a mock facilitator must never be reachable from another host',
    );
  }

  // 0 is allowed: the OS assigns an ephemeral port, which is what tests use so they never
  // collide with a real service.
  const port = Number(env['FACILITATOR_PORT'] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError(`FACILITATOR_PORT is not a valid port: ${String(env['FACILITATOR_PORT'])}`);
  }

  const sponsorRaw = env['FACILITATOR_SPONSOR_ADDRESS'];
  const sponsorAddress = sponsorRaw === undefined || sponsorRaw === '' ? null : sponsorRaw;
  if (sponsorAddress !== null && !isConcordiumAccount(sponsorAddress)) {
    throw new ConfigurationError('FACILITATOR_SPONSOR_ADDRESS is not a Concordium base58check account');
  }
  if (mode === 'real' && sponsorAddress === null) {
    throw new ConfigurationError('real mode requires FACILITATOR_SPONSOR_ADDRESS');
  }
  if (mode === 'mock' && sponsorAddress !== null) {
    throw new ConfigurationError(
      'mock mode must not be given a real sponsor address — the mock signer derives its own placeholder',
    );
  }

  // mock-mode-only address the mock signer reports (see the
  // interface comment). Real mode must never use it: a real settlement is
  // sponsored by the provisioned signer, never by a mock placeholder.
  const mockSponsorRaw = env['FACILITATOR_MOCK_SPONSOR_ADDRESS'];
  const mockSponsorAddress = mockSponsorRaw === undefined || mockSponsorRaw === '' ? null : mockSponsorRaw;
  if (mockSponsorAddress !== null && !isConcordiumAccount(mockSponsorAddress)) {
    throw new ConfigurationError('FACILITATOR_MOCK_SPONSOR_ADDRESS is not a Concordium base58check account');
  }
  if (mode === 'real' && mockSponsorAddress !== null) {
    throw new ConfigurationError('real mode must not be given FACILITATOR_MOCK_SPONSOR_ADDRESS');
  }

  const pendingTtlMs = Number(env['FACILITATOR_PENDING_TTL_MS'] ?? 120_000);
  const replayTtlMs = Number(env['FACILITATOR_REPLAY_TTL_MS'] ?? 600_000);
  for (const [name, v] of [
    ['FACILITATOR_PENDING_TTL_MS', pendingTtlMs],
    ['FACILITATOR_REPLAY_TTL_MS', replayTtlMs],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) throw new ConfigurationError(`${name} must be a positive number`);
  }

  // Evidence verifier configuration. Default is `none` — no trusted verifier, so
  // reconciliation can never finalize anything. That is the safe default.
  const evidenceModeRaw = env['FACILITATOR_EVIDENCE_MODE'] ?? 'none';
  if (evidenceModeRaw !== 'none' && evidenceModeRaw !== 'fixture' && evidenceModeRaw !== 'grpc') {
    throw new ConfigurationError(`FACILITATOR_EVIDENCE_MODE must be 'none', 'fixture' or 'grpc'`);
  }
  const evidenceMode = evidenceModeRaw as EvidenceMode;

  const nodeHostRaw = env['FACILITATOR_NODE_HOST'];
  const nodeHost = nodeHostRaw === undefined || nodeHostRaw === '' ? null : nodeHostRaw;
  const nodePortRaw = env['FACILITATOR_NODE_PORT'];
  const nodePort = nodePortRaw === undefined || nodePortRaw === '' ? null : Number(nodePortRaw);
  if (nodePort !== null && (!Number.isInteger(nodePort) || nodePort < 1 || nodePort > 65535)) {
    throw new ConfigurationError('FACILITATOR_NODE_PORT is not a valid port');
  }
  const nodeUseTls = env['FACILITATOR_NODE_USE_TLS'] === '1';

  if (evidenceMode === 'grpc') {
    if (nodeHost === null) throw new ConfigurationError('grpc evidence mode requires FACILITATOR_NODE_HOST');
    if (nodePort === null) throw new ConfigurationError('grpc evidence mode requires FACILITATOR_NODE_PORT');
  }
  if (evidenceMode === 'none' && (nodeHost !== null || nodePort !== null)) {
    // Not an error — operators may stage config — but the values are unused.
  }

  const dbPath = env['FACILITATOR_DB_PATH'] ?? ':memory:';
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new ConfigurationError('FACILITATOR_DB_PATH must be a non-empty path');
  }
  // A durable service must not silently fall back to memory: that is exactly the restart bug
  // this change exists to fix.
  if (mode === 'real' && dbPath === ':memory:') {
    throw new ConfigurationError('real mode requires a durable FACILITATOR_DB_PATH, not :memory:');
  }

  const dbFileModeRaw = env['FACILITATOR_DB_FILE_MODE'];
  let dbFileMode: number | null = null;
  if (dbFileModeRaw !== undefined && dbFileModeRaw !== '') {
    if (!/^0[0-7]{3}$/.test(dbFileModeRaw)) {
      throw new ConfigurationError('FACILITATOR_DB_FILE_MODE must be an octal mode like 0644');
    }
    dbFileMode = parseInt(dbFileModeRaw, 8);
    if ((dbFileMode & 0o022) !== 0) {
      throw new ConfigurationError('FACILITATOR_DB_FILE_MODE must not grant group or world write — the Owner launcher refuses a settlement file writable by its UID');
    }
  }

  const reconcileEnabled = env['FACILITATOR_RECONCILE_ENABLED'] === '1';
  const tokenRaw = env['FACILITATOR_OPERATOR_TOKEN_SHA256'];
  const operatorTokenSha256 = tokenRaw === undefined || tokenRaw === '' ? null : tokenRaw;
  if (reconcileEnabled && operatorTokenSha256 === null) {
    throw new ConfigurationError(
      'FACILITATOR_RECONCILE_ENABLED=1 requires FACILITATOR_OPERATOR_TOKEN_SHA256',
    );
  }
  if (operatorTokenSha256 !== null && !/^[0-9a-f]{64}$/i.test(operatorTokenSha256)) {
    throw new ConfigurationError('FACILITATOR_OPERATOR_TOKEN_SHA256 must be a 64-character hex SHA-256 digest');
  }

  const expiresRaw = env['FACILITATOR_OPERATOR_TOKEN_EXPIRES_AT'];
  const operatorTokenExpiresAt =
    expiresRaw === undefined || expiresRaw === '' ? null : Number(expiresRaw);
  if (operatorTokenExpiresAt !== null && (!Number.isFinite(operatorTokenExpiresAt) || operatorTokenExpiresAt <= 0)) {
    throw new ConfigurationError('FACILITATOR_OPERATOR_TOKEN_EXPIRES_AT must be an epoch timestamp in ms');
  }

  const submitLedgerPath = env['FACILITATOR_SUBMIT_LEDGER'] ?? null;
  const processLabel = env['FACILITATOR_PROCESS_LABEL'] ?? null;
  const busyTimeoutMs = Number(env['FACILITATOR_BUSY_TIMEOUT_MS'] ?? 5000);
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new ConfigurationError('FACILITATOR_BUSY_TIMEOUT_MS must be a non-negative number');
  }

  const authorizationSocketRaw = env['FACILITATOR_AUTHZ_SOCKET'];
  const authorizationSocket =
    authorizationSocketRaw === undefined || authorizationSocketRaw.trim() === ''
      ? null
      : authorizationSocketRaw.trim();

  // ── Sender signature verification ────────────────────────────────
  // Selection rule (fail-closed):
  //   - `real` mode: `sdk` is REQUIRED. `passthrough` or unset is an initialization error.
  //   - `mock` mode: `passthrough` is the default. `sdk` is allowed (it will hit a real
  //     node) but never implied.
  // There is no environment-based implicit fallback to passthrough in real mode.
  const senderRaw = env['FACILITATOR_SENDER_VERIFICATION'];
  let senderVerification: SenderVerificationMode;
  if (senderRaw === 'sdk') {
    senderVerification = 'sdk';
  } else if (senderRaw === 'passthrough' || senderRaw === undefined || senderRaw === '') {
    senderVerification = 'passthrough';
  } else {
    throw new ConfigurationError(
      "FACILITATOR_SENDER_VERIFICATION must be 'sdk' or 'passthrough'",
    );
  }
  if (mode === 'real' && senderVerification !== 'sdk') {
    throw new ConfigurationError(
      'real mode REQUIRES FACILITATOR_SENDER_VERIFICATION=sdk — refusing to run with a pass-through verifier',
    );
  }
  if (senderVerification === 'sdk') {
    if (nodeHost === null) {
      throw new ConfigurationError('sdk sender verification requires FACILITATOR_NODE_HOST');
    }
    if (nodePort === null) {
      throw new ConfigurationError('sdk sender verification requires FACILITATOR_NODE_PORT');
    }
    if (network !== TESTNET_CAIP2) {
      throw new ConfigurationError('sdk sender verification supports the configured Testnet network only');
    }
  }

  const senderVerificationTimeoutMs = Number(env['FACILITATOR_SENDER_VERIFY_TIMEOUT_MS'] ?? 10_000);
  if (!Number.isFinite(senderVerificationTimeoutMs) || senderVerificationTimeoutMs <= 0) {
    throw new ConfigurationError('FACILITATOR_SENDER_VERIFY_TIMEOUT_MS must be a positive number');
  }

  // ── Sponsor signing service IPC ─────────────────────────────────
  // Selection rule (fail-closed):
  //   - `real` mode: BOTH socket and UID are REQUIRED. No default is substituted.
  //   - `mock` mode: neither may be set (the mock signer never speaks IPC). Setting them
  //     is an error so a stale config cannot silently point a mock at a real service.
  const signingSocketRaw = env['FACILITATOR_SIGNING_SERVICE_SOCKET'];
  const signingServiceSocket =
    signingSocketRaw === undefined || signingSocketRaw.trim() === '' ? null : signingSocketRaw.trim();
  if (signingServiceSocket !== null && !signingServiceSocket.startsWith('/')) {
    throw new ConfigurationError(
      'FACILITATOR_SIGNING_SERVICE_SOCKET must be an absolute Unix socket path',
    );
  }

  const signingUidRaw = env['FACILITATOR_SIGNING_SERVICE_UID'];
  let signingServiceUid: number | null;
  if (signingUidRaw === undefined || signingUidRaw.trim() === '') {
    signingServiceUid = null;
  } else {
    const parsedUid = Number(signingUidRaw);
    if (!Number.isInteger(parsedUid)) {
      throw new ConfigurationError(
        'FACILITATOR_SIGNING_SERVICE_UID must be an integer UID between 1 and 65533',
      );
    }
    // Root is called out separately: the signing service rejects it explicitly, so a
    // configuration that names it must fail with the same reasoning, not a range error.
    if (parsedUid === 0) {
      throw new ConfigurationError('FACILITATOR_SIGNING_SERVICE_UID must not be 0 (root is rejected)');
    }
    if (parsedUid < 1 || parsedUid > 65533) {
      throw new ConfigurationError(
        'FACILITATOR_SIGNING_SERVICE_UID must be an integer UID between 1 and 65533',
      );
    }
    signingServiceUid = parsedUid;
  }

  if (mode === 'real') {
    if (signingServiceSocket === null) {
      throw new ConfigurationError('real mode requires FACILITATOR_SIGNING_SERVICE_SOCKET');
    }
    if (signingServiceUid === null) {
      throw new ConfigurationError('real mode requires FACILITATOR_SIGNING_SERVICE_UID');
    }
  } else {
    if (signingServiceSocket !== null || signingServiceUid !== null) {
      throw new ConfigurationError(
        'mock mode must not configure the signing service — the mock signer never uses IPC',
      );
    }
  }

  const signingServiceTimeoutMs = Number(env['FACILITATOR_SIGNING_TIMEOUT_MS'] ?? 10_000);
  if (!Number.isFinite(signingServiceTimeoutMs) || signingServiceTimeoutMs <= 0) {
    throw new ConfigurationError('FACILITATOR_SIGNING_TIMEOUT_MS must be a positive number');
  }

  // ── Authorization Owner IPC ────────────────────────────────────────────────
  // Selection rule (fail-closed):
  //   - `real` mode: FACILITATOR_AUTHZ_SOCKET is REQUIRED. Without it the core
  //     would silently fall back to the local mock-only client, which must never
  //     authorize a real settlement. The socket must be an absolute path.
  //   - `mock` mode: optional. The IPC client is constructed when set, but the
  //     mock signer can never sign, so no real authorization can result.
  if (authorizationSocket !== null && !authorizationSocket.startsWith('/')) {
    throw new ConfigurationError('FACILITATOR_AUTHZ_SOCKET must be an absolute Unix socket path');
  }
  if (mode === 'real' && authorizationSocket === null) {
    throw new ConfigurationError(
      'real mode requires FACILITATOR_AUTHZ_SOCKET — the local authorization client is test-only and must not authorize real settlements',
    );
  }

  // ── Fee and energy caps ────────────────────────────────────────
  const maxFeeRaw = env['FACILITATOR_MAX_FEE_MICROCCD'];
  let maxFeeMicroCcd: bigint;
  if (maxFeeRaw === undefined || maxFeeRaw.trim() === '') {
    maxFeeMicroCcd = 10_000_000n;
  } else {
    if (!/^[0-9]+$/.test(maxFeeRaw.trim())) {
      throw new ConfigurationError('FACILITATOR_MAX_FEE_MICROCCD must be a non-negative integer (microCCD)');
    }
    maxFeeMicroCcd = BigInt(maxFeeRaw.trim());
  }
  const maxEnergyRaw = env['FACILITATOR_MAX_ENERGY'];
  let maxEnergy: bigint;
  if (maxEnergyRaw === undefined || maxEnergyRaw.trim() === '') {
    maxEnergy = 1_000n;
  } else {
    if (!/^[0-9]+$/.test(maxEnergyRaw.trim())) {
      throw new ConfigurationError('FACILITATOR_MAX_ENERGY must be a non-negative integer');
    }
    maxEnergy = BigInt(maxEnergyRaw.trim());
  }

  // ── Sponsor wallet export path ────────────────────────────────
  // A path only; the contents are never read here. Fail closed on anything that is not an
  // absolute, traversal-free path.
  const sponsorWalletRaw = env['FACILITATOR_SPONSOR_WALLET_FILE'];
  const sponsorWalletFile =
    sponsorWalletRaw === undefined || sponsorWalletRaw.trim() === '' ? null : sponsorWalletRaw.trim();
  if (sponsorWalletFile !== null) {
    if (!sponsorWalletFile.startsWith('/')) {
      throw new ConfigurationError('FACILITATOR_SPONSOR_WALLET_FILE must be an absolute path');
    }
    if (sponsorWalletFile.split('/').includes('..')) {
      throw new ConfigurationError('FACILITATOR_SPONSOR_WALLET_FILE must not contain path traversal');
    }
  }

  // ── Startup recovery ─────────────────────────────────────────
  const recoverRaw = env['FACILITATOR_RECOVER_ON_STARTUP'];
  const recoverOnStartup = recoverRaw === undefined || recoverRaw === '' ? false : recoverRaw === '1';
  if (recoverOnStartup && mode !== 'real') {
    // Recovery is a real-mode concern; enabling it in mock mode would be a no-op at best and
    // a confusing configuration at worst, so it is rejected rather than silently ignored.
    throw new ConfigurationError(
      'FACILITATOR_RECOVER_ON_STARTUP=1 is only meaningful in real mode',
    );
  }
  const startupRecoveryTimeoutRaw = env['FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS'];
  const startupRecoveryTimeoutMs =
    startupRecoveryTimeoutRaw === undefined || startupRecoveryTimeoutRaw.trim() === ''
      ? 30_000
      : Number(startupRecoveryTimeoutRaw);
  if (!Number.isFinite(startupRecoveryTimeoutMs) || startupRecoveryTimeoutMs <= 0) {
    throw new ConfigurationError('FACILITATOR_STARTUP_RECOVERY_TIMEOUT_MS must be a positive number');
  }

  return {
    mode,
    host,
    port,
    sponsorAddress,
    mockSponsorAddress,
    network,
    pendingTtlMs,
    replayTtlMs,
    dbPath,
    dbFileMode,
    reconcileEnabled,
    operatorTokenSha256,
    operatorTokenExpiresAt,
    submitLedgerPath,
    processLabel,
    busyTimeoutMs,
    evidenceMode,
    nodeHost,
    nodePort,
    nodeUseTls,
    authorizationSocket,
    senderVerification,
    senderVerificationTimeoutMs,
    signingServiceSocket,
    signingServiceUid,
    signingServiceTimeoutMs,
    maxFeeMicroCcd,
    maxEnergy,
    sponsorWalletFile,
    recoverOnStartup,
    startupRecoveryTimeoutMs,
  };
}
