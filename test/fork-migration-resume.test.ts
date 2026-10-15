import { v142 } from '../src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts';
import { v144 } from '../src/core/schema-migrations/v144-open-loops.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { UPSTREAM_SCHEMA_KEY, upstreamSchemaVersion } from '../src/core/fork-migration-state.ts';
import { LATEST_SCHEMA_VERSION, LATEST_UPSTREAM_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => engine.disconnect());
describe('independent fork migration cursor', () => {
  test('detects low-band work behind a current high-band bookmark and resumes a failed handler', async () => {
    const page = await engine.putPage('fixtures/migration', {type:'note',title:'Fixture',compiled_truth:'preserved'});
    await engine.setConfig('models.default', 'fixture-configured-model');
    await engine.setConfig(UPSTREAM_SCHEMA_KEY, String(LATEST_UPSTREAM_SCHEMA_VERSION-1));
    expect(await hasPendingMigrations(engine)).toBe(true);
    const original = engine.unsetConfig.bind(engine);
    let failed = false;
    engine.unsetConfig = async key => {
      if (key.includes('page_vector_bounded_timeline')) { failed = true; throw new Error('fixture interrupted handler'); }
      return original(key);
    };
    try { await expect(runMigrations(engine)).rejects.toThrow('fixture interrupted handler'); }
    finally { engine.unsetConfig = original; }
    expect(failed).toBe(true);
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect(await engine.getConfig(UPSTREAM_SCHEMA_KEY)).toBe(String(LATEST_UPSTREAM_SCHEMA_VERSION-1));
    expect((await runMigrations(engine)).applied).toBe(1);
    expect(await hasPendingMigrations(engine)).toBe(false);
    expect((await runMigrations(engine)).applied).toBe(0);
    expect((await engine.getPage(page.slug))?.content_hash).toBe(page.content_hash);
    expect(await engine.getConfig('models.default')).toBe('fixture-configured-model');
  });
  test('an upstream-only v245 ledger records its cursor before crossing into the fork band', async () => {
    await engine.setConfig('version',String(LATEST_UPSTREAM_SCHEMA_VERSION));
    await engine.unsetConfig(UPSTREAM_SCHEMA_KEY);
    const result=await runMigrations(engine);
    expect(result.applied).toBeGreaterThan(0);
    expect(await engine.getConfig(UPSTREAM_SCHEMA_KEY)).toBe(String(LATEST_UPSTREAM_SCHEMA_VERSION));
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  });
  test('refuses an incidental destructive take-vector resize on the fork', async () => {
    const page = await engine.putPage('fixtures/vector', {type:'note',title:'Vector',compiled_truth:'preserved take'});
    const [{ dimensions }] = await engine.executeRaw<{dimensions:number}>(
      "SELECT atttypmod AS dimensions FROM pg_attribute WHERE attrelid = 'takes'::regclass AND attname = 'embedding'",
    );
    const vector = '[' + Array.from({length:dimensions}, (_,i) => i === 0 ? 1 : 0).join(',') + ']';
    await engine.executeRaw(
      `INSERT INTO takes(page_id,row_num,claim,kind,holder,embedding,embedded_at)
       VALUES($1,1,'Preserved claim','fact','world',$2::vector,now())`, [page.id,vector],
    );
    const snapshot = () => engine.executeRaw('SELECT claim,embedding::text,embedded_at FROM takes WHERE page_id=$1',[page.id]);
    const before = await snapshot();
    const configBefore = await engine.getConfig('embedding_dimensions');
    await engine.setConfig('embedding_dimensions', String(dimensions === 1024 ? 1536 : 1024));
    try {
      for (const migration of [v142,v144]) {
        await expect(migration.handler!(engine)).rejects.toThrow('take embeddings would be cleared');
        expect(await snapshot()).toEqual(before);
      }
    } finally {
      if (configBefore === null) await engine.unsetConfig('embedding_dimensions');
      else await engine.setConfig('embedding_dimensions', configBefore);
    }
  });
  test('does not infer unknown high-band history or accept a malformed cursor', async () => {
    await engine.unsetConfig(UPSTREAM_SCHEMA_KEY);
    try {
      expect(await upstreamSchemaVersion(engine,9007)).toBe(126);
      await expect(upstreamSchemaVersion(engine,9999)).rejects.toThrow('Unknown fork schema');
      await engine.setConfig(UPSTREAM_SCHEMA_KEY,'245corrupt');
      expect(await hasPendingMigrations(engine)).toBe(true);
      await expect(runMigrations(engine)).rejects.toThrow('Invalid independent');
    } finally { await engine.setConfig(UPSTREAM_SCHEMA_KEY,String(LATEST_UPSTREAM_SCHEMA_VERSION)); }
  });
});

