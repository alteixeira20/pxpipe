/**
 * Verbatim fact-sheet / precision ledger for imaged content.
 *
 * When pxpipe renders a block (system slab, history, tool_result, reminder) to a PNG,
 * the precision-critical, hard-to-OCR strings inside it — file paths (with line numbers),
 * URLs, SHAs/UUIDs, version numbers, CLI flags, key-value / assignment pairs, numbers,
 * snake_case / camelCase / PascalCase identifiers, CONST_IDS, and quoted literals — are
 * exactly what a model is most likely to misread off the image yet most likely to need
 * quoted verbatim. This module extracts those tokens as a precision ledger that rides
 * next to the image as plain text.
 *
 * Deterministic by construction (fixed pattern order, priority tiering, first-use ordering,
 * length-desc/lexical sort) → the emitted text is byte-stable across turns and never busts
 * prompt caching.
 */

/** ReDoS-safe extraction patterns (each global). Ordered most- to least-specific. */
const PATTERNS: readonly RegExp[] = [
  // 1. Path with line number / range (e.g. src/core/render.ts:512, ./test/file.ts:12-30)
  /(?:[\w@~+-]+)?(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}:(?:\d+)(?:[.-]\d+)?\b/g,
  // 2. Semantic uppercase LABEL=value pair (preserve association)
  /\b[A-Z][A-Z0-9_]{1,32}=[^\s)"'<>]+/g,
  // 3. Lower/mixed-case `field=value`
  /\b[A-Za-z][A-Za-z0-9_]{1,32}=[A-Za-z0-9_.:/+-]{1,64}/g,
  // 4. Key-colon-value (e.g. status: 404, model: gemini-3.6-flash-high, port: 47821; excludes http/https)
  /\b(?!https?:)[A-Za-z][A-Za-z0-9_]{1,32}:\s*[A-Za-z0-9_.:/+-]{1,64}/g,
  // 5. URLs
  /\bhttps?:\/\/[^\s)"'<>]+/g,
  // 6. Email address
  /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g,
  // 7. UUID
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // 8. IBAN-like account string & Currency amount
  /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g,
  /(?:[$€£¥]|(?:USD|EUR|GBP|CAD|AUD|CHF|JPY))\d(?:[\d,_]*\d)?(?:\.\d{2})?\b/g,
  // 9. Bounded quoted literals ("value" or 'value')
  /"([A-Za-z0-9_./#@:+\-]{2,64})"/g,
  /'([A-Za-z0-9_./#@:+\-]{2,64})'/g,
  // 10. File paths (without line number) & Dir paths (>=2 segments)
  /(?:[\w@~+-]+)?(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}\b/g,
  /\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g,
  // 11. Git sha / long hex (must contain a digit)
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi,
  // 12. Version string
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g,
  // 13. CLI flag
  /(?:^|[^\w-])(--?[A-Za-z][\w-]+)/g,
  // 14. CONST_IDS / env var names
  /\b[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+\b/g,
  // 15. snake_case identifiers (lower/mixed case with at least one underscore)
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi,
  // 16. camelCase / PascalCase identifiers
  /\b(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+\b/g,
  // 17. Ticket / advisory codes
  /\b(?=[A-Z0-9-]{0,119}\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
  // 18. Large/separated numbers & decimals
  /\b\d[\d,_]{3,}\b/g,
  /\b\d+\.\d+\b/g,
  // 19. Standalone short machine-like numbers (ports, status codes, 1-5 digits)
  /\b\d{1,5}\b/g,
];

const MIN_LEN = 3;
const MAX_LEN = 120;
/** Conservative compile-time hard maximum limit for precision ledger entries. */
export const HARD_MAX_ENTRIES = 256;
/** Default maximum entry budget: highest-priority tokens kept first. */
export const DEFAULT_MAX_ENTRIES = 96;
/** Budget cap: highest-priority tokens kept first. Exported so consumers can report drops. */
export const MAX_TOKENS = DEFAULT_MAX_ENTRIES;
// At most this many URL exemplars: URLs are long, structured, low OCR-risk, and usually
// reconstructable, so they must never crowd out short zero-redundancy tokens.
const MAX_URLS = 8;
const MAX_SEEN = 2048; // defensive bound on distinct tokens entering substring-collapse
const MAX_SCAN = 262_144; // defensive input bound; tool_results are already paged
// Match render DENSE_CONTENT_CHARS_PER_IMAGE without importing render (cycle-free).
const FACTSHEET_PAGE_CHARS = 28_080;
const MAX_CHUNK = 512; // whitespace-free chunks longer than this are blobs (base64, minified) — skip

const SHAPE_PATH_LINE = /^(?:[\w@~+-]+)?(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}:(?:\d+)(?:[.-]\d+)?$/;
const SHAPE_UPPER_ASSIGNMENT = /^[A-Z][A-Z0-9_]{1,32}=\S+$/;
const SHAPE_KEY_VALUE = /^(?!https?:)[A-Za-z][A-Za-z0-9_]{1,32}:\s*\S+$/i;

const SHAPE_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,40}$/i;
const SHAPE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHAPE_TICKET = /^(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const SHAPE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SHAPE_IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/;
const SHAPE_CURRENCY = /^(?:[$€£¥]|(?:USD|EUR|GBP|CAD|AUD|CHF|JPY))\d(?:[\d,_]*\d)?(?:\.\d{2})?$/;
const SHAPE_URL = /^https?:\/\//i;

const SHAPE_QUOTED = /^"[^"\r\n]{2,64}"$|^'[^'\r\n]{2,64}'$/;

const SHAPE_CONST = /^[A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+$/;
const SHAPE_SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/i;
const SHAPE_CAMEL = /^(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+$/;
const SHAPE_FLAG = /^--?[A-Za-z][\w-]+$/;
const SHAPE_VERSION = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?$/;
const SHAPE_LOWER_ASSIGNMENT = /^[a-z][a-z0-9_]{1,32}=\S+$/i;

const SHAPE_NUM = /^\d[\d,_]*$|^\d+\.\d+$/;

/**
 * Budget priority by token SHAPE and relationship.
 * Tiers:
 * 0 = path+line / uppercase assignment / key-value relationships / long camelCase
 * 1 = hashes / UUIDs / ticket codes / URLs / email / iban / currency
 * 2 = quoted literals
 * 3 = identifiers (snake_case, camelCase, CONST_IDS, lower assignments) / versions / flags
 * 4 = standalone short machine-like numbers
 */
function priorityTier(tok: string): 0 | 1 | 2 | 3 | 4 {
  if (
    SHAPE_PATH_LINE.test(tok) ||
    SHAPE_UPPER_ASSIGNMENT.test(tok) ||
    SHAPE_KEY_VALUE.test(tok) ||
    (SHAPE_CAMEL.test(tok) && tok.length >= 8)
  ) {
    return 0;
  }
  if (
    SHAPE_HEX.test(tok) ||
    SHAPE_UUID.test(tok) ||
    SHAPE_TICKET.test(tok) ||
    SHAPE_EMAIL.test(tok) ||
    SHAPE_IBAN.test(tok) ||
    SHAPE_CURRENCY.test(tok) ||
    SHAPE_URL.test(tok)
  ) {
    return 1;
  }
  if (SHAPE_QUOTED.test(tok)) {
    return 2;
  }
  if (
    SHAPE_CONST.test(tok) ||
    SHAPE_SNAKE.test(tok) ||
    SHAPE_CAMEL.test(tok) ||
    SHAPE_FLAG.test(tok) ||
    SHAPE_VERSION.test(tok) ||
    SHAPE_LOWER_ASSIGNMENT.test(tok)
  ) {
    return 3;
  }
  if (SHAPE_NUM.test(tok)) {
    return 4;
  }
  return 3;
}

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token|private[_-]?key|cookie|session[_-]?id|bearer)/i;

/** Returns true if candidate token is a credential, API key, private key, or secret. */
export function isSecretOrCredential(tok: string): boolean {
  if (!tok) return true;

  // Key prefixes for known provider tokens / keys
  if (/^(?:sk-|sk_|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z-_]{35})/i.test(tok)) {
    return true;
  }

  // Bearer tokens or JWTs
  if (/^Bearer\s+/i.test(tok) || /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/.test(tok)) {
    return true;
  }

  // Private key block headers
  if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i.test(tok)) {
    return true;
  }

  // Cookie strings with sensitive names
  if (/^(?:connect\.sid|session|id_token|access_token|refresh_token|auth_token)=/i.test(tok)) {
    return true;
  }

  // Key-value / assignment check where key indicates a secret and value is non-trivial
  const eqIdx = tok.indexOf('=');
  const colonIdx = tok.indexOf(':');
  const sepIdx = eqIdx >= 0 ? eqIdx : colonIdx;
  if (sepIdx > 0) {
    const key = tok.slice(0, sepIdx).trim();
    const val = tok.slice(sepIdx + 1).trim();
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      if (val.length > 3 && !/^(?:\*{3,}|<redacted>|null|undefined|true|false)$/i.test(val)) {
        return true;
      }
    }
  }

  return false;
}

