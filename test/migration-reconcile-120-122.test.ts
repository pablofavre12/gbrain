/** Legacy 9003 databases have no independent cursor. Infer 119, replay low
 * migrations in order, then apply the remaining fork band. */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_SCHEMA_VERSION, LATEST_UPSTREAM_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { UPSTREAM_SCHEMA_KEY } from '../src/core/fork-migration-state.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('reconcile_forked_120_121_122 heals a brain stamped inside the fork band', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema(); // fresh → applies everything through the catch-up
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a brain at schema_version 9003 missing v120/121/122 objects gets them via 9004', async () => {
    // ── Simulate the stuck brain: strip the v120/121/122 schema objects and
    //    roll the bookmark back to the fork-band ceiling that predates them.
    await engine.executeRaw(
      `ALTER TABLE timeline_entries DROP COLUMN IF EXISTS event_page_id CASCADE;`,
    );
    await engine.executeRaw(`ALTER TABLE facts DROP COLUMN IF EXISTS dimension CASCADE;`);
    await engine.executeRaw(`ALTER TABLE facts DROP COLUMN IF EXISTS value_hash CASCADE;`);
    // Un-harden a function v120 pins, to prove the catch-up re-pins it.
    await engine.executeRaw(
      `ALTER FUNCTION public.bump_page_generation_clock_fn() RESET search_path;`,
    );
    await engine.setConfig('version', "9003");
    await engine.unsetConfig(UPSTREAM_SCHEMA_KEY);

    // Sanity: the objects really are gone and the bump fn really is un-pinned.
    const preTimeline = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'timeline_entries' AND column_name = 'event_page_id';`,
    );
    expect(preTimeline[0].n).toBe(0);
    const preFn = await engine.executeRaw<{ proconfig: unknown }>(
      `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'bump_page_generation_clock_fn';`,
    );
    expect(JSON.stringify(preFn[0]?.proconfig ?? [])).not.toContain('search_path=');

    // ── Run migrations: all fork entries added after bookmark 9003 are pending.
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThan(4);
    expect(await engine.getConfig(UPSTREAM_SCHEMA_KEY)).toBe(String(LATEST_UPSTREAM_SCHEMA_VERSION));
    expect(res.current).toBe(LATEST_SCHEMA_VERSION);

    // ── v121 restored: timeline_entries.event_page_id + its indexes.
    const postTimeline = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'timeline_entries' AND column_name = 'event_page_id';`,
    );
    expect(postTimeline[0].n).toBe(1);

    // ── v122 restored: facts.dimension + facts.value_hash.
    const postFacts = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'facts' AND column_name IN ('dimension','value_hash');`,
    );
    expect(postFacts[0].n).toBe(2);

    // ── v120 restored: the trigger function is search_path-pinned again.
    const postFn = await engine.executeRaw<{ proconfig: unknown }>(
      `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'bump_page_generation_clock_fn';`,
    );
    expect(JSON.stringify(postFn[0]?.proconfig ?? [])).toContain('search_path=');
  }, 30000);

  test('re-running after the catch-up is idempotent (0 applied)', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  }, 30000);
});
