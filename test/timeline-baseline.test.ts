/**
 * apply_timeline_baseline — creation-date baseline backfill.
 *
 * Lifts timeline_coverage by giving every entity page (person/company) that has
 * no timeline yet a single "Page created" entry dated at the page's creation,
 * sourced 'baseline' so it stays distinguishable from substantive entries.
 * Must be entity-only, idempotent, and reflected in getHealth's
 * timeline_coverage.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'raw_data', 'tags', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

describe('apply_timeline_baseline', () => {
  test('backfills entity pages without a timeline, leaves the rest alone', async () => {
    // Two entity pages with no timeline, one entity page that already has one,
    // and a non-entity leaf doc that must NOT get a baseline.
    await engine.putPage('alice-example', { type: 'person', title: 'Alice', compiled_truth: '# Alice', frontmatter: {} });
    await engine.putPage('bob-example', { type: 'company', title: 'Bob Co', compiled_truth: '# Bob Co', frontmatter: {} });
    await engine.putPage('carol-example', { type: 'person', title: 'Carol', compiled_truth: '# Carol', frontmatter: {} });
    await engine.addTimelineEntry('carol-example', { date: '2025-05-05', source: 'meeting', summary: 'hired', detail: '' });
    await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'x', frontmatter: {} });

    const res = await engine.applyTimelineBaseline();
    expect(res.created).toBe(2); // alice + bob, not carol (already had one), not the note

    // carol keeps her substantive entry untouched; no baseline added.
    const carol = await engine.getTimeline('carol-example');
    expect(carol.length).toBe(1);
    expect(carol[0].summary).toBe('hired');

    // alice got exactly one baseline entry, correctly sourced + dated at her
    // creation day (getTimeline returns `date` as a Date — normalize to YYYY-MM-DD).
    const alice = await engine.getTimeline('alice-example');
    expect(alice.length).toBe(1);
    expect(alice[0].source).toBe('baseline');
    expect(alice[0].summary).toBe('Page created');
    expect(new Date(alice[0].date as unknown as string).toISOString().slice(0, 10))
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // the leaf doc got nothing.
    const scratch = await engine.getTimeline('notes/scratch');
    expect(scratch.length).toBe(0);

    // timeline_coverage now full: all 3 entity pages have a timeline.
    const h = await engine.getHealth();
    expect(h.timeline_coverage).toBeCloseTo(1.0, 5);
  });

  test('is idempotent — a second run creates nothing', async () => {
    await engine.putPage('dave-example', { type: 'person', title: 'Dave', compiled_truth: '# Dave', frontmatter: {} });

    const first = await engine.applyTimelineBaseline();
    expect(first.created).toBe(1);

    const second = await engine.applyTimelineBaseline();
    expect(second.created).toBe(0);

    const dave = await engine.getTimeline('dave-example');
    expect(dave.length).toBe(1); // still exactly one, no duplicate
  });

  test('source-scoped backfill honors the source filter', async () => {
    // The page lives in the default source. A backfill scoped to a different
    // source must skip it; one scoped to its own source must catch it.
    await engine.putPage('grace-example', { type: 'person', title: 'Grace', compiled_truth: '# Grace', frontmatter: {} });

    const other = await engine.applyTimelineBaseline({ sourceId: 'some-other-source' });
    expect(other.created).toBe(0); // scoped out

    const own = await engine.applyTimelineBaseline({ sourceId: 'default' });
    expect(own.created).toBe(1); // scoped in
  });
});
