/**
 * Featherless.ai provider integration for pxpipe:
 * - Upstream URL normalization (/v1 exact match)
 * - Model capability discovery & bounded TTL caching
 * - HTTP 200 provider error envelope detection
 * - Per-provider/origin/model circuit breaker
 * - Observability types
 */

export type FeatherlessTransformMode = 'off' | 'auto' | 'force';

export type FeatherlessCapabilityDecision =
  | 'capable'
  | 'uncapable'
  | 'disabled'
  | 'discovery_failed';

export type FeatherlessCapabilitySource = 'api' | 'cache' | 'override';
export type FeatherlessCacheStatus = 'hit' | 'miss' | 'bypass';

export type FeatherlessTransformationState =
  | 'transformed'
  | 'passthrough'
  | 'degraded'
  | 'skipped'
  | 'fallback';

export interface FeatherlessCapabilityResult {
  visionSupported: boolean;
  decision: FeatherlessCapabilityDecision;
  source: FeatherlessCapabilitySource;
  cacheStatus: FeatherlessCacheStatus;
  error?: string;
}

export interface FeatherlessObservabilityFields {
  provider?: string;
  transformation_mode?: FeatherlessTransformMode;
  transformation_state?: FeatherlessTransformationState;
  capability_decision?: FeatherlessCapabilityDecision;
  capability_source?: FeatherlessCapabilitySource;
  capability_cache_status?: FeatherlessCacheStatus;
  skip_reason?: string;
  fallback_attempted?: boolean;
  fallback_reason?: string;
  fallback_result?: 'success' | 'failed' | 'not_attempted';
  upstream_attempt_count?: number;
}

/** Package version injected by the host entrypoint (node.ts / worker).
 *  Defaults to 'unknown' when not set (library use). */
let pxpipeVersion = 'unknown';

/** Set the package version for User-Agent headers. Called once at startup. */
export function setPxpipeVersion(v: string): void {
  pxpipeVersion = v;
}

const CAPABILITY_SUCCESS_TTL_MS = 300_000; // 5 minutes
const CAPABILITY_FAILURE_TTL_MS = 60_000;  // 1 minute

interface CacheEntry {
  result: FeatherlessCapabilityResult;
  expiresAt: number;
}

const capabilityCache = new Map<string, CacheEntry>();

/**
 * Computes a non-secret, in-memory SHA-256 digest (16 hex chars) for authorization context isolation.
 * Kept strictly in memory and never emitted in events, errors, dashboard state, or logs.
 */