export interface SensitiveSpansResult {
  readonly spans: ReadonlyArray<readonly [number, number]>;
  readonly values: ReadonlySet<string>;
}

const SENSITIVE_SOURCE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z-_]{35})/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g,
  /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bCookie:\s*[^;\r\n]+/gi,
  /\b(?:connect\.sid|session|id_token|access_token|refresh_token|auth_token)=[^\s;\r\n]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
];

export function findSensitiveSpansAndValues(text: string): SensitiveSpansResult {
  const spans: Array<[number, number]> = [];
  const values = new Set<string>();

  if (!text) return { spans, values };

  for (const re of SENSITIVE_SOURCE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (m.index !== undefined) {
        const val = m[0];
        spans.push([m.index, m.index + val.length]);
        values.add(val.toLowerCase());

        const tokenMatch = val.match(/Bearer\s+(\S+)/i);
        if (tokenMatch && tokenMatch[1]) {
          values.add(tokenMatch[1].toLowerCase());
        }
        const cookieMatch = val.match(/=\s*(\S+)/);
        if (cookieMatch && cookieMatch[1]) {
          values.add(cookieMatch[1].toLowerCase());
        }
      }
    }
  }

  const kvRe = /\b([A-Za-z0-9_.-]{1,64})\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|\S+)/g;
  for (const m of text.matchAll(kvRe)) {
    if (m.index !== undefined && m[1] && m[2]) {
      const key = m[1].trim();
      let rawVal = m[2].trim();
      if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
        rawVal = rawVal.slice(1, -1).trim();
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (rawVal.length > 3 && !/^(?:\*{3,}|<redacted>|null|undefined|true|false)$/i.test(rawVal)) {
          spans.push([m.index, m.index + m[0].length]);
          values.add(m[0].toLowerCase());
          values.add(rawVal.toLowerCase());
        }
      }
    }
  }

  return { spans, values };
}

