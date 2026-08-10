# PXPipe 0.13 reliability milestone

PXPipe 0.13 moves the fork from request-size optimization toward task-level coding-agent reliability.

## Default safety contract

`coding-safe` keeps system/project authority, tool definitions, live tool results, source code, diffs, diagnostics and the recent conversation tail as native text. Only old closed history is eligible for image compression, and renderer-known character loss fails closed to text.

For validated Gemini 3.6 Flash / AGY traffic, the recent eight Google contents remain native. A closed older prefix may collapse after four eligible contents and 2,000 estimated text tokens, but only when the provider-specific image-cost gate predicts at least 20% local headroom. Public Google requests still get provider countTokens validation; Antigravity uses this conservative margin because no grounded public countTokens endpoint is available. `balanced` uses six recent contents / two old units / 1,500 tokens. `aggressive` remains explicit A/B-only behavior.

## AGY/Antigravity

AGY uses the persistent PXPipe CONNECT listener when healthy. Only grounded Antigravity inference endpoints are diverted; control-plane traffic tunnels unchanged. The outer Antigravity envelope is preserved and only its nested GenerateContent request is transformed.

Google function-call trajectories now participate in the same repeated-read circuit breaker as Anthropic. Historical function calls are deduplicated by position+payload fingerprints without persisting prompts, paths, arguments or tool-result text. Three exact repeated read/search operations after a real image exposure force the rest of that session to native text.

## Explainability

Every live inference carrying transform metadata now gets a dashboard request-detail id even when no image was emitted. The Details panel explains common outcomes such as fresh/no-history, below threshold, not profitable, unsupported model, renderer loss, provider validation failure, and an active repeated-retrieval breaker.

## Other hardening

- Google trajectory exposure is recorded only after the final body decision, so a public-Google countTokens rollback cannot falsely arm the circuit breaker.
- Google/AGY trajectory ids feed the existing dashboard session accounting.
- AGY model discovery rejects heading-only tokens such as `GPT-OSS` while preserving real versioned/namespaced ids.
- The package runtime contract is Node >=20.19, matching the modern TypeScript/Vitest/Vite toolchain used to build and validate this fork.

## Task-level A/B telemetry

`/api/current-session.json` now exposes provider-reported input/output/cache token totals plus tool calls, read/search calls, repeated reads, repeated tool results and circuit-breaker state. These counters are provider-neutral and remain available for Google/AGY even when dollar pricing is intentionally unknown. Use them to compare completed tasks, not isolated request shrinkage.
