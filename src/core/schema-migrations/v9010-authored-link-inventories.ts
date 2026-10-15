import type { Migration } from './types.ts';

/** Rebuilt by the normal versioned extraction sweep; no content or healing queue is rewritten. */
export const v9010: Migration = {
  version: 9010, name: 'authored_link_inventories', idempotent: true,
  sql: `CREATE TABLE IF NOT EXISTS authored_link_inventories (
  origin_page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  origin_revision UUID NOT NULL,
  refs JSONB NOT NULL CHECK (jsonb_typeof(refs) = 'array'),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authored_link_inventories_source_idx ON authored_link_inventories(source_id);
DO $rls$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user,pr.oid,'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
      ALTER TABLE authored_link_inventories ENABLE ROW LEVEL SECURITY;
    END IF;
  END $rls$;`,
};
