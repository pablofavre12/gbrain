import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { collectFactCandidates } from '../../src/core/search/fact-relevance.ts';
import { resolveEntitiesToPointers } from '../../src/core/context/retrieval-reflex.ts';
import { loadChronicleContext } from '../../src/core/context/chronicle-context.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';

export async function assertForkReviewReadPolicy(engine: BrainEngine): Promise<void> {
  const sourceId='review-acl';
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING",[sourceId]);
  const visible=await engine.putPage('people/visible-fixture',{type:'person',title:'Visible Fixture',compiled_truth:'Public rendezvous'}, {sourceId});
  const hidden=await engine.putPage('people/hidden-fixture',{type:'person',title:'Hidden Fixture',compiled_truth:'Secret rendezvous',acl_subject_ids:['user:alice']},{sourceId});
  await engine.setPageAliases(hidden.slug,sourceId,['scarlet fixture']);
  const alice={sourceId,aclSubjectIds:['user:alice']}, bob={sourceId,aclSubjectIds:['user:bob']};
  await engine.executeRaw('UPDATE pages SET emotional_weight=1 WHERE id=$1',[hidden.id]);
  expect((await engine.getRecentSalience({...bob,limit:1})).map(p=>p.slug)).toEqual([visible.slug]);
  expect((await engine.getRecentSalience({...alice,limit:10})).map(p=>p.slug)).toContain(hidden.slug);
  for(const [slug,mark] of [[hidden.slug,'SECRET'],[visible.slug,'PUBLIC']]) {
    await engine.insertFact({fact:`Rendezvous ${mark} coordinates`,entity_slug:slug,source:'fixture',visibility:'world'}, {source_id:sourceId});
  }
  const pool=(aclSubjectIds:string[])=>collectFactCandidates(engine,'rendezvous coordinates',{sourceId,aclSubjectIds,remote:true,excludePrivate:true},null,{depth:{keyword:1,cosine:0,entity:1}});
  expect(JSON.stringify((await pool(bob.aclSubjectIds)).candidates)).toContain('PUBLIC');
  expect(JSON.stringify((await pool(bob.aclSubjectIds)).candidates)).not.toContain('SECRET');
  const ctx=(subject:string):OperationContext=>({engine,config:{engine:engine.kind},logger:{info(){},warn(){},error(){}},remote:true,dryRun:false,sourceId,
    auth:{token:'fixture',clientId:'fixture',scopes:['read'],sourceId,allowedSources:[sourceId],subjectIds:[subject]}});
  const recall=operations.find(o=>o.name==='recall')!;
  const recalled=JSON.stringify(await recall.handler(ctx('user:bob'),{grep:'Rendezvous',limit:1}));
  expect(recalled).toContain('PUBLIC');expect(recalled).not.toContain('SECRET');
  for(const query of ['Hidden Fixture','Scarlet Fixture','Fixture']) {
    const candidates=[{query,display:query}];
    const denied=await resolveEntitiesToPointers(engine,sourceId,candidates,bob);
    expect(JSON.stringify(denied)).not.toContain(hidden.slug);
  }
  expect(JSON.stringify(await resolveEntitiesToPointers(engine,sourceId,[{query:'Scarlet Fixture',display:'Scarlet Fixture'}],alice))).toContain(hidden.slug);
  await engine.mergeOntologyFact({sourceId,entitySlug:visible.slug,dimension:'role',value:'secret role',source:hidden.slug,visibility:'world'});
  await engine.mergeOntologyFact({sourceId,entitySlug:hidden.slug,dimension:'location',value:'secret location',source:visible.slug,visibility:'world'});
  expect(await engine.getOntology(visible.slug,bob)).toEqual([]);
  expect(await engine.getOntology(hidden.slug,bob)).toEqual([]);
  expect(await engine.discoverOntologyDimensions(bob)).toEqual([]);
  expect(await engine.discoverOntologyDimensions(alice)).toHaveLength(2);
  await engine.mergeOntologyFact({sourceId,entitySlug:visible.slug,dimension:'role',value:'public role',source:visible.slug,visibility:'world'});
  await engine.executeRaw('UPDATE facts SET valid_until=NULL WHERE source_id=$1 AND dimension IS NOT NULL',[sourceId]);
  expect(await engine.findOntologyConflicts(bob)).toEqual([]);
  expect(await engine.findOntologyConflicts(alice)).toHaveLength(1);
  expect(JSON.stringify(await loadChronicleContext(engine,{...bob,remote:true,entities:[visible.slug,hidden.slug]}))).not.toContain('secret role');
  // Aggregation must not leak hidden cohorts, even when their count would trigger an anomaly.
  for(let i=0;i<4;i++) for(const secret of [false,true]) {
    const slug=`notes/${secret?'secret':'public'}-${i}`;
    await engine.putPage(slug,{type:'note',title:slug,compiled_truth:'fixture',...(secret?{acl_subject_ids:['user:alice']}: {})},{sourceId});
    await engine.addTag(slug,secret?'secret-cohort':'public-cohort',{sourceId});
  }
  expect(JSON.stringify(await engine.findAnomalies({...bob,sigma:0}))).not.toContain('secret-cohort');
  expect(JSON.stringify(await engine.findAnomalies({...alice,sigma:0}))).toContain('secret-cohort');
  // A live ACL revocation applies to the next call, with no new context/session.
  await engine.executeRaw('UPDATE pages SET acl_subject_ids=ARRAY[\'user:bob\']::text[] WHERE id=$1',[hidden.id]);
  expect(JSON.stringify(await resolveEntitiesToPointers(engine,sourceId,[{query:'Scarlet Fixture',display:'Scarlet Fixture'}],alice))).not.toContain(hidden.slug);
}
