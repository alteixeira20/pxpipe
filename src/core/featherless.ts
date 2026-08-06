import {
  BoundedCapabilityCache,
  type CapabilityCacheInspection,
} from './capability-cache.js';

/**
 * Featherless.ai provider integration for pxpipe:
 * - Upstream URL normalization (/v1 exact match)
 * - Model capability discovery & bounded stale-while-revalidate caching
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

let pxpipeVersion = 'unknown';

export function setPxpipeVersion(v: string): void {
  pxpipeVersion = v;
}

const capabilityCache = new BoundedCapabilityCache<FeatherlessCapabilityResult>({
  maxEntries: 256,
  successTtlMs: 300_000,
  negativeTtlMs: 120_000,
  failureTtlMs: 30_000,
  staleWhileRevalidateMs: 300_000,
});

export async function computeAuthContextDigest(authHeader?: string): Promise<string> {
  if (!authHeader) return 'none';
  const encoded = new TextEncoder().encode(authHeader);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}

export function parseFeatherlessModelMetadata(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  if (
    obj.status === 'unavailable' ||
    obj.status === 'disabled' ||
    obj.status === 'offline' ||
    obj.status === 'unsupported'
  ) {
    return false;
  }
  if (obj.available_on_current_plan === false || obj.vision_supported === false) return false;
  if (obj.features && typeof obj.features === 'object') {
    const feat = obj.features as Record<string, unknown>;
    if (feat.image_input === false) return false;
  }

  if (obj.vision_supported === true) return true;
  if (obj.features && typeof obj.features === 'object') {
    const feat = obj.features as Record<string, unknown>;
    if (feat.image_input === true) return true;
  }
  return Array.isArray(obj.input_modalities)
    && (obj.input_modalities.includes('image') || obj.input_modalities.includes('vision'));
}

export function clearFeatherlessCapabilityCache(): void {
  capabilityCache.clear();
}

export function inspectFeatherlessCapabilityCache(): CapabilityCacheInspection {
  return capabilityCache.inspect();
}

export function buildFeatherlessDiscoveryUrl(upstreamBase: string, model: string): string {
  const normalizedBase = normalizeUpstreamRoot(upstreamBase);
  const encodedModel = model
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${normalizedBase}/v1/models/${encodedModel}`;
}

function discoveryHeaders(authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `pxpipe/${pxpipeVersion}`,
  };
  if (authHeader) headers.authorization = authHeader;
  return headers;
}

async function fetchFeatherlessCapability(
  upstreamBase: string,
  model: string,
  authHeader: string | undefined,
  customFetch: typeof fetch,
): Promise<FeatherlessCapabilityResult> {
  try {
    const res = await customFetch(buildFeatherlessDiscoveryUrl(upstreamBase, model), {
      method: 'GET',
      headers: discoveryHeaders(authHeader),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        visionSupported: false,
        decision: 'discovery_failed',
        source: 'api',
        cacheStatus: 'miss',
        error: `HTTP ${res.status}`,
      };
    }

    const visionSupported = parseFeatherlessModelMetadata(await res.json());
    return {
      visionSupported,
      decision: visionSupported ? 'capable' : 'uncapable',
      source: 'api',
      cacheStatus: 'miss',
    };
  } catch (e) {
    return {
      visionSupported: false,
      decision: 'discovery_failed',
      source: 'api',
      cacheStatus: 'miss',
      error: (e as Error).message,
    };
  }
}

function cacheCapability(key: string, result: FeatherlessCapabilityResult): FeatherlessCapabilityResult {
  capabilityCache.set(key, {
    value: result,
    positive: result.visionSupported,
    failed: result.decision === 'discovery_failed',
  });
  return result;
}

async function capabilityCacheKey(
  upstreamBase: string,
  model: string,
  authHeader?: string,
): Promise<string> {
  const normalizedBase = normalizeUpstreamRoot(upstreamBase);
  const authDigest = await computeAuthContextDigest(authHeader);
  return `${normalizedBase}::${model}::${authDigest}`;
}

export async function discoverFeatherlessCapability(
  upstreamBase: string,
  model: string,
  authHeader?: string,
  customFetch: typeof fetch = fetch,
): Promise<FeatherlessCapabilityResult> {
  const key = await capabilityCacheKey(upstreamBase, model, authHeader);
  const cached = capabilityCache.get(key);
  if (cached.state === 'fresh' && cached.value) {
    return { ...cached.value, source: 'cache', cacheStatus: 'hit' };
  }

  const load = (): Promise<FeatherlessCapabilityResult> => capabilityCache.runSingleFlight(
    key,
    async () => cacheCapability(
      key,
      await fetchFeatherlessCapability(upstreamBase, model, authHeader, customFetch),
    ),
  );

  if (cached.state === 'stale' && cached.value) {
    void load().catch(() => undefined);
    return { ...cached.value, source: 'cache', cacheStatus: 'hit' };
  }
  return load();
}

export async function refreshFeatherlessCapability(
  upstreamBase: string,
  model: string,
  authHeader?: string,
  customFetch: typeof fetch = fetch,
): Promise<FeatherlessCapabilityResult> {
  const key = await capabilityCacheKey(upstreamBase, model, authHeader);
  capabilityCache.delete(key);
  return discoverFeatherlessCapability(upstreamBase, model, authHeader, customFetch);
}

export function normalizeUpstreamRoot(rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) url = url.slice(0, -3).replace(/\/+$/, '');
  return url;
}

export function buildFeatherlessUpstreamUrl(base: string, rawPath: string): string {
  const root = normalizeUpstreamRoot(base);
  let path = rawPath;
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith('/v1/')) path = path === '/v1' ? '/v1' : '/v1' + path;
  return `${root}${path}`;
}

export function shouldFallbackFeatherlessResponse(
  status: number,
  errorMessage?: string,
): boolean {
  if (status === 401 || status === 403 || status === 404 || status === 409 || status === 429) {
    return false;
  }
  if (status >= 400) return true;
  return Boolean(errorMessage);
}

export function detectProviderErrorEnvelope(bodyText: string): string | null {
  if (!bodyText || !bodyText.trim().startsWith('{')) return null;
  try {
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    if (json.code === 'completion_error' && typeof json.message === 'string') return json.message;
    if (json.error && typeof json.error === 'object') {
      const err = json.error as Record<string, unknown>;
      if (typeof err.message === 'string') return err.message;
    }
    if (typeof json.error === 'string') return json.error;
  } catch {
    // Not a JSON error envelope.
  }
  return null;
}

interface CircuitBreakerEntry {
  failures: number;
  openUntil: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 300_000;
const circuitBreakers = new Map<string, CircuitBreakerEntry>();

export function buildCircuitBreakerKey(provider: string, upstreamOrigin: string, model: string): string {
  return `${provider}::${normalizeUpstreamRoot(upstreamOrigin)}::${model}`;
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
  circuitBreakers.delete(buildCircuitBreakerKey(provider, upstreamOrigin, model));
}

export function recordCircuitBreakerFailure(provider: string, upstreamOrigin: string, model: string): void {
  const key = buildCircuitBreakerKey(provider, upstreamOrigin, model);
  const now = Date.now();
  const entry = circuitBreakers.get(key) ?? { failures: 0, openUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= CIRCUIT_BREAKER_THRESHOLD) entry.openUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
  circuitBreakers.set(key, entry);
}

export function clearCircuitBreakers(): void {
  circuitBreakers.clear();
}
