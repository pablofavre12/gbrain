import type { BrainEngine, PageReferenceOpts } from '../engine.ts';
import type { Page } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';

export async function getPageById(engine: BrainEngine, pageId: number, opts?: PageReferenceOpts & { includeDeleted?: boolean }): Promise<Page | null> {
  const params: unknown[] = [pageId];
  const filter = pageReadFilter('p', opts, params);
  const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT p.slug,p.source_id FROM pages p WHERE p.id=$1 AND ${filter} ${opts?.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}`, params);
  const row = rows[0];
  return row ? (await engine.readPageSnapshot(row.slug, { ...opts, sourceId: row.source_id, sourceIds: [row.source_id], pageId }))?.page ?? null : null;
}

export type PageReference = Pick<Page, 'id' | 'slug' | 'source_id'>;

export async function getPageReferences(engine: BrainEngine, slug: string | undefined, opts?: PageReferenceOpts & { includeDeleted?: boolean; pageId?: number }): Promise<PageReference[]> {
  const params: unknown[] = [];
  const filter = pageReadFilter('p', opts, params);
  const identity = opts?.pageId !== undefined
    ? `p.id=$${params.push(opts.pageId)}` : `p.slug=$${params.push(slug)}`;
  let order = 'p.source_id,p.id';
  if (opts?.sourceIds?.length) {
    params.push(opts.sourceIds);
    order = `array_position($${params.length}::text[],p.source_id),p.id`;
  }
  const refs = await engine.executeRaw<PageReference>(
    `SELECT p.id,p.slug,p.source_id FROM pages p WHERE ${identity} AND ${filter} ${opts?.includeDeleted ? '' : 'AND p.deleted_at IS NULL'} ORDER BY ${order}`, params);
  return refs.map(ref => ({ ...ref, id: Number(ref.id) }));
}

export async function getPageLayers(engine: BrainEngine, slug: string, opts?: PageReferenceOpts & { includeDeleted?: boolean }): Promise<Page[]> {
  const refs = await getPageReferences(engine, slug, opts);
  const pages = await Promise.all(refs.map(ref => engine.readPageSnapshot(ref.slug, { ...opts, sourceId: ref.source_id, sourceIds: [ref.source_id], pageId: ref.id })));
  return pages.flatMap(snapshot => snapshot ? [snapshot.page] : []);
}
