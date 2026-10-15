import { OperationError } from '../ops/contract.ts';
import type { PageSnapshot, PageMutationPrecondition } from './types.ts';

export class PageContentConflictError extends OperationError {
  constructor() {
    super('content_conflict', 'The source, page identity or content hash changed.', 'Read the exact source and page again before retrying with a new request id.');
    this.name = 'PageContentConflictError';
  }
}

/** Called while the canonical page row is locked, before any page effects. */
export function assertPageContent(snapshot: PageSnapshot | null, sourceId: string, opts?: PageMutationPrecondition): void {
  if (opts?.expectedPageId === undefined && opts?.expectedContentHash === undefined) return;
  if (!Number.isSafeInteger(opts.expectedPageId) || (opts.expectedPageId ?? 0) < 1 || !/^[a-f0-9]{64}$/.test(opts.expectedContentHash ?? '')) {
    throw new Error('expectedPageId and expectedContentHash must both be valid');
  }
  if (!snapshot || snapshot.page.source_id !== sourceId || snapshot.page.id !== opts.expectedPageId
    || snapshot.page.content_hash !== opts.expectedContentHash) throw new PageContentConflictError();
}
