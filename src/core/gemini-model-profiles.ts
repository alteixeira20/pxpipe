import {
  MAX_HEIGHT_PX as ANTHROPIC_MAX_HEIGHT_PX,
  ANTHROPIC_SLAB_COLS as ANTHROPIC_STRIP_COLS,
} from './render.js';
import { BASE_PRICING } from './profile-base.js';
import { visionTokens } from './vision-cost.js';
import type { GptModelProfile } from './gpt-model-profiles.js';

/** Dedicated profile for the validated Gemini 3.6 Flash model. The production
 *  1568×728 geometry measured 1,078 image tokens. */
export const GEMINI_3_6_FLASH_PROFILE: GptModelProfile = {
  // Flat per-image charge. Live usage measured the exact production canvas at
  // 1,078 IMAGE tokens; other measured shapes ranged up to 1,113 and Google's
  // Gemini 3 docs publish an approximate 1,120-token default/high image budget,
  // so that documented ceiling prices partial pages and width-shrunk slabs.
  vision: { regime: 'flat', tokens: 1120, exact: { widthPx: 1568, heightPx: 728, tokens: 1078 } },
  // No published cached-input/output ratio has been verified for this model, so
  // it keeps the conservative shared default rather than a guessed discount.
  ...BASE_PRICING,
  stripCols: ANTHROPIC_STRIP_COLS,
  maxHeightPx: ANTHROPIC_MAX_HEIGHT_PX,
  minCompressTokens: 500,
  factSheetFormat: 'full',
  history: {
    maxImages: 32,
    keepTail: 6,
    keepRecentPairs: 6,
    minCollapseTokens: 2000,
    responsesMode: 'pairs',
    framing: 'full',
    factSheetScope: 'per-segment',
  },
  style: {
    font: 'spleen-5x8',
    cellWBonus: 0,
    cellHBonus: 0,
    aa: true,
    grid: false,
    gridCols: 0,
    colorCycle: false,
    markerScale: 1,
    markerRed: false,
    inkDilate: 0,
  },
};

/**
 * AGY/Antigravity exposes Gemini 3.6 Flash effort variants as model ids ending
 * in `-high`, `-medium`, and `-low`. They select serving effort rather than a
 * different image tokenizer/rendering geometry, so they share the measured 3.6
 * Flash profile. Other Gemini generations remain excluded until separately
 * validated.
 */
export function canonicalGeminiModel(model: string | null | undefined): string | null {
  const id = (model ?? '').toLowerCase();
  const unqualified = id.startsWith('google/') ? id.slice('google/'.length) : id;
  if (/^gemini-3\.6-flash(?:-(?:high|medium|low))?$/.test(unqualified)) {
    return 'gemini-3.6-flash';
  }
  return null;
}

export function isGeminiModel(model: string | null | undefined): boolean {
  return canonicalGeminiModel(model) !== null;
}

export function resolveGeminiProfile(): GptModelProfile {
  return GEMINI_3_6_FLASH_PROFILE;
}

/** Gemini image tokens, with an explicit guard: this path is only reachable for
 *  ids pxpipe has actually measured (including AGY effort aliases). The numbers
 *  themselves live in `GEMINI_3_6_FLASH_PROFILE.vision`. */
export function geminiVisionTokens(model: string, w: number, h: number): number {
  if (!isGeminiModel(model) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`Unsupported Gemini image-token estimate: ${model} ${w}x${h}`);
  }
  return visionTokens(GEMINI_3_6_FLASH_PROFILE, w, h);
}
