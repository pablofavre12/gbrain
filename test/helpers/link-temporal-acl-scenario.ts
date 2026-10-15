/** Exact reader-scoped temporal derivation: hidden evidence must not alter public answers. */
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { refreshRelationships } from '../../src/core/link-relationships.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { loadRelationshipNotes, relationshipNoteKey } from '../../src/core/link-relationship-notes.ts';
import { withTrustPromotion } from '../../src/core/persistence/context.ts';
import { assembleTurnContext } from '../../src/core/context/turn-context.ts';
import { __resetHotMemoryCacheForTests } from '../../src/core/facts/meta-hook.ts';
import { buildRelationshipState, type TemporalAnnotation } from '../../src/core/link-validity.ts';
import type { PageReadScope } from '../../src/core/types.ts';

export function defineTemporalAclTests(engineOf: () => BrainEngine): void {
  setDefaultTimeout(60_000);
  let engine: BrainEngine;
  const person = 'people/alice-example';
  const company = 'companies/acme-example';
  const origin = 'notes/direction';
  let personId: number, companyId: number, originId: number;
  const alice = ['user:alice'];
  const bob = ['user:bob'];
  const scope = (subjects: string[], sources = ['default']): PageReadScope => ({
    aclSubjectIds: subjects, sourceIds: sources, excludePrivate: true,
  });
  function ctx(subjects: string[], allowedSources = ['default']): OperationContext {
    return {
      engine, config: { engine: 'pglite' }, dryRun: false, remote: true, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'synthetic', clientId: 'test', scopes: ['read'], subjectIds: subjects, allowedSources },
    } as OperationContext;
  }
  const call = (name: string, subjects: string[], params: Record<string, unknown> = {}, sources = ['default']) =>
    operations.find(op => op.name === name)!.handler(ctx(subjects, sources), params);
  const rows = (value: unknown): Array<Record<string, unknown>> => value as Array<Record<string, unknown>>;
  async function page(slug: string, sourceId = 'default') {
    const type = slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'note';
    const title = slug === company ? 'Acme Example' : slug === person ? 'Alice Example' : slug;
    const body = slug === person ? 'Alice works at Acme Example.' : 'Synthetic evidence.';
    await operations.find(op => op.name === 'put_page')!.handler({ ...ctx(alice), remote: false, auth: undefined, sourceId },
      { slug, content: `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}` });
    return (await engine.getPage(slug, { sourceId }))!.id;
  }
  async function transition(kind: 'start' | 'end', date: string, originPageId: number, toId = companyId) {
    await engine.executeRaw(`INSERT INTO link_transitions
      (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
      VALUES ('default', $1, $2, 'works_at', $3, $4::date, 'timeline', $5)`,
    [personId, toId, kind, date, originPageId]);
  }
  async function refresh(toId = companyId) {
    await refreshRelationships(engine, [{ from_page_id: personId, to_page_id: toId, link_type: 'works_at' }]);
  }
  async function addSecretEnd() {
    await transition('end', '2024-07-01', originId);
    await refresh();
  }
  async function history(subjects: string[], sources = ['default']) {
    return rows(await call('get_links', subjects, { slug: person, link_type: 'works_at', status: 'all' }, sources));
  }
  async function card(subjects: string[]) {
    const result = await buildEntityCard(engine, 'default', person, { remote: true, aclSubjectIds: subjects });
    if (!result.card) throw new Error('synthetic entity card missing');
    return { edges: result.card.edges, note: result.card.relationship_note };
  }
  async function note(subjects: string[], sources = ['default']) {
    const notes = await loadRelationshipNotes(engine, [{ slug: person, source_id: 'default', summary: 'Alice works at Acme Example.' }],
      { ...scope(subjects, sources), excludePrivate: true });
    return notes.get(relationshipNoteKey('default', person));
  }

  beforeEach(async () => {
    engine = engineOf();
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('secret', 'Secret', '{}'::jsonb)");
    personId = await page(person); companyId = await page(company); originId = await page(origin);
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [alice, originId]);
    await engine.addLink(person, company, 'Alice works at Acme Example', 'works_at', 'frontmatter', person);
    await transition('start', '2020-01-01', personId);
    await refresh();
  });

  describe('per-reader temporal ACL', () => {
    test('history annotations ignore a hidden end but authorized readers receive its exact date', async () => {
      const before = await history(bob);
      expect(before).toHaveLength(1);
      expect(before[0].status).toBe('live');
      await addSecretEnd();
      expect(await history(bob)).toEqual(before);
      expect(await history([])).toEqual(before);
      const allowed = await history(alice);
      expect(allowed[0].status).toBe('ended');
      expect(allowed[0].stints).toEqual([{ from: '2020-01-01', until: '2024-07-01' }]);
    });

    for (const name of ['get_links', 'get_backlinks', 'traverse_graph']) {
      test(`${name} filters live, ended, as_of and during using only authorized evidence`, async () => {
        const base = { slug: name === 'get_backlinks' ? company : person, link_type: 'works_at', ...(name === 'traverse_graph' ? { depth: 2, direction: 'out' } : {}) };
        const probes = [{}, { status: 'all' }, { status: 'ended' }, { as_of: '2023-01-01' }, { as_of: '2025-01-01' }, { during: '2025' }];
        const before = await Promise.all(probes.map(p => call(name, bob, { ...base, ...p })));
        expect(rows(before[0])).toHaveLength(1);
        await addSecretEnd();
        for (let i = 0; i < probes.length; i++) expect(await call(name, bob, { ...base, ...probes[i] })).toEqual(before[i]);
        expect(rows(await call(name, alice, base))).toHaveLength(0);
        expect(rows(await call(name, alice, { ...base, status: 'ended' }))).toHaveLength(1);
        expect(rows(await call(name, alice, { ...base, as_of: '2023-01-01' }))).toHaveLength(1);
        expect(rows(await call(name, alice, { ...base, as_of: '2025-01-01' }))).toHaveLength(0);
        expect(rows(await call(name, alice, { ...base, during: '2025' }))).toHaveLength(0);
      });
    }

    test('entity edges and relationship notes preserve the public view and enrich the authorized view', async () => {
      const before = await card(bob);
      expect(before.edges).toHaveLength(1);
      expect(before.edges[0].status).toBe('live');
      expect(await note(bob)).toBeUndefined();
      await addSecretEnd();
      expect(await card(bob)).toEqual(before);
      expect(await note(bob)).toBeUndefined();
      expect(await note([])).toBeUndefined();
      const allowed = await card(alice);
      expect(allowed.edges[0]).toMatchObject({ status: 'ended', until: '2024-07-01' });
      expect(allowed.note).toContain('2024-07-01');
      expect(await note(alice)).toContain('2024-07-01');
    });

    test('relational recall retains public present-tense answers and authorized former answers', async () => {
      const query = 'who works at acme-example';
      const before = await buildRelationalArm(engine, query, scope(bob));
      expect(before.map(r => r.slug)).toContain(person);
      await addSecretEnd();
      expect((await buildRelationalArm(engine, query, scope(bob))).map(r => r.slug)).toEqual(before.map(r => r.slug));
      expect((await buildRelationalArm(engine, query, scope(alice))).map(r => r.slug)).not.toContain(person);
      expect((await buildRelationalArm(engine, 'who worked at acme-example', scope(alice))).map(r => r.slug)).toContain(person);
    });

    test('node traversal, relational fanout and oriented chain hops use the same reader-specific state', async () => {
      const reads = (subjects: string[]) => Promise.all([
        engine.traverseGraph(person, 1, { ...scope(subjects), temporal: { status: 'live' } }),
        engine.relationalFanout([company], { ...scope(subjects), direction: 'in', linkTypes: ['works_at'], depth: 1, temporal: { status: 'live' } }),
        engine.relationalChainHop([companyId], { ...scope(subjects), linkTypes: ['works_at'], toward: 'subject', subjectTypes: ['person'], objectTypes: ['company'], degreeLinkTypes: ['works_at'], neighborCap: 10, temporal: { status: 'live' } }),
      ]);
      const before = await reads(bob);
      expect(before[0].map(r => r.slug)).toContain(company);
      expect(before[1].map(r => r.slug)).toContain(person);
      expect(before[2].map(r => r.to_slug)).toContain(person);
      await addSecretEnd();
      expect(await reads(bob)).toEqual(before);
      const allowed = await reads(alice);
      expect(allowed[0].map(r => r.slug)).not.toContain(company);
      expect(allowed[1]).toEqual([]);
      expect(allowed[2]).toEqual([]);
    });

    test('ACL revocation and grant take effect immediately without refreshing shared relationship caches', async () => {
      const publicView = await history(bob);
      await addSecretEnd();
      expect((await history(alice))[0].status).toBe('ended');
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [bob, originId]);
      expect(await history(alice)).toEqual(publicView);
      expect((await history(bob))[0].status).toBe('ended');
      expect(await note(alice)).toBeUndefined();
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [['user:neither'], originId]);
      expect(await history(alice)).toEqual(publicView);
      expect(await history(bob)).toEqual(publicView);
      expect(await history([])).toEqual(publicView);
    });

    test('hidden past assertions cannot change disputed status or the first recorded evidence timestamp', async () => {
      const before = await history(bob);
      await engine.executeRaw(`INSERT INTO links
        (from_page_id, to_page_id, link_type, link_source, origin_page_id, assertion_tense, created_at)
        VALUES ($1, $2, 'works_at', 'restricted-origin', $3, 'past', '2001-01-01T00:00:00Z')`,
      [personId, companyId, originId]);
      await refresh();
      expect(await history(bob)).toEqual(before);
      expect(await history([])).toEqual(before);
      const allowed = await history(alice);
      expect(allowed[0].status).toBe('disputed');
      expect(allowed[0].recorded_at).toBe('2001-01-01T00:00:00.000Z');
    });

    test('out-of-grant origin cannot leak link context between public endpoints', async () => {
      const foreignOrigin = await page('notes/foreign-evidence', 'secret');
      await engine.executeRaw(`INSERT INTO links
        (from_page_id, to_page_id, link_type, link_source, origin_page_id, context)
        VALUES ($1, $2, 'advises', 'foreign-origin', $3, 'FOREIGN_ORIGIN_SECRET_MARKER')`,
      [personId, companyId, foreignOrigin]);
      for (const name of ['get_links', 'get_backlinks']) {
        const params = { slug: name === 'get_backlinks' ? company : person, link_type: 'advises', status: 'all' };
        const hidden = await call(name, alice, params, ['default']);
        expect(JSON.stringify(hidden)).not.toContain('FOREIGN_ORIGIN_SECRET_MARKER');
        expect(rows(hidden)).toHaveLength(0);
      }
    });

    for (const policy of [{ minTrust: 'user_confirmed' as const }, { suppressFlagged: true }]) {
      test(`evidence eligibility precedes temporal aggregation (${Object.keys(policy)[0]})`, async () => {
        const promote = (id: number) => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
          () => tx.executeRaw("UPDATE pages SET trust_tier = 'user_confirmed' WHERE id = $1", [id])));
        await promote(personId); await promote(companyId);
        await engine.executeRaw(`INSERT INTO write_gate_receipts
          (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families)
          VALUES ('pages', $1, 'default', md5($1), 'agent_written', 1, 'flag', ARRAY['standing_instruction']::text[])`, [String(originId)]);
        const read = () => engine.getLinks(person, { ...scope(alice), ...policy, temporal: { status: 'all' } });
        const before = await read();
        expect(before).toHaveLength(1);
        await addSecretEnd();
        expect(await read()).toEqual(before);
        expect((await history(alice))[0].status).toBe('ended');
        const notes = () => loadRelationshipNotes(engine, [{ slug: person, source_id: 'default' }],
          { ...scope(alice), ...policy, excludePrivate: true });
        expect((await notes()).size).toBe(0);
        await promote(originId);
        expect((await read())[0]).toMatchObject({ status: 'ended' } satisfies Pick<TemporalAnnotation, 'status'>);
        expect([...(await notes()).values()][0]).toContain('2024-07-01');
      });
    }

    test('typed and limited backlink history filters before limiting', async () => {
      const params = { page_id: companyId, type: 'person', limit: 1 };
      await addSecretEnd();
      await page('people/second-example');
      await engine.addLink('people/second-example', company, 'Second person works at Acme Example', 'works_at', 'frontmatter', 'people/second-example');
      expect(rows(await call('get_backlinks', bob, params))).toHaveLength(1);
      const live = rows(await call('get_backlinks', alice, params));
      expect(live).toHaveLength(1);
      expect(live[0].from_slug).toBe('people/second-example');
      const past = rows(await call('get_backlinks', alice, { ...params, status: 'ended' }));
      expect(past).toHaveLength(1);
      expect(past[0].stints).toEqual([{ from: '2020-01-01', until: '2024-07-01' }]);
      expect(rows(await call('get_backlinks', alice, { ...params, as_of: '2021-01-01' }))).toHaveLength(1);
      await expect(call('get_backlinks', alice, { ...params, cursor: 'not-a-cursor' })).rejects.toThrow(/cursor needs group/);
    });

    test('grouped backlink pagination rejects explicit temporal filters instead of silently ignoring them', async () => {
      for (const temporal of [{ status: 'ended' }, { as_of: '2021-01-01' }]) {
        await expect(call('get_backlinks', alice, { page_id: companyId, group: 'page', limit: 1, ...temporal })).rejects.toThrow(/temporal|status|as_of/);
      }
      const grouped = await call('get_backlinks', alice, { page_id: companyId, group: 'page', limit: 1 }) as { rows: unknown[] };
      expect(grouped.rows).toHaveLength(1);
    });

    test('actual turn-context assembly respects reader, floor and activation on a warm session', async () => {
      __resetHotMemoryCacheForTests();
      try {
        const read = (subjects: string[], eligibility = {}) => assembleTurnContext(engine, {
          sourceId: 'default', sessionId: 'temporal-acl-warm-session', aclSubjectIds: subjects,
          window: [{ role: 'user', text: 'Tell me about Alice Example' }], eligibility,
        });
        await addSecretEnd();
        const authorized = await read(alice);
        expect(authorized.pointers.map(p => p.slug)).toContain(person);
        expect(authorized.text).toContain('2024-07-01');
        for (const subjects of [bob, []]) {
          const hidden = await read(subjects);
          expect(hidden.pointers.map(p => p.slug)).toContain(person);
          expect(hidden.text).not.toContain('2024-07-01');
        }
        await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () =>
          tx.executeRaw("UPDATE pages SET trust_tier = 'user_confirmed' WHERE id = ANY($1::int[])", [[personId, companyId]])));
        const floored = await read(alice, { floor: 'user_confirmed' });
        expect(floored.pointers.map(p => p.slug)).toContain(person);
        expect(floored.text).not.toContain('2024-07-01');
        await engine.executeRaw(`INSERT INTO write_gate_receipts
          (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families)
          VALUES ('pages', $1, 'default', md5($1), 'agent_written', 1, 'flag', ARRAY['standing_instruction']::text[])`, [String(originId)]);
        const suppressed = await read(alice, { suppressFlagged: true });
        expect(suppressed.pointers.map(p => p.slug)).toContain(person);
        expect(suppressed.text).not.toContain('2024-07-01');
        await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () =>
          tx.executeRaw("UPDATE pages SET trust_tier = 'user_confirmed' WHERE id = $1", [originId])));
        expect((await read(alice, { floor: 'user_confirmed', suppressFlagged: true })).text).toContain('2024-07-01');
      } finally { __resetHotMemoryCacheForTests(); }
    });

    test('mixed-origin histories and retired timestamps derive from each independently authorized subset', async () => {
      const originB = await page('notes/second-reader');
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [bob, originB]);
      await engine.executeRaw("UPDATE links SET created_at = '2019-01-01T00:00:00Z'");
      await engine.executeRaw("UPDATE link_transitions SET created_at = '2019-01-02T00:00:00Z'");
      const fixtures = [
        { kind: 'start' as const, date: '2020-01-01', origin: originId, subjects: alice, recorded: '2021-01-01' },
        { kind: 'start' as const, date: '2020-01-01', origin: originB, subjects: bob, recorded: '2021-01-02' },
        { kind: 'end' as const, date: '2022-01-01', origin: originId, subjects: alice, recorded: '2024-01-01' },
        { kind: 'start' as const, date: '2023-01-01', origin: originB, subjects: bob, recorded: '2025-01-01' },
      ];
      for (const f of fixtures) {
        await transition(f.kind, f.date, f.origin);
        await engine.executeRaw('UPDATE link_transitions SET created_at = $1::timestamptz WHERE origin_page_id = $2 AND occurred_on = $3::date',
          [f.recorded, f.origin, f.date]);
      }
      await refresh();
      for (const subjects of [[], alice, bob, [...alice, ...bob]]) {
        const visible = fixtures.filter(f => f.subjects.some(s => subjects.includes(s)));
        const expected = buildRelationshipState('state', [{ tense: 'present', originPageId: personId }], [
          { kind: 'start', occurredOn: '2020-01-01', producer: 'timeline', originPageId: personId },
          ...visible.map(f => ({ kind: f.kind, occurredOn: f.date, producer: 'timeline' as const, originPageId: f.origin })),
        ]);
        const result = (await history(subjects))[0];
        expect(result.stints).toEqual(expected.stints);
        expect(result.recorded_at).toBe('2019-01-01T00:00:00.000Z');
        expect(result.retired_at).toBe(subjects.length === 1 && subjects[0] === alice[0] ? '2024-01-01T00:00:00.000Z' : null);
      }
      await engine.executeRaw("UPDATE pages SET acl_subject_ids = ARRAY['user:unrelated'] WHERE id = $1", [originId]);
      expect((await history([...alice, ...bob]))[0].stints).toEqual([{ from: '2020-01-01', until: null }]);
      expect((await history(alice))[0].retired_at).toBeNull();
    });

    test('unusual server-established subject values remain data in full temporal and recursive SQL', async () => {
      const unusual = "user:o'hara\\$2-雪";
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [[unusual], originId]);
      await addSecretEnd();
      expect((await history([unusual]))[0].status).toBe('ended');
      expect((await history(alice))[0].status).toBe('live');
      const params = { slug: person, direction: 'out', depth: 2, link_type: 'works_at' };
      expect(rows(await call('traverse_graph', [unusual], params))).toHaveLength(0);
      expect(rows(await call('traverse_graph', alice, params))).toHaveLength(1);
    });

    test('a foreign-source transition origin never contributes, even when the reader can access both sources', async () => {
      const foreignOrigin = await page('notes/foreign-evidence', 'secret');
      const before = await history(alice, ['default', 'secret']);
      await transition('end', '2024-07-01', foreignOrigin);
      await refresh();
      expect(await history(alice, ['default', 'secret'])).toEqual(before);
      expect(await history(alice, ['default'])).toEqual(before);
      expect(await note(alice, ['default', 'secret'])).toBeUndefined();
    });

    test('restricted targets and excluded source endpoints never appear in historical reads or notes', async () => {
      await addSecretEnd();
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1::text[] WHERE id = $2', [alice, companyId]);
      expect(await history(bob)).toEqual([]);
      expect(await note(bob)).toBeUndefined();
      expect((await history(alice))[0].status).toBe('ended');
      const foreignTarget = await page('companies/foreign-company', 'secret');
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source, origin_page_id)
        VALUES ($1, $2, 'works_at', 'frontmatter', $1)`, [personId, foreignTarget]);
      await transition('start', '2019-01-01', personId, foreignTarget);
      await transition('end', '2023-01-01', personId, foreignTarget);
      await refresh(foreignTarget);
      expect(JSON.stringify(await history(alice))).not.toContain('foreign-company');
      expect(await note(alice)).not.toContain('foreign-company');
      expect(JSON.stringify(await history(alice, ['default', 'secret']))).toContain('foreign-company');
      expect(await note(alice, ['default', 'secret'])).toContain('foreign-company');
    });
  });
}
