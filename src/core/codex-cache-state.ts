/**
 * Small in-memory cache observation store for the dedicated Codex route.
 *
 * OpenAI prompt caching is automatic and prefix-based. A history transform that
 * rewrites an already-warm prefix can cost far more than the raw text→image
 * delta saves. The transform path therefore needs one fact from the PREVIOUS
 * accepted request in the same Codex conversation: was that request already
 * warm, and which frozen history wire segments did it send?
 *
 * No prompt/tool text is retained here. Keys are the existing sha8 session
 * fingerprint and segment values are sha8 digests of the exact synthetic Responses items.
 */

const MAX_SESSIONS = 512;

export interface CodexCacheHint {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheShare: number;
  readonly compressed: boolean;
  readonly historySegmentShas: readonly string[];
  readonly lastSeenMs: number;
}

export interface CodexCacheOutcome {
  inputTokens?: number;
  cachedTokens?: number;
  compressed: boolean;
  historySegmentShas?: readonly string[];
}

interface RecordState {
  inputTokens: number;
  cachedTokens: number;
  compressed: boolean;
  historySegmentShas: string[];
  lastSeenMs: number;
}

const sessions = new Map<string, RecordState>();

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function touch(key: string, value: RecordState): void {
  sessions.delete(key);
  sessions.set(key, value);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function getCodexCacheHint(sessionKey: string | undefined): CodexCacheHint | undefined {
  if (!sessionKey) return undefined;
  const state = sessions.get(sessionKey);
  if (!state) return undefined;
  touch(sessionKey, state);
  const inputTokens = finiteNonNegative(state.inputTokens);
  const cachedTokens = Math.min(inputTokens, finiteNonNegative(state.cachedTokens));
  return {
    inputTokens,
    cachedTokens,
    cacheShare: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    compressed: state.compressed,
    historySegmentShas: [...state.historySegmentShas],
    lastSeenMs: state.lastSeenMs,
  };
}

/** Record only provider-grounded input usage. A partial/aborted stream without
 * terminal input usage must not overwrite the last trustworthy cache state. */
export function noteCodexCacheOutcome(
  sessionKey: string | undefined,
  outcome: CodexCacheOutcome,
  nowMs: number = Date.now(),
): void {
  if (!sessionKey) return;
  const inputTokens = finiteNonNegative(outcome.inputTokens);
  if (inputTokens <= 0) return;
  const cachedTokens = Math.min(inputTokens, finiteNonNegative(outcome.cachedTokens));
  touch(sessionKey, {
    inputTokens,
    cachedTokens,
    compressed: outcome.compressed,
    historySegmentShas: outcome.compressed ? [...(outcome.historySegmentShas ?? [])] : [],
    lastSeenMs: nowMs,
  });
}

/** Tests only. */
export function clearCodexCacheState(): void {
  sessions.clear();
}
