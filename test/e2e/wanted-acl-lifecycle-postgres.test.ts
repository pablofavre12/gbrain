import { test } from 'bun:test';
import { wantedAclLifecycle, wantedIncompleteAttendance, wantedIncompleteAttendanceExtraction } from '../helpers/wanted-acl-lifecycle-scenario.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
const databaseUrl = requirePostgresTestDatabase();
test('reader-relative wanted lifecycle on isolated PostgreSQL', () => wantedAclLifecycle(databaseUrl), 120_000);
test('incomplete attendance preserves wanted inventory and prior graph', () => wantedIncompleteAttendance(databaseUrl), 120_000);
test('unmanaged attendance inventory backfills and refuses stale snapshots', () => wantedIncompleteAttendanceExtraction(databaseUrl), 120_000);
