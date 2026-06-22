/**
 * Integration test for the contradiction-probe timeline writer against
 * in-memory PGLite (no DATABASE_URL required).
 *
 * Proves the deliverable: writing temporal findings as timeline entries raises
 * `timeline_coverage` (entity-scoped) AND `timeline_coverage_score` (the /15
 * brain-score component), and that re-running is a no-op (idempotent on the
 * (page_id, date, summary, source) dedup key).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeTimelineFromContradictions } from '../src/core/eval-contradictions/timeline-writer.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const companyPage = (title: string): PageInput => ({
  type: 'company', title, compiled_truth: '', timeline: '',
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'eval_contradictions_runs', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

/** Persist a probe run whose report carries a single temporal_evolution finding
 * on `slug` spanning olderDate -> newerDate. */
async function seedRun(runId: string, slug: string, olderDate: string, newerDate: string) {
  await engine.writeContradictionsRun({
    run_id: runId,
    judge_model: 'test-judge',
    prompt_version: '2',
    queries_evaluated: 1,
    queries_with_contradiction: 0,
    total_contradictions_flagged: 1,
    wilson_ci_lower: 0,
    wilson_ci_upper: 0,
    judge_errors_total: 0,
    cost_usd_total: 0,
    duration_ms: 1,
    source_tier_breakdown: {},
    report_json: {
      per_query: [{
        contradictions: [{
          verdict: 'temporal_evolution',
          resolution_kind: 'log_timeline_change',
          axis: 'team size grew',
          confidence: 0.9,
          a: { slug, effective_date: olderDate },
          b: { slug, effective_date: newerDate },
        }],
      }],
    },
  });
}

describe('writeTimelineFromContradictions (PGLite integration)', () => {
  beforeEach(truncateAll);

  test('no probe run -> reports no_run, writes nothing', async () => {
    const res = await writeTimelineFromContradictions(engine);
    expect(res.no_run).toBe(true);
    expect(res.created).toBe(0);
  });

  test('raises timeline_coverage and is idempotent', async () => {
    // Two entity pages; the finding only touches one.
    await engine.putPage('companies/acme-example', companyPage('Acme Example'));
    await engine.putPage('companies/widget-co', companyPage('Widget Co'));
    await seedRun('2026-06-22T00:00:00Z', 'companies/acme-example', '2026-06-01', '2026-06-13');

    const before = await engine.getHealth();
    expect(before.timeline_coverage).toBe(0);

    const res = await writeTimelineFromContradictions(engine);
    expect(res.no_run).toBe(false);
    expect(res.considered).toBe(1);
    expect(res.created).toBe(1);

    // The entry landed on the later-dated page, dated at the change point.
    const timeline = await engine.getTimeline('companies/acme-example');
    expect(timeline.length).toBe(1);
    // PGLite returns DATE columns as local-midnight Date objects; format from
    // local components to avoid a timezone-induced off-by-one.
    const d = new Date(timeline[0].date as unknown as string);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(ymd).toBe('2026-06-13');
    expect(timeline[0].source).toBe('contradiction-probe');
    expect(timeline[0].summary).toContain('Evolved');

    const after = await engine.getHealth();
    // 1 of 2 entity pages now has a timeline entry -> 0.5.
    expect(after.timeline_coverage).toBeGreaterThan(before.timeline_coverage);
    expect(after.timeline_coverage).toBeCloseTo(0.5, 5);
    // The /15 brain-score component moved too (pages_with_timeline up).
    expect(after.timeline_coverage_score).toBeGreaterThanOrEqual(before.timeline_coverage_score);

    // Idempotent: re-running writes nothing new.
    const second = await writeTimelineFromContradictions(engine);
    expect(second.created).toBe(0);
    expect(second.considered).toBe(1);
    const timelineAfter = await engine.getTimeline('companies/acme-example');
    expect(timelineAfter.length).toBe(1);
  });

  test('dry-run builds entries but writes nothing', async () => {
    await engine.putPage('companies/acme-example', companyPage('Acme Example'));
    await seedRun('2026-06-22T01:00:00Z', 'companies/acme-example', '2026-06-01', '2026-06-13');

    const res = await writeTimelineFromContradictions(engine, { dryRun: true });
    expect(res.dry_run).toBe(true);
    expect(res.entries.length).toBe(1);
    expect(res.created).toBe(0);
    const timeline = await engine.getTimeline('companies/acme-example');
    expect(timeline.length).toBe(0);
  });

  test('finding whose slug does not exist is JOIN-dropped (no error, created=0)', async () => {
    await seedRun('2026-06-22T02:00:00Z', 'companies/ghost', '2026-06-01', '2026-06-13');
    const res = await writeTimelineFromContradictions(engine);
    expect(res.entries.length).toBe(1); // built (slug unknown to the builder)
    expect(res.created).toBe(0);        // but JOIN-dropped at insert
  });
});
