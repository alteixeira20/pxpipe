from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def append_before(path: str, marker: str, block: str) -> None:
    p = Path(path)
    text = p.read_text()
    if marker not in text:
        raise SystemExit(f"marker not found in {path}: {marker!r}")
    p.write_text(text.replace(marker, block + marker, 1))


# ---------------------------------------------------------------------------
# 1) Provider-neutral safe-history tuning, including Google/Antigravity.
# ---------------------------------------------------------------------------
replace(
    "src/core/transform.ts",
    """  /** GPT only: history-collapse tuning overrides (keepTail / collapseChunk / …). */\n  gptHistory?: Partial<GptHistoryOptions>;\n  /** Re-pack image-bound text into a ↵-delimited stream to fill `cols` (~29%→75-80%\n""",
    """  /** GPT only: history-collapse tuning overrides (keepTail / collapseChunk / …). */\n  gptHistory?: Partial<GptHistoryOptions>;\n  /** Google/Antigravity old-history tuning. Safe profiles deliberately keep a\n   *  larger recent tail than the model-level renderer default while allowing\n   *  sufficiently large, closed older history to collapse earlier than the\n   *  historical hard-coded 10-turn floor. */\n  googleHistory?: {\n    keepTail?: number;\n    minCollapseUnits?: number;\n    minCollapseTokens?: number;\n  };\n  /** Re-pack image-bound text into a ↵-delimited stream to fill `cols` (~29%→75-80%\n""",
)
replace(
    "src/core/transform.ts",
    """  collapseHistory: true,\n  gptHistory: {},\n  model: '',\n""",
    """  collapseHistory: true,\n  gptHistory: {},\n  googleHistory: {},\n  model: '',\n""",
)

