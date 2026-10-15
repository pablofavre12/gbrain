import type { Page, PageInput } from '../types.ts';
export type ForkPageMetadata = Pick<PageInput, 'acl_subject_ids' | 'document_id' | 'document_version_sequence' | 'document_version_hash' | 'last_write_client_id' | 'last_write_client_name'>;
export function forkMetadataChanges(page: Page | null, metadata?: ForkPageMetadata): boolean {
  return !!metadata && Object.entries(metadata).some(([key, value]) => value != null && JSON.stringify(page?.[key as keyof Page]) !== JSON.stringify(value));
}

export function hasDocumentVersionFence(metadata: ForkPageMetadata): boolean {
  return !!metadata.document_id && Number.isSafeInteger(metadata.document_version_sequence)
    && metadata.document_version_sequence! > 0 && typeof metadata.document_version_hash === 'string'
    && /^[a-f0-9]{64}$/.test(metadata.document_version_hash);
}
