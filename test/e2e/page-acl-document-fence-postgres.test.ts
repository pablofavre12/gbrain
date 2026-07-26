/** Real-Postgres parity for page ACL and monotonic Platform document writes. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DocumentVersionConflictError } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('page ACL + document fence — Postgres parity', () => {
  let engine: Awaited<ReturnType<typeof setupDB>>;

  beforeAll(async () => {
    engine = await setupDB();
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('ACL filters direct/search/graph reads and stale version cannot overwrite', async () => {
    const page = {
      type: 'note' as const,
      title: 'Private report',
      compiled_truth: 'private postgres marker',
      timeline: '',
      frontmatter: {},
      acl_subject_ids: ['user:alice'],
      document_id: 'postgres-document',
      document_version_sequence: 2,
      document_version_hash: '2'.repeat(64),
    };
    const saved = await engine.putPage('documents/postgres-report', page);
    await engine.upsertChunks('documents/postgres-report', [{
      chunk_index: 0,
      chunk_text: 'private postgres marker',
      chunk_source: 'compiled_truth',
    }]);
    await engine.putPage('documents/public-root', {
      type: 'note', title: 'Root', compiled_truth: 'root', timeline: '', frontmatter: {},
    });
    await engine.addLink('documents/public-root', 'documents/postgres-report', '', 'references');

    expect(await engine.getPageById(saved.id, { aclSubjectIds: ['user:bob'] })).toBeNull();
    expect(await engine.getPageById(saved.id, { aclSubjectIds: ['user:alice'] })).not.toBeNull();
    expect(await engine.searchKeyword('postgres marker', { aclSubjectIds: ['user:bob'] })).toEqual([]);
    expect(await engine.searchKeyword('postgres marker', { aclSubjectIds: ['user:alice'] }))
      .toHaveLength(1);
    expect((await engine.traverseGraph('documents/public-root', 1, { aclSubjectIds: ['user:bob'] }))
      .map((node) => node.slug)).toEqual(['documents/public-root']);

    await expect(engine.putPage('documents/postgres-report', {
      ...page,
      compiled_truth: 'stale',
      document_version_sequence: 1,
      document_version_hash: '1'.repeat(64),
    })).rejects.toBeInstanceOf(DocumentVersionConflictError);
    expect((await engine.getPageById(saved.id, { aclSubjectIds: ['user:alice'] }))?.compiled_truth)
      .toBe('private postgres marker');
  });
});
