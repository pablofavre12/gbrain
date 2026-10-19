/** Caller subjects are server-derived. SQL aliases and parameter expressions are code-owned. */
export function pageAclFilter(alias: string, subjects: string): string {
  const own = (p: string) => `(${p}.acl_subject_ids IS NULL OR ${p}.acl_subject_ids && ${subjects}::text[])`;
  const atom = (p: string) => `(CASE WHEN ${p}.type = 'atom' THEN EXISTS (
    SELECT 1 FROM pages acl_origin WHERE acl_origin.source_id = ${p}.source_id
      AND acl_origin.slug = ${p}.frontmatter->>'source_slug'
      AND acl_origin.deleted_at IS NULL AND acl_origin.type <> 'atom'
      AND NOT (acl_origin.type = 'concept' AND acl_origin.frontmatter->>'synthesized_by' IS NOT NULL)
      AND ${own('acl_origin')}
      AND EXISTS (SELECT 1 FROM derivation_inputs acl_binding
        WHERE acl_binding.derived_table='pages' AND acl_binding.derived_id=${p}.id::text
          AND acl_binding.input_table='pages' AND acl_binding.input_id=acl_origin.id::text)
      AND NOT EXISTS (SELECT 1 FROM derivation_inputs acl_other_input
        WHERE acl_other_input.derived_table='pages' AND acl_other_input.derived_id=${p}.id::text
          AND (acl_other_input.input_table<>'pages' OR acl_other_input.input_id<>acl_origin.id::text))) ELSE true END)`;
  // Stable input IDs prevent a recreated slug from granting access to an old derivation.
  // Unbound legacy atoms and chained atoms fail closed; trusted local reads omit this policy.
  // Guard casts with CASE, preserving canonical int32 text and indexable pages.id equality.
  return `(${own(alias)} AND ${atom(alias)}
    AND (CASE WHEN ${alias}.type = 'concept' AND ${alias}.frontmatter->>'synthesized_by' IS NOT NULL THEN
      EXISTS (SELECT 1 FROM derivation_inputs acl_binding WHERE acl_binding.derived_table='pages' AND acl_binding.derived_id=${alias}.id::text)
      AND NOT EXISTS (SELECT 1 FROM derivation_inputs acl_input_binding
        LEFT JOIN pages acl_input ON acl_input_binding.input_table='pages' AND acl_input.id = CASE
          WHEN acl_input_binding.input_id ~ '^(0|[1-9][0-9]{0,9}|-[1-9][0-9]{0,9})$' THEN CASE
            WHEN acl_input_binding.input_id::bigint BETWEEN -2147483648 AND 2147483647
            THEN acl_input_binding.input_id::integer ELSE NULL END
          ELSE NULL END
        WHERE acl_input_binding.derived_table='pages' AND acl_input_binding.derived_id=${alias}.id::text
          AND (acl_input.id IS NULL OR acl_input.deleted_at IS NOT NULL OR acl_input.source_id<>${alias}.source_id
            OR (acl_input.type='concept' AND acl_input.frontmatter->>'synthesized_by' IS NOT NULL)
            OR NOT ${own('acl_input')} OR NOT ${atom('acl_input')})) ELSE true END))`;
}
