import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { appendRelationshipNotes, loadRelationshipNotes, relationshipNoteKey } from '../src/core/link-relationship-notes.ts';
import { refreshRelationships } from '../src/core/link-relationships.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { compileView } from '../src/core/context/compile-view.ts';
import { loadSensitivityConfig } from '../src/core/context/sensitivity-scan.ts';
import type { PageReadScope } from '../src/core/types.ts';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;
let workspace: string;
const ids: Record<string, number> = {};
const person = 'people/notes-alice';
const company = 'companies/notes-acme';
const evidence = 'notes/restricted-departure';
const subject = { slug: person, source_id: 'default', summary: 'Alice works at Acme.' };
const publicScope: PageReadScope = { sourceId: 'default', excludePrivate: true, aclSubjectIds: [] };
const directorScope: PageReadScope = { ...publicScope, aclSubjectIds: ['director'] };

async function note(scope: PageReadScope) {
  return (await loadRelationshipNotes(engine, [subject], scope)).get(relationshipNoteKey('default', person));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  workspace = mkdtempSync(join(tmpdir(), 'relationship-notes-acl-'));
  for (const [slug, type, title, body] of [
    [person, 'person', 'Alice', 'Alice works at Acme.'],
    [company, 'company', 'Acme', 'A public company.'],
    [evidence, 'note', 'Restricted departure', 'CONFIDENTIAL_DEPARTURE_BODY'],
  ]) {
    await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} });
    const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
    ids[slug] = Number(row.id);
  }
  await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['director'], ids[evidence]]);
  await engine.addLink(person, company, 'works at Acme', 'works_at', 'markdown', person);
  await engine.executeRaw(`INSERT INTO link_transitions
    (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
    VALUES ('default', $1, $2, 'works_at', 'start', '2020-01-01', 'timeline', $1),
           ('default', $1, $2, 'works_at', 'end', '2024-07-01', 'timeline', $3)`,
  [ids[person], ids[company], ids[evidence]]);
  await refreshRelationships(engine, [{ from_page_id: ids[person], to_page_id: ids[company], link_type: 'works_at' }]);
});

afterAll(async () => {
  await engine.disconnect();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

test('the same relationship note reflects only evidence readable by each subject', async () => {
  expect(await note(publicScope)).toBeUndefined();
  expect(await note(directorScope)).toContain('ended: works_at notes-acme (2024-07-01)');
  expect(await note({ ...directorScope, aclSubjectIds: ['unrelated'] })).toBeUndefined();
  expect(await note({ sourceId: 'default', excludePrivate: true })).toContain('2024-07-01');
});

test('revoking evidence access changes the note without refreshing the shared aggregate', async () => {
  await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['other-director'], ids[evidence]]);
  try {
    expect(await note(directorScope)).toBeUndefined();
    expect(await note({ ...publicScope, aclSubjectIds: ['other-director'] })).toContain('2024-07-01');
  } finally {
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['director'], ids[evidence]]);
  }
});

test('restricted endpoints cannot be disclosed by relationship notes', async () => {
  for (const slug of [person, company]) {
    await engine.executeRaw('UPDATE pages SET acl_subject_ids = $1 WHERE id = $2', [['other-director'], ids[slug]]);
    try {
      expect(await note(directorScope)).toBeUndefined();
    } finally {
      await engine.executeRaw('UPDATE pages SET acl_subject_ids = NULL WHERE id = $1', [ids[slug]]);
    }
  }
});

test('source boundaries, deleted evidence and private evidence apply before temporal derivation', async () => {
  expect(await note({ ...directorScope, sourceId: 'ungranted-source' })).toBeUndefined();
  await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [ids[evidence]]);
  try {
    expect(await note(directorScope)).toBeUndefined();
  } finally {
    await engine.executeRaw('UPDATE pages SET deleted_at = NULL WHERE id = $1', [ids[evidence]]);
  }
  await engine.executeRaw(`UPDATE pages SET frontmatter = '{"visibility":"private"}' WHERE id = $1`, [ids[evidence]]);
  try {
    expect(await note(directorScope)).toBeUndefined();
    expect(await note({ ...directorScope, excludePrivate: false })).toContain('2024-07-01');
  } finally {
    await engine.executeRaw(`UPDATE pages SET frontmatter = '{}' WHERE id = $1`, [ids[evidence]]);
  }
});

test('ambient notes use explicit reader scope and default to public-only evidence', async () => {
  const shared = [{ slug: person, source_id: 'default', synopsis: subject.summary }];
  await appendRelationshipNotes(engine, shared);
  expect(shared[0].synopsis).toBe(subject.summary);
  const authorized = [{ slug: person, source_id: 'default', synopsis: subject.summary }];
  await appendRelationshipNotes(engine, authorized, directorScope);
  expect(authorized[0].synopsis).toContain('2024-07-01');
});

test('entity cards carry the reader scope to relationship annotations and notes', async () => {
  const publicResult = await buildEntityCard(engine, 'default', person, { remote: true, aclSubjectIds: [] });
  const directorResult = await buildEntityCard(engine, 'default', person, { remote: true, aclSubjectIds: ['director'] });
  expect(publicResult.found).toBe(true);
  expect(directorResult.found).toBe(true);
  if (!publicResult.card || !directorResult.card) throw new Error('Expected both entity cards');
  expect(publicResult.card.relationship_note).toBeUndefined();
  expect(directorResult.card.relationship_note).toContain('2024-07-01');
});

test('shared compiled context excludes ACL pages and restricted temporal evidence', async () => {
  const scanConfig = loadSensitivityConfig({ workspaceRoot: workspace, blocklist: '', userPatternsPath: join(workspace, 'none.txt') });
  const { text } = await compileView({ engine, sourceId: 'default', target: 'claude-code', budget: 4000, scanConfig });
  expect(text).toContain('Alice works at Acme');
  expect(text).not.toContain('2024-07-01');
  expect(text).not.toContain('CONFIDENTIAL_DEPARTURE_BODY');
  expect(text).not.toContain('Restricted departure');
});
