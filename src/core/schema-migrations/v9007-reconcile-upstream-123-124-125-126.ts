import type { Migration } from './types.ts';

export const v9007: Migration = {
    version: 9007, // 9007
    name: 'reconcile_upstream_123_124_125_126',
    // Production Perennia brains are already stamped 9006, so the ordinary
    // low-range runner would skip upstream 123-126. Replay their exact current
    // definitions here; every migration in the set is idempotent.
    idempotent: true,
    sql: '',
    // Low-range migrations are reconciled by the independent upstream cursor.
  };
