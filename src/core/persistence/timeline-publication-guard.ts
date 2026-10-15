/** A durable, restrictive provenance fence for automatically inferred timelines.
 * Manual timeline writes do not use it. Inference only publishes from ordinary
 * public pages in the destination source; a reader's broader grants never grant
 * permission to widen the audience of the evidence.
 *
 * This is a publication-time fence. A committed timeline line becomes canonical
 * content governed by its destination page's ACL; later changes to input ACLs
 * do not retract that line. The guard is retained in the write journal, but is
 * not a live read-time dependency. Legacy inferred lines and post-publication
 * revocations therefore require a separate provenance/reconciliation policy. */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { OperationError } from '../ops/contract.ts';

export interface TimelinePublicationGuard {
  version: 1;
  sourceId: string;
  targetPageId: number;
  pageIds: number[];
  relationship?: { fromPageId: number; linkType: string };
  fingerprint: string;
}
interface GuardInput {
  sourceId: string;
  targetPageId: number;
  pageIds: number[];
  relationship?: { fromPageId: number; linkType: string };
  /** Validation executes under the same projection locks as the captured pins. */
  validate?: (tx: BrainEngine) => Promise<boolean>;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function lockEvidence(engine: BrainEngine, input: Pick<GuardInput, 'relationship'>): Promise<void> {
  // Row locks cannot protect an absent needs_rederive/flag row. These locks
  // serialize the rare inference publication with projection invalidation and
  // regeneration, while ordinary graph reads remain nonblocking.
  await engine.executeRaw('LOCK TABLE content_chunks, takes, needs_rederive, write_gate_receipts IN SHARE ROW EXCLUSIVE MODE');
  if (input.relationship) await engine.executeRaw('LOCK TABLE links, link_transitions IN SHARE ROW EXCLUSIVE MODE');
}

async function dependencyIds(engine: BrainEngine, input: GuardInput): Promise<number[]> {
  const ids = new Set([input.targetPageId, ...input.pageIds]);
  if (input.relationship) {
    const rows = await engine.executeRaw<{ id: number }>(`SELECT DISTINCT unnest(ARRAY[from_page_id,to_page_id,COALESCE(origin_page_id,from_page_id)]) AS id
      FROM links WHERE from_page_id=$1 AND link_type=$2
      UNION SELECT DISTINCT unnest(ARRAY[from_page_id,to_page_id,COALESCE(origin_page_id,from_page_id)])
      FROM link_transitions WHERE from_page_id=$1 AND link_type=$2`, [input.relationship.fromPageId, input.relationship.linkType]);
    for (const row of rows) ids.add(Number(row.id));
  }
  return [...ids].sort((a, b) => a - b);
}

async function fingerprint(engine: BrainEngine, input: GuardInput, pageIds: number[]): Promise<string | null> {
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [input.sourceId]);
  if (!source || source.archived) return null;
  // Fixed order keeps dependency locks consistent between inferred writers.
  await engine.executeRaw('SELECT id FROM pages WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE', [pageIds]);
  const params: unknown[] = [pageIds];
  const readable = pageReadFilter('p', { sourceId: input.sourceId, aclSubjectIds: [], excludePrivate: true }, params, true);
  const pages = await engine.executeRaw<{ id: number; safe: boolean; value: unknown }>(`SELECT p.id,
      (${readable} AND p.acl_subject_ids IS NULL
       AND p.type NOT IN ('atom','concept','event','question') AND p.frontmatter->'derived_from' IS NULL) AS safe,
      jsonb_build_object('id',p.id,'source',p.source_id,'slug',p.slug,'type',p.type,'title',p.title,
        'frontmatter',p.frontmatter,'compiled_truth',p.compiled_truth,'timeline',p.timeline,
        'acl',p.acl_subject_ids,'deleted',p.deleted_at,'trust',p.trust_tier,
        'effective_date',p.effective_date,'effective_date_source',p.effective_date_source,
        'revision',p.knowledge_revision,'projection_revision',p.text_projection_revision,'chunker_version',p.chunker_version) AS value
    FROM pages p WHERE p.id=ANY($1::int[]) ORDER BY p.id`, params);
  if (pages.length !== pageIds.length || pages.some(p => !p.safe)) return null;
  const chunks = await engine.executeRaw(`SELECT to_jsonb(c)-'embedding'-'embedding_image'-'embedding_multimodal'-'search_vector'-'embedded_at'-'embedded_text_hash'-'embedding_input_hash'-'embedding_pending_since'-'model' AS value
    FROM content_chunks c WHERE page_id=ANY($1::int[]) ORDER BY id`, [pageIds]);
  const takes = await engine.executeRaw(`SELECT to_jsonb(t)-'embedding'-'embedded_at' AS value FROM takes t WHERE page_id=ANY($1::int[]) ORDER BY id`, [pageIds]);
  const invalidations = await engine.executeRaw(`SELECT to_jsonb(n) AS value FROM needs_rederive n
    WHERE (derived_table='pages' AND derived_id=ANY($1::int[]::text[]))
      OR (derived_table='takes' AND derived_id IN (SELECT id::text FROM takes WHERE page_id=ANY($1::int[])))
      OR (derived_table='content_chunks' AND derived_id IN (SELECT id::text FROM content_chunks WHERE page_id=ANY($1::int[])))
    ORDER BY derived_table,derived_id`, [pageIds]);
  const flags = await engine.executeRaw(`SELECT to_jsonb(r)-'last_seen_at' AS value FROM write_gate_receipts r
    WHERE (target_table='pages' AND target_id=ANY($1::int[]::text[]))
      OR (target_table='takes' AND target_id IN (SELECT id::text FROM takes WHERE page_id=ANY($1::int[])))
    ORDER BY id`, [pageIds]);
  const relationship = input.relationship;
  const edges = relationship ? await engine.executeRaw(`SELECT to_jsonb(l) AS value FROM links l
    WHERE from_page_id=$1 AND link_type=$2 ORDER BY id`, [relationship.fromPageId, relationship.linkType]) : [];
  const transitions = relationship ? await engine.executeRaw(`SELECT to_jsonb(t) AS value FROM link_transitions t
    WHERE from_page_id=$1 AND link_type=$2 ORDER BY id`, [relationship.fromPageId, relationship.linkType]) : [];
  return hash({ source, pages: pages.map(p => p.value), chunks, takes, invalidations, flags, edges, transitions });
}

