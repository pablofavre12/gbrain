import { SLUG_WORD_CHARS, SLUG_VARIATION_SELECTORS_RE } from './cjk.ts';
import { foldNonDecomposingLatin } from './latin-fold.ts';

/**
 * Issue #972 (codex [P2] DRY): the ONE basename matcher. makeResolver, the
 * FS resolver, and the doctor `link_resolution_opportunity` check all
 * build/query through these two functions so they cannot drift.
 *
 * Keying: raw tail + lowercase tail + slugified tail (the final `/`-segment,
 * or the whole slug when it has no `/`). #2367: slugified keys follow
 * slugifySegment (NFD → strip accents → NFC → lowercase → SLUG_WORD_CHARS
 * filter) and then fold stroke letters through latin-fold (#4855), so for
 * names with đ/ø/ł/ß… the key is NOT byte-identical to the page slug sync
 * mints; the dir-hint candidate step (makeResolver step 2, the FS resolver)
 * tries both forms. The old ASCII-only strip emptied CJK basenames.
 */
const BASENAME_KEEP_RE = new RegExp(`[^${SLUG_WORD_CHARS}\\s\\-]`, 'gu');
export function normalizeBasename(s: string): string {
  // The accent strip cannot fold stroke letters \u2014 Unicode gives them no
  // decomposition \u2014 so the shared table runs after it, on both the index and
  // the query side. Without it a display name keeps the unfolded letter while
  // the ASCII page slug does not, and the lookup misses in silence:
  // `[[\u0110\u1ee9c Example]]` keyed `\u0111uc-example` and never found `people/duc-example`.
  const folded = foldNonDecomposingLatin(
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
      .replace(SLUG_VARIATION_SELECTORS_RE, '').toLowerCase(), // twin of slugifySegment's strip (#4985)
  );
  return folded.replace(BASENAME_KEEP_RE, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Stable order: shorter slug first (likely closer to brain root), then lexical. */
function basenameSort(a: string, b: string): number {
  return (a.length - b.length) || a.localeCompare(b);
}

/** Build a `key → slug[]` index over a slug collection, or add the slugs to `idx`. Keys: raw/lower/slugified tail. */
export function buildBasenameIndex(slugs: Iterable<string>, idx = new Map<string, string[]>()): Map<string, string[]> {
  const addKey = (key: string, slug: string) => {
    const existing = idx.get(key);
    if (existing) { if (!existing.includes(slug)) existing.push(slug); }
    else idx.set(key, [slug]);
  };
  for (const slug of slugs) {
    const tail = slug.includes('/') ? slug.slice(slug.lastIndexOf('/') + 1) : slug;
    addKey(tail, slug);
    const lower = tail.toLowerCase();
    if (lower !== tail) addKey(lower, slug);
    const slugified = normalizeBasename(tail);
    if (slugified && slugified !== tail && slugified !== lower) addKey(slugified, slug);
  }
  return idx;
}

/** Look a name up in a basename index (raw → lower → slugified), stable-sorted. */
export function queryBasenameIndex(idx: Map<string, string[]>, name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const hit = idx.get(trimmed) ?? idx.get(trimmed.toLowerCase()) ?? idx.get(normalizeBasename(trimmed));
  return hit ? [...hit].sort(basenameSort) : [];
}
