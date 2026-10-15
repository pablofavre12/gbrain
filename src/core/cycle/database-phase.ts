import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';

/** Shared no-database, progress and timing contract for simple database phases. */
export async function runDatabasePhase(
  engine: BrainEngine | null,
  phase: CyclePhase,
  progress: ProgressReporter,
  timePhase: (run: () => Promise<PhaseResult>, phase: CyclePhase) => Promise<{ result: PhaseResult; duration_ms: number }>,
  run: (engine: BrainEngine) => Promise<PhaseResult>,
): Promise<PhaseResult> {
  if (!engine) return {
    phase, status: 'skipped', duration_ms: 0,
    summary: 'no database connected', details: { reason: 'no_database' },
  };
  progress.start(`cycle.${phase}`);
  try {
    const { result, duration_ms } = await timePhase(() => run(engine), phase);
    return { ...result, duration_ms };
  } finally {
    progress.finish();
  }
}
