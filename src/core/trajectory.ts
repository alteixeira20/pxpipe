const MAX_SESSIONS = 128;
const MAX_TOOL_IDS_PER_SESSION = 4_096;
const MAX_FINGERPRINTS_PER_SESSION = 2_048;
const REPEAT_BREAKER_THRESHOLD = 3;

interface ToolUseBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface ToolResultBlock {
  type?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface RequestLike {
  model?: unknown;
  messages?: unknown;
}

interface SessionState {
  seenToolUseIds: Set<string>;
  readFingerprints: Map<string, number>;
  seenToolResultIds: Set<string>;
  toolResultHashes: Set<string>;
  hadCompression: boolean;
  repeatedReadsAfterCompression: number;
  breakerActive: boolean;
  touchedAt: number;
}

export interface TrajectoryObservation {
  /** Non-reversible SHA-256 prefix derived from model + first user turn. */
  sessionSha8: string;
  /** Newly observed tool_use ids on this request, excluding history already seen. */
  newToolCalls: number;
  /** Newly observed Read/Grep/Glob/search-like calls. */
  newReadLikeCalls: number;
  /** New read-like calls whose exact tool name + canonical input was seen earlier. */
  repeatedReadLikeCalls: number;
  /** New tool results whose exact content hash was already seen under another result id. */
  repeatedToolResults: number;
  /** Whether PXPipe has already rendered context in this session. */
  compressionExposed: boolean;
  /** True when this observation crossed the repeat-retrieval threshold. */
  breakerTriggered: boolean;
  /** Sticky session-local circuit breaker; hosts should pass the request through as text. */
  breakerActive: boolean;
}

const sessions = new Map<string, SessionState>();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

async function sha256Prefix(value: string, length = 16): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return canonicalJson(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'image') parts.push('[image]');
    else parts.push(canonicalJson(item));
  }
  return parts.join('\n');
}

function firstUserMaterial(messages: readonly MessageLike[]): string {
  const first = messages.find((message) => message?.role === 'user');
  return first ? contentText(first.content) : '';
}

function isReadLikeTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const segments = normalized.split('_').filter(Boolean);
  return segments.some((segment) => [
    'read', 'grep', 'glob', 'search', 'find', 'list', 'ls', 'cat', 'view',
  ].includes(segment));
}

function trimSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const first = set.values().next().value as string | undefined;
    if (first === undefined) break;
    set.delete(first);
  }
}

function trimMap(map: Map<string, number>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value as string | undefined;
    if (first === undefined) break;
    map.delete(first);
  }
}

function touchSession(key: string, state: SessionState): void {
  state.touchedAt = Date.now();
  sessions.delete(key);
  sessions.set(key, state);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function getSession(key: string): SessionState {
  const existing = sessions.get(key);
  if (existing) {
    touchSession(key, existing);
    return existing;
  }
  const state: SessionState = {
    seenToolUseIds: new Set(),
    readFingerprints: new Map(),
    seenToolResultIds: new Set(),
    toolResultHashes: new Set(),
    hadCompression: false,
    repeatedReadsAfterCompression: 0,
    breakerActive: false,
    touchedAt: Date.now(),
  };
  touchSession(key, state);
  return state;
}

/**
 * Observe an Anthropic Messages-shaped request without persisting any prompt,
 * tool input, path or tool-result content. State is process-local and bounded.
 *
 * The same historical tool calls are resent on every API turn. Stable tool_use
 * ids let PXPipe count only newly observed actions rather than charging the full
 * transcript again. An exact repeated read/search fingerprint after PXPipe has
 * actually rendered context is treated as a possible rediscovery loop. Three
 * such repeats open a sticky session-local pass-through circuit breaker.
 */
export async function observeAnthropicTrajectory(
  body: Uint8Array,
  explicitModel?: string | null,
): Promise<TrajectoryObservation | undefined> {
  let parsed: RequestLike;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as RequestLike;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.messages)) return undefined;
  const messages = parsed.messages.filter(
    (value): value is MessageLike => Boolean(value && typeof value === 'object'),
  );
  const model = typeof explicitModel === 'string'
    ? explicitModel
    : typeof parsed.model === 'string'
      ? parsed.model
      : '';
  const sessionSha8 = await sha256Prefix(`${model}\n${firstUserMaterial(messages)}`, 8);
  const state = getSession(sessionSha8);
  let newToolCalls = 0;
  let newReadLikeCalls = 0;
  let repeatedReadLikeCalls = 0;
  let repeatedToolResults = 0;
  let breakerTriggered = false;

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as ToolUseBlock & ToolResultBlock;
      if (
        block.type === 'tool_use'
        && typeof block.id === 'string'
        && typeof block.name === 'string'
        && !state.seenToolUseIds.has(block.id)
      ) {
        state.seenToolUseIds.add(block.id);
        trimSet(state.seenToolUseIds, MAX_TOOL_IDS_PER_SESSION);
        newToolCalls += 1;
        if (isReadLikeTool(block.name)) {
          newReadLikeCalls += 1;
          const fingerprint = await sha256Prefix(
            `${block.name.toLowerCase()}\n${canonicalJson(block.input)}`,
          );
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

      if (
        block.type === 'tool_result'
        && typeof block.tool_use_id === 'string'
        && !state.seenToolResultIds.has(block.tool_use_id)
      ) {
        state.seenToolResultIds.add(block.tool_use_id);
        trimSet(state.seenToolResultIds, MAX_TOOL_IDS_PER_SESSION);
        const resultHash = await sha256Prefix(contentText(block.content));
        if (state.toolResultHashes.has(resultHash)) repeatedToolResults += 1;
        state.toolResultHashes.add(resultHash);
        trimSet(state.toolResultHashes, MAX_FINGERPRINTS_PER_SESSION);
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

/** Record whether the just-completed request actually placed rendered images on
 * the wire. Merely running through PXPipe is not enough to arm the repeat-read
 * breaker: it reacts only after the session has been exposed to a modality change. */
export function noteTrajectoryCompression(sessionSha8: string, rendered: boolean): void {
  const state = sessions.get(sessionSha8);
  if (!state) return;
  if (rendered) state.hadCompression = true;
  touchSession(sessionSha8, state);
}

export function clearTrajectoryState(): void {
  sessions.clear();
}

export const trajectoryLimits = Object.freeze({
  maxSessions: MAX_SESSIONS,
  maxToolIdsPerSession: MAX_TOOL_IDS_PER_SESSION,
  maxFingerprintsPerSession: MAX_FINGERPRINTS_PER_SESSION,
  repeatBreakerThreshold: REPEAT_BREAKER_THRESHOLD,
});
