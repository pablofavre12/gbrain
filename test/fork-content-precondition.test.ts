import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMutationPrecondition } from '../src/core/persistence/preconditions.ts';

let engine: PGLiteEngine;
const page = (body: string) => ({ type: 'note', title: 'Fixture', compiled_truth: body, frontmatter: {} });
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

describe('source and page content precondition', () => {
  test('rejects a stale recovery without changing text, chunks or versions', async () => {
    const original = await engine.putPage('fixture/recovery', page('original'));
    await engine.upsertChunks(original.slug, [{chunk_index: 0, chunk_text: 'original', chunk_source: 'compiled_truth'}]);
    await engine.createVersion(original.slug);
    await engine.putPage(original.slug, page('concurrent edit'));
    const snapshot = async () => JSON.stringify(await engine.executeRaw(`SELECT
      (SELECT jsonb_agg(to_jsonb(p)) FROM pages p WHERE slug='fixture/recovery') AS pages,
      (SELECT jsonb_agg(to_jsonb(c)) FROM content_chunks c) AS chunks,
      (SELECT jsonb_agg(to_jsonb(v)) FROM page_versions v) AS versions`));
    const before = await snapshot();
    await expect(engine.putPage(original.slug, page('recovered'), {
      sourceId: 'default', expectedPageId: original.id, expectedContentHash: original.content_hash,
    })).rejects.toMatchObject({code: 'content_conflict'});
    expect(await snapshot()).toBe(before);
    const current = (await engine.getPage(original.slug))!;
    await engine.putPage(original.slug, page('recovered'), {
      sourceId: 'default', expectedPageId: current.id, expectedContentHash: current.content_hash,
    });
    expect((await engine.getPage(original.slug))?.compiled_truth).toBe('recovered');
  });
  test('a different row cannot satisfy the same hash', async () => {
    const a = await engine.putPage('fixture/a', page('equal'));
    const b = await engine.putPage('fixture/b', page('equal'));
    await expect(engine.putPage(b.slug, page('replacement'), {sourceId:'default', expectedPageId:a.id, expectedContentHash:b.content_hash})).rejects.toMatchObject({code:'content_conflict'});
  });
  test('partial, malformed or force-bypassed conditions fail closed', () => {
    for (const args of [{expected_page_id:1}, {expected_content_hash:'a'.repeat(64)}, {expected_page_id:0,expected_content_hash:'a'.repeat(64)}, {expected_page_id:1,expected_content_hash:'a'.repeat(64),force:true}]) {
      expect(() => parseMutationPrecondition(args)).toThrow();
    }
  });
});
