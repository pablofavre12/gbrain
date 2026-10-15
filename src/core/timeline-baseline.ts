import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';

/** Baselines use the same page writer as explicit timeline changes. */
export async function applyTimelineBaseline(engine: BrainEngine, opts?: {sourceId?: string}): Promise<{created:number}> {
  const rows = await engine.executeRaw<{slug:string;source_id:string;date:string}>(`
    SELECT p.slug,p.source_id,to_char(COALESCE((SELECT min(v.snapshot_at) FROM page_versions v WHERE v.page_id=p.id),p.created_at),'YYYY-MM-DD') AS date
    FROM pages p WHERE p.type IN ('person','company') AND p.deleted_at IS NULL
      AND ($1::text IS NULL OR p.source_id=$1)
      AND NOT EXISTS(SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id)
    ORDER BY p.source_id,p.id`,[opts?.sourceId ?? null]);
  const {operations} = await import('./operations.ts');
  const op = operations.filter(op => !op.localOnly).find(op=>op.name==='add_timeline_entry')!;
  for (const row of rows) {
    const requestId = 'timeline-baseline-' + createHash('sha256').update(JSON.stringify(row)).digest('hex');
    await op.handler({engine,sourceId:row.source_id,remote:false,dryRun:false,config:{engine:engine.kind,embedding_disabled:true},logger:console},
      {slug:row.slug,date:row.date,source:'baseline',summary:'Page created',request_id:requestId});
  }
  return {created:rows.length};
}
