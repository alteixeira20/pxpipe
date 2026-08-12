# Provider-neutral accounting model

PXPipe must not describe character reduction as token savings. Accounting is
split into independent evidence classes.

## Evidence priority

1. **Provider-reported** — an original-request baseline from the provider and
   actual provider usage for the transformed request.
2. **Estimated** — provider/model-specific token estimates for both request
   shapes.
3. **Bytes-only** — original and transformed serialized request sizes.
4. **Unavailable** — insufficient evidence; no savings number is emitted.

Provider-reported evidence always wins when both reported and estimated values
exist. Estimates remain available for diagnostics but do not replace the
reported result.

## Provider input semantics

Anthropic reports uncached input, cache creation and cache reads as disjoint
buckets. Physical input tokens are their sum.

OpenAI-compatible providers, Featherless and Google report cached tokens as a
subset of input tokens. The cached bucket must not be added to input again.

## Normalized fields

- original/transformed bytes and compression ratio;
- provider-reported original and actual input tokens;
- provider-reported token reduction and ratio;
- estimated original/actual input tokens and reduction;
- cache-read and cache-write buckets;
- image tokens;
- output and total tokens;
- PXPipe-added latency and model latency as separate inputs;
- fallback count;
- bypass reason;
- provider and model labels.

The normalization API does not infer latency components from wall-clock values
or invent an original token baseline. Callers must supply measured evidence.
