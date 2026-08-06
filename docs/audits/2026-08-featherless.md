# Featherless integration audit — 2026-08

## Scope reviewed

- OpenAI-compatible chat request transformation;
- slash-qualified model routing;
- capability discovery and authorization isolation;
- JSON and SSE provider error envelopes;
- streaming deltas and usage;
- tool calls and JSON Schema;
- native multimodal inputs;
- response/header transparency;
- fallback, timeout, cancellation and circuit-breaker behavior;
- event accounting and credential non-exposure.

## Existing strengths

The integration already has broad tests for URL normalization, exact discovery
paths, authentication forwarding, off/auto modes, explicit model allow-lists,
capability metadata, authorization-isolated caching, degraded pass-through,
streaming error prelude inspection, partial output, tool-call deltas,
independent abort controllers, client disconnects, event propagation and secret
non-exposure.

## Confirmed defects addressed by the PR stack

1. **429 amplification** — one transformed request could immediately generate a
   second text request, worsening the rate limit and opening the image breaker.
   PR #3 suppresses that non-discriminating retry.
2. **Misleading dashboard state** — generic skipped requests appeared as
   `capability-skipped`. PR #3 separates skipped/degraded/capability states.
3. **Unbounded/duplicated capability discovery** — PR #4 adds bounds,
   single-flight loading, negative caching and stale-while-revalidate.
4. **No model-catalog operations** — PR #4 adds refresh, listing and doctor
   commands with a sanitized private cache.
5. **Failure vocabulary incomplete** — this slice adds safe classification for
   authentication, permission, rate limit, model availability, payload rejection,
   timeout, transient upstream and provider envelopes, including `Retry-After`.

## Grounded capability policy

Vision is enabled only from positive provider metadata. A successful request
with image-shaped content is not treated as capability proof. Missing or
incomplete metadata remains text-only.

## Context-limit conclusion

No model-specific serialized-request cap is added in this audit. The repository
correctly warns that a guessed provider cap can disable valid compression and
that intermediate proxies may produce provider-shaped 413 responses. A limit
should be added only from authoritative provider metadata or attributable
provider evidence.

## Contracts added

- structured-output schema remains exact;
- tool parameters remain machine-readable;
- multiple native images are neither duplicated nor recursively recompressed;
- unsupported media parts pass through unchanged;
- streaming tool-call and usage chunks remain intact;
- provider-specific headers and response bytes remain unchanged;
- model identifiers containing `/` survive discovery and completion routing.

## Remaining work before merge

- Run the complete test suite for every stacked branch.
- Perform one live `models featherless --refresh` check.
- Verify a real 429 emits one upstream attempt and preserves `Retry-After`.
- Verify cancellation against an actual long-running Featherless stream.
- Decide whether generic provider retries should exist at all; current policy
  classifies retries but does not introduce an unbounded retry loop.
