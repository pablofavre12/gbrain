/** Reader coverage cannot disclose another reader's unindexed pages or maintenance history. */
import { beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { readMentionCoverage } from '../../src/core/mentions/coverage.ts';
import { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION } from '../../src/core/mentions/pass.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';

export function defineMentionCoverageAclTests(engineOf: () => BrainEngine) {
  let engine: BrainEngine;
  const scope = (subjects = ['user:tech'], sourceIds = ['default']) => ({ aclSubjectIds: subjects, sourceIds, excludePrivate: true });
  const context = (subjects = ['user:tech']): OperationContext => ({ engine, config: { engine: 'pglite' }, remote: true,
    dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'synthetic', clientId: 'test', scopes: ['read'], subjectIds: subjects, allowedSources: ['default'] },
  } as OperationContext);
  async function page(slug: string, type = 'note', sourceId = 'default', subjects: string[] | null = null) {
    await operationsByName.put_page!.handler({ ...context(), remote: false, auth: undefined, sourceId },
      { slug, content: `---\ntype: ${type}\ntitle: ${slug}\n---\n\nSynthetic mention evidence.` });
    const id = (await engine.getPage(slug, { sourceId }))!.id;
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [subjects, id]);
    return id;
  }
  async function scanned(id: number) {
    await engine.executeRaw(`INSERT INTO page_mention_state
      (page_id,source_id,mention_revision,mention_version,mentions_scanned_at,alias_revision,alias_version,aliases_refreshed_at)
      SELECT id,source_id,knowledge_revision,$2,'2024-01-01',knowledge_revision,$3,'2024-01-01' FROM pages WHERE id=$1
      ON CONFLICT(page_id) DO UPDATE SET mention_revision=EXCLUDED.mention_revision, mention_version=EXCLUDED.mention_version,
        alias_revision=EXCLUDED.alias_revision, alias_version=EXCLUDED.alias_version`,
    [id, MENTION_EXTRACTOR_VERSION, ALIAS_DERIVATION_VERSION]);
  }
  const read = (subjects?: string[]) => readMentionCoverage(engine, ['default'], scope(subjects));
  beforeEach(() => { engine = engineOf(); });

  test('hidden pages, global failure/count/date changes and version mismatch cannot affect reader coverage or mutate cache', async () => {
    const publicId = await page('people/alice-example', 'person');
    await scanned(publicId);
    const baseline = await read();
    expect(baseline).toEqual({ state: 'complete', pending_pages: 0, last_pass_at: null });
    const hidden = await page('notes/secret', 'note', 'default', ['user:director']);
    await engine.executeRaw(`INSERT INTO mention_index_status(source_id,state,pending,last_pass_at,policy_fingerprint)
      VALUES('default','failed',987,'2030-01-01','old-binary')
      ON CONFLICT(source_id) DO UPDATE SET state='failed',pending=987,last_pass_at='2030-01-01',policy_fingerprint='old-binary'`);
    const stored = await engine.executeRaw('SELECT * FROM mention_index_status ORDER BY source_id');
    expect(await read()).toEqual(baseline);
    expect(await engine.executeRaw('SELECT * FROM mention_index_status ORDER BY source_id')).toEqual(stored);
    expect(await read(['user:director'])).toEqual({ state: 'pending', pending_pages: 1, last_pass_at: null, degraded: true });
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2', [['user:other'], hidden]);
    expect(await read(['user:director'])).toEqual(baseline);
    // The actual backlink and card paths carry the policy, including miss coverage.
    const backlinks = await operationsByName.get_backlinks!.handler(context(), { slug: 'people/alice-example', group: 'page' }) as any;
    expect(backlinks.coverage).toEqual(baseline);
    const card = await buildEntityCard(engine, 'default', 'people/alice-example', { remote: true, aclSubjectIds: ['user:tech'], includeReferences: true });
    expect(card.card?.coverage).toEqual(baseline);
    const miss = await buildEntityCard(engine, 'default', 'unmatched-entity-example', { remote: true, aclSubjectIds: ['user:tech'], includeReferences: true });
    expect(miss.coverage).toEqual(baseline);
  });

  test('visible due pages and alias versions count exactly once and clear after scan', async () => {
    const a = await page('people/alice-example', 'person');
    const b = await page('notes/public');
    expect(await read()).toMatchObject({ state: 'pending', pending_pages: 2 });
    await scanned(a); await scanned(b);
    await engine.executeRaw('UPDATE page_mention_state SET alias_version=$1 WHERE page_id=$2', [ALIAS_DERIVATION_VERSION - 1, a]);
    expect(await read()).toMatchObject({ state: 'pending', pending_pages: 1 });
    await engine.executeRaw('UPDATE page_mention_state SET mention_version=$1 WHERE page_id=$2', [MENTION_EXTRACTOR_VERSION - 1, a]);
    expect(await read()).toMatchObject({ state: 'pending', pending_pages: 1 });
    await scanned(a);
    expect(await read()).toMatchObject({ state: 'complete', pending_pages: 0 });
  });

  test('source grants, liveness and private visibility apply before due counts', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other')");
    await page('notes/other', 'note', 'other');
    const hidden = await page('notes/private');
    await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter || '{"visibility":"private"}'::jsonb WHERE id=$1`, [hidden]);
    expect(await readMentionCoverage(engine, ['default', 'other'], scope())).toMatchObject({ pending_pages: 0, state: 'complete' });
    expect(await readMentionCoverage(engine, ['default', 'other'], scope(undefined, ['default', 'other']))).toMatchObject({ pending_pages: 1 });
    await engine.executeRaw("UPDATE sources SET archived=true WHERE id='other'");
    expect(await readMentionCoverage(engine, ['default', 'other'], scope(undefined, ['default', 'other']))).toMatchObject({ pending_pages: 0 });
  });

  test('disabled scoped coverage exposes no global pass timestamp and performs no cache repair', async () => {
    await page('notes/public');
    await engine.executeRaw(`INSERT INTO mention_index_status(source_id,state,pending,last_pass_at,policy_fingerprint)
      VALUES('default','complete',0,'2030-01-01','old-binary')`);
    await engine.setConfig('mentions.auto_link', 'false');
    const stored = await engine.executeRaw('SELECT * FROM mention_index_status');
    expect(await read()).toEqual({ state: 'disabled', pending_pages: 0, last_pass_at: null, degraded: true });
    expect(await engine.executeRaw('SELECT * FROM mention_index_status')).toEqual(stored);
  });
}
