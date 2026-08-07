/** Applicability helpers for pxpipe's production-safe model scope. */

import { isMisresolvedModelId } from './gpt-model-profiles.js';

export type PxpipeApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export interface PxpipeApplicabilityInput {
  readonly model?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly bodyBytes?: number | null;
}

export type PxpipeSafetyScope = 'coding-safe' | 'balanced' | 'aggressive' | 'passthrough';

/** Bracketed variant tags (e.g. `[1m]`) stripped before model matching so base and variant gate identically. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Dashboard runtime override; null = fall back to PXPIPE_MODELS env / built-in default. In-memory only. */
let runtimeModelBases: readonly string[] | null = null;
/** Host-selected safety profile. Product hosts install this explicitly; low-level
 * core/library consumers retain the historical model-scope semantics unless they
 * choose a profile-local gate. */
let runtimeSafetyScope: PxpipeSafetyScope | null = null;

/** Historical low-level default scope. Product hosts apply the stricter safe-model
 * filter on top of this list. Keeping this baseline unchanged prevents a semantic
 * policy change from breaking direct createProxy/dashboard/test consumers. */
const DEFAULT_MODEL_BASES = ['claude-fable-5', 'gemini-3.6-flash'];
const SAFE_VALIDATED_MODEL_BASES = ['claude-fable-5', 'gemini-3.6-flash'];

function falsey(v: string): boolean {
  return /^(0|false|no|off|none)$/i.test(v.trim());
}

/** When no product host has installed a safety scope, preserve the pre-profile
 * applicability contract. An explicitly configured PXPIPE_PROFILE still applies,
 * which is useful to low-level Node consumers that intentionally opt in by env. */
function envSafetyScope(): PxpipeSafetyScope {
  if (typeof process === 'undefined') return 'aggressive';
  const raw = (process.env?.PXPIPE_PROFILE ?? '').trim().toLowerCase();
  if (!raw) return 'aggressive';
  if (raw === 'safe' || raw === 'coding' || raw === 'coding-safe') return 'coding-safe';
  if (raw === 'balanced') return 'balanced';
  if (raw === 'aggressive' || raw === 'legacy') return 'aggressive';
  if (raw === 'off' || raw === 'disabled' || raw === 'passthrough') return 'passthrough';
  // Product startup validation reports the configuration error. Until then, fail
  // closed rather than allowing an unknown profile to broaden model eligibility.
  return 'passthrough';
}

function activeSafetyScope(): PxpipeSafetyScope {
  return runtimeSafetyScope ?? envSafetyScope();
}

/** PXPIPE_MODELS env / built-in default, ignoring the runtime override. One CSV
 *  controls every family (Claude + GPT). Resolution (read per-call so scope flips LIVE):
 *  - unset or empty        → historical core default (Fable 5 + Gemini 3.6 Flash)
 *  - `off`/`0`/`false`/... → compress nothing
 *  - CSV of model bases    → exactly those families (subject to active host safety) */
