/**
 * What a per-slug sync hook actually got done. `created` is the row count
 * (unchanged reporting); `processed` is the subset of the requested slugs
 * whose file was found on disk and read successfully.
 *
 * The split exists because the watermark stamp lives at the CALL SITE: the
 * caller may only stamp `links_extracted_at` for slugs the extractor really
 * read. Stamping the whole requested set marks silently-skipped pages fresh
 * and hides them from `extract --stale` forever.
 */
export interface ExtractForSlugsResult {
  created: number;
  processed: string[];
  /** Pages whose read or write failed; they stay stale for `extract --stale`. */
  errors?: Array<{ slug: string; error: string }>;
}

/**
 * The slugs both sync hooks read, in the order the caller asked for them.
 * One `links_extracted_at` watermark covers link AND timeline extraction, so
 * a slug is only fresh when both halves read it.
 */
export function slugsSafeToStamp(
  links: ExtractForSlugsResult,
  timeline: ExtractForSlugsResult,
): string[] {
  const timelineRead = new Set(timeline.processed);
  return links.processed.filter((slug) => timelineRead.has(slug));
}

/**
 * #4304: apply the --since filter to (slug, source_id, updated_at) refs
 * BEFORE any getPage round-trip. `--since` is a "touched since" filter on
 * `updated_at` (last DB write), not the content's authored date — see the
 * module header. Semantics match the old in-loop check: keep strictly-newer
 * rows (updated_at > since); an unparseable `since` is rejected upstream in
 * runExtract, so the pass-through here is belt-and-braces only.
 */
export function filterRefsSince<T extends { updated_at: Date }>(
  refs: T[],
  since: string | undefined,
): T[] {
  if (!since) return refs;
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return refs;
  return refs.filter(r => r.updated_at.getTime() > sinceMs);
}
