/** Read-time temporal state. Authorization precedes aggregation, so hidden
 * evidence cannot change a visible relationship's dates, status or timestamps. */
import type { PageReadScope } from './types.ts';
import { hasReadPolicy, pageReadFilter } from './search/read-policy-sql.ts';
import { sqlFragment, type SqlFragment } from './engine-sql/fragment.ts';

/** Compose a positional fragment while retaining every value as a binding.
 * Only generated SQL enters this adapter; policy strings never enter the text. */
export function temporalSqlFragment(build: (params: unknown[]) => string): SqlFragment {
  const params: unknown[] = [];
  const text = build(params);
  const strings: string[] = [];
  const values: unknown[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\$(\d+)\b/g)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= params.length) throw new TypeError('Missing temporal SQL binding');
    strings.push(text.slice(offset, match.index));
    values.push(params[index]);
    offset = match.index! + match[0].length;
  }
  strings.push(text.slice(offset));
  return sqlFragment(Object.assign(strings, { raw: [...strings] }), ...values);
}

/** Unrestricted local readers can use the writer-maintained projection. */
export function needsScopedTemporalState(scope: PageReadScope): boolean {
  return hasReadPolicy(scope);
}

/** Use the canonical read policy on fixed aliases, appending bound values. */
export function temporalEvidencePageSql(alias: string, scope: PageReadScope, params: unknown[]): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new TypeError('Invalid temporal page alias');
  return pageReadFilter(alias, scope, params, true);
}

/**
 * A correlated relation with the columns consumed by temporal graph readers.
 * Consecutive equal transition kinds collapse: their first event opens/closes
 * a stint. An initial end supplies the implicit (-infinity, end) stint.
 * range_agg merges touching intervals, including an end/start on the same day,
 * matching buildRelationshipState without depending on arrival order.
 *
 * Shared projection history is deliberately absent. recorded_at is the first
 * authorized evidence timestamp, and retired_at is the latest authorized
 * evidence timestamp when that evidence currently describes an ended state.
 * Permission revocations and edits therefore take effect in the same snapshot
 * as the read, without waiting for a materialized projection refresh.
 */
