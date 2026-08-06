# Featherless model discovery

PXPipe uses two related caches:

1. An in-process, authorization-isolated capability cache used by the proxy.
2. A sanitized local model-catalog cache used by management commands.

## Commands

```bash
pxpipe models featherless
pxpipe models featherless --refresh
pxpipe models featherless --json
pxpipe doctor featherless
pxpipe doctor featherless --json
```

`models featherless` fetches `/v1/models` only when the catalog is absent or
older than five minutes. `--refresh` explicitly bypasses the fresh catalog.
When discovery is unavailable, a catalog younger than 24 hours is returned as
stale with a warning. API keys are never written to the cache or command
output.

The persisted catalog contains only:

- model identifier;
- grounded vision-capability decision;
- provider status when supplied;
- input modalities when supplied;
- fetch time and upstream origin.

The proxy capability cache is bounded to 256 authorization-isolated entries,
coalesces concurrent lookups, negatively caches models without grounded vision
metadata, and serves stale decisions while one background refresh runs.
Discovery failure remains fail-closed: without positive provider metadata,
PXPipe passes the request through as text.

## Files and permissions

```text
~/.cache/pxpipe/featherless-models.json
```

The cache directory is created privately and the catalog is written with mode
`0600` through a temporary-file rename.
