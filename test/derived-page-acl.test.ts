import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { pageAclFilter } from '../src/core/search/page-acl.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
beforeAll(async () => {
  for (const backend of backends) {
    if (backend === 'postgres') { const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(fixture.engine); closePg = fixture.close; }
    else { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); engines.push(e); }
  }
  for (const e of engines) {
    await e.executeRaw("INSERT INTO sources(id,name) VALUES('other','Other')");
    for (const sourceId of ['default', 'other']) {
      await e.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'cedar source', acl_subject_ids: [sourceId === 'default' ? 'user:owner' : 'user:outsider'] }, { sourceId });
      await installFixtureChunks(e, 'notes/origin', [{ chunk_index: 0, chunk_text: 'cedar source', chunk_source: 'compiled_truth' }], { sourceId });
    }
    await e.putPage('atoms/derived', { type: 'atom', title: 'Derived', compiled_truth: 'cedar derived', frontmatter: { visibility: 'world', source_slug: 'notes/origin' } });
    await e.executeRaw("INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id) SELECT 'pages',a.id::text,'pages',p.id::text,'default' FROM pages a,pages p WHERE a.slug='atoms/derived' AND a.source_id='default' AND p.slug='notes/origin' AND p.source_id='default'");
    await installFixtureChunks(e, 'atoms/derived', [{ chunk_index: 0, chunk_text: 'cedar derived', chunk_source: 'compiled_truth' }]);
  }
}, 120000);
afterAll(async () => { for (const e of engines) if (e.kind === 'pglite') await e.disconnect(); await closePg?.(); });
const scope = (user: string) => ({ sourceIds: ['default', 'other'], aclSubjectIds: [`user:${user}`], excludePrivate: false });
const ctx = (engine: BrainEngine, user: string): OperationContext => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default', auth: { clientId: 'fixture', sourceId: 'default', allowedSources: ['default', 'other'], subjectIds: [`user:${user}`] } as never });

test('chunk rows and counts honor concrete page ACL across same-slug sources', async () => {
  for (const e of engines) {
    const page = await e.getChunkPage('notes/origin', { ...scope('outsider'), fromIndex: 0, limit: 10 });
    const allowed = await e.getPage('notes/origin', { sourceId: 'other' });
    expect(page.chunks.map(c => c.page_id)).toEqual([allowed!.id]);
    expect(page.total_chunks).toBe(1);
    expect((await e.getChunks('notes/origin', scope('outsider'))).map(c => c.page_id)).toEqual([allowed!.id]);
    expect(await e.getChunkPage('notes/origin', { sourceId: 'default', aclSubjectIds: [], fromIndex: 0, limit: 10 })).toEqual({ chunks: [], total_chunks: 0, max_chunk_index: null });
  }
});

test('derived readers require live same-source origin ACL even with privacy opted out', async () => {
  for (const e of engines) {
    expect(await e.getPage('atoms/derived', scope('owner'))).not.toBeNull();
    expect(await e.getPage('atoms/derived', scope('outsider'))).toBeNull();
    expect((await e.listPages(scope('outsider'))).map(p => p.slug)).not.toContain('atoms/derived');
    expect((await e.searchKeyword('cedar', scope('outsider'))).map(p => p.slug)).not.toContain('atoms/derived');
    expect((await e.getChunkPage('atoms/derived', { ...scope('outsider'), fromIndex: 0, limit: 10 })).total_chunks).toBe(0);
    await expect(operationsByName.get_page.handler(ctx(e, 'outsider'), { slug: 'atoms/derived', aclSubjectIds: ['user:owner'] })).rejects.toThrow();
    await e.executeRaw("UPDATE pages SET acl_subject_ids=ARRAY['user:replacement'] WHERE source_id='default' AND slug='notes/origin'");
    expect(await e.getPage('atoms/derived', scope('owner'))).toBeNull();
    expect(await e.getPage('atoms/derived', scope('replacement'))).not.toBeNull();
    await e.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='notes/origin'");
    expect(await e.getPage('atoms/derived', scope('replacement'))).toBeNull();
    await e.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug='notes/origin'");
    expect(await e.getPage('atoms/derived', scope('outsider'))).toBeNull();
    expect(await e.getPage('atoms/derived')).not.toBeNull();
    await e.putPage('notes/origin', { type: 'note', title: 'Recreated', compiled_truth: 'Public replacement' });
    expect(await e.getPage('atoms/derived', scope('outsider'))).toBeNull();
  }
});

