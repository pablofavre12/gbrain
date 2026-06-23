/**
 * delete_page / restore_page — federated_write symmetry.
 *
 * Delete rights track write rights: a client may soft-delete (and restore) a
 * page in any sala it is authorized to WRITE to, i.e. `{ctx.sourceId} ∪
 * ctx.auth.federatedWrite`, resolved by the same `resolveWriteSource` gate that
 * put_page/add_link use. Before this fix, delete_page/restore_page ignored the
 * per-call target and always operated on ctx.sourceId, so an admin token bound
 * to `directorio` got page_not_found trying to delete a page living in
 * `backoffice` — even though it could write there.
 *
 * Mirrors put-page-federated-write.test.ts: dry-run with a stub engine (no DB),
 * and the dry-run return echoes the resolved `source` so we assert the target.
 *
 * Coverage per op:
 *   (a) no `source`             → resolves to ctx.sourceId (unchanged behavior)
 *   (b) `source` in the set     → allowed (own source_id OR a federated_write src)
 *   (c) `source` NOT in the set → rejected with the federated_write auth error
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const delete_page = operations.find(o => o.name === 'delete_page') as Operation;
if (!delete_page) throw new Error('delete_page op missing');
const restore_page = operations.find(o => o.name === 'restore_page') as Operation;
if (!restore_page) throw new Error('restore_page op missing');

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

// A "directorio" admin token: writes (and now deletes) in its own source plus campo + lideres.
function directorioCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return makeCtx({
    sourceId: 'directorio',
    auth: {
      token: 'stub',
      clientId: 'gbrain_cl_director',
      scopes: ['read', 'write', 'admin'],
      sourceId: 'directorio',
      allowedSources: ['campo', 'lideres', 'directorio'],
      federatedWrite: ['campo', 'lideres'],
    },
    ...overrides,
  });
}

describe('delete_page honors federated_write (delete tracks write)', () => {
  test('(a) no source → targets ctx.sourceId', async () => {
    const result = await delete_page.handler(directorioCtx(), { slug: 'wiki/x' });
    expect(result).toMatchObject({ dry_run: true, action: 'soft_delete_page', slug: 'wiki/x', source: 'directorio' });
  });

  test('(b) source in federated_write set → targets there', async () => {
    const result = await delete_page.handler(directorioCtx(), { slug: 'wiki/x', source: 'campo' });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
    const result2 = await delete_page.handler(directorioCtx(), { slug: 'wiki/x', source: 'lideres' });
    expect(result2).toMatchObject({ dry_run: true, source: 'lideres' });
  });

  test('(c) source not in set → rejected (preview surfaces the rejection)', async () => {
    const p = delete_page.handler(directorioCtx(), { slug: 'wiki/x', source: 'finanzas' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/federated_write/);
    await expect(p).rejects.toThrow(/finanzas/);
  });

  test('no federatedWrite grant → only ctx.sourceId admitted', async () => {
    const ctx = makeCtx({ sourceId: 'campo' }); // no auth.federatedWrite
    const ok = await delete_page.handler(ctx, { slug: 'wiki/x', source: 'campo' });
    expect(ok).toMatchObject({ dry_run: true, source: 'campo' });
    const bad = delete_page.handler(ctx, { slug: 'wiki/x', source: 'backoffice' });
    await expect(bad).rejects.toThrow(/federated_write/);
  });
});

describe('restore_page honors federated_write (symmetric with delete_page)', () => {
  test('(a) no source → targets ctx.sourceId', async () => {
    const result = await restore_page.handler(directorioCtx(), { slug: 'wiki/x' });
    expect(result).toMatchObject({ dry_run: true, action: 'restore_page', slug: 'wiki/x', source: 'directorio' });
  });

  test('(b) source in federated_write set → targets there', async () => {
    const result = await restore_page.handler(directorioCtx(), { slug: 'wiki/x', source: 'campo' });
    expect(result).toMatchObject({ dry_run: true, source: 'campo' });
  });

  test('(c) source not in set → rejected', async () => {
    const p = restore_page.handler(directorioCtx(), { slug: 'wiki/x', source: 'finanzas' });
    await expect(p).rejects.toBeInstanceOf(OperationError);
    await expect(p).rejects.toThrow(/finanzas/);
  });
});
