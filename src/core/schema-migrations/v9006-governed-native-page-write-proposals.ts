import type { Migration } from './types.ts';

export const v9006: Migration = {
    version: 9006, // 9006
    name: 'governed_native_page_write_proposals',
    // [fork] Native agent knowledge writes are proposal → confirmation, never
    // an implicit direct put_page. The durable payload is actor-bound and
    // expires quickly; confirm re-authorizes federated_write and page ACL at
    // execution time, so this table is an audit/review queue, not a capability.
    idempotent: true,
    sql: `
      CREATE TABLE IF NOT EXISTS page_write_proposals (
        proposal_id               TEXT PRIMARY KEY,
        actor_id                  TEXT NOT NULL,
        source_id                 TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        slug                      TEXT NOT NULL,
        content                   TEXT NOT NULL,
        content_hash              TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        allowed_subject_ids       TEXT[],
        document_id               TEXT,
        document_version_sequence BIGINT,
        document_version_hash     TEXT,
        status                    TEXT NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'confirming', 'confirmed', 'cancelled', 'expired')),
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at                TIMESTAMPTZ NOT NULL,
        confirming_at             TIMESTAMPTZ,
        confirmed_at              TIMESTAMPTZ,
        cancelled_at              TIMESTAMPTZ,
        CONSTRAINT page_write_proposals_acl_nonempty_check
          CHECK (allowed_subject_ids IS NULL OR cardinality(allowed_subject_ids) > 0),
        CONSTRAINT page_write_proposals_document_fence_shape_check CHECK (
          (document_id IS NULL AND document_version_sequence IS NULL AND document_version_hash IS NULL)
          OR
          (document_id IS NOT NULL AND char_length(document_id) BETWEEN 1 AND 200
            AND document_version_sequence >= 1
            AND document_version_hash ~ '^[a-f0-9]{64}$')
        )
      );
      CREATE INDEX IF NOT EXISTS page_write_proposals_actor_status_expires_idx
        ON page_write_proposals (actor_id, status, expires_at);
    `,
  };
