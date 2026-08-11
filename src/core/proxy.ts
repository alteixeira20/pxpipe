/**
 * pxpipe proxy as a single Web-standard fetch handler.
 * Adapted by src/node.ts and src/worker.ts; uses only Request/Response/URL/fetch.
 */

import { markCacheDead, noteCacheOutcome, responseLeftNoCache } from './session-state.js';
import {
  noteTrajectoryCompression,
  observeAnthropicTrajectory,
  observeGoogleTrajectory,
  type TrajectoryObservation,
} from './trajectory.js';
import { applyTrajectoryCircuitBreaker } from './trajectory-policy.js';
import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';
import { isClaudeModel, transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import { isAnthropicMessagesPath, isPxpipeSupportedGptModel, isPxpipeSupportedModel } from './applicability.js';
import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
} from './measurement.js';
import type { Usage } from './types.js';
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponsesToAnthropicResponse,
} from './messages-responses-bridge.js';
import {
  anthropicMessagesToOpenAIChat,
  chatCompletionsUrl,
  openAIChatToAnthropicResponse,
} from './messages-chat-bridge.js';
import { pinCommandResponse, pinCommandResponseOpenAI } from './pin.js';
import { parseGoogleModelFromPath, transformGoogleGenerateContent } from './google.js';
import {
  inspectAntigravityEnvelope,
  isAntigravityInferencePath,
  transformAntigravityGenerateContent,
} from './antigravity.js';
import { resolveGoogleTransportProfile } from './google-transport-profiles.js';
import { resolveGptProfile } from './gpt-model-profiles.js';
import { Decompress as ZstdDecompress } from 'fzstd';
import {
  buildFeatherlessUpstreamUrl,
  detectProviderErrorEnvelope,
  discoverFeatherlessCapability,
  isCircuitBreakerOpen,
  normalizeUpstreamRoot,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  shouldFallbackFeatherlessResponse,
  type FeatherlessCapabilityDecision,
  type FeatherlessCapabilityResult,
  type FeatherlessTransformationState,
  type FeatherlessTransformMode,
} from './featherless.js';

export interface ProxyConfig {
  /** 'cloudflare-ai-gateway': routes both families through gatewayBaseUrl;
   *  OpenAI paths drop the `/v1` prefix to match gateway shape. */
  provider?: 'cloudflare-ai-gateway' | 'featherless';
  featherlessTransformMode?: FeatherlessTransformMode;
  /** Provider-specific Google wire envelope. Antigravity keeps model/project
   * metadata outside the nested GenerateContent request. */
  googleEnvelope?: 'antigravity';
  /** Custom fetch implementation (for unit tests / mock servers). */
  customFetch?: typeof fetch;
  /** Gateway base URL (account/gateway-scoped). Required when provider is set. */
  gatewayBaseUrl?: string;
  /** Extra headers injected on every upstream request (e.g. gateway auth). */
  gatewayHeaders?: Record<string, string>;
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** Override the Anthropic `authorization` bearer. Pass a function to re-resolve
   *  per request: subscription tokens expire, and a client that froze its bearer
   *  at startup (a container env var) cannot renew one mid-run. Resolving here
   *  keeps rotation on the host, with a single writer. */
  authToken?: string | (() => string | undefined);
  /** OpenAI API base for GPT chat completions, no trailing slash. */
  openAIUpstream?: string;
  /** Override or supply an OpenAI API key. If unset, we forward Authorization. */
  openAIApiKey?: string;
  /** Cloudflare's OpenAI-compatible Chat Completions endpoint and bearer key. */
  cloudflareUpstream?: string;
  cloudflareApiKey?: string;
  /** Exact model ids routed to each non-default provider. Unlisted Claude
   * models retain normal Anthropic routing. */
  openAIModels?: string[];
  cloudflareModels?: string[];
  /** Pass a function to inject dynamic values per-request (e.g. live charsPerToken);
   *  static object for Workers/tests. */
  transform?: TransformOptions | (() => TransformOptions);
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
  /** Persist 4xx diagnostics: the gzipped request body plus the upstream error
   *  body. Off by default because either side may contain prompts or secrets. */
  captureErrorReqBody?: boolean;
  /** Decode zstd-compressed JSON request bodies before model parsing and
   * transformation. Intended for the ChatGPT-authenticated Codex route; other
   * OpenAI-compatible routes retain their existing byte-for-byte behavior. */
  decodeZstdRequests?: boolean;
  /** Abort the upstream request if response headers have not arrived within this
   *  many ms. Cleared once headers land, so long generations are unaffected.
   *  0 disables. */
  upstreamHeadersTimeoutMs?: number;
  /** Abort the upstream response if no bytes arrive for this many ms. This is the
   *  stall guard: a wedged connection can otherwise be held open forever. 0 disables. */
  upstreamIdleTimeoutMs?: number;
  /** How long an in-flight request may reject an identical retry before the dedupe
   *  fails open. Prevents one stalled request from permanently 409-ing its retries.
   *  0 disables dedupe entirely. */
  duplicateHoldMs?: number;
  /** Hard ceiling, in bytes, on an inbound request body pxpipe will hold in
   *  memory. Transformable routes must read the whole body, so an unbounded
   *  read lets one caller choose the daemon/Worker allocation. Over-limit
   *  bodies receive a provider-shaped 413 before any upstream request. Label-
   *  only upload/audio routes are not rejected; their model sniff is bounded
   *  and the untouched remainder is streamed. Invalid values fall back to the
   *  conservative default rather than disabling the bound. */
  maxRequestBytes?: number;
}

export interface ProxyEvent {
  method: string;
  path: string;
  /** Top-level request model when present. Used for telemetry/dashboard labels only. */
  model?: string;
  /** Provider cost/usage semantics after any internal wire bridge. Unlike
   * `path`, this describes the upstream that actually billed the request. */
  accountingProvider?: 'anthropic' | 'openai' | 'google';
  status: number;
  /** Wall-clock ms from request start to event fire (≈ end of upstream body). */
  durationMs: number;
  /** Wall-clock ms from request start to upstream response headers. */
  firstByteMs?: number;
  /** Local transform/render time, excluding upstream inference and token probes. */
  transformMs?: number;
  info?: TransformInfo;
  /** Usage block from Anthropic's response — input/output/cache tokens. */
  usage?: Usage;
  /** Model stop reason from the response ("end_turn", "tool_use", "max_tokens",
   *  "refusal", …). "refusal" = safety classifier fired on the transformed request —
   *  scorers must fail cost comparisons on refusal rows (refusals emit almost no
   *  output and would otherwise look "cheaper"). OpenAI finish_reason ("stop",
   *  "length", "content_filter", …) is normalized into the same field. */
  stopReason?: string;
  error?: string;
  /** First ~2 KiB of the upstream 4xx body (not captured on 2xx or 5xx). */
  errorBody?: string;
  /** sha256[0..8] of the transformed outgoing body — set on every /v1/messages POST for correlation. */
  reqBodySha8?: string;
  /** Gzipped transformed body, populated only on 4xx. Node may write to sidecar (see reqBodySamplePath). */
  reqBodyGz?: Uint8Array;
  /** Set by the Node host instead of reqBodyGz when the body was written to a sidecar file. */
  reqBodySamplePath?: string;
  /** Ground-truth char counts from the response stream, independent of usage.output_tokens.
   *  Absent when the body couldn't be scanned (5xx, unknown content-type). See OutputMeasurement. */
  measurement?: OutputMeasurement;
  // Featherless / Observability fields:
  provider?: string;
  transformation_mode?: FeatherlessTransformMode;
  transformation_state?: FeatherlessTransformationState;
  capability_decision?: FeatherlessCapabilityDecision;
  capability_source?: 'api' | 'cache' | 'override';
  capability_cache_status?: 'hit' | 'miss' | 'bypass';
  skip_reason?: string;
  fallback_attempted?: boolean;
  fallback_reason?: string;
  fallback_result?: 'success' | 'failed' | 'not_attempted';
  upstream_attempt_count?: number;
  /** Non-secret classification of response stream completion / termination. */
  streamTermination?: 'response_terminal' | 'client_aborted' | 'upstream_ended_without_usage';
  /** Privacy-preserving session trajectory counters; never contains tool input, paths or result text. */
  trajectory?: TrajectoryObservation;
}

/** Max chars of 4xx error body captured on ProxyEvent — enough for Anthropic's full error JSON. */
const ERROR_BODY_MAX = 2048;

/** Headers should arrive well inside this; generous enough for slow reasoning starts. */
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 300_000;
/** No bytes for this long means the connection is wedged, not slow. */
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000;
/** Past this, an in-flight entry is treated as stale and a retry is let through. */
const DEFAULT_DUPLICATE_HOLD_MS = 60_000;
/**
 * Budget for a count-tokens probe. Both probes fail closed (null keeps the original
 * body), so expiring one costs that request's savings, never correctness. The Google
 * pair is awaited before the forward, so this is worst-case added latency; the
 * Anthropic pair only feeds telemetry.
 *
 * Neither provider publishes a latency SLO for count-tokens, and we have no probe
 * timing of our own, so this is not a measured figure. It is bounded by the one number
 * we do have: p99 time-to-headers for a full generation on the same route (30s over
 * 2166 Gemini requests in our telemetry). A probe does strictly less work than
 * first-token generation, so one that misses that mark is wedged rather than slow.
 */
const COUNT_TOKENS_TIMEOUT_MS = 30_000;
/** Sweep the in-flight map early once it grows past plausible real concurrency. */
const INFLIGHT_SWEEP_SIZE = 256;
/** Floor between size-triggered sweeps so genuine high concurrency stays O(1)/request. */
const INFLIGHT_SWEEP_MIN_INTERVAL_MS = 1_000;

/**
 * Abort the response if no chunk arrives for `ms`. Wraps the raw upstream stream so
 * the watchdog sees real network activity rather than post-transform output.
 */