describe('take-vector resize transaction recovery', () => {
  let resizeEngine: PGLiteEngine;
  beforeAll(async () => {
    resizeEngine = new PGLiteEngine();
    await resizeEngine.connect({});
    await resizeEngine.initSchema();
    const page = await resizeEngine.putPage('fixtures/resize', { type: 'note', title: 'Resize', compiled_truth: 'Retained claim' });
    await resizeEngine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder)
      VALUES($1,1,'Retained claim','fact','world')`, [page.id]);
  });
  afterAll(async () => resizeEngine.disconnect());

  const shape = () => resizeEngine.executeRaw<{ shape: string }>(
    `SELECT format_type(atttypid,atttypmod) AS shape FROM pg_attribute
      WHERE attrelid='takes'::regclass AND attname='embedding' AND NOT attisdropped`);
  const index = () => resizeEngine.executeRaw<{ oid: string; definition: string }>(
    `SELECT oid::text AS oid,pg_get_indexdef(oid) AS definition FROM pg_class
      WHERE oid=to_regclass('public.idx_takes_embedding_hnsw')`);
  const rows = () => resizeEngine.executeRaw('SELECT claim,embedding::text,embedded_at FROM takes ORDER BY id');
  async function reset() {
    await resizeEngine.executeRaw('DROP INDEX IF EXISTS idx_takes_embedding_hnsw');
    await resizeEngine.executeRaw('ALTER TABLE takes DROP COLUMN IF EXISTS embedding');
    await resizeEngine.executeRaw('ALTER TABLE takes ADD COLUMN embedding vector(8)');
    await resizeEngine.executeRaw('UPDATE takes SET embedded_at=now()');
    await resizeEngine.setConfig('embedding_dimensions', '8');
    await v142.handler!(resizeEngine);
  }

  for (const migration of [v142, v144]) {
    test(`v${migration.version} rolls back a failure after dropping the column and then resumes`, async () => {
      await reset();
      const beforeRows = await rows();
      const beforeIndex = await index();
      expect(beforeIndex).toHaveLength(1);
      await resizeEngine.setConfig('embedding_dimensions', '16');
      const original = resizeEngine.executeRaw;
      let dropped = false;
      resizeEngine.executeRaw = async function<T = Record<string, unknown>>(
        sql: string, params?: unknown[], opts?: Parameters<PGLiteEngine['executeRaw']>[2],
      ): Promise<T[]> {
        const result = await original.call(this, sql, params, opts) as T[];
        if (sql === 'ALTER TABLE takes DROP COLUMN IF EXISTS embedding') {
          dropped = true;
          throw new Error('fixture failure after column drop');
        }
        return result;
      };
      try {
        await expect(migration.handler!(resizeEngine)).rejects.toThrow('fixture failure after column drop');
      } finally { resizeEngine.executeRaw = original; }
      expect(dropped).toBe(true);
      expect(await shape()).toEqual([{ shape: 'vector(8)' }]);
      expect(await index()).toEqual(beforeIndex);
      expect(await rows()).toEqual(beforeRows);
      await migration.handler!(resizeEngine);
      expect(await shape()).toEqual([{ shape: 'vector(16)' }]);
      expect(await index()).toHaveLength(1);
      expect(await rows()).toEqual([{ claim: 'Retained claim', embedding: null, embedded_at: null }]);
      const repairedIndex = await index();
      await migration.handler!(resizeEngine);
      expect(await index()).toEqual(repairedIndex);
    });

    test(`v${migration.version} repairs an already missing column`, async () => {
      await reset();
      await resizeEngine.executeRaw('ALTER TABLE takes DROP COLUMN embedding');
      await resizeEngine.setConfig('embedding_dimensions', '16');
      await migration.handler!(resizeEngine);
      expect(await shape()).toEqual([{ shape: 'vector(16)' }]);
      expect(await index()).toHaveLength(1);
      expect(await rows()).toEqual([{ claim: 'Retained claim', embedding: null, embedded_at: null }]);
      const repairedIndex = await index();
      await migration.handler!(resizeEngine);
      expect(await index()).toEqual(repairedIndex);
    });

    test(`v${migration.version} repairs a missing index without clearing vectors or timestamps`, async () => {
      await reset();
      await resizeEngine.executeRaw(`UPDATE takes SET embedding='[1,0,0,0,0,0,0,0]'::vector, embedded_at=now()`);
      await resizeEngine.executeRaw('DROP INDEX idx_takes_embedding_hnsw');
      const before = await rows();
      await migration.handler!(resizeEngine);
      expect(await shape()).toEqual([{ shape: 'vector(8)' }]);
      const repairedIndex = await index();
      expect(repairedIndex).toHaveLength(1);
      expect(repairedIndex[0]?.definition).toContain('vector_cosine_ops');
      expect(await rows()).toEqual(before);
      await migration.handler!(resizeEngine);
      expect(await index()).toEqual(repairedIndex);
      expect(await rows()).toEqual(before);
    });
  }
});
