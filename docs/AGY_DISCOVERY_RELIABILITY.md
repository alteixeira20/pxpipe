# AGY model discovery reliability

PXPipe treats the installed AGY CLI as an external dependency whose presentation and binary version can change independently of PXPipe.

Model discovery therefore follows these rules:

- `agy --version` establishes the current executable identity.
- `agy models` is non-billable and is the only model-catalog command used.
- Model identifiers may be read from stdout or informational stderr, but raw stderr is never persisted.
- Human-formatted tables, bullets, and ANSI decoration are accepted for recognized Claude, Gemini, and OpenAI-compatible model identifiers.
- If AGY changes version or executable mtime while discovery is in progress, PXPipe re-runs `agy models` once and stamps the cache with the post-update identity.
- An empty/unparseable discovery result never overwrites a previously valid catalog.
- If a refresh temporarily fails and a sanitized catalog exists for the same executable path, PXPipe may return it as a stale fallback rather than silently replacing it with an empty catalog.

The cache remains private at `~/.cache/pxpipe/agy-models.json` and contains only executable identity, fetch time, and sanitized model descriptors. It does not contain prompts, credentials, account identities, project names, conversations, or raw AGY stderr.

## Persistent AGY routing

`pxpipe agy` now prefers the already-running loopback PXPipe listener instead of launching AGY direct and bypassing dashboard/accounting. Before spawning AGY, PXPipe probes the local `/proxy-stats` endpoint. When the listener is healthy it supplies that loopback URL through AGY's standard HTTP(S) proxy environment together with PXPipe's matching local CA certificate. If the listener is unavailable, routing fails open and AGY keeps its native direct networking; `PXPIPE_AGY_AUTO_PROXY=off` explicitly requests the same direct mode.

The persistent CONNECT listener does not redirect all Google traffic. Only the grounded Antigravity inference endpoints `/v1internal:generateContent` and `/v1internal:streamGenerateContent` on the known Cloud Code origins are diverted into provider-isolated PXPipe routes. Other endpoints on those hosts, including model discovery and code-assist control-plane calls, are re-originated unchanged. Unrelated hosts remain blind CONNECT tunnels.

Antigravity owns an outer provider envelope containing routing/session metadata and a nested Google GenerateContent request. PXPipe transforms only that nested `request` object. A pass-through or failed-safe transformation returns the original outer request bytes unchanged, while response accounting accepts Google usage/candidate metadata nested under Antigravity's `response` envelope without rewriting the provider response.

`pxpipe doctor agy --model MODEL --json` reports `route.mode` as `persistent`, `explicit`, or `direct`. `compressionReady` is true for the persistent path only when PXPipe is reachable and the selected model maps to a measured Gemini image profile. Explicit `PXPIPE_AGY_ROUTE(S)`/`pxpipe warp --route` configuration remains available for diagnostics and compatibility, but it is no longer required for normal AGY interception.