import { getPageReferences } from '../page-state/fork-page-refs.ts';
import type { BrainEngine } from '../engine.ts';
import { findPrivateOnlySlugs } from '../search/private-visibility.ts';
import { OperationError, type Operation, type OperationContext } from './contract.ts';
import { pageNotFoundError, type federatedSearchScope } from './context.ts';
import { PageSnapshotAmbiguousError, type PageSnapshot } from '../page-state/types.ts';

/** Resolve exact identity and authorized layers before the normal get_page projection. */
export async function resolveForkGetPage(
  ctx: OperationContext, p: Record<string, unknown>, slug: string,
  sourceOpts: ReturnType<typeof federatedSearchScope>, includeDeleted: boolean,
  excludePrivate: boolean, sourceIdParam: string | undefined, readPage: Operation['handler'],
): Promise<{ slug: string; snapshot: PageSnapshot | null; layers?: { slug: string; multi_source: true; layers: unknown[] } }> {
    if (p.page_id !== undefined) {
      const [selected] = await getPageReferences(ctx.engine, undefined, { pageId: p.page_id as number, includeDeleted, excludePrivate, ...sourceOpts });
      if (!selected) throw pageNotFoundError(ctx, slug ?? String(p.page_id), { includeDeleted, sourceIdParam });
      if (slug && slug !== selected.slug) throw new OperationError('invalid_params', 'page_id and slug disagree.', "Pass a positive page_id and a matching slug when both are supplied.");
      slug = selected.slug;
    }
    if (p.include_layers === true && p.page_id === undefined) {
      const candidates = await getPageReferences(ctx.engine, slug, { includeDeleted, excludePrivate, ...sourceOpts });
      if (candidates.length > 1) {
        const order = sourceOpts.sourceIds;
        if (order) candidates.sort((a, b) => order.indexOf(a.source_id) - order.indexOf(b.source_id));
        const layers: unknown[] = [];
        for (const candidate of candidates) {
          try {
            layers.push(await readPage(ctx, { ...p, include_layers: false, page_id: candidate.id, source: candidate.source_id, source_id: candidate.source_id }));
          } catch (error) {
            // A revoked/deleted layer between enumeration and its read stays hidden.
            if (!(error instanceof OperationError) || error.code !== 'page_not_found') throw error;
          }
        }
        return { slug, snapshot: null, layers: { slug, multi_source: true, layers } };
      }
    }
    let snapshot: PageSnapshot | null;
    try {
      const options = { includeDeleted, excludePrivate, ...sourceOpts, pageId: p.page_id as number | undefined, requireUnambiguous: true };
      snapshot = await ctx.engine.readPageSnapshot(slug, options)
        ?? await ctx.engine.readPageSnapshot(slug, { ...options, resolveAlias: true });
    } catch (error) {
      if (!(error instanceof PageSnapshotAmbiguousError)) throw error;
      throw new OperationError('AMBIGUOUS_PAGE_REF', 'The slug exists in multiple authorized sources; provide source_id or page_id.', 'Use include_layers:true to read the authorized layers.');
    }
    return { slug, snapshot };
}

/**
 * #4352 remediation — filter fuzzy-resolution candidates so get_page's
 * ambiguous_slug candidate list can't enumerate private slugs to an
 * untrusted caller. Probe SQL lives ONCE in findPrivateOnlySlugs (a slug
 * with at least one non-private in-scope page stays visible; candidates
 * come from resolveSlugs, so every slug has a live page row).
 * Order-preserving (resolveSlugs returns ranked candidates). Read-only,
 * scope-threaded — not a getPage/putPage pair (no unscoped-check/scoped-write
 * hazard).
 */
export async function dropPrivateSlugs(
  engine: BrainEngine,
  candidates: string[],
  scope: { sourceId?: string; sourceIds?: string[] },
  includeDeleted: boolean,
): Promise<string[]> {
  const hidden = await findPrivateOnlySlugs(engine, candidates, scope, { includeDeleted });
  return candidates.filter(c => !hidden.has(c));
}

