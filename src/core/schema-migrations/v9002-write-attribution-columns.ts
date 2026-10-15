import type { Migration } from './types.ts';

export const v9002: Migration = {
    version: 9002, // 9002
    name: 'write_attribution_columns',
    idempotent: true,
    sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_write_client_id TEXT NULL;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_write_client_name TEXT NULL;
      ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS last_write_client_id TEXT NULL;
      ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS last_write_client_name TEXT NULL;
    `,
  };
