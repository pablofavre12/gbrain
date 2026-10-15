/** Synthetic-only legacy 9007 rehearsal. Supply an engine checkout, not a live brain. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const { values } = parseArgs({options:{engine:{type:'string'},mode:{type:'string'},evidence:{type:'string'}}});
if (!values.engine || !['seed','upgrade','drain','inventory'].includes(values.mode ?? '') || !values.evidence) throw new Error('Use --engine CHECKOUT --mode seed|upgrade|drain|inventory --evidence FILE');
const url = process.env.GBRAIN_REHEARSAL_URL;
if (!url) throw new Error('GBRAIN_REHEARSAL_URL is required');
const target = new URL(url);
if (!['127.0.0.1','localhost'].includes(target.hostname) || target.pathname !== '/gbrain_port_rehearsal') throw new Error('Only a local disposable gbrain_port_rehearsal database is permitted');
const {PostgresEngine} = await import(pathToFileURL(resolve(values.engine,'src/core/postgres-engine.ts')).href);
const engine = new PostgresEngine();
const vector = (n:number) => '['+Array.from({length:n},(_,i)=>i===0?1:0).join(',')+']';
try {
  await engine.connect({database_url:url});
  if (values.mode === 'seed') {
    await engine.initSchema();
    if (await engine.getConfig('version') !== '9007') throw new Error('Seed must use the production 9007 baseline');
    if ((await engine.executeRaw('SELECT id FROM pages LIMIT 1')).length) throw new Error('Seed requires an empty database');
    // Align the empty synthetic chunk column with the legacy takes dimension.
    await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(1536)');
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES
      ('room-a','Room A','{"schema_pack":"fixture-a"}'),('room-b','Room B','{"schema_pack":"fixture-b"}')`);
    for (const sourceId of ['room-a','room-b']) {
      const page=await engine.putPage('docs/shared',{type:'note',title:'Synthetic',compiled_truth:`Synthetic ${sourceId}`,frontmatter:{fixture:true},acl_subject_ids:['user:fixture'],document_id:`doc-${sourceId}`,document_version_sequence:4,document_version_hash:'a'.repeat(64)},{sourceId});
      await engine.upsertChunks('docs/shared',[{chunk_index:0,chunk_text:`Synthetic ${sourceId}`,chunk_source:'compiled_truth'}],{sourceId});
      await engine.createVersion('docs/shared',{sourceId});
      await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,embedding,embedded_at) VALUES($1,1,'Synthetic take','fact','world',$2::vector,now())`,[page.id,vector(1536)]);
    }
    await engine.executeRaw(`UPDATE content_chunks SET embedding=$1::vector,embedded_at=now(),model='openai:text-embedding-3-small'`,[vector(1536)]);
    await engine.addLink('docs/shared','docs/shared','Synthetic link','references','manual',undefined,undefined,{fromSourceId:'room-a',toSourceId:'room-b'}); // gbrain-allow-direct-insert: synthetic isolated migration fixture, never a live brain
    await engine.setConfig('embedding_dimensions','1536');
    await engine.setConfig('embedding_model','openai:text-embedding-3-small');
    await engine.setConfig('chat_model','openrouter:anthropic/claude-haiku-4.5');
    await engine.setConfig('search.reranker.model','cohere:rerank-v4.0-pro');
    await engine.setConfig('schema_pack','fixture-global');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,federated_read,federated_write) VALUES('fixture-client','Fixture','read write','room-a',ARRAY['room-a','room-b'],ARRAY['room-b'])`);
    const content='Synthetic pending proposal';
    await engine.executeRaw(`INSERT INTO page_write_proposals(proposal_id,actor_id,source_id,slug,content,content_hash,expires_at) VALUES($1,'user:fixture','room-a','notes/pending',$2,$3,now()+interval '1 day')`,[randomUUID(),content,createHash('sha256').update(content).digest('hex')]);
  } else if (values.mode === 'upgrade') {
    const {runMigrations} = await import(pathToFileURL(resolve(values.engine,'src/core/migrate.ts')).href);
    const first=await runMigrations(engine);
    const second=await runMigrations(engine);
    if (second.applied !== 0) throw new Error('Migration rerun was not a no-op');
    console.log(JSON.stringify({applied:first.applied,rerun:second.applied,version:await engine.getConfig('version'),upstream:await engine.getConfig('schema.upstream_version')}));
  }
  if (values.mode === 'drain') {
    const {configureGateway} = await import(pathToFileURL(resolve(values.engine,'src/core/ai/gateway.ts')).href);
    configureGateway({embedding_model:await engine.getConfig('embedding_model'),embedding_dimensions:1536,env:{}});
    const {drainProjections} = await import(pathToFileURL(resolve(values.engine,'src/core/page-state/projections.ts')).href);
    const drained=await drainProjections(engine);
    if (drained.remaining || drained.failed.length) throw new Error(`Projection drain incomplete: ${JSON.stringify(drained)}`);
    const retrieval:Record<string,unknown>={};
    for(const sourceId of ['room-a','room-b']) {
      const policy={sourceId,aclSubjectIds:['user:fixture'],limit:5};
      const keyword=await engine.searchKeyword('Synthetic',policy);
      const semantic=await engine.searchVector(Float32Array.from({length:1536},(_,i)=>i===0?1:0),policy);
      if (!keyword.some((r:{slug:string})=>r.slug==='docs/shared') || !semantic.some((r:{slug:string})=>r.slug==='docs/shared')) throw new Error(`Retrieval missing after projection drain in ${sourceId}`);
      if ((await engine.searchKeyword('Synthetic',{...policy,aclSubjectIds:['user:denied']})).length) throw new Error('ACL failed after projection drain');
      retrieval[sourceId]={keyword:keyword.length,vector:semantic.length};
    }
    console.log(JSON.stringify({drained,retrieval}));
  }
  const queries = {
    pages:'SELECT id,source_id,slug,title,compiled_truth,content_hash,acl_subject_ids,document_id,document_version_sequence,document_version_hash FROM pages ORDER BY id',
    chunks:'SELECT id,page_id,chunk_index,chunk_text,model,embedding::text,embedded_at FROM content_chunks ORDER BY id',
    versions:'SELECT id,page_id,compiled_truth,frontmatter,snapshot_at FROM page_versions ORDER BY id',
    takes:'SELECT id,page_id,row_num,claim,embedding::text,embedded_at FROM takes ORDER BY id',
    links:'SELECT from_page_id,to_page_id,link_type,context FROM links ORDER BY from_page_id,to_page_id',
    sources:"SELECT id,name,config FROM sources WHERE id IN ('room-a','room-b') ORDER BY id",
    clients:"SELECT client_id,client_name,scope,source_id,federated_read,federated_write FROM oauth_clients WHERE client_id='fixture-client'",
    proposals:'SELECT proposal_id,actor_id,source_id,slug,content,content_hash,status,expires_at FROM page_write_proposals ORDER BY proposal_id',
    config:"SELECT key,value FROM config WHERE key IN ('embedding_model','embedding_dimensions','chat_model','search.reranker.model','schema_pack') ORDER BY key",
  };
  const inventory:Record<string,unknown>={};
  for(const [name,sql] of Object.entries(queries)) inventory[name]=await engine.executeRaw(sql);
  const serialized=JSON.stringify(inventory,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n';
  await Bun.write(values.evidence,serialized);
  console.log(JSON.stringify({inventory:values.evidence,sha256:createHash('sha256').update(serialized).digest('hex')}));
} finally { await engine.disconnect(); }
