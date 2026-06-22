/**
 * Unit tests for the contradiction-probe timeline writer's pure builder.
 *
 * The builder turns a persisted probe report into idempotent timeline rows.
 * These tests pin the decisions that make re-runs no-ops: stable `source`,
 * deterministic `summary`, later-dated-side page selection, verdict filtering.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildTimelineEntriesFromReport,
  TIMELINE_WRITER_SOURCE,
} from '../src/core/eval-contradictions/timeline-writer.ts';

/** Build a minimal report with one finding. */
function reportWith(findings: unknown[]): Record<string, unknown> {
  return { per_query: [{ contradictions: findings }] };
}

const evolution = (over: Partial<Record<string, unknown>> = {}) => ({
  verdict: 'temporal_evolution',
  resolution_kind: 'log_timeline_change',
  axis: 'team size',
  confidence: 0.8,
  a: { slug: 'companies/acme-example', effective_date: '2026-06-01' },
  b: { slug: 'companies/acme-example', effective_date: '2026-06-13' },
  ...over,
});

describe('buildTimelineEntriesFromReport', () => {
  test('null / empty report yields nothing', () => {
    expect(buildTimelineEntriesFromReport(null).entries).toEqual([]);
    expect(buildTimelineEntriesFromReport(undefined).entries).toEqual([]);
    expect(buildTimelineEntriesFromReport({}).entries).toEqual([]);
    expect(buildTimelineEntriesFromReport(reportWith([])).entries).toEqual([]);
  });

  test('keeps only temporal resolution kinds', () => {
    const r = reportWith([
      evolution(),
      { verdict: 'contradiction', resolution_kind: 'manual_review', a: { slug: 'x', effective_date: '2026-01-01' }, b: { slug: 'y', effective_date: '2026-02-01' } },
      { verdict: 'temporal_regression', resolution_kind: 'flag_for_review', a: { slug: 'x', effective_date: '2026-01-01' }, b: { slug: 'y', effective_date: '2026-02-01' } },
    ]);
    const out = buildTimelineEntriesFromReport(r);
    expect(out.considered).toBe(1);
    expect(out.entries.length).toBe(1);
  });

  test('dates the entry at the later side and attaches it to that page', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution()]));
    expect(out.entries.length).toBe(1);
    const e = out.entries[0];
    expect(e.slug).toBe('companies/acme-example');
    expect(e.date).toBe('2026-06-13'); // the newer side
    expect(e.summary).toContain('Evolved');
    expect(e.summary).toContain('2026-06-01'); // references the older anchor
  });

  test('later side wins regardless of a/b order', () => {
    const swapped = evolution({
      a: { slug: 'companies/acme-example', effective_date: '2026-06-13' },
      b: { slug: 'companies/acme-example', effective_date: '2026-06-01' },
    });
    const out = buildTimelineEntriesFromReport(reportWith([swapped]));
    expect(out.entries[0].date).toBe('2026-06-13');
  });

  test('source is the stable constant (idempotency key), never a run id', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution()]));
    expect(out.entries[0].source).toBe(TIMELINE_WRITER_SOURCE);
    expect(out.entries[0].source).toBe('contradiction-probe');
  });

  test('supersession renders the Superseded verb', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      verdict: 'temporal_supersession',
      resolution_kind: 'temporal_supersede',
    })]));
    expect(out.entries[0].summary).toContain('Superseded');
  });

  test('skips findings with no date anchor on either side', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      a: { slug: 'companies/acme-example', effective_date: null },
      b: { slug: 'companies/acme-example', effective_date: null },
    })]));
    expect(out.considered).toBe(1);
    expect(out.skipped_no_date).toBe(1);
    expect(out.entries.length).toBe(0);
  });

  test('one-sided date uses that side as the anchor', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      a: { slug: 'companies/acme-example', effective_date: '2026-06-13' },
      b: { slug: 'people/alice-example', effective_date: null },
    })]));
    expect(out.entries.length).toBe(1);
    expect(out.entries[0].slug).toBe('companies/acme-example');
    expect(out.entries[0].date).toBe('2026-06-13');
  });

  test('skips findings with no usable slug on the current-state side', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      a: { slug: null, effective_date: '2026-06-13' },
      b: { slug: 'people/alice-example', effective_date: null },
    })]));
    expect(out.skipped_no_slug).toBe(1);
    expect(out.entries.length).toBe(0);
  });

  test('rejects malformed dates (not strict YYYY-MM-DD)', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      a: { slug: 'companies/acme-example', effective_date: '2026/06/13' },
      b: { slug: 'companies/acme-example', effective_date: 'June 1' },
    })]));
    expect(out.skipped_no_date).toBe(1);
    expect(out.entries.length).toBe(0);
  });

  test('deterministic: same report builds byte-identical entries (dedup-stable)', () => {
    const a = buildTimelineEntriesFromReport(reportWith([evolution()]));
    const b = buildTimelineEntriesFromReport(reportWith([evolution()]));
    expect(a.entries).toEqual(b.entries);
  });

  test('within-batch dedup collapses identical findings to one entry', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution(), evolution()]));
    expect(out.considered).toBe(2);
    expect(out.entries.length).toBe(1);
  });

  test('threads source_id (multi-source brains) and defaults to "default"', () => {
    expect(buildTimelineEntriesFromReport(reportWith([evolution()])).entries[0].source_id).toBe('default');
    const scoped = buildTimelineEntriesFromReport(reportWith([evolution()]), { sourceId: 'repo-a' });
    expect(scoped.entries[0].source_id).toBe('repo-a');
  });

  test('axis is normalized to a single bounded line', () => {
    const out = buildTimelineEntriesFromReport(reportWith([evolution({
      axis: 'line one\nline two   with    spaces',
    })]));
    expect(out.entries[0].summary).not.toContain('\n');
    expect(out.entries[0].summary).toContain('line one line two with spaces');
  });
});
