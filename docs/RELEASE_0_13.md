# PXPipe 0.13 reliability milestone

PXPipe 0.13 moves the fork from request-size optimization toward task-level coding-agent reliability.

## Default safety contract

`coding-safe` keeps system/project authority, tool definitions, live tool results, source code, diffs, diagnostics and the recent conversation tail as native text. Only old closed history is eligible for image compression, and renderer-known character loss fails closed to text.

For validated Gemini 3.6 Flash / AGY traffic, the recent eight Google contents remain native. A closed older prefix may collapse after four eligible contents and 2,000 estimated text tokens, but only when the provider-specific image-cost gate predicts at least 20% local headroom. Public Google requests still get provider `countTokens` validation; Antigravity uses this conservative margin because no grounded public `countTokens` endpoint is available. `balanced` uses six recent contents / two old units / 1,500 tokens. `aggressive` remains explicit A/B-only behavior.

A fresh one-turn coding request is therefore expected to remain text. “Compression ready” means the route and model can safely participate in the policy; it does not promise that every request will emit a PNG.

## AGY/Antigravity

AGY uses the persistent PXPipe CONNECT listener when healthy. Only grounded Antigravity inference endpoints are diverted; control-plane traffic tunnels unchanged. The outer Antigravity envelope is preserved and only its nested GenerateContent request is transformed.

Google function-call trajectories now participate in the same repeated-read circuit breaker as Anthropic. Historical function calls are deduplicated by position+payload fingerprints without persisting prompts, paths, arguments or tool-result text. Three exact repeated read/search operations after a real image exposure force the rest of that session to native text.

Antigravity's provider-owned nested `sessionId` is hashed and used to isolate trajectory state. Two AGY conversations with the same opening prompt cannot accidentally share a repeated-read breaker. If neither a provider session id nor textual user task is available, PXPipe declines to create trajectory state rather than grouping unrelated traffic under a model-wide bucket.

## Explainability

Every live inference carrying transform metadata now gets a dashboard request-detail id even when no image was emitted. The Details panel explains common outcomes such as fresh/no-history, below threshold, not profitable, unsupported model, renderer loss, provider validation failure, and an active repeated-retrieval breaker.

## Other hardening

- Google trajectory exposure is recorded only after the final body decision, so a public-Google `countTokens` rollback cannot falsely arm the circuit breaker.
- Google/AGY trajectory ids feed the existing dashboard session accounting.
- AGY model discovery rejects heading-only tokens such as `GPT-OSS` while preserving real versioned/namespaced ids.
- The package runtime contract is Node >=20.19, matching the modern TypeScript/Vitest/Vite toolchain used to build and validate this fork.
- CI validates the supported Node 20.19, 22 and 24 lines and runs the production dependency audit, typecheck, full test suite and build on each line.

## Task-level A/B telemetry

`/api/current-session.json` exposes provider-reported input/output/cache token totals plus request count, transformed-request count, tool calls, read/search calls, repeated reads, repeated tool results and circuit-breaker state. These counters are provider-neutral and remain available for Google/AGY even when dollar pricing is intentionally unknown. Raw compression counterfactuals are kept separate from dollar estimates.

Use these values to compare completed tasks, not isolated request shrinkage. A release is successful only when the coding-safe arm is non-inferior on task correctness and does not materially increase turns, reads/searches, repeated retrievals or wall time while reducing total provider input on representative long-running tasks.

## Deployment acceptance gate

Before treating 0.13 as a daily-driver release:

1. Install/build the exact `main` commit and restart the single user service on `127.0.0.1:47821`.
2. Confirm `pxpipe models agy --refresh --json` returns real model ids and no human heading such as `GPT-OSS`.
3. Confirm `pxpipe doctor agy --model gemini-3.6-flash-high --json` reports the persistent route and `compressionReady: true`.
4. Run a one-turn AGY smoke request. It should appear in the dashboard; under coding-safe it may correctly remain text and its Details view must explain why.
5. Run a real multi-turn coding task long enough to create more than eight Google contents. When an older closed prefix clears the safety and profitability gates, the dashboard should show history images while the recent eight contents and all live tool state remain native.
6. Inspect `/api/current-session.json`. In healthy operation the repeated-read count should stay low and `breakerActive` should remain false. If three exact repeated read/search actions occur after image exposure, the breaker must switch the session back to native text.
7. Repeat the same task in `PXPIPE_PROFILE=passthrough` and `coding-safe` with clean sessions. Compare correctness/tests first, then provider input/output/cache totals, turns/tool calls/read calls/repeated reads and wall time. Because coding-agent trajectories are stochastic, use multiple repetitions before attributing a difference to PXPipe.

Do not use `aggressive` as the production control arm. It intentionally retains the legacy lossy tool/static-context behavior for explicit experiments only.
