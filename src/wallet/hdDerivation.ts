/**
 * Internal Wallet Context HD derivation session.
 *
 * The seed is accepted only from inside the Wallet Context (never postMessage),
 * validated with the v2 descriptor validator, used to derive a Concordium
 * account signing key, and held only for this session. Lock / auto-lock clear
 * every derived reference. No storage, no network, no IDP/node calls.
 */
import { ConcordiumHdWallet, buildBasicAccountSigner, verifyAccountSignature, type AccountSigner } from '@concordium/web-sdk';
import { validateV2WalletDescriptor, type V2Credential } from './v2DescriptorValidator.js';

export interface HdInitInput {
  seedHex: string;
  walletId: string;
  idpIndex: number;
  identityIndex: number;
  credentials: V2Credential[];
}

export interface HdSessionOptions {
  crypto: Crypto;
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  autoLockMs?: number;
}

export interface HdCredentialView {
  credIndex: number;
  publicKey: string;
  signerMatchesDerivedPublicKey: boolean;
}

interface DerivedCredential {
  credIndex: number;
  publicKey: string;
  signer: AccountSigner;
}

const SAMPLE_DIGEST = new Uint8Array(32).fill(7);

function accountInfoFor(publicKey: string) {
  return {
    accountThreshold: 1,
    accountAddress: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    accountCredentials: {
      0: {
        value: {
          contents: {
            credentialPublicKeys: {
              keys: { 0: { schemeId: 'Ed25519', verifyKey: publicKey } },
              threshold: 1,
            },
          },
        },
      },
    },
  };
}

export function createHdDerivationSession(opts: HdSessionOptions) {
  const autoLockMs = opts.autoLockMs ?? 60_000;
  let hd: ConcordiumHdWallet | null = null;
  let derived = new Map<number, DerivedCredential>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;

  const clearTimer = () => { if (timer) { opts.clearTimeout(timer); timer = null; } };

  const lock = (): void => {
    clearTimer();
    epoch += 1; // invalidates every signer view handed out before this lock
    derived = new Map();
    hd = null;
    // Seed string is not retained by this session after initialization.
  };

  const scheduleAutoLock = () => {
    clearTimer();
    timer = opts.setTimeout(() => lock(), autoLockMs);
  };

  const initialize = async (input: HdInitInput): Promise<
    | { ok: true; credentials: HdCredentialView[] }
    | { ok: false; reason: string }
  > => {
    lock();
    try {
      const aad = `agenttrust|2|testnet|${input.walletId}`;
      const descriptor = {
        schemaVersion: 2,
        kind: 'v2-hd',
        network: 'testnet',
        walletId: input.walletId,
        seedHex: input.seedHex,
        aad,
        identity: { idpIndex: input.idpIndex, identityIndex: input.identityIndex },
        credentials: input.credentials,
        metadata: {
          walletId: input.walletId,
          schemaVersion: 2,
          network: 'testnet',
          identity: { idpIndex: input.idpIndex, identityIndex: input.identityIndex },
          credentials: input.credentials,
        },
      };
      const validation = validateV2WalletDescriptor(descriptor);
      if (!validation.ok) return { ok: false, reason: `descriptor_invalid:${validation.errors[0]?.code ?? 'unknown'}` };

      const wallet = ConcordiumHdWallet.fromHex(input.seedHex, 'Testnet');
      const views: HdCredentialView[] = [];
      const next = new Map<number, DerivedCredential>();
      for (const cred of input.credentials) {
        const keyIndexes = Object.keys(cred.publicKeys).map(Number).filter(n => Number.isInteger(n)).sort((a, b) => a - b);
        if (keyIndexes.length === 0 || cred.threshold !== 1) {
          return { ok: false, reason: 'unsupported_threshold' };
        }
        const keyIndex = keyIndexes[0];
        const privateKeyHex = wallet.getAccountSigningKey(input.idpIndex, input.identityIndex, cred.credIndex).toString('hex');
        const publicKey = wallet.getAccountPublicKey(input.idpIndex, input.identityIndex, cred.credIndex).toString('hex');
        const signer = buildBasicAccountSigner(privateKeyHex);
        const signature = await signer.sign(SAMPLE_DIGEST);
        const matches = await verifyAccountSignature(SAMPLE_DIGEST, signature, accountInfoFor(publicKey) as never);
        if (!matches) return { ok: false, reason: 'signer_public_key_mismatch' };
        next.set(cred.credIndex, { credIndex: cred.credIndex, publicKey, signer });
        views.push({ credIndex: cred.credIndex, publicKey, signerMatchesDerivedPublicKey: matches });
      }
      hd = wallet;
      derived = next;
      scheduleAutoLock();
      return { ok: true, credentials: views };
    } catch {
      lock();
      return { ok: false, reason: 'derivation_failed' };
    }
  };

  /** INTERNAL ONLY: never exposed through postMessage. */
  const getSigner = (credIndex: number): AccountSigner | null => {
    const entry = derived.get(credIndex);
    if (!entry || !hd) return null;
    scheduleAutoLock();
    const issuedEpoch = epoch;
    // Revocable view: after lock/auto-lock the underlying signer is gone and
    // any previously handed-out view refuses to sign.
    return {
      async sign(digest: ArrayBuffer) {
        if (issuedEpoch !== epoch || !hd || !derived.has(credIndex)) {
          throw new Error('wallet_locked');
        }
        return entry.signer.sign(digest);
      },
      getSignatureCount() {
        if (issuedEpoch !== epoch || !hd || !derived.has(credIndex)) {
          throw new Error('wallet_locked');
        }
        return entry.signer.getSignatureCount();
      },
    } as AccountSigner;
  };

  const touch = (): boolean => {
    if (!hd || derived.size === 0) return false;
    scheduleAutoLock();
    return true;
  };

  const status = (): { state: 'locked' | 'unlocked'; credentials: { credIndex: number; publicKey: string }[] } => ({
    state: hd && derived.size > 0 ? 'unlocked' : 'locked',
    credentials: hd ? Array.from(derived.values()).map(c => ({ credIndex: c.credIndex, publicKey: c.publicKey })) : [],
  });

  return { initialize, getSigner, lock, touch, status };
}
