import { createProxy, type ProxyConfig } from './proxy.js';

const TRANSFORM_FAILURE_STATUS = 502;
const TRANSFORM_FAILURE_MARKER = 'pxpipe transform failed';
const SNIFF_LIMIT = 4 * 1024;

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
 */
export function createFailOpenProxy(
  config: ProxyConfig,
): ((request: Request) => Promise<Response>) {
  const primary = createProxy(config);
  const fallback = createProxy({
    ...config,
    transform: { compress: false },
  });

  return async (request: Request): Promise<Response> => {
    // Clone before the primary consumes a streamed POST body. A clone is only read
    // if the primary returns the exact pre-upstream transform failure marker.
    const retryRequest = request.clone();
    const response = await primary(request);
    if (!(await isPxpipeTransformFailure(response))) return response;

    const retried = await fallback(retryRequest);
    const headers = new Headers(retried.headers);
    headers.set('x-pxpipe-fail-open', 'transform-error');
    return new Response(retried.body, {
      status: retried.status,
      statusText: retried.statusText,
      headers,
    });
  };
}
