# Bounded AGY batch execution

`pxpipe agy-batch` executes newline-delimited AGY prompts under explicit safety
limits. It is provider-independent and does not depend on Synapse internals.

```bash
cat prompts.txt | pxpipe agy-batch \
  --max-calls 100 \
  --max-duration 30m \
  --max-input-tokens 1000000 \
  --concurrency 2 \
  --timeout 10m \
  --max-output-bytes 16777216 \
  --stop-on quota,auth,systemic \
  -- --print --output-format json
```

A file may be supplied with `--input prompts.txt`. Each non-empty line becomes
one AGY prompt appended after the AGY arguments following `--`.

## Guard behavior

- The request count is claimed atomically before each call.
- The wall-clock budget is checked before another call starts.
- Input tokens use a clearly labelled protective estimate; they are never
  reported as provider usage or savings.
- Concurrency is capped by the request limit.
- Each subprocess has an independent timeout and output limit.
- Signals propagate to the active process group.
- Quota, authentication and systemic provider failures stop future work by
  default.
- Quota/rate/auth cooldown state is shared with `pxpipe doctor agy`.
- AGY stdout and stderr bytes are forwarded as produced; PXPipe writes only its
  final summary to stderr.

A clear quota failure prevents unclaimed work from starting. Calls already in
flight are cancelled through the shared abort controller.
