import { OperationError, type OperationContext } from './contract.ts';
import { federatedSearchScope, readPolicyOpts, parseSourceIdParam, assertExplicitSourceLive } from './context.ts';
import { getPageReferences, type PageReference } from '../page-state/fork-page-refs.ts';

export async function resolveGraphPageRef(ctx: OperationContext, p: Record<string, unknown>): Promise<PageReference> {
  const slug = typeof p.slug === 'string' && p.slug.length ? p.slug : undefined;
  if (p.page_id !== undefined && (!Number.isSafeInteger(p.page_id) || (p.page_id as number) < 1))
    throw new OperationError('invalid_params', 'page_id must be a positive safe integer', "Pass a positive page_id and a matching slug when both are supplied.");
  if (!slug && p.page_id === undefined) throw new OperationError('invalid_params', 'Provide slug or page_id', "Pass a positive page_id and a matching slug when both are supplied.");
  const requested = parseSourceIdParam(p.source_id, 'page reference', { allowAll: true });
  if (p.all_sources === true && requested !== undefined && requested !== '__all__')
    throw new OperationError('invalid_params', 'Pass either source_id or all_sources, not both.', 'Remove one of the source selectors.');
  const source = p.all_sources === true ? '__all__' : requested;
  const scope = await readPolicyOpts(ctx, federatedSearchScope(ctx, source));
  await assertExplicitSourceLive(ctx, source);
  if (p.page_id !== undefined) {
    const [page] = await getPageReferences(ctx.engine, undefined, { ...scope, pageId: p.page_id as number });
    if (!page) throw new OperationError('page_not_found', 'Page not found', "Check the page reference and read grant for the requested source.");
    if (slug && page.slug !== slug) throw new OperationError('invalid_params', 'page_id and slug disagree', "Pass a positive page_id and a matching slug when both are supplied.");
    return page;
  }
  const candidates = await getPageReferences(ctx.engine, slug!, scope);
  if (!candidates.length) throw new OperationError('page_not_found', 'Page not found', "Check the page reference and read grant for the requested source.");
  if (candidates.length > 1) throw new OperationError('AMBIGUOUS_PAGE_REF',
    'The slug exists in multiple authorized sources; provide source_id or page_id',
    JSON.stringify(candidates.map(p=>({source_id:p.source_id,page_id:p.id,slug:p.slug}))));
  return candidates[0];
}
