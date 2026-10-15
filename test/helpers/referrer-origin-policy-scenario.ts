import { beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { withTrustPromotion } from '../../src/core/persistence/context.ts';
import { readReferrerPage, readReferrerGroups } from '../../src/core/mentions/referrers.ts';

export function defineReferrerOriginPolicyTests(engineOf: () => BrainEngine) {
  let engine: BrainEngine;
  const context = (sources = ['default'], subjects = ['user:tech']): OperationContext => ({
    engine, remote: true, sourceId: 'default', dryRun: false, config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'synthetic', clientId: 'test', scopes: ['read'], allowedSources: sources, subjectIds: subjects },
  } as OperationContext);
  const call = (params: Record<string, unknown> = {}, sources?: string[], subjects?: string[]) =>
    operationsByName.get_backlinks.handler(context(sources, subjects), { slug: 'people/target', group: 'page', ...params }) as Promise<any>;
  async function page(slug: string, source = 'default') {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Synthetic reference.', timeline: '' }, { sourceId: source });
    return (await engine.getPage(slug, { sourceId: source }))!.id;
  }
  async function edge(from: number, target: number, origin: number | null) {
    await engine.executeRaw("INSERT INTO links(from_page_id,to_page_id,origin_page_id,link_type,link_source) VALUES($1,$2,$3,'mentions','markdown')", [from, target, origin]);
  }
  beforeEach(() => { engine = engineOf(); });
  describe('grouped referrer evidence policy', () => {
    for (const grouped of [false, true]) {
      test(`${grouped ? 'grouped' : 'paged'} content shares the authorization snapshot during a concurrent restriction`, async () => {
        const target = await page('people/target'), ref = await page('notes/ref');
        await edge(ref, target, null);
        const original = engine.executeRaw;
        const execute = original.bind(engine);
        const scope = { slug: 'people/target', sourceId: 'default', referrerSources: ['default'],
          aclSubjectIds: [], excludePrivate: true, pack: null, keepVisibility: ['world'] as ['world'] };
        let interleaved = false;
        engine.executeRaw = (async (sql, params, options) => {
          const rows = await execute(sql, params, options);
          if (!interleaved && sql.includes('typed AS MATERIALIZED') && rows.some(row => Number(row.id) === ref)) {
            interleaved = true;
            await execute('UPDATE pages SET acl_subject_ids=$2::text[],title=$3,compiled_truth=$4 WHERE id=$1',
              [ref, ['user:director'], 'Restricted replacement title', 'Restricted replacement text']);
          }
          return rows;
        }) as BrainEngine['executeRaw'];
        try {
          const result = grouped ? await readReferrerGroups(engine, scope) : await readReferrerPage(engine, scope, { limit: 10 });
          expect(interleaved).toBe(true);
          expect(JSON.stringify(result)).not.toContain('Restricted replacement');
          const rows = 'groups' in result ? result.groups.flatMap(group => group.rows) : result.rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ title: 'notes/ref', preview: 'Synthetic reference.' });
        } finally { engine.executeRaw = original; }
        expect((await readReferrerPage(engine, scope, { limit: 10 })).rows).toEqual([]);
        expect((await readReferrerGroups(engine, scope)).total).toBe(0);
      });
    }
    test('independent source grants apply before counts, type discovery and pagination', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other')");
      const target = await page('people/target');
      const publicRef = await page('notes/public');
      const foreignRef = await page('notes/foreign');
      const origin = await page('notes/evidence', 'other');
      await edge(publicRef, target, null);
      await edge(foreignRef, target, origin);
      const denied = await call({ limit: 1 });
      expect(denied).toMatchObject({ total: 1, truncated: false, cursor: null });
      expect(denied.rows.map((r: any) => r.slug)).toEqual(['notes/public']);
      const allowed = await call({ limit: 1 }, ['default', 'other']);
      expect(allowed).toMatchObject({ total: 2, truncated: true });
      const next = await call({ limit: 1, cursor: allowed.cursor }, ['default', 'other']);
      expect(next).toMatchObject({ total: 2, truncated: false, cursor: null });
      expect(new Set([...allowed.rows, ...next.rows].map((r: any) => r.slug)).size).toBe(2);
      expect(await call({ limit: 1 })).toEqual(denied);
      const card = await operationsByName.entity.handler(context(), { name: 'people/target' }) as any;
      expect(card.card.referenced_by_count).toBe(1);
      expect(card.card.referenced_by.flatMap((g: any) => g.rows).map((r: any) => r.slug)).toEqual(['notes/public']);
    });
    for (const archivedSource of ['other', 'targetsource']) {
      test(`archived ${archivedSource} hides manual null-origin links from every backlink view`, async () => {
        await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other'),('targetsource','Target source')");
        await page('people/target', 'targetsource');
        await page('notes/ref', 'other');
        await engine.addLink('notes/ref', 'people/target', 'Synthetic manual reference', 'mentions', 'manual',
          undefined, undefined, { fromSourceId: 'other', toSourceId: 'targetsource' });
        const sources = ['targetsource', 'other'];
        const ctx = { ...context(sources), sourceId: 'targetsource' };
        const paged = () => operationsByName.get_backlinks.handler(ctx, { slug: 'people/target', group: 'page', limit: 1 }) as Promise<any>;
        const ordinary = () => operationsByName.get_backlinks.handler(ctx, { slug: 'people/target' });
        const groups = () => readReferrerGroups(engine, { slug: 'people/target', sourceId: 'targetsource',
          referrerSources: sources, aclSubjectIds: ['user:tech'], excludePrivate: true, pack: null, keepVisibility: ['world'] });
        expect((await paged()).total).toBe(1);
        expect(await ordinary()).toHaveLength(1);
        expect((await groups()).total).toBe(1);
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archivedSource]);
        expect(await ordinary()).toEqual([]);
        expect(await paged()).toMatchObject({ rows: [], total: 0, truncated: false, cursor: null });
        expect(await groups()).toEqual({ total: 0, groups: [] });
        await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [archivedSource]);
        expect((await paged()).total).toBe(1);
        expect((await groups()).total).toBe(1);
      });
    }
    test('origin ACL, archival, deletion and quarantine revoke grouped evidence immediately', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other')");
      const target = await page('people/target'), ref = await page('notes/ref');
      const origin = await page('notes/evidence', 'other');
      await edge(ref, target, origin);
      const sources = ['default', 'other'];
      expect((await call({}, sources)).total).toBe(1);
      await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['user:director'], origin]);
      expect((await call({}, sources)).total).toBe(0);
      expect((await call({}, sources, ['user:director'])).total).toBe(1);
      await engine.executeRaw('UPDATE pages SET acl_subject_ids=NULL, deleted_at=now() WHERE id=$1', [origin]);
      expect((await call({}, sources)).total).toBe(0);
      await engine.executeRaw("UPDATE pages SET deleted_at=NULL, frontmatter='{\"quarantine\":true}'::jsonb WHERE id=$1", [origin]);
      expect((await call({}, sources)).total).toBe(0);
      await engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb WHERE id=$1", [origin]);
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='other'");
      expect((await call({}, sources)).total).toBe(0);
    });
    test('origin eligibility is checked independently of authorized endpoints', async () => {
      const target = await page('people/target'), ref = await page('notes/ref'), origin = await page('notes/evidence');
      await edge(ref, target, origin);
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () => tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE id=ANY($1::bigint[])", [[target, ref]])));
      await engine.executeRaw("UPDATE pages SET trust_tier='external_untrusted' WHERE id=$1", [origin]);
      expect((await call()).total).toBe(1);
      const scoped = await readReferrerPage(engine, { slug: 'people/target', sourceId: 'default',
        referrerSources: ['default'], aclSubjectIds: ['user:tech'], excludePrivate: true,
        pack: null, keepVisibility: ['world'], eligibility: { floor: 'operator_curated' } }, { limit: 10 });
      expect(scoped.total).toBe(0);
    });
  });
}
