import type { Migration } from './types.ts';

export const v9000: Migration = {
    version: 9000, // 9000
    name: 'oauth_clients_federated_write_column',
    idempotent: true,
    sql: `ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_write TEXT[] NOT NULL DEFAULT '{}';`,
  };
