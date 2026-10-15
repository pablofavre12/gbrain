import { installFixtureChunks } from './helpers/page-projection.ts';
import { sealPageTextProjection } from '../src/core/page-state/projections.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DocumentVersionConflictError } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import {
  OperationError,
  operations,
  type OperationContext,
} from '../src/core/operations.ts';

let engine: PGLiteEngine;

const basePage = (title: string, body: string): PageInput => ({
  type: 'note',
  title,
  compiled_truth: body,
  timeline: '',
  frontmatter: {},
});

const op = (name: string) => {
  const found = operations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} operation missing`);
  return found;
};

function remoteCtx(subjectIds: string[], capabilities: string[] = []): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: {
      token: 'server-verified',
      clientId: 'web-bff',
      scopes: ['read', 'write'],
      principal: { kind: 'oauth_client', id: 'web-bff' },
      sourceId: 'default',
      allowedSources: ['default'],
      subjectIds,
      capabilities,
    },
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES('web-bff','fixture','Fixture','read write','default')");
});

beforeEach(async () => {
  await (engine as any).db.exec(`
    DELETE FROM links;
    DELETE FROM page_aliases;
    DELETE FROM content_chunks;
    DELETE FROM pages;
  `);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('page-level ACL is fail-closed on PGLite read surfaces', () => {
  test('legacy pages stay public while ACL pages require a matching server subject', async () => {
    await engine.putPage('docs/public', basePage('Public', 'public marker'));
    await engine.putPage('docs/private', {
      ...basePage('Private', 'private marker'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.upsertChunks('docs/public', [{
      chunk_index: 0,
      chunk_text: 'public marker',
      chunk_source: 'compiled_truth',
    }]);
    await engine.upsertChunks('docs/private', [{
      chunk_index: 0,
      chunk_text: 'private marker',
      chunk_source: 'compiled_truth',
    }]);

    await sealPageTextProjection(engine, 'docs/public', 'default');
    await sealPageTextProjection(engine, 'docs/private', 'default');
    expect(await engine.getPage('docs/private', { aclSubjectIds: ['user:alice'] })).not.toBeNull();
    expect(await engine.getPage('docs/private', { aclSubjectIds: ['user:bob'] })).toBeNull();
    expect(await engine.getPage('docs/private', { aclSubjectIds: [] })).toBeNull();
    expect(await engine.getPage('docs/private')).not.toBeNull();

    expect((await engine.listPages({ aclSubjectIds: ['user:bob'] })).map((p) => p.slug))
      .toEqual(['docs/public']);
    expect((await engine.searchKeyword('marker', { aclSubjectIds: ['user:bob'] })).map((r) => r.slug))
      .toEqual(['docs/public']);
    expect((await engine.searchKeyword('marker', { aclSubjectIds: ['user:alice'] })).map((r) => r.slug).sort())
      .toEqual(['docs/private', 'docs/public']);
  });

  test('tags, raw data, timeline and paged backlinks retain the page ACL', async () => {
    const hidden = await engine.putPage('notes/hidden-sidecars', {
      ...basePage('Hidden sidecars', 'Secret body'), acl_subject_ids: ['user:alice'],
    });
    const visible = await engine.putPage('notes/public-sidecars', basePage('Public', 'Public body'));
    await engine.addTag(hidden.slug, 'secret-tag');
    await engine.putRawData(hidden.slug, 'fixture', { secret: true });
    await engine.addTimelineEntry(hidden.slug, { date: '2026-10-15', summary: 'Secret change', source: 'fixture' });
    await engine.addLink(hidden.slug, visible.slug, 'secret context', 'mentions');
    const bob = remoteCtx(['user:bob']);
    expect(await op('get_tags').handler(bob, { slug: hidden.slug })).toEqual([]);
    expect(await op('get_raw_data').handler(bob, { slug: hidden.slug })).toEqual([]);
    expect(await op('get_timeline').handler(bob, { slug: hidden.slug })).toEqual([]);
    const links = await op('get_backlinks').handler(bob, { page_id: visible.id, group: 'page' }) as any;
    expect(links.rows).toEqual([]);
    expect(links.total).toBe(0);
    const own = await op('get_backlinks').handler(remoteCtx(['user:alice']), { page_id: visible.id, group: 'page' }) as any;
    expect(own.rows.map((row: any) => row.slug)).toEqual([hidden.slug]);
    await expect(op('get_backlinks').handler(bob, { page_id: hidden.id, group: 'page' })).rejects.toMatchObject({code:'page_not_found'});
  });

  test('open loops do not expose summaries from hidden page evidence', async () => {
    const { upsertOpenLoop, listOpenLoops } = await import('../src/core/loops/loops-store.ts');
    const hidden = await engine.putPage('notes/hidden-loop',{...basePage('Hidden','restricted body'),acl_subject_ids:['user:alice']});
    await upsertOpenLoop(engine,{sourceId:'default',dedupKey:'acl-loop',loopType:'decision_pending',summary:'hidden loop summary',
      pageSlug:hidden.slug,evidence:[{page_slug:hidden.slug}],detector:'manual'});
    expect(await listOpenLoops(engine,{sourceIds:['default'],pagePolicy:{aclSubjectIds:['user:bob']}})).toEqual([]);
    expect(await listOpenLoops(engine,{sourceIds:['default'],pagePolicy:{aclSubjectIds:['user:alice']}})).toHaveLength(1);
  });

  test('takes and batched snapshots cannot bypass page ACLs', async () => {
    const hidden = await engine.putPage('notes/hidden-take',{...basePage('Hidden','restricted body'),acl_subject_ids:['user:alice']});
    await engine.executeRaw("INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES($1,1,'secret take marker','fact','world')",[hidden.id]);
    await engine.executeRaw("UPDATE takes SET kind='bet', weight=0.8, resolved_quality='correct', resolved_at=now(), resolved_by='mcp:fixture' WHERE page_id=$1",[hidden.id]);
    expect(await op('takes_scorecard').handler(remoteCtx(['user:bob']),{})).toMatchObject({total_bets:0,mcp_resolved:0});
    expect(await op('takes_scorecard').handler(remoteCtx(['user:alice']),{})).toMatchObject({total_bets:1,mcp_resolved:1});
    expect(await op('takes_calibration').handler(remoteCtx(['user:bob']),{})).toEqual([]);
    expect(await op('takes_calibration').handler(remoteCtx(['user:alice']),{})).toHaveLength(1);
    const refs = [{slug:hidden.slug,sourceId:'default'}];
    expect((await engine.readPageSnapshotsBatch(refs,{aclSubjectIds:['user:bob']})).snapshots.size).toBe(0);
    expect((await engine.readPageSnapshotsBatch(refs,{aclSubjectIds:['user:alice']})).snapshots.size).toBe(1);
    for (const name of ['takes_list','takes_search']) {
      const args = name === 'takes_search' ? {query:'secret take marker'} : {};
      expect(await op(name).handler(remoteCtx(['user:bob']),args)).toEqual([]);
      expect(await op(name).handler(remoteCtx(['user:alice']),args)).toHaveLength(1);
    }
  });

  test('graph, aliases and backlink ranking cannot disclose an inaccessible endpoint', async () => {
    const publicPage = await engine.putPage('docs/public', basePage('Public', 'public'));
    const privatePage = await engine.putPage('docs/private', {
      ...basePage('Private', 'private'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.addLink('docs/public', 'docs/private', 'context', 'references');
    await engine.addLink('docs/private', 'docs/public', 'context', 'references');
    await engine.setPageAliases('docs/private', 'default', ['secret alias']);

    const bobGraph = await engine.traverseGraph('docs/public', 2, { aclSubjectIds: ['user:bob'] });
    expect(bobGraph.map((n) => n.slug)).toEqual(['docs/public']);
    expect(bobGraph[0]?.links).toEqual([]);

    const aliceGraph = await engine.traverseGraph('docs/public', 2, { aclSubjectIds: ['user:alice'] });
    expect(aliceGraph.map((n) => n.slug).sort()).toEqual(['docs/private', 'docs/public']);

    expect(await engine.getPageById(privatePage.id, { aclSubjectIds: ['user:bob'] })).toBeNull();
    expect((await engine.resolveAliases(['secret alias'], { aclSubjectIds: ['user:bob'] })).size).toBe(0);
    expect((await engine.resolveAliases(['secret alias'], { aclSubjectIds: ['user:alice'] })).get('secret alias'))
      .toEqual([{ slug: 'docs/private', source_id: 'default' }]);

    expect((await engine.getBacklinkCounts([publicPage.id], { aclSubjectIds: ['user:bob'] })).get(publicPage.id))
      .toBe(0);
    expect((await engine.getBacklinkCounts([publicPage.id], { aclSubjectIds: ['user:alice'] })).get(publicPage.id))
      .toBe(1);
  });

  test('operation layer derives subjects from auth and protects current + historical bodies', async () => {
    await engine.putPage('docs/private', {
      ...basePage('Private', 'historical private body'),
      acl_subject_ids: ['user:alice'],
    });
    await engine.createVersion('docs/private', { sourceId: 'default' });

    await expect(op('get_page').handler(remoteCtx(['user:bob']), {
      slug: 'docs/private',
    })).rejects.toBeInstanceOf(OperationError);

    const visible = await op('get_page').handler(remoteCtx(['user:alice']), {
      slug: 'docs/private',
    }) as any;
    expect(visible.compiled_truth).toBe('historical private body');

    expect(await op('get_versions').handler(remoteCtx(['user:bob']), {
      slug: 'docs/private',
    })).toEqual([]);
    const history = await op('get_versions').handler(remoteCtx(['user:alice']), {
      slug: 'docs/private', include_body: true,
    }) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].compiled_truth).toBe('historical private body');
  });

  test('remote history applies the same Takes and Facts redaction as get_page', async () => {
    const fencedBody = `visible prose
