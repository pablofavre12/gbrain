// Value: protects=canonical publication preserves source schema selection;
// fails_when=a configured pack error silently falls back to the base vocabulary;
// why_new=loader and CLI import tests do not exercise queued put_page publication;
// seam=none; no_claim=production pack installation or provider acceptance.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;
let ctx: OperationContext;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('pack-scope','Synthetic pack scope')");
  ctx = { engine, sourceId: 'pack-scope', remote: false, dryRun: false, config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
});
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

test('a missing configured source pack refuses publication; repairing it permits a fresh request', async () => {
  const write = operations.find(op => op.name === 'put_page')!;
  const slug = 'notes/source-pack';
  const content = '---\ntitle: Synthetic source schema\n---\nThe configured vocabulary must resolve before this page is published.';
  await engine.setConfig('schema_pack.source.pack-scope', 'missing-fork-fixture-pack');
  let refusal: unknown;
  try { await write.handler(ctx, { slug, content, request_id: 'missing-source-pack' }); }
  catch (error) { refusal = error; }
  expect(refusal).toBeDefined();
  // The public receipt deliberately redacts unexpected owner errors.
  expect(refusal).toMatchObject({ code: 'storage_error' });
  expect(await engine.getPage(slug, { sourceId: 'pack-scope' })).toBeNull();
  const chunks = await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM content_chunks');
  expect(chunks[0]?.n).toBe('0');
  await engine.setConfig('schema_pack.source.pack-scope', 'gbrain-base');
  await write.handler(ctx, { slug, content, request_id: 'repaired-source-pack' });
  expect((await engine.getPage(slug, { sourceId: 'pack-scope' }))?.compiled_truth).toContain('configured vocabulary');
});
