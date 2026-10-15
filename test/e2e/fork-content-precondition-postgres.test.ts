import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
const suite = hasDatabase() ? describe : describe.skip;
suite('content CAS shares the canonical PostgreSQL writer lock', () => {
  let first: PostgresEngine;
  const second = new PostgresEngine();
  beforeAll(async () => { first = await setupDB(); await second.connect({database_url:process.env.DATABASE_URL!}); });
  afterAll(async () => { await second.disconnect(); await teardownDB(); });
  test('a competing ordinary writer commits first; stale CAS waits and changes no page effects', async () => {
    const input={type:'note',title:'Fixture',compiled_truth:'original'};
    const original=await first.putPage('fixtures/pg-cas',input);
    await first.upsertChunks(original.slug,[{chunk_index:0,chunk_text:'original',chunk_source:'compiled_truth'}]);
    await first.createVersion(original.slug);
    const snapshot=async (db: PostgresEngine | import('../../src/core/engine.ts').BrainEngine) => JSON.stringify(await db.executeRaw(`SELECT
      (SELECT jsonb_agg(to_jsonb(p)) FROM pages p WHERE id=$1) AS pages,
      (SELECT jsonb_agg(to_jsonb(c)) FROM content_chunks c WHERE page_id=$1) AS chunks,
      (SELECT jsonb_agg(to_jsonb(v)) FROM page_versions v WHERE page_id=$1) AS versions`,[original.id]));
    let release!:()=>void, locked!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const ready=new Promise<void>(resolve=>{locked=resolve;});
    let winnerState='';
    const winner=first.transaction(async tx=>{
      await tx.putPage(original.slug,{...input,compiled_truth:'competing writer'});
      winnerState=await snapshot(tx); locked(); await hold;
    });
    await ready;
    let waitingPid=0;
    const loser=second.transaction(async tx=>{
      waitingPid=Number((await tx.executeRaw<{pid:number}>('SELECT pg_backend_pid() AS pid'))[0].pid);
      return tx.putPage(original.slug,{...input,compiled_truth:'stale recovery'},
        {sourceId:'default',expectedPageId:original.id,expectedContentHash:original.content_hash});
    }).then(()=>null,error=>error);
    try {
      let blocked=false;
      for(let i=0;i<100;i++) {
        if(waitingPid) blocked=(await first.executeRaw<{blocked:boolean}>("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[waitingPid]))[0]?.blocked===true;
        if(blocked) break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(blocked).toBe(true);
    } finally { release(); await winner; }
    expect(await loser).toMatchObject({code:'content_conflict'});
    expect(await snapshot(first)).toBe(winnerState);
  });
});