replace(
    "src/core/safety-policy.ts",
    """      gptHistory: {\n        keepTail: 12,\n        keepRecentPairs: 12,\n        minCollapsePrefix: 16,\n        minCollapseTokens: 4_000,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
    """      gptHistory: {\n        keepTail: 12,\n        keepRecentPairs: 12,\n        minCollapsePrefix: 16,\n        minCollapseTokens: 4_000,\n      },\n      // Google has no Anthropic-style cache marker and uses a different turn\n      // shape. Keep eight recent contents byte-exact, but allow a profitable\n      // closed four-unit archival prefix to collapse once it exceeds 2k tokens.\n      googleHistory: {\n        keepTail: 8,\n        minCollapseUnits: 4,\n        minCollapseTokens: 2_000,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
)
replace(
    "src/core/safety-policy.ts",
    """      gptHistory: {\n        keepTail: 8,\n        keepRecentPairs: 8,\n        minCollapsePrefix: 12,\n        minCollapseTokens: 3_000,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
    """      gptHistory: {\n        keepTail: 8,\n        keepRecentPairs: 8,\n        minCollapsePrefix: 12,\n        minCollapseTokens: 3_000,\n      },\n      googleHistory: {\n        keepTail: 6,\n        minCollapseUnits: 2,\n        minCollapseTokens: 1_500,\n      },\n      keepSharp: shouldKeepToolResultSharp,\n""",
)
replace(
    "src/core/safety-policy.ts",
    """      historyAmortizationHorizon: 1,\n      collapseHistory: true,\n      reflow: true,\n""",
    """      historyAmortizationHorizon: 1,\n      collapseHistory: true,\n      googleHistory: {\n        keepTail: 4,\n        minCollapseUnits: 1,\n        minCollapseTokens: 1_000,\n      },\n      reflow: true,\n""",
)

replace(
    "src/core/google.ts",
    """import { classifyContent, compactSlabWhitespace, type TransformInfo } from './transform.js';\n""",
    """import {\n  classifyContent,\n  compactSlabWhitespace,\n  type TransformInfo,\n  type TransformOptions,\n} from './transform.js';\n""",
)
replace(
    "src/core/google.ts",
    """async function planGoogleHistory(\n  contents: GoogleContent[],\n  modelName: string,\n  reflowEnabled: boolean,\n): Promise<GoogleHistoryPlan | null> {\n  const profile = resolveGeminiProfile();\n  const units = contents.map(googleHistoryUnit);\n  const cutoff = Math.max(0, units.length - profile.history.keepTail);\n""",
    """async function planGoogleHistory(\n  contents: GoogleContent[],\n  modelName: string,\n  reflowEnabled: boolean,\n  tuning: NonNullable<TransformOptions['googleHistory']> = {},\n): Promise<GoogleHistoryPlan | null> {\n  const profile = resolveGeminiProfile();\n  const keepTail = Math.max(0, Math.floor(tuning.keepTail ?? profile.history.keepTail));\n  const minCollapseUnits = Math.max(1, Math.floor(tuning.minCollapseUnits ?? 10));\n  const minCollapseTokens = Math.max(1, Math.floor(\n    tuning.minCollapseTokens ?? profile.history.minCollapseTokens,\n  ));\n  const units = contents.map(googleHistoryUnit);\n  const cutoff = Math.max(0, units.length - keepTail);\n""",
)
replace(
    "src/core/google.ts",
    """  const boundary = googleClosedBoundary(units, start, cutoff);\n  if (boundary < start || boundary + 1 - start < 10) return null;\n  const selected = units.slice(start, boundary + 1);\n  const text = selected.map((unit) => unit.text).filter(Boolean).join('\\n\\n');\n  const baselineTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);\n  if (!text || baselineTokens < profile.history.minCollapseTokens) return null;\n""",
    """  const boundary = googleClosedBoundary(units, start, cutoff);\n  if (boundary < start || boundary + 1 - start < minCollapseUnits) return null;\n  const selected = units.slice(start, boundary + 1);\n  const text = selected.map((unit) => unit.text).filter(Boolean).join('\\n\\n');\n  const baselineTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);\n  if (!text || baselineTokens < minCollapseTokens) return null;\n""",
)
replace(
    "src/core/google.ts",
    """export async function transformGoogleGenerateContent(\n  bodyBytes: Uint8Array,\n  modelName: string,\n  options: {\n    compress?: boolean;\n    compressTools?: boolean;\n    compressToolResults?: boolean;\n    collapseHistory?: boolean;\n    minToolResultChars?: number;\n    maxImagesPerToolResult?: number;\n    cols?: number;\n    reflow?: boolean;\n    /** Same static-context eligibility threshold used by the cross-provider\n     * reliability profiles. coding-safe/balanced set this to MAX_SAFE_INTEGER\n     * so system/developer authority remains native. */\n    minCompressChars?: number;\n    /** Refuse any candidate for which the renderer reports dropped characters. */\n    requireLosslessRender?: boolean;\n  } = {},\n): Promise<{ body: Uint8Array; info: TransformInfo }> {\n""",
    """export async function transformGoogleGenerateContent(\n  bodyBytes: Uint8Array,\n  modelName: string,\n  options: TransformOptions = {},\n): Promise<{ body: Uint8Array; info: TransformInfo }> {\n""",
)
replace(
    "src/core/google.ts",
    """  const plannedHistory = options.collapseHistory === false\n    ? null\n    : await planGoogleHistory(originalContents, modelName, options.reflow !== false);\n""",
    """  const plannedHistory = options.collapseHistory === false\n    ? null\n    : await planGoogleHistory(\n        originalContents,\n        modelName,\n        options.reflow !== false,\n        options.googleHistory,\n      );\n""",
)
replace(
    "src/core/google.ts",
    """  } else if (options.collapseHistory !== false) {\n    info.historyReason = originalContents.length > profile.history.keepTail\n      ? 'not_profitable'\n      : 'no_history';\n  }\n""",
    """  } else if (options.collapseHistory !== false) {\n    const keepTail = Math.max(0, Math.floor(\n      options.googleHistory?.keepTail ?? profile.history.keepTail,\n    ));\n    info.historyReason = originalContents.length > keepTail\n      ? 'not_profitable'\n      : 'no_history';\n  }\n""",
)

# ---------------------------------------------------------------------------
# 2) Google/Antigravity trajectory guard: repeated reads must trip the same
#    safety breaker as Anthropic, and session ids should reach the dashboard.
# ---------------------------------------------------------------------------
replace(
    "src/core/trajectory.ts",
    """interface SessionState {\n  seenToolUseIds: Set<string>;\n  readFingerprints: Map<string, number>;\n  seenToolResultIds: Set<string>;\n  toolResultHashes: Set<string>;\n""",
    """interface SessionState {\n  seenToolUseIds: Set<string>;\n  readFingerprints: Map<string, number>;\n  seenToolResultIds: Set<string>;\n  toolResultHashes: Set<string>;\n  /** Google function calls have no stable tool_use id. Position+payload hashes\n   * distinguish historical replays from newly appended occurrences. */\n  seenGoogleCallOccurrences: Set<string>;\n  seenGoogleResultOccurrences: Set<string>;\n""",
)
replace(
    "src/core/trajectory.ts",
    """    seenToolUseIds: new Set(),\n    readFingerprints: new Map(),\n    seenToolResultIds: new Set(),\n    toolResultHashes: new Set(),\n""",
    """    seenToolUseIds: new Set(),\n    readFingerprints: new Map(),\n    seenToolResultIds: new Set(),\n    toolResultHashes: new Set(),\n    seenGoogleCallOccurrences: new Set(),\n    seenGoogleResultOccurrences: new Set(),\n""",
)

append_before(
    "src/core/trajectory.ts",
    "/** Record whether the just-completed request actually placed rendered images on\n",
    r'''interface GooglePartLike {
  text?: unknown;
  functionCall?: { name?: unknown; args?: unknown };
  functionResponse?: { name?: unknown; response?: unknown };
}

interface GoogleContentLike {
  role?: unknown;
  parts?: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function googleFirstUserMaterial(contents: readonly GoogleContentLike[]): string {
  const first = contents.find((content) => content?.role === 'user');
  if (!first || !Array.isArray(first.parts)) return '';
  return first.parts
    .map((raw) => objectRecord(raw))
    .filter((part): part is Record<string, unknown> => part !== null)
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Observe native Google GenerateContent or AGY/Antigravity nested requests.
 * Google functionCall/functionResponse parts do not carry Anthropic-style stable
 * tool ids, so PXPipe keys each historical occurrence by content/part position
 * plus a payload hash. Replayed history is ignored, while the same Read/Grep
 * input appended at a later position counts as a real repeat.
 */
export async function observeGoogleTrajectory(
  body: Uint8Array,
  explicitModel?: string | null,
  antigravityEnvelope = false,
): Promise<TrajectoryObservation | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  const outer = objectRecord(parsed);
  if (!outer) return undefined;
  const request = antigravityEnvelope ? objectRecord(outer.request) : outer;
  if (!request || !Array.isArray(request.contents)) return undefined;
  const contents = request.contents.filter(
    (value): value is GoogleContentLike => Boolean(value && typeof value === 'object'),
  );
  const model = typeof explicitModel === 'string' && explicitModel
    ? explicitModel
    : typeof outer.model === 'string'
      ? outer.model
      : '';
  const sessionSha8 = await sha256Prefix(`${model}\n${googleFirstUserMaterial(contents)}`, 8);
  const state = getSession(sessionSha8);
  let newToolCalls = 0;
  let newReadLikeCalls = 0;
  let repeatedReadLikeCalls = 0;
  let repeatedToolResults = 0;
  let breakerTriggered = false;

  for (let ci = 0; ci < contents.length; ci++) {
    const content = contents[ci]!;
    if (!Array.isArray(content.parts)) continue;
    for (let pi = 0; pi < content.parts.length; pi++) {
      const part = objectRecord(content.parts[pi]) as GooglePartLike | null;
      if (!part) continue;
      const call = objectRecord(part.functionCall) as { name?: unknown; args?: unknown } | null;
      if (call && typeof call.name === 'string') {
        const payload = `${call.name.toLowerCase()}\n${canonicalJson(call.args)}`;
        const occurrence = await sha256Prefix(`call\n${ci}:${pi}\n${payload}`);
        if (!state.seenGoogleCallOccurrences.has(occurrence)) {
          state.seenGoogleCallOccurrences.add(occurrence);
          trimSet(state.seenGoogleCallOccurrences, MAX_TOOL_IDS_PER_SESSION);
          newToolCalls += 1;
          if (isReadLikeTool(call.name)) {
            newReadLikeCalls += 1;
            const fingerprint = await sha256Prefix(payload);
            const prior = state.readFingerprints.get(fingerprint) ?? 0;
            state.readFingerprints.delete(fingerprint);
            state.readFingerprints.set(fingerprint, prior + 1);
            trimMap(state.readFingerprints, MAX_FINGERPRINTS_PER_SESSION);
            if (prior > 0) {
              repeatedReadLikeCalls += 1;
              if (state.hadCompression) state.repeatedReadsAfterCompression += 1;
            }
          }
        }
      }

      const response = objectRecord(part.functionResponse) as {
        name?: unknown;
        response?: unknown;
      } | null;
      if (response) {
        const payload = canonicalJson(response.response);
        const occurrence = await sha256Prefix(`result\n${ci}:${pi}\n${String(response.name ?? '')}\n${payload}`);
        if (!state.seenGoogleResultOccurrences.has(occurrence)) {
          state.seenGoogleResultOccurrences.add(occurrence);
          trimSet(state.seenGoogleResultOccurrences, MAX_TOOL_IDS_PER_SESSION);
          const resultHash = await sha256Prefix(payload);
          if (state.toolResultHashes.has(resultHash)) repeatedToolResults += 1;
          state.toolResultHashes.add(resultHash);
          trimSet(state.toolResultHashes, MAX_FINGERPRINTS_PER_SESSION);
        }
      }
    }
  }

  if (
    !state.breakerActive
    && state.hadCompression
    && state.repeatedReadsAfterCompression >= REPEAT_BREAKER_THRESHOLD
  ) {
    state.breakerActive = true;
    breakerTriggered = true;
  }
  touchSession(sessionSha8, state);
  return {
    sessionSha8,
    newToolCalls,
    newReadLikeCalls,
    repeatedReadLikeCalls,
    repeatedToolResults,
    compressionExposed: state.hadCompression,
    breakerTriggered,
    breakerActive: state.breakerActive,
  };
}

''',
)

replace(
    "src/core/proxy.ts",
    """import { noteTrajectoryCompression, observeAnthropicTrajectory, type TrajectoryObservation } from './trajectory.js';\n""",
    """import {\n  noteTrajectoryCompression,\n  observeAnthropicTrajectory,\n  observeGoogleTrajectory,\n  type TrajectoryObservation,\n} from './trajectory.js';\n""",
)
replace(
    "src/core/proxy.ts",
    """        if (isMessages) {\n          trajectory = await observeAnthropicTrajectory(bodyIn, requestModel);\n        }\n""",
    """        if (isMessages) {\n          trajectory = await observeAnthropicTrajectory(bodyIn, requestModel);\n        } else if (isGoogle) {\n          trajectory = await observeGoogleTrajectory(\n            bodyIn,\n            requestModel,\n            isAntigravityRoute,\n          );\n        }\n""",
)
replace(
    "src/core/proxy.ts",
    """        if (trajectory) {\n          noteTrajectoryCompression(\n            trajectory.sessionSha8,\n            Boolean(r.info.compressed && (r.info.imageCount ?? 0) > 0),\n          );\n        }\n        if (isGoogle && !isAntigravityRoute && r.info.compressed) {\n""",
    """        if (isGoogle && !isAntigravityRoute && r.info.compressed) {\n""",
)
replace(
    "src/core/proxy.ts",
    """        if (!modelOk) r.info.reason = skipReason ?? 'unsupported_model';\n        if (r.info.compressed) {\n""",
    """        // Arm the repeated-retrieval breaker only after the FINAL body decision.\n        // Public Google can still revert an initially rendered candidate after its\n        // provider countTokens validation; marking compression before that revert\n        // falsely blamed later repeated reads on a modality change the model never saw.\n        if (trajectory) {\n          r.info.firstUserSha8 ??= trajectory.sessionSha8;\n          noteTrajectoryCompression(\n            trajectory.sessionSha8,\n            Boolean(r.info.compressed && (r.info.imageCount ?? 0) > 0),\n          );\n        }\n        if (!modelOk) r.info.reason = skipReason ?? 'unsupported_model';\n        if (r.info.compressed) {\n""",
)

# ---------------------------------------------------------------------------
# 3) AGY discovery: do not treat human headings such as "GPT-OSS" as models.
# ---------------------------------------------------------------------------
replace(
    "src/agy-models.ts",
    """function addModel(unique: Set<string>, candidate: string): void {\n  const normalized = candidate.replace(/[),;]+$/g, '');\n  if (!MODEL_ID.test(normalized)) return;\n  unique.add(normalized);\n}\n\n/**\n * Parse both the historical one-id-per-line format and newer human-formatted\n * tables/bullets. Exact single-token lines retain unknown models; formatted\n""",
    """function addModel(unique: Set<string>, candidate: string): void {\n  const normalized = candidate.replace(/[),;]+$/g, '');\n  if (!MODEL_ID.test(normalized)) return;\n  unique.add(normalized);\n}\n\nfunction plausibleSingleModelId(candidate: string): boolean {\n  if (!MODEL_ID.test(candidate)) return false;\n  // Preserve known family aliases even when they use a `latest` suffix, and\n  // preserve unknown ids that contain normal model-version/namespace signals.\n  // A bare heading such as `GPT-OSS` has none of these and must not become a\n  // selectable phantom model merely because it is a syntactically valid token.\n  return /^(?:claude-|gemini-|gpt[-_]|o\\d)/i.test(candidate)\n    || /[0-9/:.]/.test(candidate);\n}\n\n/**\n * Parse both the historical one-id-per-line format and newer human-formatted\n * tables/bullets. Plausible single-token model ids are retained; formatted\n""",
)
replace(
    "src/agy-models.ts",
    """    if (MODEL_ID.test(line)) {\n      addModel(unique, line);\n""",
    """    if (plausibleSingleModelId(line)) {\n      addModel(unique, line);\n""",
)

# ---------------------------------------------------------------------------
# 4) Dashboard: every transformed/passthrough inference gets inspectable decision
#    telemetry, not only requests that happened to produce a PNG.
# ---------------------------------------------------------------------------
replace(
    "src/dashboard.ts",
    """  img_id?: number;\n  img_ids?: number[];\n}\n""",
    """  img_id?: number;\n  img_ids?: number[];\n  /** Stable in-process request-detail id. Unlike img_id it exists for text-only\n   * decisions, so operators can inspect why a request was not imaged. */\n  detail_id?: number;\n  decision_reason?: string;\n  history_reason?: string;\n  image_count?: number;\n  trajectory_repeated_read_like_calls?: number;\n  trajectory_breaker_active?: boolean;\n}\n""",
)
replace(
    "src/dashboard.ts",
    """  private nextImageId = 1;\n  /** Runtime kill switch for compression. When false, the proxy forwards\n""",
    """  private nextImageId = 1;\n  /** Monotonic id for request-decision details. Separate from image ids so a\n   * text-only request still has a Details view explaining the gate outcome. */\n  private nextDetailId = 1;\n  /** Runtime kill switch for compression. When false, the proxy forwards\n""",
)
replace(
    "src/dashboard.ts",
    """    const u = ev.usage;\n    const info = ev.info;\n    const compressed = info?.compressed === true;\n""",
    """    const u = ev.usage;\n    const info = ev.info;\n    const detailId = info ? this.nextDetailId++ : undefined;\n    const compressed = info?.compressed === true;\n""",
)
replace(
    "src/dashboard.ts",
    """    if (info && haveUsage && imgId !== undefined) {\n      // Key by the request's first image id so the recent table's \"view\" link\n      // (which carries that id) maps straight to this breakdown.\n      this.contextHistory.push({\n        id: imgId,\n""",
    """    if (info && haveUsage && detailId !== undefined) {\n      // Key by a request-detail id rather than an image id: text-only decisions\n      // are just as important to inspect as transformed ones.\n      this.contextHistory.push({\n        id: detailId,\n""",
)
replace(
    "src/dashboard.ts",
    """        compressed,\n        model: ev.model,\n        responsesComposition: info.responsesComposition,\n""",
    """        compressed,\n        model: ev.model,\n        reason: info.reason,\n        historyReason: info.historyReason,\n        trajectoryRepeatedReads: ev.trajectory?.repeatedReadLikeCalls,\n        trajectoryBreakerActive: ev.trajectory?.breakerActive,\n        responsesComposition: info.responsesComposition,\n""",
)
replace(
    "src/dashboard.ts",
    """      img_id: imgId,\n      img_ids: imgIds,\n    };\n""",
    """      img_id: imgId,\n      img_ids: imgIds,\n      detail_id: detailId,\n      decision_reason: info?.reason,\n      history_reason: info?.historyReason,\n      image_count: info?.imageCount,\n      trajectory_repeated_read_like_calls: ev.trajectory?.repeatedReadLikeCalls,\n      trajectory_breaker_active: ev.trajectory?.breakerActive,\n    };\n""",
)

# Replay: allocate a decision id for every persisted inference with transform info,
# including passthrough rows. This preserves inspectability after restart.
replace(
    "src/dashboard.ts",
    """      const imageCount = (t as { image_count?: number }).image_count ?? 0;\n      let imgId: number | undefined;\n      if (compressed && haveUsage && (imageCount > 0 || rawBaseline > 0)) {\n        imgId = this.nextImageId++;\n        this.contextHistory.push({\n          id: imgId,\n""",
    """      const imageCount = (t as { image_count?: number }).image_count ?? 0;\n      let imgId: number | undefined;\n      const detailId = haveUsage ? this.nextDetailId++ : undefined;\n      if (compressed && imageCount > 0) imgId = this.nextImageId++;\n      if (haveUsage && detailId !== undefined) {\n        this.contextHistory.push({\n          id: detailId,\n""",
)
replace(
    "src/dashboard.ts",
    """          compressed,\n          model: t.model,\n          responsesComposition: (t as { responses_composition?: ContextMapData['responsesComposition'] }).responses_composition,\n""",
    """          compressed,\n          model: t.model,\n          reason: (t as { reason?: string }).reason,\n          historyReason: (t as { history_reason?: string }).history_reason,\n          trajectoryRepeatedReads: (t as { trajectory_repeated_read_like_calls?: number }).trajectory_repeated_read_like_calls,\n          trajectoryBreakerActive: (t as { trajectory_breaker_active?: boolean }).trajectory_breaker_active,\n          responsesComposition: (t as { responses_composition?: ContextMapData['responsesComposition'] }).responses_composition,\n""",
)
replace(
    "src/dashboard.ts",
    """        img_id: imgId,\n        img_ids: imgId !== undefined ? [imgId] : undefined,\n      };\n""",
    """        img_id: imgId,\n        img_ids: imgId !== undefined ? [imgId] : undefined,\n        detail_id: detailId,\n        decision_reason: t.reason,\n        history_reason: t.history_reason,\n        image_count: imageCount,\n        trajectory_repeated_read_like_calls: t.trajectory_repeated_read_like_calls,\n        trajectory_breaker_active: t.trajectory_breaker_active,\n      };\n""",
)

replace(
    "src/dashboard/types.ts",
    """  img_id?: number;\n  img_ids?: number[];\n  transformation_state?: string;\n}\n""",
    """  img_id?: number;\n  img_ids?: number[];\n  detail_id?: number;\n  decision_reason?: string;\n  history_reason?: string;\n  image_count?: number;\n  trajectory_repeated_read_like_calls?: number;\n  trajectory_breaker_active?: boolean;\n  transformation_state?: string;\n}\n""",
)

replace(
    "src/dashboard/fragments.ts",
    """  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone\n}\n""",
    """  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone\n  reason?: string;\n  historyReason?: string;\n  trajectoryRepeatedReads?: number;\n  trajectoryBreakerActive?: boolean;\n}\n""",
)

# Make the details panel useful for text-only decisions instead of rejecting them.
replace(
    "src/dashboard/fragments.ts",
    """  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {\n    return `<div class=\"ctxmap\"><div class=\"empty-note\">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;\n  }\n""",
    """  if (!c) {\n    return `<div class=\"ctxmap\"><div class=\"empty-note\">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;\n  }\n""",
)

# Add a clear, user-facing explanation for the common safe-profile outcomes.
insert_marker = "function statusCls(status: number): string {\n"
append_before(
    "src/dashboard/fragments.ts",
    insert_marker,
    r'''function decisionExplanation(reason: string | undefined, historyReason: string | undefined): string {
  const r = reason ?? '';
  if (r === 'compression_disabled') return 'Compression is disabled for this request.';
  if (r === 'unsupported_model') return 'The model is outside the active validated compression scope.';
  if (r === 'render_lossy') return 'The renderer reported character loss, so coding-safe kept the original text.';
  if (r === 'no_static_context') {
    if (historyReason === 'no_history') return 'Fresh request: coding-safe keeps live authority/tool state native and there is no old closed history yet.';
    return 'No eligible static context was present; live working state stayed native.';
  }
  if (r === 'below_threshold') {
    if (historyReason === 'no_history') return 'Fresh request: there is not enough old closed history to image safely yet.';
    return 'Eligible context exists, but it has not crossed the safe compression threshold.';
  }
  if (r.startsWith('not_profitable')) return 'PXPipe estimated that images would not beat the text token cost, so it kept text.';
  if (r === 'count_tokens_failed') return 'Provider validation was unavailable, so PXPipe failed closed to native text.';
  if (historyReason === 'no_history') return 'No old closed history is eligible yet; coding-safe intentionally leaves this request as text.';
  if (historyReason === 'not_profitable') return 'Old history exists, but rendering it would not reduce provider input tokens.';
  return r ? `PXPipe kept text: ${r}.` : 'PXPipe kept this request as native text under the current safety policy.';
}

''',
)
replace(
    "src/dashboard/fragments.ts",
    """  const title = isLatest ? 'Latest request' : 'Selected request';\n\n  // The provider caps a request at 100 image blocks and counts the CLIENT's\n""",
    """  const title = isLatest ? 'Latest request' : 'Selected request';\n  const decisionNote = c.imageCount <= 0\n    ? `<div class=\"decision-note\"><strong>Why no image:</strong> ${escapeHtml(decisionExplanation(c.reason, c.historyReason))}` +\n      (c.trajectoryBreakerActive\n        ? ` <strong>Safety breaker active:</strong> repeated retrievals after earlier compression forced native text.`\n        : (c.trajectoryRepeatedReads ?? 0) > 0\n          ? ` Repeated read/search actions observed this turn: ${c.trajectoryRepeatedReads}.`\n          : '') +\n      `</div>`\n    : '';\n\n  // The provider caps a request at 100 image blocks and counts the CLIENT's\n""",
)
replace(
    "src/dashboard/fragments.ts",
    """    `<div class=\"ctx-headline\"><span class=\"ctx-title\">${title}</span> ${headline}</div>` +\n    `<div class=\"split-note ctx-subnote\">${subnote}</div>` +\n""",
    """    `<div class=\"ctx-headline\"><span class=\"ctx-title\">${title}</span> ${headline}</div>` +\n    `<div class=\"split-note ctx-subnote\">${subnote}</div>` +\n    decisionNote +\n""",
)

replace(
    "src/dashboard/fragments.ts",
    """            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];\n            const viewLink =\n              viewId != null\n                ? `<a class=\"row-view\" href=\"#\" hx-get=\"/fragments/context-map?req=${viewId}\" hx-target=\"#frag-context-map\" hx-swap=\"innerHTML\">Details →</a>`\n                : `<span class=\"muted\">—</span>`;\n""",
    """            const detailId = e.detail_id ?? (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];\n            const viewLink =\n              detailId != null\n                ? `<a class=\"row-view\" href=\"#\" hx-get=\"/fragments/context-map?req=${detailId}\" hx-target=\"#frag-context-map\" hx-swap=\"innerHTML\">Details →</a>`\n                : `<span class=\"muted\">—</span>`;\n""",
)
replace(
    "src/dashboard/fragments.ts",
    """            const imaged = renderTransformationStateBadge(e);\n            return (\n""",
    """            const imaged = renderTransformationStateBadge(e);\n            const decision = !e.compressed\n              ? `<div class=\"decision-mini\">${escapeHtml(decisionExplanation(e.decision_reason, e.history_reason))}</div>`\n              : '';\n            return (\n""",
)
replace(
    "src/dashboard/fragments.ts",
    """              `<td>${imaged}</td>` +\n""",
    """              `<td>${imaged}${decision}</td>` +\n""",
)

# CSS for the two compact decision explanations.
replace(
    "src/dashboard/fragments.ts",
    """  .hint { color: var(--muted); font-size: 11px; }\n""",
    """  .hint { color: var(--muted); font-size: 11px; }\n  .decision-mini { margin-top: 3px; max-width: 260px; color: var(--muted); font-size: 10.5px; line-height: 1.25; }\n  .decision-note { margin: 10px 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--ink-2); font-size: 12px; }\n""",
)

# ---------------------------------------------------------------------------
# 5) Version, supported runtime contract, and docs.
# ---------------------------------------------------------------------------
replace(
    "package.json",
    '  "version": "0.12.0",\n',
    '  "version": "0.13.0",\n',
)
replace(
    "package.json",
    '    "node": ">=18"\n',
    '    "node": ">=20.19.0"\n',
)
replace(
    "README.md",
    """At this milestone the safe model scope is intentionally **`claude-fable-5` only**. Other render profiles still exist, but technical image support is not enough to qualify as a safe coding default.\n""",
    """The validated safe model scope currently includes **`claude-fable-5`** and **Gemini 3.6 Flash** (including AGY/Antigravity `-high`, `-medium`, and `-low` effort aliases). Other render profiles still exist, but technical image support alone is not enough to qualify as a safe coding default.\n\nFor Gemini/AGY, a fresh one-turn request can legitimately produce **no image**: coding-safe keeps system/tool authority native and waits for a sufficiently old, closed conversation prefix. The default Google policy keeps the most recent eight contents byte-exact and can collapse an older closed prefix once at least four units and roughly 2k text tokens are eligible and the image gate is profitable. The dashboard's request **Details** view explains this decision even when no PNG was emitted.\n""",
)
replace(
    "README.md",
    """The dashboard exposes recent requests, measured token accounting, rendered pages, model scope, and a live compression kill switch.\n""",
    """The dashboard exposes recent requests, measured token accounting, rendered pages, model scope, a live compression kill switch, and the exact gate reason for text-only requests. AGY/Antigravity traffic uses the same persistent loopback listener and appears in this telemetry when the daemon is healthy.\n""",
)

Path("docs/RELEASE_0_13.md").write_text("""# PXPipe 0.13 reliability milestone\n\nPXPipe 0.13 moves the fork from request-size optimization toward task-level coding-agent reliability.\n\n## Default safety contract\n\n`coding-safe` keeps system/project authority, tool definitions, live tool results, source code, diffs, diagnostics and the recent conversation tail as native text. Only old closed history is eligible for image compression, and renderer-known character loss fails closed to text.\n\nFor validated Gemini 3.6 Flash / AGY traffic, the recent eight Google contents remain native. A closed older prefix may collapse after four eligible contents and 2,000 estimated text tokens, but only when the provider-specific image-cost gate predicts a win. `balanced` uses six recent contents / two old units / 1,500 tokens. `aggressive` remains explicit A/B-only behavior.\n\n## AGY/Antigravity\n\nAGY uses the persistent PXPipe CONNECT listener when healthy. Only grounded Antigravity inference endpoints are diverted; control-plane traffic tunnels unchanged. The outer Antigravity envelope is preserved and only its nested GenerateContent request is transformed.\n\nGoogle function-call trajectories now participate in the same repeated-read circuit breaker as Anthropic. Historical function calls are deduplicated by position+payload fingerprints without persisting prompts, paths, arguments or tool-result text. Three exact repeated read/search operations after a real image exposure force the rest of that session to native text.\n\n## Explainability\n\nEvery live inference carrying transform metadata now gets a dashboard request-detail id even when no image was emitted. The Details panel explains common outcomes such as fresh/no-history, below threshold, not profitable, unsupported model, renderer loss, provider validation failure, and an active repeated-retrieval breaker.\n\n## Other hardening\n\n- Google trajectory exposure is recorded only after the final body decision, so a public-Google countTokens rollback cannot falsely arm the circuit breaker.\n- Google/AGY trajectory ids feed the existing dashboard session accounting.\n- AGY model discovery rejects heading-only tokens such as `GPT-OSS` while preserving real versioned/namespaced ids.\n- The package runtime contract is Node >=20.19, matching the modern TypeScript/Vitest/Vite toolchain used to build and validate this fork.\n""")

# ---------------------------------------------------------------------------
# 6) Regression tests.
# ---------------------------------------------------------------------------
Path("tests/google-trajectory.test.ts").write_text(r'''import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTrajectoryState,
  noteTrajectoryCompression,
  observeGoogleTrajectory,
} from '../src/core/trajectory.js';

const enc = new TextEncoder();

beforeEach(() => clearTrajectoryState());

function googleBody(readCount: number, antigravity = false): Uint8Array {
  const contents: Array<Record<string, unknown>> = [
    { role: 'user', parts: [{ text: 'Fix the repository carefully.' }] },
  ];
  for (let i = 0; i < readCount; i++) {
    contents.push({
      role: 'model',
      parts: [{ functionCall: { name: 'Read', args: { file_path: '/repo/src/a.ts' } } }],
    });
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: 'Read', response: { content: 'const answer = 42;' } } }],
    });
  }
  const request = { contents };
  return enc.encode(JSON.stringify(
    antigravity
      ? { model: 'gemini-3.6-flash-high', project: 'p', request }
      : request,
  ));
}

describe('Google/Antigravity trajectory guard', () => {
  it('does not recount replayed history, but detects newly appended repeated reads', async () => {
    const first = await observeGoogleTrajectory(
      googleBody(1),
      'gemini-3.6-flash-high',
    );
    expect(first).toMatchObject({
      newToolCalls: 1,
      newReadLikeCalls: 1,
      repeatedReadLikeCalls: 0,
      repeatedToolResults: 0,
      breakerActive: false,
    });
    noteTrajectoryCompression(first!.sessionSha8, true);

    const replay = await observeGoogleTrajectory(
      googleBody(1),
      'gemini-3.6-flash-high',
    );
    expect(replay).toMatchObject({
      newToolCalls: 0,
      newReadLikeCalls: 0,
      repeatedReadLikeCalls: 0,
    });

    const second = await observeGoogleTrajectory(googleBody(2), 'gemini-3.6-flash-high');
    expect(second).toMatchObject({ newReadLikeCalls: 1, repeatedReadLikeCalls: 1, breakerActive: false });
    const third = await observeGoogleTrajectory(googleBody(3), 'gemini-3.6-flash-high');
    expect(third).toMatchObject({ newReadLikeCalls: 1, repeatedReadLikeCalls: 1, breakerActive: false });
    const fourth = await observeGoogleTrajectory(googleBody(4), 'gemini-3.6-flash-high');
    expect(fourth).toMatchObject({
      newReadLikeCalls: 1,
      repeatedReadLikeCalls: 1,
      breakerTriggered: true,
      breakerActive: true,
    });
  });

  it('understands the nested Antigravity request without hashing provider metadata into the task', async () => {
    const a = await observeGoogleTrajectory(
      googleBody(1, true),
      'gemini-3.6-flash-high',
      true,
    );
    expect(a?.newReadLikeCalls).toBe(1);
    noteTrajectoryCompression(a!.sessionSha8, true);
    const b = await observeGoogleTrajectory(
      googleBody(2, true),
      'gemini-3.6-flash-high',
      true,
    );
    expect(b).toMatchObject({ repeatedReadLikeCalls: 1, compressionExposed: true });
  });
});
''')

Path("tests/google-safe-history-policy.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  mergeCompressionProfileOptions,
  resolveCompressionProfile,
} from '../src/core/safety-policy.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function request(turns: number, charsPerTurn: number) {
  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: 'CRITICAL: keep this system authority native. ' + 'RULE '.repeat(3000) }],
    },
    contents: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + String.fromCharCode(65 + (i % 20)).repeat(charsPerTurn) }],
    })),
  };
}