function overlapsAnySpan(start: number, end: number, spans: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (start < s[1] && end > s[0]) {
      return true;
    }
  }
  return false;
}

export type FactSheetFormat = 'full' | 'compact';

/** Options driving factsheet / precision ledger extraction and budget limits. */
export interface FactSheetOptions {
  readonly format?: FactSheetFormat;
  readonly maxTokens?: number;
  readonly maxChars?: number;
  readonly tokenHeadroom?: number;
  readonly charsPerToken?: number;
}

/** Non-identifying telemetry about factsheet extraction. */
export interface FactSheetTelemetry {
  readonly entriesEmitted: number;
  readonly approxTokens: number;
  readonly approxChars: number;
  readonly candidatesDropped: number;
  readonly budgetDynamicallyReduced: boolean;
}

/** Purely merge two FactSheetTelemetry records or initialize from next if current is undefined. */
export function mergeFactSheetTelemetry(
  current: FactSheetTelemetry | undefined,
  next: FactSheetTelemetry,
): FactSheetTelemetry {
  if (!current) return { ...next };
  return {
    entriesEmitted: current.entriesEmitted + next.entriesEmitted,
    approxTokens: current.approxTokens + next.approxTokens,
    approxChars: current.approxChars + next.approxChars,
    candidatesDropped: current.candidatesDropped + next.candidatesDropped,
    budgetDynamicallyReduced: current.budgetDynamicallyReduced || next.budgetDynamicallyReduced,
  };
}

