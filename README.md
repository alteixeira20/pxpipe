# pxpipe

**A reliability-first token-saving proxy for coding agents.**

pxpipe can reduce repeated LLM input by rendering selected *cold* context as dense PNG pages before a request reaches the model. The key constraint is semantic safety: code, diagnostics, project rules, tool contracts, and other live working state should not become lossy merely because pixels are cheaper than tokens.

The default runtime policy is therefore **`coding-safe`**. It keeps the agent's active working set as native text and only allows sufficiently old, closed conversation history to enter the image-compression path on the currently validated model.

> Historical pxpipe releases were substantially more aggressive: they could image system/tool documentation and large tool results. Those paths remain available behind `PXPIPE_PROFILE=aggressive` for controlled A/B evaluation, but they are no longer the production-safe default.

## Why this exists

Coding agents repeatedly send large context windows. A dense image can represent far more characters per provider input token than the same material as native text, and pxpipe has measured large per-request reductions on suitable workloads. But image compression is not a transparent codec:

- OCR/vision can misread exact identifiers even when general comprehension is excellent;
- moving instructions from a system/developer role into a user-role image can change instruction salience;
- rasterized source, diffs, tests, and tool output can cause an agent to re-read or rediscover information;
- a per-request token win can still be a task-level loss if the transformed trajectory needs extra turns or tool calls.

pxpipe now treats those as first-class product constraints. **Semantic eligibility is checked before token profitability.**

![Example dense rendered context](docs/assets/example-render.png)

## Quick start

```bash
npx pxpipe-proxy
```

The proxy listens on `127.0.0.1:47821` by default.

Claude Code:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

Or use Warp when you do not want to replace the application's base URL:

```bash
pxpipe warp -- claude
```

Dashboard:

```text
http://127.0.0.1:47821/
```

The dashboard exposes recent requests, measured token accounting, rendered pages, model scope, a live compression kill switch, and the exact gate reason for text-only requests. AGY/Antigravity traffic uses the same persistent loopback listener and appears in this telemetry when the daemon is healthy.

## Reliability profiles

### `coding-safe` — default

```bash
PXPIPE_PROFILE=coding-safe pxpipe
```

Current behavior:

- system/project authority remains native text;
- tool definitions and behavioral tool documentation remain native;
- live tool results remain native, including Read/Grep output, diffs, compiler errors, test failures, stack traces, structured state, and exact identifiers;
- destructive tool-result paging is unreachable from the safe profile;
- only sufficiently old, closed history remains eligible for image collapse;
- the history gate uses a conservative multi-turn amortization horizon;
- only the currently validated safe model family is transformed;
- a pxpipe transform implementation error fails open to a native-text retry before any model request is duplicated.