for (const managed of [false, true]) test(`real ${managed ? 'managed' : 'unmanaged'} atom extraction retains the origin read boundary`, async () => {
  const { runPhaseExtractAtoms } = await import('../src/core/cycle/extract-atoms.ts');
  const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
  for (const e of engines) {
    const page = await e.putPage(`notes/extraction-${managed ? 'managed' : 'unmanaged'}-origin`, { type: 'note', title: 'Extraction origin', compiled_truth: 'A synthetic cedar project record. '.repeat(20), acl_subject_ids: ['user:owner'] });
    await e.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
    try {
      const result = await runPhaseExtractAtoms(e, {
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _transcripts: [],
        _chat: async () => ({ text: JSON.stringify([{ title: 'Cedar observation', atom_type: 'insight', body: 'Cedar project observation.' }]), blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' }),
      });
      expect(result.details?.atoms_extracted).toBe(1);
      const [atom] = await e.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE type='atom' AND frontmatter->>'source_slug'=$1", [page.slug]);
      expect(await e.getPage(atom.slug, scope('owner'))).not.toBeNull();
      expect(await e.getPage(atom.slug, scope('outsider'))).toBeNull();
      expect(await e.getChunks(atom.slug, scope('outsider'))).toEqual([]);
    } finally {
      await disposePersistenceConsumer(e);
      await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }
}, 60000);


test('unbound, chained and cyclic atoms fail closed for remote readers', async () => {
  for (const e of engines) {
    for (const [slug, origin] of [['atoms/unbound', 'notes/origin'], ['atoms/chained', 'atoms/derived'], ['atoms/cycle-a', 'atoms/cycle-b'], ['atoms/cycle-b', 'atoms/cycle-a']]) {
      await e.putPage(slug, { type: 'atom', title: slug, compiled_truth: 'Cedar synthetic output', frontmatter: { visibility: 'world', source_slug: origin } });
    }
    await e.executeRaw("INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id) SELECT 'pages',a.id::text,'pages',p.id::text,'default' FROM pages a JOIN pages p ON p.slug=a.frontmatter->>'source_slug' AND p.source_id=a.source_id WHERE a.slug IN ('atoms/chained','atoms/cycle-a','atoms/cycle-b')");
    for (const slug of ['atoms/unbound', 'atoms/chained', 'atoms/cycle-a', 'atoms/cycle-b']) {
      expect(await e.getPage(slug, scope('owner'))).toBeNull();
      expect(await e.getPage(slug)).not.toBeNull();
    }
  }
});

test('atom sidecars and synthesized concepts retain the stable input boundary', async () => {
  for (const e of engines) {
    const origin = await e.putPage('notes/sidecar-origin', { type: 'note', title: 'Origin', compiled_truth: 'Cedar source', acl_subject_ids: ['user:owner'] });
    const atom = await e.putPage('atoms/sidecars', { type: 'atom', title: 'Sidecar', compiled_truth: 'Cedar detail', frontmatter: { source_slug: origin.slug, visibility: 'world' } });
    const concept = await e.putPage('concepts/sidecars', { type: 'concept', title: 'Concept', compiled_truth: 'Cedar synthesis', frontmatter: { synthesized_by: 'fixture', visibility: 'world' } });
    const { recordDerivationInputs } = await import('../src/core/facts/derivation-inputs.ts');
    await recordDerivationInputs(e, { table: 'pages', id: atom.id, sourceId: 'default' }, [{ table: 'pages', id: origin.id }]);
    await recordDerivationInputs(e, { table: 'pages', id: concept.id, sourceId: 'default' }, [{ table: 'pages', id: atom.id }]);
    await e.addTag(atom.slug, 'cedar-tag');
    await e.putRawData(atom.slug, 'fixture', { detail: 'cedar detail' });
    await e.addTimelineEntry(atom.slug, { date: '2026-10-15', summary: 'Cedar event', source: 'fixture' });
    await e.createVersion(atom.slug);
    for (const name of ['get_tags', 'get_raw_data', 'get_timeline', 'get_versions']) {
      expect(await operationsByName[name].handler(ctx(e, 'outsider'), { slug: atom.slug })).toEqual([]);
      expect((await operationsByName[name].handler(ctx(e, 'owner'), { slug: atom.slug }) as unknown[]).length).toBeGreaterThan(0);
    }
    expect((await e.readPageSnapshotsBatch([{ slug: atom.slug, sourceId: 'default' }], scope('outsider'))).snapshots.size).toBe(0);
    expect(await e.getPage(concept.slug, scope('outsider'))).toBeNull();
    expect(await e.getPage(concept.slug, scope('owner'))).not.toBeNull();
    await e.executeRaw('DELETE FROM pages WHERE id=$1', [atom.id]);
    expect(await e.getPage(concept.slug, scope('owner'))).toBeNull();
  }
});


test('concept input IDs preserve canonical int32 identity and reject malformed or mixed bindings', async () => {
  for (const e of engines) {
    const input = await e.putPage('notes/id-input', { type: 'note', title: 'ID input', compiled_truth: 'Synthetic input', acl_subject_ids: ['user:owner'] });
    const concept = await e.putPage('concepts/id-input', { type: 'concept', title: 'ID concept', compiled_truth: 'Synthetic output', frontmatter: { synthesized_by: 'fixture', visibility: 'world' } });
    const replaceInputs = async (inputs: Array<{ table: string; id: string | number }>) => {
      await e.executeRaw("DELETE FROM derivation_inputs WHERE derived_table='pages' AND derived_id=$1", [String(concept.id)]);
      await recordDerivationInputs(e, { table: 'pages', id: concept.id, sourceId: 'default' }, inputs);
    };
    const valid = { table: 'pages', id: input.id };
    await replaceInputs([valid]);
    expect(await e.getPage(concept.slug, scope('owner'))).not.toBeNull();
    expect(await e.getPage(concept.slug, scope('outsider'))).toBeNull();
    const invalidIds = [
      `0${input.id}`, `+${input.id}`, ` ${input.id}`, `${input.id} `, `${input.id}\n`,
      `${input.id}.0`, `${input.id}e0`, '-0', 'not-an-id',
      '2147483648', '-2147483649', '9999999999', '-9999999999', '9'.repeat(100),
    ];
    for (const id of invalidIds) {
      for (const inputs of [[{ table: 'pages', id }], [valid, { table: 'pages', id }]]) {
        await replaceInputs(inputs);
        expect({ id, count: inputs.length, page: await e.getPage(concept.slug, scope('owner')) }).toEqual({ id, count: inputs.length, page: null });
      }
    }
    for (const inputs of [[], [valid, { table: 'facts', id: input.id }], [valid, { table: 'pages', id: '2147483647' }]]) {
      await replaceInputs(inputs);
      expect(await e.getPage(concept.slug, scope('owner'))).toBeNull();
    }
    // SERIAL has no positive-only constraint: retain exact identity for every int32 boundary.
    for (const id of [-2147483648, -1, 0, 2147483647]) {
      await e.executeRaw(`INSERT INTO pages(id,source_id,slug,type,title,compiled_truth,timeline,frontmatter)
        VALUES($1::integer,'default',$2,'note','Boundary input','Synthetic input','','{}'::jsonb)`, [id, `notes/id-boundary-${id}`]);
      try {
        await replaceInputs([{ table: 'pages', id: String(id) }]);
        expect((await e.getPage(concept.slug, scope('owner')))?.id).toBe(concept.id);
        await e.executeRaw("UPDATE pages SET acl_subject_ids=ARRAY['user:outsider'] WHERE id=$1::integer", [id]);
        expect(await e.getPage(concept.slug, scope('owner'))).toBeNull();
      } finally {
        await e.executeRaw('DELETE FROM pages WHERE id=$1::integer', [id]);
      }
    }
    await replaceInputs([valid]);
    expect(await e.getPage(concept.slug, scope('owner'))).not.toBeNull();
  }
});

test('a populated concept lineage resolves page inputs through the primary-key index', async () => {
  for (const e of engines) {
    const input = await e.putPage('notes/index-input', { type: 'note', title: 'Index input', compiled_truth: 'Synthetic input' });
    const concept = await e.putPage('concepts/index-input', { type: 'concept', title: 'Index concept', compiled_truth: 'Synthetic output', frontmatter: { synthesized_by: 'fixture', visibility: 'world' } });
    await recordDerivationInputs(e, { table: 'pages', id: concept.id, sourceId: 'default' }, [{ table: 'pages', id: input.id }]);
    expect(await e.getPage(concept.slug, scope('owner'))).not.toBeNull();
    const rows = await e.transaction(async tx => {
      await tx.executeRaw('SET LOCAL enable_seqscan = off');
      return tx.executeRaw<Record<string, string>>(`EXPLAIN SELECT p.id FROM pages p WHERE p.id=$1::integer AND ${pageAclFilter('p', '$2')}`, [concept.id, ['user:owner']]);
    });
    const plan = rows.map(r => Object.values(r)[0]).join('\n');
    expect(plan).toMatch(/Index Scan using pages_pkey on pages acl_input\b/);
    expect(plan).not.toMatch(/Seq Scan on pages\b/);
  }
});
