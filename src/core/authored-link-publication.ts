/** Publish authored input without certifying or replacing unresolved attendance edges. */
import type { BrainEngine } from './engine.ts';
import type { PageSnapshot } from './page-state/types.ts';
import { replaceAuthoredLinkInventory, type AuthoredLinkReference } from './authored-link-inventory.ts';
import { possibleWantedRows } from './wanted-links-store.ts';

export async function publishAuthoredLinkInventory(engine: BrainEngine, snapshot: PageSnapshot,
  references: AuthoredLinkReference[]): Promise<void> {
  await engine.transaction(async tx => {
    const { slug, source_id: sourceId, id: pageId } = snapshot.page;
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    if (!current || current.page.id !== pageId || current.revision !== snapshot.revision
      || current.sourceIncarnation !== snapshot.sourceIncarnation) return;
    await replaceAuthoredLinkInventory(tx, { pageId, sourceId, revision: snapshot.revision },
      await possibleWantedRows(tx, sourceId, references));
  });
}
