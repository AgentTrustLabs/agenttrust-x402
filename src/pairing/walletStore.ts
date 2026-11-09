/**
 * Durable agent-wallet persistence (SQLite, via node:sqlite).
 *
 * Same primitive the facilitator already uses (`services/facilitator/src/repository.ts`),
 * so no new dependency and no native build. The database holds wallet metadata and
 * lifecycle events — never raw private keys. Key material lives in the
 * `WalletKeyStore` boundary (`walletSigner.ts`).
 *
 * Fail-closed: every method throws on a storage error; the manager converts that
 * into a `storage_unavailable` result and never falls back to in-memory state.
 */

import { DatabaseSync } from 'node:sqlite';

export type WalletStatus = 'provisioned' | 'awaiting_funding' | 'active' | 'paused' | 'revoked' | 'recovery_required';
export type FundingStatus = 'unknown' | 'unfunded' | 'funded';

export interface WalletRecord {
  walletId: string;
  agentId: string;
  ownerWalletAddress: string;
  network: string;
  genesisHash: string;
  accountAddress: string | null;
  signingPublicKeyHex: string;
  status: WalletStatus;
  fundingStatus: FundingStatus;
  balanceMicroCcd: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WalletEvent {
  at: number;
  walletId: string;
  agentId: string;
  ownerWalletAddress: string;
  network: string;
  event: string;
  detail: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS agent_wallets (
  wallet_id            TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  owner_wallet_address TEXT NOT NULL,
  network              TEXT NOT NULL,
  genesis_hash         TEXT NOT NULL,
  account_address      TEXT,
  signing_public_key   TEXT NOT NULL,
  status               TEXT NOT NULL,
  funding_status       TEXT NOT NULL,
  balance_micro_ccd    TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_wallets_agent
  ON agent_wallets (owner_wallet_address, agent_id, network);
CREATE INDEX IF NOT EXISTS ix_agent_wallets_owner ON agent_wallets (owner_wallet_address);
CREATE TABLE IF NOT EXISTS wallet_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  wallet_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  owner_wallet_address TEXT NOT NULL,
  network   TEXT NOT NULL,
  event     TEXT NOT NULL,
  detail    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wallet_events_wallet ON wallet_events (wallet_id);
`;

export interface WalletStoreOptions {
  /** Path to the SQLite file, or ':memory:' for tests. */
  path: string;
}

export class WalletStore {
  private readonly db: DatabaseSync;
  constructor(opts: WalletStoreOptions) {
    this.db = new DatabaseSync(opts.path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Atomic upsert of a wallet row plus its event. */
  save(wallet: WalletRecord, event: string, detail: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO agent_wallets
             (wallet_id, agent_id, owner_wallet_address, network, genesis_hash, account_address,
              signing_public_key, status, funding_status, balance_micro_ccd, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(wallet_id) DO UPDATE SET
             account_address=excluded.account_address,
             status=excluded.status, funding_status=excluded.funding_status,
             balance_micro_ccd=excluded.balance_micro_ccd, updated_at=excluded.updated_at`,
        )
        .run(
          wallet.walletId, wallet.agentId, wallet.ownerWalletAddress, wallet.network, wallet.genesisHash,
          wallet.accountAddress, wallet.signingPublicKeyHex, wallet.status, wallet.fundingStatus,
          wallet.balanceMicroCcd, wallet.createdAt, wallet.updatedAt,
        );
      this.db
        .prepare(
          `INSERT INTO wallet_events (at, wallet_id, agent_id, owner_wallet_address, network, event, detail)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(Math.floor(Date.now() / 1000), wallet.walletId, wallet.agentId, wallet.ownerWalletAddress, wallet.network, event, detail);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  get(walletId: string): WalletRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_wallets WHERE wallet_id = ?')
      .get(walletId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  /** Existing wallet for (owner, agent, network). This is the idempotency key. */
  find(ownerWalletAddress: string, agentId: string, network: string): WalletRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_wallets WHERE owner_wallet_address = ? AND agent_id = ? AND network = ?')
      .get(ownerWalletAddress, agentId, network) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  listByOwner(ownerWalletAddress: string): WalletRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_wallets WHERE owner_wallet_address = ? ORDER BY created_at')
      .all(ownerWalletAddress) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  listAll(): WalletRecord[] {
    const rows = this.db.prepare('SELECT * FROM agent_wallets ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  events(walletId: string, limit = 100): WalletEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM wallet_events WHERE wallet_id = ? ORDER BY seq DESC LIMIT ?')
      .all(walletId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      at: Number(r['at']), walletId: String(r['wallet_id']), agentId: String(r['agent_id']),
      ownerWalletAddress: String(r['owner_wallet_address']), network: String(r['network']),
      event: String(r['event']), detail: String(r['detail']),
    }));
  }
}

function toRecord(row: Record<string, unknown>): WalletRecord {
  return {
    walletId: String(row['wallet_id']),
    agentId: String(row['agent_id']),
    ownerWalletAddress: String(row['owner_wallet_address']),
    network: String(row['network']),
    genesisHash: String(row['genesis_hash']),
    accountAddress: (row['account_address'] as string | null) ?? null,
    signingPublicKeyHex: String(row['signing_public_key']),
    status: row['status'] as WalletStatus,
    fundingStatus: row['funding_status'] as FundingStatus,
    balanceMicroCcd: (row['balance_micro_ccd'] as string | null) ?? null,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}
