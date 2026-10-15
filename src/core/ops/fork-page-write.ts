import { OperationError, type OperationContext, type ParamDef } from './contract.ts';
import { pageAccessOpts } from './context.ts';
import { requireVersionedDocumentWriteCapability } from './fork-page-policy.ts';

export const FORK_PAGE_WRITE_PARAMS: Record<string, ParamDef> = {
  source: { type: 'string', description: 'Source alias; must be within the write grant.', fullSurfaceOnly: true },
  allowed_subject_ids: { type: 'array', items: {type:'string'}, description: 'Page ACL subjects.', fullSurfaceOnly: true },
  document_id: {type:'string', description:'Versioned document identity.', fullSurfaceOnly: true},
  document_version_sequence: {type:'number', description:'Monotonic document version.', fullSurfaceOnly: true},
  document_version_hash: {type:'string', description:'Document version SHA-256.', fullSurfaceOnly: true},
};

export async function validateForkPageWrite(ctx: OperationContext, p: Record<string, unknown>, sourceId: string): Promise<void> {
  if (p.source !== undefined && p.source_id !== undefined && p.source !== p.source_id) throw new OperationError('invalid_params', 'source and source_id disagree.', "Pass one source identifier, or the same value in source and source_id.");
  if (typeof p.document_id === 'string') p.document_id = p.document_id.trim();
  if (typeof p.document_version_hash === 'string') p.document_version_hash = p.document_version_hash.toLowerCase();
  const fence = [p.document_id, p.document_version_sequence, p.document_version_hash];
  if (fence.some(v=>v!==undefined)) {
    requireVersionedDocumentWriteCapability(ctx);
    if (typeof p.document_id !== 'string' || p.document_id.length < 1 || p.document_id.length > 200 || /[\u0000-\u001f\u007f]/.test(p.document_id)
      || !Number.isSafeInteger(p.document_version_sequence) || (p.document_version_sequence as number) < 1
      || typeof p.document_version_hash !== 'string' || !/^[a-f0-9]{64}$/.test(p.document_version_hash)) throw new OperationError('invalid_params', 'A complete document id, sequence and hash is required.', "Supply document_id, a positive document_version_sequence and the SHA-256 document_version_hash together.");
  }
  if (p.allowed_subject_ids !== undefined) {
    const acl = p.allowed_subject_ids;
    if (!Array.isArray(acl) || !acl.length || acl.length > 256 || acl.some(x=>typeof x!=='string'||!x.trim()||x.trim().length>200||/[\u0000-\u001f\u007f]/.test(x))) throw new OperationError('invalid_params', 'Page ACL must be a non-empty list of subjects.', "Supply a non-empty allowed_subject_ids list that retains a server-verified caller subject.");
    p.allowed_subject_ids = [...new Set((acl as string[]).map(x => x.trim()))].sort();
    if (ctx.remote !== false && !pageAccessOpts(ctx).aclSubjectIds?.some(x=>(p.allowed_subject_ids as string[]).includes(x))) throw new OperationError('permission_denied', 'A page ACL must retain an authenticated caller subject.', "Use a caller with the required page, source and document grants.");
  }
  if (p.document_id !== undefined && p.allowed_subject_ids === undefined) throw new OperationError('invalid_params', 'Versioned documents require a non-empty allowed_subject_ids ACL', "Supply document_id, a positive document_version_sequence and the SHA-256 document_version_hash together.");
  if (ctx.remote !== false && !ctx.dryRun) {
    const page = await ctx.engine.getPage(p.slug as string, {sourceId,includeDeleted:true});
    if (page?.acl_subject_ids && !pageAccessOpts(ctx).aclSubjectIds?.some(x=>page.acl_subject_ids!.includes(x))) throw new OperationError('permission_denied', 'You are not authorized to modify this page.', "Use a caller with the required page, source and document grants.");
  }
}
