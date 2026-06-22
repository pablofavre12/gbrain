/**
 * Fork-band migration convention + upstream v118/v119 reconciliation.
 *
 * This is a FORK of garrytan/gbrain. To stop the fork and upstream from minting
 * the same integer version with different SQL (which the high-water-mark runner
 * resolves by SILENTLY skipping the loser on already-migrated brains), fork-local
 * migrations live in a reserved high band (>= FORK_MIGRATION_BASE) while the
 * shared low range stays byte-identical to upstream.
 *
 * The fork previously overwrote upstream's v118
 * (page_generation_clock_sequence_swap) and v119
 * (op_checkpoints_completed_keys_array_check) with its own federated_write
 * migrations. Those moved to the band; the upstream pair is restored at 118/119;
 * and a catch-up at the top of the band re-applies the pair (idempotently) so
 * brains that already passed bookmark 119 get healed.
 *
 * These tests pin all of that. Schema assertions run against in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FORK_BAND_START = 9000;

// Migrations the fork owns (everything in the band today). Keep in sync with
// migrate.ts; the band check below also enforces "nothing else is >= 9000".
const FORK_LOCAL_NAMES = new Set([
  'oauth_clients_federated_write_column',
  'oauth_clients_federated_write_gin_index',
  'write_attribution_columns',
  'reconcile_forked_118_119',
]);

describe('fork-band migration convention', () => {
  test('every migration version is unique (no fork/upstream collision)', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  test('fork-local migrations live in the reserved band; everything else is below it', () => {
    for (const m of MIGRATIONS) {
      if (m.version >= FORK_BAND_START) {
        // Anything in the band MUST be a known fork-local migration. A stray
        // upstream migration up here would mean the band got polluted.
        expect(FORK_LOCAL_NAMES.has(m.name)).toBe(true);
      } else {
        // Anything below the band MUST NOT be a fork-local migration. A
        // fork migration down here is the collision bug class this convention
        // exists to prevent.
        expect(FORK_LOCAL_NAMES.has(m.name)).toBe(false);
      }
    }
  });

  test('upstream v118/v119 are restored verbatim by name (shared low range matches upstream)', () => {
    const v118 = MIGRATIONS.find((m) => m.version === 118);
    const v119 = MIGRATIONS.find((m) => m.version === 119);
    expect(v118?.name).toBe('page_generation_clock_sequence_swap');
    expect(v119?.name).toBe('op_checkpoints_completed_keys_array_check');
  });

  test('catch-up migration sits above bookmark 119 so collision-victim brains re-run it', () => {
    const catchup = MIGRATIONS.find((m) => m.name === 'reconcile_forked_118_119')!;
    expect(catchup.version).toBeGreaterThan(119);
  });
});

describe('schema is healed after running all migrations (PGLite fresh init)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('upstream v118 ran: page_generation_clock_seq exists', async () => {
    const rows = (await engine.executeRaw(
      `SELECT 1 AS ok FROM pg_class WHERE relkind = 'S' AND relname = 'page_generation_clock_seq'`,
      [],
    )) as Array<{ ok: number }>;
    expect(rows.length).toBe(1);
  });

  test('upstream v119 ran: op_checkpoints array CHECK constraint exists', async () => {
    const rows = (await engine.executeRaw(
      `SELECT 1 AS ok FROM pg_constraint WHERE conname = 'op_checkpoints_completed_keys_array'`,
      [],
    )) as Array<{ ok: number }>;
    expect(rows.length).toBe(1);
  });

  test('fork attribution columns exist on pages and ingest_log', async () => {
    const rows = (await engine.executeRaw(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name IN ('last_write_client_id', 'last_write_client_name')
          AND table_name IN ('pages', 'ingest_log')`,
      [],
    )) as Array<{ table_name: string; column_name: string }>;
    // 2 columns x 2 tables = 4 rows
    expect(rows.length).toBe(4);
  });
});
