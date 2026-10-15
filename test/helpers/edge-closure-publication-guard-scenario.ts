import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { refreshRelationships } from '../../src/core/link-relationships.ts';
import { runPhaseEdgeContradictions, applyEdgeProposal } from '../../src/core/cycle/edge-contradictions.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../../src/core/schema-pack/bundled-assets.ts';

export function defineEdgeClosurePublicationGuardTests(engineOf: () => BrainEngine) {
let engine: BrainEngine;
const ctx = (): OperationContext => ({ engine, config: {engine:engine.kind}, remote:false, dryRun:false, sourceId:'default', logger:{info(){},warn(){},error(){}} });
const op = (name: string) => operations.find(o => o.name === name)!;
const subjectSlug = 'people/closure-example';
const conflict = async () => [{a:1,b:2,conflict:true,confidence:1}];
beforeEach(() => { installFaultHook(undefined); engine = engineOf(); });
afterAll(() => { installFaultHook(undefined); });
async function put(slug: string, type: string, body: string) {
  const snapshot = await engine.readPageSnapshot(slug,{sourceId:'default'});
  await op('put_page').handler(ctx(), {slug,...(snapshot ? {expected_revision:snapshot.revision} : {}),content:`---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}`});
  return (await engine.getPage(slug, {sourceId:'default'}))!.id;
}
async function seed() {
  const a = await put('companies/closure-a','company','Company A');
  const b = await put('companies/closure-b','company','Company B');
  const from = await put(subjectSlug,'person','Works at [Company A](../companies/closure-a) and [Company B](../companies/closure-b).\n\n## Timeline\n\n- **2019-01-01** | test — joined [Company A](../companies/closure-a)\n- **2024-01-01** | test — joined [Company B](../companies/closure-b)');
  await engine.setConfig('dream.edge_contradictions.mode','propose');
  return {a,b,from};
}
async function proposal() {
  const result = await runPhaseEdgeContradictions(engine,{judge:conflict});
  expect(result.totals?.proposed).toBe(1);
  const [row] = await engine.executeRaw<{id:number}>('SELECT id FROM link_edge_proposals ORDER BY id DESC LIMIT 1');
  return Number(row.id);
}
const timeline = async () => (await engine.getPage(subjectSlug,{sourceId:'default'}))!.timeline;

describe('inferred edge closures preserve the publication audience', () => {
  test('ordinary public evidence still publishes through the canonical writer', async () => {
    await seed();
    const id = await proposal();
    expect((await applyEdgeProposal(engine,id)).status).toBe('applied');
    expect(await timeline()).toContain('gbrain-dream (inferred)');
  });

  test('a restricted contributor never reaches the judge or the public timeline', async () => {
    const {from,b} = await seed();
    const origin = await put('notes/closure-restricted','note','Restricted contribution');
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],origin]);
    await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source,origin_page_id,context)
      VALUES($1,$2,'works_at','restricted',$3,'Restricted context')`,[from,b,origin]);
    await refreshRelationships(engine,[{from_page_id:from,to_page_id:b,link_type:'works_at'}]);
    let calls = 0;
    await engine.setConfig('dream.edge_contradictions.mode','apply');
    await runPhaseEdgeContradictions(engine,{judge:async () => { calls++; return conflict(); }});
    expect(calls).toBe(0);
    expect(await timeline()).not.toContain('gbrain-dream');
  });

  test('a proposal is stale when permissions change without a relationship-cache refresh', async () => {
    const {b} = await seed();
    const id = await proposal();
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],b]);
    expect((await applyEdgeProposal(engine,id)).status).toBe('stale');
    expect(await timeline()).not.toContain('gbrain-dream');
  });

  test('a stale proposal recovers after its evidence becomes public again', async () => {
    const {b} = await seed();
    const id = await proposal();
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],b]);
    expect((await applyEdgeProposal(engine,id)).status).toBe('stale');
    let calls = 0;
    const judge = async () => { calls++; return conflict(); };
    await runPhaseEdgeContradictions(engine,{judge});
    expect(calls).toBe(0);
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=NULL WHERE id=$1',[b]);
    const rerun = await runPhaseEdgeContradictions(engine,{judge});
    expect(rerun.totals?.proposed).toBe(1);
    expect(calls).toBe(1);
    await runPhaseEdgeContradictions(engine,{judge});
    expect(calls).toBe(1);
    expect((await engine.executeRaw('SELECT id FROM link_edge_proposals')).length).toBe(1);
    expect((await applyEdgeProposal(engine,id)).status).toBe('applied');
    expect(await timeline()).toContain('gbrain-dream (inferred)');
  });

  test('rerunning refreshes an open proof after a target edit without changing the relationship', async () => {
    await seed();
    const id = await proposal();
    const [before] = await engine.executeRaw<{evidence_hash:string;detail:string}>('SELECT evidence_hash,detail FROM link_edge_proposals WHERE id=$1',[id]);
    await put('companies/closure-b','company','Company B with a new public description');
    const rerun = await runPhaseEdgeContradictions(engine,{judge:conflict});
    expect(rerun.totals?.judged).toBe(1);
    const [after] = await engine.executeRaw<{evidence_hash:string;detail:string}>('SELECT evidence_hash,detail FROM link_edge_proposals WHERE id=$1',[id]);
    expect(after.evidence_hash).toBe(before.evidence_hash);
    expect(after.detail).not.toBe(before.detail);
    expect((await applyEdgeProposal(engine,id)).status).toBe('applied');
  });

  test('a failed renewal retains the judge error backoff', async () => {
    const {b} = await seed();
    const id = await proposal();
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],b]);
    expect((await applyEdgeProposal(engine,id)).status).toBe('stale');
    await engine.executeRaw('UPDATE pages SET acl_subject_ids=NULL WHERE id=$1',[b]);
    let calls = 0;
    const judge = async () => { calls++; return null; };
    await runPhaseEdgeContradictions(engine,{judge});
    await runPhaseEdgeContradictions(engine,{judge});
    expect(calls).toBe(1);
    const [row] = await engine.executeRaw<{status:string;detail:string}>('SELECT status,detail FROM link_edge_proposals WHERE id=$1',[id]);
    expect(row.status).toBe('error');
    expect(row.detail).toStartWith('attempt 1/3;');
  });

  test.each(['rejected', 'reverted_by_user'])('renewing evidence preserves a %s decision', async (status) => {
    await seed();
    const id = await proposal();
    await engine.executeRaw('UPDATE link_edge_proposals SET status=$2,detail=NULL WHERE id=$1',[id,status]);
    await put('companies/closure-b','company','Company B with a new public description');
    let calls = 0;
    await runPhaseEdgeContradictions(engine,{judge:async () => { calls++; return conflict(); }});
    expect(calls).toBe(0);
    const [row] = await engine.executeRaw<{status:string}>('SELECT status FROM link_edge_proposals WHERE id=$1',[id]);
    expect(row.status).toBe(status);
    expect(await timeline()).not.toContain('gbrain-dream');
  });

  test.each([false, true])('declared chains recapture evidence after each closure (revoke successor: %s)', async (revoke) => {
    const root = mkdtempSync(join(tmpdir(),'gbrain-closure-chain-'));
    const pack = {api_version:'gbrain-schema-pack-v1',name:'closure-chain-fixture',version:'1.0.0',extends:'gbrain-base',
      page_types:[],frontmatter_links:[],link_types:[{name:'works_at',cardinality:'one_per_from'}]};
    writeFileSync(join(root,'pack.json'),JSON.stringify(pack));
    __setPackLocatorForTests(name => name === pack.name ? join(root,'pack.json') : bundledPackPath(name));
    _resetPackCacheForTests();
    try {
      await engine.setConfig('schema_pack',pack.name);
      await seed();
      const c = await put('companies/closure-c','company','Company C');
      await put(subjectSlug,'person','Works at [Company A](../companies/closure-a), [Company B](../companies/closure-b), and [Company C](../companies/closure-c).\n\n## Timeline\n\n- **2019-01-01** | test — joined [Company A](../companies/closure-a)\n- **2024-01-01** | test — joined [Company B](../companies/closure-b)\n- **2025-01-01** | test — joined [Company C](../companies/closure-c)');
      const noJudge = async () => { throw new Error('Declared chains do not use a model'); };
      const initial = await runPhaseEdgeContradictions(engine,{judge:noJudge});
      expect(initial.totals?.declared_proposed).toBe(2);
      // A legacy open proposal must be renewed through the deterministic path too.
      await engine.executeRaw('UPDATE link_edge_proposals SET detail=NULL WHERE id=(SELECT min(id) FROM link_edge_proposals)');
      await engine.setConfig('dream.single_value.mode','apply');
      let applies = 0;
      const result = await runPhaseEdgeContradictions(engine,{
        judge:noJudge,
        applier:async (db,id) => {
          const result = await applyEdgeProposal(db,id);
          applies++;
          if (revoke && applies === 1) await db.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],c]);
          return result;
        },
      });
      expect(result.totals?.declared_applied).toBe(revoke ? 1 : 2);
      expect(applies).toBe(revoke ? 1 : 2);
      expect((await timeline()).match(/gbrain-dream \(inferred\)/g)?.length).toBe(revoke ? 1 : 2);
    } finally {
      _resetPackLocatorForTests();
      _resetPackCacheForTests();
      rmSync(root,{recursive:true,force:true});
    }
  });

  test('a permission change during judging cannot be published automatically', async () => {
    const {b} = await seed();
    await engine.setConfig('dream.edge_contradictions.mode','apply');
    const result = await runPhaseEdgeContradictions(engine,{judge:async () => {
      await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],b]);
      return conflict();
    }});
    expect(result.totals?.applied).toBe(0);
    expect(await timeline()).not.toContain('gbrain-dream');
  });

  test('publication rechecks permissions after canonical preparation', async () => {
    const {b} = await seed();
    const id = await proposal();
    let revoked = false;
    installFaultHook(async (point, detail) => {
      if (point === 'consumer:prepared' && detail.operation === 'add_timeline_entry' && !revoked) {
        revoked = true;
        await engine.executeRaw('UPDATE pages SET acl_subject_ids=$1::text[] WHERE id=$2',[['reader:director'],b]);
      }
    });
    try {
      expect((await applyEdgeProposal(engine,id)).status).not.toBe('applied');
      expect(revoked).toBe(true);
      expect(await timeline()).not.toContain('gbrain-dream');
    } finally { installFaultHook(undefined); }
  }, 30000);

  test('legacy proposals and raw replayed guard parameters cannot bypass provenance', async () => {
    await seed();
    const id = await proposal();
    await engine.executeRaw('UPDATE link_edge_proposals SET detail=NULL WHERE id=$1',[id]);
    expect((await applyEdgeProposal(engine,id)).status).toBe('refused');
    await expect(op('add_timeline_entry').handler(ctx(), {slug:subjectSlug,date:'2024-01-01',summary:'unsafe replay',timeline_publication_guard:{version:1}}))
      .rejects.toThrow('Stored inference provenance');
    expect(await timeline()).not.toContain('unsafe replay');
    const rerun = await runPhaseEdgeContradictions(engine,{judge:conflict});
    expect(rerun.totals?.proposed).toBe(1);
    expect((await applyEdgeProposal(engine,id)).status).toBe('applied');
  });
});

}
