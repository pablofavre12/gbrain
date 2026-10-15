import { guardForkTakeVectorResize } from '../fork-vector-migration.ts';
import type { Migration } from './types.ts';
import { hnswMaxDimsForType } from '../vector-index.ts';

export const v142: Migration = {
  version: 142,
  name: 'takes_embedding_dimension_matches_config',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    await engine.transaction(async tx => {
      // Skew guard (see renumber note above): branch-tester DBs at v141
      // missed extract_rollup_expected_limit; IF NOT EXISTS makes this free
      // everywhere else.
      await tx.executeRaw(
        `ALTER TABLE extract_rollup_7d
             ADD COLUMN IF NOT EXISTS expected_limit_count INTEGER NOT NULL DEFAULT 0`,
      );
      const dimRows = await tx.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
      );
      const configured = Number.parseInt(dimRows[0]?.value ?? '', 10);
      const embeddingDim = Number.isInteger(configured) && configured > 0 && configured <= 16000
        ? configured
        : 1536;

      const typeRows = await tx.executeRaw<{ formatted: string | null }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = 'takes'
             AND a.attname = 'embedding'
             AND NOT a.attisdropped`,
      );
      const current = typeRows[0]?.formatted?.match(/vector\((\d+)\)/i)?.[1];
      const resize = !current || Number.parseInt(current, 10) !== embeddingDim;
      if (resize) {
        await guardForkTakeVectorResize(tx, typeRows.length > 0, embeddingDim);
        await tx.executeRaw(`DROP INDEX IF EXISTS idx_takes_embedding_hnsw`);
        // A prior interrupted migration may already have removed the column.
        await tx.executeRaw(typeRows.length > 0
          ? `UPDATE takes SET embedding = NULL, embedded_at = NULL`
          : `UPDATE takes SET embedded_at = NULL`);
        await tx.executeRaw(`ALTER TABLE takes DROP COLUMN IF EXISTS embedding`);
        await tx.executeRaw(`ALTER TABLE takes ADD COLUMN embedding VECTOR(${embeddingDim})`);
      }
      // Repair an interrupted index build even when the column already matches.
      if (embeddingDim <= hnswMaxDimsForType('vector')) {
        await tx.executeRaw(
          `CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
               USING hnsw (embedding vector_cosine_ops)
               WHERE active AND embedding IS NOT NULL`,
        );
      }
      if (resize) process.stderr.write(`  v142: takes.embedding resized to vector(${embeddingDim}); existing take vectors cleared\n`);
    });
  },
};
