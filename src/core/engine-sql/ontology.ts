import type { OntologyReadOpts, OntologyValue, OntologyDimensionStat, OntologyConflict, PageReadScope } from '../types.ts';
import { privateProvenanceFilterFragment } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

type OntologyPolicy = PageReadScope & { visibility?: OntologyReadOpts['visibility'] };

/** Entity and provenance ACLs apply before newest-value selection and aggregation. */
function policy(opts?: OntologyPolicy) {
  const scope = opts?.sourceIds?.length ? sqlFragment`AND source_id = ANY(${opts.sourceIds}::text[])`
    : sqlFragment`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
  const privacy = opts?.excludePrivate ? trustedSql(`AND ${privateProvenanceFilterFragment('facts')}`) : sqlFragment``;
  const visibility = opts?.visibility ? sqlFragment`AND visibility = ANY(${opts.visibility}::text[])` : sqlFragment``;
  const acl = opts?.aclSubjectIds === undefined ? sqlFragment`` : sqlFragment`AND NOT EXISTS (
    SELECT 1 FROM pages acl_page WHERE acl_page.source_id=facts.source_id
      AND acl_page.slug IN (facts.entity_slug,facts.source_markdown_slug)
      AND acl_page.acl_subject_ids IS NOT NULL AND NOT (acl_page.acl_subject_ids && ${opts.aclSubjectIds}::text[]))`;
  return sqlFragment`${scope} ${privacy} ${visibility} ${acl}`;
}

export async function getOntology(exec: LegacyUnscopedRead, entitySlug: string, opts?: OntologyReadOpts): Promise<OntologyValue[]> {
  const {rows}=await exec.run(sqlFragment`
    SELECT DISTINCT ON (dimension) dimension, value, confidence,
      source_markdown_slug AS source, valid_from, valid_until AS valid_to,
      COALESCE(dim_status,'active') AS status, id AS fact_id
    FROM facts WHERE entity_slug=${entitySlug} AND dimension IS NOT NULL AND expired_at IS NULL ${policy(opts)}
      AND COALESCE(valid_from,'-infinity'::timestamptz) <= COALESCE(${opts?.asof ?? null}::timestamptz,now())
      AND COALESCE(valid_until,'infinity'::timestamptz) > COALESCE(${opts?.asof ?? null}::timestamptz,now())
      AND confidence >= ${opts?.minConfidence ?? 0}
      AND (${opts?.includeQuarantined ?? false}::boolean OR dim_status IS NULL OR dim_status='active')
    ORDER BY dimension,valid_from DESC NULLS LAST,confidence DESC,id DESC`);
  return rows.map(row=>({...row,confidence:Number(row.confidence),fact_id:Number(row.fact_id)} as OntologyValue));
}

export async function discoverOntologyDimensions(exec: LegacyUnscopedRead, opts?: OntologyPolicy): Promise<OntologyDimensionStat[]> {
  const {rows}=await exec.run(sqlFragment`
    SELECT dimension,count(DISTINCT entity_slug)::int AS entities,count(*)::int AS observations
    FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL ${policy(opts)}
    GROUP BY dimension ORDER BY entities DESC,dimension`);
  return rows.map(row=>({dimension:String(row.dimension),entities:Number(row.entities),observations:Number(row.observations)}));
}

export async function findOntologyConflicts(exec: LegacyUnscopedRead, opts?: OntologyPolicy & { minConfidence?: number }): Promise<OntologyConflict[]> {
  const {rows}=await exec.run(sqlFragment`
    WITH cur AS (
      SELECT entity_slug,dimension,value,source_markdown_slug AS source,confidence,id AS fact_id
      FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL
        AND (dim_status IS NULL OR dim_status='active') AND confidence >= ${opts?.minConfidence ?? 0} ${policy(opts)}
    ) SELECT entity_slug,dimension,
      json_agg(json_build_object('value',value,'source',source,'confidence',confidence,'fact_id',fact_id)) AS values
    FROM cur GROUP BY entity_slug,dimension
    HAVING count(DISTINCT value)>=2 AND count(DISTINCT source)>=2 ORDER BY entity_slug,dimension`);
  return rows.map(row=>({entity_slug:String(row.entity_slug),dimension:String(row.dimension),
    values:typeof row.values==='string'?JSON.parse(row.values):row.values as OntologyConflict['values']}));
}
