# Codex integration

PXPipe integrates with the Codex CLI as a dedicated ChatGPT-authenticated OpenAI
Responses route. It is not the Anthropic Warp path and it does not replace or
copy Codex authentication state.

```bash
pxpipe codex
pxpipe codex --binary codex-ar
```

The persistent listener routes Codex through `/providers/codex`, forwards the
caller's ChatGPT authorization, uses HTTPS Responses transport, and forwards
`/responses/compact` byte-for-byte. Native Codex compaction remains authoritative.

## Optimization objective

Codex is different from a client that repeatedly sends a large uncached prompt.
Its automatic prompt cache can make a stable historical prefix very cheap. PXPipe
therefore does **not** treat every positive text-to-image delta as a reason to
change modality.

The dedicated Codex optimizer applies these gates in order:

1. semantic safety — system/developer authority, live tool state, current work,
   reasoning/opaque items and malformed protocol state stay native;
2. protocol closure — completed `function_call`/`function_call_output` and
   `custom_tool_call`/`custom_tool_call_output` rounds are paired by `call_id` and
   selected atomically;
3. immutable history sections — old safe history seals into token-sized sections;
   a partial section stays native until it reaches the section target;
4. whole-plan materiality — the candidate must pay for image tokens **and** all
   PXPipe-native framing/fact-sheet tokens with a meaningful absolute, percentage
   and per-image margin;
5. cache preservation — after provider usage proves a native prefix is warm,
   PXPipe refuses the first image transition. If a compressed epoch is already
   warm, later candidates are accepted only when every previous history page is
   an exact byte-prefix of the new page list;
6. context-pressure override — only near a deliberately conservative high-context
   threshold may history preservation outweigh the warm-cache transition guard.

The result is intentionally selective. A Codex request can be fully routed and
measured by PXPipe while remaining native text. That is expected when native
prompt caching is already the better representation.

## Custom tools

Modern Codex trajectories use custom tools heavily. PXPipe treats a completed
custom-tool round as protocol-atomic state:

```text
custom_tool_call(call_id=X)
custom_tool_call_output(call_id=X)
```

Open, orphaned, duplicate, reversed, referenced, or otherwise malformed state is
never removed from native Responses input. Parallel contiguous rounds are paired
as a unit so PXPipe cannot leave only one side of a tool exchange on the wire.

Telemetry exposes function and custom-tool counts separately in
`responses_composition`, including completed/recent/old/imageable/collapsed and
open/orphan/malformed counts.

## Prompt-cache stability

PXPipe keeps a bounded in-memory observation for each Codex trajectory. It stores
only token counts and short hashes of accepted history PNGs — no prompt/tool text.
The previous provider response supplies the authoritative `input_tokens` and
`cached_tokens` observation.

A warm native trajectory is left native. Once a compressed epoch is established
on a cold/low-cache turn, its old PNG page hashes must remain an exact prefix of
all later accepted candidates. New history is appended as newly sealed sections;
old pages are not regenerated merely because another message became cold.

A daemon restart intentionally forgets this observation. The first eligible
request is then kept native so PXPipe can observe the real provider cache state
before changing representation.

## Economics and reporting

The transform gate and report use the same three components for a history
candidate:

```text
net raw saving = represented text - image tokens - PXPipe native framing
```

Codex additionally requires a material absolute margin, a material percentage of
the represented text, and a minimum saving per physical PNG. This prevents tiny
under-filled pages from being emitted just because they save one token.

`pxpipe codex report --model gpt-5.6-sol` separates raw provider-input shrink from
cache-weighted economics and now reports optimizer/history abstention reasons and
stream termination categories. `client_aborted` is shown as its own lifecycle
category rather than being presented only as a generic "abnormal" count.

For a controlled comparison use the routed native-text arm:

```bash
pxpipe codex --passthrough
```

Both arms keep the same PXPipe route/auth/accounting plumbing; the passthrough
child changes only the compression decision.

## Safety boundaries

The dedicated optimizer never makes these imageable in `coding-safe` or
`balanced` merely to increase savings:

- system/developer instructions;
- tool definitions;
- live/current tool results;
- open or malformed tool protocol state;
- reasoning/encrypted/opaque Responses items;
- the current user request;
- native `/responses/compact` payloads.

When the safe, material and cache-stability gates do not all pass, PXPipe leaves
the request native.
