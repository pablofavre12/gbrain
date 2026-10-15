/** Canonical writes + normal extraction, including globally resolved references. */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { managedBrain } from './managed-brain.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { extractStaleFromDB, runExtract } from '../../src/commands/extract.ts';
import { isolatedSharedSkillsEngine } from './shared-skills-engine.ts';
import { publishAuthoredLinkInventory } from '../../src/core/authored-link-publication.ts';
import { listWantedPages } from '../../src/core/wanted-links-store.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';
import { v9010 } from '../../src/core/schema-migrations/v9010-authored-link-inventories.ts';

export async function wantedAclLifecycle(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const put = (slug: string, body: string, frontmatter = '', title = slug) => submitPageMutation(ctx, { operation: 'put_page', params: {
      slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${title}\n${frontmatter}---\n\n${body}\n`,
    } });
    const read = (subject = 'user:tech') => operationsByName.wanted_pages!.handler({ ...ctx, remote: true,
      auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], subjectIds: [subject], allowedSources: ['default'] } }, {}) as Promise<any>;
    const extract = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true, includeFrontmatter: true });
    const restrict = (slug: string, subjects: string[] | null) => engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE source_id=$2 AND slug=$3', [subjects, 'default', slug]);

    // Both direct body references and raw frontmatter names retain their authored identity.
    await put('notes/origin', 'See [[notes/hidden-target]].', 'sources: ["[[notes/hidden-target]]"]\n');
    await extract();
    const baseline = await read();
    expect(baseline).toMatchObject({ total: 1, targets: [{ target: 'notes/hidden-target', referenced_by: 1 }] });
    await put('notes/hidden-target', 'Restricted content');
    await restrict('notes/hidden-target', ['user:director']);
    expect(await read()).toEqual(baseline);
    await extract();
    expect(await read()).toEqual(baseline);
    expect(await engine.executeRaw('SELECT target_ref FROM wanted_links')).toEqual([]);
    expect(await read('user:director')).toMatchObject({ total: 0 });
    await restrict('notes/hidden-target', null);
    expect(await read()).toMatchObject({ total: 0 });
    await restrict('notes/hidden-target', ['user:director']);
    expect(await read()).toEqual(baseline);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    await extract();
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    expect(await read()).toEqual(baseline);

    // The target predates the first extraction: no unresolved queue row ever existed.
    await put('notes/second', 'See [[notes/hidden-target]].', 'sources: ["[[notes/hidden-target]]"]\n');
    await extract();
    expect(await read()).toMatchObject({ total: 1, targets: [{ target: 'notes/hidden-target', referenced_by: 2 }] });
    const inventories = await engine.executeRaw<{ refs: Array<{ producer: string }> }>(`SELECT i.refs FROM authored_link_inventories i
      JOIN pages p ON p.id=i.origin_page_id WHERE p.slug='notes/second'`);
    expect(inventories[0]!.refs.map(r => r.producer).sort()).toEqual(['body', 'frontmatter']);
    expect(await read('user:director')).toMatchObject({ total: 0 });

    // A resolved frontmatter display name must retain the name, not fabricate its canonical slug.
    await put('media/hidden-reference', 'Restricted named reference');
    await restrict('media/hidden-reference', ['user:director']);
    await put('notes/fm-name', '', 'sources: ["hidden-reference"]\n');
    await extract();
    expect((await read()).targets.some((r: any) => r.target === 'hidden-reference')).toBe(true);
    expect(await read('user:director')).toMatchObject({ total: 0 });

    // A hidden homonym must not defeat the unique visible basename, even when
    // the global fuzzy resolver would prefer the hidden exact title.
    await engine.setConfig('link_resolution.global_basename', 'true');
    await put('notes/reader-homonym', '', '', 'Unrelated visible caption');
    await put('notes/homonym-origin', 'See [[Reader Homonym]].', 'related: ["Reader Homonym"]\n');
    await extract();
    const beforeHomonym = await read();
    expect(beforeHomonym.targets.some((r: any) => r.target === 'reader-homonym')).toBe(false);
    await put('archive/reader-homonym', '', '', 'Reader Homonym');
    await restrict('archive/reader-homonym', ['user:director']);
    await engine.executeRaw("UPDATE pages SET links_extracted_at='2026-10-08' WHERE slug='notes/homonym-origin'");
    await extract();
    expect(await read()).toEqual(beforeHomonym);
    await restrict('notes/reader-homonym', ['user:director']);
    const deniedHomonyms = await read();
    expect(deniedHomonyms.targets.some((r: any) => r.target === 'reader-homonym')).toBe(true);
    await engine.executeRaw("UPDATE pages SET links_extracted_at='2026-10-08' WHERE slug='notes/homonym-origin'");
    await extract();
    expect(await read()).toEqual(deniedHomonyms);
    await restrict('notes/reader-homonym', null);
    expect(await read()).toEqual(beforeHomonym);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);

    // Disabling the healing queue does not certify a false empty inventory.
    await engine.setConfig('wanted_pages.enabled', 'false');
    await put('notes/feature-disabled-origin', 'See [[notes/disabled-missing]].');
    await extract();
    await engine.setConfig('wanted_pages.enabled', 'true');
    expect((await read()).targets.some((r: any) => r.target === 'notes/disabled-missing')).toBe(true);

    // A legacy brain has no inventory: refuse rather than claim all links resolved.
    await engine.executeRaw('DELETE FROM authored_link_inventories');
    await expect(read()).rejects.toMatchObject({ code: 'projection_pending' });
    await engine.executeRaw('DO $replay$ BEGIN ' + v9010.sql + ' END $replay$;');
    await engine.executeRaw('DO $replay$ BEGIN ' + v9010.sql + ' END $replay$;');
    await expect(read()).rejects.toMatchObject({ code: 'projection_pending' });
    await engine.executeRaw("UPDATE pages SET links_extracted_at='2026-10-08T00:00:00Z'");
    await extract();
    expect((await read()).total).toBe(3);
    expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    expect(await engine.getConfig('schema.upstream_version')).toBe('245');
  }, { databaseUrl });
}

// Value: protects=missing attendees remain discoverable while prior attendance edges survive; fails_when=incomplete attendance prevents authored inventory publication; why_new=existing lifecycle covers note references only; seam=none; no_claim=concurrent writer schedules.
export async function wantedIncompleteAttendance(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const put = async (slug: string, type: string, body: string, frontmatter = '') => {
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      return submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
        ...(current ? { expected_revision: current.revision } : {}),
        content: `---\ntype: ${type}\ntitle: ${slug}\n${frontmatter}---\n\n${body}\n` } });
    };
    const read = () => operationsByName.wanted_pages!.handler({ ...ctx, remote: true,
      auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], subjectIds: ['user:tech'], allowedSources: ['default'] } }, {}) as Promise<any>;
    const extract = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true, includeFrontmatter: true });
    const attendance = () => engine.executeRaw(`SELECT l.id,l.from_page_id,l.to_page_id,l.origin_page_id,l.link_source FROM links l
      JOIN pages p ON p.id=l.origin_page_id WHERE p.slug='meetings/incomplete' AND l.link_type='attended' ORDER BY l.id`);
    await put('notes/ordinary', 'note', 'See [[notes/missing-note]].');
    await put('people/known-person', 'person', 'Known person.');
    await put('meetings/incomplete', 'meeting', 'Attendees: [[people/known-person]]');
    const prior = await attendance();
    expect(prior.length).toBeGreaterThan(0);
    expect((await read()).targets.map((t: any) => t.target)).toEqual(['notes/missing-note']);
    await put('meetings/incomplete', 'meeting', 'Attendees: [[people/missing-person]]', 'attendees: ["people/missing-person"]\n');
    const wanted = await read();
    expect(wanted.total).toBe(2);
    expect(wanted.targets.map((t: any) => t.target).sort()).toEqual(['notes/missing-note', 'people/missing-person']);
    expect(await attendance()).toEqual(prior);
    await extract();
    expect(await read()).toEqual(wanted);
    expect(await attendance()).toEqual(prior);
    const [inventory] = await engine.executeRaw<{ refs: Array<{ producer: string }> }>(`SELECT i.refs FROM authored_link_inventories i
      JOIN pages p ON p.id=i.origin_page_id WHERE p.slug='meetings/incomplete' AND i.origin_revision=p.knowledge_revision`);
    expect(inventory.refs.map(r => r.producer).sort()).toEqual(['body', 'frontmatter']);
    // Old brains can already carry the blocked marker without any inventory.
    await engine.executeRaw(`DELETE FROM authored_link_inventories WHERE origin_page_id=(SELECT id FROM pages WHERE slug='meetings/incomplete')`);
    await expect(read()).rejects.toMatchObject({ code: 'projection_pending' });
    await extract();
    expect((await read()).targets.map((t: any) => t.target).sort()).toEqual(['notes/missing-note', 'people/missing-person']);
    expect(await attendance()).toEqual(prior);
    // Once the target exists, the same sweep can replace the old attendance.
    await put('people/missing-person', 'person', 'Now present.');
    await extract();
    expect((await read()).targets.map((t: any) => t.target)).toEqual(['notes/missing-note']);
    const edges = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT f.slug FROM links l JOIN pages f ON f.id=l.from_page_id
      JOIN pages p ON p.id=l.origin_page_id WHERE p.slug='meetings/incomplete' AND l.link_type='attended'`);
    expect(edges).toEqual([{ slug: 'people/missing-person' }]);
  }, { databaseUrl });
}

