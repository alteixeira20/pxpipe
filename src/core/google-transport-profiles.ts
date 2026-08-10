import { isGeminiModel, resolveGeminiProfile } from './gemini-model-profiles.js';
import { isClaudeModel, resolveClaudeProfile } from './claude-model-profiles.js';
import type { GptModelProfile } from './gpt-model-profiles.js';
import { visionTokens } from './vision-cost.js';

/**
 * Resolve the model profile for a serving model arriving through Google/AGY
 * transport.
 *
 * AGY is a transport, not a model family. The serving model determines the
 * vision cost, rendering geometry, and profitability calculation:
 *
 *   transport = antigravity/google-internal
 *   modelProfile = selected serving model's profile
 *
 * Returns `null` when no validated profile covers the model, which signals the
 * caller to fail closed (passthrough) rather than guess economics.
 */
export function resolveGoogleTransportProfile(
  model: string | null | undefined,
): GptModelProfile | null {
  if (isGeminiModel(model)) return resolveGeminiProfile();
  if (isClaudeModel(model ?? '')) return resolveClaudeProfile((model ?? '').toLowerCase());
  return null;
}

/**
 * Vision token cost for a model served through Google/AGY transport.
 * Uses the serving model's economics, not the transport's.
 */
export function googleTransportVisionTokens(
  model: string,
  w: number,
  h: number,
): number {
  const profile = resolveGoogleTransportProfile(model);
  if (!profile || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Unsupported Google-transport image-token estimate: ${model} ${w}x${h}`);
  }
  return visionTokens(profile, w, h);
}