function withIdleTimeout(
  res: Response,
  firstChunkMs: number,
  ms: number,
  onIdle: () => void,
): Response {
  if (!res.body || ms <= 0) return res;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  // The watchdog errors its own controller rather than relying on the fetch
  // implementation to tear the body down when the signal aborts.
  let ctl: TransformStreamDefaultController<Uint8Array> | undefined;
  const arm = (budget: number): void => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      onIdle();
      try {
        ctl?.error(new Error(`pxpipe: upstream stalled for ${budget}ms`));
      } catch {
        /* already errored or closed */
      }
    }, budget);
  };
  const watched = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        ctl = controller;
        // Nothing has streamed yet: the model may still be starting up, which is the
        // same wait the headers budget covers. Real traffic has taken >120s just to
        // return headers (max 146s over 41k requests), so charging the mid-stream idle
        // budget here would abort healthy slow starts.
        arm(firstChunkMs);
      },
      transform(chunk, controller) {
        // Bytes have flowed: from here a long silence means wedged, not slow.
        arm(ms);
        controller.enqueue(chunk);
      },
      flush() {
        clear();
      },
    }),
  );
  return new Response(watched, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Passthrough that notifies on client disconnect. `cancel` deliberately does not await
 * the inner cancel: with a wedged upstream that call can hang, which would in turn hang
 * the caller's `body.cancel()`.
 */
function withClientDisconnect(
  body: ReadableStream<Uint8Array>,
  onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      onCancel(reason);
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Cap on bodies buffered only to sniff a model name, on paths pxpipe does not
 *  transform. Chat requests naming a model are far below this; uploads that blow
 *  past it stream through unbuffered. */
const MODEL_SNIFF_MAX_BYTES = 1 << 20;

/** Default ceiling on a buffered inbound body: 16 MiB. Normal coding-agent
 * requests are far below this; deployments with a demonstrated need can raise
 * it explicitly. The limit is enforced on bytes actually read, never trusted
 * from Content-Length alone. */
export const DEFAULT_MAX_REQUEST_BYTES = 16 << 20;

function resolveMaxRequestBytes(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_REQUEST_BYTES;
  return configured;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

type BoundedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; observedBytes: number; declaredBytes?: number };

/** Read a complete body under a hard ceiling. Content-Length is only an early
 * rejection hint: missing or under-declared lengths are still bounded by the
 * running byte count. The reader is cancelled as soon as the limit is crossed. */
async function readBodyBounded(req: Request, limit: number): Promise<BoundedBody> {
  const declaredRaw = req.headers.get('content-length');
  const declared = declaredRaw === null ? NaN : Number(declaredRaw);
  const declaredBytes = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
  if (declaredBytes !== undefined && declaredBytes > limit) {
    return { ok: false, observedBytes: 0, declaredBytes };
  }

  const body = req.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          observedBytes: total,
          ...(declaredBytes !== undefined ? { declaredBytes } : {}),
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return { ok: true, bytes: concatChunks(chunks, total) };
}

/** Read only a bounded prefix for best-effort model labeling while preserving
 * the complete body byte-for-byte for forwarding. This keeps upload/audio
 * routes streaming regardless of their total size. */
async function sniffPrefixRestoringBody(
  req: Request,
  maxPrefix: number,
): Promise<{ prefix: Uint8Array<ArrayBuffer>; body: BodyInit | null }> {
  const body = req.body;
  if (!body) return { prefix: new Uint8Array(0), body: null };
  const reader = body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let total = 0;
  let exhausted = false;
  try {
    while (total < maxPrefix) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      prefixChunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }

  const prefix = concatChunks(prefixChunks, total);
  if (exhausted) return { prefix, body: prefix };

  const restored = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefixChunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else if (value && value.byteLength > 0) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, body: restored };
}

/** Read the actual top-level `model` field. The body is already buffered for
 * transformation, so parsing it is both safer and simpler than a prefix regex
 * (which could mistake `metadata.model` for the routing model). */
function readModelField(body: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof value.model === 'string' && value.model.length <= 200 ? value.model : null;
  } catch {
    return null;
  }
}

// Claude Code only admits gateway-discovered ids beginning with "claude" or
// "anthropic". Prefix provider ids for discovery, then remove that compatibility
// prefix before PXPIPE_MODELS matching and upstream routing.
const CLAUDE_GATEWAY_MODEL_PREFIX = 'claude-';

function claudeGatewayModelId(model: string): string {
  if (model.startsWith('claude-') || model.startsWith('anthropic')) return model;
  return CLAUDE_GATEWAY_MODEL_PREFIX + model;
}

function resolveClaudeGatewayModelId(model: string | null): string | undefined {
  if (!model?.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX)) return undefined;
  const providerModel = model.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length);
  return providerModel.includes('/') ? providerModel : undefined;
}

function routedModelDisplayName(model: string, route: 'openai' | 'cloudflare'): string {
  if (route === 'cloudflare' && /kimi-k3/i.test(model)) return 'Kimi K3 (Cloudflare)';
  return `${model} (${route === 'cloudflare' ? 'Cloudflare' : 'OpenAI'})`;
}

/** Gzip via CompressionStream — available in Node 18+ and Cloudflare Workers. */
async function gzipBytes(body: Uint8Array): Promise<Uint8Array> {
  // Cast: TS doesn't model Response(Uint8Array) even though it works in both runtimes.
  const stream = new Response(body as BufferSource).body!.pipeThrough(
    new CompressionStream('gzip'),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** SHA-256 hex of a byte buffer. */
async function sha256Bytes(body: Uint8Array): Promise<string> {
  // Cast: Web Crypto accepts Uint8Array at runtime despite the BufferSource type.
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

/**
 * Inspects a Response (both application/json and text/event-stream) for provider error envelopes.
 * For SSE, reads only a bounded prelude. If valid completion deltas are present, or no error
 * envelope is found, returns isError: false and a reconstructed Response containing all bytes.
 */
export async function inspectResponseForErrorEnvelope(res: Response): Promise<{
  isError: boolean;
  errorMsg?: string;
  response: Response;
}> {
  if (!res.ok) {
    return { isError: true, errorMsg: `http_status_${res.status}`, response: res };
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await res.text();
    const err = detectProviderErrorEnvelope(text);
    const newRes = new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    return err
      ? { isError: true, errorMsg: err, response: newRes }
      : { isError: false, response: newRes };
  }
  if (contentType.includes('text/event-stream') && res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const PRELUDE_MAX_BYTES = 4096;
    let hasDeltas = false;
    let providerError: string | null = null;
    let doneReading = false;

    while (totalBytes < PRELUDE_MAX_BYTES && !doneReading) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      if (value) {
        chunks.push(value);
        totalBytes += value.byteLength;
        const preludeText = new TextDecoder().decode(value);
        if (
          preludeText.includes('"delta"') ||
          preludeText.includes('"content"') ||
          preludeText.includes('"reasoning"') ||
          preludeText.includes('"thinking"') ||
          preludeText.includes('"tool_calls"') ||
          preludeText.includes('"function_call"')
        ) {
          hasDeltas = true;
          break;
        }
        const lines = preludeText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          let rawJson = trimmed;
          if (trimmed.startsWith('data:')) {
            rawJson = trimmed.slice(5).trim();
          }
          const err = detectProviderErrorEnvelope(rawJson);
          if (err) {
            providerError = err;
            break;
          }
        }
        if (providerError) break;
      }
    }

    const reconstructedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks.length > 0) {
          controller.enqueue(chunks.shift()!);
          return;
        }
        if (doneReading) {
          controller.close();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            doneReading = true;
            controller.close();
          } else if (value) {
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    const newRes = new Response(reconstructedStream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });

    if (hasDeltas) {
      return { isError: false, response: newRes };
    }
    if (providerError) {
      return { isError: true, errorMsg: providerError, response: newRes };
    }
    return { isError: false, response: newRes };
  }

  return { isError: false, response: res };
}

/**
 * Ground-truth char counts from the response stream, independent of usage.output_tokens.
 * redactedBlockCount blocks are opaque server bytes — no char count available for those.
 */
export interface OutputMeasurement {
  textChars: number;
  thinkingChars: number;
  toolUseChars: number;
  redactedBlockCount: number;
}

