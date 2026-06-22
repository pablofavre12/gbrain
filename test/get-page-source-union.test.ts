/**
 * v119 — get_page multi-source "union of layers" + explicit `source` read.
 *
 * The same slug can exist as several layers across salas/sources (e.g.
 * `personas/x` in BOTH `campo` and `directorio`). Pre-v119 get_page returned
 * ONE ambiguous row. v119:
 *   - get_page(slug, source='campo')  → ONLY that layer, scope-checked.
 *   - get_page(slug) with 1 readable layer  → the single page (legacy shape).
 *   - get_page(slug) with >1 readable layer → {slug, multi_source:true, layers}
 *     ordered most-public → most-restricted.
 *   - source outside the caller's read grant → forbidden_source.
 *
 * Engine-free: a stub engine returns fixture layers so the test exercises the
 * OP-LAYER union/scope logic (the part this PR adds), not SQL. The Postgres /
 * PGLite SQL ordering is covered separately by the engines' own suites.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
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

/**
 * Stub engine: serves a per-(slug→layers) map. getPage returns the first row
 * within scope (mirrors the real LIMIT 1 + array-precedence contract);
 * getPageLayers returns ALL rows within scope, ordered by the sourceIds array
 * the op hands down (the real engines order in SQL — here we replicate that
 * deterministic order so the op-layer assertions are meaningful).
 */
function makeEngine(layersBySlug: Record<string, Page[]>): BrainEngine {
  const getTags = async (_slug: string, opts?: { sourceId?: string }) => {
    const src = opts?.sourceId ?? 'default';
    return [`tag-${src}`];
  };
  const getPage: BrainEngine['getPage'] = async (slug, opts) => {
    const all = layersBySlug[slug] ?? [];
    const ids = opts?.sourceIds;
    const id = opts?.sourceId;
    const inScope = all.filter((pg) =>
      ids && ids.length > 0 ? ids.includes(pg.source_id) : id ? pg.source_id === id : true,
    );
    return inScope[0] ?? null;
  };
  const getPageLayers: BrainEngine['getPageLayers'] = async (slug, opts) => {
    const all = layersBySlug[slug] ?? [];
    const ids = opts?.sourceIds;
    const inScope =
      ids && ids.length > 0 ? all.filter((pg) => ids.includes(pg.source_id)) : all;
    if (ids && ids.length > 0) {
      // Deterministic order by position in the scope array (what the SQL does).
      return [...inScope].sort(
        (a, b) => ids.indexOf(a.source_id) - ids.indexOf(b.source_id),
      );
    }
    return [...inScope].sort((a, b) => a.source_id.localeCompare(b.source_id));
  };
  return {
    getPage,
    getPageLayers,
    getTags,
    async resolveSlugs() {
      return [];
    },
    async getConfig() {
      return null;
    },
    async executeRaw() {
      return [] as never;
    },
  } as unknown as BrainEngine;
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

beforeEach(() => {
  _resetPendingLastRetrievedWritesForTests();
});

describe('get_page explicit source → single layer', () => {
  test('(a) source within scope returns ONLY that layer', async () => {
    const engine = makeEngine({
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
    const engine = makeEngine({
      'personas/x': [page({ source_id: 'campo' })],
    });
    const p = get_page.handler(directorioCtx(engine), {
      slug: 'personas/x',
      source: 'finanzas', // not in allowedSources
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/forbidden_source|outside your readable scope/);
  });
});

describe('get_page union (no source)', () => {
  test('(b) >1 readable layer → multi_source envelope, public→restricted order', async () => {
    const engine = makeEngine({
      'personas/x': [page({ source_id: 'directorio' }), page({ source_id: 'campo' })],
    });
    const result: any = await get_page.handler(directorioCtx(engine), { slug: 'personas/x' });
    expect(result.multi_source).toBe(true);
    expect(result.slug).toBe('personas/x');
    expect(result.layers).toHaveLength(2);
    // allowedSources = [campo, lideres, directorio] → campo (public) first.
    expect(result.layers.map((l: any) => l.source_id)).toEqual(['campo', 'directorio']);
    // Each layer carries its own per-source tags + the layer shape.
    expect(result.layers[0]).toMatchObject({
      source_id: 'campo',
      title: 'title-campo',
      type: 'note',
      tags: ['tag-campo'],
    });
    expect(result.layers[1].tags).toEqual(['tag-directorio']);
  });

  test('(c) exactly 1 readable layer → flat single-page shape (backward compat)', async () => {
    const engine = makeEngine({
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
    const engine = makeEngine({
      'personas/x': [
        page({ source_id: 'campo' }),
        page({ source_id: 'directorio' }),
        page({ source_id: 'finanzas' }), // outside grant
      ],
    });
    const result: any = await get_page.handler(directorioCtx(engine), { slug: 'personas/x' });
    expect(result.multi_source).toBe(true);
    expect(result.layers.map((l: any) => l.source_id)).toEqual(['campo', 'directorio']);
  });

  test('not found → page_not_found', async () => {
    const engine = makeEngine({});
    const p = get_page.handler(directorioCtx(engine), { slug: 'personas/nope' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/Page not found/);
  });
});
