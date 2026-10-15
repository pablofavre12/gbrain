import { importFromContent } from '../src/core/import-file.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { startServeHttp, callTool, envelopeOf, type LiveServeHttp } from './helpers/live-mcp-servers.ts';
let engine: PGLiteEngine;
let server: LiveServeHttp;
let token: string;
beforeAll(async () => { engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('cas-room','Fixture')");
  await engine.setConfig('embedding.disabled','true');
  token = (await mintLegacyToken(engine,{ name:'cas-fixture',takesHolders:['world'],scopes:['read','write'],sourceGrant:['cas-room'] })).token;
  server = await startServeHttp(engine,{surface:'full'});
});
afterAll(async () => { await server?.close(); await engine.disconnect(); });
describe('content precondition over production HTTP MCP', () => {
  test('stale content fails and a current condition commits exactly once', async () => {
    const page = await engine.putPage('fixtures/recovery', {type:'note',title:'Fixture',compiled_truth:'first'}, {sourceId:'cas-room'});
    await engine.upsertChunks(page.slug,[{chunk_index:0,chunk_text:'first',chunk_source:'compiled_truth'}],{sourceId:'cas-room'});
    await engine.createVersion(page.slug,{sourceId:'cas-room'});
    await importFromContent(engine, page.slug, '---\ntype: note\ntitle: Fixture\n---\nconcurrent', {sourceId:'cas-room',noEmbed:true});
    const snapshot = async () => JSON.stringify(await engine.executeRaw(`SELECT
      (SELECT jsonb_agg(to_jsonb(p)) FROM pages p WHERE id=$1) AS pages,
      (SELECT jsonb_agg(to_jsonb(c)) FROM content_chunks c WHERE page_id=$1) AS chunks,
      (SELECT jsonb_agg(to_jsonb(v)) FROM page_versions v WHERE page_id=$1) AS versions`,[page.id]));
    const before=await snapshot();
    const args={slug:page.slug,source_id:'cas-room',content:'---\ntype: note\ntitle: Fixture\n---\nRecovered content.',expected_page_id:page.id,expected_content_hash:page.content_hash,request_id:'cas-stale'};
    const refused=await callTool(server.base,token,'put_page',args);
    expect(envelopeOf(refused).code).toBe('content_conflict');
    expect(await snapshot()).toBe(before);
    const current=(await engine.getPage(page.slug,{sourceId:'cas-room'}))!;
    const valid={...args,expected_content_hash:current.content_hash,request_id:'cas-current'};
    expect((await callTool(server.base,token,'put_page',valid)).isError).not.toBe(true);
    const committed=await snapshot();
    expect((await engine.getPage(page.slug,{sourceId:'cas-room'}))?.compiled_truth).toContain('Recovered content.');
    expect((await callTool(server.base,token,'put_page',valid)).isError).not.toBe(true);
    expect(await snapshot()).toBe(committed);
  });
});
