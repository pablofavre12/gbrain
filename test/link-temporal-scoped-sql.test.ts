import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildRelationshipState, parseMultirange, relationshipFilterSql, temporalLinkJoinSql,
  type AssertionEvidence, type TransitionEvidence } from '../src/core/link-validity.ts';
import { scopedTemporalStateSql, temporalEvidencePageSql, temporalSqlFragment } from '../src/core/link-temporal-read-sql.ts';

import { renderFragment, sqlFragment } from '../src/core/engine-sql/fragment.ts';

let engine: PGLiteEngine;
let from: number, to: number;
const origins: number[] = [];
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const name of ['from', 'to', 'origin-a', 'origin-b']) {
    await engine.putPage(`notes/temporal-sql-${name}`, { type: 'note', title: name, compiled_truth: name, timeline: '', frontmatter: {} });
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [`notes/temporal-sql-${name}`]);
    origins.push(Number(page.id));
  }
  [from, to] = origins;
});
afterAll(async () => { await engine.disconnect(); });

async function setEvidence(assertions: AssertionEvidence[], transitions: TransitionEvidence[], type = 'works_at') {
  await engine.executeRaw('DELETE FROM links WHERE from_page_id = $1', [from]);
  await engine.executeRaw('DELETE FROM link_transitions WHERE from_page_id = $1', [from]);
  for (const [index, a] of assertions.entries()) {
    await engine.executeRaw(`INSERT INTO links(from_page_id, to_page_id, link_type, link_source, origin_page_id, assertion_tense)
      VALUES ($1, $2, $3, $4, $5, $6)`, [from, to, type, `test-${index}`, a.originPageId, a.tense]);
  }
  for (const t of transitions) {
    await engine.executeRaw(`INSERT INTO link_transitions(source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
      VALUES ('default', $1, $2, $3, $4, $5::date, 'timeline', $6) ON CONFLICT DO NOTHING`,
    [from, to, type, t.kind, t.occurredOn, t.originPageId]);
  }
}

async function readState(type: string, semantics: 'state' | 'event', subjects: string[] = []) {
  const params: unknown[] = [from, to, type];
  const query = scopedTemporalStateSql('l', { aclSubjectIds: subjects }, [{ linkType: type, semantics }], params);
  return engine.executeRaw<{ valid_ranges: string; disputed: boolean; first_start: string | null; undated_past: number }>(
    `SELECT s.valid_ranges::text, s.disputed, s.first_start::text, s.undated_past
      FROM (VALUES ($1::int, $2::int, $3::text)) l(from_page_id, to_page_id, link_type)
      CROSS JOIN LATERAL (${query}) s`,
    params);
}

describe('scoped temporal SQL derives the pure state algorithm', () => {
  test('all event subsets and present/past origin combinations match pure stints and disputes', async () => {
    const events: TransitionEvidence[] = ['2020-01-01', '2021-01-01', '2022-01-01'].flatMap(occurredOn =>
      (['start', 'end'] as const).map(kind => ({ kind, occurredOn, producer: 'timeline' as const, originPageId: origins[2] })));
    const assertionSets: AssertionEvidence[][] = [
      [],
      [{ tense: 'present', originPageId: origins[2] }],
      [{ tense: 'past', originPageId: origins[2] }],
      [{ tense: 'present', originPageId: origins[2] }, { tense: 'past', originPageId: origins[3] }],
      [{ tense: 'present', originPageId: origins[2] }, { tense: 'past', originPageId: origins[2] }],
    ];
    for (let mask = 0; mask < 64; mask++) {
      const transitions = events.filter((_, i) => (mask & (1 << i)) !== 0).reverse();
      for (const assertions of assertionSets) {
        for (const semantics of ['state', 'event'] as const) {
          const type = semantics === 'state' ? 'works_at' : 'founded';
          await setEvidence(assertions, transitions, type);
          const expected = buildRelationshipState(semantics, assertions, transitions);
          const rows = await readState(type, semantics);
          if (!assertions.length && !transitions.length) { expect(rows).toHaveLength(0); continue; }
          const [actual] = rows;
          expect(parseMultirange(actual.valid_ranges)).toEqual(expected.stints);
          expect(actual.disputed).toBe(expected.disputed);
          expect(actual.first_start).toBe(expected.firstStart);
          expect(Number(actual.undated_past)).toBe(expected.undatedPast);
        }
      }
    }
  }, 30000);

  test('ACL revocation changes filters and annotations immediately without touching shared projections', async () => {
    const assertions: AssertionEvidence[] = [{ tense: 'present', originPageId: origins[2] }];
    const transitions: TransitionEvidence[] = [{ kind: 'end', occurredOn: '2021-01-01', producer: 'timeline', originPageId: origins[3] }];
    await setEvidence(assertions, transitions);
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['allowed-reader'], origins[3]]);
    expect(parseMultirange((await readState('works_at', 'state'))[0].valid_ranges)).toEqual([{ from: null, until: null }]);
    expect(parseMultirange((await readState('works_at', 'state', ['allowed-reader']))[0].valid_ranges))
      .toEqual([{ from: null, until: '2021-01-01' }]);
    const filter = (subjects: string[]) => {
      const params: unknown[] = [from];
      const sql = relationshipFilterSql('l', { aclSubjectIds: subjects, asOf: '2022-01-01' }, params);
      return engine.executeRaw(`SELECT l.id FROM links l WHERE l.from_page_id = $1 AND ${sql}`, params);
    };
    expect(await filter([])).toHaveLength(1);
    expect(await filter(['allowed-reader'])).toHaveLength(0);
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['another-reader'], origins[3]]);
    expect(await filter(['allowed-reader'])).toHaveLength(1);
    const annotationParams: unknown[] = [from];
    const join = temporalLinkJoinSql('l', { aclSubjectIds: ['allowed-reader'] }, annotationParams);
    const [annotation] = await engine.executeRaw<{ ranges: string }>(`SELECT lr_t.valid_ranges::text AS ranges FROM links l
      ${join} WHERE l.from_page_id = $1`, annotationParams);
    expect(parseMultirange(annotation.ranges)).toEqual([{ from: null, until: null }]);
  });

  test('policy values remain data for quotes, backslashes, dollar markers and Unicode', async () => {
    const subject = "reader'\\$1); SELECT pg_sleep(1); --🦉";
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [[subject], origins[3]]);
    const params: unknown[] = [origins[3]];
    const fragment = temporalEvidencePageSql('p', { aclSubjectIds: [subject] }, params);
    expect(fragment).not.toContain(subject);
    expect(await engine.executeRaw(`SELECT p.id FROM pages p WHERE p.id = $1 AND ${fragment}`, params)).toHaveLength(1);
    const composed = renderFragment(sqlFragment`SELECT p.id FROM pages p WHERE p.id = ${origins[3]}
      AND ${temporalSqlFragment(bindings => temporalEvidencePageSql('p', { aclSubjectIds: [subject] }, bindings))}`);
    expect(await engine.executeRaw(composed.text, composed.params)).toHaveLength(1);
    const deniedParams: unknown[] = [origins[3]];
    const denied = temporalEvidencePageSql('p', { aclSubjectIds: [] }, deniedParams);
    expect(await engine.executeRaw(`SELECT p.id FROM pages p WHERE p.id = $1 AND ${denied}`, deniedParams)).toHaveLength(0);
  });
});
