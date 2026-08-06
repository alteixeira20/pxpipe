# Unified provider routing

PXPipe can multiplex provider-specific proxy configurations behind one HTTP
listener without guessing which OpenAI-compatible upstream should receive an
ambiguous `/v1/chat/completions` request.

## Route contract

Legacy routes remain valid and use the default provider configuration:

```text
/v1/messages
/v1/chat/completions
/v1/responses
```

Explicit provider routes use:

```text
/providers/<provider-id>/<upstream-path>
```

Examples:

```text
/providers/anthropic/v1/messages
/providers/openai/v1/chat/completions
/providers/featherless/v1/chat/completions
/providers/featherless/v1/responses
```

The selected proxy receives the original method, headers, query string, body
stream and abort signal, with only the internal `/providers/<id>` prefix removed.
Model payloads, schemas, tool declarations, images and structured-output fields
are not decoded or rewritten by the router.

## Security properties

- Provider selection comes only from the URL path.
- Routing headers, query parameters and model payloads cannot override it.
- Provider identifiers are limited to lowercase letters, digits and dashes.
- Unknown explicit providers fail closed with HTTP 404 and contact no upstream.
- Registry inspection returns route metadata only; credentials and full proxy
  configurations are never serialized.
- Each provider retains its own capability cache, circuit breaker, upstream,
  authentication override and request observer.

## Host integration

`createProviderRouter()` is runtime-neutral and returns one Web `Request` to
`Response` handler. The Node host will attach this handler to the existing
`127.0.0.1:47821` listener in the next stacked slice, sharing the current
tracker and dashboard observer across all provider routes.

This first slice intentionally does not disable the existing Featherless unit.
Service migration occurs only after the unified listener passes live Anthropic,
Featherless and AGY checks.
