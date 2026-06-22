/**
 * cycle phase `timeline_apply` - the contradiction-probe timeline writer,
 * wired into the overnight maintenance cycle.
 *
 * Thin wrapper around `writeTimelineFromContradictions`. Deterministic and
 * cheap (one DB read of the latest probe run + one batched INSERT ... ON
 * CONFLICT DO NOTHING). No LLM calls, so it runs every cycle by default; when
 * no probe run exists it skips cleanly. Idempotent by construction (stable
 * 4-column dedup key), so repeated nightly runs never fan out duplicates.
 *
 * This is what makes `timeline_coverage` self-heal: once
 * `gbrain eval suspected-contradictions` has flagged temporal evolutions, the
 * next cycle materializes them as timeline entries with no operator action.
 */

import type { BrainEngine } from '../engine.ts';
import { writeTimelineFromContradictions } from '../eval-contradictions/timeline-writer.ts';

export interface TimelineApplyPhaseOpts {
  dryRun?: boolean;
  sourceId?: string;
  signal?: AbortSignal;
}

export interface TimelineApplyPhaseResult {
  phase: 'timeline_apply';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
  error?: { class: string; code: string; message: string; hint?: string };
}

export async function runPhaseTimelineApply(
  engine: BrainEngine,
  opts: TimelineApplyPhaseOpts = {},
): Promise<TimelineApplyPhaseResult> {
  try {
    const res = await writeTimelineFromContradictions(engine, {
      dryRun: !!opts.dryRun,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });

    if (res.no_run) {
      return {
        phase: 'timeline_apply',
        status: 'skipped',
        duration_ms: 0,
        summary: 'no contradiction probe run to read; run `gbrain eval suspected-contradictions` first',
        details: { reason: 'no_probe_run' },
      };
    }

    const planned = res.dry_run ? res.entries.length : res.created;
    return {
      phase: 'timeline_apply',
      status: 'ok',
      duration_ms: 0,
      summary:
        `${res.dry_run ? 'would write' : 'wrote'} ${planned} timeline ` +
        `entr${planned === 1 ? 'y' : 'ies'} from ${res.considered} temporal finding(s)`,
      details: {
        run_id: res.run_id,
        considered: res.considered,
        built: res.entries.length,
        created: res.created,
        skipped_no_date: res.skipped_no_date,
        skipped_no_slug: res.skipped_no_slug,
        dry_run: res.dry_run,
      },
    };
  } catch (e) {
    return {
      phase: 'timeline_apply',
      status: 'fail',
      duration_ms: 0,
      summary: 'timeline_apply phase failed',
      details: {},
      error: {
        class: 'InternalError',
        code: 'UNKNOWN',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