describe('Google coding-safe history policy', () => {
  it('keeps authority + eight recent contents native while imaging a profitable old closed prefix', async () => {
    const original = request(12, 5000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(4);
    expect(out.info.bucketChars?.static_slab ?? 0).toBe(0);
    expect(out.info.bucketChars?.history).toBeGreaterThan(0);
    expect(out.info.imageCount).toBeGreaterThan(0);

    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    const tailTexts = parsed.contents.slice(-8).map((c: any) => c.parts?.[0]?.text);
    expect(tailTexts).toEqual(original.contents.slice(-8).map((c) => c.parts[0]!.text));
  });

  it('does not image a fresh one-turn coding-safe request and explains the lack of old history', async () => {
    const original = request(1, 1000);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(false);
    expect(out.info.historyReason).toBe('no_history');
    expect(dec.decode(out.body)).toBe(JSON.stringify(original));
  });

  it('balanced keeps six recent contents native but can collapse two sufficiently large old units', async () => {
    const original = request(8, 6500);
    const opts = mergeCompressionProfileOptions(resolveCompressionProfile('balanced'));
    const out = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify(original)),
      'gemini-3.6-flash-high',
      opts,
    );
    expect(out.info.compressed).toBe(true);
    expect(out.info.collapsedTurns).toBe(2);
    const parsed = JSON.parse(dec.decode(out.body));
    expect(parsed.systemInstruction).toEqual(original.systemInstruction);
    expect(parsed.contents.slice(-6).map((c: any) => c.parts?.[0]?.text)).toEqual(
      original.contents.slice(-6).map((c) => c.parts[0]!.text),
    );
  });
});
''')

Path("tests/agy-model-heading.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
import { parseAgyModelsOutput } from '../src/agy-models.js';

describe('AGY human model-list headings', () => {
  it('does not turn GPT-OSS family headings into phantom models', () => {
    expect(parseAgyModelsOutput(`
      GPT-OSS
      gpt-oss-120b-medium
      Gemini
      gemini-3.6-flash-high
    `)).toEqual([
      'gpt-oss-120b-medium',
      'gemini-3.6-flash-high',
    ]);
  });

  it('still accepts plausible unknown versioned or namespaced one-token ids', () => {
    expect(parseAgyModelsOutput('vendor/model-v2\ncustom.2026\n')).toEqual([
      'vendor/model-v2',
      'custom.2026',
    ]);
  });
});
''')

