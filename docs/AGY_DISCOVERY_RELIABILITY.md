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
