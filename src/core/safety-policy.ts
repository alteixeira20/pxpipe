import type { KeepSharpBlock, TransformOptions } from './transform.js';

export type CompressionProfileName =
  | 'coding-safe'
  | 'balanced'
  | 'aggressive'
  | 'passthrough';

export interface CompressionProfile {
  readonly name: CompressionProfileName;
  readonly description: string;
  readonly transform: Readonly<TransformOptions>;
}

const CODE_FENCE = /```(?:[A-Za-z0-9_+-]+)?\s*[\s\S]*?```/;
const DIFF = /(?:^|\n)(?:diff --git |@@\s+-\d|\+\+\+\s+\S|---\s+\S)/m;
const STACK = /(?:^|\n)\s*(?:at\s+\S+\s*\(|Traceback \(most recent call last\)|Caused by:|panic:)/m;
const COMPILER = /(?:^|\n).*(?:error TS\d+|warning TS\d+|error\[[A-Z]\d+\]|fatal error:|undefined reference|SyntaxError:|TypeError:|AssertionError:)/m;
const TEST_OUTPUT = /(?:^|\n).*(?:FAIL(?:ED)?\b|PASS\b|Tests?:\s+\d+|test result:|\d+\s+failed|\d+\s+passed)/mi;
const PATH_WITH_LINE = /(?:^|\s)(?:\.?\.?\/|\/)[^\s:]+:\d+(?::\d+)?\b/;
const SOURCE_SHAPE = /(?:^|\n)\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|interface\s|type\s|def\s|async\s+def\s|fn\s|package\s|#include\s|public\s+|private\s+|protected\s+)/m;
const STRUCTURED_STATE = /^\s*[\[{][\s\S]*[\]}]\s*$/;
const EXACT_MACHINE_TOKEN = /(?:\b[0-9a-f]{7,40}\b|\b[A-Z][A-Z0-9_]{2,}\b|--[A-Za-z][\w-]*|\b[A-Za-z_][A-Za-z0-9_]*\([^\n]{0,120}\))/;

/**
 * Conservative built-in fidelity classifier for live tool output.
 *
 * A false negative can make an agent re-read a file, mis-copy an identifier, or
 * act on an incomplete diagnostic. A false positive merely leaves some tokens as
 * text. Bias heavily toward text for code, machine state, diagnostics and exact
 * identifiers. The predicate remains public for hosts that deliberately opt into
 * tool-result imaging; the production-safe profiles do not image live tool output.
 */
export function shouldKeepToolResultSharp(block: KeepSharpBlock): boolean {
  const text = block.text;
  if (!text) return false;
  const sample = text.length > 96_000
    ? `${text.slice(0, 64_000)}\n${text.slice(-32_000)}`
    : text;
  return CODE_FENCE.test(sample)
    || DIFF.test(sample)
    || STACK.test(sample)
    || COMPILER.test(sample)
    || TEST_OUTPUT.test(sample)
    || PATH_WITH_LINE.test(sample)
    || SOURCE_SHAPE.test(sample)
    || STRUCTURED_STATE.test(sample.trim())
    || EXACT_MACHINE_TOKEN.test(sample);
}

const HISTORY_ONLY_STATIC_FLOOR = Number.MAX_SAFE_INTEGER;

const PROFILES: Record<CompressionProfileName, CompressionProfile> = {
  'coding-safe': {
    name: 'coding-safe',
    description: 'native authority/tool state; image only sufficiently old closed history',
    transform: {
      compress: true,
      compressTools: false,
      compressToolResults: false,
      // Anthropic treats an oversized static threshold as history-only mode:
      // system/tool authority remains in its original text role while the closed
      // archival conversation prefix can still clear its independent history gate.
      minCompressChars: HISTORY_ONLY_STATIC_FLOOR,
      collapseHistory: true,
      historyAmortizationHorizon: 4,
      reflow: true,
      gptHistory: {
        keepTail: 12,
        keepRecentPairs: 12,
        minCollapsePrefix: 16,
        minCollapseTokens: 4_000,
      },
      keepSharp: shouldKeepToolResultSharp,
    },
  },
  balanced: {
    name: 'balanced',
    description: 'native authority/tool state with a shorter protected history tail',
    transform: {
      compress: true,
      compressTools: false,
      compressToolResults: false,
      minCompressChars: HISTORY_ONLY_STATIC_FLOOR,
      collapseHistory: true,
      historyAmortizationHorizon: 3,
      reflow: true,
      gptHistory: {
        keepTail: 8,
        keepRecentPairs: 8,
        minCollapsePrefix: 12,
        minCollapseTokens: 3_000,
      },
      keepSharp: shouldKeepToolResultSharp,
    },
  },
  aggressive: {
    name: 'aggressive',
    description: 'legacy lossy maximum-density policy; controlled A/B use only',
    transform: {
      compress: true,
      compressTools: true,
      compressToolResults: true,
      minCompressChars: 2_000,
      minToolResultChars: 6_000,
      maxImagesPerToolResult: 10,
      charsPerToken: 4,
      historyAmortizationHorizon: 1,
      collapseHistory: true,
      reflow: true,
      keepSharp: () => false,
      emitRecoverable: false,
    },
  },
  passthrough: {
    name: 'passthrough',
    description: 'byte-preserving proxy; no context compression',
    transform: { compress: false },
  },
};

function normalizeProfileName(raw: string | undefined): CompressionProfileName {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'safe' || value === 'coding' || value === 'coding-safe') {
    return 'coding-safe';
  }
  if (value === 'balanced') return 'balanced';
  if (value === 'aggressive' || value === 'legacy') return 'aggressive';
  if (value === 'off' || value === 'disabled' || value === 'passthrough') return 'passthrough';
  throw new Error(
    `invalid PXPIPE_PROFILE '${raw}'; expected coding-safe, balanced, aggressive or passthrough`,
  );
}

export function resolveCompressionProfile(raw?: string): CompressionProfile {
  return PROFILES[normalizeProfileName(raw)];
}

/** Merge caller overrides without allowing a custom keepSharp callback to weaken
 * a profile's built-in fidelity guard. Either predicate may keep a block native. */
export function mergeCompressionProfileOptions(
  profile: CompressionProfile,
  overrides: TransformOptions = {},
): TransformOptions {
  const baseKeep = profile.transform.keepSharp;
  const callerKeep = overrides.keepSharp;
  const keepSharp = baseKeep && callerKeep
    ? (block: KeepSharpBlock) => {
        let base = false;
        let caller = false;
        try { base = baseKeep(block) === true; } catch { /* defensive */ }
        try { caller = callerKeep(block) === true; } catch { /* defensive */ }
        return base || caller;
      }
    : callerKeep ?? baseKeep;
  return {
    ...profile.transform,
    ...overrides,
    ...(keepSharp ? { keepSharp } : {}),
  };
}
