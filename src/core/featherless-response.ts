import { detectProviderErrorEnvelope } from './featherless.js';

export type FeatherlessFailureKind =
  | 'authentication'
  | 'permission'
  | 'rate_limit'
  | 'model_unavailable'
  | 'payload_rejected'
  | 'timeout'
  | 'transient_upstream'
  | 'provider_error'
  | 'unknown';

export interface FeatherlessFailureClassification {
  kind: FeatherlessFailureKind;
  retryAfterMs?: number;
  hard: boolean;
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : undefined;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function classifyFeatherlessFailure(
  status: number,
  bodyText = '',
  retryAfter?: string | null,
): FeatherlessFailureClassification | null {
  if (status >= 200 && status < 300) {
    const envelope = detectProviderErrorEnvelope(bodyText);
    return envelope ? { kind: 'provider_error', hard: false } : null;
  }

  const lower = bodyText.toLowerCase();
  const retryAfterMs = parseRetryAfter(retryAfter);
  const result = (
    kind: FeatherlessFailureKind,
    hard: boolean,
  ): FeatherlessFailureClassification => ({
    kind,
    hard,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  if (status === 401) return result('authentication', true);
  if (status === 403) return result('permission', true);
  if (status === 408 || status === 504) return result('timeout', false);
  if (status === 429) return result('rate_limit', false);
  if (status === 413 || status === 415 || status === 422) return result('payload_rejected', true);
  if (status === 404 || /model.*(?:not found|unavailable|disabled|unsupported)/.test(lower)) {
    return result('model_unavailable', true);
  }
  if (status >= 500) return result('transient_upstream', false);
  if (status >= 400) return result('provider_error', true);
  return result('unknown', false);
}

export function shouldAutomaticallyRetryFeatherless(
  failure: FeatherlessFailureClassification | null,
): boolean {
  if (!failure || failure.hard) return false;
  // PXPipe does not own a general provider retry loop. This predicate exists for
  // bounded callers and explicitly prevents hot-looping rate limits without a
  // Retry-After value.
  if (failure.kind === 'rate_limit') return failure.retryAfterMs !== undefined;
  return failure.kind === 'timeout' || failure.kind === 'transient_upstream';
}
