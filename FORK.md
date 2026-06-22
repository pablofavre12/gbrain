# FORK.md — perennia-regen/gbrain

This repo is a **fork of [garrytan/gbrain](https://github.com/garrytan/gbrain)**.
This file is the map a human (or an agent) reads before merging upstream: what the
fork changes, why, and where the merge landmines are.

## Remotes

```bash
git remote -v
# fork      https://github.com/perennia-regen/gbrain.git   (the fork; default)
# origin    https://github.com/garrytan/gbrain.git         (upstream / Garry Tan)
```

Base branch for fork work: **`perennia`** (not `master`).

## How far behind upstream are we?

Check any time:

```bash
git fetch origin fork
echo "fork:     $(git show fork/perennia:VERSION)"
echo "upstream: $(git show origin/master:VERSION)"
git log --oneline origin/master..fork/perennia   # what the fork adds
git log --oneline fork/perennia..origin/master   # what upstream has that we lack
```

The fork forked from an older upstream and upstream keeps releasing. Pulling
upstream regularly (small, frequent merges) is far cheaper than a once-a-year
big-bang merge. See "Sync process" below.

## What the fork adds on top of upstream

Keep this list current — it's the checklist for "did upstream touch any of these?"
on every merge.

| Area | Files | What |
|---|---|---|
| Per-call source on graph ops | `src/core/operations.ts`, `src/core/engine.ts` | `add_link` / `add_tag` / `remove_link` / `remove_tag` take a per-call `source` param (PR #1) |
| `get_page` multi-source read | `src/core/operations.ts` (get_page handler), `src/core/{postgres,pglite}-engine.ts` (`getPageLayers`) | `source` param + union-of-layers read across sources (PR #2) |
| Federated write | `src/core/oauth-provider.ts`, `src/commands/auth.ts`, schema + migration (fork band) | `oauth_clients.federated_write`: per-write source authorization (write-side mirror of `federated_read`) |
| Pere runtime patches | `src/core/by-mention.ts`, `src/core/extract-takes-from-pages.ts`, `src/core/cycle/extract-atoms.ts` | takes chat-model, by-mention domain types, `'atom'` linkable + `has_atom` source→atom link |
| Write attribution | `src/core/{operations,types,utils,import-file,postgres-engine,pglite-engine}.ts`, migration (fork band) | `pages` / `ingest_log` record the writer's OAuth identity (`last_write_client_id` / `last_write_client_name`) for the per-user ingestion digest |

## Migration numbering — the one rule that prevents silent data loss

**The problem.** Upstream and the fork both append migrations at "the next integer."
Run in parallel, both repos mint the SAME version number with DIFFERENT SQL. The
runner is a high-water-mark (`pending = m.version > current`), so when a brain has
already passed that number, the loser's migration is **skipped silently** — no
conflict marker, no error, no CI failure. This already bit us once: the fork's
`federated_write` grabbed 118/119 and upstream's `page_generation_clock_sequence_swap`
+ `op_checkpoints_completed_keys_array_check` were dropped from the fork entirely.

**The rule.**

- **Upstream owns the contiguous low range (1..N).** Never renumber, edit, or
  reuse an upstream migration version. On merge, the shared low range stays
  byte-identical to upstream, so `migrate.ts` merges cleanly there.
- **Fork-local migrations live in a reserved high band**, starting at
  `FORK_MIGRATION_BASE = 9000` (see `src/core/migrate.ts`). Upstream's counter
  will never reach it. Add new fork migrations by appending within the band.
- Band order is **not** chronological — every fork-band migration is idempotent
  (`ADD COLUMN IF NOT EXISTS`, `CREATE ... IF NOT EXISTS`, guarded `ADD
  CONSTRAINT`) and order-independent, so appending is safe.

**Healing brains hit by a past collision.** A brain that recorded version 119 under
the old (fork) numbering will never re-run the upstream 118/119 placed there now
(they're ≤ its bookmark). The fix is a **catch-up migration in the band** (e.g.
`reconcile_forked_118_119` at `FORK_MIGRATION_BASE + 3`) that re-applies the exact
same DDL idempotently. On a fresh install it's a harmless no-op.

**Guardrail.** `test/migration-fork-band.test.ts` pins: unique versions, fork
migrations live only in the band, upstream 118/119 restored by name, and the
schema is healed after a full init. Run it after touching `migrate.ts`.

## Merge-conflict hotspots

When merging `origin/master`, expect to resolve these (the fork has large local
deltas here):

- `src/core/operations.ts` — biggest delta (per-call source, get_page union,
  attribution threading). Conflicts likely.
- `src/core/migrate.ts` — should conflict ONLY if upstream edits the shared low
  range you also touched; the fork band (9000+) is additive and won't conflict.
- `src/core/{postgres,pglite}-engine.ts` — `getPageLayers`, `putPage` /
  `logIngest` attribution columns.
- `src/core/oauth-provider.ts`, `src/commands/auth.ts` — federated_write.
- `src/schema.sql`, `src/core/pglite-schema.ts`, `src/core/schema-embedded.ts` —
  schema additions; `schema-embedded.ts` is generated (`bun run build:schema`).

## Sync process (do this monthly, not yearly)

```bash
git fetch origin fork
git switch -c sync/upstream-$(date +%Y%m%d) fork/perennia
git merge origin/master            # resolve conflicts using the hotspot list above
bun run typecheck
bun run test                       # full unit suite
# (E2E if DATABASE_URL is available — see CLAUDE.md)
git push fork sync/upstream-$(date +%Y%m%d)
gh pr create --repo perennia-regen/gbrain --base perennia
```

On merge, after resolving `migrate.ts`: if upstream added migrations that the fork
had shadowed (collision), restore them at their upstream numbers and add a
band catch-up so already-migrated brains heal. Re-run
`test/migration-fork-band.test.ts`.

The `.github/workflows/upstream-sync.yml` workflow automates the fetch + merge
attempt + test run and opens a PR (or an issue on conflict) on a schedule.

## Upstream-first for generic features

If a feature is not perennia-specific, **send it to `garrytan/gbrain` instead of
(or before) the fork.** Anything that merges upstream stops being fork delta and
costs zero to maintain. The ideal permanent delta is the minimum that is genuinely
Perennia-specific.
