import type { Recipe } from '../types.ts';

/**
 * Cohere's hosted Rerank v2 API uses the same request/response contract as
 * gateway.rerank(): `{model, query, documents, top_n?}` in and
 * `{results: [{index, relevance_score}]}` out. The only provider-specific
 * delta is the `/v2/rerank` endpoint, so this recipe can ride the gateway's
 * native reranker path without an adapter or Cohere SDK dependency.
 *
 * Reference: https://docs.cohere.com/v2/reference/rerank
 */
export const cohere: Recipe = {
  id: 'cohere',
  name: 'Cohere (reranker)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.cohere.com',
  // Prevent a config-plane URL override from exfiltrating COHERE_API_KEY.
  // The credential is only ever sent to Cohere's official API origin.
  allow_base_url_override: false,
  auth_env: {
    required: ['COHERE_API_KEY'],
    setup_url: 'https://dashboard.cohere.com/api-keys',
  },
  touchpoints: {
    reranker: {
      models: ['rerank-v4.0-pro', 'rerank-v4.0-fast', 'rerank-v3.5'],
      // Keep the ZeroEntropy migration guide's recommended target as the
      // default while allowing Cohere's current v4 variants explicitly.
      default_model: 'rerank-v3.5',
      // Defensive client-side ceiling. gateway.rerank() rejects larger
      // payloads before network I/O and the search pipeline fails open.
      max_payload_bytes: 5_000_000,
      path: '/v2/rerank',
    },
  },
  setup_hint:
    'Create an API key at https://dashboard.cohere.com/api-keys, then ' +
    '`export COHERE_API_KEY=...`, `gbrain config set search.reranker.model ' +
    'cohere:rerank-v3.5`, and `gbrain config set search.reranker.enabled true`.',
};
