import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import type { FrozenHit } from './evidence-delivery.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { currentTextProjectionFilter, safeChunksFilter, requiresSafeChunks } from './safe-chunks.ts';
import { applyEffectiveDate } from '../utils.ts';

/**
 * Resolve frozen (source_id, slug, chunk_id) hits into search rows under the
 * caller's read scope (one query). Hits outside the scope, on deleted or
 * private-to-this-caller pages, or naming a chunk the page no longer holds
 * are unresolved. chunk_id 0 addresses the page's first chunk.
 */
export async function resolveFrozenHits(
  engine: BrainEngine,
  hits: FrozenHit[],
  scope: PageReadScope,
): Promise<{ rows: SearchResult[]; unresolved: number[] }> {
  if (hits.length === 0) return { rows: [], unresolved: [] };
  const params: unknown[] = [
    hits.map(h => String(h.source_id)),
    hits.map(h => String(h.slug)),
    hits.map(h => (Number.isInteger(h.chunk_id) ? h.chunk_id : -1)),
    hits.map((_, i) => i),
  ];
  const filter = pageReadFilter('p', scope, params, true);
  const safe = requiresSafeChunks(scope) ? `AND ${safeChunksFilter('p')}` : '';
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT h.ord, p.id AS page_id, p.slug, p.source_id, p.title, p.type,
            p.effective_date, p.effective_date_source,
            cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS h(source_id, slug, chunk_id, ord)
       JOIN pages p ON p.source_id = h.source_id AND p.slug = h.slug
       LEFT JOIN content_chunks cc ON cc.page_id = p.id
            AND CASE WHEN h.chunk_id > 0 THEN cc.id = h.chunk_id ELSE cc.chunk_index = 0 END
      WHERE ${filter} AND ${currentTextProjectionFilter('p')} ${safe}`,
    params,
  );
  const byOrd = new Map<number, Record<string, unknown>>();
  for (const r of rows) byOrd.set(Number(r.ord), r);
  const out: SearchResult[] = [];
  const unresolved: number[] = [];
  hits.forEach((h, i) => {
    const r = byOrd.get(i);
    if (!r || (h.chunk_id > 0 && r.chunk_id == null) || h.chunk_id < 0) { unresolved.push(i); return; }
    const row: SearchResult = {
      slug: String(r.slug),
      page_id: Number(r.page_id),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as SearchResult['type'],
      chunk_text: r.chunk_text == null ? '' : String(r.chunk_text),
      chunk_source: (r.chunk_source ?? 'compiled_truth') as SearchResult['chunk_source'],
      chunk_id: r.chunk_id == null ? 0 : Number(r.chunk_id),
      chunk_index: r.chunk_index == null ? 0 : Number(r.chunk_index),
      score: 0,
      stale: false,
    };
    // The page date, normalized exactly as live search rows are, so frozen
    // and live delivery hand a reader the same date fields.
    applyEffectiveDate(row, r);
    out.push(row);
  });
  return { rows: out, unresolved };
}

