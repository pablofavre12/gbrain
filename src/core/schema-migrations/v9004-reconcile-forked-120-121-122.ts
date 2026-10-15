import type { Migration } from './types.ts';

export const v9004: Migration = {
    version: 9004, // 9004
    name: 'reconcile_forked_120_121_122',
    idempotent: true,
    sql: '',
    // Low-range migrations are reconciled by the independent upstream cursor.
  };
