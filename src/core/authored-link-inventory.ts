/** Durable authored references. Target resolution must never erase authored evidence. */
import type { BrainEngine } from './engine.ts';
import type { PageReadScope } from './types.ts';
import type { WantedPageRow, WantedProducer } from './wanted-links-store.ts';
import { executeRawJsonb } from './sql-query.ts';
import { pageReadFilter } from './search/read-policy-sql.ts';
import { makeResolver, normalizeBasename, buildBasenameIndex } from './link-extraction.ts';
import { slugifyPath } from './sync.ts';
import { opError } from './ops/contract.ts';

export interface AuthoredLinkReference {
  producer: WantedProducer;
  ref_kind: 'slug' | 'name';
  target_source_id: string;
  target_ref: string;
  link_type: string;
  resolutions?: Array<{ name: string; body?: boolean; globalBasename?: boolean; dirHint?: string | string[]; canonicalAttendance?: boolean }>;
}

/** Called with the canonical origin locked; the revision check also protects standalone effect publication. */
export async function replaceAuthoredLinkInventory(engine: Pick<BrainEngine, 'executeRaw'>,
  origin: { pageId: number; sourceId: string; revision: string }, references: AuthoredLinkReference[]): Promise<void> {
  const [previous] = await engine.executeRaw<{ observed: Date | string; refs: Array<AuthoredLinkReference & { first_seen_at: string }> | null }>(
    'SELECT clock_timestamp() AS observed,(SELECT refs FROM authored_link_inventories WHERE origin_page_id=$1 FOR UPDATE) AS refs', [origin.pageId]);
  const key = (r: AuthoredLinkReference) => [r.producer,r.ref_kind,r.target_source_id,r.target_ref].join('\0');
  const prior = new Map((previous?.refs ?? []).map(r => [key(r), r.first_seen_at]));
  const observed = new Date(previous!.observed).toISOString();
  const refs = references.map(r => ({ ...r, first_seen_at: prior.get(key(r)) ?? observed }));
  await executeRawJsonb(engine, `INSERT INTO authored_link_inventories(origin_page_id,source_id,origin_revision,refs,checked_at)
    SELECT p.id,p.source_id,p.knowledge_revision,($4::jsonb)->'refs',clock_timestamp()
    FROM pages p WHERE p.id=$1 AND p.source_id=$2 AND p.knowledge_revision=$3::uuid AND p.deleted_at IS NULL
    ON CONFLICT(origin_page_id) DO UPDATE SET origin_revision=EXCLUDED.origin_revision,refs=EXCLUDED.refs,
      checked_at=CASE WHEN authored_link_inventories.origin_revision=EXCLUDED.origin_revision
        THEN authored_link_inventories.checked_at ELSE EXCLUDED.checked_at END`,
  [origin.pageId, origin.sourceId, origin.revision], [{ refs }]);
}

export type AuthoredInventoryReader = Pick<BrainEngine, 'executeRaw' | 'getAllSlugs' | 'getPage' | 'resolveSlugWithAlias' | 'findByTitleFuzzy' | 'searchKeyword'>;

