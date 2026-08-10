/**
 * Codex model selection helpers.
 *
 * PXPipe installs a custom model_provider for the child process, so readiness
 * reporting must describe the model Codex will actually start with rather than
 * a hard-coded reference model. Keep the parser intentionally narrow: it reads
 * only the top-level/profile `model` values needed for diagnostics and never
 * rewrites Codex configuration.
 */

export type CodexModelSource = 'cli' | 'profile' | 'config' | 'reference';

export interface CodexModelSelection {
  model: string;
  source: CodexModelSource;
  profile?: string;
}

interface ParsedCodexConfig {
  model?: string;
  profile?: string;
  profileModels: Map<string, string>;
}

function assignmentValue(raw: string, key: string): string | undefined {
  const eq = raw.indexOf('=');
  if (eq < 0) return undefined;
  if (raw.slice(0, eq).trim() !== key) return undefined;
  const value = raw.slice(eq + 1).trim();
  if (!value) return undefined;
  return unquoteTomlScalar(value);
}

function unquoteTomlScalar(raw: string): string | undefined {
  const value = stripTomlComment(raw).trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end < 0) return undefined;
    const parsed = value.slice(1, end).trim();
    return parsed || undefined;
  }
  const bare = value.split(/\s+/)[0]?.trim();
  return bare || undefined;
}

function stripTomlComment(raw: string): string {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote === 'double') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === 'single') {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      continue;
    }
    if (ch === '#') return raw.slice(0, i);
  }
  return raw;
}

function configOverride(args: readonly string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-c' || arg === '--config') {
      const next = args[i + 1];
      if (next !== undefined) {
        const value = assignmentValue(next, key);
        if (value !== undefined) return value;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-c=')) {
      const value = assignmentValue(arg.slice(3), key);
      if (value !== undefined) return value;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = assignmentValue(arg.slice('--config='.length), key);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/** Model selected explicitly on the Codex command line/config override. */
export function codexModelFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-m' || arg === '--model') {
      const next = args[i + 1]?.trim();
      if (next) return next;
      continue;
    }
    if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length).trim();
      if (value) return value;
    }
  }
  return configOverride(args, 'model');
}

/** Profile selected explicitly on the Codex command line/config override. */
export function codexProfileFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--profile') {
      const next = args[i + 1]?.trim();
      if (next) return next;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim();
      if (value) return value;
    }
  }
  return configOverride(args, 'profile');
}

/**
 * Read only the model/profile selectors from Codex TOML.
 *
 * Profile sections are deliberately supported because `codex -p NAME` may
 * select a model that differs from the top-level `model`. All unrelated TOML is
 * ignored; malformed values simply make diagnostics fall back to the reference
 * model rather than blocking Codex launch.
 */
function parseCodexConfig(text: string | undefined): ParsedCodexConfig {
  const parsed: ParsedCodexConfig = { profileModels: new Map() };
  if (!text) return parsed;

  let profileSection: string | null = null;
  let inOtherSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1]!.trim();
      const profile = /^profiles\.([A-Za-z0-9_.-]+)$/.exec(name);
      profileSection = profile?.[1] ?? null;
      inOtherSection = profileSection === null;
      continue;
    }

    const model = assignmentValue(line, 'model');
    if (model !== undefined) {
      if (profileSection !== null) parsed.profileModels.set(profileSection, model);
      else if (!inOtherSection) parsed.model = model;
      continue;
    }

    if (!inOtherSection && profileSection === null) {
      const profile = assignmentValue(line, 'profile');
      if (profile !== undefined) parsed.profile = profile;
    }
  }
  return parsed;
}

/**
 * Resolve the model PXPipe should report before launching Codex.
 *
 * Precedence mirrors Codex's user intent: an explicit model wins, then an
 * explicitly/default selected profile, then top-level config, then the supplied
 * reference. The reference is diagnostic only; callers should avoid injecting
 * it back into Codex because the executable's own default can evolve.
 */
export function resolveCodexModelSelection(
  args: readonly string[],
  configText: string | undefined,
  referenceModel: string,
): CodexModelSelection {
  const explicit = codexModelFromArgs(args);
  if (explicit) return { model: explicit, source: 'cli' };

  const config = parseCodexConfig(configText);
  const profile = codexProfileFromArgs(args) ?? config.profile;
  if (profile) {
    const model = config.profileModels.get(profile);
    if (model) return { model, source: 'profile', profile };
  }
  if (config.model) return { model: config.model, source: 'config' };
  return { model: referenceModel, source: 'reference', ...(profile ? { profile } : {}) };
}
