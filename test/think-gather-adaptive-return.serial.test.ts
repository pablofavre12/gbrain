/**
 * #5890 — think/synthesize evidence gather must not be trimmed by adaptive
 * return. With `search.adaptive_return` on, the reader-facing intent cap
 * (entity 2 pages, other 6) used to cut a breadth-sized gather of 12
 * matching meetings to 2 or 6 pages before synthesis saw them.
 *
 * Real PGLite + real runGather. Embeddings are mocked deterministically so
 * hybridSearch takes the vector path (the keyword-only short-circuit skips
 * adaptive return and would hide the bug).
 *
 * Serial: mock.module + process-global gateway config.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

function unitVector(seed: number): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.sin(1 + i * 0.001) + seed * 0.0001 * Math.cos(i);
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  return arr.map((v) => v / norm);
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => unitVector(0),
  embedQuery: async () => unitVector(0),
}));

const { runGather, renderPagesBlock } = await import('../src/core/think/gather.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedHome = process.env.GBRAIN_HOME;
const MEETINGS = 12;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-5890-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 1; i <= MEETINGS; i++) {
    const slug = `meetings/zorblax-review-${i}`;
    const body = `Zorblax review ${i}: the team discussed the Zorblax rollout, risks and next steps.`;
    await engine.putPage(slug, { type: 'meeting', title: `Zorblax review ${i}`, compiled_truth: body });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', embedding: unitVector(i) }]);
  }
  await engine.setConfig('search.adaptive_return', 'true');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('#5890 gather keeps breadth with adaptive return on', () => {
  for (const question of ['Zorblax', 'what did the team decide about the zorblax rollout']) {
    test(`"${question}" gathers all ${MEETINGS} meetings`, async () => {
      const result = await runGather(engine, { question, remote: false });
      const meetings = result.pages.filter((p) => p.slug.startsWith('meetings/zorblax-review-'));
      expect(new Set(meetings.map((p) => p.slug)).size).toBe(MEETINGS);
    }, 30_000);
  }
});

// Value: protects=think evidence and graph expansion honor page ACL after same-caller revocation;
// fails_when=gather search, anchor hydration, or graph options drop the read policy;
// why_new=existing real gather tests cover breadth but have no subject-restricted evidence;
// seam=none; no_claim=takes evidence or synthesis quality (embedding is deterministic).
test('think gather rechecks ACL before rendering synthesis evidence', async () => {
  const anchor = 'notes/think-acl-anchor';
  const restricted = 'notes/think-acl-restricted';
  const marker = 'THINKACLSECRETEVIDENCE';
  await engine.putPage(anchor, { type: 'note', title: 'Think ACL anchor', compiled_truth: 'THINKPUBLICCONTROL' });
  await engine.putPage(restricted, { type: 'note', title: 'Think restricted', compiled_truth: marker, acl_subject_ids: ['user:alice'] });
  await installFixtureChunks(engine, restricted, [{ chunk_index: 0, chunk_text: marker, chunk_source: 'compiled_truth', embedding: unitVector(0) }]);
  await engine.addLink(anchor, restricted, '', 'related_to', 'manual');
  try {
    const opts = { question: 'think evidence fixture', anchor, sourceId: 'default', aclSubjectIds: ['user:alice'], remote: true };
    const before = await runGather(engine, opts);
    expect(renderPagesBlock(before.pages)).toContain(marker);
    expect(before.graphSlugs).toContain(restricted);
    await engine.executeRaw("UPDATE pages SET acl_subject_ids=ARRAY['user:bob'] WHERE source_id='default' AND slug=$1", [restricted]);
    const after = await runGather(engine, opts);
    const promptEvidence = renderPagesBlock(after.pages);
    expect(promptEvidence).not.toContain(marker);
    expect(promptEvidence).toContain('THINKPUBLICCONTROL');
    expect(after.graphSlugs).not.toContain(restricted);
    // Direct anchor hydration must obey the same revoked read policy.
    const hiddenAnchor = await runGather(engine, { ...opts, anchor: restricted });
    expect(renderPagesBlock(hiddenAnchor.pages)).not.toContain(marker);
    expect(hiddenAnchor.warnings).toContain('ANCHOR_PAGE_NOT_FOUND');
  } finally {
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', ['default', [anchor, restricted]]);
  }
});
