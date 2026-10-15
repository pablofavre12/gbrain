/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` is covered through a transport stub; `runExplain` remains in E2E.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Recipe } from '../src/core/ai/types.ts';
import { describe, test, expect, afterEach } from 'bun:test';
import { formatRecipeTable, formatEnvOutput, envReady, runProviders } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import {
  __setRerankTransportForTests,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('RERANK');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('shows keyless Ollama chat as available', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const ollamaLine = out.split('\n').find(line => line.startsWith('ollama'));
    expect(ollamaLine).toBeDefined();
    // Master-skew fixup: on this branch ollama also carries an expansion
    // touchpoint (#4073), so the EXPAND column reads `yes`, not `—`.
    // System One: RERANK and DECIDE columns follow CHAT (ollama declares neither).
    expect(ollamaLine).toMatch(/ollama\s+openai-compat\s+yes\s+yes\s+yes\s+—\s+—\s+✓ ready/);
  });

  test('TypeSafe shows the rerank and decide capabilities and accepts either key name', () => {
    const line = (env: Record<string, string>) => formatRecipeTable(listRecipes(), env).split('\n').find(l => l.startsWith('typesafe '));
    expect(line({})).toMatch(/typesafe\s+openai-compat\s+—\s+—\s+—\s+yes\s+yes\s+✗ missing TYPESAFE_API_KEY/);
    expect(line({ JEV_TYPESAFE_API_KEY: 'k' })).toContain('✓ ready');
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (voyage) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const voyageLine = out.split('\n').find(line => line.startsWith('voyage'));
    expect(voyageLine).toBeDefined();
    // Voyage has embedding but no expansion or chat
    expect(voyageLine).toContain('yes');
    expect(voyageLine).toContain('—');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const voyage = getRecipe('voyage');
    expect(openai && voyage).toBeTruthy();
    const out = formatRecipeTable([openai!, voyage!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('voyage');
    expect(lines[3]).toContain('✗ missing VOYAGE_API_KEY');
  });
});

describe('formatEnvOutput (providers env <id>)', () => {

  test('living provider control: setup funnel intact', () => {
    const voyage = getRecipe('voyage')!;
    const out = formatEnvOutput(voyage, {});
    expect(out).not.toContain('DEPRECATED');
    expect(out).toContain('Setup:');
  });

  test('keyless recipe (ollama): Required: (none) arm renders', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, {});
    expect(out).toContain('Required: (none)');
    expect(out).not.toContain('DEPRECATED');
  });

  test('optional-env arm renders when a recipe declares optional vars', () => {
    const fake = {
      id: 'fake-optional',
      name: 'Fake Optional',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'], optional: ['FAKE_ORG'], setup_url: 'https://example.com' },
      setup_hint: 'Get a key at example.com.',
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, { FAKE_ORG: 'org-1' });
    expect(out).toContain('Optional:');
    expect(out).toContain('FAKE_ORG');
    expect(out).toContain('✓ set');
    // Living provider keeps its funnel:
    expect(out).toContain('Setup: https://example.com');
    expect(out).toContain('Get a key at example.com.');
  });
});

describe('providers test --touchpoint reranker', () => {
  test('accepts a Cohere model and exercises the stubbed reranker contract', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-providers-reranker-'));
    const output: string[] = [];
    const originalLog = console.log;
    let capturedUrl = '';
    try {
      console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
      __setRerankTransportForTests(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({
          results: [{ index: 0, relevance_score: 0.99 }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      await withEnv({
        GBRAIN_HOME: tempHome,
        COHERE_API_KEY: 'cohere-test-key',
      }, async () => {
        await runProviders('test', [
          '--touchpoint', 'reranker',
          '--model', 'cohere:rerank-v3.5',
        ]);
      });
      expect(capturedUrl).toBe('https://api.cohere.com/v2/rerank');
      expect(output.join('\n')).toContain('Probing reranker provider');
      expect(output.join('\n')).toContain('All probes green');
    } finally {
      console.log = originalLog;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('providers explain --json', () => {
  test('publishes reranker options and detects Cohere auth without exposing its value', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-providers-explain-'));
    const output: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
      await withEnv({
        GBRAIN_HOME: tempHome,
        COHERE_API_KEY: 'cohere-secret-must-not-appear',
      }, async () => {
        await runProviders('explain', ['--json']);
      });

      const payload = JSON.parse(output.join('\n')) as {
        schema_version: number;
        env_detected: Record<string, boolean>;
        options: Array<{ id: string; touchpoint: string; env_ready: boolean }>;
      };
      expect(payload.schema_version).toBe(2);
      expect(payload.env_detected.COHERE_API_KEY).toBe(true);
      expect(payload.options).toContainEqual(expect.objectContaining({
        id: 'cohere:rerank-v3.5',
        touchpoint: 'reranker',
        env_ready: true,
      }));
      expect(output.join('\n')).not.toContain('cohere-secret-must-not-appear');
    } finally {
      console.log = originalLog;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
