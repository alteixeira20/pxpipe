/**
 * `pxpipe claude` — launch Claude Code through the PXPipe already running.
 *
 * The bare `pxpipe` word starts the persistent listener. Typing `pxpipe claude`
 * used to fall through to exactly that, so with `pxpipe.service` already owning
 * 127.0.0.1:47821 the launch died on EADDRINUSE before Claude ever started.
 * Nothing about that was a Claude problem: the wrapper simply had no subcommand
 * and bound a port that was already taken.
 *
 * The fix mirrors `pxpipe codex`: resolve the listener that is ALREADY there and
 * route the child into it. Claude Code has no base-URL override that survives
 * its first-party checks, so the routing hop is `pxpipe warp`, which decrypts
 * only `api.anthropic.com/v1/messages` behind a CONNECT proxy on a
 * kernel-assigned port. Two things follow, and both are the point:
 *
 *  - no second persistent listener is created, and no fixed port is bound;
 *  - trust is scoped to the child process (warp exports its CA path in the
 *    child's environment only), so nothing is installed system-wide.
 *
 * CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY and the OAuth credential store are left
 * exactly as the user has them: warp only removes ANTHROPIC_BASE_URL and
 * ANTHROPIC_UNIX_SOCKET, both of which would defeat the diversion.
 */

/** The port the persistent PXPipe listener serves on. */
export const DEFAULT_CLAUDE_PORT = 47821;

export interface ClaudeInvocation {
  /** Executable to run: `claude` by default, or an alternate build. */
  binary: string;
  /** Skip PXPipe entirely and run Claude Code untouched. */
  direct: boolean;
  /** Everything forwarded to Claude Code verbatim. */
  args: string[];
}

/**
 * `pxpipe claude [--binary NAME] [--direct] [--] [claude args...]`
 *
 * Same grammar as `pxpipe codex`: PXPipe flags are recognised only in the
 * leading position and `--` ends them explicitly, so a Claude flag of the same
 * spelling still reaches Claude.
 */
export function parseClaudeInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ClaudeInvocation {
  const rest = argv[0] === 'claude' ? argv.slice(1) : [...argv];
  let binary = env.PXPIPE_CLAUDE_BINARY?.trim() || 'claude';
  let direct = false;
  let index = 0;

  for (; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--binary') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--binary requires an executable name or path');
      }
      binary = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--binary=')) {
      binary = arg.slice('--binary='.length);
      if (!binary) throw new Error('--binary requires an executable name or path');
      continue;
    }
    if (arg === '--direct') {
      direct = true;
      continue;
    }
    break;
  }

  return { binary, direct, args: rest.slice(index) };
}

export function resolveClaudePort(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.PORT ?? DEFAULT_CLAUDE_PORT);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CLAUDE_PORT;
}

/**
 * Is the persistent listener up on this port?
 *
 * Nothing is ever bound here — reusing the running service is the whole point,
 * and binding would reproduce the EADDRINUSE this subcommand exists to fix. A
 * negative answer means "run Claude Code without routing", never "fail the
 * launch": compression is an optimisation, not a prerequisite for coding.
 */
export async function persistentListenerReachable(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/proxy-stats`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
