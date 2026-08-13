/**
 * eval-contradictions/timeline-writer - materialize temporal findings as
 * idempotent timeline entries.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The contradiction probe's judge classifies pairs into six verdicts. Two of
 * them are *temporal* and non-error: `temporal_evolution` (legitimate change
 * over time) and `temporal_supersession` (a newer claim updates an older one).
 * For those, `auto-supersession.ts` historically rendered a paste-ready HINT
 * comment ("record in timeline when the gbrain timeline writer lands") because
 * the writer that turns those findings into real `timeline_entries` rows was
 * deferred. This module IS that writer.
 *
 * WHAT IT DOES
 * ------------
 * Reads the latest persisted probe report (the same `eval_contradictions_runs`
 * row that `find_contradictions` surfaces), keeps the findings whose
 * resolution_kind is `log_timeline_change` (evolution) or `temporal_supersede`
 * (supersession), and writes one timeline entry per finding onto the page that
 * represents the *current* state (the later-dated side). The entry is dated at
 * the change point.
 *
 * IDEMPOTENCY (the design constraint)
 * -----------------------------------
 * `timeline_entries` has `idx_timeline_dedup UNIQUE (page_id, date, summary,
 * source)` and the batch insert uses `ON CONFLICT DO NOTHING`. For re-runs to
 * be no-ops the four key columns MUST be stable across runs:
 *   - page_id : derived from the finding's slug (stable).
 *   - date    : the later effective_date of the pair (stable per finding).
 *   - summary : built deterministically from verdict + the older side's slug +
 *               a normalized one-line axis (stable per cached verdict).
 *   - source  : the CONSTANT `TIMELINE_WRITER_SOURCE`, NOT the run_id. Keying on
 *               run_id would defeat dedup - every nightly run would fan out a
 *               fresh duplicate. This is the single most important decision in
 *               the file; do not "improve" it by embedding the run_id.
 *
 * The builder is a pure function (`buildTimelineEntriesFromReport`) so the date
 * selection, verdict filtering, and summary determinism are unit-testable with
 * no engine. `writeTimelineFromContradictions` is the thin DB-touching wrapper.
 */

import type { BrainEngine, TimelineBatchInput } from '../engine.ts';

/**
 * Stable `source` value for every timeline row this writer emits. Participates
 * in `idx_timeline_dedup`; keeping it constant is what makes re-runs idempotent.
 */
export const TIMELINE_WRITER_SOURCE = 'contradiction-probe' as const;

/** Resolution kinds whose findings this writer materializes. */
const TEMPORAL_RESOLUTION_KINDS = new Set(['log_timeline_change', 'temporal_supersede']);

/** Minimal shape we read out of the persisted report JSON. Defensive: the report
 * is JSONB on disk, so we treat every field as possibly-absent. */
interface ReportFindingSide {
  slug?: unknown;
  effective_date?: unknown;
}
interface ReportFinding {
  verdict?: unknown;
  resolution_kind?: unknown;
  axis?: unknown;
  confidence?: unknown;
  a?: ReportFindingSide;
  b?: ReportFindingSide;
}

export interface BuildOpts {
  /** Source scope for the owning pages. Defaults to 'default' (single-source
   * brains). Multi-source brains pass the source whose pages should receive the
   * entries (mirrors `add_timeline_entry` ctx.sourceId / `gbrain dream --source`). */
  sourceId?: string;
}

export interface BuildResult {
  entries: TimelineBatchInput[];
  /** Findings examined (after the resolution-kind filter). */
  considered: number;
  /** Findings dropped because neither side carried an effective_date anchor. */
  skipped_no_date: number;
  /** Findings dropped because they had no usable slug for the current-state side. */
  skipped_no_slug: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Normalize an axis description to a single bounded line so it can't smuggle
 * newlines into the dedup key or balloon the summary. */
function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
}

/**
 * Pure: turn a persisted probe report into the timeline rows to insert.
 *
 * Exported separately from the DB write so date selection, verdict filtering,
 * summary determinism, and dedup-key stability are testable without an engine.
 */
