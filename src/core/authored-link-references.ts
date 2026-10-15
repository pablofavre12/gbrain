/** Lossless authored identities, kept separately from the unresolved healing queue. */
import type { AuthoredFrontmatterRef, LinkCandidate } from './link-extraction.ts';
import { normalizeBasename, unwrapWikilink } from './link-extraction.ts';
import { isValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';
import type { AuthoredLinkReference } from './authored-link-inventory.ts';

type Resolution = { ok: true; fromSourceId?: string; toSourceId?: string } | { ok: false; reason: string };
export function collectAuthoredLinkReferences(input: {
  candidates: readonly LinkCandidate[]; frontmatterReferences?: readonly AuthoredFrontmatterRef[];
  originSourceId: string; originSlug: string; crossSourceAllowed: boolean; resolve: (candidate: LinkCandidate) => Resolution;
}): AuthoredLinkReference[] {
  const refs = new Map<string, AuthoredLinkReference>();
  const add = (ref: AuthoredLinkReference) => {
    if (ref.target_source_id !== input.originSourceId && !input.crossSourceAllowed) return;
    if (!ref.target_ref) return;
    if (ref.ref_kind === 'slug') { try { validateSlug(ref.target_ref); } catch { return; } }
    const key = [ref.producer, ref.ref_kind, ref.target_source_id, ref.target_ref].join('\0');
    const previous = refs.get(key);
    if (!previous) refs.set(key, ref);
    else {
      for (const resolution of ref.resolutions ?? []) {
        if (!(previous.resolutions ??= []).some(r => JSON.stringify(r) === JSON.stringify(resolution))) previous.resolutions.push(resolution);
      }
    }
  };
  for (const candidate of input.candidates) {
    const ref = candidate.authoredRef;
    if (!ref) continue;

    add({ producer: 'body', ref_kind: ref.kind, target_ref: ref.target,
      target_source_id: ref.targetSourceId ?? input.originSourceId, link_type: candidate.linkType,
      resolutions: ref.resolution ? [ref.resolution] : [] });
  }
  for (const ref of input.frontmatterReferences ?? []) {
    let target = unwrapWikilink(ref.name), sourceId = input.originSourceId;
    const colon = target.indexOf(':');
    if (colon > 0 && isValidSourceId(target.slice(0, colon))) { sourceId = target.slice(0, colon); target = target.slice(colon + 1); }
    const slug = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9._-]*)+$/.test(target);
    add({ producer: 'frontmatter', ref_kind: slug ? 'slug' : 'name', target_source_id: sourceId,
      target_ref: slug ? target : normalizeBasename(target), link_type: ref.linkType,
      resolutions: [{ name: target, dirHint: ref.dirHint, globalBasename: ref.globalBasename, canonicalAttendance: ref.canonicalAttendance }] });
  }
  return [...refs.values()];
}