function envOrDefaultBases(): string[] {
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_MODELS : undefined;
  if (raw === undefined) return [...DEFAULT_MODEL_BASES];
  const trimmed = raw.trim();
  if (!trimmed) return [...DEFAULT_MODEL_BASES];
  if (falsey(trimmed)) return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function modelBaseMatches(id: string, candidate: string): boolean {
  const target = candidate.toLowerCase();
  return id === target || id.startsWith(`${target}-`);
}

function safetyAllowsConfiguredBase(candidate: string, scope: PxpipeSafetyScope): boolean {
  if (scope === 'passthrough') return false;
  if (scope !== 'coding-safe' && scope !== 'balanced') return true;
  const base = baseModelId(candidate).toLowerCase();
  const unqualified = unqualifiedModelId(base);
  return SAFE_VALIDATED_MODEL_BASES.some((safe) =>
    modelBaseMatches(base, safe)
    || (unqualified !== null && modelBaseMatches(unqualified, safe)),
  );
}

function configuredModelBases(): string[] {
  return runtimeModelBases !== null ? [...runtimeModelBases] : envOrDefaultBases();
}

function allowedModelBasesForScope(scope: PxpipeSafetyScope): string[] {
  return configuredModelBases().filter((candidate) => safetyAllowsConfiguredBase(candidate, scope));
}

function allowedModelBases(): string[] {
  return allowedModelBasesForScope(activeSafetyScope());
}

/** Current effective allowed-model scope after host semantic safety filtering. */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** User-requested runtime scope before semantic safety filtering. Dashboard
 * controls must mutate this set rather than the filtered set or a blocked model
 * click can silently erase other requested models. */
export function getRequestedModelBases(): string[] {
  return configuredModelBases();
}

/** PXPIPE_MODELS env / historical default scope, independent of runtime override and safety filtering. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the dashboard runtime override. Empty array = compress nothing; null = clear override. Not persisted. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

/** Host-level semantic profile gate. Safe/balanced currently permit only models
 * whose provider path has passed the coding non-inferiority suite. Aggressive keeps
 * the explicit PXPIPE_MODELS scope for controlled experiments. `null` restores the
 * low-level env/backward-compatible resolution. */
export function setCompressionSafetyScope(scope: PxpipeSafetyScope | null): void {
  runtimeSafetyScope = scope;
}

/** Gateways qualify ids with routing segments:
 *
 *    google/gemini-3.6-flash
 *    workers-ai/@cf/moonshotai/kimi-k3
 *
 * The vendor picks the upstream, not the reader, so scope matching also compares
 * the segment after the last slash. */
function unqualifiedModelId(base: string): string | null {
  const slash = base.lastIndexOf('/');
  return slash >= 0 ? base.slice(slash + 1) : null;
}

/** Membership test against a caller-selected safety scope. Pure with respect to
 * profile selection, so public library calls can choose a profile without mutating
 * process-global host state or racing another concurrent transform. */
function isAllowedForScope(
  model: string | null | undefined,
  scope: PxpipeSafetyScope,
): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model).toLowerCase();
  if (isMisresolvedModelId(base)) return false;
  const unqualified = unqualifiedModelId(base);
  return allowedModelBasesForScope(scope).some((b) => {
    const target = b.toLowerCase();
    return modelBaseMatches(base, target)
      || (unqualified !== null && modelBaseMatches(unqualified, target));
  });
}

/** Public pure model gate for a specific semantic profile. */
export function isPxpipeSupportedModelForScope(
  model: string | null | undefined,
  scope: PxpipeSafetyScope,
): boolean {
  return isAllowedForScope(model, scope);
}

/** True when pxpipe may transform this Anthropic/Google model under the active host scope. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  return isAllowedForScope(model, activeSafetyScope());
}

/** True when pxpipe may transform this GPT model. Shares the single PXPIPE_MODELS scope. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return isAllowedForScope(model, activeSafetyScope());
}

/** Canonical set of Anthropic Messages routes pxpipe transforms. */
export function isAnthropicMessagesPath(pathname: string): boolean {
  return pathname === '/v1/messages'
    || pathname === '/anthropic/v1/messages'
    || pathname === '/anthropic/messages';
}

export function shouldTransformAnthropicMessages(
  input: PxpipeApplicabilityInput,
): { eligible: boolean; reason: PxpipeApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !isAnthropicMessagesPath(input.path)) {
    return { eligible: false, reason: 'unsupported_path' };
  }
  if (input.bodyBytes !== undefined && input.bodyBytes !== null && input.bodyBytes <= 0) {
    return { eligible: false, reason: 'empty_body' };
  }
  if (!isPxpipeSupportedModel(input.model)) {
    return { eligible: false, reason: 'unsupported_model' };
  }
  return { eligible: true, reason: 'eligible' };
}