export function buildTimelineEntriesFromReport(
  report: Record<string, unknown> | null | undefined,
  opts: BuildOpts = {},
): BuildResult {
  const sourceId = opts.sourceId ?? 'default';
  const result: BuildResult = { entries: [], considered: 0, skipped_no_date: 0, skipped_no_slug: 0 };
  if (!report) return result;

  const perQuery = Array.isArray(report.per_query) ? (report.per_query as Array<{ contradictions?: unknown }>) : [];
  const findings: ReportFinding[] = perQuery.flatMap((q) =>
    Array.isArray(q?.contradictions) ? (q.contradictions as ReportFinding[]) : [],
  );

  // Dedup within the batch on the 4-column key so `considered`/`entries` counts
  // stay honest when two findings collapse to the same entry.
  const seen = new Set<string>();

  for (const f of findings) {
    const kind = asString(f.resolution_kind);
    if (!kind || !TEMPORAL_RESOLUTION_KINDS.has(kind)) continue;
    result.considered++;

    const aSlug = asString(f.a?.slug);
    const bSlug = asString(f.b?.slug);
    const aDateRaw = asString(f.a?.effective_date);
    const bDateRaw = asString(f.b?.effective_date);
    const aDate = aDateRaw && ISO_DATE_RE.test(aDateRaw) ? aDateRaw : null;
    const bDate = bDateRaw && ISO_DATE_RE.test(bDateRaw) ? bDateRaw : null;

    if (!aDate && !bDate) {
      result.skipped_no_date++;
      continue;
    }

    // The current-state side is the later-dated one; the entry is dated there.
    // When only one side carries a date, that side is the anchor.
    let newerSlug: string | null;
    let newerDate: string;
    let olderSlug: string | null;
    let olderDate: string | null;
    if (aDate && bDate) {
      if (aDate >= bDate) {
        newerSlug = aSlug; newerDate = aDate; olderSlug = bSlug; olderDate = bDate;
      } else {
        newerSlug = bSlug; newerDate = bDate; olderSlug = aSlug; olderDate = aDate;
      }
    } else if (aDate) {
      newerSlug = aSlug; newerDate = aDate; olderSlug = bSlug; olderDate = null;
    } else {
      newerSlug = bSlug; newerDate = bDate as string; olderSlug = aSlug; olderDate = null;
    }

    if (!newerSlug) {
      result.skipped_no_slug++;
      continue;
    }

    const verdict = asString(f.verdict) ?? '';
    const verb = verdict === 'temporal_supersession' ? 'Superseded' : 'Evolved';
    const axis = asString(f.axis);
    const axisLine = axis ? oneLine(axis) : '';
    const fromPart = olderSlug
      ? `${olderSlug}${olderDate ? ` @ ${olderDate}` : ''}`
      : 'prior state';
    const summary = `${verb} prior state (${fromPart})${axisLine ? `: ${axisLine}` : ''}`;

    const confidence = typeof f.confidence === 'number' ? f.confidence : null;
    const detail =
      `Recorded by contradiction probe (verdict=${verdict || 'temporal'}` +
      `${confidence !== null ? `, confidence=${confidence}` : ''}). ` +
      `${olderSlug ?? 'prior state'} (${olderDate ?? 'date unknown'}) -> ${newerSlug} (${newerDate}).`;

    const dedupKey = `${newerSlug}${newerDate}${summary}${TIMELINE_WRITER_SOURCE}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    result.entries.push({
      slug: newerSlug,
      date: newerDate,
      summary,
      detail,
      source: TIMELINE_WRITER_SOURCE,
      source_id: sourceId,
    });
  }

  return result;
}

export interface WriteResult extends BuildResult {
  run_id: string | null;
  ran_at: string | null;
  /** Rows actually inserted (excludes ON CONFLICT collisions AND slugs whose
   * page did not exist for this source - both are JOIN/conflict drops). */
  created: number;
  /** True when no probe run exists to read from. */
  no_run: boolean;
  dry_run: boolean;
}

/**
 * Load the latest persisted contradiction run and materialize its temporal
 * findings as idempotent timeline entries. No new probe is triggered; this
 * consumes whatever `gbrain eval suspected-contradictions` last wrote.
 */
export async function writeTimelineFromContradictions(
  engine: BrainEngine,
  opts: { sourceId?: string; dryRun?: boolean; days?: number } = {},
): Promise<WriteResult> {
  const rows = await engine.loadContradictionsTrend(opts.days ?? 30);
  if (rows.length === 0) {
    return {
      entries: [], considered: 0, skipped_no_date: 0, skipped_no_slug: 0,
      run_id: null, ran_at: null, created: 0, no_run: true, dry_run: !!opts.dryRun,
    };
  }
  const latest = rows[0];
  const built = buildTimelineEntriesFromReport(latest.report_json, { sourceId: opts.sourceId });

  let created = 0;
  if (!opts.dryRun && built.entries.length > 0) {
    created = await engine.addTimelineEntriesBatch(built.entries, { auditSite: 'timeline-writer.contradictions' });
  }

  return {
    ...built,
    run_id: latest.run_id,
    ran_at: latest.ran_at,
    created,
    no_run: false,
    dry_run: !!opts.dryRun,
  };
}
