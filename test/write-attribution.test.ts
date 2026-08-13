/**
 * Migration v9002 (fork band) — write attribution (author of each write).
 *
 * `pages` and `ingest_log` gained two nullable columns
 * (last_write_client_id, last_write_client_name). This file pins the
 * contract:
 *
 *   1. An authenticated write (OperationContext.auth set — the identity the
 *      OAuth verifier resolved at token-verification time) stamps both
 *      columns on the page row.
 *   2. An identity-less write (no ctx.auth — local CLI / sync / migrations)
 *      leaves both columns NULL.
 *   3. The identity comes from ctx.auth, NEVER from a wire param: a client
 *      that smuggles `last_write_client_id` in the put_page params cannot
 *      poison the attribution.
 *   4. COALESCE-preserve UPDATE: an identity-less re-write does NOT erase the
 *      prior author; a different authenticated write overwrites it.
 *   5. log_ingest stamps the same identity from ctx.auth (NULL when absent).
 *
 * All cases run against in-memory PGLite (hermetic, no DATABASE_URL), mirroring
 * test/put-page-provenance.test.ts.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;
const logIngestOp = operations.find((o) => o.name === 'log_ingest')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  // Hermeticity guard (cross-file gateway-state leak class — see CLAUDE.md
  // "Test-isolation lint and helpers"). put_page embeds via the gateway; pin
  // it to legacy OpenAI/1536 and stub the embed transport so the test never
  // touches the network. These tests assert attribution columns, not embeddings.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages', []);
  await engine.executeRaw('DELETE FROM ingest_log', []);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: {
      info: () => { /* noop */ },
      warn: () => { /* noop */ },
      error: () => { /* noop */ },
    },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

function auth(clientId: string, clientName?: string): AuthInfo {
  return { token: 'tok', clientId, clientName, scopes: ['write'] };
}

// Read attribution straight from the DB so we don't depend on get_page.
async function readAttribution(slug: string): Promise<{
  last_write_client_id: string | null;
  last_write_client_name: string | null;
}> {
  const rows = await engine.executeRaw(
    'SELECT last_write_client_id, last_write_client_name FROM pages WHERE slug = $1',
    [slug],
  ) as Array<{ last_write_client_id: unknown; last_write_client_name: unknown }>;
  const r = rows[0];
  return {
    last_write_client_id: (r?.last_write_client_id as string | null) ?? null,
    last_write_client_name: (r?.last_write_client_name as string | null) ?? null,
  };
}

async function readIngestAttribution(sourceRef: string): Promise<{
  last_write_client_id: string | null;
  last_write_client_name: string | null;
}> {
  const rows = await engine.executeRaw(
    'SELECT last_write_client_id, last_write_client_name FROM ingest_log WHERE source_ref = $1',
    [sourceRef],
  ) as Array<{ last_write_client_id: unknown; last_write_client_name: unknown }>;
  const r = rows[0];
  return {
    last_write_client_id: (r?.last_write_client_id as string | null) ?? null,
    last_write_client_name: (r?.last_write_client_name as string | null) ?? null,
  };
}

