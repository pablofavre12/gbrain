/** The same exact temporal ACL contract on real PostgreSQL with isolated databases. */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { defineTemporalAclTests } from '../helpers/link-temporal-acl-scenario.ts';

const databaseUrl = requirePostgresTestDatabase();
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let fixture: Awaited<ReturnType<typeof template.clone>>;
beforeAll(async () => { template = await persistencePostgresTemplate(databaseUrl); }, 120_000);
beforeEach(async () => { fixture = await template.clone(); });
afterEach(async () => { await fixture?.close(); });
afterAll(async () => { await template?.dispose(); });
defineTemporalAclTests(() => fixture.engine);
