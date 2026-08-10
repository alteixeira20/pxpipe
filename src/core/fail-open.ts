import { createProxy, type ProxyConfig, type ProxyEvent } from './proxy.js';
import {
  setCompressionSafetyScope,
  type PxpipeSafetyScope,
} from './applicability.js';

const TRANSFORM_FAILURE_STATUS = 502;
const TRANSFORM_FAILURE_MARKER = 'pxpipe transform failed';
const SNIFF_LIMIT = 4 * 1024;
/** Internal loopback control used by `pxpipe codex --passthrough` to create a
 * comparable routed baseline. It is stripped before the provider sees it. */
export const PXPIPE_COMPRESSION_CONTROL_HEADER = 'x-pxpipe-compression';

type ProxyRequest = Parameters<ReturnType<typeof createProxy>>[0];

export interface FailOpenHostOptions {
  /** Explicit host policy for runtimes (notably Workers) where process.env is
   * unavailable or may be shimmed by a test/bundler. Node may omit this and
   * retain the PXPIPE_PROFILE environment contract. */
  safetyScope?: PxpipeSafetyScope;
}

/** `@cloudflare/workers-types` augments Request with host metadata generics while
 * Node's Web Request is the unparameterized form. createProxy intentionally uses
 * only standard Request fields, so normalize the structurally compatible value at
 * this single boundary instead of leaking runtime-specific generics through the API. */
function asProxyRequest(request: unknown): ProxyRequest {
  return request as ProxyRequest;
}

/** Only request shapes whose body the transform pipeline may consume need a retry
 * clone. Avoid teeing uploads/audio/arbitrary passthrough streams: a fail-open guard
 * must not become a hidden buffering tax on traffic it can never transform. */
export function mayTransformRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false;
  const path = new URL(request.url).pathname;
  if (
    path === '/v1/messages'
    || path === '/anthropic/v1/messages'
    || path === '/anthropic/messages'
  ) return true;
  if (/(?:\/v1)?\/(?:chat\/completions|responses)$/.test(path)) return true;
  if (/:(?:generateContent|streamGenerateContent)$/.test(path)) return true;
  return false;
}

function isTransformFailureEvent(event: ProxyEvent): boolean {
  return event.status === TRANSFORM_FAILURE_STATUS
    && typeof event.error === 'string'
    && event.error.startsWith('transform_error:');
}

function parseSafetyScope(raw: string | undefined): PxpipeSafetyScope | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'safe' || value === 'coding' || value === 'coding-safe') return 'coding-safe';
  if (value === 'balanced') return 'balanced';
  if (value === 'aggressive' || value === 'legacy') return 'aggressive';
  if (value === 'off' || value === 'disabled' || value === 'passthrough') return 'passthrough';
  return undefined;
}

/**
 * Resolve semantic model-scope policy at the PRODUCT HOST boundary.
 *
 * Low-level `createProxy` retains its historical applicability semantics for SDK
 * compatibility and tests. Node/Worker production hosts enter through this wrapper,
 * so an unset profile means the new coding-safe default here. Explicit aggressive
 * remains available for controlled evaluation.
 */
export function resolveHostedSafetyScope(
  config: ProxyConfig,
  explicitScope?: PxpipeSafetyScope,
): PxpipeSafetyScope {
  if (explicitScope) return explicitScope;

  if (typeof process !== 'undefined') {
    return parseSafetyScope(process.env?.PXPIPE_PROFILE) ?? 'coding-safe';
  }

  const transform = typeof config.transform === 'object' ? config.transform : undefined;
  if (transform?.compress === false) return 'passthrough';
  if (transform?.compressTools === true || transform?.compressToolResults === true) return 'aggressive';
  if (
    transform?.compressTools === false
    && transform.compressToolResults === false
    && transform.minCompressChars === Number.MAX_SAFE_INTEGER
  ) {
    return transform.historyAmortizationHorizon === 3 ? 'balanced' : 'coding-safe';
  }
  // A host using the reliability wrapper without declaring a policy gets the safe
  // default. Hosts wanting legacy semantics can call createProxy directly.
  return 'coding-safe';
}

/**
 * Node's CLI historically parsed PXPIPE_FEATHERLESS_TRANSFORM but did not pass the
 * result into ProxyConfig, which left provider mode at its implicit `auto` default.
 * That also let Featherless bypass the safe model allow-list when PXPIPE_MODELS was
 * unset. Resolve the missing runtime value here, at the common Node/Worker host
 * wrapper, and fail closed for safe profiles.
 *
 * Explicit ProxyConfig always wins. Otherwise safe/balanced/passthrough disable the
 * unvalidated Featherless image path. `aggressive` may use the legacy env mode (or
 * proxy's `auto` default) for controlled A/B evaluation.
 */