export function recordFactSheetTelemetry(
  target: { factsheetTelemetry?: FactSheetTelemetry },
  telem: FactSheetTelemetry,
): void {
  target.factsheetTelemetry = mergeFactSheetTelemetry(target.factsheetTelemetry, telem);
}

/** A kept fact-sheet token plus how many times it occurs in the scanned text. */
export interface FactSheetEntry {
  readonly token: string;
  readonly count: number;
}

export interface FactSheetResult {
  readonly kept: FactSheetEntry[];
  readonly dropped: number;
  readonly text: string;
  readonly telemetry: FactSheetTelemetry;
}

export interface FactSheetAllPagesResult {
  readonly kept: FactSheetEntry[];
  readonly dropped: number;
  readonly telemetry: FactSheetTelemetry;
}

/**
  Extract precision ledger entries and full telemetry for `text`.
 */
export function extractFactSheetResult(
  text: string,
  options?: FactSheetOptions,
): FactSheetResult {
  if (!text) {
    const emptyTelem: FactSheetTelemetry = {
      entriesEmitted: 0,
      approxTokens: 0,
      approxChars: 0,
      candidatesDropped: 0,
      budgetDynamicallyReduced: false,
    };
    return { kept: [], dropped: 0, text: '', telemetry: emptyTelem };
  }

  const format = typeof options?.format === 'string' ? options.format : 'full';
  const requestedMax = Number.isFinite(options?.maxTokens) && options!.maxTokens! > 0
    ? Math.floor(options!.maxTokens!)
    : DEFAULT_MAX_ENTRIES;
  const hardMax = Math.min(requestedMax, HARD_MAX_ENTRIES);
  const cpt = Number.isFinite(options?.charsPerToken) && options!.charsPerToken! > 0 ? options!.charsPerToken! : 4;

  let maxCharsFromHeadroom = Number.POSITIVE_INFINITY;
  if (options?.maxChars !== undefined && Number.isFinite(options.maxChars)) {
    maxCharsFromHeadroom = Math.max(0, options.maxChars);
  } else if (options?.tokenHeadroom !== undefined && Number.isFinite(options.tokenHeadroom)) {
    const availableNetChars = Math.max(0, Math.floor(options.tokenHeadroom * cpt) - 120);
    maxCharsFromHeadroom = availableNetChars;
  }

  const scan = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const sensitiveInfo = findSensitiveSpansAndValues(scan);
  const counts = new Map<string, number>();
  const firstSeenMap = new Map<string, number>();

  const rawChunks = scan.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i]!;
    if ((c.endsWith(':') || c.endsWith('=')) && i + 1 < rawChunks.length) {
      const nextC = rawChunks[i + 1]!;
      if (nextC.length > 0 && !nextC.endsWith(':') && !nextC.endsWith('=')) {
        chunks.push(`${c} ${nextC}`);
      }
    }
    chunks.push(c);
  }

  let pos = 0;
  for (const chunk of chunks) {
    if (chunk.length < MIN_LEN || chunk.length > MAX_CHUNK) {
      pos += chunk.length + 1;
      continue;
    }
    const spanSeen = new Set<string>();
    for (const re of PATTERNS) {
      for (const m of chunk.matchAll(re)) {
        let tok = (m[1] ?? m[0]).trim().replace(/[.,;:!?]+$/, '');
        if (tok.startsWith(':')) tok = tok.slice(1).trim();
        if (tok.length < MIN_LEN || tok.length > MAX_LEN) continue;

        const absMatchStart = pos + (m.index ?? 0);
        const absMatchEnd = absMatchStart + m[0].length;

        if (overlapsAnySpan(absMatchStart, absMatchEnd, sensitiveInfo.spans)) continue;
        if (sensitiveInfo.values.has(tok.toLowerCase())) continue;
        if (isSecretOrCredential(tok)) continue;

        const key = `${m.index ?? 0}\x00${tok}`;
        if (spanSeen.has(key)) continue;
        spanSeen.add(key);

        if (!counts.has(tok)) {
          firstSeenMap.set(tok, absMatchStart);
        }
        counts.set(tok, (counts.get(tok) ?? 0) + 1);
      }
    }
    pos += chunk.length + 1;
    if (counts.size >= MAX_SEEN) break;
  }

  // Phase 1 — Substring collapse (longest-first): fold isolated constituent tokens
  // into longer preserved relationships (e.g. `404` or `status` into `status: 404`).
  const ordered = [...counts.keys()].sort(
    (a, b) => b.length - a.length || (firstSeenMap.get(a) ?? 0) - (firstSeenMap.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const specific: string[] = [];
  for (const t of ordered) {
    if (!specific.some((k) => k.includes(t))) specific.push(t);
  }

  // Phase 2 — Priority tiering + first-use ordering
  const ranked = specific
    .map((t) => ({
      t,
      tier: priorityTier(t),
      firstSeen: firstSeenMap.get(t) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.firstSeen - b.firstSeen ||
        b.t.length - a.t.length ||
        (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)
    );

  const kept: FactSheetEntry[] = [];
  let currentChars = 0;
  let urls = 0;
  let dynamicallyReduced = false;

  for (const { t, tier } of ranked) {
    if (kept.length >= hardMax) break;
    if (tier === 1 && SHAPE_URL.test(t) && urls >= MAX_URLS) continue;

    const count = counts.get(t) ?? 1;
    const entryStr = count >= 2 ? `${t} ×${count}` : t;
    const addedChars = (kept.length > 0 ? 3 : 0) + entryStr.length;

    if (Number.isFinite(maxCharsFromHeadroom) && currentChars + addedChars > maxCharsFromHeadroom) {
      dynamicallyReduced = true;
      continue;
    }

    if (SHAPE_URL.test(t)) urls++;
    kept.push({ token: t, count });
    currentChars += addedChars;
  }

  const dropped = ranked.length - kept.length;
  const fsText = factSheetTextFromEntries(kept, format);
  const approxTokens = Math.ceil(fsText.length / cpt);

  const telemetry: FactSheetTelemetry = {
    entriesEmitted: kept.length,
    approxTokens,
    approxChars: fsText.length,
    candidatesDropped: dropped,
    budgetDynamicallyReduced: dynamicallyReduced || (Number.isFinite(maxCharsFromHeadroom) && maxCharsFromHeadroom < Number.POSITIVE_INFINITY && dropped > 0),
  };

  return { kept, dropped, text: fsText, telemetry };
}

/** Extract deduped precision-critical tokens from `text`. */
export function extractFactSheetTokens(text: string, options?: FactSheetOptions): string[] {
  return extractFactSheetEntries(text, options).map((e) => e.token);
}

/** Extract deduped precision-critical token+count entries from `text`. */
export function extractFactSheetEntries(
  text: string,
  options?: FactSheetOptions,
): FactSheetEntry[] {
  return extractFactSheetResult(text, options).kept;
}

/** Page-aware variant of `extractFactSheetTokens` for large source texts. */
export function extractFactSheetTokensAllPages(
  text: string,
  charsPerPage: number,
  options?: FactSheetOptions,
): { kept: string[]; dropped: number } {
  const { kept, dropped } = extractFactSheetEntriesAllPages(text, charsPerPage, options);
  return { kept: kept.map((e) => e.token), dropped };
}

/** Entry-carrying variant of `extractFactSheetTokensAllPages`. */
export function extractFactSheetEntriesAllPages(
  text: string,
  charsPerPage: number,
  options?: FactSheetOptions,
): FactSheetAllPagesResult {
  if (!text) {
    const emptyTelem: FactSheetTelemetry = {
      entriesEmitted: 0,
      approxTokens: 0,
      approxChars: 0,
      candidatesDropped: 0,
      budgetDynamicallyReduced: false,
    };
    return { kept: [], dropped: 0, telemetry: emptyTelem };
  }

  const format = typeof options?.format === 'string' ? options.format : 'full';
  const requestedMax = Number.isFinite(options?.maxTokens) && options!.maxTokens! > 0
    ? Math.floor(options!.maxTokens!)
    : DEFAULT_MAX_ENTRIES;
  const hardMax = Math.min(requestedMax, HARD_MAX_ENTRIES);
  const cpt = Number.isFinite(options?.charsPerToken) && options!.charsPerToken! > 0 ? options!.charsPerToken! : 4;

  let maxCharsFromHeadroom = Number.POSITIVE_INFINITY;
  if (options?.maxChars !== undefined && Number.isFinite(options.maxChars)) {
    maxCharsFromHeadroom = Math.max(0, options.maxChars);
  } else if (options?.tokenHeadroom !== undefined && Number.isFinite(options.tokenHeadroom)) {
    const availableNetChars = Math.max(0, Math.floor(options.tokenHeadroom * cpt) - 120);
    maxCharsFromHeadroom = availableNetChars;
  }

  const sensitiveInfo = findSensitiveSpansAndValues(text);
  const counts = new Map<string, number>();
  const firstSeenMap = new Map<string, number>();
  const spanSeen = new Set<string>();
  const all: string[] = [];

  const pageCount = Math.max(1, Math.ceil(text.length / charsPerPage));
  for (let i = 0; i < pageCount; i++) {
    const pageOffset = i * charsPerPage;
    const chunk = text.slice(pageOffset, (i + 1) * charsPerPage);

    const rawSubChunks = chunk.split(/\s+/);
    const subChunks: string[] = [];
    for (let j = 0; j < rawSubChunks.length; j++) {
      const c = rawSubChunks[j]!;
      if ((c.endsWith(':') || c.endsWith('=')) && j + 1 < rawSubChunks.length) {
        const nextC = rawSubChunks[j + 1]!;
        if (nextC.length > 0 && !nextC.endsWith(':') && !nextC.endsWith('=')) {
          subChunks.push(`${c} ${nextC}`);
        }
      }
      subChunks.push(c);
    }

    let pos = pageOffset;
    for (const subChunk of subChunks) {
      if (subChunk.length >= MIN_LEN && subChunk.length <= MAX_CHUNK) {
        for (const re of PATTERNS) {
          for (const m of subChunk.matchAll(re)) {
            let tok = (m[1] ?? m[0]).trim().replace(/[.,;:!?]+$/, '');
            if (tok.startsWith(':')) tok = tok.slice(1).trim();
            if (tok.length < MIN_LEN || tok.length > MAX_LEN) continue;

            const absMatchStart = pos + (m.index ?? 0);
            const absMatchEnd = absMatchStart + m[0].length;

            if (overlapsAnySpan(absMatchStart, absMatchEnd, sensitiveInfo.spans)) continue;
            if (sensitiveInfo.values.has(tok.toLowerCase())) continue;
            if (isSecretOrCredential(tok)) continue;

            const spanKey = `${absMatchStart}:${tok}`;
            if (spanSeen.has(spanKey)) continue;
            spanSeen.add(spanKey);

            if (!counts.has(tok)) {
              all.push(tok);
              firstSeenMap.set(tok, absMatchStart);
            }
            counts.set(tok, (counts.get(tok) ?? 0) + 1);
          }
        }
      }
      pos += subChunk.length + 1;
    }
  }

  // Phase 1 — Substring collapse
  const ordered = [...counts.keys()].sort(
    (a, b) => b.length - a.length || (firstSeenMap.get(a) ?? 0) - (firstSeenMap.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const specific: string[] = [];
  for (const t of ordered) {
    if (!specific.some((k) => k.includes(t))) specific.push(t);
  }

  // Phase 2 — Priority tiering + first-use ordering
  const ranked = specific
    .map((t) => ({
      t,
      tier: priorityTier(t),
      firstSeen: firstSeenMap.get(t) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.firstSeen - b.firstSeen ||
        b.t.length - a.t.length ||
        (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)
    );

  const kept: FactSheetEntry[] = [];
  let currentChars = 0;
  let urls = 0;
  let dynamicallyReduced = false;

  for (const { t, tier } of ranked) {
    if (kept.length >= hardMax) break;
    if (tier === 1 && SHAPE_URL.test(t) && urls >= MAX_URLS) continue;

    const count = counts.get(t) ?? 1;
    const entryStr = count >= 2 ? `${t} ×${count}` : t;
    const addedChars = (kept.length > 0 ? 3 : 0) + entryStr.length;

    if (Number.isFinite(maxCharsFromHeadroom) && currentChars + addedChars > maxCharsFromHeadroom) {
      dynamicallyReduced = true;
      continue;
    }

    if (SHAPE_URL.test(t)) urls++;
    kept.push({ token: t, count });
    currentChars += addedChars;
  }

  const dropped = ranked.length - kept.length;
  const fsText = factSheetTextFromEntries(kept, format);
  const approxTokens = Math.ceil(fsText.length / cpt);

  const telemetry: FactSheetTelemetry = {
    entriesEmitted: kept.length,
    approxTokens,
    approxChars: fsText.length,
    candidatesDropped: dropped,
    budgetDynamicallyReduced: dynamicallyReduced || (Number.isFinite(maxCharsFromHeadroom) && maxCharsFromHeadroom < Number.POSITIVE_INFINITY && dropped > 0),
  };

  return { kept, dropped, telemetry };
}

const OPEN =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image: ';
const OPEN_COUNTS =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image; ×N marks a token that occurs N times within the imaged content: ';
const OPEN_COMPACT = '[Exact rendered identifiers—quote verbatim: ';
const OPEN_COMPACT_COUNTS = '[Exact rendered identifiers—quote verbatim; ×N=count: ';

/** Build the one-line fact-sheet string from a pre-extracted token list. */
export function factSheetTextFromTokens(tokens: string[]): string {
  return tokens.length > 0 ? OPEN + tokens.join(' · ') + ']' : '';
}

/** Build the one-line fact-sheet string from token+count entries. */
export function factSheetTextFromEntries(
  entries: readonly FactSheetEntry[],
  format: FactSheetFormat = 'full',
): string {
  if (entries.length === 0) return '';
  const anyRepeat = entries.some((e) => e.count >= 2);
  const body = entries.map((e) => (e.count >= 2 ? `${e.token} ×${e.count}` : e.token)).join(' · ');
  const opener = format === 'compact'
    ? (anyRepeat ? OPEN_COMPACT_COUNTS : OPEN_COMPACT)
    : (anyRepeat ? OPEN_COUNTS : OPEN);
  return opener + body + ']';
}

/** One-line fact-sheet string for `text`, or `''` when nothing notable was found. */
export function factSheetText(
  text: string,
  formatOrOptions?: FactSheetFormat | FactSheetOptions,
  options?: FactSheetOptions,
): string {
  if (!text) return '';

  let opts: FactSheetOptions = {};
  if (typeof formatOrOptions === 'string') {
    opts = { format: formatOrOptions, ...options };
  } else if (formatOrOptions && typeof formatOrOptions === 'object') {
    opts = formatOrOptions;
  }

  if (text.length <= MAX_SCAN) {
    return extractFactSheetResult(text, opts).text;
  }
  const { kept } = extractFactSheetEntriesAllPages(text, FACTSHEET_PAGE_CHARS, opts);
  return factSheetTextFromEntries(kept, opts.format);
}
