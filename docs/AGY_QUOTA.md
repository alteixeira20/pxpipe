# AGY model-aware readiness and quota state

Live AGY readiness checks must name the model being tested:

```bash
pxpipe doctor agy \
  --model gemini-3.6-flash-high \
  --live \
  --json
```

`pxpipe doctor agy --live` without `--model` is rejected. This prevents a
failure in AGY's default Claude model from being reported as a global AGY
failure.

The non-billable form remains:

```bash
pxpipe doctor agy --json
pxpipe doctor agy --model gemini-3.6-flash-high --json
```

It inspects the binary, version, help capabilities, discovered model catalogue,
local authentication artifacts, PXPipe server reachability and existing
model-specific cooldown state. It performs no inference request.

## Cooldown scope

Cooldown entries are keyed by:

- non-reversible local authentication-context digest;
- exact model identifier;
- failure category.

Quota and rate-limit failures are model-specific:

```text
claude-sonnet-4-6         blocked
 gemini-3.6-flash-high    available
```

Authentication failures are intentionally authentication-context-wide because
the same missing login affects every model using that context.

The store is:

```text
~/.pxpipe/agy-cooldowns.json
```

It contains no credentials, prompt content, account email address, project name,
conversation data or raw AGY output. Authentication/profile inputs contribute
only to a SHA-256 digest. Credential files contribute path, size and mtime to
the in-memory digest material; their contents are never read.

The obsolete singular file:

```text
~/.pxpipe/agy-cooldown.json
```

is removed by the model-aware entrypoint because its global scope could let an
exhausted Claude quota pool block an available Gemini model.

## Reset durations

Compound durations are supported:

```text
39m9s       -> 2349 seconds
1h 2m 3s   -> 3723 seconds
```

The model-aware doctor preserves AGY's original exit code in its `live` report
and stores only the safe failure category and reset timing.

## Current boundary

This slice covers explicit doctor checks and pre-execution cooldown enforcement
for `pxpipe agy` and `pxpipe warp -- agy`. Transparent classification of every
ordinary AGY structured invocation will be completed with the unified CONNECT
observer, where PXPipe can see the provider response without rewriting AGY's
stdout or stderr.
