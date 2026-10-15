/**
 * The nightly probes the `gbrain autopilot` daemon runs after every tick
 * (4.5 quality probe, 4.6 conversation-parser probe). Both own their gates and
 * never throw into the loop. Called by runAutopilotDaemon.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import type { NightlyProbeModelRoutes } from '../core/cycle/nightly-probe-routes.ts';
import { logError } from './autopilot.ts';

/**
 * The quality probe's model routes (#5872): refresh the daemon's gateway from
 * the brain the way queued jobs do, so a `gbrain config set models.*` made
 * after daemon start reaches the #4636 judge substitute, then resolve the
 * reader, extractor and judge-slot routes against the same brain.
 */
export async function resolveNightlyProbeModelRoutesForDaemon(engine: BrainEngine): Promise<NightlyProbeModelRoutes> {
  // refreshGatewayForJob's two calls, inlined: importing jobs.ts would grant its flags to `autopilot` in the flag registry.
  const { refreshGatewayEnvFromFilePlane, reconfigureGatewayWithEngine } = await import('../core/ai/gateway.ts');
  const { resolveNightlyProbeModelRoutes } = await import('../core/cycle/nightly-probe-routes.ts');
  refreshGatewayEnvFromFilePlane();
  await reconfigureGatewayWithEngine(engine);
  return resolveNightlyProbeModelRoutes(engine);
}

export async function runNightlyQualityProbeStep(engine: BrainEngine, cfg: GBrainConfig | null): Promise<void> {
  // 4.5 — Nightly quality probe (v0.41).
  // Per D10: trust the phase's internal 24h rate-limit (via shouldRunNightly
  // reading the audit JSONL). No scheduler-side precheck — one source of
  // truth for the rate-limit. Feature flag gates the probe entirely.
  // Wrapped in try/catch — a probe failure NEVER crashes the autopilot
  // loop. Probe runs even when cycleOk=false (probe may surface signal
  // explaining why the cycle is failing).
  try {
    const { resolveProbeEnabled, resolveProbeCap, runNightlyQualityProbe } =
      await import('../core/cycle/nightly-quality-probe.ts');
    const { resolveNightlyProbeSearchConfigSnapshot } =
      await import('../core/cycle/nightly-probe-search-config.ts');
    // Dual-plane read: `gbrain config set` (what the doctor enable hint
    // prints) writes the DB plane; ~/.gbrain/config.json is the fallback.
    let dbEnabled: string | null = null;
    let dbMaxUsd: string | null = null;
    try {
      dbEnabled = await engine.getConfig('autopilot.nightly_quality_probe.enabled');
      dbMaxUsd = await engine.getConfig('autopilot.nightly_quality_probe.max_usd');
    } catch { /* DB unavailable → file plane only */ }
    const probeEnabled = resolveProbeEnabled(dbEnabled, cfg?.autopilot?.nightly_quality_probe?.enabled);
    if (probeEnabled) {
      const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
      const { NIGHTLY_PROBE_FIXTURES } = await import('../core/cycle/nightly-probe-fixtures.ts');
      const { loadPricingOverrides } = await import('../core/budget/budget-tracker.ts');
      const { isAvailable } = await import('../core/ai/gateway.ts');
      const cap = resolveProbeCap(dbMaxUsd, cfg?.autopilot?.nightly_quality_probe?.max_usd);
      await runNightlyQualityProbe({
        isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
        hasEmbeddingProvider: () => isAvailable('embedding'),
        resolveMaxUsd: () => cap.maxUsd,
        resolveBudgetPolicy: async () => ({ capSource: cap.capSource, pricingOverrides: await loadPricingOverrides(engine) }),
        // Embedded with the package (#5187): a compiled binary reads it from the bundle, not the brain repo.
        resolveFixturePath: () => NIGHTLY_PROBE_FIXTURES.longMemEval,
        resolveSearchConfigSnapshot: () => resolveNightlyProbeSearchConfigSnapshot(engine),
        resolveModelRoutes: () => resolveNightlyProbeModelRoutesForDaemon(engine),
        runLongMemEval: runLongMemEvalForProbe,
        runCrossModalBatch: runCrossModalBatchForProbe,
        now: () => new Date(),
      });
    }
  } catch (e) {
    logError('autopilot.nightly_probe', e);
    // Intentional: do NOT bump consecutiveErrors. Probe failure is
    // informational; autopilot loop continues.
  }
}