const body = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nbody`;

describe('put_page write attribution', () => {
  test('authenticated write stamps client_id + client_name', async () => {
    const ctx = makeCtx({ remote: true, auth: auth('gbrain_cl_alice', 'Alice Agent') });
    await putPageOp.handler(ctx, { slug: 'wiki/attr-auth', content: body('Auth') });
    const attr = await readAttribution('wiki/attr-auth');
    expect(attr.last_write_client_id).toBe('gbrain_cl_alice');
    expect(attr.last_write_client_name).toBe('Alice Agent');
  });

  test('identity-less local write leaves both columns NULL', async () => {
    const ctx = makeCtx({ remote: false }); // no ctx.auth — local CLI
    await putPageOp.handler(ctx, { slug: 'wiki/attr-local', content: body('Local') });
    const attr = await readAttribution('wiki/attr-local');
    expect(attr.last_write_client_id).toBeNull();
    expect(attr.last_write_client_name).toBeNull();
  });

  test('client_id resolves only from ctx.auth WITHOUT a client_name', async () => {
    // Legacy bearer tokens may resolve a clientId but no clientName.
    const ctx = makeCtx({ remote: true, auth: auth('gbrain_cl_bob') });
    await putPageOp.handler(ctx, { slug: 'wiki/attr-noname', content: body('NoName') });
    const attr = await readAttribution('wiki/attr-noname');
    expect(attr.last_write_client_id).toBe('gbrain_cl_bob');
    expect(attr.last_write_client_name).toBeNull();
  });

  test('a wire param cannot spoof attribution (identity comes from ctx.auth only)', async () => {
    const ctx = makeCtx({ remote: false }); // no auth
    await putPageOp.handler(ctx, {
      slug: 'wiki/attr-spoof',
      content: body('Spoof'),
      // Attacker-supplied params — must be ignored; only ctx.auth feeds the column.
      last_write_client_id: 'gbrain_cl_attacker',
      last_write_client_name: 'Attacker',
    });
    const attr = await readAttribution('wiki/attr-spoof');
    expect(attr.last_write_client_id).toBeNull();
    expect(attr.last_write_client_name).toBeNull();
  });

  test('COALESCE-preserve: identity-less re-write keeps prior author', async () => {
    const authed = makeCtx({ remote: true, auth: auth('gbrain_cl_alice', 'Alice Agent') });
    await putPageOp.handler(authed, { slug: 'wiki/attr-preserve', content: body('V1') });

    // Background sync / local edit with no identity re-writes the same slug.
    const anon = makeCtx({ remote: false });
    await putPageOp.handler(anon, { slug: 'wiki/attr-preserve', content: body('V2') });

    const attr = await readAttribution('wiki/attr-preserve');
    expect(attr.last_write_client_id).toBe('gbrain_cl_alice');
    expect(attr.last_write_client_name).toBe('Alice Agent');
  });

  test('a different authenticated write overwrites the author', async () => {
    const alice = makeCtx({ remote: true, auth: auth('gbrain_cl_alice', 'Alice Agent') });
    await putPageOp.handler(alice, { slug: 'wiki/attr-overwrite', content: body('V1') });

    const bob = makeCtx({ remote: true, auth: auth('gbrain_cl_bob', 'Bob Agent') });
    await putPageOp.handler(bob, { slug: 'wiki/attr-overwrite', content: body('V2') });

    const attr = await readAttribution('wiki/attr-overwrite');
    expect(attr.last_write_client_id).toBe('gbrain_cl_bob');
    expect(attr.last_write_client_name).toBe('Bob Agent');
  });
});

describe('log_ingest write attribution', () => {
  test('authenticated log_ingest stamps client identity', async () => {
    const ctx = makeCtx({ remote: true, auth: auth('gbrain_cl_alice', 'Alice Agent') });
    await logIngestOp.handler(ctx, {
      source_type: 'manual',
      source_ref: 'attr-ingest-auth',
      pages_updated: ['wiki/x'],
      summary: 'test',
    });
    const attr = await readIngestAttribution('attr-ingest-auth');
    expect(attr.last_write_client_id).toBe('gbrain_cl_alice');
    expect(attr.last_write_client_name).toBe('Alice Agent');
  });

  test('identity-less log_ingest leaves both columns NULL', async () => {
    const ctx = makeCtx({ remote: false });
    await logIngestOp.handler(ctx, {
      source_type: 'sync',
      source_ref: 'attr-ingest-anon',
      pages_updated: ['wiki/y'],
      summary: 'test',
    });
    const attr = await readIngestAttribution('attr-ingest-anon');
    expect(attr.last_write_client_id).toBeNull();
    expect(attr.last_write_client_name).toBeNull();
  });
});
