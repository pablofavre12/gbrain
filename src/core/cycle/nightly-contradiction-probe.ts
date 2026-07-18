/**
 * Nightly contradiction probe phase (perennia fork).
 *
 * Once per cadence window (default 7 days), runs the suspected-contradictions
 * probe over the queries the team actually issued (the `eval_candidates`
 * capture table) and persists the run, so `find_contradictions` /
 * `apply_timeline_from_contradictions` always read a FRESH row instead of
 * reporting `no_run: true` forever.
 *
 * Why this exists: `gbrain eval suspected-contradictions` needs an explicit
 * query set (`--from-capture | --queries-file | --query`) and is never invoked
 * by the routine autopilot cycle. On a hosted brain nobody runs it, so the
 * probe silently goes stale and the daily maintenance routine re-discovers
 * "probe never ran" on every pass. This phase closes that loop server-side.
 *
 * Default: DISABLED. Opt-in via
 *   gbrain config set autopilot.nightly_contradiction_probe.enabled true
 * Requires `eval.capture: true` so `eval_candidates` fills from real usage;
 * when the table is empty the phase skips silently WITHOUT spending (no LLM
 * judge calls). Mirrors the DI + rate-limit shape of nightly-quality-probe.
 */

/** Result reported back to the autopilot dispatcher. */
export interface ContradictionProbeResult {
  outcome: 'ran' | 'disabled' | 'rate_limited' | 'no_captures' | 'error';
  run_id?: string;
  queries_evaluated?: number;
  total_contradictions_flagged?: number;
  detail?: string;
}

export interface ContradictionProbeDeps {
  /** Returns true when the feature config flag is on. */
  isEnabled: () => boolean | Promise<boolean>;
  /** Now provider — overridable for tests of the cadence rate-limit. */
  now: () => Date;
  /** Cadence window in ms; a run inside the window is skipped. */
  resolveCadenceMs: () => number | Promise<number>;
  /** USD cap for the run (soft ceiling in the runner). */
  resolveMaxUsd: () => number | Promise<number>;
  /** Max captured queries to evaluate per run. */
  resolveMaxQueries: () => number | Promise<number>;
  /** `ran_at` of the most recent persisted probe run, or null if none. */
  lastRunAt: () => Promise<Date | null>;
  /** Load up to `limit` captured queries; returns [] when capture is off/empty. */
  loadCaptureQueries: (limit: number) => Promise<string[]>;
  /**
   * Run the probe over `queries` and persist the run row. Returns a summary,
   * or null when the runner refused (pre-flight budget refusal without --yes).
   */
  runAndPersist: (args: { queries: string[]; budgetUsd: number }) => Promise<{
    run_id: string;
    queries_evaluated: number;
    total_contradictions_flagged: number;
  } | null>;
}

/**
 * Pure function: decide whether the probe should run given the last run time.
 * Returns reason when skipping. A null `lastRunAt` (never run) always runs.
 */
export function shouldRunContradictionProbe(
  now: Date,
  lastRunAt: Date | null,
  cadenceMs: number,
): { run: true } | { run: false; reason: 'rate_limited' } {
  if (lastRunAt) {
    const elapsed = now.getTime() - lastRunAt.getTime();
    if (Number.isFinite(elapsed) && elapsed < cadenceMs) {
      return { run: false, reason: 'rate_limited' };
    }
  }
  return { run: true };
}

/**
 * Run the nightly contradiction probe. Pure DI surface — `deps` controls
 * every external effect so tests can stub the engine / runner / persistence.
 */
export async function runNightlyContradictionProbe(
  deps: ContradictionProbeDeps,
): Promise<ContradictionProbeResult> {
  if (!(await deps.isEnabled())) {
    return { outcome: 'disabled', detail: 'feature flag off' };
  }

  // Cadence rate-limit — skip when a run happened inside the window.
  const now = deps.now();
  const cadenceMs = await deps.resolveCadenceMs();
  const last = await deps.lastRunAt();
  const decision = shouldRunContradictionProbe(now, last, cadenceMs);
  if (!decision.run) {
    return { outcome: 'rate_limited', detail: 'within cadence window' };
  }

  // Load captured queries. Empty => capture is off or no usage yet: skip
  // WITHOUT spending. The probe is meaningless (and would need synthetic
  // queries, which cross entities and yield false positives) without them.
  const maxQueries = await deps.resolveMaxQueries();
  const queries = await deps.loadCaptureQueries(maxQueries);
  if (queries.length === 0) {
    process.stderr.write(
      `[nightly-contradiction-probe] eval_candidates is empty; nothing to probe. ` +
        `Enable capture with 'gbrain config set eval.capture true' and let real ` +
        `queries accumulate. Skipping (no spend).\n`,
    );
    return { outcome: 'no_captures', detail: 'no captured queries' };
  }

  try {
    const budgetUsd = await deps.resolveMaxUsd();
    const res = await deps.runAndPersist({ queries, budgetUsd });
    if (!res) {
      return { outcome: 'error', detail: 'probe refused at pre-flight' };
    }
    return {
      outcome: 'ran',
      run_id: res.run_id,
      queries_evaluated: res.queries_evaluated,
      total_contradictions_flagged: res.total_contradictions_flagged,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[nightly-contradiction-probe] runtime error: ${detail}\n`);
    return { outcome: 'error', detail };
  }
}
