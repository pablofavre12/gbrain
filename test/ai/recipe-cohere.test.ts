/**
 * Cohere hosted reranker recipe + gateway wire contract.
 *
 * The transport is stubbed: these tests never read a real credential or make
 * a network request.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import {
  __setRerankTransportForTests,
  configureGateway,
  defaultResolveAuth,
  rerank,
  resetGateway,
  RerankError,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

function mockResponse(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('recipe: cohere', () => {
  test('is registered with the supported v2 reranker contract', () => {
    const recipe = getRecipe('cohere');
    expect(recipe).toBeDefined();
    expect(recipe!.tier).toBe('openai-compat');
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBe('https://api.cohere.com');
    expect(recipe!.allow_base_url_override).toBe(false);
    expect(recipe!.auth_env?.required).toEqual(['COHERE_API_KEY']);

    const touchpoint = recipe!.touchpoints.reranker!;
    expect(touchpoint.models).toEqual([
      'rerank-v4.0-pro',
      'rerank-v4.0-fast',
      'rerank-v3.5',
    ]);
    expect(touchpoint.default_model).toBe('rerank-v3.5');
    expect(touchpoint.path).toBe('/v2/rerank');
    expect(touchpoint.max_payload_bytes).toBe(5_000_000);
  });

  test('resolves COHERE_API_KEY as Bearer auth and fails closed when absent', () => {
    const recipe = getRecipe('cohere')!;
    expect(
      defaultResolveAuth(recipe, { COHERE_API_KEY: 'cohere-test-key' }, 'reranker'),
    ).toEqual({
      headerName: 'Authorization',
      token: 'Bearer cohere-test-key',
    });
    expect(() => defaultResolveAuth(recipe, {}, 'reranker')).toThrow(AIConfigError);
  });

  test('gateway posts the Cohere v2 request and maps its response', async () => {
    configureGateway({
      reranker_model: 'cohere:rerank-v3.5',
      env: { COHERE_API_KEY: 'cohere-test-key' },
    });

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    __setRerankTransportForTests(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return mockResponse({
        results: [
          { index: 1, relevance_score: 0.97 },
          { index: 0, relevance_score: 0.42 },
        ],
      });
    });

    const result = await rerank({
      query: 'which document is relevant?',
      documents: ['first', 'second'],
      topN: 2,
    });

    expect(capturedUrl).toBe('https://api.cohere.com/v2/rerank');
    expect(new Headers(capturedInit!.headers).get('authorization')).toBe(
      'Bearer cohere-test-key',
    );
    expect(new Headers(capturedInit!.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(JSON.parse(capturedInit!.body as string)).toEqual({
      model: 'rerank-v3.5',
      query: 'which document is relevant?',
      documents: ['first', 'second'],
      top_n: 2,
    });
    expect(result).toEqual([
      { index: 1, relevanceScore: 0.97 },
      { index: 0, relevanceScore: 0.42 },
    ]);
  });

  test('missing key becomes an auth-classified RerankError before transport', async () => {
    configureGateway({ reranker_model: 'cohere:rerank-v3.5', env: {} });
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResponse({ results: [] });
    });

    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('expected rerank to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RerankError);
      expect((error as RerankError).reason).toBe('auth');
      expect((error as Error).message).toContain('COHERE_API_KEY');
      expect(called).toBe(false);
    }
  });

  test('rejects a configured base URL override before auth or transport', async () => {
    const credential = 'cohere-must-not-leave-official-origin';
    configureGateway({
      reranker_model: 'cohere:rerank-v3.5',
      base_urls: { cohere: 'https://attacker.example' },
      env: { COHERE_API_KEY: credential },
    });
    let called = false;
    let observedAuthorization = '';
    __setRerankTransportForTests(async (_url, init) => {
      called = true;
      observedAuthorization = new Headers(init.headers).get('authorization') ?? '';
      return mockResponse({ results: [] });
    });

    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('expected base URL override rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AIConfigError);
      expect((error as Error).message).toContain('does not allow provider base URL overrides');
      expect((error as Error).message).not.toContain(credential);
      expect(called).toBe(false);
      expect(observedAuthorization).toBe('');
    }
  });
});
