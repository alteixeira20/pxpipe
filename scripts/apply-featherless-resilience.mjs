import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, before, after) {
  const current = readFileSync(path, 'utf8');
  if (!current.includes(before)) {
    throw new Error(`Expected patch target not found in ${path}`);
  }
  if (current.includes(after)) {
    return;
  }
  writeFileSync(path, current.replace(before, after));
}

const featherlessPath = 'src/core/featherless.ts';
const featherless = readFileSync(featherlessPath, 'utf8');
const helperAnchor = `export function detectProviderErrorEnvelope(bodyText: string): string | null {`;
const helper = `/**\n * Returns true only when retrying the original text request can plausibly\n * distinguish an image-compatibility failure from a provider-wide failure.\n *\n * Transient load, authentication, routing and server failures must not trigger a\n * second upstream request: retrying them immediately doubles traffic, worsens\n * rate limits, and can incorrectly open the image circuit breaker.\n */\nexport function shouldFallbackFeatherlessResponse(\n  status: number,\n  errorMessage?: string,\n): boolean {\n  if (status === 408 || status === 425 || status === 429 || status >= 500) return false;\n  if (status === 401 || status === 403 || status === 404 || status === 409) return false;\n\n  if (status >= 400) {\n    return status === 400 || status === 413 || status === 415 || status === 422;\n  }\n\n  if (!errorMessage) return false;\n  return /(image|vision|multimodal|modality|unsupported\\s+(?:content|input)|invalid\\s+(?:image|content)|payload\\s+too\\s+large)/i\n    .test(errorMessage);\n}\n\n`;
if (!featherless.includes('export function shouldFallbackFeatherlessResponse(')) {
  if (!featherless.includes(helperAnchor)) throw new Error('Featherless helper anchor missing');
  writeFileSync(featherlessPath, featherless.replace(helperAnchor, helper + helperAnchor));
}

replaceExact(
  'src/core/proxy.ts',
  `  recordCircuitBreakerFailure,\n  recordCircuitBreakerSuccess,`,
  `  recordCircuitBreakerFailure,\n  recordCircuitBreakerSuccess,\n  shouldFallbackFeatherlessResponse,`,
);

replaceExact(
  'src/core/proxy.ts',
  `        if (inspection.isError) {\n          recordCircuitBreakerFailure('featherless', upstreamBase, targetM);\n          fallbackAttempted = true;\n          fallbackReason = !upstreamRes.ok ? \`http_status_\${upstreamRes.status}\` : (inspection.errorMsg ?? 'provider_error_envelope');\n          const attempt2 = await executeFetch(originalBodyBytes as unknown as BodyInit);\n          upstreamAttemptCount = 2;\n          const retryInspection = await inspectResponseForErrorEnvelope(attempt2.res);\n          let retryResFinal = retryInspection.response;\n          retryResFinal = withIdleTimeout(retryResFinal, headersTimeoutMs, idleTimeoutMs, () => {\n            timeoutKind = 'idle';\n            attempt2.abortController.abort(new Error('pxpipe: upstream stalled'));\n          });\n          if (!retryInspection.isError) {\n            fallbackResult = 'success';\n            transformationState = 'fallback';\n            upstreamRes = retryResFinal;\n          } else {\n            fallbackResult = 'failed';\n            transformationState = 'fallback';\n            upstreamRes = retryResFinal;\n          }\n        } else {`,
  `        if (inspection.isError && shouldFallbackFeatherlessResponse(\n          upstreamRes.status,\n          inspection.errorMsg,\n        )) {\n          fallbackAttempted = true;\n          fallbackReason = !upstreamRes.ok\n            ? \`http_status_\${upstreamRes.status}\`\n            : (inspection.errorMsg ?? 'provider_error_envelope');\n          const attempt2 = await executeFetch(originalBodyBytes as unknown as BodyInit);\n          upstreamAttemptCount = 2;\n          const retryInspection = await inspectResponseForErrorEnvelope(attempt2.res);\n          let retryResFinal = retryInspection.response;\n          retryResFinal = withIdleTimeout(retryResFinal, headersTimeoutMs, idleTimeoutMs, () => {\n            timeoutKind = 'idle';\n            attempt2.abortController.abort(new Error('pxpipe: upstream stalled'));\n          });\n          transformationState = 'fallback';\n          upstreamRes = retryResFinal;\n          if (!retryInspection.isError) {\n            // Only a successful text retry proves that the transformed shape was\n            // the problem. Provider-wide failures must not poison this breaker.\n            recordCircuitBreakerFailure('featherless', upstreamBase, targetM);\n            fallbackResult = 'success';\n          } else {\n            fallbackResult = 'failed';\n          }\n        } else if (inspection.isError) {\n          fallbackReason = !upstreamRes.ok\n            ? \`http_status_\${upstreamRes.status}\`\n            : (inspection.errorMsg ?? 'provider_error_envelope');\n          // The transformed request was sent, but a transient/provider-wide\n          // failure is returned directly without an immediate duplicate retry.\n          transformationState = 'transformed';\n        } else {`,
);

