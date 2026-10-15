import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { refreshRelationships } from '../../src/core/link-relationships.ts';
import { primeRelationSemantics } from '../../src/core/link-semantics-pack.ts';
import { relationSemantics, relationshipFilterSql, setPackRelationSemantics, temporalLinkJoinSql, type TemporalAnnotation } from '../../src/core/link-validity.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import type { Link } from '../../src/core/types.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../../src/core/schema-pack/bundled-assets.ts';

const declarations = [
  ['reports_to', 'state'], ['promoted', 'event'], ['founded', 'state'], ['works_at', 'event'],
] as const;

export function defineColdTemporalSemanticsTests(engineOf: () => BrainEngine): void {
  let engine: BrainEngine;
  let root: string;
  let from: number, to: number, hidden: number;
  const fromSlug = 'people/cold-reader';
  const pack = { api_version: 'gbrain-schema-pack-v1', name: 'cold-semantics-fixture', version: '1.0.0', extends: 'gbrain-base',
    page_types: [], frontmatter_links: [], link_types: declarations.map(([name, temporal]) => ({ name, temporal })) };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-cold-semantics-'));
    writeFileSync(join(root, 'pack.json'), JSON.stringify(pack));
    __setPackLocatorForTests(name => name === pack.name ? join(root, 'pack.json') : bundledPackPath(name));
    _resetPackCacheForTests();
  });
  afterAll(() => {
    setPackRelationSemantics(new Map());
    _resetPackLocatorForTests();
    _resetPackCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    engine = engineOf();
    await engine.setConfig('schema_pack', pack.name);
    const ids: number[] = [];
    for (const slug of [fromSlug, 'people/cold-target', 'notes/cold-private']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Synthetic evidence.', timeline: '', frontmatter: {} });
      ids.push((await engine.getPage(slug, { sourceId: 'default' }))!.id);
    }
    [from, to, hidden] = ids;
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['reader:allowed'], hidden]);
  });

  async function seed(type: string, semantics: 'state' | 'event', hiddenOnly = false) {
    await primeRelationSemantics(engine);
    expect(relationSemantics(type)).toBe(semantics);
    const origin = hiddenOnly ? hidden : from;
    await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source,origin_page_id)
      VALUES($1,$2,$3,'cold-fixture',$4)`, [from, to, type, origin]);
    for (const [kind, date, page] of [
      ['start', '2020-01-01', origin], ['end', '2023-01-01', origin],
      ['start', semantics === 'state' ? '2024-01-01' : '2010-01-01', hidden],
    ]) {
      await engine.executeRaw(`INSERT INTO link_transitions(source_id,from_page_id,to_page_id,link_type,kind,occurred_on,producer,origin_page_id)
        VALUES('default',$1,$2,$3,$4,$5::date,'timeline',$6)`, [from, to, type, kind, date, page]);
    }
    await refreshRelationships(engine, [{ from_page_id: from, to_page_id: to, link_type: type }]);
    // Force the true cold-reader condition after all writers have finished.
    setPackRelationSemantics(new Map());
    // Shared aggregate history must never supply a restricted reader's dates.
    await engine.executeRaw(`UPDATE link_relationships SET recorded_at='1900-01-01',retired_at='1901-01-01',
      valid_ranges='{[1900-01-01,1901-01-01)}'::datemultirange,status_now='ended' WHERE from_page_id=$1`, [from]);
  }

  describe('cold readers use persisted temporal semantics with authorized evidence', () => {
    for (const [type, semantics] of declarations) {
      test(`${type} retains its ${semantics} declaration without a primed process registry`, async () => {
        await seed(type, semantics);
        const read = async (subjects: string[], params: Record<string, unknown> = { status: 'all' }) => {
          const ctx = { engine, config: { engine: engine.kind }, dryRun: false, remote: true, sourceId: 'default',
            logger: { info() {}, warn() {}, error() {} },
            auth: { token: 'synthetic', clientId: 'test', scopes: ['read'], subjectIds: subjects, allowedSources: ['default'] },
          } as OperationContext;
          return await operations.find(op => op.name === 'get_links')!.handler(ctx, { slug: fromSlug, ...params }) as Array<Link & TemporalAnnotation>;
        };
        const visible = await read([]);
        expect(visible).toHaveLength(1);
        expect(visible[0].status).toBe(semantics === 'state' ? 'ended' : 'event');
        expect(visible[0].stints).toEqual([{ from: '2020-01-01', until: semantics === 'state' ? '2023-01-01' : null }]);
        expect(visible[0].recorded_at).not.toStartWith('1900');
        expect(visible[0].retired_at ?? '').not.toStartWith('1901');
        const allowed = await read(['reader:allowed']);
        expect(allowed[0].status).toBe(semantics === 'state' ? 'live' : 'event');
        expect(allowed[0].stints).toEqual(semantics === 'state'
          ? [{ from: '2020-01-01', until: '2023-01-01' }, { from: '2024-01-01', until: null }]
          : [{ from: '2010-01-01', until: null }]);
        expect(await engine.getLinks(fromSlug, { sourceId: 'default', temporal: { status: 'all' } })).toMatchObject(allowed);
        // A registry primed by another brain cannot override persisted metadata.
        setPackRelationSemantics(new Map([[type, semantics === 'state' ? 'event' : 'state']]));
        expect(await read([])).toEqual(visible);
        setPackRelationSemantics(new Map());
        const when = { status: 'live', as_of: semantics === 'state' ? '2025-01-01' : '2015-01-01' };
        expect(await read([], when)).toHaveLength(0);
        expect(await read(['reader:allowed'], when)).toHaveLength(1);
        const filtered = (subjects: string[]) => {
          const params: unknown[] = [from];
          const filter = relationshipFilterSql('l', { sourceId: 'default', aclSubjectIds: subjects, asOf: when.as_of }, params);
          return engine.executeRaw(`SELECT l.id FROM links l WHERE l.from_page_id=$1 AND ${filter}`, params);
        };
        expect(await filtered([])).toHaveLength(0);
        expect(await filtered(['reader:allowed'])).toHaveLength(1);
        // Revocation changes the result immediately, with no projection refresh.
        await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['reader:other'], hidden]);
        expect(await read(['reader:allowed'])).toEqual(visible);
      });
    }

    test('stored semantics do not create state when every evidence origin is hidden', async () => {
      await seed('reports_to', 'state', true);
      const params: unknown[] = [from];
      const join = temporalLinkJoinSql('l', { sourceId: 'default', aclSubjectIds: [] }, params);
      const rows = await engine.executeRaw<{ semantics: string | null }>(
        `SELECT lr_t.semantics FROM links l ${join} WHERE l.from_page_id=$1`, params);
      expect(rows).toEqual([{ semantics: null }]);
      expect(await engine.getLinks(fromSlug, { sourceId: 'default', aclSubjectIds: [], temporal: { status: 'all' } })).toEqual([]);
    });
  });
}
