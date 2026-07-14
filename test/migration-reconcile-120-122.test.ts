/**
 * Regression — reconcile_forked_120_121_122 (fork band + 4).
 *
 * The v0.42.59.0 upstream sync added v120/v121/v122 at their upstream numbers.
 * But the fork's migration runner is a scalar high-water-mark
 * (`pending = version > current`, see migrate.ts runMigrations), and every
 * deployed brain is already stamped inside the fork band (schema_version 9003).
 * For such a brain, 120/121/122 are NOT > 9003 → they would be SKIPPED SILENTLY,
 * leaving v0.42.59 CODE running against a schema missing the timeline event FK
 * (v121), the facts ontology dimension (v122), and the search_path/RLS hardening
 * (v120). The reconcile_forked_120_121_122 catch-up (version 9004) exists to heal
 * exactly this: it sits above the band ceiling so it IS pending, and re-applies
 * the same DDL idempotently.
 *
 * This test reproduces the stuck-at-9003 brain and asserts the catch-up restores
 * the three upstream schema objects and advances the bookmark.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
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

    // ── Run migrations: only the 9004 catch-up should be pending.
    const res = await runMigrations(engine);
    expect(res.applied).toBe(1);
    expect(res.current).toBe(9004);

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
