import { createProxy, type ProxyConfig, type ProxyEvent } from './proxy.js';

const TRANSFORM_FAILURE_STATUS = 502;
const TRANSFORM_FAILURE_MARKER = 'pxpipe transform failed';
const SNIFF_LIMIT = 4 * 1024;

type ProxyRequest = Parameters<ReturnType<typeof createProxy>>[0];

/** `@cloudflare/workers-types` augments Request with host metadata generics while
 * Node's Web Request is the unparameterized form. createProxy intentionally uses
 * only standard Request fields, so normalize the structurally compatible value at
 * this single boundary instead of leaking runtime-specific generics through the API. */
function asProxyRequest(request: Request): ProxyRequest {
  return request as unknown as ProxyRequest;
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

/**
 * Wrap the normal proxy with a single fail-open pass-through retry for transform
 * failures. The retry still uses createProxy, so provider routing, auth rotation,
 * Messages→Responses/Chat bridging, timeouts, duplicate protection and telemetry
 * remain identical; only `compress:false` changes.
 *
 * The primary proxy's synthetic transform-error event is suppressed because it never
 * reached an upstream and the caller ultimately sees the fallback result. This keeps
 * dashboards at one row per real request instead of reporting a phantom 502 followed
 * by a success. A fallback failure is still reported normally.
 */
export function createFailOpenProxy(
  config: ProxyConfig,
): ((request: Request) => Promise<Response>) {
  const observer = config.onRequest;
  const primary = createProxy({
    ...config,
    onRequest: observer
      ? async (event) => {
          if (!isTransformFailureEvent(event)) await observer(event);
        }
      : undefined,
  });
  const fallback = createProxy({
    ...config,
    transform: { compress: false },
  });

  return async (request: Request): Promise<Response> => {
    if (!mayTransformRequest(request)) return primary(asProxyRequest(request));

    // Clone only a model-request shape and before the primary consumes the stream.
    // The clone is read only if the primary returns the exact pre-upstream marker.
    const retryRequest = request.clone();
    const response = await primary(asProxyRequest(request));
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
