import { OperationError, type OperationContext } from '../ops/contract.ts';
import { federatedSearchScope, readPolicyOpts } from '../ops/context.ts';
import { resolveReadEligibility, type ReadEligibility } from '../eligibility/policy.ts';
import type { PageReadPolicy } from '../types.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { captureTimelinePublicationGuard, type TimelinePublicationGuard } from '../persistence/timeline-publication-guard.ts';
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

import { createHash } from 'node:crypto';
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
  effective_date_source?: unknown;
  chunk_id?: unknown;
  take_id?: unknown;
  text?: unknown;
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
/** Match the probe's anchor normalization: fallback dates are not evidence. */
function currentReportAnchor(side: ReportFindingSide, page: { effective_date: Date | string | null; effective_date_source: string | null }): boolean {
  const anchored = page.effective_date && page.effective_date_source && page.effective_date_source !== 'fallback';
  const date = anchored ? (page.effective_date instanceof Date ? page.effective_date.toISOString() : String(page.effective_date)).slice(0, 10) : null;
  return side.effective_date === date && side.effective_date_source === (anchored ? page.effective_date_source : null);
}

async function visibleReportSide(engine: BrainEngine, side: ReportFindingSide | undefined, policy: PageReadPolicy, sourceId: string, eligibility: ReadEligibility): Promise<boolean> {
  if (!side || typeof side.slug !== 'string' || typeof side.text !== 'string') return false;
  // Resolve immutable evidence ids, never a same-slug substitute in another room.
  if (Number.isSafeInteger(side.chunk_id) && Number(side.chunk_id) > 0 && side.take_id == null) {
    const [ref] = await engine.executeRaw<{page_id: number; chunk_index: number; chunk_source: string; effective_date: Date | string | null; effective_date_source: string | null}>(
      'SELECT c.page_id,c.chunk_index,c.chunk_source,p.effective_date,p.effective_date_source FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.id=$1', [side.chunk_id]);
    if (!ref || !currentReportAnchor(side, ref)) return false;
    const windows = await engine.getChunkWindows([{page_id: Number(ref.page_id), from_index: Number(ref.chunk_index),
      to_index: Number(ref.chunk_index), priority: 0}], {...policy, minTrust: eligibility.floor, suppressFlagged: eligibility.suppressFlagged, chunkSources: [ref.chunk_source], maxRows: 1});
    return windows.some(page => page.source_id === sourceId && page.slug === side.slug && page.sealed && page.chunks.some(chunk => chunk.id === side.chunk_id && chunk.chunk_text === side.text));
  }
  if (Number.isSafeInteger(side.take_id) && Number(side.take_id) > 0 && side.chunk_id == null) {
    const [ref] = await engine.executeRaw<{page_id: number; effective_date: Date | string | null; effective_date_source: string | null}>(
      'SELECT t.page_id,p.effective_date,p.effective_date_source FROM takes t JOIN pages p ON p.id=t.page_id WHERE t.id=$1', [side.take_id]);
    if (!ref || !currentReportAnchor(side, ref)) return false;
    const snapshot = await engine.readPageSnapshot(side.slug, {...policy, pageId: Number(ref.page_id), requireLiveSource: true, minTrust: eligibility.floor});
    if (!snapshot || snapshot.page.source_id !== sourceId) return false;
    // Bound work on old reports; unverifiable, changed or revoked evidence stays hidden.
    for (let offset = 0; offset < 10_000; offset += 500) {
      const takes = await engine.listTakes({...policy, page_id: Number(ref.page_id), active: true, limit: 500, offset, eligibility});
      const take = takes.find(take => take.id === side.take_id);
      if (take) return take.claim === side.text;
      if (takes.length < 500) break;
    }
  }
  return false;
}

async function evidencePageId(engine: BrainEngine, side: ReportFindingSide): Promise<number | null> {
  const rows = side.chunk_id != null
    ? await engine.executeRaw<{ page_id: number }>('SELECT page_id FROM content_chunks WHERE id=$1', [side.chunk_id])
    : await engine.executeRaw<{ page_id: number }>('SELECT page_id FROM takes WHERE id=$1', [side.take_id]);
  return rows[0] ? Number(rows[0].page_id) : null;
}

