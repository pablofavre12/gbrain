import type { BrainEngine } from './engine.ts';

/** A fork upgrade must not erase populated vectors as a side effect of aligning dimensions. */
export async function guardForkTakeVectorResize(engine: BrainEngine, columnExists: boolean, targetDimensions: number): Promise<void> {
  if (!columnExists || Number(await engine.getConfig('version')) < 9000) return;
  const [row] = await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM takes WHERE embedding IS NOT NULL');
  if (Number(row?.n ?? 0) > 0) {
    throw new Error(`Fork upgrade refused: ${row.n} take embeddings would be cleared to resize to ${targetDimensions} dimensions. Reconcile the configured embedding dimensions with the existing vectors before retrying; no automatic re-embedding is authorized.`);
  }
}
