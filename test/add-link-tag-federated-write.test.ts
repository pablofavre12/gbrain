/**
 * add_link / add_tag / remove_link / remove_tag honor `source` against
 * federated_write — the same {ctx.sourceId} ∪ ctx.auth.federatedWrite
 * authorization put_page uses.
 *
 * Bug context: v0.31.8 (D7) threaded only the scalar default `ctx.sourceId`
 * into these ops. A directorio-default client whose pages lived in `campo`
 * could put_page(source='campo') successfully (v118 added it to put_page) but
 * the follow-up add_link/add_tag would fail with
 *   `addLink failed: page "X" (source=directorio) or "Y" (source=directorio) not found`
 * because the lookup defaulted to the client's own source. The fix mirrors
 * put_page's `source` param + resolveWriteSource gate.
 *
 * Mirrors put-page-federated-write.test.ts: dry-run with a stub engine so no
 * DB / network is needed. The dry-run return echoes the resolved `source`, so
 * we assert the authorized write target directly.
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function findOp(name: string): Operation {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`${name} op missing`);
  return op;
}
const add_link = findOp('add_link');
const remove_link = findOp('remove_link');
const add_tag = findOp('add_tag');
const remove_tag = findOp('remove_tag');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'directorio',
    ...overrides,
  };
}

// A "directorio" curator token: writes to its own source plus campo + lideres.
function directorioCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return makeCtx({
    sourceId: 'directorio',
    auth: {
      token: 'stub',
      clientId: 'gbrain_cl_director',
      scopes: ['read', 'write'],
      sourceId: 'directorio',
      allowedSources: ['campo', 'lideres', 'directorio'],
      federatedWrite: ['campo', 'lideres'],
    },
    ...overrides,
  });
}

describe('add_link honors federated_write', () => {
  test('(a) no source → resolves to ctx.sourceId', async () => {
    const result = await add_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y',
    });
    expect(result).toMatchObject({
      dry_run: true, action: 'add_link', from: 'proyectos/x', to: 'personas/y',
      source: 'directorio',
    });
  });

  test('(b) source in federated_write set → resolves to that source', async () => {
    const result = await add_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y', source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(b) source === ctx.sourceId is always admitted', async () => {
    const result = await add_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y', source: 'directorio',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'directorio' });
  });

  test('(c) source NOT in set → rejected with federated_write error (surfaces in dry_run preview)', async () => {
    const p = add_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y', source: 'finanzas',
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
    await expect(p).rejects.toThrow(/finanzas/);
  });

  test('(c) no federatedWrite grant → only ctx.sourceId admitted', async () => {
    const ctx = makeCtx({ sourceId: 'campo' }); // no auth.federatedWrite at all
    const p = add_link.handler(ctx, {
      from: 'proyectos/x', to: 'personas/y', source: 'directorio',
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
  });
});

describe('remove_link honors federated_write', () => {
  test('(a) no source → ctx.sourceId', async () => {
    const result = await remove_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y',
    });
    expect(result).toMatchObject({ dry_run: true, action: 'remove_link', source: 'directorio' });
  });

  test('(b) source in set → admitted', async () => {
    const result = await remove_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y', source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(c) source not in set → rejected', async () => {
    const p = remove_link.handler(directorioCtx(), {
      from: 'proyectos/x', to: 'personas/y', source: 'finanzas',
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
  });
});

describe('add_tag honors federated_write', () => {
  test('(a) no source → ctx.sourceId', async () => {
    const result = await add_tag.handler(directorioCtx(), { slug: 'proyectos/x', tag: 'review' });
    expect(result).toMatchObject({
      dry_run: true, action: 'add_tag', slug: 'proyectos/x', tag: 'review', source: 'directorio',
    });
  });

  test('(b) source in set → admitted', async () => {
    const result = await add_tag.handler(directorioCtx(), {
      slug: 'proyectos/x', tag: 'review', source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(c) source not in set → rejected', async () => {
    const p = add_tag.handler(directorioCtx(), {
      slug: 'proyectos/x', tag: 'review', source: 'finanzas',
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
  });
});

describe('remove_tag honors federated_write', () => {
  test('(a) no source → ctx.sourceId', async () => {
    const result = await remove_tag.handler(directorioCtx(), { slug: 'proyectos/x', tag: 'review' });
    expect(result).toMatchObject({ dry_run: true, action: 'remove_tag', source: 'directorio' });
  });

  test('(b) source in set → admitted', async () => {
    const result = await remove_tag.handler(directorioCtx(), {
      slug: 'proyectos/x', tag: 'review', source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(c) source not in set → rejected', async () => {
    const p = remove_tag.handler(directorioCtx(), {
      slug: 'proyectos/x', tag: 'review', source: 'finanzas',
    });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
  });
});

describe('multi-source workflow reproduces the original bug', () => {
  // The exact shape of Pablo's failing sequence:
  //   put_page(slug, content, source='campo')              ← worked
  //   add_link(from=A, to=B)                                ← failed: lookup vs 'directorio'
  //   add_tag(slug, tag)                                    ← failed: lookup vs 'directorio'
  // After the fix:
  //   add_link(from, to, source='campo')                    ← works
  //   add_tag(slug, tag, source='campo')                    ← works
  test('add_link with source=campo on a directorio-default client returns campo (not directorio)', async () => {
    const ctx = directorioCtx();
    const result = await add_link.handler(ctx, {
      from: 'proyectos/skill-informe-plan-cerrado',
      to: 'personas/geronimo-liberatti',
      source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('add_tag with source=campo on a directorio-default client returns campo (not directorio)', async () => {
    const ctx = directorioCtx();
    const result = await add_tag.handler(ctx, {
      slug: 'proyectos/skill-informe-plan-cerrado',
      tag: 'q2-review',
      source: 'campo',
    });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });
});
