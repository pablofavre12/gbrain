import type { Migration } from './types.ts';

export const v9005: Migration = {
    version: 9005, // 9005
    name: 'page_acl_and_document_version_fence',
    // [fork] Page-level ACL for Platform documents plus an atomic monotonic
    // destination fence. NULL ACL preserves all legacy/source-level behavior.
    // A non-empty ACL is filtered in every agent-facing page/search/graph
    // engine path against server-resolved subjects. The GIN index supports
    // the array-overlap predicate. Four nullable columns are metadata-only on
    // Postgres 11+; existing rows remain public within their source.
    idempotent: true,
    sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS acl_subject_ids TEXT[];
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS document_id TEXT;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS document_version_sequence BIGINT;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS document_version_hash TEXT;

      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_acl_nonempty_check;
      ALTER TABLE pages ADD CONSTRAINT pages_acl_nonempty_check
        CHECK (acl_subject_ids IS NULL OR cardinality(acl_subject_ids) > 0);

      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_document_fence_shape_check;
      ALTER TABLE pages ADD CONSTRAINT pages_document_fence_shape_check CHECK (
        (document_id IS NULL AND document_version_sequence IS NULL AND document_version_hash IS NULL)
        OR
        (document_id IS NOT NULL AND char_length(document_id) BETWEEN 1 AND 200
          AND document_version_sequence >= 1
          AND document_version_hash ~ '^[a-f0-9]{64}$')
      );

      CREATE INDEX IF NOT EXISTS pages_acl_subject_ids_idx
        ON pages USING GIN (acl_subject_ids)
        WHERE acl_subject_ids IS NOT NULL;
    `,
  };
