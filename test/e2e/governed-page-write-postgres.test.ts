import assert from 'node:assert/strict';
import { beforeAll, afterAll, describe, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import {PostgresEngine} from '../../src/core/postgres-engine.ts';
import {operations, type OperationContext} from '../../src/core/operations.ts';
import {disposePersistenceConsumer} from '../../src/core/persistence/service.ts';
(hasDatabase() ? describe : describe.skip)('governed writes across independent PostgreSQL connections', () => {
let first: PostgresEngine;
const second=new PostgresEngine();
const context=(engine:PostgresEngine):OperationContext=>({engine, config:{engine:'postgres'},logger:{info(){},warn(){},error(){}},dryRun:false,remote:true,sourceId:'campo',auth:{token:'synthetic',clientId:'fork-governed-agent',principal:{kind:'oauth_client',id:'fork-governed-agent'},scopes:['read','write'],sourceId:'campo',allowedSources:['campo','backoffice'],federatedWrite:['backoffice'],subjectIds:['user:fixture']}});
const op=(name:string,ctx:OperationContext,p:Record<string,unknown>)=>operations.find(o=>o.name===name)!.handler(ctx,p) as Promise<any>;
beforeAll(async()=>{first=await setupDB();await second.connect({database_url:process.env.DATABASE_URL!});});
afterAll(async()=>{await disposePersistenceConsumer(first);await disposePersistenceConsumer(second);await second.disconnect();await teardownDB();});
test('confirm/confirm, confirm/cancel and persisted grant revocation preserve one canonical outcome', async()=>{
 await first.executeRaw("INSERT INTO sources(id,name) VALUES('campo','Fixture'),('backoffice','Backoffice fixture') ON CONFLICT DO NOTHING");
 await first.executeRaw("INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,federated_read,federated_write) VALUES('fork-governed-agent','fixture','Fixture','read write','campo',ARRAY['campo','backoffice'],ARRAY['backoffice']) ON CONFLICT (client_id) DO UPDATE SET federated_write=EXCLUDED.federated_write");
 const a=context(first),b=context(second);
 const propose=async(slug:string)=>op('propose_page_write',a,{slug,source:'backoffice',content:`---\ntitle: Synthetic\n---\napproved ${slug}`});
 for(let i=0;i<6;i++) {
  const slug=`notes/confirm-race-${i}`,p=await propose(slug);
  const outcomes=await Promise.all([op('confirm_page_write',a,{proposal_id:p.proposal_id}),op('confirm_page_write',b,{proposal_id:p.proposal_id})]);
  assert(outcomes.some(r=>r.status==='confirmed'));assert(outcomes.every(r=>['confirmed','confirming'].includes(r.status)));
  assert.equal((await first.executeRaw("SELECT id FROM persistence_requests WHERE client_request_id=$1",[`proposal-${p.proposal_id}`])).length,1);
  assert((await first.getPage(slug,{sourceId:'backoffice'}))?.compiled_truth.includes(`approved ${slug}`));
 }

 for(let i=0;i<8;i++) {
  const slug=`notes/cancel-race-${i}`,p=await propose(slug);
  const outcomes=await Promise.allSettled([op('confirm_page_write',a,{proposal_id:p.proposal_id}),op('cancel_page_write',b,{proposal_id:p.proposal_id})]);
  const [row]=await first.executeRaw<{status:string}>('SELECT status FROM page_write_proposals WHERE proposal_id=$1',[p.proposal_id]);
  assert(['confirmed','cancelled'].includes(row.status));
  const page=await first.getPage(slug,{sourceId:'backoffice'});
  if(row.status==='cancelled') {assert.equal(page,null);assert.equal(outcomes[0].status,'rejected');}
  else {assert(page?.compiled_truth.includes(`approved ${slug}`));assert.equal(outcomes[1].status,'rejected');}
 }

 const p=await propose('notes/revoked');
 await first.executeRaw("UPDATE oauth_clients SET federated_write=ARRAY[]::text[] WHERE client_id='fork-governed-agent'");
 let error:any;try{await op('confirm_page_write',b,{proposal_id:p.proposal_id});}catch(e){error=e;}
 assert(error);assert.equal(await first.getPage('notes/revoked',{sourceId:'backoffice'}),null);

});
});
