/** Metadata is an aggregate of authorized graph evidence, never a global side channel. */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { withTrustPromotion } from '../../src/core/persistence/context.ts';
import { listWantedPages } from '../../src/core/wanted-links-store.ts';

export function defineGraphMetadataAclTests(engineOf: () => BrainEngine) {
  let engine: BrainEngine;
  const context = (subjects = ['user:tech'], sources = ['default']): OperationContext => ({
    engine, config: { engine: 'pglite' }, remote: true, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'synthetic', clientId: 'test', scopes: ['read'], subjectIds: subjects, allowedSources: sources },
  } as OperationContext);
  const call = (name: string, params = {}, subjects?: string[], sources?: string[]) =>
    operationsByName[name]!.handler(context(subjects, sources), params) as Promise<any>;
  async function page(slug: string, acl: string[] | null = null, source = 'default') {
    await operationsByName.put_page!.handler({ ...context(), auth: undefined, remote: false, sourceId: source }, {
      slug, content: `---\ntype: note\ntitle: ${slug}\n---\n\nSynthetic graph evidence.`,
    });
    const row = (await engine.getPage(slug, { sourceId: source }))!;
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [acl, row.id]);
    return row.id;
  }
  async function wanted(id: number, target: string, kind = 'slug', date = '2024-01-01', targetSource = 'default') {
    await engine.executeRaw(`INSERT INTO wanted_links
      (origin_page_id, source_id, producer, ref_kind, target_source_id, target_ref, link_type, first_seen_at, checked_at)
      SELECT id, source_id, 'body', $2, $3, $4, 'mentions', $5::timestamptz, $5::timestamptz FROM pages WHERE id=$1`,
    [id, kind, targetSource, target, date]);
    // This aggregate-level fixture retains authored evidence as the real writer does;
    // canonical extraction lifecycle coverage lives in wanted-acl-lifecycle-scenario.ts.
    await engine.executeRaw(`UPDATE authored_link_inventories SET checked_at=$5::timestamptz,
      refs=refs || jsonb_build_array(jsonb_build_object('producer','body','ref_kind',$2::text,
        'target_source_id',$3::text,'target_ref',$4::text,'link_type','mentions','resolved_targets','[]'::jsonb,'first_seen_at',$5::text))
      WHERE origin_page_id=$1`, [id, kind, targetSource, target, date]);
  }
  async function edge(from: number, to: number, origin: number | null, provenance = 'manual') {
    await engine.executeRaw(`INSERT INTO links (from_page_id,to_page_id,origin_page_id,link_source,link_type)
      VALUES ($1,$2,$3,$4,'mentions')`, [from, to, origin, provenance]);
  }
  beforeEach(() => { engine = engineOf(); });
  describe('graph metadata read policy', () => {
    test('wanted counts, dates, samples and pagination ignore denied origins; revocation is immediate', async () => {
      const publicId = await page('notes/public');
      const secretId = await page('notes/secret', ['user:director']);
      await wanted(publicId, 'people/shared-example');
      await wanted(secretId, 'people/shared-example', 'slug', '2025-01-01');
      await wanted(secretId, 'people/classified-example');
      const denied = await call('wanted_pages', { limit: 1 });
      expect(denied).toMatchObject({ total: 1, next_offset: null, targets: [{ target: 'people/shared-example',
        referenced_by: 1, sample_origins: [{ slug: 'notes/public', source_id: 'default' }],
        first_seen: '2024-01-01T00:00:00.000Z', last_checked: '2024-01-01T00:00:00.000Z' }] });
      expect(await call('wanted_pages', { count_only: true })).toMatchObject({ total: 1, targets: [] });
      expect(await call('wanted_pages', { offset: 1 })).toMatchObject({ total: 1, targets: [] });
      expect(await call('wanted_pages', { limit: 1 }, ['user:director'])).toMatchObject({ total: 2, next_offset: 1,
        targets: [{ target: 'people/shared-example', referenced_by: 2 }] });
      await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['user:other'], secretId]);
      expect(await call('wanted_pages', {}, ['user:director'])).toEqual(await call('wanted_pages'));
    });
    test('hidden destinations neither suppress wanted rows nor appear as basename suggestions', async () => {
      const origin = await page('notes/public');
      await wanted(origin, 'people/hidden-example');
      await wanted(origin, 'example', 'name');
      await page('people/hidden-example', ['user:director']);
      await page('people/example', ['user:director']);
      await page('companies/example');
      const denied = await call('wanted_pages');
      expect(denied.total).toBe(2);
      expect(denied.targets.find((r: any) => r.target === 'example').existing_matches).toEqual([
        { slug: 'companies/example', source_id: 'default' },
      ]);
      const allowed = await call('wanted_pages', {}, ['user:director']);
      expect(allowed.total).toBe(1);
      expect(allowed.targets[0].existing_matches).toHaveLength(2);
    });
    test('link provenance checks both endpoints and independent origins before counting', async () => {
      const a = await page('notes/a'), b = await page('notes/b');
      const secret = await page('notes/secret', ['user:director']);
      await edge(a, b, null);
      await edge(secret, b, secret, 'classified-source');
      await edge(a, secret, null, 'classified-target');
      await edge(a, b, secret, 'classified-origin');
      expect(await call('list_link_sources')).toEqual([{ link_source: 'manual', count: 1 }]);
      expect(await call('list_link_sources', {}, ['user:director'])).toHaveLength(4);
      await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['user:other'], secret]);
      expect(await call('list_link_sources', {}, ['user:director'])).toEqual([{ link_source: 'manual', count: 1 }]);
      expect(await engine.listLinkSources({ sourceId: 'default' })).toHaveLength(4);
    });
    test('federated origin and endpoint grants constrain both metadata operations', async () => {
      await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other','Other')");
      const a = await page('notes/a'), b = await page('notes/b');
      const foreign = await page('notes/foreign', null, 'other');
      await edge(a, b, foreign, 'foreign-origin');
      await edge(a, foreign, null, 'foreign-target');
      await edge(foreign, b, null, 'foreign-from');
      await wanted(foreign, 'people/foreign-example', 'slug', '2024-01-01', 'other');
      expect(await call('list_link_sources')).toEqual([]);
      expect(await call('wanted_pages')).toMatchObject({ total: 0 });
      expect(await call('list_link_sources', {}, undefined, ['default', 'other'])).toHaveLength(3);
      expect(await call('wanted_pages', {}, undefined, ['default', 'other'])).toMatchObject({ total: 1 });
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='other'");
      expect(await call('list_link_sources', {}, undefined, ['default', 'other'])).toEqual([]);
      expect(await call('wanted_pages', {}, undefined, ['default', 'other'])).toMatchObject({ total: 0 });
    });
    test('private, deleted, quarantined and low trust pages cannot influence authorized metadata', async () => {
      const a = await page('notes/a'), b = await page('notes/b'), origin = await page('notes/origin');
      await edge(a, b, origin);
      await wanted(origin, 'people/example');
      const policy = { sourceIds: ['default'], aclSubjectIds: ['user:tech'], excludePrivate: true };
      for (const mutation of [
        "frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb",
        "frontmatter = '{}'::jsonb, deleted_at = now()",
        "deleted_at = NULL, frontmatter = '{\"quarantine\":true}'::jsonb",
      ]) {
        await engine.executeRaw(`UPDATE pages SET ${mutation} WHERE id=$1`, [origin]);
        expect(await engine.listLinkSources(policy)).toEqual([]);
        expect(await listWantedPages(engine, { ...policy, limit: 10, offset: 0 })).toEqual({ total: 0, rows: [] });
      }
      await engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb, trust_tier='external_untrusted' WHERE id=$1", [origin]);
      const trusted = { ...policy, minTrust: 'operator_curated' as const };
      // Raise endpoints so only the independent origin controls exclusion.
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () => tx.executeRaw("UPDATE pages SET trust_tier='operator_curated' WHERE id=ANY($1::bigint[])", [[a, b]])));
      expect(await engine.listLinkSources(trusted)).toEqual([]);
      expect(await listWantedPages(engine, { ...trusted, limit: 10, offset: 0 })).toEqual({ total: 0, rows: [] });
    });
  });
}
