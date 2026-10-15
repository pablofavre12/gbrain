import { createHash, randomUUID } from 'node:crypto';
import { OperationError, type Operation, type OperationContext } from './contract.ts';
import { resolveWriteSource, validatePageSlug } from './context.ts';
import { requireVersionedDocumentWriteCapability } from './fork-page-policy.ts';
import { pagesOperations } from './pages.ts';
const PAGE_WRITE_PROPOSAL_TTL_MINUTES = 15;
const PAGE_WRITE_PROPOSAL_MAX_BYTES = 5_000_000;
const PAGE_WRITE_CONFIRMING_STALE_SECONDS = 120;
type PageWriteProposalRow = {
  proposal_id: string;
  base_revision: string | null;
  confirming_client_id: string | null;
  actor_id: string;
  source_id: string;
  slug: string;
  content: string;
  content_hash: string;
  allowed_subject_ids: string[] | null;
  document_id: string | null;
  document_version_sequence: number | null;
  document_version_hash: string | null;
  status: 'pending' | 'confirming' | 'confirmed' | 'cancelled' | 'expired' | 'failed';
  expires_at: Date | string;
  confirmed_at: Date | string | null;
  confirming_at: Date | string | null;
};
function governedWriteActor(ctx: OperationContext): string {
  // A remote confirmation must be bound to a server-verified principal. Stdio
  // MCP intentionally has no OAuth identity, so it cannot silently collapse
  // all callers into one shared "anonymous" actor and bypass confirmation.
  if (ctx.remote !== false) {
    const verifiedUserSubject = ctx.auth?.subjectIds
      ?.filter((subject) => subject.startsWith('user:'))
      .sort()[0];
    if (verifiedUserSubject) return verifiedUserSubject;
    if (!ctx.auth?.clientId) {
      throw new OperationError(
        'permission_denied',
        'Governed page writes require an authenticated server actor.',
        'Use an OAuth-authenticated MCP client, or run the trusted local CLI.',
      );
    }
    return `client:${ctx.auth.clientId}`;
  }
  return 'local-cli';
}
function proposalExpiryIso(expiresAt: Date | string): string {
  const value = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return value.toISOString();
}
function proposalPreview(row: Pick<PageWriteProposalRow, 'proposal_id' | 'source_id' | 'slug' | 'content' | 'content_hash' | 'expires_at'>) {
  return {
    proposal_id: row.proposal_id,
    status: 'pending' as const,
    preview: {
      slug: row.slug,
      source_id: row.source_id,
      content: row.content,
      content_hash: row.content_hash,
      expires_at: proposalExpiryIso(row.expires_at),
    },
  };
}
function proposalConfirmation(row: Pick<PageWriteProposalRow, 'proposal_id' | 'source_id' | 'slug' | 'content_hash' | 'confirmed_at'>, idempotent: boolean) {
  return {
    proposal_id: row.proposal_id,
    status: 'confirmed' as const,
    idempotent,
    slug: row.slug,
    source_id: row.source_id,
    content_hash: row.content_hash,
    ...(row.confirmed_at ? { confirmed_at: proposalExpiryIso(row.confirmed_at) } : {}),
  };
}
function isProposalExpired(row: Pick<PageWriteProposalRow, 'expires_at'>): boolean {
  return new Date(row.expires_at).getTime() <= Date.now();
}
const propose_page_write: Operation = {
  name: 'propose_page_write',
  idempotent: false,
  outputRedaction: { exempt: 'Actor-bound preview of the exact submitted payload; does not retrieve page content.' },
  description: 'Create a durable, expiring preview for a native knowledge page write. This never writes the page; call confirm_page_write with the returned proposal_id to apply the exact slug/source/content/hash payload.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug to write after confirmation.' },
    content: { type: 'string', required: true, description: 'Exact markdown content to preview and later write.' },
    source: { type: 'string', required: false, description: 'Target source/sala. Must be the authenticated actor\'s source_id or federated_write grant.' },
    allowed_subject_ids: { type: 'array', required: false, items: { type: 'string' }, description: 'Optional page ACL to pass unchanged to the confirmed write.' },
    document_id: { type: 'string', required: false, description: 'Optional Platform document fence; must be supplied with version sequence and hash.' },
    document_version_sequence: { type: 'number', required: false, description: 'Optional Platform document version sequence.' },
    document_version_hash: { type: 'string', required: false, description: 'Optional Platform document version hash.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const actorId = governedWriteActor(ctx);
    const slug = p.slug as string;
    const content = p.content as string;
    validatePageSlug(slug);
    if (Buffer.byteLength(content, 'utf8') > PAGE_WRITE_PROPOSAL_MAX_BYTES) {
      throw new OperationError('invalid_params', `content exceeds ${PAGE_WRITE_PROPOSAL_MAX_BYTES} bytes`, "Reduce the proposed content below the stated byte limit before creating a preview.");
    }
    const sourceId = resolveWriteSource(ctx, p.source as string | undefined);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + PAGE_WRITE_PROPOSAL_TTL_MINUTES * 60_000);
    const allowedSubjectIds = p.allowed_subject_ids === undefined ? null : p.allowed_subject_ids;
    if (p.document_id !== undefined) {
      requireVersionedDocumentWriteCapability(ctx);
    }

    if (ctx.dryRun) {
      return proposalPreview({ proposal_id: proposalId, slug, source_id: sourceId, content, content_hash: contentHash, expires_at: expiresAt });
    }

    const base = await ctx.engine.readPageSnapshot(slug, {sourceId, includeDeleted:true});
    await ctx.engine.executeRaw(
      `INSERT INTO page_write_proposals
        (proposal_id, actor_id, source_id, slug, content, content_hash, allowed_subject_ids,
         document_id, document_version_sequence, document_version_hash, status, expires_at, base_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, 'pending', $11, $12::uuid)`,
      [
        proposalId, actorId, sourceId, slug, content, contentHash, allowedSubjectIds,
        p.document_id ?? null, p.document_version_sequence ?? null, p.document_version_hash ?? null, expiresAt, base?.revision ?? null,
      ],
    );
    return proposalPreview({ proposal_id: proposalId, slug, source_id: sourceId, content, content_hash: contentHash, expires_at: expiresAt });
  },
  cliHints: { name: 'propose-page-write', sourceIsScope: true, positional: ['slug'], stdin: 'content' },
};
async function loadOwnedPageWriteProposal(
  ctx: OperationContext,
  proposalId: string,
  actorId: string,
): Promise<PageWriteProposalRow> {
  // actor_id is part of the query rather than checked after a broad fetch: a
  // caller who does not own the proposal gets no content, no target, and no
  // existence oracle for another actor's pending write.
  const rows = await ctx.engine.executeRaw<PageWriteProposalRow>(
    `SELECT confirming_client_id, base_revision, proposal_id, actor_id, source_id, slug, content, content_hash,
            allowed_subject_ids, document_id, document_version_sequence,
            document_version_hash, status, expires_at, confirmed_at, confirming_at
       FROM page_write_proposals
      WHERE proposal_id = $1 AND actor_id = $2`,
    [proposalId, actorId],
  );
  const row = rows[0];
  if (!row) {
    throw new OperationError('permission_denied', 'Page-write proposal was not found for this actor.', "Use a caller with the required page, source and document grants.");
  }
  return row;
}
async function expirePageWriteProposal(
  ctx: OperationContext,
  proposalId: string,
  actorId: string,
): Promise<void> {
  await ctx.engine.executeRaw(
    `UPDATE page_write_proposals
        SET status = 'expired'
      WHERE proposal_id = $1 AND actor_id = $2
        AND status = 'pending' AND expires_at <= now()`,
    [proposalId, actorId],
  );
}
const confirm_page_write: Operation = {
  name: 'confirm_page_write',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Confirm one durable native-knowledge write proposal. The same authenticated actor may repeat this call safely: a confirmed proposal returns its prior confirmation without rewriting the page.',
  params: {
    proposal_id: { type: 'string', required: true, description: 'Proposal id returned by propose_page_write.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const actorId = governedWriteActor(ctx);
    const proposalId = p.proposal_id as string;
    if (!proposalId) throw new OperationError('invalid_params', 'proposal_id must be a non-empty string', "Pass the proposal_id returned by propose_page_write.");
    let proposal = await loadOwnedPageWriteProposal(ctx, proposalId, actorId);

    if (proposal.status === 'confirmed') return proposalConfirmation(proposal, true);
    if (proposal.status === 'failed') throw new OperationError('proposal_not_confirmable', 'This proposal failed permanently; create a fresh preview.', 'Read the current page before creating a replacement proposal.');
    if (proposal.status === 'cancelled') {
      throw new OperationError('proposal_cancelled', 'This page-write proposal was cancelled.', "Inspect the proposal state and create a fresh preview if a new write is intended.");
    }
    if (proposal.status === 'expired' || (proposal.status === 'pending' && isProposalExpired(proposal))) {
      await expirePageWriteProposal(ctx, proposalId, actorId);
      throw new OperationError('proposal_expired', 'This page-write proposal expired; create a fresh proposal.', "Inspect the proposal state and create a fresh preview if a new write is intended.");
    }

    // `confirming` is a short-lived lease. It prevents concurrent confirms
    // from racing the canonical writer, while a retry can reclaim a process
    // that died before recording the durable confirmation receipt.
    const confirmingClientId = ctx.auth?.clientId ?? 'local-cli';
    if (proposal.confirming_client_id && proposal.confirming_client_id !== confirmingClientId) {
      throw new OperationError('permission_denied', 'Retry confirmation using the client that first confirmed this proposal.', "Use a caller with the required page, source and document grants.");
    }
    if (proposal.status === 'confirming') {
      const confirmingAt = proposal.confirming_at ? new Date(proposal.confirming_at).getTime() : 0;
      if (confirmingAt > Date.now() - PAGE_WRITE_CONFIRMING_STALE_SECONDS * 1000) {
        return {
          proposal_id: proposal.proposal_id,
          status: 'confirming' as const,
          retry_after_seconds: PAGE_WRITE_CONFIRMING_STALE_SECONDS,
        };
      }
    }

    // Re-authorize at confirmation time. A grant may have changed since the
    // preview was made; `federated_write` is never captured as a durable
    // capability token in the proposal itself.
    const writeSourceId = resolveWriteSource(ctx, proposal.source_id);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        proposal_id: proposal.proposal_id,
        slug: proposal.slug,
        source_id: writeSourceId,
        content_hash: proposal.content_hash,
      };
    }

    const claimed = await ctx.engine.executeRaw<PageWriteProposalRow>(
      `UPDATE page_write_proposals
          SET status = 'confirming', confirming_at = now(), confirming_client_id = $4
        WHERE proposal_id = $1 AND actor_id = $2
          AND (confirming_client_id IS NULL OR confirming_client_id = $4)
          AND ((status = 'pending' AND expires_at > now())
            OR (status = 'confirming' AND (confirming_at IS NULL OR confirming_at < now() - ($3 * interval '1 second'))))
      RETURNING confirming_client_id, base_revision, proposal_id, actor_id, source_id, slug, content, content_hash,
                allowed_subject_ids, document_id, document_version_sequence,
                document_version_hash, status, expires_at, confirmed_at, confirming_at`,
      [proposalId, actorId, PAGE_WRITE_CONFIRMING_STALE_SECONDS, confirmingClientId],
    );
    proposal = claimed[0] ?? await loadOwnedPageWriteProposal(ctx, proposalId, actorId);
    if (!claimed.length && proposal.status === 'confirming') {
      return { proposal_id: proposalId, status: 'confirming', retry_after_seconds: PAGE_WRITE_CONFIRMING_STALE_SECONDS };
    }
    if (proposal.status === 'confirmed') return proposalConfirmation(proposal, true);
    if (proposal.status !== 'confirming') {
      if (proposal.status === 'expired' || (proposal.status === 'pending' && isProposalExpired(proposal))) {
        await expirePageWriteProposal(ctx, proposalId, actorId);
        throw new OperationError('proposal_expired', 'This page-write proposal expired; create a fresh proposal.', "Inspect the proposal state and create a fresh preview if a new write is intended.");
      }
      throw new OperationError('proposal_not_confirmable', 'This page-write proposal cannot be confirmed in its current state.', "Inspect the proposal state and create a fresh preview if a new write is intended.");
    }

    try {
      const actualHash = createHash('sha256').update(proposal.content).digest('hex');
      if (actualHash !== proposal.content_hash) {
        throw new OperationError('storage_error', 'Stored proposal content failed its integrity check.', "Stop confirming this proposal and report its id to the host operator; stored content failed integrity.");
      }

      // Canonical page writing remains exclusively in put_page. In particular,
      // this keeps document fences, source provenance, and native chunking
      // exactly aligned with every other page write.
      await pagesOperations.find(op => op.name === 'put_page')!.handler(ctx, {
        slug: proposal.slug,
        content: proposal.content,
        source_id: writeSourceId,
        request_id: `proposal-${proposal.proposal_id}`,
        ...(proposal.base_revision ? { expected_revision: proposal.base_revision } : { expected_absent: true }),
        ...(proposal.allowed_subject_ids ? { allowed_subject_ids: proposal.allowed_subject_ids } : {}),
        ...(proposal.document_id ? { document_id: proposal.document_id } : {}),
        ...(proposal.document_version_sequence ? { document_version_sequence: proposal.document_version_sequence } : {}),
        ...(proposal.document_version_hash ? { document_version_hash: proposal.document_version_hash } : {}),
      });

      const confirmed = await ctx.engine.executeRaw<PageWriteProposalRow>(
        `UPDATE page_write_proposals
            SET status = 'confirmed', confirmed_at = now()
          WHERE proposal_id = $1 AND actor_id = $2 AND status = 'confirming'
        RETURNING confirming_client_id, base_revision, proposal_id, actor_id, source_id, slug, content, content_hash,
                  allowed_subject_ids, document_id, document_version_sequence,
                  document_version_hash, status, expires_at, confirmed_at, confirming_at`,
        [proposalId, actorId],
      );
      return proposalConfirmation(confirmed[0] ?? { ...proposal, confirmed_at: new Date() }, false);
    } catch (error) {
      // Only a durable terminal refusal or a known pre-admission validation
      // failure can release the lease. Unknown outcomes retain their request id.
      const [request] = await ctx.engine.executeRaw<{ state: string }>(
        'SELECT state FROM persistence_requests WHERE client_request_id=$1', [`proposal-${proposal.proposal_id}`]);
      const refusedBeforeAdmission = !request && error instanceof OperationError
        && (['permission_denied', 'invalid_params', 'source_not_found'].includes(error.code)
          || (error.code === 'storage_error' && createHash('sha256').update(proposal.content).digest('hex') !== proposal.content_hash));
      if (refusedBeforeAdmission || (request && ['failed', 'conflict', 'cancelled'].includes(request.state))) {
        await ctx.engine.executeRaw(`UPDATE page_write_proposals SET status='failed'
          WHERE proposal_id=$1 AND actor_id=$2 AND status='confirming' AND confirming_at=$3::timestamptz`,
          [proposalId, actorId, proposal.confirming_at]);
      }
      throw error;
    }
  },
  cliHints: { name: 'confirm-page-write', positional: ['proposal_id'] },
};
const cancel_page_write: Operation = {
  name: 'cancel_page_write',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Cancel a pending native-knowledge page write proposal. Cancellation is actor-bound and never writes the proposed page.',
  params: {
    proposal_id: { type: 'string', required: true, description: 'Proposal id returned by propose_page_write.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const actorId = governedWriteActor(ctx);
    const proposalId = p.proposal_id as string;
    const proposal = await loadOwnedPageWriteProposal(ctx, proposalId, actorId);
    if (proposal.status === 'confirmed') {
      throw new OperationError('proposal_already_confirmed', 'A confirmed page-write proposal cannot be cancelled.', "Read the confirmed page before proposing any further change.");
    }
    if (proposal.status === 'expired' || (proposal.status === 'pending' && isProposalExpired(proposal))) {
      await expirePageWriteProposal(ctx, proposalId, actorId);
      return { proposal_id: proposalId, status: 'expired' as const };
    }
    if (proposal.status === 'cancelled') return { proposal_id: proposalId, status: 'cancelled' as const, idempotent: true };
    if (proposal.status === 'confirming') {
      throw new OperationError('proposal_confirmation_in_progress', 'This page-write proposal is currently being confirmed. Retry shortly.', "Wait for the accepted confirmation, then poll with the same proposal_id and client.");
    }
    if (ctx.dryRun) return { dry_run: true, proposal_id: proposalId, status: 'cancelled' as const };
    const cancelled = await ctx.engine.executeRaw<PageWriteProposalRow>(
      `UPDATE page_write_proposals
          SET status = 'cancelled', cancelled_at = now()
        WHERE proposal_id = $1 AND actor_id = $2 AND status = 'pending'
      RETURNING confirming_client_id, base_revision, proposal_id, actor_id, source_id, slug, content, content_hash,
                allowed_subject_ids, document_id, document_version_sequence,
                document_version_hash, status, expires_at, confirmed_at, confirming_at`,
      [proposalId, actorId],
    );
    if (cancelled.length === 0) {
      const current = await loadOwnedPageWriteProposal(ctx, proposalId, actorId);
      if (current.status === 'confirmed') {
        throw new OperationError('proposal_already_confirmed', 'A confirmed page-write proposal cannot be cancelled.', "Read the confirmed page before proposing any further change.");
      }
      if (current.status === 'confirming') {
        throw new OperationError('proposal_confirmation_in_progress', 'This page-write proposal is currently being confirmed. Retry shortly.', "Wait for the accepted confirmation, then poll with the same proposal_id and client.");
      }
      if (current.status === 'cancelled') return { proposal_id: proposalId, status: 'cancelled' as const, idempotent: true };
      throw new OperationError('proposal_not_cancellable', 'This page-write proposal cannot be cancelled in its current state.', "Inspect the proposal state and create a fresh preview if a new write is intended.");
    }
    return { proposal_id: proposalId, status: 'cancelled' as const, idempotent: false };
  },
  cliHints: { name: 'cancel-page-write', positional: ['proposal_id'] },
};
export const governedWriteOperations: Operation[] = [propose_page_write, confirm_page_write, cancel_page_write];
