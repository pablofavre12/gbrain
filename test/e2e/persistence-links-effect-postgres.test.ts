import { afterAll, beforeAll, describe, test } from 'bun:test';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { exerciseRemoteLinks, remoteLinksCases } from '../helpers/remote-links-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('remote mention-links effect on PostgreSQL (#6007)', () => {
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
  let fixture: Awaited<ReturnType<typeof template.clone>>;
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    fixture = await template.clone();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); await template?.dispose(); });
  for (const scenario of remoteLinksCases) test(scenario, () => exerciseRemoteLinks(fixture.engine, scenario), 60_000);
  for (const scenario of ['links', 'restart', 'acl', 'acl_names'] as const) test(`${scenario} on a managed brain`, () => exerciseRemoteLinks(fixture.engine, scenario, { managed: true }), 60_000);
});