export function scopedTemporalStateSql(
  linkAlias: string,
  scope: PageReadScope,
  semantics: readonly { linkType: string; semantics: 'state' | 'event' }[],
  params: unknown[],
): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(linkAlias)) throw new TypeError('Invalid temporal link alias');
  const matches = (alias: string) => `${alias}.from_page_id = ${linkAlias}.from_page_id
      AND ${alias}.to_page_id = ${linkAlias}.to_page_id AND ${alias}.link_type = ${linkAlias}.link_type`;
  const semanticsSql = semantics.map(s => {
    params.push(s.linkType, s.semantics);
    return `WHEN $${params.length - 1}::text THEN $${params.length}::text`;
  }).join(' ');
  // Writers persist each relationship's declaration. Prefer that metadata so
  // cold readers (and readers after another brain primes the process registry)
  // retain pack types and built-in overrides. Never read shared temporal state:
  // every date, count and status below comes solely from authorized evidence.
  const storedSemantics = `(SELECT tm.semantics FROM link_relationships tm
    WHERE ${matches('tm')} AND tm.scope = 'all' AND tm.semantics IN ('state', 'event'))`;
  const endpoints = `JOIN pages tf ON tf.id = ${linkAlias}.from_page_id
        JOIN pages tt ON tt.id = ${linkAlias}.to_page_id`;
  const readableEndpoints = `${temporalEvidencePageSql('tf', scope, params)} AND ${temporalEvidencePageSql('tt', scope, params)}`;
  return `WITH
    temporal_assertions AS (
      SELECT COALESCE(ta.assertion_tense, 'present') AS tense,
        COALESCE(ta.origin_page_id, ta.from_page_id) AS origin_id, ta.created_at
      FROM links ta ${endpoints}
      JOIN pages tor ON tor.id = COALESCE(ta.origin_page_id, ta.from_page_id)
      WHERE ${matches('ta')} AND ${readableEndpoints}
        AND tor.source_id = tf.source_id AND ${temporalEvidencePageSql('tor', scope, params)}
    ),
    temporal_transitions AS (
      SELECT tx.kind, tx.occurred_on, tx.created_at
      FROM link_transitions tx ${endpoints}
      LEFT JOIN pages tor ON tor.id = tx.origin_page_id
      WHERE ${matches('tx')} AND ${readableEndpoints}
        AND (tx.origin_page_id IS NULL OR (tor.source_id = tf.source_id AND ${temporalEvidencePageSql('tor', scope, params)}))
    ),
    temporal_events AS (
      SELECT kind, occurred_on, lag(kind) OVER (ORDER BY occurred_on, kind) AS previous_kind
      FROM (SELECT DISTINCT kind, occurred_on FROM temporal_transitions) td
    ),
    temporal_changes AS (
      SELECT kind, occurred_on, row_number() OVER (ORDER BY occurred_on, kind) AS position,
        lead(occurred_on) OVER (ORDER BY occurred_on, kind) AS next_date
      FROM temporal_events WHERE previous_kind IS DISTINCT FROM kind
    ),
    temporal_summary AS (
      SELECT COALESCE(${storedSemantics}, CASE ${linkAlias}.link_type ${semanticsSql} END) AS semantics,
        (SELECT count(*) FROM temporal_assertions WHERE tense = 'present') AS undated_present,
        (SELECT count(*) FROM temporal_assertions WHERE tense = 'past') AS undated_past,
        (SELECT count(*) FROM temporal_transitions) AS dated_count,
        (SELECT min(occurred_on) FROM temporal_transitions WHERE kind = 'start') AS first_start,
        (SELECT kind FROM temporal_changes ORDER BY position DESC LIMIT 1) AS last_kind,
        (SELECT min(created_at) FROM (
          SELECT created_at FROM temporal_assertions UNION ALL SELECT created_at FROM temporal_transitions
        ) te) AS recorded_at,
        (SELECT max(created_at) FROM (
          SELECT created_at FROM temporal_assertions UNION ALL SELECT created_at FROM temporal_transitions
        ) te) AS latest_evidence_at,
        EXISTS (SELECT 1 FROM temporal_assertions ap WHERE ap.tense = 'past'
          AND NOT EXISTS (SELECT 1 FROM temporal_assertions an
            WHERE an.tense = 'present' AND an.origin_id IS NOT DISTINCT FROM ap.origin_id)) AS other_origin_past
    ),
    temporal_ranges AS (
      SELECT ts.*,
        CASE WHEN semantics = 'event' THEN datemultirange(daterange((SELECT min(occurred_on) FROM temporal_transitions), NULL))
          WHEN dated_count = 0 THEN CASE WHEN undated_present > 0 THEN datemultirange(daterange(NULL::date, NULL::date)) ELSE '{}'::datemultirange END
          ELSE COALESCE((SELECT range_agg(stint) FROM (
            SELECT daterange(occurred_on, next_date) AS stint FROM temporal_changes WHERE kind = 'start'
            UNION ALL SELECT daterange(NULL::date, occurred_on) FROM temporal_changes WHERE kind = 'end' AND position = 1
          ) tr), '{}'::datemultirange) END AS valid_ranges
      FROM temporal_summary ts
      WHERE semantics IS NOT NULL AND (undated_present + undated_past + dated_count) > 0
    )
    SELECT valid_ranges, semantics, undated_past, first_start, recorded_at,
      (semantics = 'state' AND undated_present > 0 AND undated_past > 0 AND other_origin_past
        AND (dated_count = 0 OR last_kind = 'start')) AS disputed,
      CASE WHEN semantics = 'state' AND NOT (valid_ranges @> (now() AT TIME ZONE 'UTC')::date)
        AND (isempty(valid_ranges) OR lower_inf(valid_ranges) OR lower(valid_ranges) <= (now() AT TIME ZONE 'UTC')::date)
        THEN latest_evidence_at ELSE NULL END AS retired_at
    FROM temporal_ranges`;
}
