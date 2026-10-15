import { test } from 'bun:test';
import { wantedAclLifecycle, wantedIncompleteAttendance, wantedIncompleteAttendanceExtraction } from './helpers/wanted-acl-lifecycle-scenario.ts';
test('reader-relative wanted targets survive canonical extraction and ACL lifecycle', () => wantedAclLifecycle(), 120_000);
test('incomplete attendance preserves wanted inventory and prior graph', () => wantedIncompleteAttendance(), 120_000);
test('unmanaged attendance inventory backfills and refuses stale snapshots', () => wantedIncompleteAttendanceExtraction(), 120_000);