export async function computeAuthContextDigest(authHeader?: string): Promise<string> {
  if (!authHeader) return 'none';
  const encoded = new TextEncoder().encode(authHeader);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

/**
 * Normalizes Featherless model discovery API responses conservatively.
 * Explicit unsupported/unavailable status overrides generic image flags.
 * Considers status, available_on_current_plan, vision_supported, features.image_input and input_modalities.
 */
export function parseFeatherlessModelMetadata(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  // Explicit negative / unavailable overrides take precedence
  if (
    obj.status === 'unavailable' ||
    obj.status === 'disabled' ||
    obj.status === 'offline' ||
    obj.status === 'unsupported'
  ) {
    return false;
  }
  if (obj.available_on_current_plan === false) {
    return false;
  }
  if (obj.vision_supported === false) {
    return false;
  }
  if (obj.features && typeof obj.features === 'object') {
    const feat = obj.features as Record<string, unknown>;
    if (feat.image_input === false) return false;
  }

  // Positive signals
  let positiveSignal = false;
  if (obj.vision_supported === true) {
    positiveSignal = true;
  }
  if (obj.features && typeof obj.features === 'object') {
    const feat = obj.features as Record<string, unknown>;
    if (feat.image_input === true) positiveSignal = true;
  }
  if (Array.isArray(obj.input_modalities)) {
    if (obj.input_modalities.includes('image') || obj.input_modalities.includes('vision')) {
      positiveSignal = true;
    }
  }

  return positiveSignal;
}

/**
 * Clear capability cache (mainly for tests).
 */
export function clearFeatherlessCapabilityCache(): void {
  capabilityCache.clear();
}

/**
 * Encodes each model path segment separately so separators like moonshotai/Kimi-K3
 * are preserved as /v1/models/moonshotai/Kimi-K3.
 */
export function buildFeatherlessDiscoveryUrl(upstreamBase: string, model: string): string {
  const normalizedBase = normalizeUpstreamRoot(upstreamBase);
  const encodedModel = model
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${normalizedBase}/v1/models/${encodedModel}`;
}

/**
 * Discover Kimi / Featherless model capabilities via GET /v1/models/{model}.
 * Fails gracefully to pass-through mode if network/discovery fails.
 */
export async function discoverFeatherlessCapability(
  upstreamBase: string,
  model: string,
  authHeader?: string,
  customFetch: typeof fetch = fetch,
): Promise<FeatherlessCapabilityResult> {
  const normalizedBase = normalizeUpstreamRoot(upstreamBase);
  const authDigest = await computeAuthContextDigest(authHeader);
  const cacheKey = `${normalizedBase}::${model}::${authDigest}`;
  const now = Date.now();
  const cached = capabilityCache.get(cacheKey);

  if (cached && now < cached.expiresAt) {
    return {
      ...cached.result,
      source: 'cache',
      cacheStatus: 'hit',
    };
  }

  const discoveryUrl = buildFeatherlessDiscoveryUrl(upstreamBase, model);

  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `pxpipe/${pxpipeVersion}`,
  };
  if (authHeader) {
    headers.authorization = authHeader;
  }

  try {
    const res = await customFetch(discoveryUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const result: FeatherlessCapabilityResult = {
        visionSupported: false,
        decision: 'discovery_failed',
        source: 'api',
        cacheStatus: 'miss',
        error: `HTTP ${res.status}`,
      };
      capabilityCache.set(cacheKey, { result, expiresAt: now + CAPABILITY_FAILURE_TTL_MS });
      return result;
    }

    const data = await res.json();
    const visionSupported = parseFeatherlessModelMetadata(data);
    const result: FeatherlessCapabilityResult = {
      visionSupported,
      decision: visionSupported ? 'capable' : 'uncapable',
      source: 'api',
      cacheStatus: 'miss',
    };
    capabilityCache.set(cacheKey, { result, expiresAt: now + CAPABILITY_SUCCESS_TTL_MS });
    return result;
  } catch (e) {
    const result: FeatherlessCapabilityResult = {
      visionSupported: false,
      decision: 'discovery_failed',
      source: 'api',
      cacheStatus: 'miss',
      error: (e as Error).message,
    };
    capabilityCache.set(cacheKey, { result, expiresAt: now + CAPABILITY_FAILURE_TTL_MS });
    return result;
  }
}

/**
 * Normalizes upstream URL root so that appending `/v1/...` path results in `/v1` appearing
 * EXACTLY ONCE in the generated upstream URL.
 */
export function normalizeUpstreamRoot(rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) {
    url = url.slice(0, -3).replace(/\/+$/, '');
  }
  return url;
}

/**
 * Builds full upstream URL ensuring `/v1` appears exactly once in path.
 */
export function buildFeatherlessUpstreamUrl(base: string, rawPath: string): string {
  const root = normalizeUpstreamRoot(base);
  let path = rawPath;
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith('/v1/')) {
    if (path === '/v1') {
      path = '/v1';
    } else {
      path = '/v1' + path;
    }
  }
  return `${root}${path}`;
}

/**
 * Detects if a response (even HTTP 200) contains a Featherless provider error envelope:
 * e.g., {"message": "This model is busy, please try again later.", "code": "completion_error"}
 * or {"error": ...}
 */
/**
 * Returns true only when retrying the original text request can plausibly
 * distinguish an image-compatibility failure from a provider-wide failure.
 *
 * Transient load, authentication, routing and server failures must not trigger a
 * second upstream request: retrying them immediately doubles traffic, worsens
 * rate limits, and can incorrectly open the image circuit breaker.
 */
export function shouldFallbackFeatherlessResponse(
  status: number,
  errorMessage?: string,
): boolean {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return false;
  if (status === 401 || status === 403 || status === 404 || status === 409) return false;

  if (status >= 400) {
    return status === 400 || status === 413 || status === 415 || status === 422;
  }

  if (!errorMessage) return false;
  return /(image|vision|multimodal|modality|unsupported\s+(?:content|input)|invalid\s+(?:image|content)|payload\s+too\s+large)/i
    .test(errorMessage);
}

export function detectProviderErrorEnvelope(bodyText: string): string | null {
  if (!bodyText || !bodyText.trim().startsWith('{')) return null;
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    if (json.code === 'completion_error' && typeof json.message === 'string') {
      return json.message;
    }
    if (json.error && typeof json.error === 'object') {
      const err = json.error as Record<string, unknown>;
      if (typeof err.message === 'string') return err.message;
    }
    if (typeof json.error === 'string') {
      return json.error;
    }
  } catch {
    // Not valid JSON envelope
  }
  return null;
}

/**
 * Per-provider + upstream origin + model circuit breaker.
 */
interface CircuitBreakerEntry {
  failures: number;
  openUntil: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 consecutive failures opens circuit
const CIRCUIT_BREAKER_COOLDOWN_MS = 300_000; // 5 minutes open duration

const circuitBreakers = new Map<string, CircuitBreakerEntry>();

export function buildCircuitBreakerKey(provider: string, upstreamOrigin: string, model: string): string {
  const normOrigin = normalizeUpstreamRoot(upstreamOrigin);
  return `${provider}::${normOrigin}::${model}`;
}

export function isCircuitBreakerOpen(provider: string, upstreamOrigin: string, model: string): boolean {
  const key = buildCircuitBreakerKey(provider, upstreamOrigin, model);
  const entry = circuitBreakers.get(key);
  if (!entry) return false;
  if (entry.openUntil > 0 && Date.now() >= entry.openUntil) {
    circuitBreakers.delete(key);
    return false;
  }
  return entry.failures >= CIRCUIT_BREAKER_THRESHOLD;
}

export function recordCircuitBreakerSuccess(provider: string, upstreamOrigin: string, model: string): void {
  const key = buildCircuitBreakerKey(provider, upstreamOrigin, model);
  circuitBreakers.delete(key);
}

export function recordCircuitBreakerFailure(provider: string, upstreamOrigin: string, model: string): void {
  const key = buildCircuitBreakerKey(provider, upstreamOrigin, model);
  const now = Date.now();
  const entry = circuitBreakers.get(key) ?? { failures: 0, openUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    entry.openUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
  }
  circuitBreakers.set(key, entry);
}

export function clearCircuitBreakers(): void {
  circuitBreakers.clear();
}
