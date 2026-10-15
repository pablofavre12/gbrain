import type { Migration } from './types.ts';
export const v9009: Migration = {
  version:9009, name:'governed_write_base_revision', idempotent:true,
  sql:`ALTER TABLE page_write_proposals
    ADD COLUMN IF NOT EXISTS base_revision UUID,
    ADD COLUMN IF NOT EXISTS confirming_client_id TEXT;
    ALTER TABLE page_write_proposals DROP CONSTRAINT IF EXISTS page_write_proposals_status_check;
    ALTER TABLE page_write_proposals ADD CONSTRAINT page_write_proposals_status_check
      CHECK(status IN ('pending','confirming','confirmed','cancelled','expired','failed'));`,
};