/** Parse one SSE block into the running usage + measurement accumulators. Silent on malformed input. */
function processSseEvent(
  block: string,
  m: OutputMeasurement,
  state: { usage: Usage | undefined; stopReason: string | undefined },
): void {
  // Parse `event:` + `data:` lines; continuation data: lines concatenate per SSE spec.
  let event = '';
  let data = '';
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).replace(/^\s/, '');
  }
  if (!data) return;
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return;
  }
  const obj = j as Record<string, unknown>;

  // OpenAI chunks have no `event:` line; usage only present when stream_options.include_usage is set.
  const openAIUsage = normalizeUsage((obj as { usage?: unknown }).usage);
  if (openAIUsage) state.usage = openAIUsage;
  // OpenAI Responses API streams usage nested under `response` on the terminal
  // `response.completed` (or `.incomplete`) event — not at the top level.
  if (event === 'response.completed' || event === 'response.incomplete') {
    const resp = obj.response as
      | { usage?: unknown; incomplete_details?: { reason?: unknown } }
      | undefined;
    const respUsage = normalizeUsage(resp?.usage);
    if (respUsage) state.usage = respUsage;
    // Responses API has no stop_reason; normalize the terminal status/reason instead.
    const reason = resp?.incomplete_details?.reason;
    state.stopReason = typeof reason === 'string' ? reason
      : event === 'response.incomplete' ? 'incomplete' : 'stop';
  }
  // Google AI Studio streams usage at top level. Antigravity wraps the same
  // payload under `response`; accept both without rewriting the provider response.
  const nestedGoogleResponse = objectRecord(obj.response);
  const googleUsageRaw = obj.usageMetadata ?? nestedGoogleResponse?.usageMetadata;
  if (googleUsageRaw && typeof googleUsageRaw === 'object') {
    const gUsage = normalizeUsage(googleUsageRaw);
    if (gUsage) state.usage = gUsage;
  }
  measureGoogleCandidates(obj, m, state);
  if (nestedGoogleResponse) measureGoogleCandidates(nestedGoogleResponse, m, state);

  measureOpenAIChoices(obj, m);
  // OpenAI chat chunks: the final chunk carries choices[].finish_reason (earlier chunks ship null).
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') state.stopReason = fr;
    }
  }

  if (event === 'message_start') {
    const msg = obj.message as { usage?: Usage } | undefined;
    const usage = normalizeUsage(msg?.usage);
    if (usage) state.usage = usage;
  } else if (event === 'content_block_start') {
    const cb = obj.content_block as { type?: string } | undefined;
    if (cb?.type === 'redacted_thinking') m.redactedBlockCount += 1;
  } else if (event === 'content_block_delta') {
    const d = obj.delta as
      | { type?: string; text?: string; thinking?: string; partial_json?: string }
      | undefined;
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      m.textChars += d.text.length;
    } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      m.thinkingChars += d.thinking.length;
    } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      m.toolUseChars += d.partial_json.length;
    }
  } else if (event === 'message_delta') {
    // Anthropic ships the final stop_reason here ("end_turn", "refusal", …).
    const d = obj.delta as { stop_reason?: unknown } | undefined;
    if (typeof d?.stop_reason === 'string') state.stopReason = d.stop_reason;
    // Authoritative final output_tokens; merge over message_start (which ships output_tokens: 1).
    const u = obj.usage as Partial<Usage> | undefined;
    if (u) {
      if (!state.usage) state.usage = {} as Usage;
      const cur = state.usage;
      if (typeof u.output_tokens === 'number') cur.output_tokens = u.output_tokens;
      if (typeof u.input_tokens === 'number' && cur.input_tokens === undefined) {
        cur.input_tokens = u.input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === 'number') {
        cur.cache_creation_input_tokens = u.cache_creation_input_tokens;
      }
      if (typeof u.cache_read_input_tokens === 'number') {
        cur.cache_read_input_tokens = u.cache_read_input_tokens;
      }
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObjects(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null);
    }
    const item = objectRecord(parsed);
    return item ? [item] : null;
  } catch {
    const match = /"usageMetadata"\s*:\s*(\{[^}]+\})/.exec(trimmed);
    if (match && match[1]) {
      try {
        const usageMetadata: unknown = JSON.parse(match[1]);
        return [{ usageMetadata }];
      } catch {}
    }
  }
  return null;
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: Usage = {};

  if (typeof u.input_tokens === 'number') out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.output_tokens = u.output_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation === 'object' && u.cache_creation !== null) {
    out.cache_creation = u.cache_creation as Usage['cache_creation'];
  }
  if (typeof u.server_tool_use === 'object' && u.server_tool_use !== null) {
    out.server_tool_use = u.server_tool_use as Usage['server_tool_use'];
  }

  // OpenAI field aliases.
  if (typeof u.prompt_tokens === 'number') out.input_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.output_tokens = u.completion_tokens;

  // Google AI Studio field aliases.
  if (typeof u.promptTokenCount === 'number') out.input_tokens = u.promptTokenCount;
  if (typeof u.candidatesTokenCount === 'number' || typeof u.thoughtsTokenCount === 'number') {
    out.output_tokens =
      (typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0) +
      (typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : 0);
  }
  if (typeof u.cachedContentTokenCount === 'number') out.cached_tokens = u.cachedContentTokenCount;
  // OpenAI prompt-cache hits live in a details sub-object: Responses uses
  // `input_tokens_details.cached_tokens`, Chat uses `prompt_tokens_details`.
  const details =
    (u.input_tokens_details as Record<string, unknown> | undefined) ??
    (u.prompt_tokens_details as Record<string, unknown> | undefined);
  if (details && typeof details.cached_tokens === 'number') {
    out.cached_tokens = details.cached_tokens;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function revertedGoogleInfo(
  info: TransformInfo,
  reason: string,
  baselineProbeStatus: 'ok' | 'failed',
): TransformInfo {
  return {
    ...info,
    compressed: false,
    reason,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    imagePixels: undefined,
    imageTokens: undefined,
    baselineImagedTokens: undefined,
    nativeInjectedTokens: undefined,
    firstImagePng: undefined,
    firstImageWidth: undefined,
    firstImageHeight: undefined,
    imagePngs: undefined,
    imageDims: undefined,
    imageSourceText: undefined,
    imageSourceTexts: undefined,
    toolResultImgs: undefined,
    collapsedTurns: undefined,
    collapsedChars: undefined,
    collapsedImages: undefined,
    historyTextChars: undefined,
    historyReason: undefined,
    bucketChars: undefined,
    gateEval: undefined,
    baselineProbeStatus,
  };
}

function measureOpenAIChoices(obj: Record<string, unknown>, m: OutputMeasurement): void {
  const choices = obj.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const c = choice as { delta?: unknown; message?: unknown };
    const payload = (c.delta ?? c.message) as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    if (typeof payload.content === 'string') m.textChars += payload.content.length;
    const toolCalls = payload.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc as { function?: unknown } | undefined)?.function;
        const args = (fn as { arguments?: unknown } | undefined)?.arguments;
        if (typeof args === 'string') m.toolUseChars += args.length;
      }
    }
  }
}

function measureGoogleCandidates(
  obj: Record<string, unknown>,
  m: OutputMeasurement,
  state?: { stopReason: string | undefined },
): boolean {
  if (!Array.isArray(obj.candidates)) return false;
  for (const rawCandidate of obj.candidates) {
    const candidate = objectRecord(rawCandidate);
    if (!candidate) continue;
    if (state && typeof candidate.finishReason === 'string') state.stopReason = candidate.finishReason;
    const content = objectRecord(candidate.content);
    if (!Array.isArray(content?.parts)) continue;
    for (const rawPart of content.parts) {
      const part = objectRecord(rawPart);
      if (!part) continue;
      if (typeof part.text === 'string') {
        if (part.thought === true) m.thinkingChars += part.text.length;
        else m.textChars += part.text.length;
      }
      if (part.functionCall !== undefined) {
        try {
          m.toolUseChars += JSON.stringify(part.functionCall).length;
        } catch {}
      }
    }
  }
  return true;
}

/** Measure non-streaming messages.content[] — same OutputMeasurement shape as the SSE accumulator. */
function measureFromMessageJson(j: unknown): OutputMeasurement {
  const m: OutputMeasurement = { textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0 };
  if (j && typeof j === 'object') measureOpenAIChoices(j as Record<string, unknown>, m);
  const content = (j as { content?: unknown })?.content;
  if (!Array.isArray(content)) return m;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; thinking?: unknown; input?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') {
      m.textChars += b.text.length;
    } else if (b?.type === 'thinking' && typeof b.thinking === 'string') {
      m.thinkingChars += b.thinking.length;
    } else if (b?.type === 'redacted_thinking') {
      m.redactedBlockCount += 1;
    } else if (b?.type === 'tool_use') {
      try {
        m.toolUseChars += JSON.stringify(b.input ?? {}).length;
      } catch {
        /* circular / unserialisable input — leave the counter as-is */
      }
    }
  }
  return m;
}

/** Stop reason from a non-streaming response JSON: Anthropic `stop_reason`,
 *  OpenAI chat `choices[].finish_reason`, Responses `incomplete_details.reason`. */
function readStopReasonFromJson(j: unknown): string | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const obj = j as {
    stop_reason?: unknown;
    choices?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
  };
  if (typeof obj.stop_reason === 'string') return obj.stop_reason;
  if (Array.isArray(obj.choices)) {
    for (const c of obj.choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') return fr;
    }
  }
  if (obj.status === 'incomplete') {
    const reason = obj.incomplete_details?.reason;
    return typeof reason === 'string' ? reason : 'incomplete';
  }
  return undefined;
}

export type StreamTerminationReason =
  | 'response_terminal'
  | 'client_aborted'
  | 'upstream_ended_without_usage';

/**
 * Tee the response body to extract usage + output measurement without blocking the client.
 * Streams are scanned to EOF (final output_tokens is in message_delta; redacted_thinking
 * blocks can appear anywhere). 4xx bodies are capped at ERROR_BODY_MAX. 5xx is skipped.
 */
