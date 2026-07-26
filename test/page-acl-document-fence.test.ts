import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DocumentVersionConflictError } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import {
  OperationError,
  operations,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;

const basePage = (title: string, body: string): PageInput => ({
  type: 'note',
  title,
  compiled_truth: body,
  timeline: '',
  frontmatter: {},
});

const op = (name: string) => {
  const found = operations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} operation missing`);
  return found;
};

function remoteCtx(subjectIds: string[]): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: {
      token: 'server-verified',
      clientId: 'web-bff',
      scopes: ['read'],
      sourceId: 'default',
      allowedSources: ['default'],
      subjectIds,
    },
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await (engine as any).db.exec(`
    DELETE FROM links;
    DELETE FROM page_aliases;
    DELETE FROM content_chunks;
    DELETE FROM pages;
  `);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('page-level ACL is fail-closed on PGLite read surfaces', () => {
  test('legacy pages stay public while ACL pages require a matching server subject', async () => {
    await engine.putPage('docs/public', basePage('Public', 'public-marker'));
    await engine.putPage('docs/private', {
      ...basePage('Private', 'private-marker'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.upsertChunks('docs/public', [{
      chunk_index: 0,
      chunk_text: 'public-marker',
      chunk_source: 'compiled_truth',
    }]);
    await engine.upsertChunks('docs/private', [{
      chunk_index: 0,
      chunk_text: 'private-marker',
      chunk_source: 'compiled_truth',
    }]);

    expect(await engine.getPage('docs/private', { aclSubjectIds: ['user:alice'] })).not.toBeNull();
    expect(await engine.getPage('docs/private', { aclSubjectIds: ['user:bob'] })).toBeNull();
    expect(await engine.getPage('docs/private', { aclSubjectIds: [] })).toBeNull();
    expect(await engine.getPage('docs/private')).not.toBeNull();

    expect((await engine.listPages({ aclSubjectIds: ['user:bob'] })).map((p) => p.slug))
      .toEqual(['docs/public']);
    expect((await engine.searchKeyword('marker', { aclSubjectIds: ['user:bob'] })).map((r) => r.slug))
      .toEqual(['docs/public']);
    expect((await engine.searchKeyword('marker', { aclSubjectIds: ['user:alice'] })).map((r) => r.slug).sort())
      .toEqual(['docs/private', 'docs/public']);
  });

  test('graph, aliases and backlink ranking cannot disclose an inaccessible endpoint', async () => {
    await engine.putPage('docs/public', basePage('Public', 'public'));
    const privatePage = await engine.putPage('docs/private', {
      ...basePage('Private', 'private'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.addLink('docs/public', 'docs/private', 'context', 'references');
    await engine.addLink('docs/private', 'docs/public', 'context', 'references');
    await engine.setPageAliases('docs/private', 'default', ['secret alias']);

    const bobGraph = await engine.traverseGraph('docs/public', 2, { aclSubjectIds: ['user:bob'] });
    expect(bobGraph.map((n) => n.slug)).toEqual(['docs/public']);
    expect(bobGraph[0]?.links).toEqual([]);

    const aliceGraph = await engine.traverseGraph('docs/public', 2, { aclSubjectIds: ['user:alice'] });
    expect(aliceGraph.map((n) => n.slug).sort()).toEqual(['docs/private', 'docs/public']);

    expect(await engine.getPageById(privatePage.id, { aclSubjectIds: ['user:bob'] })).toBeNull();
    expect((await engine.resolveAliases(['secret alias'], { aclSubjectIds: ['user:bob'] })).size).toBe(0);
    expect((await engine.resolveAliases(['secret alias'], { aclSubjectIds: ['user:alice'] })).get('secret alias'))
      .toEqual([{ slug: 'docs/private', source_id: 'default' }]);

    expect((await engine.getBacklinkCounts(['docs/public'], { aclSubjectIds: ['user:bob'] })).get('docs/public'))
      .toBe(0);
    expect((await engine.getBacklinkCounts(['docs/public'], { aclSubjectIds: ['user:alice'] })).get('docs/public'))
      .toBe(1);
  });

  test('operation layer derives subjects from auth and protects current + historical bodies', async () => {
    await engine.putPage('docs/private', {
      ...basePage('Private', 'historical private body'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.createVersion('docs/private', { sourceId: 'default' });

    await expect(op('get_page').handler(remoteCtx(['user:bob']), {
      slug: 'docs/private',
    })).rejects.toBeInstanceOf(OperationError);

    const visible = await op('get_page').handler(remoteCtx(['user:alice']), {
      slug: 'docs/private',
    }) as any;
    expect(visible.compiled_truth).toBe('historical private body');

    expect(await op('get_versions').handler(remoteCtx(['user:bob']), {
      slug: 'docs/private',
    })).toEqual([]);
    const history = await op('get_versions').handler(remoteCtx(['user:alice']), {
      slug: 'docs/private',
    }) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].compiled_truth).toBe('historical private body');
  });
});

describe('document version fence', () => {
  test('rejects stale/conflicting versions without changing the current page', async () => {
    const v2 = {
      ...basePage('Report', 'version two'),
      acl_subject_ids: ['user:alice'],
      document_id: 'document-123',
      document_version_sequence: 2,
      document_version_hash: '2'.repeat(64),
    };
    const first = await engine.putPage('documents/report', v2);

    const replay = await engine.putPage('documents/report', v2);
    expect(replay.id).toBe(first.id);

    await expect(engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'stale version one',
      document_version_sequence: 1,
      document_version_hash: '1'.repeat(64),
    })).rejects.toBeInstanceOf(DocumentVersionConflictError);

    await expect(engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'conflicting version two',
      document_version_hash: 'f'.repeat(64),
    })).rejects.toBeInstanceOf(DocumentVersionConflictError);

    const afterConflict = await engine.getPage('documents/report', { aclSubjectIds: ['user:alice'] });
    expect(afterConflict?.compiled_truth).toBe('version two');
    expect(afterConflict?.document_version_sequence).toBe(2);

    const v3 = await engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'version three',
      document_version_sequence: 3,
      document_version_hash: '3'.repeat(64),
    });
    expect(v3.id).toBe(first.id);
    expect(v3.document_version_sequence).toBe(3);
    expect(v3.compiled_truth).toBe('version three');
  });
});
