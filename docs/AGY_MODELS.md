# AGY model discovery

PXPipe discovers the model identifiers exposed by the installed AGY binary:

```bash
pxpipe models agy
pxpipe models agy --json
pxpipe models agy --refresh --json
```

The command runs only:

```text
agy --version
agy models
```

It performs no model inference call and consumes no AGY model quota.

## Cache

The sanitized cache is stored at:

```text
~/.cache/pxpipe/agy-models.json
```

It is invalidated when any of these change:

- five-minute TTL;
- AGY executable path;
- AGY version;
- AGY executable modification time;
- explicit `--refresh`.

The file contains only executable identity, fetch time and model descriptors.
It does not contain prompts, credentials, account email addresses, projects,
conversation IDs or AGY stderr. The cache is written atomically with owner-only
permissions.

## Classification

Model identifiers provide a conservative protocol hint, not proof of AGY's
wire protocol:

- `claude-*` → Anthropic hint;
- `gemini-*` → Google hint;
- `gpt-*` and `oN-*` → OpenAI-compatible hint;
- everything else → unknown, passthrough.

Validated PXPipe compression support is currently reported for Claude-family
models and Gemini 3.6 Flash variants. Other recognized families are marked
experimental until actual AGY traffic confirms their protocol shape and the
provider-neutral golden tests pass.

The later CONNECT integration slice will combine this catalogue with observed
host/path/protocol metadata. It will never redirect a model solely from its
name.
