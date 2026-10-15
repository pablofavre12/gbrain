import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const op = (name: string) => {
  const found = operations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing operation: ${name}`);
  return found;
};

const markdown = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}`;

function actorCtx(clientId: string, opts: {
  sourceId?: string;
  federatedWrite?: string[];
  subjects?: string[];
  capabilities?: string[];
} = {}): OperationContext {
  const sourceId = opts.sourceId ?? 'campo';
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'server-verified',
      clientId,
      principal: { kind: 'oauth_client', id: clientId },
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId, ...(opts.federatedWrite ?? [])],
      federatedWrite: opts.federatedWrite ?? [],
      subjectIds: opts.subjects ?? [],
      capabilities: opts.capabilities ?? [],
    },
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('campo', 'campo') ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('backoffice', 'backoffice') ON CONFLICT DO NOTHING`);
  for (const id of ['agent-a','agent-b','shared-bff']) await engine.executeRaw(
    `INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,federated_read,federated_write) VALUES($1,'fixture','Fixture','read write','campo',ARRAY['campo','backoffice'],ARRAY['backoffice'])`,[id]);
});

beforeEach(async () => {
  await (engine as any).db.exec(`
    DELETE FROM page_write_proposals;
    DELETE FROM content_chunks;
    DELETE FROM pages;
  `);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('governed native page writes', () => {
  test('persists an exact preview but writes no page until the owning actor confirms', async () => {
    const content = markdown('Governed note', 'this must not exist before confirmation');
    const proposal = await op('propose_page_write').handler(actorCtx('agent-a', {
      federatedWrite: ['backoffice'],
    }), {
      slug: 'notes/governed', content, source: 'backoffice',
    }) as any;

    expect(proposal.status).toBe('pending');
    expect(proposal.preview).toMatchObject({
      slug: 'notes/governed', source_id: 'backoffice', content,
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await engine.getPage('notes/governed', { sourceId: 'backoffice' })).toBeNull();

    await expect(op('confirm_page_write').handler(actorCtx('agent-b', {
      federatedWrite: ['backoffice'],
    }), { proposal_id: proposal.proposal_id })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.getPage('notes/governed', { sourceId: 'backoffice' })).toBeNull();

    const confirmed = await op('confirm_page_write').handler(actorCtx('agent-a', {
      federatedWrite: ['backoffice'],
    }), { proposal_id: proposal.proposal_id }) as any;
    expect(confirmed).toMatchObject({
      proposal_id: proposal.proposal_id,
      status: 'confirmed', idempotent: false,
      slug: 'notes/governed', source_id: 'backoffice',
      content_hash: proposal.preview.content_hash,
    });
    expect((await engine.getPage('notes/governed', { sourceId: 'backoffice' }))?.compiled_truth)
      .toContain('this must not exist before confirmation');

    const repeated = await op('confirm_page_write').handler(actorCtx('agent-a', {
      federatedWrite: ['backoffice'],
    }), { proposal_id: proposal.proposal_id }) as any;
    expect(repeated).toMatchObject({ status: 'confirmed', idempotent: true, content_hash: proposal.preview.content_hash });
  });

  test('a proposal cannot overwrite an edit made after its preview', async () => {
    const ctx = actorCtx('agent-a');
    const slug = 'notes/concurrent-proposal';
    await engine.putPage(slug, {type:'note',title:'Original',compiled_truth:'original'}, {sourceId:'campo'});
    const proposal = await op('propose_page_write').handler(ctx,{slug,content:markdown('Proposal','proposed body')}) as any;
    await engine.putPage(slug, {type:'note',title:'Concurrent',compiled_truth:'winning edit'}, {sourceId:'campo'});
    await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'revision_conflict'});
    expect((await engine.getPage(slug,{sourceId:'campo'}))?.compiled_truth).toBe('winning edit');
    const [row] = await engine.executeRaw<{status:string}>('SELECT status FROM page_write_proposals WHERE proposal_id=$1',[proposal.proposal_id]);
    expect(row.status).toBe('failed');
    await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'proposal_not_confirmable'});
  });

  test('a crash after canonical commit replays the same request without a second version', async () => {
    const ctx = actorCtx('agent-a');
    const slug = 'notes/recover-proposal';
    const proposal = await op('propose_page_write').handler(ctx,{slug,content:markdown('Recovery','exact approved payload')}) as any;
    const execute = engine.executeRaw;
    (engine as any).executeRaw = async function (this: PGLiteEngine, query: string, params?: unknown[]) {
      if (query.includes("SET status = 'confirmed'")) throw new Error('fixture interrupted receipt');
      return execute.call(this,query,params);
    };
    try { await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toThrow('fixture interrupted receipt'); }
    finally { engine.executeRaw = execute; }
    const before = await engine.readPageSnapshot(slug,{sourceId:'campo'});
    expect(before?.page.compiled_truth).toContain('exact approved payload');
    await engine.executeRaw("UPDATE page_write_proposals SET confirming_at=now()-interval '3 minutes', expires_at=now()-interval '1 second' WHERE proposal_id=$1",[proposal.proposal_id]);
    await expect(op('cancel_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'proposal_confirmation_in_progress'});
    expect(await op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).toMatchObject({status:'confirmed'});
    expect((await engine.readPageSnapshot(slug,{sourceId:'campo'}))?.revision).toBe(before?.revision);
    const requests = await engine.executeRaw('SELECT id FROM persistence_requests WHERE client_request_id=$1',[`proposal-${proposal.proposal_id}`]);
    expect(requests).toHaveLength(1);
  });

  test('a confirming proposal retains its client across retries by the same verified user', async () => {
    const first = actorCtx('agent-a',{subjects:['user:alice']});
    const proposal = await op('propose_page_write').handler(first,{slug:'notes/client-bound',content:markdown('Client','approved body')}) as any;
    await engine.executeRaw("UPDATE page_write_proposals SET status='confirming', confirming_client_id='agent-a', confirming_at=now()-interval '3 minutes' WHERE proposal_id=$1",[proposal.proposal_id]);
    await expect(op('confirm_page_write').handler(actorCtx('agent-b',{subjects:['user:alice']}),{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'permission_denied'});
    expect(await engine.getPage('notes/client-bound',{sourceId:'campo'})).toBeNull();
    expect(await op('confirm_page_write').handler(first,{proposal_id:proposal.proposal_id})).toMatchObject({status:'confirmed'});
  });

  test('tampered proposal content is never published', async () => {
    const ctx = actorCtx('agent-a');
    const proposal = await op('propose_page_write').handler(ctx,{slug:'notes/integrity',content:markdown('Integrity','approved body')}) as any;
    await engine.executeRaw("UPDATE page_write_proposals SET content='tampered content' WHERE proposal_id=$1",[proposal.proposal_id]);
    await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'storage_error'});
    expect(await engine.getPage('notes/integrity',{sourceId:'campo'})).toBeNull();
  });

  test('cancel is actor-bound and leaves the proposal page absent', async () => {
    const proposal = await op('propose_page_write').handler(actorCtx('agent-a'), {
      slug: 'notes/cancelled', content: markdown('Cancelled', 'never write me'),
    }) as any;

    await expect(op('cancel_page_write').handler(actorCtx('agent-b'), {
      proposal_id: proposal.proposal_id,
    })).rejects.toMatchObject({ code: 'permission_denied' });

    await expect(op('cancel_page_write').handler(actorCtx('agent-a'), {
      proposal_id: proposal.proposal_id,
    })).resolves.toMatchObject({ status: 'cancelled', idempotent: false });
    await expect(op('cancel_page_write').handler(actorCtx('agent-a'), {
      proposal_id: proposal.proposal_id,
    })).resolves.toMatchObject({ status: 'cancelled', idempotent: true });
    expect(await engine.getPage('notes/cancelled', { sourceId: 'campo' })).toBeNull();
  });

  test('shared OAuth clients still bind proposals to the verified user subject', async () => {
    const proposal = await op('propose_page_write').handler(actorCtx('shared-bff', {
      subjects: ['user:alice'],
    }), {
      slug: 'notes/user-bound',
      content: markdown('User bound', 'only Alice may confirm'),
    }) as any;

    await expect(op('confirm_page_write').handler(actorCtx('shared-bff', {
      subjects: ['user:bob'],
    }), {
      proposal_id: proposal.proposal_id,
    })).rejects.toMatchObject({ code: 'permission_denied' });

    await expect(op('confirm_page_write').handler(actorCtx('shared-bff', {
      subjects: ['user:alice'],
    }), {
      proposal_id: proposal.proposal_id,
    })).resolves.toMatchObject({ status: 'confirmed' });
  });

  test('expiration and ACL are enforced at confirmation time without exposing protected content', async () => {
    const expiring = await op('propose_page_write').handler(actorCtx('agent-a'), {
      slug: 'notes/expired', content: markdown('Expired', 'never write me'),
    }) as any;
    await engine.executeRaw(
      `UPDATE page_write_proposals SET expires_at = now() - interval '1 second' WHERE proposal_id = $1`,
      [expiring.proposal_id],
    );
    await expect(op('confirm_page_write').handler(actorCtx('agent-a'), {
      proposal_id: expiring.proposal_id,
    })).rejects.toMatchObject({ code: 'proposal_expired' });
    expect(await engine.getPage('notes/expired', { sourceId: 'campo' })).toBeNull();

    await engine.putPage('notes/restricted', {
      type: 'note', title: 'Restricted', compiled_truth: 'private existing body', timeline: '', frontmatter: {},
      acl_subject_ids: ['user:alice'],
    }, { sourceId: 'campo' });
    const restricted = await op('propose_page_write').handler(actorCtx('agent-a', { subjects: ['user:bob'] }), {
      slug: 'notes/restricted', content: markdown('Restricted', 'attempted overwrite'),
    }) as any;
    const denied = op('confirm_page_write').handler(actorCtx('agent-a', { subjects: ['user:bob'] }), {
      proposal_id: restricted.proposal_id,
    });
    await expect(denied).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(denied).rejects.not.toThrow(/private existing body/);
    expect((await engine.getPage('notes/restricted', { sourceId: 'campo' }))?.compiled_truth).toBe('private existing body');
  });

  test('fails closed for remote callers without a server-authenticated actor', async () => {
    const anonymous: OperationContext = {
      engine, config: {} as any, logger: { info() {}, warn() {}, error() {} },
      dryRun: false, remote: true, sourceId: 'campo',
    };
    await expect(op('propose_page_write').handler(anonymous, {
      slug: 'notes/no-actor', content: markdown('No actor', 'no write'),
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('rejects a versioned-document proposal before persistence without the server capability', async () => {
    const params = {
      slug: 'documents/guarded',
      content: markdown('Guarded document', 'version one'),
      allowed_subject_ids: ['user:alice'],
      document_id: 'platform-document-guarded',
      document_version_sequence: 1,
      document_version_hash: 'b'.repeat(64),
    };

    await expect(op('propose_page_write').handler(actorCtx('shared-bff', {
      subjects: ['user:alice'],
    }), params)).rejects.toMatchObject({ code: 'permission_denied' });

    const rows = await engine.executeRaw<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM page_write_proposals',
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);

    await expect(op('propose_page_write').handler(actorCtx('shared-bff', {
      subjects: ['user:alice'],
      capabilities: ['versioned_document_write'],
    }), params)).resolves.toMatchObject({ status: 'pending' });
  });
});


test('a definite pre-admission refusal becomes terminal without changing the page', async()=>{
  const ctx=actorCtx('agent-a',{subjects:['user:bob']});
  await engine.putPage('notes/terminal-refusal',{type:'note',title:'Restricted',compiled_truth:'unchanged',acl_subject_ids:['user:alice']},{sourceId:'campo'});
  const proposal:any=await op('propose_page_write').handler(ctx,{slug:'notes/terminal-refusal',content:markdown('Restricted','denied')});
  await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'permission_denied'});
  const [row]=await engine.executeRaw<{status:string}>('SELECT status FROM page_write_proposals WHERE proposal_id=$1',[proposal.proposal_id]);
  expect(row.status).toBe('failed');
  await expect(op('confirm_page_write').handler(ctx,{proposal_id:proposal.proposal_id})).rejects.toMatchObject({code:'proposal_not_confirmable'});
  expect((await engine.getPage('notes/terminal-refusal',{sourceId:'campo'}))?.compiled_truth).toBe('unchanged');
});

test('a document creation proposal cannot overwrite a page created after preview', async () => {
  const ctx = actorCtx('agent-a', {capabilities: ['versioned_document_write']});
  const slug = 'notes/expected-absence';
  const proposal = await op('propose_page_write').handler(ctx, {slug, content: markdown('Document', 'stale preview'),
    allowed_subject_ids: ['client:agent-a'], document_id: 'expected-absence-document',
    document_version_sequence: 1, document_version_hash: 'a'.repeat(64)}) as any;
  await engine.putPage(slug, {type:'note', title:'Intervening native page', compiled_truth:'concurrent content'}, {sourceId:'campo'});
  await expect(op('confirm_page_write').handler(ctx, {proposal_id: proposal.proposal_id})).rejects.toMatchObject({code:'revision_conflict'});
  const page = await engine.getPage(slug, {sourceId:'campo'});
  expect(page?.compiled_truth).toBe('concurrent content');
  expect(page?.document_id).toBeNull();
  await expect(op('confirm_page_write').handler(ctx, {proposal_id: proposal.proposal_id})).rejects.toMatchObject({code:'proposal_not_confirmable'});
});