<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|---|---|---|---|---|---|
| 1 | private take marker | take | brain | 0.8 | 2026-01 | test |
<!--- gbrain:takes:end -->
<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | world fact marker | fact | 1 | world | high | 2026-01-01 | | test | |
| 2 | private fact marker | fact | 1 | private | high | 2026-01-01 | | test | |
<!--- gbrain:facts:end -->`;
    await engine.putPage('docs/history-fences', {
      ...basePage('History fences', fencedBody),
      acl_subject_ids: ['user:alice'],
    });
    await engine.createVersion('docs/history-fences', { sourceId: 'default' });

    const history = await op('get_versions').handler(remoteCtx(['user:alice']), {
      slug: 'docs/history-fences', include_body: true,
    }) as any[];
    expect(history[0].compiled_truth).toContain('visible prose');
    expect(history[0].compiled_truth).toContain('world fact marker');
    expect(history[0].compiled_truth).not.toContain('private take marker');
    expect(history[0].compiled_truth).not.toContain('private fact marker');
  });

  test('remote mutators require current ACL access and bind reverts to the authorized page', async () => {
    await engine.putPage('docs/protected', {
      ...basePage('Protected', 'protected-v1'),
      acl_subject_ids: ['user:alice'],
    });
    const protectedVersion = await engine.createVersion('docs/protected', { sourceId: 'default' });
    await engine.putPage('docs/other', basePage('Other', 'other-v1'));
    const otherVersion = await engine.createVersion('docs/other', { sourceId: 'default' });

    await expect(op('put_page').handler(remoteCtx(['user:bob']), {
      slug: 'docs/protected',
      content: 'attempted overwrite',
    })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(op('delete_page').handler(remoteCtx(['user:bob']), {
      slug: 'docs/protected',
    })).rejects.toMatchObject({ code: 'page_not_found' });
    await expect(op('revert_version').handler(remoteCtx(['user:bob']), {
      slug: 'docs/protected',
      version_id: protectedVersion.id,
    })).rejects.toMatchObject({ code: 'page_not_found' });
    await expect(op('revert_version').handler(remoteCtx(['user:alice']), {
      slug: 'docs/protected',
      version_id: otherVersion.id, expected_revision: (await engine.readPageSnapshot('docs/protected'))!.revision,
    })).rejects.toMatchObject({ code: 'not_found' });

    await engine.softDeletePage('docs/protected', { sourceId: 'default' });
    await expect(op('restore_page').handler(remoteCtx(['user:bob']), {
      slug: 'docs/protected',
    })).rejects.toMatchObject({ code: 'page_not_found' });
    expect((await engine.getPage('docs/protected', {
      sourceId: 'default',
      includeDeleted: true,
    }))?.deleted_at).not.toBeNull();
  });

  test('remote ACL changes must retain a server-verified caller subject', async () => {
    await expect(op('put_page').handler(remoteCtx(['user:alice']), {
      slug: 'docs/new-private',
      content: 'new private page',
      allowed_subject_ids: ['user:bob'],
    })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('remote writers cannot claim a page as a versioned document without a server capability', async () => {
    await engine.putPage('docs/public-contract', basePage('Public contract', 'legacy public body'));
    const documentWrite = {
      slug: 'docs/public-contract',
      content: 'platform version one',
      allowed_subject_ids: ['user:alice'],
      document_id: 'platform-document-123',
      document_version_sequence: 1,
      document_version_hash: 'a'.repeat(64),
      expected_revision: (await engine.readPageSnapshot('docs/public-contract'))!.revision,
    };

    await expect(op('put_page').handler(remoteCtx(['user:alice']), documentWrite))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect((await engine.getPage('docs/public-contract'))?.document_id).toBeNull();

    await expect(op('put_page').handler(
      remoteCtx(['user:alice'], ['versioned_document_write']),
      documentWrite,
    )).resolves.toMatchObject({
      slug: 'docs/public-contract',
    });
    expect((await engine.getPage('docs/public-contract', {
      aclSubjectIds: ['user:alice'],
    }))?.document_id).toBe('platform-document-123');
  });
});

describe('document version fence', () => {
  test('rejects stale/conflicting versions without changing the current page', async () => {
    const v2 = {
      ...basePage('Report', 'version two'),
      acl_subject_ids: ['user:alice'],
      document_id: 'document-123',
      document_version_sequence: 2,
      document_version_hash: '2'.repeat(64),
    };
    const first = await engine.putPage('documents/report', v2);

    const replay = await engine.putPage('documents/report', v2);
    expect(replay.id).toBe(first.id);

    await expect(engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'stale version one',
      document_version_sequence: 1,
      document_version_hash: '1'.repeat(64),
    })).rejects.toBeInstanceOf(DocumentVersionConflictError);

    await expect(engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'conflicting version two',
      document_version_hash: 'f'.repeat(64),
    })).rejects.toBeInstanceOf(DocumentVersionConflictError);

    const afterConflict = await engine.getPage('documents/report', { aclSubjectIds: ['user:alice'] });
    expect(afterConflict?.compiled_truth).toBe('version two');
    expect(afterConflict?.document_version_sequence).toBe(2);

    const v3 = await engine.putPage('documents/report', {
      ...v2,
      compiled_truth: 'version three',
      document_version_sequence: 3,
      document_version_hash: '3'.repeat(64),
    });
    expect(v3.id).toBe(first.id);
    expect(v3.document_version_sequence).toBe(3);
    expect(v3.compiled_truth).toBe('version three');
  });
});

// Value: protects=all loop evidence references are authorized before limiting;
// fails_when=evidence-only or cross-source counterparty ACL filtering is removed;
// why_new=the earlier loop fixture repeats one hidden slug in two fields;
// seam=none; no_claim=PostgreSQL parity or production loop content.
test('loop evidence-only and cross-source counterparties cannot hide the next authorized result', async () => {
  const { upsertOpenLoop, listOpenLoops } = await import('../src/core/loops/loops-store.ts');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('loop-other','Other') ON CONFLICT DO NOTHING");
  const secret = await engine.putPage('notes/evidence-only', {...basePage('Evidence','secret evidence'),acl_subject_ids:['user:alice']});
  const counterparty = await engine.putPage('people/loop-counterparty', {...basePage('Counterparty','secret person'),acl_subject_ids:['user:alice']},{sourceId:'loop-other'});
  const visible = await engine.putPage('notes/visible-loop',basePage('Visible','public evidence'));
  const common = {sourceId:'default',loopType:'decision_pending' as const,detector:'manual' as const};
  await upsertOpenLoop(engine,{...common,dedupKey:'evidence-only',summary:'EVIDENCESECRET',evidence:[{page_slug:secret.slug}],lastActivityAt:'2029-01-03T00:00:00Z'});
  await upsertOpenLoop(engine,{...common,dedupKey:'counterparty-only',summary:'COUNTERPARTYSECRET',evidence:[],counterpartySlug:counterparty.slug,counterpartySourceId:'loop-other',lastActivityAt:'2029-01-02T00:00:00Z'});
  await upsertOpenLoop(engine,{...common,dedupKey:'visible-next',summary:'VISIBLELOOP',evidence:[{page_slug:visible.slug}],lastActivityAt:'2029-01-01T00:00:00Z'});
  const scope = {sourceIds:['default','loop-other']};
  const bob = await listOpenLoops(engine,{...scope,limit:1,pagePolicy:{...scope,aclSubjectIds:['user:bob']}});
  expect(bob.map(row=>row.summary)).toEqual(['VISIBLELOOP']);
  const alice = await listOpenLoops(engine,{...scope,limit:3,pagePolicy:{...scope,aclSubjectIds:['user:alice']}});
  expect(alice.map(row=>row.summary)).toEqual(['EVIDENCESECRET','COUNTERPARTYSECRET','VISIBLELOOP']);
});

// Value: protects=metadata-only page updates and server-derived legacy client attribution;
// fails_when=no-op detection discards ACL or document metadata or accepts forged attribution;
// why_new=existing attribution tests cover upstream principal columns, not these fork columns;
// seam=none; no_claim=HTTP authentication or all maintenance writers.
test('same-body writes publish ACL and document changes with server-derived client attribution', async () => {
  const ctx = remoteCtx(['user:alice'],['versioned_document_write']);
  ctx.auth!.clientName = 'Verified fixture client';
  const slug = 'notes/metadata-only';
  const content = '---\ntitle: Metadata\ntype: note\n---\nStable body for metadata-only publication.';
  await op('put_page').handler(ctx,{slug,content,request_id:'metadata-initial'});
  const original = (await engine.getPage(slug))!;
  const revision = async () => (await engine.readPageSnapshot(slug))!.revision;
  await op('put_page').handler(ctx,{slug,content,allowed_subject_ids:['user:alice'],expected_revision:await revision(),request_id:'metadata-acl',last_write_client_id:'forged-client',last_write_client_name:'Forged'});
  const protectedPage = (await engine.getPage(slug))!;
  expect(protectedPage.content_hash).toBe(original.content_hash);
  expect(protectedPage.acl_subject_ids).toEqual(['user:alice']);
  expect(protectedPage.last_write_client_id).toBe('web-bff');
  expect(protectedPage.last_write_client_name).toBe('Verified fixture client');
  expect(await engine.getPage(slug,{aclSubjectIds:['user:bob']})).toBeNull();
  for (const sequence of [1,2]) {
    await op('put_page').handler(ctx,{slug,content,allowed_subject_ids:['user:alice'],document_id:'metadata-document',document_version_sequence:sequence,document_version_hash:String(sequence).repeat(64),expected_revision:await revision(),request_id:`metadata-document-${sequence}`});
    const stored = (await engine.getPage(slug))!;
    expect(stored.content_hash).toBe(original.content_hash);
    expect(stored.document_version_sequence).toBe(sequence);
    expect(stored.document_version_hash).toBe(String(sequence).repeat(64));
  }
  await op('log_ingest').handler(ctx,{source_type:'fixture',source_ref:'metadata-attribution',pages_updated:[slug],summary:'Synthetic ingest',last_write_client_id:'forged-client'});
  const rows = await engine.executeRaw('SELECT last_write_client_id,last_write_client_name FROM ingest_log WHERE source_ref=$1',['metadata-attribution']);
  expect(rows).toEqual([{last_write_client_id:'web-bff',last_write_client_name:'Verified fixture client'}]);
});


test('Platform document writes retain the complete version fence without a new revision parameter', async () => {
  const ctx=remoteCtx(['user:alice'],['versioned_document_write']);
  const slug='documents/platform-compatibility';
  const write=(sequence:number,body:string,hash=String(sequence).repeat(64),extra:Record<string,unknown>={})=>op('put_page').handler(ctx,{
    slug,content:`---\ntitle: Platform document\n---\n${body}`,allowed_subject_ids:['user:alice'],
    document_id:'platform-document',document_version_sequence:sequence,document_version_hash:hash,...extra,
  });
  await write(1,'version one');
  await write(2,'version two');
  await write(2,'version two');
  expect((await engine.getPage(slug))?.document_version_sequence).toBe(2);
  await expect(write(1,'stale version')).rejects.toThrow();
  await expect(write(2,'conflicting same version','f'.repeat(64))).rejects.toThrow();
  await expect(write(3,'new version','3'.repeat(64),{expected_revision:'00000000-0000-0000-0000-000000000001'})).rejects.toThrow();
  const current=await engine.getPage(slug);
  expect(current?.compiled_truth).toBe('version two');
  await expect(write(3,'content conflict','3'.repeat(64),{expected_content_hash:'0'.repeat(64),expected_page_id:current!.id})).rejects.toThrow();
  await write(3,'version three');
  expect((await engine.getPage(slug))?.document_version_sequence).toBe(3);
  await engine.putPage('notes/ordinary-revision',{type:'note',title:'Ordinary',compiled_truth:'before'});
  await expect(op('put_page').handler(ctx,{slug:'notes/ordinary-revision',content:'after'})).rejects.toMatchObject({code:'revision_required'});
});


test('evidence assembly and entity anchoring cannot expand hidden pages', async()=>{
  const {anchorOpResults}=await import('../src/core/search/entity-anchor.ts');
  const visible=await engine.putPage('people/visible-anchor',{type:'person',title:'Visible Anchor',compiled_truth:'Visible anchor body'});
  const hidden=await engine.putPage('notes/hidden-anchor',{type:'note',title:'Hidden linked note',compiled_truth:'HIDDENANCHORSECRET',acl_subject_ids:['user:alice']});
  for(const page of [visible,hidden]) {
    await installFixtureChunks(engine,page.slug,[{chunk_index:0,chunk_text:page.compiled_truth,chunk_source:'compiled_truth'}]);
  }
  await engine.addLink(hidden.slug,visible.slug,'fixture','mentions');
  const hits=(await engine.getChunks(hidden.slug)).map(c=>({source_id:'default',slug:hidden.slug,chunk_id:c.id}));
  const assembly=(subject:string)=>op('assemble_evidence').handler(remoteCtx([subject]),{hits,return_unit:'page'});
  expect(JSON.stringify(await assembly('user:alice'))).toContain('HIDDENANCHORSECRET');
  expect(JSON.stringify(await assembly('user:bob'))).not.toContain('HIDDENANCHORSECRET');
  await engine.setConfig('search.entity_anchoring','true');
  const anchored=(subject:string)=>anchorOpResults(engine,{},'Visible Anchor latest',[],{sourceId:'default',aclSubjectIds:[subject],filtered:false,evidencePlan:false});
  expect(JSON.stringify(await anchored('user:alice'))).toContain('HIDDENANCHORSECRET');
  expect(JSON.stringify(await anchored('user:bob'))).not.toContain('HIDDENANCHORSECRET');
  await engine.executeRaw("UPDATE pages SET acl_subject_ids=ARRAY['user:bob']::text[] WHERE id=$1",[hidden.id]);
  expect(JSON.stringify(await assembly('user:alice'))).not.toContain('HIDDENANCHORSECRET');
});
