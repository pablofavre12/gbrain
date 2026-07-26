import { describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';

const put = operations.find((op) => op.name === 'put_page');
if (!put) throw new Error('put_page operation missing');

describe('gbrain put document automation flags', () => {
  test('parses repeatable/CSV ACL flags while document body stays off argv', () => {
    const params = parseOpArgs(put, [
      'documents/report',
      '--source', 'perennia',
      '--allowed-subject-id', 'user:a',
      '--allowed-subject-id', 'user:b,group:editors',
      '--document-id', 'doc-123',
      '--document-version-sequence', '7',
      '--document-version-hash', 'a'.repeat(64),
      '--json',
    ]);
    expect(params).toEqual({
      slug: 'documents/report',
      source: 'perennia',
      content: '',
      allowed_subject_ids: ['user:a', 'user:b', 'group:editors'],
      document_id: 'doc-123',
      document_version_sequence: 7,
      document_version_hash: 'a'.repeat(64),
    });
    // The generic parser always sources this field from fd 0, never argv.
    expect(params.content).toBe('');
  });
});
