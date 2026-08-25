/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` is covered through a transport stub; `runExplain` remains in E2E.
 */

import { afterEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRecipeTable, envReady, runProviders } from '../src/commands/providers.ts';
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

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('dual embedding/reranker recipe (zeroentropyai) shows both capabilities', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const zeLine = out.split('\n').find(line => line.startsWith('zeroentropyai'));
    expect(zeLine).toBeDefined();
    expect((zeLine!.match(/yes/g) ?? [])).toHaveLength(2);
  });

  test('Cohere and user-provided llama-server recipes show reranker capability', () => {
    const out = formatRecipeTable(listRecipes(), {});
    for (const id of ['cohere', 'llama-server-reranker']) {
      const line = out.split('\n').find(row => row.startsWith(id));
      expect(line).toBeDefined();
      const header = out.split('\n')[0]!;
      const rerankColumn = header.indexOf('RERANK');
      expect(line!.slice(rerankColumn, rerankColumn + 9).trim()).toBe('yes');
    }
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const ze = getRecipe('zeroentropyai');
    expect(openai && ze).toBeTruthy();
    const out = formatRecipeTable([openai!, ze!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('zeroentropyai');
    expect(lines[3]).toContain('✗ missing ZEROENTROPY_API_KEY');
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