/** Full reader-relative wanted list; a missing inventory is incomplete knowledge, never an empty answer. */
export async function listAuthoredWantedPages(engine: AuthoredInventoryReader,
  opts: PageReadScope & { limit: number; offset: number }): Promise<{ total: number; rows: WantedPageRow[] }> {
  const pending = () => opError('projection_pending', 'Authored link inventory is not current for your readable pages.',
    'Run gbrain extract --stale --include-frontmatter --catch-up, then repeat wanted_pages.');
  const initialParams: unknown[] = [];
  const originRows = await engine.executeRaw<{ id: number; slug: string; knowledge_revision: string; origin_revision: string | null;
    refs: Array<AuthoredLinkReference & { first_seen_at: string }> | null }>(`SELECT o.id,o.slug,o.knowledge_revision,i.origin_revision,i.refs
    FROM pages o LEFT JOIN authored_link_inventories i ON i.origin_page_id=o.id
    WHERE ${pageReadFilter('o', opts, initialParams, true)}`, initialParams);
  if (originRows.some(o => o.origin_revision !== o.knowledge_revision)) throw pending();
  const resolvers = new Map<string, ReturnType<typeof makeResolver>>();
  const visibleSlugs = new Map<string, Promise<Set<string>>>();
  const aliases = new Map<string, Promise<Map<string, string>>>();
  const slugsFor = (sourceId: string) => {
    if (!visibleSlugs.has(sourceId)) {
      const p: unknown[] = [sourceId];
      visibleSlugs.set(sourceId, engine.executeRaw<{ slug: string }>(`SELECT t.slug FROM pages t WHERE t.source_id=$1
        AND ${pageReadFilter('t', opts, p, true)}`, p).then(rows => new Set(rows.map(row => row.slug))));
    }
    return visibleSlugs.get(sourceId)!;
  };
  const readable = async (sourceId: string, slug: string) => (await slugsFor(sourceId)).has(slug);
  const canonicalFor = async (sourceId: string, slug: string) => {
    if (!aliases.has(sourceId)) {
      // Rename aliases have one canonical target per (source, alias); renames
      // repoint prior aliases. Filter destinations before exposing the mapping.
      const p: unknown[] = [sourceId];
      aliases.set(sourceId, engine.executeRaw<{ alias_slug: string; canonical_slug: string }>(`SELECT a.alias_slug,a.canonical_slug
        FROM slug_aliases a JOIN pages t ON t.source_id=a.source_id AND t.slug=a.canonical_slug
        WHERE a.source_id=$1 AND ${pageReadFilter('t', opts, p, true)}`, p)
        .then(rows => new Map(rows.map(row => [row.alias_slug, row.canonical_slug]))));
    }
    return (await aliases.get(sourceId)!).get(slug) ?? slug;
  };
  const resolvedOrigins = [];
  for (const origin of originRows) {
    const refs = [];
    for (const reference of origin.refs ?? []) {
      const sourceId = reference.target_source_id;
      const targets = new Set<string>();
      const sourceAllowed = opts.sourceIds?.length ? opts.sourceIds.includes(sourceId) : !opts.sourceId || opts.sourceId === sourceId;
      if (sourceAllowed) {
        if (!resolvers.has(sourceId)) resolvers.set(sourceId, makeResolver(engine, { mode: 'batch', sourceId, readScope: opts, basenameIndex: async () => buildBasenameIndex(await slugsFor(sourceId)) }));
        const resolver = resolvers.get(sourceId)!;
        if (!reference.resolutions?.length) {
          if (await readable(sourceId, reference.target_ref)) targets.add(reference.target_ref);
          else if (reference.ref_kind === 'slug') {
            const canonical = await canonicalFor(sourceId, reference.target_ref);
            if (await readable(sourceId, canonical)) targets.add(canonical);
          }
        }
        for (const input of reference.resolutions ?? []) {
          if (targets.size) break;
          if (input.body) {
            // The same alternatives used by the canonical body parser: exact root forms,
            // path suffixes, and (when enabled) every basename match. No fuzzy body links.
            const raw = input.name, qualified = raw.includes('/');
            const forms = qualified ? [raw, slugifyPath(raw)] : [slugifyPath(raw), normalizeBasename(raw)];
            for (const form of forms) {
              if (await readable(sourceId, form)) { targets.add(form); break; }
              const canonical = await canonicalFor(sourceId, form);
              if (canonical !== form && await readable(sourceId, canonical)) { targets.add(canonical); break; }
            }
            const normalized = slugifyPath(raw);
            if (!targets.size && (qualified || input.globalBasename)) {
              const matches = await resolver.resolveBasenameMatches!(qualified ? normalized.slice(normalized.lastIndexOf('/') + 1) : raw);
              for (const match of matches) if (match !== origin.slug && (!qualified || match === normalized || match.endsWith('/' + normalized))) targets.add(match);
            }
          } else {
            let target = input.canonicalAttendance
              ? await resolver.resolveAttendance!(input.name, input.dirHint)
              : await resolver.resolve(input.name, input.dirHint, { globalBasename: input.globalBasename, selfSlug: origin.slug });
            if (!target && input.globalBasename && !input.canonicalAttendance) {
              const matches = (await resolver.resolveBasenameMatches!(input.name)).filter(slug => slug !== origin.slug);
              if (matches.length === 1) target = matches[0];
            }
            if (target) targets.add(target);
          }
        }
      }
      refs.push({ ...reference, resolved_targets: [...targets].map(slug => ({ source_id: sourceId, slug })) });
    }
    resolvedOrigins.push({ id: origin.id, revision: origin.knowledge_revision, refs });
  }
  const params: unknown[] = [{ origins: resolvedOrigins }];
  const originPolicy = pageReadFilter('o', opts, params, true);
  const targetPolicy = pageReadFilter('t', opts, params, true);
  const base = `WITH origins AS MATERIALIZED (
    SELECT o.id,o.slug,o.source_id,o.knowledge_revision,r.revision AS origin_revision,r.refs,i.checked_at
    FROM pages o LEFT JOIN authored_link_inventories i ON i.origin_page_id=o.id
    LEFT JOIN jsonb_to_recordset(($1::jsonb)->'origins') r(id int,revision uuid,refs jsonb)
      ON r.id=o.id AND r.revision=i.origin_revision WHERE ${originPolicy}
  ), wanted AS (
    SELECT r.*,o.slug AS origin_slug,o.source_id AS origin_source_id,o.checked_at
    FROM origins o CROSS JOIN LATERAL jsonb_to_recordset(o.refs) AS r(producer text,ref_kind text,target_source_id text,target_ref text,link_type text,resolved_targets jsonb,first_seen_at timestamptz)
    WHERE o.origin_revision=o.knowledge_revision
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(r.resolved_targets) AS rt(source_id text,slug text)
        JOIN pages t ON t.source_id=rt.source_id AND t.slug=rt.slug WHERE ${targetPolicy})
  ), grouped AS (
    SELECT target_source_id,target_ref,min(ref_kind) AS ref_kind,
      count(DISTINCT (origin_source_id,origin_slug))::int AS referenced_by,
      jsonb_agg(DISTINCT jsonb_build_object('slug',origin_slug,'source_id',origin_source_id)) AS origins,
      coalesce(jsonb_agg(DISTINCT link_type) FILTER(WHERE link_type<>''),'[]'::jsonb) AS link_types,
      min(first_seen_at) AS first_seen,max(checked_at) AS last_checked
    FROM wanted GROUP BY target_source_id,target_ref
  )`;
  const matchPolicy = pageReadFilter('m', opts, params, true);
  params.push(opts.limit, opts.offset);
  type Row = { target_source_id: string; target_ref: string; ref_kind: 'slug' | 'name'; referenced_by: number;
    origins: WantedPageRow['sample_origins']; link_types: string[]; matches: WantedPageRow['existing_matches'] | null;
    first_seen: string; last_checked: string };
  const [result] = await engine.executeRaw<{ missing: boolean; total: number; rows: Row[] | null }>(`${base}, paged AS (
    SELECT g.*,(SELECT jsonb_agg(jsonb_build_object('slug',m.slug,'source_id',m.source_id)) FROM (
      SELECT m.slug,m.source_id FROM pages m WHERE g.ref_kind='name' AND m.source_id=g.target_source_id
        AND regexp_replace(m.slug,'^.*/','')=g.target_ref AND ${matchPolicy} ORDER BY m.slug LIMIT 3) m) AS matches
    FROM grouped g ORDER BY g.referenced_by DESC,g.target_source_id,g.target_ref
    LIMIT $${params.length - 1} OFFSET $${params.length})
    SELECT EXISTS(SELECT 1 FROM origins WHERE origin_revision IS DISTINCT FROM knowledge_revision) AS missing,
      (SELECT count(*)::int FROM grouped) AS total,
      (SELECT jsonb_agg(paged ORDER BY referenced_by DESC,target_source_id,target_ref) FROM paged) AS rows`, params);
  if (result?.missing) throw pending();
  const rows = result?.rows ?? [];
  return { total: Number(result?.total ?? 0), rows: rows.map(r => ({ target: r.target_ref, target_source_id: r.target_source_id,
    ref_kind: r.ref_kind, referenced_by: Number(r.referenced_by),
    sample_origins: r.origins.sort((a,b) => a.slug.localeCompare(b.slug) || a.source_id.localeCompare(b.source_id)).slice(0,3),
    link_types: r.link_types, existing_matches: r.matches ?? [], first_seen: new Date(r.first_seen).toISOString(),
    last_checked: new Date(r.last_checked).toISOString() })) };
}
