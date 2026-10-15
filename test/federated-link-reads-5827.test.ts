/**
 * #5827 — link reads on multi-source federated brains.
 *
 * Contract protected: get_links / get_backlinks / traverse_graph read the same
 * source set as `search` for the same caller. A no-grant remote caller (whose
 * scalar scope collapses to an empty `default`) reads across the transport's
 * federated set through the #2200 all-endpoints branch; a granted token never
 * widens; non-federated and archived sources stay out; private pages stay
 * hidden from remote callers. The fork rejects ambiguous same-slug roots; exact references merge one scalar
 * read per federated source; explicit `source_id` is honored or refused.
 *
 * Regression that fails it: the link ops reading `sourceScopeOpts` (scalar
 * `default`) again — on the wave-5 base every new-behavior case below returned
 * [] or ignored `source_id`. Existing coverage (get-page-federated-scope,
 * operations-source-isolation-matrix) only exercises granted tokens.
 * Remote calls go through `dispatchToolCall` with the HTTP no-grant context
 * `serve-http-mcp.ts` builds; no production seam is added.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type AuthInfo, type OperationContext } from '../src/core/operations.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { makeContext } from '../src/cli/main.ts';
import { withEnv } from './helpers/with-env.ts';
import { FEDERATED_SET, edgeKeys, seedAliceIdentity, seedFederatedLinkFixture } from './helpers/federated-link-fixture.ts';
import { ENTITY_IDENTITY_UNION_CONFIG_KEY } from '../src/core/entity-identity.ts';
import type { GraphNode } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedFederatedLinkFixture(engine);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function noGrantOpts(): Promise<DispatchOpts> {
  const auth = { token: '', clientId: 'legacy', scopes: ['read'], sourceId: 'default', hasSourceGrant: false } as AuthInfo;
  return {
    remote: true, transport: 'http', sourceId: 'default', auth,
    localFederatedSourceIds: await noGrantFederatedScope(engine, false, 'default'),
  };
}

function grantedOpts(allowedSources: string[]): DispatchOpts {
  const auth = {
    token: '', clientId: 'client-a', scopes: ['read'], sourceId: allowedSources[0], allowedSources,
    principal: { kind: 'oauth_client', id: 'client-a' },
  } as AuthInfo;
  return { remote: true, transport: 'http', sourceId: allowedSources[0], auth, localFederatedSourceIds: [...FEDERATED_SET] };
}

async function call(opts: DispatchOpts, name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, name, params, opts);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

function localCtx(overrides: Partial<OperationContext> = {}, warnings: string[] = []): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: { info: () => {}, warn: (m: string) => { warnings.push(m); }, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    localFederatedSourceIds: [...FEDERATED_SET],
    ...overrides,
  };
}

const runOp = (name: string, ctx: OperationContext, params: Record<string, unknown>) =>
  operationsByName[name].handler(ctx, params) as Promise<unknown[]>;

describe('#5827 remote no-grant caller reads the federated set', () => {
  test('the transport computed a federated set without priv (never federated) or arch (archived)', async () => {
    expect((await noGrantOpts()).localFederatedSourceIds).toEqual([...FEDERATED_SET]);
  });

  test('get_backlinks returns the business backlink; non-federated, archived and private referrers stay out', async () => {
    const { isError, body } = await call(await noGrantOpts(), 'get_backlinks', { slug: 'companies/acme-example' });
    expect(isError).toBe(false);
    expect(edgeKeys(body)).toEqual(['people/alice-example(business)->companies/acme-example(business)']);
  });

  test('same-slug link and graph references require an exact source', async () => {
    const opts = await noGrantOpts();
    for (const name of ['get_links', 'traverse_graph']) {
      for (const selector of [{}, { all_sources: true }, { source_id: '__all__' }]) {
        const result = await call(opts, name, { slug: 'people/alice-example', depth: 1, ...selector });
        expect(result.isError).toBe(true);
        expect(result.body.code).toBe('ambiguous_page_ref');
      }
      for (const [source, destination] of [['business', 'companies/acme-example'], ['wiki', 'topics/widget-co']]) {
        const result = await call(opts, name, { slug: 'people/alice-example', source_id: source, depth: 1 });
        expect(result.isError).toBe(false);
        expect(edgeKeys(result.body)).toEqual([`people/alice-example(${source})->${destination}(${source})`]);
      }
    }
  });

  test('an explicit federated source_id narrows to that source', async () => {
    const { body } = await call(await noGrantOpts(), 'get_links', { slug: 'people/alice-example', source_id: 'wiki' });
    expect(edgeKeys(body)).toEqual(['people/alice-example(wiki)->topics/widget-co(wiki)']);
  });

  test('an explicit non-federated source_id is refused with the #5081 hint', async () => {
    for (const name of ['get_links', 'get_backlinks', 'traverse_graph']) {
      const { isError, body } = await call(await noGrantOpts(), name, { slug: 'notes/priv-note', source_id: 'priv' });
      expect(isError).toBe(true);
      expect(body.error).toBe('permission_denied');
      expect(body.suggestion).toContain('priv is not federated');
    }
  });

  test('an archived source the caller was never granted answers permission_denied, not unknown_source', async () => {
    for (const name of ['get_links', 'get_backlinks', 'traverse_graph']) {
      const { body } = await call(await noGrantOpts(), name, { slug: 'notes/arch-note', source_id: 'arch' });
      expect(body.error).toBe('permission_denied');
    }
  });

  test('source_id together with all_sources is invalid_params', async () => {
    const { body } = await call(await noGrantOpts(), 'get_links', { slug: 'people/alice-example', source_id: 'wiki', all_sources: true });
    expect(body.error).toBe('invalid_params');
  });

  test('identity union under the federated scope adds federated co-members only', async () => {
    await seedAliceIdentity(engine);
    try {
      const page = await engine.getPage('people/alice-example', { sourceId: 'business' });
      const { body } = await call(await noGrantOpts(), 'get_links', { page_id: page!.id });
      expect(edgeKeys(body)).toEqual([
        'people/al-example(wiki)->topics/gadget-co(wiki)',
        'people/alice-example(business)->companies/acme-example(business)',
      ]);
    } finally {
      await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'false');
    }
  });
});

describe('#5827 granted tokens never widen', () => {
  test('a business grant reads exactly what the engine returns for that grant', async () => {
    const expected = await engine.getBacklinks('companies/acme-example', { sourceIds: ['business'], excludePrivate: true });
    const { body } = await call(grantedOpts(['business']), 'get_backlinks', { slug: 'companies/acme-example' });
    expect(body).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(edgeKeys(body)).toEqual(['people/alice-example(business)->companies/acme-example(business)']);
  });

  test('a wiki grant sees no business links and cannot name business', async () => {
    const opts = grantedOpts(['wiki']);
    expect((await call(opts, 'get_backlinks', { slug: 'companies/acme-example' })).body.code).toBe('page_not_found');
    expect(edgeKeys((await call(opts, 'get_links', { slug: 'people/alice-example' })).body)).toEqual([
      'people/alice-example(wiki)->topics/widget-co(wiki)',
    ]);
    const denied = await call(opts, 'get_links', { slug: 'people/alice-example', source_id: 'business' });
    expect(denied.body.error).toBe('permission_denied');
  });

  test('a token granted an archived source gets unknown_source for it', async () => {
    const { body } = await call(grantedOpts(['business', 'arch']), 'get_backlinks', {
      slug: 'companies/acme-example', source_id: 'arch',
    });
    expect(body.error).toBe('unknown_source');
  });
});

describe('#5827 trusted local link reads', () => {
  test('an unqualified read merges one scalar read per federated source, keeping cross-source referrers', async () => {
    const rows = await runOp('get_backlinks', localCtx(), { slug: 'companies/acme-example' });
    const perSource: unknown[] = [];
    for (const sourceId of FEDERATED_SET) perSource.push(...await engine.getBacklinks('companies/acme-example', { sourceId }));
    expect(rows).toEqual(perSource);
    expect(edgeKeys(rows)).toEqual([
      'notes/arch-note(arch)->companies/acme-example(business)',
      'notes/priv-note(priv)->companies/acme-example(business)',
      'people/alice-example(business)->companies/acme-example(business)',
      'people/secret-example(business)->companies/acme-example(business)',
    ]);
  });

  test('a pinned scalar read (no federated set) is unchanged', async () => {
    const ctx = localCtx({ sourceId: 'business', localFederatedSourceIds: undefined });
    const rows = await runOp('get_backlinks', ctx, { slug: 'companies/acme-example' });
    expect(rows).toEqual(await engine.getBacklinks('companies/acme-example', { sourceId: 'business' }));
  });

  test('`gbrain backlinks <slug> --source business` reads business through makeContext', async () => {
    const ctx = await withEnv({ GBRAIN_SOURCE: undefined }, () => makeContext(engine as never, { source: 'business' }));
    expect(ctx.sourceId).toBe('business');
    const rows = await runOp('get_backlinks', ctx, { slug: 'companies/acme-example' });
    expect(rows).toEqual(await engine.getBacklinks('companies/acme-example', { sourceId: 'business' }));
  });

  test('explicit source_id and all_sources are honored', async () => {
    const wiki = await runOp('get_links', localCtx(), { slug: 'people/alice-example', source_id: 'wiki' });
    expect(edgeKeys(wiki)).toEqual(['people/alice-example(wiki)->topics/widget-co(wiki)']);
    const all = await runOp('get_backlinks', localCtx(), { slug: 'companies/acme-example', all_sources: true });
    expect(all).toEqual(await engine.getBacklinks('companies/acme-example'));
  });

  test('an archived source_id answers unknown_source locally', async () => {
    await expect(runOp('get_backlinks', localCtx(), { slug: 'companies/acme-example', source_id: 'arch' }))
      .rejects.toMatchObject({ code: 'unknown_source' });
  });

  test('a page outside the federated scope refuses without disclosing other sources', async () => {
    const warnings: string[] = [];
    for (const json of [false, true]) {
      await expect(runOp('get_backlinks', localCtx({}, warnings), { slug: 'companies/priv-only-co', json }))
        .rejects.toMatchObject({ code: 'page_not_found' });
    }
    expect(warnings).toEqual([]);
  });

  test('local graph roots require a source when the slug is ambiguous', async () => {
    await expect(runOp('traverse_graph', localCtx(), { slug: 'people/alice-example', depth: 1 }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_PAGE_REF' });
    for (const source of ['business', 'wiki']) {
      const nodes = await runOp('traverse_graph', localCtx(), { slug: 'people/alice-example', source_id: source, depth: 1 }) as GraphNode[];
      expect(nodes.filter(n => n.depth === 0).map(n => n.source_id)).toEqual([source]);
    }
  });
});
