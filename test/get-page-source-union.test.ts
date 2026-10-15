/** Source/page identity and multi-room reads against the real PGLite snapshot path. */
import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { Page } from '../src/core/types.ts';
import { _resetPendingLastRetrievedWritesForTests } from '../src/core/last-retrieved.ts';

const get_page: Operation = (() => {
  const op = operations.find((o) => o.name === 'get_page');
  if (!op) throw new Error('get_page op missing');
  return op;
})();

// Minimal page fixture builder. Only the fields the handler reads matter.
function page(overrides: Partial<Page> & { source_id: string }): Page {
  return {
    id: Math.floor(Math.random() * 1e6),
    slug: 'personas/x',
    type: 'note' as Page['type'],
    title: `title-${overrides.source_id}`,
    compiled_truth: `body of ${overrides.source_id}`,
    timeline: '',
    frontmatter: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

let realEngine: PGLiteEngine;
beforeAll(async () => { realEngine = new PGLiteEngine(); await realEngine.connect({}); await realEngine.initSchema(); });
afterAll(async () => { await realEngine.disconnect(); });
async function makeEngine(layersBySlug: Record<string, Page[]>): Promise<BrainEngine> {
  for (const pg of Object.values(layersBySlug).flat()) {
    await realEngine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING',[pg.source_id]);
    await realEngine.putPage(pg.slug, pg, {sourceId:pg.source_id});
    const stored = (await realEngine.getPage(pg.slug,{sourceId:pg.source_id}))!;
    pg.id = stored.id;
    await realEngine.addTag(pg.slug, `tag-${pg.source_id}`, {sourceId:pg.source_id});
  }
  return realEngine;
}

function ctxFor(engine: BrainEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'directorio',
    ...overrides,
  };
}

// A "directorio" curator: readable scope = campo < lideres < directorio.
function directorioCtx(engine: BrainEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return ctxFor(engine, {
    sourceId: 'directorio',
    auth: {
      token: 'stub',
      clientId: 'gbrain_cl_director',
      scopes: ['read', 'write'],
      sourceId: 'directorio',
      allowedSources: ['campo', 'lideres', 'directorio'],
    },
    ...overrides,
  });
}

beforeEach(async () => {
  await resetPgliteState(realEngine);
  _resetPendingLastRetrievedWritesForTests();
});

describe('get_page explicit source → single layer', () => {
  test('(a) source within scope returns ONLY that layer', async () => {
    const engine = await makeEngine({
      'personas/x': [page({ source_id: 'campo' }), page({ source_id: 'directorio' })],
    });
    const result: any = await get_page.handler(directorioCtx(engine), {
      slug: 'personas/x',
      source: 'campo',
    });
    expect(result.source_id).toBe('campo');
    expect(result.multi_source).toBeUndefined();
    expect(result.title).toBe('title-campo');
    // Tags fetched with the layer's own source_id, not the default.
    expect(result.tags).toEqual(['tag-campo']);
  });

  test('(d) source OUTSIDE the read grant → forbidden_source', async () => {
    const engine = await makeEngine({
      'personas/x': [page({ source_id: 'campo' })],
    });
    const p = get_page.handler(directorioCtx(engine), {
      slug: 'personas/x',
      source: 'finanzas', // not in allowedSources
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/forbidden_source|outside your readable scope|not granted|outside.*grant/i);
  });
});

describe('get_page union (no source)', () => {
  test('(b) >1 readable layer requires explicit include_layers=true', async () => {
    const engine = await makeEngine({
      'personas/x': [page({ source_id: 'directorio' }), page({ source_id: 'campo' })],
    });
    await expect(get_page.handler(directorioCtx(engine), { slug: 'personas/x' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_PAGE_REF',
    });
    const result: any = await get_page.handler(directorioCtx(engine), {
      slug: 'personas/x', include_layers: true,
    });
    expect(result.multi_source).toBe(true);
    expect(result.slug).toBe('personas/x');
    expect(result.layers).toHaveLength(2);
    // allowedSources = [campo, lideres, directorio] → campo (public) first.
    expect(result.layers.map((l: any) => l.source_id)).toEqual(['campo', 'directorio']);
    // Each layer carries its own per-source tags + the layer shape.
    expect(result.layers[0]).toMatchObject({
      source_id: 'campo',
      page_id: expect.any(Number),
      slug: 'personas/x',
      title: 'title-campo',
      type: 'note',
      tags: ['tag-campo'],
    });
    expect(result.layers[1].tags).toEqual(['tag-directorio']);
  });

  test('(c) exactly 1 readable layer → flat single-page shape (backward compat)', async () => {
    const engine = await makeEngine({
      'personas/only-campo': [page({ slug: 'personas/only-campo', source_id: 'campo' })],
    });
    const result: any = await get_page.handler(directorioCtx(engine), {
      slug: 'personas/only-campo',
    });
    expect(result.multi_source).toBeUndefined();
    expect(result.layers).toBeUndefined();
    expect(result.source_id).toBe('campo');
    expect(result.slug).toBe('personas/only-campo');
    expect(result.compiled_truth).toBe('body of campo');
    expect(result.tags).toBeDefined();
  });

  test('scope filters the union: a layer outside the grant is NOT surfaced', async () => {
    const engine = await makeEngine({
      'personas/x': [
        page({ source_id: 'campo' }),
        page({ source_id: 'directorio' }),
        page({ source_id: 'finanzas' }), // outside grant
      ],
    });
    const result: any = await get_page.handler(directorioCtx(engine), {
      slug: 'personas/x', include_layers: true,
    });
    expect(result.multi_source).toBe(true);
    expect(result.layers.map((l: any) => l.source_id)).toEqual(['campo', 'directorio']);
  });

  test('page_id + source_id reads one exact authorized layer and validates slug', async () => {
    const campo = page({ id: 101, source_id: 'campo' });
    const directorio = page({ id: 202, source_id: 'directorio' });
    const engine = await makeEngine({ 'personas/x': [campo, directorio] });
    const result: any = await get_page.handler(directorioCtx(engine), {
      page_id: directorio.id, source_id: 'directorio', slug: 'personas/x',
    });
    expect(result).toMatchObject({ source_id: 'directorio', page_id: directorio.id, slug: 'personas/x' });
    await expect(get_page.handler(directorioCtx(engine), {
      page_id: directorio.id, source_id: 'directorio', slug: 'other/slug',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('not found → page_not_found', async () => {
    const engine = await makeEngine({});
    const p = get_page.handler(directorioCtx(engine), { slug: 'personas/nope' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/Page not found/);
  });
});
