# Cohere Rerank

Cohere's hosted `rerank-v3.5`, `rerank-v4.0-pro`, and `rerank-v4.0-fast`
models are available through the `cohere` reranker recipe. The default stays
`rerank-v3.5`, matching the ZeroEntropy migration recommendation. The recipe
uses Cohere's native v2 endpoint and the same fail-open search stage as every
other gbrain reranker.

## Setup

1. Create an API key in the
   [Cohere dashboard](https://dashboard.cohere.com/api-keys).
2. Export it in the environment that runs gbrain:

   ```bash
   export COHERE_API_KEY=<your-key>
   ```

3. Select and enable the reranker:

   ```bash
   gbrain config set search.reranker.model cohere:rerank-v3.5
   gbrain config set search.reranker.enabled true
   ```

   To opt into a current v4 model, replace `rerank-v3.5` with
   `rerank-v4.0-pro` or `rerank-v4.0-fast`.

4. Verify configuration and reachability:

   ```bash
   gbrain models doctor
   ```

The recipe sends `POST https://api.cohere.com/v2/rerank` with Bearer auth. It
is pinned to Cohere's official API origin: a `provider_base_urls.cohere`
override is rejected before auth headers are resolved or any network request
is made, so the Cohere credential cannot be redirected to another host.

## Search behavior

`gateway.rerank()` sends `{model, query, documents, top_n}` and maps Cohere's
`results[].relevance_score` into gbrain's provider-neutral result shape. A
missing or invalid key, timeout, rate limit, malformed response, network
failure, or oversized request is audit-logged and search returns the original
RRF order. Raw query text is not written to the reranker failure audit.

The recipe applies a defensive 5 MB request ceiling before network I/O. This
is a gbrain safety bound, not a claim about Cohere's service quota.

## Cost caps

Cohere bills reranking per search rather than with gbrain's token-priced model.
The recipe therefore does not invent a `cost_per_1m_tokens_usd` conversion.
Runs with a strict gateway `--max-cost` cap fail closed as unpriced; normal
searches remain available. Track Cohere usage in its dashboard until gbrain
has a per-request reranker pricing contract.

API contract: [Cohere Rerank v2 reference](https://docs.cohere.com/v2/reference/rerank).