replaceExact(
  'src/dashboard/fragments.ts',
  `  if (state === 'degraded' || state === 'capability-skipped' || state === 'skipped') {\n    const label = state === 'degraded' ? 'degraded' : 'capability-skipped';\n    return \`<span class="badge badge-warn">\${label}</span>\`;\n  }`,
  `  if (state === 'degraded') {\n    return \`<span class="badge badge-warn">degraded</span>\`;\n  }\n  if (state === 'capability-skipped') {\n    return \`<span class="badge badge-warn">capability-skipped</span>\`;\n  }\n  if (state === 'skipped') {\n    return \`<span class="badge badge-warn">skipped</span>\`;\n  }`,
);

writeFileSync('tests/featherless-resilience.test.ts', `import { beforeEach, describe, expect, it } from 'vitest';\nimport {\n  clearCircuitBreakers,\n  isCircuitBreakerOpen,\n  recordCircuitBreakerFailure,\n  recordCircuitBreakerSuccess,\n  shouldFallbackFeatherlessResponse,\n} from '../src/core/featherless.js';\n\nconst provider = 'featherless';\nconst upstream = 'https://api.featherless.ai';\nconst model = 'moonshotai/Kimi-K3';\n\ndescribe('Featherless fallback policy', () => {\n  it.each([408, 425, 429, 500, 502, 503, 504])('does not amplify transient HTTP %s failures', (status) => {\n    expect(shouldFallbackFeatherlessResponse(status, 'busy')).toBe(false);\n  });\n\n  it.each([401, 403, 404, 409])('does not retry auth or routing HTTP %s failures', (status) => {\n    expect(shouldFallbackFeatherlessResponse(status, 'bad request')).toBe(false);\n  });\n\n  it.each([400, 413, 415, 422])('allows a text fallback for transform-shaped HTTP %s failures', (status) => {\n    expect(shouldFallbackFeatherlessResponse(status)).toBe(true);\n  });\n\n  it('allows a 200 error envelope only when it indicates image incompatibility', () => {\n    expect(shouldFallbackFeatherlessResponse(200, 'image input is unsupported')).toBe(true);\n    expect(shouldFallbackFeatherlessResponse(200, 'model is busy, try again later')).toBe(false);\n  });\n});\n\ndescribe('Featherless image circuit breaker', () => {\n  beforeEach(() => clearCircuitBreakers());\n\n  it('opens after three confirmed transform failures and resets on success', () => {\n    recordCircuitBreakerFailure(provider, upstream, model);\n    recordCircuitBreakerFailure(provider, upstream, model);\n    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(false);\n\n    recordCircuitBreakerFailure(provider, upstream, model);\n    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(true);\n\n    recordCircuitBreakerSuccess(provider, upstream, model);\n    expect(isCircuitBreakerOpen(provider, upstream, model)).toBe(false);\n  });\n});\n`);

console.log('Applied Featherless resilience patch.');
