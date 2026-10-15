/** Protect cached inference from corrected temporal anchors. Existing publication
 * tests change evidence/ACLs, not dates; removing the anchor checks admits the
 * obsolete destination/date. Uses real storage and publication, no new seam. */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writeTimelineFromContradictions } from '../../src/core/eval-contradictions/timeline-writer.ts';
import { captureTimelinePublicationGuard, validateTimelinePublicationGuard } from '../../src/core/persistence/timeline-publication-guard.ts';
import { installFixtureChunks } from './page-projection.ts';

async function seed(engine: BrainEngine, kind: 'chunk' | 'take') {
  const sides: Array<{ slug: string; effective_date: string; effective_date_source: string;
    chunk_id: number | null; take_id: number | null; text: string }> = [];
  const ids: number[] = [];
  for (const [slug, date, text] of [
    ['notes/alpha', '2024-01-01', 'First public claim'],
    ['notes/beta', '2025-01-01', 'Second public claim'],
  ]) {
    const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text,
      frontmatter: { date }, effective_date: new Date(date), effective_date_source: 'date' });
    ids.push(page.id);
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
    let chunk_id: number | null = null, take_id: number | null = null;
    if (kind === 'chunk') chunk_id = (await engine.getChunks(slug, { sourceId: 'default' }))[0].id;
    else {
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: text, kind: 'take', holder: 'world' }]);
      take_id = (await engine.listTakes({ page_id: page.id }))[0].id;
    }
    sides.push({ slug, effective_date: date, effective_date_source: 'date', chunk_id, take_id, text });
  }
  const save = async () => {
    await engine.executeRaw('DELETE FROM eval_contradictions_runs');
    await engine.writeContradictionsRun({ run_id: 'synthetic-date-report', judge_model: 'synthetic-no-call',
      prompt_version: 'fixture', queries_evaluated: 1, queries_with_contradiction: 1, total_contradictions_flagged: 1,
      wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0, cost_usd_total: 0, duration_ms: 0,
      source_tier_breakdown: {}, report_json: { per_query: [{ contradictions: [{ verdict: 'temporal_supersession',
        resolution_kind: 'temporal_supersede', axis: 'public claim update', a: sides[0], b: sides[1] }] }] } });
  };
  await save();
  return { ids, sides, save };
}

export function defineTimelineDatePublicationTests(getEngine: () => BrainEngine) {
  for (const kind of ['chunk', 'take'] as const) {
    test(`${kind}: corrected dates refuse the old report and a renewed report publishes the current chronology`, async () => {
      const engine = getEngine();
      const { sides, save } = await seed(engine, kind);
      expect((await writeTimelineFromContradictions(engine, { dryRun: true })).entries[0]).toMatchObject({ slug: 'notes/beta', date: '2025-01-01' });
      await engine.executeRaw("UPDATE pages SET effective_date='2023-01-01T00:00:00Z' WHERE slug='notes/beta'");
      for (const dryRun of [true, false]) expect(await writeTimelineFromContradictions(engine, { dryRun })).toMatchObject({ entries: [], created: 0 });
      expect(await engine.getTimeline('notes/beta')).toHaveLength(0);
      sides[1].effective_date = '2023-01-01';
      await save();
      const current = await writeTimelineFromContradictions(engine);
      expect(current).toMatchObject({ created: 1 });
      expect(current.entries[0]).toMatchObject({ slug: 'notes/alpha', date: '2024-01-01' });
      expect(await engine.getTimeline('notes/alpha')).toHaveLength(1);
      expect(await engine.getTimeline('notes/beta')).toHaveLength(0);
    });

    test(`${kind}: changed date provenance refuses a cached anchored report`, async () => {
      const engine = getEngine();
      const { sides, save } = await seed(engine, kind);
      for (const source of ['event_date', 'fallback', null]) {
        await engine.executeRaw("UPDATE pages SET effective_date_source=$1 WHERE slug='notes/beta'", [source]);
        expect((await writeTimelineFromContradictions(engine, { dryRun: true })).entries).toHaveLength(0);
      }
      await engine.executeRaw("UPDATE pages SET effective_date_source='event_date' WHERE slug='notes/beta'");
      sides[1].effective_date_source = 'event_date';
      await save();
      expect((await writeTimelineFromContradictions(engine, { dryRun: true })).entries).toHaveLength(1);
    });

    for (const change of ['date', 'date removed', 'source', 'source removed'] as const) {
      test(`${kind}: publication guard refuses ${change} changed after capture`, async () => {
        const engine = getEngine();
        const { ids } = await seed(engine, kind);
        const guard = await captureTimelinePublicationGuard(engine, { sourceId: 'default', targetPageId: ids[1], pageIds: ids });
        expect(guard).not.toBeNull();
        await engine.transaction(tx => validateTimelinePublicationGuard(tx, guard, { sourceId: 'default', pageId: ids[1] }));
        const sql = change === 'date' ? "UPDATE pages SET effective_date='2023-01-01T00:00:00Z' WHERE id=$1"
          : change === 'date removed' ? 'UPDATE pages SET effective_date=NULL WHERE id=$1'
            : change === 'source' ? "UPDATE pages SET effective_date_source='event_date' WHERE id=$1"
              : 'UPDATE pages SET effective_date_source=NULL WHERE id=$1';
        await engine.executeRaw(sql, [ids[1]]);
        await expect(engine.transaction(tx => validateTimelinePublicationGuard(tx, guard, { sourceId: 'default', pageId: ids[1] })))
          .rejects.toMatchObject({ code: 'content_conflict' });
        expect(await engine.getTimeline('notes/beta')).toHaveLength(0);
      });
    }
  }
}
