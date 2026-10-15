import type { Migration } from './types.ts';

export const v9001: Migration = {
    version: 9001, // 9001
    name: 'oauth_clients_federated_write_gin_index',
    idempotent: true,
    sql: `CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_write ON oauth_clients USING GIN (federated_write);`,
  };
