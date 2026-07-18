/**
 * Nightly contradiction probe phase (perennia fork).
 *
 * Hermetic: every external effect goes through the ContradictionProbeDeps DI
 * surface. No PGLite, no real LLM calls, no engine.
 */

import { describe, test, expect } from 'bun:test';

import {
  runNightlyContradictionProbe,
  shouldRunContradictionProbe,
  type ContradictionProbeDeps,
} from '../src/core/cycle/nightly-contradiction-probe.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDeps(over: Partial<ContradictionProbeDeps> = {}): {
  deps: ContradictionProbeDeps;
  calls: { runAndPersist: number; loadCaptureQueries: number };
} {
  const calls = { runAndPersist: 0, loadCaptureQueries: 0 };
  const deps: ContradictionProbeDeps = {
    isEnabled: () => true,
    now: () => new Date('2026-07-18T12:00:00Z'),
    resolveCadenceMs: () => 7 * DAY_MS,
    resolveMaxUsd: () => 0.6,
    resolveMaxQueries: () => 25,
    lastRunAt: async () => null,
    loadCaptureQueries: async (limit: number) => {
      calls.loadCaptureQueries++;
      return Array.from({ length: Math.min(3, limit) }, (_, i) => `q${i}`);
    },
    runAndPersist: async () => {
      calls.runAndPersist++;
      return { run_id: 'run-1', queries_evaluated: 3, total_contradictions_flagged: 1 };
    },
    ...over,
  };
  return { deps, calls };
}

describe('shouldRunContradictionProbe', () => {
  const now = new Date('2026-07-18T12:00:00Z');

  test('never run (null lastRunAt) → run', () => {
    expect(shouldRunContradictionProbe(now, null, 7 * DAY_MS)).toEqual({ run: true });
  });

  test('inside cadence window → rate_limited', () => {
    const last = new Date(now.getTime() - 2 * DAY_MS);
    expect(shouldRunContradictionProbe(now, last, 7 * DAY_MS)).toEqual({
      run: false,
      reason: 'rate_limited',
    });
  });

  test('outside cadence window → run', () => {
    const last = new Date(now.getTime() - 8 * DAY_MS);
    expect(shouldRunContradictionProbe(now, last, 7 * DAY_MS)).toEqual({ run: true });
  });

  test('exactly at the boundary → run (elapsed not < cadence)', () => {
    const last = new Date(now.getTime() - 7 * DAY_MS);
    expect(shouldRunContradictionProbe(now, last, 7 * DAY_MS)).toEqual({ run: true });
  });
});

describe('runNightlyContradictionProbe', () => {
  test('disabled flag → outcome disabled, no work', async () => {
    const { deps, calls } = makeDeps({ isEnabled: () => false });
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('disabled');
    expect(calls.loadCaptureQueries).toBe(0);
    expect(calls.runAndPersist).toBe(0);
  });

  test('recent run inside cadence → rate_limited, no spend', async () => {
    const { deps, calls } = makeDeps({
      lastRunAt: async () => new Date('2026-07-16T12:00:00Z'), // 2 days ago < 7d
    });
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('rate_limited');
    expect(calls.loadCaptureQueries).toBe(0);
    expect(calls.runAndPersist).toBe(0);
  });

  test('empty capture table → no_captures, never calls the judge', async () => {
    const { deps, calls } = makeDeps({ loadCaptureQueries: async () => [] });
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('no_captures');
    expect(calls.runAndPersist).toBe(0);
  });

  test('happy path → ran, surfaces run summary', async () => {
    const { deps, calls } = makeDeps();
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('ran');
    expect(res.run_id).toBe('run-1');
    expect(res.queries_evaluated).toBe(3);
    expect(res.total_contradictions_flagged).toBe(1);
    expect(calls.runAndPersist).toBe(1);
  });

  test('pre-flight refusal (runAndPersist → null) → error', async () => {
    const { deps } = makeDeps({ runAndPersist: async () => null });
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('error');
    expect(res.detail).toContain('pre-flight');
  });

  test('runner throws → error, does not propagate', async () => {
    const { deps } = makeDeps({
      runAndPersist: async () => {
        throw new Error('boom');
      },
    });
    const res = await runNightlyContradictionProbe(deps);
    expect(res.outcome).toBe('error');
    expect(res.detail).toBe('boom');
  });

  test('respects maxQueries limit passed to loadCaptureQueries', async () => {
    let seenLimit = -1;
    const { deps } = makeDeps({
      resolveMaxQueries: () => 10,
      loadCaptureQueries: async (limit: number) => {
        seenLimit = limit;
        return ['a'];
      },
    });
    await runNightlyContradictionProbe(deps);
    expect(seenLimit).toBe(10);
  });
});
