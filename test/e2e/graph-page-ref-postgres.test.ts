/** Real-Postgres parity for source-aware graph references. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('graph page references — Postgres parity', () => {
  let engine: Awaited<ReturnType<typeof setupDB>>;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('notes/root', { type: 'note', title: 'Root', compiled_truth: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.putPage('people/alice', { type: 'person', title: 'Alice default', compiled_truth: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.putPage('people/alice', { type: 'person', title: 'Alice B', compiled_truth: '', frontmatter: {} }, { sourceId: 'src-b' });
    await engine.addLinksBatch([
      { from_slug: 'notes/root', to_slug: 'people/alice', from_source_id: 'default', to_source_id: 'default', link_type: 'mentions' },
      { from_slug: 'notes/root', to_slug: 'people/alice', from_source_id: 'default', to_source_id: 'src-b', link_type: 'mentions' },
    ]);
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('nodes and edges retain source_id + page_id instead of merging same slugs', async () => {
    const root = await engine.getPage('notes/root', { sourceId: 'default' });
    const graph = await engine.traverseGraph('notes/root', 1, {
      pageId: root!.id,
      sourceIds: ['default', 'src-b'],
    });
    const aliceNodes = graph.filter((node) => node.slug === 'people/alice');
    expect(aliceNodes.map((node) => node.source_id).sort()).toEqual(['default', 'src-b']);
    expect(aliceNodes.every((node) => Number.isInteger(node.page_id))).toBe(true);

    const paths = await engine.traversePaths('notes/root', {
      pageId: root!.id,
      depth: 1,
      sourceIds: ['default', 'src-b'],
    });
    expect(paths).toHaveLength(2);
    expect(paths.map((path) => path.to.source_id).sort()).toEqual(['default', 'src-b']);
    expect(paths.every((path) => path.from.page_id === root!.id)).toBe(true);
  });
});
