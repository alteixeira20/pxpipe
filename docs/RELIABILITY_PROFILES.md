# Reliability profiles

pxpipe is a context optimizer, not a transparent codec. Rendering text into images can reduce provider input tokens substantially, but it changes modality and can lose exact glyph-level information. For coding agents that matters: source code, diffs, diagnostics, tool preconditions, project instructions, and live machine state are decision inputs rather than reference prose.

The runtime therefore applies a semantic safety policy **before** token-profitability math.

## Default: `coding-safe`

`PXPIPE_PROFILE=coding-safe` is the default.

On the currently validated production path (`claude-fable-5`):

- system/project/tool authority stays native text in its original protocol role;
- tool definitions stay native;
- live tool results stay native, so Read/Grep/diffs/tests are never rasterized or paged by pxpipe;
- only sufficiently old, closed conversation history remains eligible for image collapse;
- the history profitability gate uses a 4-turn amortization horizon rather than the legacy cold-per-turn gate;
- unsupported or unvalidated model families pass through without transformation;
- a pre-upstream transform failure is retried once with `compress:false` instead of failing the agent turn.

This profile is intentionally conservative. It attacks repeat-sent archival context while leaving the agent's current working set byte-exact.

## `balanced`

`PXPIPE_PROFILE=balanced` keeps the same semantic boundaries as `coding-safe`: authority text, tool documentation, and live tool results remain native. It uses less conservative archival-history settings (3-turn amortization horizon and, on GPT history-capable paths once validated, a shorter protected tail) to trade a little more context compression for a little less recency margin.

`balanced` is still non-destructive for live coding state. It does **not** enable the old tool-result truncation path.

## `aggressive`

`PXPIPE_PROFILE=aggressive` restores the previous maximum-density behavior for controlled A/B evaluation:

- static context may be rendered;
- tool descriptions may be stubbed and moved to a rendered tool reference;
- large tool results may be rendered;
- tool-result paging/truncation may occur to satisfy image budgets;
- legacy 2,000-character static and 6,000-character tool-result thresholds are used.

This mode is explicitly lossy and is **not** the default for coding work. Use it only when the workload has been evaluated against a native-text control arm.

## `passthrough`

`PXPIPE_PROFILE=passthrough` disables compression. Routing, authentication, streaming, telemetry, and provider compatibility remain active.

`PXPIPE_DISABLE=1` and the dashboard compression kill switch are also hard one-way disable controls.

## Model-safety boundary

Safe profiles are deliberately narrower than the renderer's technical model support.

At this reliability milestone, `coding-safe` and `balanced` admit the Claude 5 family (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-5`), Gemini 3.6 Flash, and `gpt-5.6-sol`. A dashboard model toggle or stale `PXPIPE_MODELS` value cannot silently broaden a safe profile beyond that set. Other models pass through unchanged until their provider-specific transform has an equivalent coding non-inferiority evaluation.

Admission is per resolved render profile, never per name. Every admitted Claude id resolves to the *same* `CLAUDE_PROFILE` object Fable 5 was validated on; `gpt-5.6-sol` and `gpt-5.6-sol-codex` resolve to the same `GPT56_SOL_PROFILE`. Ids that merely share a version number do not qualify: pre-4.7 Claude uses the `standard` vision tier (a 1568 px server-side downscale the dense 312-column strip was not measured against), and `gpt-5.6-terra` / `gpt-5.6-luna` use the generic 5.x flagship geometry (152 columns, a different font, and the `pairs` Responses planner instead of `mixed`).

For explicit experiments, `aggressive` honors `PXPIPE_MODELS`, for example:

```sh
PXPIPE_PROFILE=aggressive \
PXPIPE_MODELS=gemini-3.6-flash,gpt-5.6-sol \
pxpipe
```

The distinction is important: "the model can read pxpipe images" is not the same acceptance criterion as "the model completes coding tasks with no material increase in rereads, tool calls, turns, or failures."

## Transform fail-open behavior

Compression is optional. A transform implementation failure must not make a valid client request fail.

For recognized model request paths, the Node and Worker hosts keep a retryable clone. If pxpipe itself returns its exact pre-upstream transform failure envelope, the host retries that request once through the same routing/authentication/bridge pipeline with `compress:false` and marks the response:

```text
x-pxpipe-fail-open: transform-error
```

pxpipe does **not** retry upstream 5xx responses, transport failures, timeouts, or provider error envelopes. Those may have reached the provider already; retrying them could duplicate an inference request.

Uploads/audio/arbitrary passthrough bodies are not cloned for this mechanism.

## Live tool-result fidelity classifier

The public safety-policy API exports `shouldKeepToolResultSharp()` for hosts that deliberately enable tool-result imaging. It conservatively recognizes code, diffs, compiler/runtime diagnostics, test output, stack traces, path+line references, structured state, and exact machine identifiers.

Safe built-in profiles do not depend on this classifier: they keep **all** live tool results native. The classifier is defense-in-depth for custom/experimental hosts.

## What remains lossy

Old-history image collapse is still a lossy representation. pxpipe retains current user/task text and recent/open tool state using the existing history safeguards, but an archival image is not a byte-exact transcript. Exact values required for a current operation should be reacquired from their source rather than guessed from pixels.

This is why safe profiles keep the live working set native and why only the strongest validated reader is transformed by default.

## Acceptance criteria for expanding safe scope

A model/provider path should not be added to the safe default solely because it has good OCR or per-request token savings. It should pass paired task-level evaluation that records at least:

- task/test success;
- total effective input tokens per completed task;
- output tokens;
- model turns;
- total tool calls;
- Read/Grep/search calls and repeated reads of the same target;
- task completion time;
- refusals/fallbacks;
- exact-identifier failures.

Per-request `saved_pct` is necessary accounting evidence, but it holds the agent trajectory fixed. It cannot detect a transform that causes the agent to issue extra requests.

## Deployment examples

Conservative default:

```sh
pxpipe
```

Explicitly pin the default:

```sh
PXPIPE_PROFILE=coding-safe pxpipe
```

More archival compression with the same live-state boundaries:

```sh
PXPIPE_PROFILE=balanced pxpipe
```

No compression, proxy/routing only:

```sh
PXPIPE_PROFILE=passthrough pxpipe
```

Legacy A/B arm:

```sh
PXPIPE_PROFILE=aggressive PXPIPE_MODELS=claude-fable-5 pxpipe
```

For deployment validation, run the repository's full quality gate before switching a service or publishing a package:

```sh
pnpm install --frozen-lockfile
pnpm run audit
pnpm run typecheck
pnpm test
pnpm run build
```