export function resolveHostedFeatherlessMode(
  config: ProxyConfig,
  explicitScope?: PxpipeSafetyScope,
): ProxyConfig['featherlessTransformMode'] {
  if (config.featherlessTransformMode !== undefined) return config.featherlessTransformMode;

  const scope = resolveHostedSafetyScope(config, explicitScope);
  if (scope !== 'aggressive') return 'off';

  if (typeof process !== 'undefined') {
    const requested = (process.env?.PXPIPE_FEATHERLESS_TRANSFORM ?? '').trim().toLowerCase();
    if (requested === 'off' || requested === 'auto' || requested === 'force') return requested;
  }
  return undefined;
}

/**
 * True only for pxpipe's own pre-upstream transform failure response.
 *
 * Upstream 502s, bridge validation 400s, timeouts and transport failures are not
 * retried: doing so could duplicate a request that the provider already received.
 * The exact transform-error marker is emitted before any upstream fetch, so a single
 * native-text retry is safe and restores the optimization invariant: pxpipe may make
 * a request cheaper, but a renderer/parser bug must not make a valid request fail.
 */
export async function isPxpipeTransformFailure(response: Response): Promise<boolean> {
  if (response.status !== TRANSFORM_FAILURE_STATUS) return false;
  try {
    const text = (await response.clone().text()).slice(0, SNIFF_LIMIT);
    if (!text.includes(TRANSFORM_FAILURE_MARKER)) return false;
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed.error === TRANSFORM_FAILURE_MARKER;
  } catch {
    return false;
  }
}

function requestsPassthroughBaseline(request: Request): boolean {
  const value = request.headers.get(PXPIPE_COMPRESSION_CONTROL_HEADER)?.trim().toLowerCase();
  return value === 'off' || value === 'false' || value === '0' || value === 'passthrough';
}

/** Remove PXPipe's child-control header before any upstream request. The header
 * controls only the local reliability wrapper and is never provider metadata. */
function stripCompressionControl(request: Request): Request {
  if (!request.headers.has(PXPIPE_COMPRESSION_CONTROL_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(PXPIPE_COMPRESSION_CONTROL_HEADER);
  const bodyAllowed = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    body: bodyAllowed ? request.body : undefined,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body) init.duplex = 'half';
  return new Request(request.url, init);
}

/**
 * Wrap the normal proxy with a single fail-open pass-through retry for transform
 * failures. The retry still uses createProxy, so provider routing, auth rotation,
 * Messages→Responses/Chat bridging, timeouts, duplicate protection and telemetry
 * remain identical; only `compress:false` changes.
 *
 * The same native path is deliberately reusable as a per-process experiment arm:
 * `pxpipe codex --passthrough` injects an internal header on the loopback hop. The
 * wrapper strips it and routes that request through `fallback`, preserving the SAME
 * ChatGPT endpoint, auth, response scanner and event accounting while changing only
 * the compression decision. This is a materially better A/B baseline than `--direct`,
 * which bypasses PXPipe and therefore loses comparable telemetry.
 *
 * The primary proxy's synthetic transform-error event is suppressed because it never
 * reached an upstream and the caller ultimately sees the fallback result. This keeps
 * dashboards at one row per real request instead of reporting a phantom 502 followed
 * by a success. A fallback failure is still reported normally.
 */
export function createFailOpenProxy(
  config: ProxyConfig,
  hostOptions: FailOpenHostOptions = {},
): ((request: Request) => Promise<Response>) {
  const observer = config.onRequest;
  const safetyScope = resolveHostedSafetyScope(config, hostOptions.safetyScope);
  setCompressionSafetyScope(safetyScope);
  const featherlessTransformMode = resolveHostedFeatherlessMode(config, safetyScope);
  const hostedConfig: ProxyConfig = {
    ...config,
    ...(featherlessTransformMode !== undefined ? { featherlessTransformMode } : {}),
  };
  const primary = createProxy({
    ...hostedConfig,
    onRequest: observer
      ? async (event) => {
          if (!isTransformFailureEvent(event)) await observer(event);
        }
      : undefined,
  });
  const fallback = createProxy({
    ...hostedConfig,
    transform: { compress: false },
    featherlessTransformMode: 'off',
  });

  return async (request: Request): Promise<Response> => {
    const forcePassthrough = requestsPassthroughBaseline(request);
    const routedRequest = stripCompressionControl(request);
    if (forcePassthrough) {
      return fallback(asProxyRequest(routedRequest));
    }
    if (!mayTransformRequest(routedRequest)) return primary(asProxyRequest(routedRequest));

    // Clone only a model-request shape and before the primary consumes the stream.
    // The clone is read only if the primary returns the exact pre-upstream marker.
    const retryRequest = routedRequest.clone();
    const response = await primary(asProxyRequest(routedRequest));
    if (!(await isPxpipeTransformFailure(response))) return response;

    const retried = await fallback(asProxyRequest(retryRequest));
    const headers = new Headers(retried.headers);
    headers.set('x-pxpipe-fail-open', 'transform-error');
    return new Response(retried.body, {
      status: retried.status,
      statusText: retried.statusText,
      headers,
    });
  };
}
