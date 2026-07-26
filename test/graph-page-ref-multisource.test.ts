/**
 * Public graph identity regression: `(source_id, page_id)` is the identity;
 * slug is only a human-readable alias. Runs against in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const backlinks = operations.find((op) => op.name === 'get_backlinks')!;
const traverse = operations.find((op) => op.name === 'traverse_graph')!;

function ctx(allowedSources: string[]): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} } as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: { token: 'test', clientId: 'test', scopes: ['read'], allowedSources } as any,
  };
}

async function put(sourceId: string, slug: string, title = slug) {
  await engine.putPage(slug, {
    type: 'note', title, compiled_truth: '', timeline: '', frontmatter: {},
  }, { sourceId });
  return (await engine.getPage(slug, { sourceId }))!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const sourceId of ['src-b', 'secret']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [sourceId],
    );
  }
});

describe('source-aware graph references', () => {
  test('ambiguous slug fails closed and exposes only authorized candidates', async () => {
    const root = await put('default', 'notes/root');
    const targetDefault = await put('default', 'people/alice', 'Alice default');
    const targetB = await put('src-b', 'people/alice', 'Alice B');
    const secret = await put('secret', 'notes/secret');
    await engine.addLinksBatch([
      { from_slug: root.slug, to_slug: targetDefault.slug, from_source_id: root.source_id, to_source_id: targetDefault.source_id, link_type: 'mentions' },
      { from_slug: root.slug, to_slug: targetB.slug, from_source_id: root.source_id, to_source_id: targetB.source_id, link_type: 'mentions' },
      { from_slug: secret.slug, to_slug: targetDefault.slug, from_source_id: secret.source_id, to_source_id: targetDefault.source_id, link_type: 'mentions' },
    ]);

    let thrown: unknown;
    try {
      await backlinks.handler(ctx(['default', 'src-b']), { slug: 'people/alice' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    const err = thrown as OperationError;
    expect(err.code).toBe('AMBIGUOUS_PAGE_REF');
    const candidates = JSON.parse(err.suggestion!);
    expect(candidates).toEqual([
      { source_id: 'default', page_id: targetDefault.id, slug: 'people/alice' },
      { source_id: 'src-b', page_id: targetB.id, slug: 'people/alice' },
    ]);
    expect(err.suggestion).not.toContain('secret');
  });

  test('page_id selects one authorized target and returns full endpoint refs', async () => {
    const fromB = await put('src-b', 'notes/from-b');
    const targetB = await put('src-b', 'people/alice', 'Alice B');
    await engine.addLinksBatch([{
      from_slug: fromB.slug, to_slug: targetB.slug,
      from_source_id: fromB.source_id, to_source_id: targetB.source_id,
      link_type: 'mentions',
    }]);

    const links = await backlinks.handler(ctx(['default', 'src-b']), {
      page_id: targetB.id,
      source_id: 'src-b',
    }) as any[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      from: { source_id: 'src-b', page_id: fromB.id, slug: fromB.slug },
      to: { source_id: 'src-b', page_id: targetB.id, slug: targetB.slug },
      from_source_id: 'src-b', to_source_id: 'src-b',
    });
  });

  test('traverse_graph preserves two nodes with the same slug from distinct sources', async () => {
    const root = await put('default', 'notes/root');
    const sharedDefault = await put('default', 'people/alice', 'Alice default');
    const sharedB = await put('src-b', 'people/alice', 'Alice B');
    await engine.addLinksBatch([
      { from_slug: root.slug, to_slug: sharedDefault.slug, from_source_id: root.source_id, to_source_id: sharedDefault.source_id, link_type: 'mentions' },
      { from_slug: root.slug, to_slug: sharedB.slug, from_source_id: root.source_id, to_source_id: sharedB.source_id, link_type: 'mentions' },
    ]);

    const nodes = await traverse.handler(ctx(['default', 'src-b']), {
      page_id: root.id,
      source_id: 'default',
      depth: 1,
    }) as any[];
    const sameSlug = nodes.filter((node) => node.slug === 'people/alice');
    expect(sameSlug).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: 'default', page_id: sharedDefault.id }),
      expect.objectContaining({ source_id: 'src-b', page_id: sharedB.id }),
    ]));
    const rootNode = nodes.find((node) => node.page_id === root.id);
    expect(rootNode.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: { source_id: 'default', page_id: sharedDefault.id, slug: sharedDefault.slug } }),
      expect.objectContaining({ to: { source_id: 'src-b', page_id: sharedB.id, slug: sharedB.slug } }),
    ]));
  });
});