// Value: protects=unmanaged inventory backfill and stale-origin refusal; fails_when=incomplete attendance skips inventory or an old snapshot overwrites it; why_new=managed lifecycle bypasses unmanaged extraction; seam=none; no_claim=independent concurrent PostgreSQL schedules.
export async function wantedIncompleteAttendanceExtraction(databaseUrl?: string) {
  const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
  try {
    await engine.putPage('notes/ordinary', { type: 'note', title: 'Ordinary', compiled_truth: 'See [[notes/missing-note]].', timeline: '' });
    await engine.putPage('meetings/incomplete', { type: 'meeting', title: 'Meeting', compiled_truth: 'Attendees: [[people/missing-person]]',
      timeline: '', frontmatter: { attendees: ['people/missing-person'] } });
    const read = () => listWantedPages(engine, { sourceId: 'default', aclSubjectIds: ['user:tech'], excludePrivate: true, limit: 50, offset: 0 });
    const extract = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true, includeFrontmatter: true });
    await extract();
    expect((await read()).rows.map(r => r.target).sort()).toEqual(['notes/missing-note', 'people/missing-person']);
    await engine.executeRaw('DELETE FROM authored_link_inventories');
    await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter', '--json']);
    expect((await read()).rows.map(r => r.target).sort()).toEqual(['notes/missing-note', 'people/missing-person']);
    const previous = (await engine.readPageSnapshot('meetings/incomplete', { sourceId: 'default' }))!;
    await engine.putPage('meetings/incomplete', { type: 'meeting', title: 'Updated meeting', compiled_truth: 'No attendance claimed.', timeline: '', frontmatter: {} });
    await extract();
    const before = await engine.executeRaw('SELECT * FROM authored_link_inventories ORDER BY origin_page_id');
    await publishAuthoredLinkInventory(engine, previous, []);
    expect(await engine.executeRaw('SELECT * FROM authored_link_inventories ORDER BY origin_page_id')).toEqual(before);
    expect((await read()).rows.map(r => r.target)).toEqual(['notes/missing-note']);
  } finally { await close(); }
}
