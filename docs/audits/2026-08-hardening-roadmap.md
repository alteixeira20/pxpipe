# PXPipe hardening roadmap — 2026-08

This document tracks the audit and implementation slices without merging
unvalidated work directly into `main`.

## Pull-request map

| Slice | Work | Pull request | State |
|---|---|---:|---|
| 1 | First-class AGY wrapper | #1 | Draft |
| 2 | AGY quota/auth/failure classification | #1 foundation; #2 execution guard | Draft |
| 3 | AGY non-billable/live preflight | #1 | Draft |
| 4 | Bounded AGY orchestration | #2 stacked on #1 | Draft |
| 5 | Featherless audit and completion | #3, #7 | Draft |
| 6 | Featherless discovery/cache hardening | #4 stacked on #3 | Draft |
| 7 | Provider-neutral compression contracts | #5 | Draft |
| 8 | Token/cost accounting normalization | #6 | Draft |

## Confirmed findings

1. Featherless 429 fallback could double upstream calls and then open the image
   circuit breaker.
2. The dashboard collapsed generic `skipped` into `capability-skipped`.
3. Capability discovery was unbounded and lacked request coalescing and stale
   behavior.
4. AGY quota failures are machine-readable but PXPipe had no AGY-specific
   vocabulary, cooldown or readiness report.
5. Generic warp banners print command arguments. AGY prompts and JSON schemas
   therefore require a separate value-free diagnostic path.
6. The tracker captures many useful usage buckets, but downstream code can still
   mix provider-reported evidence, estimates and byte reduction.
7. A transform implementation exception currently produces a synthetic 502.
   The requested provider-neutral contract is fail-open to the original request;
   this remains a focused production follow-up with fault injection.
8. Original serialized request bytes and a measured PXPipe-only latency component
   are not yet first-class event fields, so dashboard byte reduction and proxy
   overhead cannot be normalized without further proxy-boundary measurements.

## Merge gates

Every PR head must pass:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

AGY live gates:

```bash
pxpipe warp -- agy --version
pxpipe warp -- agy --help
pxpipe warp -- agy --print "Reply with OK"
pxpipe doctor agy --json
```

Featherless live gates:

```bash
pxpipe models featherless --refresh
pxpipe doctor featherless --json
```

A real 429 must show one upstream attempt and must not open the image breaker by
itself. An AGY quota run must preserve the original stdout/stderr and exit code,
classify the failure safely, extract reset duration when available, and block
unclaimed repeated work during the cooldown.

## Intended merge order

1. #1
2. #2 after rebasing onto #1
3. #3
4. #4
5. #7
6. #5
7. #6

All PRs remain draft until their exact current head SHA is audited. No draft or
failing PR should be merged.
