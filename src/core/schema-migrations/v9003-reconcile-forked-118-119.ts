import type { Migration } from './types.ts';

export const v9003: Migration = {
    version: 9003, // 9003
    name: 'reconcile_forked_118_119',
    idempotent: true,
    sql: '',
    // Low-range migrations are reconciled by the independent upstream cursor.
  };
