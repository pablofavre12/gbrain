import type { Migration } from './types.ts';

export const v9008: Migration = {
  version: 9008,
  name: 'independent_upstream_schema_cursor',
  sql: '',
  idempotent: true,
  verify: async engine => Number(await engine.getConfig('schema.upstream_version')) >= 245,
};