export async function runParserProbeStep(engine: BrainEngine, cfg: GBrainConfig | null): Promise<void> {
  // 4.6 — Nightly conversation-parser probe (v0.41.16.0 phase module;
  // the scheduler wire-up was deferred at ship and is added here). Same
  // posture as 4.5: the phase owns its gates (enabled/mode-gate, LLM
  // key), the wiring owns invocation + the audit row, and a probe
  // failure NEVER crashes the autopilot loop. Per D10 the probe is
  // default-ON for search.mode=tokenmax, opt-in otherwise.
  try {
    const { runConversationParserNightlyProbe } = await import('../core/conversation-parser/nightly-probe.ts');
    const { logParserProbeEvent, parserProbeRanWithin } = await import('../core/audit-parser-probe.ts');
    const { isAvailable } = await import('../core/ai/gateway.ts');
    const { NIGHTLY_PROBE_FIXTURES } = await import('../core/cycle/nightly-probe-fixtures.ts');
    // Flag reads dual-plane: the DB row (`gbrain config set …`) wins,
    // ~/.gbrain/config.json is the fallback. search.mode lives on the
    // DB plane only (mode.ts owns it).
    let parserDbEnabled: string | null = null;
    let dbSearchMode: string | null = null;
    try {
      parserDbEnabled = await engine.getConfig('autopilot.conversation_parser_probe.enabled');
      dbSearchMode = await engine.getConfig('search.mode');
    } catch { /* DB unavailable → file plane only */ }
    const parserEnabled = parserDbEnabled != null
      ? parserDbEnabled === 'true'
      : cfg?.autopilot?.conversation_parser_probe?.enabled === true;
    const searchMode = dbSearchMode ?? '';
    // Fixtures are embedded with the package (C-N6), so a compiled binary
    // reads them from its bundle; the phase writes a `skipped` row if they
    // are ever unreadable, and that row also holds the 24h rate limit.
    if (parserEnabled || searchMode === 'tokenmax') {
      const result = await runConversationParserNightlyProbe({
        isEnabled: () => parserEnabled,
        searchMode: () => searchMode,
        hasLlmKey: () => isAvailable('chat'),
        resolveFixturePath: () => NIGHTLY_PROBE_FIXTURES.parserFormats,
        resolveAdversarialPath: () => NIGHTLY_PROBE_FIXTURES.parserAdversarial,
        now: () => new Date(),
        shouldSkipForRateLimit: () => parserProbeRanWithin(24 * 60 * 60 * 1000),
      });
      // rate_limited is a non-run: the loop ticks every few minutes, so
      // logging every skip would flood the audit file with no-signal rows.
      if (result.outcome !== 'rate_limited') logParserProbeEvent(result);
    }
  } catch (e) {
    logError('autopilot.parser_probe', e);
    // Informational, like 4.5: do NOT bump consecutiveErrors.
  }
}


export async function runNightlyContradictionProbeStep(engine: BrainEngine, cfg: GBrainConfig | null): Promise<void> {
  // 4.7 — Nightly contradiction probe (perennia fork).
  // Once per cadence (default 7d), run the suspected-contradictions probe
  // over CAPTURED queries so find_contradictions has a fresh row instead of
  // going stale forever (the routine cycle never invokes the probe; it needs
  // an explicit query set). Requires eval.capture; skips silently WITHOUT
  // spending when eval_candidates is empty. Postgres-only (needs the capture
  // table + persisted runs). Wrapped in try/catch — a probe failure NEVER
  // crashes the autopilot loop and does NOT bump consecutiveErrors.
  try {
    const cxEnabled = cfg?.autopilot?.nightly_contradiction_probe?.enabled === true;
    if (cxEnabled && engine.kind === 'postgres') {
      const { runNightlyContradictionProbe } = await import('../core/cycle/nightly-contradiction-probe.ts');
      const { runContradictionProbe } = await import('../core/eval-contradictions/runner.ts');
      const { writeRunRow } = await import('../core/eval-contradictions/trends.ts');
      const { resolveModel } = await import('../core/model-config.ts');
      const cxCfg = cfg?.autopilot?.nightly_contradiction_probe ?? {};
      const cadenceDays = Number(cxCfg.cadence_days ?? 7);
      const maxUsd = Number(cxCfg.max_usd ?? 0.6);
      const maxQueries = Number(cxCfg.max_queries ?? 25);
      const topK = Number(cxCfg.top_k ?? 5);
      await runNightlyContradictionProbe({
        isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
        now: () => new Date(),
        resolveCadenceMs: () => Math.max(0, cadenceDays) * 24 * 60 * 60 * 1000,
        resolveMaxUsd: () => maxUsd,
        resolveMaxQueries: () => maxQueries,
        lastRunAt: async () => {
          const rows = await engine.loadContradictionsTrend(Math.max(1, Math.ceil(cadenceDays) + 1));
          const latest = rows[0]?.ran_at;
          return latest ? new Date(latest) : null;
        },
        loadCaptureQueries: async (limit: number) => {
          const rows = await engine.executeRaw<{ query: string }>(
            `SELECT query FROM eval_candidates WHERE query IS NOT NULL ORDER BY id DESC LIMIT $1`,
            [limit],
          );
          return (rows ?? [])
            .map((r) => r.query)
            .filter((q): q is string => typeof q === 'string' && q.length > 0);
        },
        runAndPersist: async ({ queries, budgetUsd }) => {
          const judgeModel = await resolveModel(engine, {
            configKey: 'models.eval.contradictions_judge',
            tier: 'utility',
            envVar: 'GBRAIN_CONTRADICTIONS_JUDGE_MODEL',
            fallback: 'anthropic:claude-haiku-4-5',
          });
          const out = await runContradictionProbe({
            engine,
            queries,
            judgeModel,
            topK,
            budgetUsd,
            yesOverride: true, // non-interactive: auto-proceed past the pre-flight prompt
          });
          if (out.preFlightRefused) return null;
          await writeRunRow(engine, out.report, out.report.duration_ms);
          return {
            run_id: out.report.run_id,
            queries_evaluated: out.report.queries_evaluated,
            total_contradictions_flagged: out.report.total_contradictions_flagged,
          };
        },
      });
    }
  } catch (e) {
    logError('autopilot.contradiction_probe', e);
    // Intentional: probe failure is informational; loop continues.
  }
}
