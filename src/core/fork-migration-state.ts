import type { BrainEngine } from './engine.ts';

export const UPSTREAM_SCHEMA_KEY = 'schema.upstream_version';
const LEGACY_UPSTREAM: Record<number, number> = {
  9000: 117, 9001: 117, 9002: 117, 9003: 119,
  9004: 122, 9005: 122, 9006: 122, 9007: 126,
};

/** Independently checkpoint upstream progress; never lower the deployed fork bookmark. */
export async function upstreamSchemaVersion(engine: BrainEngine, bookmark: number): Promise<number> {
  if (!Number.isSafeInteger(bookmark) || bookmark < 1) throw new Error('Invalid schema bookmark');
  if (bookmark < 9000) return bookmark;
  const stored = await engine.getConfig(UPSTREAM_SCHEMA_KEY);
  if (stored !== null && stored !== undefined) {
    const value = Number(stored);
    if (!/^\d+$/.test(stored) || !Number.isSafeInteger(value) || value < 1 || value >= 9000) {
      throw new Error('Invalid independent upstream schema bookmark');
    }
    return value;
  }
  const known = LEGACY_UPSTREAM[bookmark];
  if (known === undefined) throw new Error(`Unknown fork schema ${bookmark}; upstream migration history must be reconciled explicitly`);
  return known;
}