function teeForUsage(res: Response): {
  response: Response;
  usagePromise: Promise<Usage | undefined>;
  errorBodyPromise: Promise<string | undefined>;
  measurementPromise: Promise<OutputMeasurement | undefined>;
  stopReasonPromise: Promise<string | undefined>;
  streamTerminationPromise: Promise<StreamTerminationReason | undefined>;
} {
  // No body at all: nothing to extract on either path.
  if (!res.body) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
      streamTerminationPromise: Promise.resolve(undefined),
    };
  }
  // 4xx: tee for the error body but skip usage scanning entirely.
  if (res.status >= 400 && res.status < 500) {
    const [forClient, forUs] = res.body.tee();
    const errorBodyPromise = (async (): Promise<string | undefined> => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      let out = '';
      try {
        while (out.length < ERROR_BODY_MAX) {
          const { done, value } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        // Drain the rest so the tee buffer doesn't hold the stream open.
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* client may have aborted */
      }
      return out.length > ERROR_BODY_MAX ? out.slice(0, ERROR_BODY_MAX) : out;
    })();
    return {
      response: new Response(forClient, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise,
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
      streamTerminationPromise: Promise.resolve(undefined),
    };
  }
  // 5xx: skip both (the host already synthesizes an error message).
  if (res.status >= 500) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
      streamTerminationPromise: Promise.resolve(undefined),
    };
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const [forClient, forUs] = res.body.tee();

  // Single read loop resolves all four; exposed as separate promises for call-site readability.
  const scanResult = (async (): Promise<{
    usage: Usage | undefined;
    measurement: OutputMeasurement | undefined;
    stopReason: string | undefined;
    streamTermination: StreamTerminationReason;
  }> => {
    const reader = forUs.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let clientAborted = false;

    try {
      // A declared content-type is authoritative when it says something we
      // recognise. When it says nothing, the BYTES decide.
      //
      // Not hypothetical: the ChatGPT backend the Codex CLI talks to streams its
      // Responses SSE with no `content-type` response header at all. Gating the
      // scanner on the header alone therefore dropped that provider's own
      // terminal `response.completed` usage block on the floor — along with
      // stop_reason and the output measurement — and every Codex event was
      // written with no token accounting whatsoever. Sniffing recovers the
      // provider's authoritative numbers; nothing here estimates anything.
      let mode: 'sse' | 'json' | 'unknown' = ct.includes('text/event-stream')
        ? 'sse'
        : ct.includes('application/json') ? 'json' : 'unknown';
      if (mode === 'unknown') {
        const first = await reader.read();
        if (!first.done) buf += decoder.decode(first.value, { stream: true });
        const head = buf.slice(0, 512);
        if (/(?:^|\r?\n)(?:event|data):/.test(head)) mode = 'sse';
        else if (/^\s*[[{]/.test(head)) mode = 'json';
      }

      if (mode === 'sse') {
        // Walk every SSE event to EOF — message_delta (final output_tokens) is last.
        const m: OutputMeasurement = {
          textChars: 0,
          thinkingChars: 0,
          toolUseChars: 0,
          redactedBlockCount: 0,
        };
        const state: { usage: Usage | undefined; stopReason: string | undefined } = {
          usage: undefined,
          stopReason: undefined,
        };
        // SSE events are terminated by a blank line; support LF and CRLF. Run
        // before the first read too: sniffing may already have buffered events.
        const drainBuffered = (): void => {
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buf)) !== null) {
            const block = buf.slice(0, boundary.index);
            buf = buf.slice(boundary.index + boundary[0].length);
            processSseEvent(block, m, state);
          }
        };
        drainBuffered();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            drainBuffered();
          }
        } catch {
          clientAborted = true;
        }
        buf += decoder.decode();
        if (buf.trim().length > 0) processSseEvent(buf, m, state); // trailing partial event
        const streamTermination: StreamTerminationReason = clientAborted
          ? 'client_aborted'
          : (state.usage !== undefined || state.stopReason !== undefined)
            ? 'response_terminal'
            : 'upstream_ended_without_usage';
        return { usage: state.usage, measurement: m, stopReason: state.stopReason, streamTermination };
      }

      if (mode === 'json') {
        // Buffer fully, capped at 4 MiB.
        const MAX = 4 * 1024 * 1024;
        try {
          while (buf.length < MAX) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
          }
        } catch {
          clientAborted = true;
        }
        try {
          const objects = parseJsonObjects(buf);
          if (!objects) {
            return {
              usage: undefined,
              measurement: undefined,
              stopReason: undefined,
              streamTermination: clientAborted ? 'client_aborted' : 'upstream_ended_without_usage',
            };
          }
          let usage: Usage | undefined;
          let recognizedGoogle = false;
          const measurement: OutputMeasurement = {
            textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0,
          };
          const state: { stopReason: string | undefined } = { stopReason: undefined };
          for (const object of objects) {
            const nestedGoogleResponse = objectRecord(object.response);
            const nextUsage = normalizeUsage(
              object.usage ?? object.usageMetadata ?? nestedGoogleResponse?.usageMetadata,
            );
            if (nextUsage) usage = nextUsage;
            recognizedGoogle = measureGoogleCandidates(object, measurement, state) || recognizedGoogle;
            if (nestedGoogleResponse) {
              recognizedGoogle = measureGoogleCandidates(nestedGoogleResponse, measurement, state) || recognizedGoogle;
            }
          }
          const last = objects[objects.length - 1];
          const finalStopReason = state.stopReason ?? readStopReasonFromJson(last);
          const streamTermination: StreamTerminationReason = clientAborted
            ? 'client_aborted'
            : (usage !== undefined || finalStopReason !== undefined)
              ? 'response_terminal'
              : 'upstream_ended_without_usage';
          return {
            usage,
            measurement: recognizedGoogle ? measurement : measureFromMessageJson(last),
            stopReason: finalStopReason,
            streamTermination,
          };
        } catch {
          return {
            usage: undefined,
            measurement: undefined,
            stopReason: undefined,
            streamTermination: clientAborted ? 'client_aborted' : 'upstream_ended_without_usage',
          };
        }
      }
    } catch {
      clientAborted = true;
    }
    // Unknown content-type: drain to release the tee buffer.
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      clientAborted = true;
    }
    return {
      usage: undefined,
      measurement: undefined,
      stopReason: undefined,
      streamTermination: clientAborted ? 'client_aborted' : 'upstream_ended_without_usage',
    };
  })();

  return {
    response: new Response(forClient, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    usagePromise: scanResult.then((s) => s.usage),
    errorBodyPromise: Promise.resolve(undefined),
    measurementPromise: scanResult.then((s) => s.measurement),
    stopReasonPromise: scanResult.then((s) => s.stopReason),
    streamTerminationPromise: scanResult.then((s) => s.streamTermination),
  };
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com';

/** Bound decompression before parsing. This is above the largest request seen
 * in local provider telemetry, while preventing a malformed loopback request
 * from expanding without limit inside the persistent daemon. */
const MAX_DECODED_REQUEST_BYTES = 64 * 1024 * 1024;

function decodeZstdRequest(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new ZstdDecompress((chunk) => {
    total += chunk.byteLength;
    if (total > MAX_DECODED_REQUEST_BYTES) {
      throw new Error('zstd request exceeds decoded size limit');
    }
    chunks.push(chunk);
  });
  decoder.push(body, true);

  if (chunks.length === 1) return chunks[0]!;
  const decoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoded;
}

/** Headers we strip on the way out — they're hop-by-hop or proxy-injected. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length', // we recompute
  'expect',
  'accept-encoding', // let upstream choose
  'x-pxpipe-bypass', // pxpipe-only opt-out signal; never forwarded upstream
]);

const STRIP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // we don't re-encode
  'content-length',   // body may differ after streaming
]);

function filterHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

const PASSTHROUGH_PREFIXES = [
  '/anthropic/',
  '/openai/',
  '/google-ai-studio/',
  '/compat/',
] as const;

function isProviderPrefixedPath(pathname: string): boolean {
  return PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** One optional gateway/provider segment, then an optional `/v1`, before the
 *  wire-shape suffix:
 *
 *    /v1/chat/completions
 *    /openai/v1/chat/completions
 *    /compat/chat/completions    AI Gateway's OpenAI-compatible route
 *    /grok/chat/completions
 *
 *  Wire shape only: whether the body is OpenAI-shaped enough to parse a model
 *  out of. Routing stays with isProviderPrefixedPath/isCanonicalOpenAIPath
 *  above, so a prefixed path still goes to passthroughUpstream. */
const PROVIDER_SEGMENT = String.raw`(?:\/[a-z0-9][a-z0-9._-]*)?(?:\/v1)?`;
const OPENAI_CHAT_PATH = new RegExp(`^${PROVIDER_SEGMENT}\\/chat\\/completions$`);
const OPENAI_RESPONSES_PATH = new RegExp(`^${PROVIDER_SEGMENT}\\/responses$`);

function isOpenAIChatPath(pathname: string): boolean {
  return OPENAI_CHAT_PATH.test(pathname);
}

function isOpenAIResponsesPath(pathname: string): boolean {
  return OPENAI_RESPONSES_PATH.test(pathname);
}

function resolveAuthToken(config: ProxyConfig): string | undefined {
  return typeof config.authToken === 'function' ? config.authToken() : config.authToken;
}

/** Inbound credential classification by shape only. No credential store is read
 * and no secret content is inspected beyond prefixes/segment structure. */
export type InboundCredential =
  | 'none'
  | 'anthropic-key'
  | 'anthropic-bearer'
  | 'oauth-jwt'
  | 'api-key-bearer'
  | 'opaque-bearer';

const ANTHROPIC_BEARER_RE = /^Bearer\s+sk-ant-/i;
const API_KEY_BEARER_RE = /^Bearer\s+sk-/i;
const JWT_BEARER_RE = /^Bearer\s+eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function classifyInboundCredential(headers: Headers): InboundCredential {
  const authorization = headers.get('authorization') ?? '';
  if (ANTHROPIC_BEARER_RE.test(authorization)) return 'anthropic-bearer';
  if (JWT_BEARER_RE.test(authorization)) return 'oauth-jwt';
  if (API_KEY_BEARER_RE.test(authorization)) return 'api-key-bearer';
  if (authorization.trim() !== '') return 'opaque-bearer';
  if ((headers.get('x-api-key') ?? '').trim() !== '') return 'anthropic-key';
  return 'none';
}

export type OutboundAuth =
  | { action: 'keep-inbound'; reason: string }
  | { action: 'replace'; reason: string }
  | { action: 'drop'; reason: string };

/** Credential policy for direct OpenAI-family routes.
 *  1) Anthropic credentials never cross providers.
 *  2) Caller subscription OAuth is never silently replaced by a host API key.
 *  3) Otherwise a configured host key is authoritative; absent one, keep the
 *     caller credential when present. */
export function resolveOpenAIRouteAuth(
  inbound: InboundCredential,
  hasConfiguredKey: boolean,
): OutboundAuth {
  if (inbound === 'anthropic-bearer' || inbound === 'anthropic-key') {
    return hasConfiguredKey
      ? { action: 'replace', reason: 'anthropic-credential-never-crosses-providers' }
      : { action: 'drop', reason: 'anthropic-credential-never-crosses-providers' };
  }
  if (inbound === 'oauth-jwt') {
    return { action: 'keep-inbound', reason: 'subscription-oauth-belongs-to-the-caller' };
  }
  if (hasConfiguredKey) return { action: 'replace', reason: 'host-configured-key' };
  return inbound === 'none'
    ? { action: 'drop', reason: 'no-credential-available' }
    : { action: 'keep-inbound', reason: 'caller-credential-forwarded' };
}

function isCanonicalOpenAIPath(pathname: string, headers: Headers, hasOpenAIKey: boolean): boolean {
  const isModelsPath = pathname === '/v1/models' || pathname.startsWith('/v1/models/');
  // `/v1/models` exists on BOTH APIs, so it is routed by auth style — but an
  // `sk-ant-…` bearer is Anthropic by construction (Claude Code subscription
  // auth sends `authorization: Bearer sk-ant-oat01-…` with no x-api-key).
  // Without this check that OAuth token would be forwarded to the OpenAI
  // upstream: a credential leak, and a guaranteed 401.
  const bearerIsAnthropic = /^Bearer\s+sk-ant-/i.test(headers.get('authorization') ?? '');
  const looksOpenAIAuth =
    hasOpenAIKey || (headers.has('authorization') && !headers.has('x-api-key') && !bearerIsAnthropic);
  return pathname === '/v1/chat/completions'
    || pathname === '/v1/responses'
    || pathname.startsWith('/v1/responses/')
    || (isModelsPath && looksOpenAIAuth);
}

/** POST /v1/messages/count_tokens with the given body. Returns the upstream's
 *  `input_tokens` number or null on any failure. count_tokens is documented
 *  as a free endpoint (no input-token billing) — we use it once per request
 *  on the PRE-COMPRESSION body to get the ground-truth baseline. Actual
 *  post-compression tokens already come back free in the /v1/messages usage
 *  block (input_tokens + cache_create + cache_read), so no second probe. */
async function countTokensUpstream(
  countTokensUrl: string,
  body: Uint8Array,
  headers: Headers,
): Promise<number | null> {
  try {
    const res = await fetch(countTokensUrl, {
      method: 'POST',
      headers,
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { input_tokens?: unknown };
    return typeof json.input_tokens === 'number' ? json.input_tokens : null;
  } catch {
    return null;
  }
}

async function countGoogleTokensUpstream(
  countTokensUrl: string,
  body: Uint8Array,
  headers: Headers,
  model: string,
): Promise<number | null> {
  try {
    const request = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const countBody = JSON.stringify({
      generateContentRequest: { ...request, model: `models/${model}` },
    });
    const res = await fetch(countTokensUrl, {
      method: 'POST',
      headers,
      body: countBody,
      signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as { totalTokens?: unknown };
    return typeof json.totalTokens === 'number' ? json.totalTokens : null;
  } catch {
    return null;
  }
}

/** Resolve upstream URLs from config. Pure — unit-testable. */
export function resolveUpstreams(config: ProxyConfig): {
  anthropic: string;
  openai: string;
  stripOpenAIV1: boolean;
} {
  if (config.provider === 'cloudflare-ai-gateway') {
    const base = (config.gatewayBaseUrl ?? '').replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        "provider 'cloudflare-ai-gateway' requires gatewayBaseUrl (PXPIPE_GATEWAY_BASE_URL)",
      );
    }
    return { anthropic: `${base}/anthropic`, openai: `${base}/openai`, stripOpenAIV1: true };
  }
  if (config.provider === 'featherless') {
    const raw = config.openAIUpstream ?? config.upstream ?? 'https://api.featherless.ai';
    const base = normalizeUpstreamRoot(raw);
    return { anthropic: base, openai: base, stripOpenAIV1: false };
  }
  return {
    anthropic: (config.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, ''),
    openai: (config.openAIUpstream ?? DEFAULT_OPENAI_UPSTREAM).replace(/\/+$/, ''),
    stripOpenAIV1: false,
  };
}

/** Parse PXPIPE_GATEWAY_HEADERS — JSON object or `k=v;k2=v2`. */
export function parseGatewayHeaders(spec: string | undefined): Record<string, string> {
  if (!spec) return {};
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Build the proxy fetch handler. */
export function createProxy(config: ProxyConfig = {}) {
  const modelRoutes = new Map<string, 'openai' | 'cloudflare'>();
  const inFlight = new Map<string, { lease: symbol; startedAt: number }>();
  // Entries are released by their holder on every exit path, but the key space is
  // unbounded (one per distinct body) and the map outlives every request, so a single
  // missed release would leak for the daemon's lifetime. An entry past the hold window
  // is already ignored by the duplicate check below, so expiring it costs nothing and
  // bounds the map by real in-window concurrency instead of by release correctness.
  let lastSweptAt = 0;
  const headersTimeoutMs = config.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
  const idleTimeoutMs = config.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const duplicateHoldMs = config.duplicateHoldMs ?? DEFAULT_DUPLICATE_HOLD_MS;
  const maxRequestBytes = resolveMaxRequestBytes(config.maxRequestBytes);
  // Explicit precedence: Cloudflare > OpenAI > normal family routing.
  for (const model of config.openAIModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'openai');
  }
  for (const model of config.cloudflareModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'cloudflare');
  }
  if ((config.cloudflareModels?.length ?? 0) > 0 && config.cloudflareUpstream === undefined) {
    throw new Error('cloudflareModels requires a Cloudflare chat upstream');
  }
  const routes = resolveUpstreams(config);
  const upstream = routes.anthropic;
  const openAIUpstream = routes.openai;
  const passthroughUpstream = config.provider === 'cloudflare-ai-gateway'
    ? (config.gatewayBaseUrl ?? '').replace(/\/+$/, '')
    : upstream;
  const gatewayHeaders = config.gatewayHeaders ?? {};
  const applyGatewayHeaders = (h: Headers): Headers => {
    for (const [k, v] of Object.entries(gatewayHeaders)) h.set(k, v);
    return h;
  };

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    // Reversibly disguise the configured upstream id for Claude Code's model
    // picker, matching CLIProxyAPI. The id decodes back to the exact provider
    // model on /v1/messages, so discovery and routing cannot drift apart.
    if (req.method === 'GET' && url.pathname === '/v1/models' && modelRoutes.size > 0) {
      const models = [...modelRoutes].map(([model, route]) => ({
            id: claudeGatewayModelId(model),
            type: 'model',
            display_name: routedModelDisplayName(model, route),
            created_at: '1970-01-01T00:00:00Z',
          }));
      return new Response(JSON.stringify({
        data: models,
        has_more: false,
        first_id: models[0]?.id ?? '',
        last_id: models.at(-1)?.id ?? '',
      }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // reqBodyBytes: kept for lazy gzip on 4xx. reqBodySha8: computed eagerly for correlation.
    let reqBodyBytes: Uint8Array | undefined;
    let reqBodySha8: string | undefined;
    let reqBodySha256: string | undefined;
    let transformMs: number | undefined;

    const fire = (
      status: number,
      info?: TransformInfo,
      error?: string,
      firstByteMs?: number,
      usage?: Usage,
      errorBody?: string,
      measurement?: OutputMeasurement,
      stopReason?: string,
      streamTermination?: StreamTerminationReason,
    ): void => {
      const is4xx = status >= 400 && status < 500;
      // Gzip body lazily (only on 4xx). Async IIFE keeps fire() synchronous.
      const finalize = async (): Promise<void> => {
        let reqBodyGz: Uint8Array | undefined;
        if (config.captureErrorReqBody && is4xx && reqBodyBytes && reqBodyBytes.byteLength > 0) {
          try {
            reqBodyGz = await gzipBytes(reqBodyBytes);
          } catch {
            // Non-fatal — drop body sample.
          }
        }
        // Await both count_tokens probes so baseline numbers land on the same event row.
        // Each probe is independent; null leaves the field absent and dashboard math degrades cleanly.
        if (info && baselineStatusApplies) {
          // Track both halves so the dashboard can gate on probe completeness (partial vs ok).
          // A missing cacheable-prefix probe must NOT be treated as cacheable=0 — that fabricates savings.
          let baselineResolved: number | null = null;
          let cacheableExpected = false;
          let cacheableResolved: number | null = null;
          if (baselinePromise) {
            try {
              baselineResolved = await baselinePromise;
              if (baselineResolved !== null) info.baselineTokens = baselineResolved;
            } catch {
              /* probe threw — drop */
            }
          }
          if (baselineCacheablePromise) {
            cacheableExpected = true;
            try {
              cacheableResolved = await baselineCacheablePromise;
              if (cacheableResolved !== null) info.baselineCacheableTokens = cacheableResolved;
            } catch {
              /* probe threw */
            }
          }
          if (baselineResolved === null) {
            info.baselineProbeStatus = 'failed';
          } else if (cacheableExpected && cacheableResolved === null) {
            info.baselineProbeStatus = 'partial'; // dashboard excludes row; must not treat as cacheable=0
          } else {
            info.baselineProbeStatus = 'ok';
          }
        }
        // The Messages compatibility response exposes Anthropic's disjoint
        // usage buckets to the client. Dashboard accounting still needs the
        // original Responses semantics: input includes the cached subset.
        const eventUsage = bridgedGptMessages && usage
          ? {
              ...usage,
              input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
              cached_tokens: usage.cache_read_input_tokens ?? 0,
            }
          : usage;
        await config.onRequest?.({
          method: req.method,
          path: url.pathname,
          model: requestModel,
          // Provider-prefixed OpenCode routes such as `/openai/responses` are
          // Responses-shaped even though they are not canonical `/v1/*` paths.
          // Classify by the parsed wire route, otherwise the dashboard ignores
          // GPT image/baseline telemetry and renders As text / Saved as dashes.
          accountingProvider: isGoogleRoute
            ? 'google'
            : isOpenAIChat || isOpenAIResponses || bridgedGptMessages || bridgedChatMessages
              ? 'openai'
              : 'anthropic',
          status,
          durationMs: Date.now() - t0,
          firstByteMs,
          transformMs,
          info,
          usage: eventUsage,
          error,
          errorBody,
          reqBodySha8,
          reqBodyGz,
          measurement,
          stopReason,
          streamTermination,
          provider: config.provider ?? (isGoogleRoute ? 'google' : isOpenAIChat || isOpenAIResponses ? 'openai' : 'anthropic'),
          transformation_mode: featherlessProvider ? featherlessMode : undefined,
          transformation_state: featherlessProvider ? transformationState : undefined,
          capability_decision: featherlessProvider ? capabilityDecision : undefined,
          capability_source: featherlessProvider ? capabilitySource : undefined,
          capability_cache_status: featherlessProvider ? capabilityCacheStatus : undefined,
          skip_reason: featherlessProvider ? skipReason : undefined,
          fallback_attempted: featherlessProvider ? fallbackAttempted : undefined,
          fallback_reason: featherlessProvider ? fallbackReason : undefined,
          fallback_result: featherlessProvider ? fallbackResult : undefined,
          upstream_attempt_count: featherlessProvider ? upstreamAttemptCount : undefined,
          trajectory,
        });
      };
      void finalize();
    };

    // Transform only known shapes; everything else passes through.
    // Explicit per-request opt-out (#111): a subprocess that merely inherited
    // ANTHROPIC_BASE_URL (e.g. a plugin's internal `claude` probe) can send
    // `x-pxpipe-bypass: 1` — via Claude Code's ANTHROPIC_CUSTOM_HEADERS — to
    // have its traffic forwarded byte-for-byte untouched. Routing and auth
    // still apply; the header itself is stripped before forwarding.
    const bypassHeader = req.headers.get('x-pxpipe-bypass');
    const bypass = bypassHeader !== null && !/^(?:0|false|off|no)$/i.test(bypassHeader.trim());
    const providerPrefixed = isProviderPrefixedPath(url.pathname);
    const isMessages = !bypass && req.method === 'POST' && isAnthropicMessagesPath(url.pathname);
    const isOpenAIChat = !bypass && req.method === 'POST' && isOpenAIChatPath(url.pathname);
    const isOpenAIResponses = !bypass && req.method === 'POST' && isOpenAIResponsesPath(url.pathname);
    const googleModel = req.method === 'POST'
      ? parseGoogleModelFromPath(url.pathname)
      : null;
    const isAntigravityRoute = req.method === 'POST'
      && config.googleEnvelope === 'antigravity'
      && isAntigravityInferencePath(url.pathname);
    const isGoogleRoute = googleModel !== null || isAntigravityRoute;
    const isGoogle = isGoogleRoute && !bypass;
    const isOpenAIPath = isCanonicalOpenAIPath(
      url.pathname,
      req.headers,
      config.openAIApiKey !== undefined,
    );
    const upstreamBase = isGoogleRoute || providerPrefixed
      ? passthroughUpstream
      : isOpenAIPath ? openAIUpstream : upstream;

    let bodyOut: BodyInit | null = null;
    let info: TransformInfo | undefined;
    let requestModel: string | undefined = googleModel ?? undefined;
    let bridgedGptMessages = false;
    let bridgedChatMessages = false;
    let modelRouteForRequest: 'openai' | 'cloudflare' | undefined;

    let featherlessProvider = config.provider === 'featherless';
    let featherlessMode: FeatherlessTransformMode = config.featherlessTransformMode ?? 'auto';
    let capabilityDecision: FeatherlessCapabilityDecision | undefined;
    let capabilitySource: 'api' | 'cache' | 'override' | undefined;
    let capabilityCacheStatus: 'hit' | 'miss' | 'bypass' | undefined;
    let transformationState: FeatherlessTransformationState | undefined;
    let skipReason: string | undefined;
    let fallbackAttempted = false;
    let fallbackReason: string | undefined;
    let fallbackResult: 'success' | 'failed' | 'not_attempted' | undefined = 'not_attempted';
    let upstreamAttemptCount = 1;
    let originalBodyBytes: Uint8Array | undefined;
    let decodedRequestContentEncoding = false;

    // Two count_tokens probes on the pre-compression body (see docs/HISTORY_CACHE_MODEL.md):
    //   baselinePromise          → full-body input_tokens
    //   baselineCacheablePromise → input_tokens truncated at last cache_control marker
    // Dashboard combines them for cache-aware baseline. Both run in parallel with the main forward.
    let baselinePromise: Promise<number | null> | undefined;
    let baselineCacheablePromise: Promise<number | null> | undefined;
    let baselineStatusApplies = false;
    let trajectory: TrajectoryObservation | undefined;

    if (isMessages || isOpenAIChat || isOpenAIResponses || isGoogle) {
      const bounded = await readBodyBounded(req, maxRequestBytes);
      if (!bounded.ok) {
        const message =
          `request body exceeds the ${maxRequestBytes}-byte pxpipe limit (` +
          `${bounded.declaredBytes !== undefined ? `declared ${bounded.declaredBytes}, ` : ''}` +
          `read ${bounded.observedBytes})`;
        const error = isMessages
          ? { type: 'error', error: { type: 'request_too_large', message } }
          : { error: { type: 'request_too_large', message } };
        return new Response(JSON.stringify(error), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        });
      }
      const wireBody: Uint8Array = bounded.bytes;
      let bodyIn: Uint8Array = wireBody;
      if (
        config.decodeZstdRequests
        && req.headers.get('content-encoding')?.trim().toLowerCase() === 'zstd'
      ) {
        try {
          bodyIn = decodeZstdRequest(wireBody);
          decodedRequestContentEncoding = true;
        } catch {
          // Fail open on an unknown/malformed encoding: preserve the original
          // wire bytes and let normal missing-model admission abstain honestly.
        }
      }
      originalBodyBytes = bodyIn;
      try {
        const transformOpts =
          typeof config.transform === 'function' ? config.transform() : config.transform;
        // Fail-closed: unreadable model → no compression, not a risky guess.
        // Antigravity owns model metadata in the outer envelope; its nested
        // GenerateContent request intentionally has no public-API model field.
        const antigravityMeta = isAntigravityRoute ? inspectAntigravityEnvelope(bodyIn) : null;
        const model = googleModel ?? antigravityMeta?.model ?? readModelField(bodyIn);
        requestModel = model ?? undefined;
        if (isMessages) {
          trajectory = await observeAnthropicTrajectory(bodyIn, requestModel);
        } else if (isGoogle) {
          trajectory = await observeGoogleTrajectory(
            bodyIn,
            requestModel,
            isAntigravityRoute,
          );
        }
        // A turn whose only content is `@pxpipe pin` / `@pxpipe unpin` is
        // configuration, not a question. Answer it here: forwarding it would bill
        // a full prefix to have the model paraphrase a list the proxy already
        // holds, and the reply would be a guess about state it cannot see.
        if (isMessages || isOpenAIChat || isOpenAIResponses) {
          const pinReply = isMessages
            ? pinCommandResponse(bodyIn)
            : pinCommandResponseOpenAI(bodyIn, isOpenAIResponses ? 'responses' : 'chat');
          if (pinReply) {
            return new Response(pinReply.body, {
              status: 200,
              headers: {
                'content-type': pinReply.contentType,
                'cache-control': 'no-cache',
              },
            });
          }
        }
        // /v1/messages is only a wire schema: Claude Code can target a non-
        // Anthropic model (for example GPT-5.6 Sol). Do not apply Claude's
        // renderer or Anthropic count_tokens merely because the route is
        // Messages-shaped. Enabled GPT models take the standalone
        // Messages→Responses bridge; unsupported models still fail closed.
        // Claude Code model aliases decode back to exact Cloudflare model IDs.
        const decodedByAlias = [...modelRoutes.keys()]
          .find((candidate) => claudeGatewayModelId(candidate) === model);
        const decodedChatModel = decodedByAlias ?? resolveClaudeGatewayModelId(model);
        const routedModel = decodedChatModel ?? model;
        const modelRoute = routedModel ? modelRoutes.get(routedModel) : undefined;
        modelRouteForRequest = modelRoute;
        const forceChat = isMessages && modelRoute === 'cloudflare';
        const messagesAnthropic = isMessages
          && modelRoute === undefined && !forceChat && isClaudeModel(model);
        // Provider routing is explicit. Unlisted Messages models use the
        // default Anthropic route, regardless of how their id is shaped.
        bridgedGptMessages =
          isMessages && !messagesAnthropic && !forceChat
          && modelRoute === 'openai';
        // Messages → Chat Completions bridge toward Cloudflare Workers AI.
        bridgedChatMessages = forceChat;
        const chatStamp = bridgedChatMessages ? routedModel : undefined;
        const effectiveModel = (bridgedGptMessages || bridgedChatMessages) ? routedModel : model;

        let featherlessShouldCompress = true;
        if (featherlessProvider) {
          const targetM = effectiveModel ?? model ?? 'moonshotai/Kimi-K3';
          if (featherlessMode === 'off') {
            featherlessShouldCompress = false;
            skipReason = 'off_mode';
            transformationState = 'passthrough';
            capabilityDecision = 'disabled';
          } else if (featherlessMode === 'auto') {
            if (isCircuitBreakerOpen('featherless', upstreamBase, targetM)) {
              featherlessShouldCompress = false;
              skipReason = 'circuit_breaker_open';
              transformationState = 'skipped';
              capabilityDecision = 'disabled';
            } else {
              const authHeader = req.headers.get('authorization') ?? undefined;
              const fetchFn = config.customFetch ?? fetch;
              const cap = await discoverFeatherlessCapability(upstreamBase, targetM, authHeader, fetchFn);
              capabilityDecision = cap.decision;
              capabilitySource = cap.source;
              capabilityCacheStatus = cap.cacheStatus;
              if (!cap.visionSupported) {
                featherlessShouldCompress = false;
                skipReason = cap.decision === 'discovery_failed' ? 'discovery_failed' : 'no_vision_capability';
                transformationState = cap.decision === 'discovery_failed' ? 'degraded' : 'skipped';
              } else {
                capabilityDecision = 'capable';
              }
            }
          } else if (featherlessMode === 'force') {
            capabilityDecision = 'capable';
            capabilitySource = 'override';
            capabilityCacheStatus = 'bypass';
          }
        }

        const explicitModelsSet = typeof process.env.PXPIPE_MODELS === 'string' && process.env.PXPIPE_MODELS.trim().length > 0;
        const isFeatherlessEligible = featherlessProvider
          ? (explicitModelsSet ? isPxpipeSupportedGptModel(model) : true) && featherlessShouldCompress
          : false;

        const modelOk = isGoogle
          ? resolveGoogleTransportProfile(model) !== null && isPxpipeSupportedModel(model)
          : isMessages
            ? (messagesAnthropic && isPxpipeSupportedModel(model))
              || bridgedGptMessages
              || (bridgedChatMessages && isPxpipeSupportedGptModel(effectiveModel))
            : featherlessProvider
              ? isFeatherlessEligible
              : isPxpipeSupportedGptModel(model);
        // Compression eligibility and telemetry follow the model that actually
        // receives the request, not Claude Code's local gateway alias.
        if ((bridgedGptMessages || bridgedChatMessages) && effectiveModel) {
          requestModel = effectiveModel;
        }
        const profileOpts: TransformOptions = (modelOk
          ? (featherlessProvider ? { ...transformOpts, imagePlacement: 'merge_first_user' as const, imageDetail: 'auto' as const } : transformOpts)
          : { ...transformOpts, compress: false }) ?? { compress: false };
        const effectiveOpts = applyTrajectoryCircuitBreaker(profileOpts, trajectory);
        const bridgeBody = bridgedGptMessages
          ? (() => {
              const bridged = JSON.parse(new TextDecoder().decode(
                anthropicMessagesToOpenAIResponses(bodyIn),
              )) as Record<string, unknown>;
              bridged.model = effectiveModel;
              return new TextEncoder().encode(JSON.stringify(bridged));
            })()
          : bridgedChatMessages
            ? anthropicMessagesToOpenAIChat(bodyIn, chatStamp ?? undefined)
            : bodyIn;
        const transformStartedAt = Date.now();
        let r = isAntigravityRoute && isGoogle
          ? await transformAntigravityGenerateContent(bodyIn, effectiveOpts)
          : isGoogle
            ? await transformGoogleGenerateContent(bodyIn, model!, effectiveOpts)
          : isMessages
            ? bridgedGptMessages
              ? await transformOpenAIResponses(bridgeBody, effectiveOpts)
              : bridgedChatMessages
                ? await transformOpenAIChatCompletions(bridgeBody, effectiveOpts)
                : await transformRequest(bodyIn, { ...effectiveOpts, model: effectiveModel ?? undefined })
            : isOpenAIChat
              ? await transformOpenAIChatCompletions(bodyIn, effectiveOpts)
              : await transformOpenAIResponses(bodyIn, effectiveOpts);
        transformMs = Date.now() - transformStartedAt;
        if (isGoogle && !isAntigravityRoute && r.info.compressed) {
          const countHeaders = applyGatewayHeaders(filterHeaders(req.headers, STRIP_REQ_HEADERS));
          countHeaders.set('content-type', 'application/json');
          const countUrl = new URL(
            passthroughUpstream + url.pathname.replace(
              /:(?:generateContent|streamGenerateContent)$/,
              ':countTokens',
            ),
          );
          for (const [key, value] of url.searchParams) countUrl.searchParams.append(key, value);
          countUrl.searchParams.delete('alt');
          const [baseline, transformed] = await Promise.all([
            countGoogleTokensUpstream(countUrl.toString(), bodyIn, countHeaders, model!),
            countGoogleTokensUpstream(countUrl.toString(), r.body, countHeaders, model!),
          ]);
          if (baseline === null || transformed === null) {
            // The local text estimate is only a coarse fallback across prose,
            // code, JSON, and Unicode. Fail closed when provider validation is
            // unavailable rather than risk making the request more expensive.
            r = {
              body: bodyIn,
              info: revertedGoogleInfo(r.info, 'count_tokens_failed', 'failed'),
            };
          } else if (transformed >= baseline) {
            r = {
              body: bodyIn,
              info: revertedGoogleInfo(
                r.info,
                `not_profitable (${transformed} >= ${baseline} tokens)`,
                'ok',
              ),
            };
          } else {
            r.info.baselineTokens = baseline;
            r.info.baselineProbeStatus = 'ok';
          }
        }
        // Arm the repeated-retrieval breaker only after the FINAL body decision.
        // Public Google can still revert an initially rendered candidate after its
        // provider countTokens validation; marking compression before that revert
        // falsely blamed later repeated reads on a modality change the model never saw.
        if (trajectory) {
          r.info.firstUserSha8 ??= trajectory.sessionSha8;
          noteTrajectoryCompression(
            trajectory.sessionSha8,
            Boolean(r.info.compressed && (r.info.imageCount ?? 0) > 0),
          );
        }
        if (!modelOk) r.info.reason = skipReason ?? 'unsupported_model';
        if (r.info.compressed) {
          if (featherlessProvider) transformationState = 'transformed';
        } else if (!transformationState) {
          if (featherlessProvider) {
            transformationState = 'passthrough';
            if (r.info.reason && !skipReason) skipReason = r.info.reason;
          }
        }
        bodyOut = r.body as unknown as BodyInit; // TS narrows Uint8Array away from BodyInit
        info = r.info;
        reqBodyBytes = r.body;
        r.info.serializedRequestBytes = r.body.byteLength;
        if (r.body.byteLength > 0) {
          reqBodySha256 = await sha256Bytes(r.body);
          reqBodySha8 = reqBodySha256.slice(0, 8);
        }
        const requestByteLimit = requestModel
          ? resolveGptProfile(requestModel).maxSerializedRequestBytes
          : undefined;
        if (r.info.compressed && requestByteLimit !== undefined) {
          if (r.body.byteLength > requestByteLimit) {
            r.info.sizeLimitOutcome = 'rejected';
            const message = `pxpipe serialized request exceeds model limit (${r.body.byteLength} > ${requestByteLimit} bytes)`;
            fire(413, r.info, message);
            const error = isMessages
              ? { type: 'error', error: { type: 'request_too_large', message } }
              : { error: { type: 'request_too_large', message } };
            return new Response(JSON.stringify(error), {
              status: 413,
              headers: { 'content-type': 'application/json' },
            });
          } else {
            r.info.sizeLimitOutcome = 'within_limit';
          }
        }

        if (isMessages && messagesAnthropic) {
          baselineStatusApplies = true;
          // Probes fire on the ORIGINAL body before the main forward so all three overlap.
          // count_tokens is not billed; ~30-80ms latency is hidden by the main forward.
          const ctBody = buildBaselineCountTokensBody(bodyIn);
          if (ctBody) {
            const ctHeaders = applyGatewayHeaders(filterHeaders(req.headers, STRIP_REQ_HEADERS));
            ctHeaders.set('content-type', 'application/json');
            if (config.apiKey) ctHeaders.set('x-api-key', config.apiKey);
            // The probe carries the client's frozen bearer otherwise, so it 401s
            // exactly when the main forward starts succeeding on the fresh one.
            const ctAuth = resolveAuthToken(config);
            if (ctAuth) ctHeaders.set('authorization', `Bearer ${ctAuth}`);
            // Mirror the actual outbound request base+path: count_tokens lives at
            // `<messages-path>/count_tokens`, so provider-prefixed routes like
            // `/anthropic/messages` probe `/anthropic/messages/count_tokens`.
            const ctBase = providerPrefixed ? passthroughUpstream : upstream;
            const ctUrl = ctBase + url.pathname + '/count_tokens';
            baselinePromise = countTokensUpstream(ctUrl, ctBody, ctHeaders);
            // Null = no markers → cacheable=0 by definition, no probe needed.
            const ctCacheableBody = buildCacheablePrefixCountTokensBody(bodyIn);
            if (ctCacheableBody) {
              baselineCacheablePromise = countTokensUpstream(
                ctUrl,
                ctCacheableBody,
                new Headers(ctHeaders),
              );
            }
          }
        }
      } catch (e) {
        if ((bridgedGptMessages || bridgedChatMessages) && (e as Error).name === 'MessagesBridgeInvalidRequest') {
          fire(400, undefined, `invalid_request: ${(e as Error).message}`);
          return new Response(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: (e as Error).message },
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        fire(502, undefined, `transform_error: ${(e as Error).message}`);
        return new Response(JSON.stringify({ error: 'pxpipe transform failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    } else if (req.method === 'POST') {
      // The model lives in the body, not the path, so read it here too or the
      // dashboard row has a blank Model and token columns. Label only: the body
      // is forwarded byte-for-byte, no transform, no baseline probe, no
      // accounting change. Never overwrite a model already recovered from the
      // path — Google routes name it there and carry no body `model`.
      //
      // This route also carries uploads and audio, so buffer only what can
      // plausibly be a JSON request naming a model: declared JSON, declared
      // length under the cap. Anything else streams and shows a blank Model, as
      // before. A missing content-length is not evidence of a big body —
      // chunked clients omit it — so only an explicit over-cap declaration
      // disqualifies.
      const declaredType = req.headers.get('content-type') ?? '';
      const declaredLength = Number(req.headers.get('content-length') ?? NaN);
      const worthSniffing =
        declaredType.toLowerCase().includes('json') &&
        !(Number.isFinite(declaredLength) && declaredLength > MODEL_SNIFF_MAX_BYTES);
      if (worthSniffing) {
        const sniffCap = Math.min(MODEL_SNIFF_MAX_BYTES, maxRequestBytes);
        const { prefix, body: restoredBody } = await sniffPrefixRestoringBody(req, sniffCap);
        requestModel ??= readModelField(prefix) ?? undefined;
        bodyOut = restoredBody;
      } else {
        bodyOut = req.body; // pass through unchanged, model stays unknown
      }
    } else {
      bodyOut = req.body; // pass through unchanged
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    if (decodedRequestContentEncoding) outHeaders.delete('content-encoding');
    if (isOpenAIPath || bridgedGptMessages || bridgedChatMessages) {
      // `x-api-key` and Anthropic-specific headers never belong on an OpenAI upstream.
      outHeaders.delete('x-api-key');
      const anthropicHeaders: string[] = [];
      outHeaders.forEach((_value, name) => {
        if (name.toLowerCase().startsWith('anthropic-')) anthropicHeaders.push(name);
      });
      for (const name of anthropicHeaders) outHeaders.delete(name);
      // The chat bridge uses the Cloudflare token; Responses uses the OpenAI key.
      const bridgeKey = bridgedChatMessages
        ? config.cloudflareApiKey
        : config.openAIApiKey;
      if (bridgedGptMessages || bridgedChatMessages) {
        // A bridge starts from Anthropic Messages, so its inbound credential is
        // cross-provider by construction. Drop it and use only the target key.
        outHeaders.delete('authorization');
        if (bridgeKey) outHeaders.set('authorization', `Bearer ${bridgeKey}`);
      } else {
        const decision = resolveOpenAIRouteAuth(
          classifyInboundCredential(req.headers),
          bridgeKey !== undefined && bridgeKey !== '',
        );
        if (decision.action === 'drop') outHeaders.delete('authorization');
        else if (decision.action === 'replace') outHeaders.set('authorization', `Bearer ${bridgeKey}`);
      }
    } else if (!providerPrefixed || url.pathname.startsWith('/anthropic/')) {
      if (config.apiKey) outHeaders.set('x-api-key', config.apiKey);
      const bearer = resolveAuthToken(config);
      if (bearer) outHeaders.set('authorization', `Bearer ${bearer}`);
    }

    applyGatewayHeaders(outHeaders);

    let upstreamUrl: string;
    // Gateway OpenAI routes drop the `/v1` prefix; provider-prefixed passthrough
    // routes keep their full path so ocproxy-style upstreams see `/openai/*`,
    // `/google-ai-studio/*`, etc. exactly as the client sent them.
    if (bridgedChatMessages) {
      // The chat bridge forwards to the configured Cloudflare upstream at its
      // /chat/completions endpoint (chatCompletionsUrl normalizes a bare base,
      // a /v1 base, or a full …/chat/completions URL). Every other route appends
      // a path to its resolved base.
      upstreamUrl = chatCompletionsUrl(config.cloudflareUpstream ?? '');
    } else {
      const outPath = bridgedGptMessages
        ? (routes.stripOpenAIV1 ? '/responses' : '/v1/responses')
        : isOpenAIPath && routes.stripOpenAIV1 ? path.replace(/^\/v1(?=\/)/, '') : path;
      const requestUpstreamBase = bridgedGptMessages ? openAIUpstream : upstreamBase;
      upstreamUrl = config.provider === 'featherless'
        ? buildFeatherlessUpstreamUrl(requestUpstreamBase, outPath)
        : requestUpstreamBase + outPath;
    }
    let releaseInFlight = (): void => {};
    if (reqBodySha256 && duplicateHoldMs > 0) {
      const headers: [string, string][] = [];
      outHeaders.forEach((value, name) => { headers.push([name, value]); });
      headers.sort(([a], [b]) => a.localeCompare(b));
      const key = await sha256Text(JSON.stringify([
        req.method,
        upstreamUrl,
        headers,
        reqBodySha256,
      ]));
      const now = Date.now();
      // Time trigger keeps steady state clean; size trigger reclaims promptly if entries
      // ever strand faster than the window. Both are throttled, so cost stays amortized.
      const sinceSweep = now - lastSweptAt;
      if (
        sinceSweep >= duplicateHoldMs
        || (inFlight.size > INFLIGHT_SWEEP_SIZE && sinceSweep >= INFLIGHT_SWEEP_MIN_INTERVAL_MS)
      ) {
        for (const [k, v] of inFlight) {
          if (now - v.startedAt >= duplicateHoldMs) inFlight.delete(k);
        }
        lastSweptAt = now;
      }
      const existing = inFlight.get(key);
      // Fail open once the holder is older than the window: a retry that arrives this
      // late is the client recovering from a stall, not an accidental double-send.
      if (existing && now - existing.startedAt < duplicateHoldMs) {
        const message = 'An identical request is already in progress';
        fire(409, undefined, 'duplicate_request_in_flight');
        const error = isMessages
          ? { type: 'error', error: { type: 'duplicate_request_in_flight', message } }
          : { error: { type: 'duplicate_request_in_flight', message } };
        return new Response(JSON.stringify(error), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      const lease = Symbol();
      inFlight.set(key, { lease, startedAt: now });
      releaseInFlight = () => {
        if (inFlight.get(key)?.lease === lease) inFlight.delete(key);
      };
    }
    // One controller for the whole exchange: headers timeout, stall watchdog and client
    // disconnect all abort through it, so nothing can hold the socket open indefinitely.
    const clientDisconnectController = new AbortController();
    let clientAbortListener: (() => void) | undefined;
    if (req.signal) {
      if (req.signal.aborted) {
        clientDisconnectController.abort(req.signal.reason ?? new Error('pxpipe: client disconnected'));
      } else {
        clientAbortListener = () => {
          clientDisconnectController.abort(req.signal.reason ?? new Error('pxpipe: client disconnected'));
        };
        req.signal.addEventListener('abort', clientAbortListener, { once: true });
      }
    }

    let activeAttemptAbort: AbortController | undefined;
    let timeoutKind: 'headers' | 'idle' | undefined;
    const HEADERS_TIMEOUT = Symbol('headers-timeout');

    let upstreamRes: Response;
    const executeFetch = async (targetBody: BodyInit | null) => {
      const fetchFn = config.customFetch ?? fetch;
      const attemptAbort = new AbortController();
      activeAttemptAbort = attemptAbort;

      let attemptHeadersTimer: ReturnType<typeof setTimeout> | undefined;
      let onClientAbort: (() => void) | undefined;

      if (clientDisconnectController.signal.aborted) {
        attemptAbort.abort(clientDisconnectController.signal.reason ?? new Error('pxpipe: client disconnected'));
      } else {
        onClientAbort = () => {
          attemptAbort.abort(clientDisconnectController.signal.reason ?? new Error('pxpipe: client disconnected'));
        };
        clientDisconnectController.signal.addEventListener('abort', onClientAbort, { once: true });
      }

      // Raced explicitly rather than trusting the fetch implementation to reject on
      // abort — the headers phase must be bounded even if the signal is ignored.
      const attemptHeadersDeadline = new Promise<typeof HEADERS_TIMEOUT>((resolve) => {
        if (headersTimeoutMs <= 0) return;
        attemptHeadersTimer = setTimeout(() => {
          attemptHeadersTimer = undefined;
          timeoutKind = 'headers';
          attemptAbort.abort(new Error('pxpipe: upstream headers timeout'));
          resolve(HEADERS_TIMEOUT);
        }, headersTimeoutMs);
      });
      try {
        const upstreamFetch = fetchFn(upstreamUrl, {
          method: req.method,
          headers: outHeaders,
          body: targetBody,
          signal: attemptAbort.signal,
          // duplex is required by spec when sending a stream as body
          ...(targetBody instanceof ReadableStream ? { duplex: 'half' } : {}),
        } as RequestInit);
        const raced =
          headersTimeoutMs > 0 ? await Promise.race([upstreamFetch, attemptHeadersDeadline]) : await upstreamFetch;
        if (raced === HEADERS_TIMEOUT) {
          // Abandoned: keep its eventual rejection from surfacing as unhandled.
          void upstreamFetch.catch(() => undefined);
          throw new Error('pxpipe: upstream headers timeout');
        }
        return { res: raced, abortController: attemptAbort };
      } finally {
        if (attemptHeadersTimer !== undefined) {
          clearTimeout(attemptHeadersTimer);
          attemptHeadersTimer = undefined;
        }
        if (onClientAbort) {
          clientDisconnectController.signal.removeEventListener('abort', onClientAbort);
        }
      }
    };

    try {
      const attempt1 = await executeFetch(bodyOut);
      upstreamRes = attempt1.res;
      // Watch the raw upstream stream, before any bridge re-encodes it.
      upstreamRes = withIdleTimeout(upstreamRes, headersTimeoutMs, idleTimeoutMs, () => {
        timeoutKind = 'idle';
        attempt1.abortController.abort(new Error('pxpipe: upstream stalled'));
      });
      if (bridgedGptMessages) {
        upstreamRes = await openAIResponsesToAnthropicResponse(upstreamRes, requestModel ?? '');
      } else if (bridgedChatMessages) {
        upstreamRes = await openAIChatToAnthropicResponse(upstreamRes, requestModel ?? '');
      }

      // Safe Fallback logic for transformed Featherless/Kimi requests strictly when provider === 'featherless':
      if (featherlessProvider && info?.compressed && originalBodyBytes && !fallbackAttempted) {
        const targetM = requestModel ?? 'moonshotai/Kimi-K3';
        const inspection = await inspectResponseForErrorEnvelope(upstreamRes);
        upstreamRes = inspection.response;

        if (inspection.isError && shouldFallbackFeatherlessResponse(
          upstreamRes.status,
          inspection.errorMsg,
        )) {
          fallbackAttempted = true;
          fallbackReason = !upstreamRes.ok
            ? `http_status_${upstreamRes.status}`
            : (inspection.errorMsg ?? 'provider_error_envelope');
          const attempt2 = await executeFetch(originalBodyBytes as unknown as BodyInit);
          upstreamAttemptCount = 2;
          const retryInspection = await inspectResponseForErrorEnvelope(attempt2.res);
          let retryResFinal = retryInspection.response;
          retryResFinal = withIdleTimeout(retryResFinal, headersTimeoutMs, idleTimeoutMs, () => {
            timeoutKind = 'idle';
            attempt2.abortController.abort(new Error('pxpipe: upstream stalled'));
          });
          transformationState = 'fallback';
          upstreamRes = retryResFinal;
          if (!retryInspection.isError) {
            // Only a successful text retry proves that the transformed shape was
            // the problem. Provider-wide failures must not poison this breaker.
            recordCircuitBreakerFailure('featherless', upstreamBase, targetM);
            fallbackResult = 'success';
          } else {
            fallbackResult = 'failed';
          }
        } else if (inspection.isError) {
          fallbackReason = !upstreamRes.ok
            ? `http_status_${upstreamRes.status}`
            : (inspection.errorMsg ?? 'provider_error_envelope');
          // The transformed request was sent, but a transient/provider-wide
          // failure is returned directly without an immediate duplicate retry.
          transformationState = 'transformed';
        } else {
          recordCircuitBreakerSuccess('featherless', upstreamBase, targetM);
          transformationState = 'transformed';
        }
      }
    } catch (e) {
      releaseInFlight();
      if (req.signal && clientAbortListener) {
        req.signal.removeEventListener('abort', clientAbortListener);
      }
      if (timeoutKind) {
        const detail = timeoutKind === 'headers'
          ? `no response headers within ${headersTimeoutMs}ms`
          : `no upstream bytes for ${idleTimeoutMs}ms`;
        fire(504, info, `upstream_timeout: ${detail}`);
        return new Response(JSON.stringify({ error: `pxpipe upstream timeout (${detail})` }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        });
      }
      fire(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'pxpipe upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    const firstByteMs = Date.now() - t0;

    // Tee: client gets one side; scanner reads the other for usage/measurement/error body.
    let teed: Response;
    let usagePromise: Promise<Usage | undefined>;
    let errorBodyPromise: Promise<string | undefined>;
    let measurementPromise: Promise<OutputMeasurement | undefined>;
    let stopReasonPromise: Promise<string | undefined>;
    let streamTerminationPromise: Promise<StreamTerminationReason | undefined>;
    try {
      ({ response: teed, usagePromise, errorBodyPromise, measurementPromise, stopReasonPromise, streamTerminationPromise } =
        teeForUsage(upstreamRes));
    } catch (e) {
      releaseInFlight();
      if (req.signal && clientAbortListener) {
        req.signal.removeEventListener('abort', clientAbortListener);
      }
      throw e;
    }

    // Fire event in background once all promises resolve (all share the same stream read).
    void Promise.all([
      usagePromise.catch(() => undefined),
      errorBodyPromise.catch(() => undefined),
      measurementPromise.catch(() => undefined),
      stopReasonPromise.catch(() => undefined),
      streamTerminationPromise.catch(() => undefined),
    ]).then(([usage, errorBody, measurement, stopReason, streamTermination]) => {
      // A rejected request never populated a prefix cache, so the append-only
      // freeze this session was protecting protects nothing: let the next turn
      // re-cut the grid for density instead of preserving dead bytes.
      if (responseLeftNoCache(upstreamRes.status, errorBody)) {
        markCacheDead(info?.firstUserSha8);
      }
      // Feed the provider's own cache accounting back into the session store. A
      // read proves the prefix was live; a create proves one was just written.
      // Either way the next turn must not re-cut the grid — which the wall clock
      // alone could not tell, and got wrong on most gaps that mattered.
      noteCacheOutcome(
        info?.firstUserSha8,
        usage?.cache_read_input_tokens,
        usage?.cache_creation_input_tokens,
      );
      fire(
        upstreamRes.status,
        info,
        undefined,
        firstByteMs,
        usage,
        config.captureErrorReqBody ? errorBody : undefined,
        measurement,
        stopReason,
        streamTermination,
      );
    }).finally(() => {
      releaseInFlight();
      if (req.signal && clientAbortListener) {
        req.signal.removeEventListener('abort', clientAbortListener);
      }
    });

    // Client disconnect: drop the lease immediately and abort upstream, rather than
    // waiting on scanner promises that a wedged connection would never settle.
    const clientBody = teed.body
      ? withClientDisconnect(teed.body, () => {
          releaseInFlight();
          if (req.signal && clientAbortListener) {
            req.signal.removeEventListener('abort', clientAbortListener);
          }
          if (!clientDisconnectController.signal.aborted) {
            clientDisconnectController.abort(new Error('pxpipe: client disconnected'));
          }
          if (activeAttemptAbort && !activeAttemptAbort.signal.aborted) {
            activeAttemptAbort.abort(new Error('pxpipe: client disconnected'));
          }
        })
      : null;

    return new Response(clientBody, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: filterHeaders(upstreamRes.headers, STRIP_RES_HEADERS),
    });
  };
}