export async function captureTimelinePublicationGuard(engine: BrainEngine, input: GuardInput): Promise<TimelinePublicationGuard | null> {
  if (![input.targetPageId, ...input.pageIds].every(id => Number.isSafeInteger(id) && id > 0)) return null;
  return engine.transaction(async tx => {
    await lockEvidence(tx, input);
    const pageIds = await dependencyIds(tx, input);
    const captured = await fingerprint(tx, input, pageIds);
    if (!captured || (input.validate && !await input.validate(tx))) return null;
    return { version: 1, sourceId: input.sourceId, targetPageId: input.targetPageId, pageIds,
      ...(input.relationship ? { relationship: input.relationship } : {}), fingerprint: captured };
  });
}

export async function validateTimelinePublicationGuard(engine: BrainEngine, raw: unknown, target: { sourceId: string; pageId: number | null }): Promise<void> {
  if (raw === undefined) return;
  const fail = () => new OperationError('content_conflict', 'The inferred timeline evidence or its audience changed; nothing was published.',
    'Re-run the inference against current public evidence before submitting another timeline write.');
  const guard = raw as TimelinePublicationGuard;
  if (!guard || guard.version !== 1 || guard.sourceId !== target.sourceId || guard.targetPageId !== target.pageId
    || !Array.isArray(guard.pageIds) || !guard.pageIds.includes(guard.targetPageId)
    || !guard.pageIds.every(id => Number.isSafeInteger(id) && id > 0) || !/^[a-f0-9]{64}$/.test(guard.fingerprint)
    || (guard.relationship && (!Number.isSafeInteger(guard.relationship.fromPageId) || typeof guard.relationship.linkType !== 'string'))) throw fail();
  await lockEvidence(engine, guard);
  const ids = await dependencyIds(engine, guard);
  if (JSON.stringify(ids) !== JSON.stringify(guard.pageIds) || await fingerprint(engine, guard, ids) !== guard.fingerprint) throw fail();
}
