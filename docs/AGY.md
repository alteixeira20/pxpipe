# AGY integration

PXPipe treats AGY as a first-class command without assuming that AGY uses an
Anthropic, OpenAI, Gemini, or Featherless endpoint.

## Commands

```bash
pxpipe agy --version
pxpipe agy --help
pxpipe agy --print "Reply with OK"
pxpipe doctor agy
pxpipe doctor agy --json
pxpipe doctor agy --live
```

The named command forwards AGY arguments unchanged. Interactive mode, print
mode, structured output, JSON Schema, model and effort selection, continuation,
conversation identifiers, sandbox settings, permission modes, projects, agents,
plugins, authentication and Remote Control remain AGY-owned behavior.

`pxpipe doctor agy` is non-billable. It checks the executable, version, help
capabilities, local authentication artifacts, route configuration, proxy health
and the short-lived failure cooldown. `--live` explicitly opts into one minimal
model request.

## Safe routing

AGY is run directly unless a route is explicitly configured. This prevents a
working AGY installation from being redirected through an API shape it does not
support.

Configure one route:

```bash
PXPIPE_AGY_ROUTE='provider.example/v1/*=http://127.0.0.1:47821' \
  pxpipe agy --print 'Reply with OK'
```

Configure several routes with semicolons or newlines:

```bash
PXPIPE_AGY_ROUTES='provider-a.example/v1/*=http://127.0.0.1:47821;provider-b.example/api/*=http://127.0.0.1:47821' \
  pxpipe agy
```

The generic warp form remains available:

```bash
pxpipe warp \
  --route 'provider.example/v1/*=http://127.0.0.1:47821' \
  -- agy --print 'Reply with OK'
```

Only matched inference paths are diverted. Authentication, project APIs,
plugins, telemetry and Remote Control continue to their original hosts.

## Failure classification

PXPipe recognizes AGY structured error envelopes and classifies:

- authentication unavailable;
- quota exhausted;
- rate limited;
- model unavailable;
- permission denied;
- timeout;
- malformed structured output;
- transport failure.

Quota and rate-limit reset durations are extracted when AGY supplies them. A
short-lived local cooldown stores only the failure category and timestamps. It
does not store account email addresses, prompts, schemas, credentials,
conversation content or AGY output.

Normal AGY stdout, stderr, exit codes and signals remain authoritative. PXPipe
diagnostics go to stderr and never include prompt or schema values.

## Diagnostic environment

```text
PXPIPE_AGY_ROUTE
PXPIPE_AGY_ROUTES
PXPIPE_AGY_DEBUG
PXPIPE_AGY_LIVE_TIMEOUT_MS
```

`PXPIPE_AGY_DEBUG` prints route-level diagnostics only. It is off by default.
