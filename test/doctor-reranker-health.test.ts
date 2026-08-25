/** Provider-neutral reranker health remediation, isolated from doctor DB tests. */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { logRerankFailure } from '../src/core/rerank-audit.ts';
import { withEnv } from './helpers/with-env.ts';

test.each([
  { reason: 'auth' as const, count: 1, expected: ['COHERE_API_KEY', 'Cohere (reranker)'] },
  { reason: 'network' as const, count: 5, expected: ['provider service status', 'Cohere (reranker)'] },
  { reason: 'unknown' as const, count: 3, expected: ['provider diagnostics', 'Cohere (reranker)'] },
])('reranker_health derives Cohere guidance for $reason failures', async ({ reason, count, expected }) => {
  const auditDir = mkdtempSync(join(tmpdir(), `gbrain-rerank-doctor-cohere-${reason}-`));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      for (let i = 0; i < count; i++) {
        logRerankFailure({
          model: 'cohere:rerank-v3.5',
          reason,
          query_hash: `${reason}${i}`,
          doc_count: 2,
          error_summary: `rerank HTTP ${reason === 'auth' ? 401 : 500}`,
        });
      }
      const check = await checkRerankerHealth({
        async getConfig(key: string): Promise<string | null> {
          return key === 'search.reranker.enabled' ? 'true' : null;
        },
      } as any);
      expect(check.status).toBe('warn');
      for (const fragment of expected) expect(check.message).toContain(fragment);
      expect(check.message).toContain('https://dashboard.cohere.com/api-keys');
      expect(check.message).not.toContain('ZEROENTROPY_API_KEY');
      expect(check.message).not.toContain('ZE status');
    });
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});