async function authorizedReport(engine: BrainEngine, report: Record<string, unknown>, context: OperationContext, sourceId: string) {
  const actorPolicy = await readPolicyOpts(context, federatedSearchScope(context, sourceId));
  // An inferred timeline entry is published to the destination's readers. A
  // privileged actor's ability to read a private input is not declassification.
  const policy: PageReadPolicy = { ...actorPolicy, aclSubjectIds: [], excludePrivate: true, requireSafeChunks: true,
    takesHoldersAllowList: actorPolicy.takesHoldersAllowList === undefined || actorPolicy.takesHoldersAllowList.includes('world') ? ['world'] : [] };
  const eligibility = await resolveReadEligibility(context);
  const verified = new Map<string, Promise<boolean>>();
  const visible = (side: ReportFindingSide | undefined) => {
    const key = JSON.stringify(side ?? null);
    let result = verified.get(key);
    if (!result) {
      result = visibleReportSide(engine, side, policy, sourceId, eligibility);
      verified.set(key, result);
    }
    return result;
  };
  const perQuery = Array.isArray(report.per_query) ? report.per_query as Array<{contradictions?: unknown}> : [];
  const contradictions: ReportFinding[] = [];
  const captureGuards = new Map<string, () => Promise<TimelinePublicationGuard | null>>();
  for (const query of perQuery) {
    for (const finding of Array.isArray(query?.contradictions) ? query.contradictions as ReportFinding[] : []) {
      if (!TEMPORAL_RESOLUTION_KINDS.has(String(finding?.resolution_kind))) continue;
      if (!await visible(finding?.a) || !await visible(finding?.b)) continue;
      const entries = buildTimelineEntriesFromReport({ per_query: [{ contradictions: [finding] }] }, { sourceId }).entries;
      const a = await evidencePageId(engine, finding.a!);
      const b = await evidencePageId(engine, finding.b!);
      if (a === null || b === null) continue;
      let accepted = true;
      for (const entry of entries) {
        const targetPageId = entry.slug === finding.a!.slug ? a : entry.slug === finding.b!.slug ? b : null;
        if (targetPageId === null) { accepted = false; break; }
        const captureGuard = () => captureTimelinePublicationGuard(engine, { sourceId, targetPageId, pageIds: [a, b],
          validate: async tx => await visibleReportSide(tx, finding.a, policy, sourceId, eligibility)
            && await visibleReportSide(tx, finding.b, policy, sourceId, eligibility),
        });
        if (!await captureGuard()) { accepted = false; break; }
        captureGuards.set(JSON.stringify(entry), captureGuard);
      }
      if (accepted) contradictions.push(finding);
    }
  }
  return { report: { per_query: [{ contradictions }] }, captureGuards };
}

export async function writeTimelineFromContradictions(
  engine: BrainEngine,
  opts: { sourceId?: string; dryRun?: boolean; days?: number; context?: OperationContext } = {},
): Promise<WriteResult> {
  const rows = await engine.loadContradictionsTrend(opts.days ?? 30);
  if (rows.length === 0) {
    return {
      entries: [], considered: 0, skipped_no_date: 0, skipped_no_slug: 0,
      run_id: null, ran_at: null, created: 0, no_run: true, dry_run: !!opts.dryRun,
    };
  }
  const latest = rows[0];
  const context: OperationContext = opts.context ?? { engine, sourceId: opts.sourceId ?? 'default', remote: false, dryRun: false,
    config: { engine: engine.kind, embedding_disabled: true }, logger: console };
  const remote = context.remote !== false;
  const { report, captureGuards } = await authorizedReport(engine, latest.report_json, context, opts.sourceId ?? 'default');
  const built = buildTimelineEntriesFromReport(report, { sourceId: opts.sourceId });
  let created = 0;
  if (!opts.dryRun && built.entries.length > 0) {
      for (const entry of built.entries) {
        const sourceId = entry.source_id ?? 'default';
        const captureGuard = captureGuards.get(JSON.stringify(entry));
        if (!captureGuard) continue;
        const target = await engine.getPage(entry.slug, { sourceId });
        if (!target) continue;
        const existing = await engine.executeRaw(`SELECT 1 FROM timeline_entries t JOIN pages p ON p.id=t.page_id
          WHERE p.source_id=$1 AND p.slug=$2 AND t.date=$3::date AND t.summary=$4 AND t.source=$5 LIMIT 1`,
          [sourceId, entry.slug, entry.date, entry.summary, entry.source]);
        if (existing.length) continue;
        // An earlier entry in this batch may have changed the destination's
        // timeline/revision. Pin its current state only after that write, while
        // revalidating the report's original immutable evidence under locks.
        const guard = await captureGuard();
        if (!guard) throw new OperationError('content_conflict',
          'The inferred timeline evidence or its audience changed; this entry was not published.',
          'Re-run the inference against current public evidence before submitting another timeline write.');
        const requestId = 'timeline-probe-' + createHash('sha256').update(JSON.stringify({page_id: target.id, entry, guard})).digest('hex');
        await submitPageMutation({ ...context, sourceId }, { operation: 'add_timeline_entry',
          params: { slug: entry.slug, date: entry.date, summary: entry.summary, detail: entry.detail,
            source: entry.source, request_id: requestId }, timelinePublicationGuard: guard });
        created++;
      }
  }

  return {
    ...built,
    run_id: remote && !built.considered ? null : latest.run_id,
    ran_at: remote && !built.considered ? null : latest.ran_at,
    created,
    no_run: Boolean(remote && !built.considered),
    dry_run: !!opts.dryRun,
  };
}
