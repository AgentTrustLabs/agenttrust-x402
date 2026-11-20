/**
 * Pure offline validator for a Wallet Vault v2 descriptor (design only).
 * Never derives keys, signs, persists, or contacts IDP/node.
 * Errors are stable codes + paths only — never secret values.
 */

export const V2_SCHEMA_VERSION = 2 as const;
export const V2_KIND = 'v2-hd' as const;
export const V2_NETWORK = 'testnet' as const;

export interface V2PublicKey {
  schemeId: 'Ed25519';
  verifyKey: string;
}

export interface V2Credential {
  credIndex: number;
  publicKeys: Record<number, V2PublicKey>;
  threshold: number;
}

export interface V2WalletDescriptor {
  schemaVersion: number;
  kind: string;
  network: string;
  walletId: string;
  seedHex: string;
  aad: string;
  identity: { idpIndex: number; identityIndex: number };
  credentials: V2Credential[];
  metadata: {
    walletId: string;
    schemaVersion: number;
    network: string;
    identity: { idpIndex: number; identityIndex: number };
    credentials: {
      credIndex: number;
      publicKeys: Record<number, V2PublicKey>;
      threshold: number;
    }[];
  };
}

export interface ValidationIssue {
  code: string;
  path: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationIssue[] };

const HEX128 = /^[0-9a-f]{128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function expectedAad(walletId: string): string {
  return `agenttrust|${V2_SCHEMA_VERSION}|${V2_NETWORK}|${walletId}`;
}

export function validateV2WalletDescriptor(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const push = (code: string, path: string) => errors.push({ code, path });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ code: 'INVALID_DESCRIPTOR', path: '$' }] };
  }
  const d = input as Record<string, unknown>;

  if (d['schemaVersion'] !== V2_SCHEMA_VERSION) push('INVALID_SCHEMA_VERSION', 'schemaVersion');
  if (d['kind'] !== V2_KIND) push('INVALID_KIND', 'kind');
  if (d['network'] !== V2_NETWORK) push('NETWORK_MISMATCH', 'network');

  if (typeof d['seedHex'] !== 'string' || !HEX128.test(d['seedHex'])) push('INVALID_SEED_HEX', 'seedHex');
  if (typeof d['walletId'] !== 'string' || !HEX64.test(d['walletId'])) push('INVALID_WALLET_ID', 'walletId');

  const identity = d['identity'];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    push('INVALID_IDENTITY', 'identity');
  } else {
    const id = identity as Record<string, unknown>;
    if (!isNonNegativeInt(id['idpIndex'])) push('INVALID_IDP_INDEX', 'identity.idpIndex');
    if (!isNonNegativeInt(id['identityIndex'])) push('INVALID_IDENTITY_INDEX', 'identity.identityIndex');
  }

  const credentials = d['credentials'];
  const seenCredIndexes = new Set<number>();
  if (!Array.isArray(credentials) || credentials.length === 0) {
    push('INVALID_CREDENTIALS', 'credentials');
  } else {
    credentials.forEach((c, i) => {
      const path = `credentials[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) { push('INVALID_CREDENTIAL', path); return; }
      const cred = c as Record<string, unknown>;
      if (!isNonNegativeInt(cred['credIndex'])) {
        push('INVALID_CREDENTIAL_INDEX', `${path}.credIndex`);
      } else {
        if (seenCredIndexes.has(cred['credIndex'])) push('DUPLICATE_CREDENTIAL_INDEX', `${path}.credIndex`);
        seenCredIndexes.add(cred['credIndex']);
      }
      const keys = cred['publicKeys'];
      let keyCount = 0;
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
        push('INVALID_PUBLIC_KEYS', `${path}.publicKeys`);
      } else {
        const entries = Object.entries(keys as Record<string, unknown>);
        const seenKeyIndexes = new Set<number>();
        for (const [keyIndex, value] of entries) {
          const kpath = `${path}.publicKeys[${keyIndex}]`;
          if (!/^\d+$/.test(keyIndex)) { push('INVALID_KEY_INDEX', kpath); continue; }
          const ki = Number(keyIndex);
          if (seenKeyIndexes.has(ki)) push('DUPLICATE_KEY_INDEX', kpath);
          seenKeyIndexes.add(ki);
          if (!value || typeof value !== 'object') { push('INVALID_PUBLIC_KEY', kpath); continue; }
          const pk = value as Record<string, unknown>;
          if (pk['schemeId'] !== 'Ed25519') push('INVALID_SCHEME', `${kpath}.schemeId`);
          if (typeof pk['verifyKey'] !== 'string' || !HEX64.test(pk['verifyKey'])) push('INVALID_PUBLIC_KEY', `${kpath}.verifyKey`);
          keyCount++;
        }
        if (keyCount === 0) push('EMPTY_PUBLIC_KEYS', `${path}.publicKeys`);
      }
      const threshold = cred['threshold'];
      if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
        push('INVALID_THRESHOLD', `${path}.threshold`);
      } else if (keyCount > 0 && threshold > keyCount) {
        push('THRESHOLD_EXCEEDS_KEYS', `${path}.threshold`);
      }
    });
  }

  const walletId = typeof d['walletId'] === 'string' ? d['walletId'] : '';
  if (typeof d['aad'] !== 'string' || d['aad'] !== expectedAad(walletId)) push('AAD_MISMATCH', 'aad');

  const metadata = d['metadata'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    push('INVALID_METADATA', 'metadata');
  } else {
    const m = metadata as Record<string, unknown>;
    if (m['walletId'] !== d['walletId']) push('METADATA_WALLET_ID_MISMATCH', 'metadata.walletId');
    if (m['schemaVersion'] !== V2_SCHEMA_VERSION) push('METADATA_SCHEMA_MISMATCH', 'metadata.schemaVersion');
    if (m['network'] !== V2_NETWORK) push('METADATA_NETWORK_MISMATCH', 'metadata.network');
    const mid = m['identity'];
    if (!mid || typeof mid !== 'object') {
      push('METADATA_IDENTITY_MISMATCH', 'metadata.identity');
    } else if (identity && typeof identity === 'object') {
      const id = identity as Record<string, unknown>;
      const mm = mid as Record<string, unknown>;
      if (mm['idpIndex'] !== id['idpIndex'] || mm['identityIndex'] !== id['identityIndex']) {
        push('METADATA_IDENTITY_MISMATCH', 'metadata.identity');
      }
    }
    const mcreds = m['credentials'];
    if (!Array.isArray(mcreds) || !Array.isArray(credentials)) {
      push('METADATA_CREDENTIALS_MISMATCH', 'metadata.credentials');
    } else {
      const canon = (arr: unknown[]) => arr.map((c) => {
        const cc = (c ?? {}) as Record<string, unknown>;
        return { credIndex: cc['credIndex'], threshold: cc['threshold'], publicKeys: cc['publicKeys'] };
      });
      if (JSON.stringify(canon(mcreds)) !== JSON.stringify(canon(credentials))) {
        push('METADATA_CREDENTIALS_MISMATCH', 'metadata.credentials');
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