Path("tests/dashboard-decision-details.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
import { renderContextMapFragment, renderRecentFragment } from '../src/dashboard/fragments.js';
import type { RecentPayload } from '../src/dashboard/types.js';

function payload(reason = 'below_threshold'): RecentPayload {
  return {
    has_preview: false,
    preview_meta: '',
    recent: [{
      ts: 1,
      method: 'POST',
      path: '/v1internal:streamGenerateContent',
      model: 'gemini-3.6-flash-high',
      status: 200,
      compressed: false,
      transformation_state: 'passthrough',
      detail_id: 77,
      decision_reason: reason,
      history_reason: 'no_history',
      image_count: 0,
    }],
  };
}

describe('dashboard decision explainability', () => {
  it('offers Details for a text-only request and explains fresh coding-safe traffic inline', () => {
    const html = renderRecentFragment(payload());
    expect(html).toContain('context-map?req=77');
    expect(html).toContain('not enough old closed history');
  });

  it('renders a no-image detail panel instead of the generic empty prompt', () => {
    const html = renderContextMapFragment({
      id: 77,
      baselineTokens: 0,
      realInput: 18560,
      baselineInputEff: 18560,
      actualInputEff: 18560,
      haveBaseline: false,
      cacheRead: 0,
      warm: false,
      output: 68,
      imageCount: 0,
      buckets: {},
      imageIds: [],
      compressed: false,
      model: 'gemini-3.6-flash-high',
      reason: 'below_threshold',
      historyReason: 'no_history',
    });
    expect(html).toContain('Why no image');
    expect(html).toContain('not enough old closed history');
    expect(html).toContain('nothing imaged this request');
  });
});
''')

print('0.13 reliability changes materialized')