The validated safe model scope currently includes the **Claude 5 family** (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-5` — every one of which resolves to the identical measured Claude render profile), **Gemini 3.6 Flash** (including AGY/Antigravity `-high`, `-medium`, and `-low` effort aliases), and **`gpt-5.6-sol`** (the Codex CLI's own model, including `gpt-5.6-sol-codex`). Other render profiles still exist, but technical image support alone is not enough to qualify as a safe coding default: admission is by resolved profile, not by name, so pre-4.7 Claude and Sol's sibling variants (`gpt-5.6-terra`, `gpt-5.6-luna`) are still passed through.

For Gemini/AGY, a fresh one-turn request can legitimately produce **no image**: coding-safe keeps system/tool authority native and waits for a sufficiently old, closed conversation prefix. The default Google policy keeps the most recent eight contents byte-exact and can collapse an older closed prefix once at least four units and roughly 2k text tokens are eligible and the image gate is profitable. The dashboard's request **Details** view explains this decision even when no PNG was emitted.

### `balanced`

```bash
PXPIPE_PROFILE=balanced pxpipe
```

Uses the same non-destructive live-state boundaries as `coding-safe`, with a somewhat less conservative archival-history policy. It still does **not** image live tool results or move tool authority into images.

### `aggressive` — experimental / A-B only

```bash
PXPIPE_PROFILE=aggressive \
PXPIPE_MODELS=claude-fable-5 \
pxpipe
```

Restores the previous maximum-density behavior. This mode may render static context, tool documentation, and large tool results; image-budget paging/truncation can occur. It is intentionally lossy and should be used only against a native-text control arm.

Other models can be opted into here for explicit experiments:

```bash
PXPIPE_PROFILE=aggressive \
PXPIPE_MODELS=gemini-3.6-flash,gpt-5.6-sol \
pxpipe
```

### `passthrough`

```bash
PXPIPE_PROFILE=passthrough pxpipe
```

Disables compression while preserving proxy routing, authentication, streaming, telemetry, and provider compatibility.

`PXPIPE_DISABLE=1` and the dashboard compression switch are also hard kill switches.

See [`docs/RELIABILITY_PROFILES.md`](docs/RELIABILITY_PROFILES.md) for the policy and acceptance criteria in detail.

## Safety model

pxpipe follows a simple order of operations:

```text
content
  |
  +-- Is changing modality semantically safe here? -- no --> native text
  |
  +-- Is the serving model/provider path validated? -- no --> native text
  |
  +-- Is the rendered representation cheaper under the same cache state? -- no --> native text
  |
  `-- yes --> render the eligible cold context
```

The result is intentionally asymmetric. Missing a possible compression win is acceptable; silently changing the agent's behavior is not.

### Live tool-result fidelity guard

The public API also exports `shouldKeepToolResultSharp()`. It conservatively recognizes source-like content, code fences, diffs, stack traces, compiler/runtime diagnostics, test output, path+line references, structured machine state, and exact machine identifiers.

Built-in safe profiles do not depend on that heuristic: **all live tool results stay text**. The classifier is defense-in-depth for custom or experimental hosts that deliberately enable tool-result imaging.

### Transform fail-open

For recognized model-request paths, the Node and Worker hosts keep a retryable request clone. If pxpipe itself fails during transformation *before upstream inference begins*, the host retries once through the same routing/auth/bridge stack with compression disabled and adds:

```text
x-pxpipe-fail-open: transform-error
```

It does **not** retry upstream 5xx responses, timeouts, transport failures, or provider error envelopes, because those may already have reached the model provider.

Uploads, audio, and unrelated pass-through bodies are not cloned for this mechanism.

## Prompt-cache-aware accounting

For Anthropic Messages traffic, pxpipe can compare the transformed request against `/count_tokens` on the original body. Its accounting treats Anthropic cache reads/writes as provider behavior rather than crediting the cache discount to pxpipe.

The project records the relevant telemetry in:

```text
~/.pxpipe/events.jsonl
```

Important distinction:

- **per-request savings** answer: “Was this particular request cheaper after transformation?”
- **task-level efficiency** answers: “Did the agent finish the task with fewer total tokens, turns, reads, and tool calls?”

The latter is the release-quality metric for coding-agent behavior. A proxy can save 60% on each request and still be worse if it makes the agent issue twice as many requests.

See [`docs/CACHING_AND_SAVINGS.md`](docs/CACHING_AND_SAVINGS.md).

## Evidence so far

The strongest paired coding evidence in the repository predates the new conservative profile and therefore demonstrates that the *rendering concept can work*, not that every current profile/model combination is automatically safe.

### SWE-bench Lite

Fable 5, 10 paired tasks:

| arm | resolved | per-request request-size effect |
| --- | ---: | ---: |
| pxpipe ON | **10/10** | about **-65%** |
| native text | **10/10** | baseline |

Receipts: [`eval/swe-bench/`](eval/swe-bench/).

### SWE-bench Pro

Fable 5, 19 completed paired tasks:

| arm | resolved |
| --- | ---: |
| pxpipe ON | **14/19** |
| native text | **15/19** |

Verdicts agreed on 18/19 tasks. The one disagreement was re-run three times with pxpipe and resolved all three times, consistent with ordinary agentic run variance rather than a reproducible compression failure. The measured ON requests were roughly 60% smaller on that benchmark window.

Receipts: [`eval/swe-bench-pro/`](eval/swe-bench-pro/).

These runs are useful evidence, but they are not a license to rasterize every model or every context class. New provider/model paths must clear the stronger task-level acceptance gate described below.

## Model evaluation

Image-reading quality varies materially by model. The repository contains arithmetic, gist/state, never-stated, dense-identifier, and provider-profile receipts under [`eval/`](eval/).

Several models can understand pxpipe images well while still performing poorly on exact dense identifiers. That is why the safe default is narrower than the set of technically supported render profiles.

To expand the safe allow-list, a model/provider path should demonstrate paired non-inferiority on coding tasks while collecting at least:

- task/test success;
- total effective input tokens per completed task;
- output tokens;
- model turns;
- total tool calls;
- Read/Grep/search calls;
- repeated reads of the same target;
- completion time;
- refusals/fallbacks;
- exact-identifier failures.

## Featherless.ai

Featherless routing and model capability discovery are supported, including models such as `moonshotai/Kimi-K3`.

```bash
PXPIPE_PROVIDER=featherless \
OPENAI_UPSTREAM=https://api.featherless.ai \
OPENAI_API_KEY="$FEATHERLESS_API_KEY" \
pxpipe
```

Under the safe profiles, **Featherless image transformation is disabled** until that provider/model path has equivalent coding non-inferiority evidence. Requests still proxy normally.

For an explicit lossy experiment:

```bash
PXPIPE_PROFILE=aggressive \
PXPIPE_PROVIDER=featherless \
PXPIPE_FEATHERLESS_TRANSFORM=auto \
PXPIPE_MODELS=moonshotai/Kimi-K3 \
OPENAI_UPSTREAM=https://api.featherless.ai \
OPENAI_API_KEY="$FEATHERLESS_API_KEY" \
pxpipe
```

`PXPIPE_FEATHERLESS_TRANSFORM=off|auto|force` is honored in the explicit aggressive host mode. Capability discovery, fallback, and the per-model circuit breaker remain provider safeguards; they do not imply coding-quality validation.

## OpenAI / Responses / Cloudflare routes

pxpipe contains OpenAI Chat Completions, Responses, Cloudflare-compatible, Gemini/Google, and protocol-bridge support. Render profiles are model-specific because image pricing and readable geometry differ by model family.

The safe host profile fails closed on unvalidated families. Use `aggressive` plus an explicit `PXPIPE_MODELS` list to evaluate them without changing the production-safe default.

## AGY integration

pxpipe can wrap AGY and provides model discovery, doctor diagnostics, bounded batch execution, and optional Warp routing.

```bash
pxpipe agy --help
pxpipe models agy
pxpipe doctor agy
```

AGY quota/rate cooldowns are scoped by authentication context and selected model. An exhausted Claude quota pool must not block an unrelated Gemini model. Authentication failures remain auth-context-wide.

Compression through AGY still requires a route for the actual inference endpoint; without one, the wrapper simply forwards AGY execution and does not claim token compression.

## Offline export (no proxy)

Offline export is an explicit/manual image workflow and is independent of the `coding-safe` proxy default. It lets you deliberately render reference material without running the proxy.

```bash
pxpipe export src/
cat large-reference.txt | pxpipe export --stdin
pxpipe export --git
```

Each run writes a private `pxpipe-export-XXXXXX/` directory containing `page-*.png`, `factsheet.txt`, `manifest.json`, and `prompt.txt`. Those pages can be uploaded to image-capable clients such as Cursor.

Offline export is intentionally user-directed and lossy. Source code and other byte-exact working state should remain native text in normal coding-agent sessions.

## Configuration

Common environment variables:

| variable | purpose |
| --- | --- |
| `PORT` | listener port, default `47821` |
| `HOST` | bind address, default loopback |
| `PXPIPE_PROFILE` | `coding-safe`, `balanced`, `aggressive`, `passthrough` |
| `PXPIPE_MODELS` | comma-separated transform scope; `off` disables |
| `PXPIPE_DISABLE` | hard process-wide pass-through switch |
| `PXPIPE_UPSTREAM` | shared upstream API base |
| `ANTHROPIC_UPSTREAM` | Anthropic-specific upstream |
| `OPENAI_UPSTREAM` | OpenAI-compatible upstream |
| `OPENAI_API_KEY` | optional OpenAI-compatible key override |
| `PXPIPE_PROVIDER` | provider mode such as `featherless` |
| `PXPIPE_FEATHERLESS_TRANSFORM` | `off`, `auto`, `force` for explicit Featherless experiments |
| `PXPIPE_LOG` | JSONL event path |
| `PXPIPE_DUMP_DIR` | debug rendered-page dump directory |
| `PXPIPE_DEBUG_CAPTURE_4XX` | opt-in sensitive 4xx body capture |

Run:

```bash
pxpipe --help
```

for the runtime's complete current list.

## Library API

The package exposes the transformer, renderer, applicability/model-scope helpers, safety policies, accounting, provider router, and proxy primitives.

Example:

```ts
import { transformAnthropicMessages } from 'pxpipe-proxy/transform';

const result = await transformAnthropicMessages({
  body,
  model: 'claude-fable-5',
  options: { profile: 'coding-safe' },
});
```

The library defaults to the same coding-safe semantic policy and fails open by returning the original bytes with `reason: 'transform_error'` if the transform implementation throws.

## Development and release gate

Requirements: Node 18+ and pnpm 10.21.0.

```bash
corepack enable
corepack prepare pnpm@10.21.0 --activate
pnpm install --frozen-lockfile
pnpm run audit
pnpm run typecheck
pnpm test
pnpm run build
```

Pull requests and `main` are covered by the repository CI quality gate. Behavioral compression changes should additionally be validated against a native-text control arm; unit tests alone cannot prove trajectory non-inferiority.

## Security and privacy

pxpipe runs as a local proxy by default. Request content can contain source code, prompts, credentials, and tool output.

- dashboard routes are loopback-only;
- persisted debug request bodies are opt-in;
- generated debug/render artifacts use private file permissions in the Node host;
- provider credential forwarding is constrained by route/auth handling;
- Worker deployments that inject provider API keys require `PXPIPE_WORKER_SECRET` to avoid exposing an open key-spending endpoint.

Read [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) before exposing the proxy beyond localhost.

## What pxpipe does **not** promise

- Images are not byte-exact text storage.
- The factsheet does not preserve every identifier or relationship.
- Old-history image collapse is still lossy.
- A technically supported vision model is not automatically a safe coding model.
- Per-request savings do not prove lower task-level cost.
- AGY is not compressed unless its inference traffic is actually routed through pxpipe.

Those constraints are why the production default now keeps the live working set native and treats aggressive rasterization as an experiment rather than a hidden optimization.

## License

MIT. See [`LICENSE`](LICENSE).
