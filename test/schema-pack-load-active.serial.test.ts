// v0.38 active-pack loader smoke tests (T-AP boundary helper).
//
// Covers: 7-tier resolution chain with config-driven inputs, tier-1
// trust gate (remote=true rejects per-call opt), gbrain-base loads from
// bundled path, custom pack via test-injected locator.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  loadActivePack,
  loadActivePackForEngine,
  resolveActivePackNameOnly,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
  _resetPackCacheForTests,
} from '../src/core/schema-pack/index.ts';
import { withEnv } from './helpers/with-env.ts';

describe('loadActivePack boundary helper', () => {
  beforeAll(() => {
    // Tests use the real bundled gbrain-base for tier-7 default; per-test
    // overrides via __setPackLocatorForTests when injecting synthetic packs.
  });
  afterAll(() => {
    _resetPackLocatorForTests();
    _resetPackCacheForTests();
  });

  test('default resolution loads gbrain-base from bundled path', async () => {
    _resetPackCacheForTests();
    const pack = await loadActivePack({ cfg: null, remote: false });
    expect(pack.manifest.name).toBe('gbrain-base');
    expect(pack.manifest.extends).toBeNull();
    expect(pack.manifest.page_types.length).toBeGreaterThan(0);
  });

  test('tier-1 per-call wins when remote=false', async () => {
    _resetPackCacheForTests();
    const result = resolveActivePackNameOnly({
      cfg: null,
      remote: false,
      perCall: 'custom-pack',
    });
    expect(result).toEqual({ pack_name: 'custom-pack', source: 'per-call' });
  });

  test('tier-1 per-call IGNORED when remote=true (D13 trust gate)', () => {
    const result = resolveActivePackNameOnly({
      cfg: { engine: 'pglite', schema_pack: 'config-pack' } as never,
      remote: true,
      perCall: 'malicious-pack',
    });
    // The resolver should land on config-pack (tier-6), not malicious-pack.
    expect(result.pack_name).toBe('config-pack');
    expect(result.source).toBe('home-config');
  });

  test('tier-2 env var GBRAIN_SCHEMA_PACK wins over tier-6 home config', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'env-pack' }, async () => {
      const result = resolveActivePackNameOnly({
        cfg: { engine: 'pglite', schema_pack: 'home-pack' } as never,
        remote: false,
      });
      expect(result.pack_name).toBe('env-pack');
      expect(result.source).toBe('env');
    });
  });

  test('tier-3 per-source DB config beats tier-4 brain-wide', () => {
    const result = resolveActivePackNameOnly({
      cfg: null,
      remote: false,
      sourceId: 'zion',
      perSourceDb: new Map([['zion', 'family-archive']]),
      dbConfig: 'main-pack',
    });
    expect(result.pack_name).toBe('family-archive');
    expect(result.source).toBe('per-source-db');
  });

  test('engine-aware resolver applies one source override and unset rolls back to global', async () => {
    _resetPackCacheForTests();
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-source-pack-'));
    const manifest = (name: string) => `api_version: gbrain-schema-pack-v1
name: ${name}
version: 0.1.0
description: test
extends: null
page_types: []
link_types: []
`;
    const globalPath = join(dir, 'global-pack.yaml');
    const sourcePath = join(dir, 'source-pack.yaml');
    writeFileSync(globalPath, manifest('global-pack'));
    writeFileSync(sourcePath, manifest('source-pack'));
    __setPackLocatorForTests((name) => {
      if (name === 'global-pack') return globalPath;
      if (name === 'source-pack') return sourcePath;
      return null;
    });
    const config = new Map<string, string>([
      ['schema_pack', 'global-pack'],
      ['schema_pack.source.wachines', 'source-pack'],
    ]);
    const engine = {
      getConfig: async (key: string) => config.get(key) ?? null,
    };

    try {
      const wachines = await loadActivePackForEngine({
        engine,
        cfg: null,
        remote: false,
        sourceId: 'wachines',
      });
      expect(wachines.pack.manifest.name).toBe('source-pack');
      expect(wachines.resolution.source).toBe('per-source-db');

      const perennia = await loadActivePackForEngine({
        engine,
        cfg: null,
        remote: false,
        sourceId: 'perennia',
      });
      expect(perennia.pack.manifest.name).toBe('global-pack');
      expect(perennia.resolution.source).toBe('db-config');

      config.delete('schema_pack.source.wachines');
      const rolledBack = await loadActivePackForEngine({
        engine,
        cfg: null,
        remote: false,
        sourceId: 'wachines',
      });
      expect(rolledBack.pack.manifest.name).toBe('global-pack');
      expect(rolledBack.resolution.source).toBe('db-config');
    } finally {
      _resetPackLocatorForTests();
      _resetPackCacheForTests();
    }
  });

  test('engine-aware resolver fails closed when a configured source pack is missing', async () => {
    _resetPackCacheForTests();
    __setPackLocatorForTests(() => null);
    const engine = {
      getConfig: async (key: string) => (
        key === 'schema_pack.source.wachines' ? 'missing-source-pack' : null
      ),
    };
    try {
      await expect(loadActivePackForEngine({
        engine,
        cfg: null,
        remote: false,
        sourceId: 'wachines',
      })).rejects.toThrow(/unknown schema pack: missing-source-pack/);
    } finally {
      _resetPackLocatorForTests();
      _resetPackCacheForTests();
    }
  });

  test('tier-7 default falls back to gbrain-base when nothing set', () => {
    const result = resolveActivePackNameOnly({ cfg: null, remote: false });
    expect(result.pack_name).toBe('gbrain-base');
    expect(result.source).toBe('default');
  });

  test('UnknownPackError when configured pack is missing from disk', async () => {
    _resetPackCacheForTests();
    // Inject locator that returns null for everything (simulates missing pack)
    __setPackLocatorForTests(() => null);
    try {
      await expect(loadActivePack({
        cfg: { engine: 'pglite', schema_pack: 'nonexistent' } as never,
        remote: false,
      })).rejects.toThrow(/unknown schema pack: nonexistent/);
    } finally {
      _resetPackLocatorForTests();
    }
  });

  test('injected locator overrides default disk path', async () => {
    _resetPackCacheForTests();
    // Build a minimal pack on the fly; write it to a temp file the
    // locator can return.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-test-pack-'));
    const yamlPath = join(dir, 'pack.yaml');
    writeFileSync(yamlPath, `api_version: gbrain-schema-pack-v1
name: injected-pack
version: 0.1.0
description: test
extends: null
page_types: []
link_types: []
`);

    __setPackLocatorForTests(name => name === 'injected-pack' ? yamlPath : null);
    try {
      const pack = await loadActivePack({
        cfg: { engine: 'pglite', schema_pack: 'injected-pack' } as never,
        remote: false,
      });
      expect(pack.manifest.name).toBe('injected-pack');
    } finally {
      _resetPackLocatorForTests();
    }
  });

  test('pack identity is stable across loads of same manifest', async () => {
    _resetPackCacheForTests();
    const pack1 = await loadActivePack({ cfg: null, remote: false });
    _resetPackCacheForTests();
    const pack2 = await loadActivePack({ cfg: null, remote: false });
    expect(pack1.identity).toBe(pack2.identity);
    expect(pack1.manifest_sha8).toBe(pack2.manifest_sha8);
    expect(pack1.alias_closure_hash).toBe(pack2.alias_closure_hash);
  });
});
