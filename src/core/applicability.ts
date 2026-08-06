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

/** Bracketed variant tags (e.g. `[1m]`) stripped before model matching so base and variant gate identically. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Dashboard runtime override; null = fall back to PXPIPE_MODELS env / built-in default. In-memory only. */
let runtimeModelBases: readonly string[] | null = null;

/**
 * Built-in production-safe scope when PXPIPE_MODELS is unset.
 *
 * Reliability policy: only the reader with the strongest end-to-end coding and
 * image-fidelity evidence is transformed by default. Other families remain explicit
 * opt-ins through the dashboard or PXPIPE_MODELS until their provider-specific
 * coding-safe path has an equally strong non-inferiority suite. A weak/unvalidated
 * reader must fail closed to native text rather than silently inherit another model's
 * confidence level.
 */
const DEFAULT_MODEL_BASES = ['claude-fable-5'];

function falsey(v: string): boolean {
  return /^(0|false|no|off|none)$/i.test(v.trim());
}

/** PXPIPE_MODELS env / built-in default, ignoring the runtime override. One CSV
 *  controls every family (Claude + GPT). Resolution (read per-call so scope flips LIVE):
 *  - unset or empty        → built-in production-safe default (Fable 5 only)
 *  - `off`/`0`/`false`/... → compress nothing
 *  - CSV of model bases    → exactly those families (e.g. `claude-fable-5,gpt-5.6-sol`) */
function envOrDefaultBases(): string[] {
  // Edge-safe: `process` is undefined off-Node; `typeof` avoids a ReferenceError.
  const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_MODELS : undefined;
  if (raw === undefined) return [...DEFAULT_MODEL_BASES];
  const trimmed = raw.trim();
  if (!trimmed) return [...DEFAULT_MODEL_BASES];
  if (falsey(trimmed)) return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function allowedModelBases(): string[] {
  if (runtimeModelBases !== null) return [...runtimeModelBases];
  return envOrDefaultBases();
}

/** Current effective allowed-model scope (Claude + GPT). */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** PXPIPE_MODELS env / default scope, independent of runtime override.
 *  Dashboard unions this into its chip set so env-enabled models are always shown as toggles. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the dashboard runtime override. Empty array = compress nothing; null = clear override. Not persisted. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

/** Gateways qualify ids with routing segments:
 *
 *    google/gemini-3.6-flash
 *    workers-ai/@cf/moonshotai/kimi-k3
 *
 *  The vendor picks the upstream, not the reader, so scope matching also
 *  compares the segment after the last slash. Otherwise PXPIPE_MODELS entries
 *  never match behind a gateway. */
function unqualifiedModelId(base: string): string | null {
  const slash = base.lastIndexOf('/');
  return slash >= 0 ? base.slice(slash + 1) : null;
}

/** Membership test against the single allowed scope. Matches exact base or `-suffix`
 *  alias; [variant] tags stripped first. */
function isAllowed(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model).toLowerCase();
  // Never compress an id that would be priced with another provider's formula
  // (e.g. an unmeasured Gemini sibling falling through to the OpenAI fallback).
  // Which ids those are is profile-table knowledge, not a rule maintained here.
  if (isMisresolvedModelId(base)) return false;
  const unqualified = unqualifiedModelId(base);
  return allowedModelBases().some((b) => {
    const target = b.toLowerCase();
    const hit = (id: string): boolean => id === target || id.startsWith(`${target}-`);
    return hit(base) || (unqualified !== null && hit(unqualified));
  });
}

/** True when pxpipe may transform this Anthropic model. */
export function isPxpipeSupportedModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** True when pxpipe may transform this GPT model. Shares the single PXPIPE_MODELS scope. */
export function isPxpipeSupportedGptModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** Canonical set of Anthropic Messages routes pxpipe transforms. Shared with
 *  createProxy (src/core/proxy.ts) so the public applicability helper and the
 *  proxy router can never disagree on which paths are eligible — they did: the
 *  proxy accepts /anthropic/messages, but the helper's old `endsWith` check
 *  rejected it (and would have wrongly accepted /foo/v1/messages). Exact matches
 *  only, so /v1/messages/count_tokens stays unsupported. */
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
