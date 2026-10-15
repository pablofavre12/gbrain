import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from './contract.ts';
import { pageAccessOpts } from './context.ts';
export const VERSIONED_DOCUMENT_WRITE_CAPABILITY = 'versioned_document_write';
export function hasPageAclAccess(ctx: OperationContext, allowedSubjects: unknown): boolean {
  if (ctx.remote === false || allowedSubjects == null) return true;
  if (!Array.isArray(allowedSubjects) || allowedSubjects.length === 0) return false;
  const callerSubjects = pageAccessOpts(ctx).aclSubjectIds ?? [];
  return callerSubjects.some((subject) => allowedSubjects.includes(subject));
}
export function requireVersionedDocumentWriteCapability(ctx: OperationContext): void {
  if (
    ctx.remote !== false
    && !ctx.auth?.capabilities?.includes(VERSIONED_DOCUMENT_WRITE_CAPABILITY)
  ) {
    throw new OperationError(
      'permission_denied', 'Versioned document writes require a server-verified document capability.', "Use a caller with the required page, source and document grants.");
  }
}
export type CurrentPageWriteTarget = {
  id: number;
  acl_subject_ids: string[] | null;
  deleted_at: Date | string | null;
};
export async function loadAuthorizedPageWriteTarget(
  ctx: OperationContext,
  slug: string,
  sourceId: string,
): Promise<CurrentPageWriteTarget | null | undefined> {
  if (
    typeof (ctx.engine as Partial<BrainEngine>).getPage !== 'function'
    || typeof (ctx.engine as Partial<BrainEngine>).executeRaw !== 'function'
  ) return undefined;
  const page = await ctx.engine.getPage(slug, {
    sourceId,
    includeDeleted: true,
  }) as CurrentPageWriteTarget | null;
  if (page && !hasPageAclAccess(ctx, page.acl_subject_ids)) {
    throw new OperationError('permission_denied', 'You are not authorized to modify this page.', "Use a caller with the required page, source and document grants.");
  }
  return page;
}
