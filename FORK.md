# Perennia gbrain fork

The fork tracks [garrytan/gbrain](https://github.com/garrytan/gbrain). Fork PRs target
`master` in `pablofavre12/gbrain` (the former repository URL redirects there). The production wrapper pins an immutable fork
commit; merging this repository does not deploy the server.

## Upgrade baseline

The current port merges upstream tag `v0.60.237.0`
(`a05fa516dcaadff57da975652c8f4b3c16cbd25e`) into the deployed fork baseline
`e3e50ef1dec2436caef2020d9ac4be43640f30c2` (schema 9007). It requires Bun 1.4.0
or later. Validate the wrapper against the exact candidate before changing its pin.

## Fork contracts

| Contract | Implementation |
|---|---|
| Federated writes and source aliases | `ops/context.ts`, `persistence/authority.ts`, OAuth client `federated_write` |
| Stable page references and ambiguous slug refusal | `ops/fork-page-ref.ts`, `page-state/fork-page-refs.ts`, page snapshots and link readers |
| Server-derived page ACLs | `ops/context.ts`, SQL read policies, snapshots, graph, history, context and projection readers |
| Document identity, version sequence and hash | `page-state/fork-metadata.ts`, canonical publication; remote `versioned_document_write` capability |
| Optional atomic content CAS | `page-state/content-precondition.ts`, engine page locks, canonical revision publication |
| Durable actor-bound proposals | `ops/governed-writes.ts`; exact payload hash, base revision, expiry and canonical request replay |
| OAuth writer attribution | Canonical persistence authority and engine page/ingest metadata |
| Per-source schema packs | `schema-pack/engine-resolution.ts`; configured pack failures stop imports, sync and canonical publication |
| Configured extraction models and Cohere | Model resolver, `ai/recipes/cohere.ts`, guarded Cohere endpoint overrides |
| Domain entities and atom provenance | Mention policy includes Spanish domain types; extraction writes source-qualified `has_atom` edges |
| Timeline maintenance and optional contradiction probe | Canonical timeline operations; default-disabled autopilot probe |
| Reader-specific temporal graph | Authorized assertions and transitions are filtered before deriving state, dates, counts and relationship notes |
| Durable authored references | Revision- and source-incarnation-bound inventories preserve references independently of target visibility and resolution |

Successful `put_page` publication returns `page_id`. A stored versioned document
also returns `receipt: { document_id, version_sequence, version_hash }`, taken
from the canonical page inside the publication transaction. An exact canonical
no-op returns these fields too; ordinary pages omit `receipt`.

**Say to your agent:** *"Save this document and show me the document version acknowledged by the brain."*

Legacy bearer grants use live source membership on both HTTP transports. An archived
federated source is excluded; an archived or missing primary source suspends the
bound grant without rewriting its stored permissions. Unarchiving restores access
under the original grant. Historical unbound tokens retain their active-source
federation floor. Canonical publication rechecks source membership for queued writes.

Paths in the table are relative to `src/core/` unless stated otherwise. Upstream
refactor wave 1 split the old `operations.ts`, engines, migration registry and
command files. Port behavior into the owning module instead of restoring the old
monolith. Regenerate registry, schema, operation/flag catalogs and documentation.

## Independent migration progress

Upstream owns migration numbers below 9000. Fork migrations start at 9000. The
legacy `config.version` remains the high fork bookmark. The independent
`config['schema.upstream_version']` checkpoints each successfully completed
upstream migration. Pending upstream work is selected against that cursor, so a
9007 bookmark cannot hide upstream 127 through 245.

For legacy databases without the cursor, only known history is inferred:
9000–9002 imply upstream 117; 9003 implies 119; 9004–9006 imply 122; 9007 implies
126. Unknown high bookmarks and malformed cursors fail closed. Existing historical
fork catch-up migrations retain their numbers; they no longer replay low-band
handlers out of order. New syncs do not need duplicate catch-up SQL. Engine graduation treats the upstream
cursor as engine schema state, keeps the target's cursor, and carries actor-bound
write proposals with the other security records.

Migration 9008 checks that the independent upstream cursor reached 245. Migration
9009 adds proposal base revisions, the confirming client and a terminal failure state.
Definite refusals finish as failed; uncertain outcomes retain the canonical request
identity for safe replay. Existing pending
proposals lack a base revision and must not overwrite an existing page without a
fresh preview.

Migration 9010 adds `authored_link_inventories`. After migration, run
`gbrain extract --stale --include-frontmatter` on the brain host with the intended source scope to
rebuild authored-reference inventories, including frontmatter references.
Scoped readers return `projection_pending` while a required inventory is missing
or stale; a migration alone does not establish extraction readiness.

Reader-specific temporal state is derived from evidence the reader can access;
hidden origins cannot change its dates, statuses, notes or counters. Archiving
either endpoint or an independent origin removes it from scoped graph reads.
Publishing inferred timeline entries separately requires current public evidence,
canonical dates and provenance, checked again under publication locks. An entry
already accepted into a public timeline is not automatically retracted when its
original evidence is later restricted.

Upstream 142 and its 144 skew guard would clear existing take vectors while
resizing their dimension. The fork adds a guard before that destructive path:
a populated vector column with mismatched dimensions stops the upgrade. Align the
configuration deliberately or plan a separately authorized migration. An upgrade
must not silently select another embedding provider or re-embed the corpus.

`test/fork-migration-resume.test.ts` exercises a failed handler, resume, no-op
rerun and populated-vector refusal. `scripts/upgrade/rehearse-fork.ts` seeds only
an empty local `gbrain_port_rehearsal` database using the legacy checkout, then
runs the candidate and writes inventories for exact comparison. It refuses remote
hosts and other database names. Use disposable fixtures; no customer data or
credentials belong in test evidence.

## Sync and publication

Fetch both remotes and inspect the fork baseline before integrating upstream.
Use the repository `/ship` workflow for version allocation, complete unit/E2E
validation, review, generated documentation, commit and PR preparation. Keep the
wrapper OAuth integration and synthetic upgrade inventory as separate gates.
A local pass does not prove CI, rollout approval or production behavior.

`.github/workflows/upstream-sync.yml` starts from fork `master`, uses Bun 1.4.0
and frozen dependencies, and creates a draft PR for a clean merge. Conflicts
always leave a job summary and downloadable report. When Issues are disabled,
the workflow skips issue creation; it does not fail by repeatedly retrying it.

The wrapper keeps DB-first operation, rejects writes to the retired `default`
source and does not run generic repository sync. Before a later authorized
rollout, coordinate every writing CLI with the server revision, stop writers,
verify a restorable database backup and test rollback against that backup.
Restoring an old image alone is not a database rollback after schema changes.
