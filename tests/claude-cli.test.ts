import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_PORT,
  parseClaudeInvocation,
  persistentListenerReachable,
  resolveClaudePort,
} from '../src/core/claude-cli.js';

const okResponse = (): Response =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('pxpipe claude invocation parsing', () => {
  it('defaults to the claude executable and forwards nothing extra', () => {
    expect(parseClaudeInvocation([], {})).toEqual({ binary: 'claude', direct: false, args: [] });
  });

  it('tolerates the subcommand word being included', () => {
    expect(parseClaudeInvocation(['claude', '--resume'], {})).toEqual({
      binary: 'claude', direct: false, args: ['--resume'],
    });
  });

  it('accepts an alternate executable in both spellings', () => {
    expect(parseClaudeInvocation(['--binary', 'claude-next'], {}).binary).toBe('claude-next');
    expect(parseClaudeInvocation(['--binary=claude-next'], {}).binary).toBe('claude-next');
  });

  it('reads PXPIPE_CLAUDE_BINARY, and an explicit flag still wins', () => {
    expect(parseClaudeInvocation([], { PXPIPE_CLAUDE_BINARY: 'claude-beta' }).binary)
      .toBe('claude-beta');
    expect(parseClaudeInvocation(['--binary', 'claude'], { PXPIPE_CLAUDE_BINARY: 'claude-beta' }).binary)
      .toBe('claude');
  });

  it('stops consuming PXPipe flags at `--` so identically spelled Claude flags survive', () => {
    expect(parseClaudeInvocation(['--direct', '--', '--binary', 'x'], {})).toEqual({
      binary: 'claude', direct: true, args: ['--binary', 'x'],
    });
  });

  it('stops at the first non-PXPipe argument', () => {
    expect(parseClaudeInvocation(['-p', 'hello', '--direct'], {})).toEqual({
      binary: 'claude', direct: false, args: ['-p', 'hello', '--direct'],
    });
  });

  it('rejects a --binary with no value rather than guessing', () => {
    expect(() => parseClaudeInvocation(['--binary'], {})).toThrow(/--binary requires/);
    expect(() => parseClaudeInvocation(['--binary', '--direct'], {})).toThrow(/--binary requires/);
  });
});

describe('pxpipe claude listener reuse', () => {
  it('targets the persistent listener port, honouring PORT', () => {
    expect(resolveClaudePort({})).toBe(DEFAULT_CLAUDE_PORT);
    expect(resolveClaudePort({ PORT: '9100' })).toBe(9100);
    expect(resolveClaudePort({ PORT: 'nonsense' })).toBe(DEFAULT_CLAUDE_PORT);
  });

  it('probes the running listener without binding anything', async () => {
    const seen: string[] = [];
    const reachable = await persistentListenerReachable(47821, (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return okResponse();
    }) as typeof fetch);
    expect(reachable).toBe(true);
    expect(seen).toEqual(['http://127.0.0.1:47821/proxy-stats']);
  });

  it('reports unreachable instead of throwing when the service is down', async () => {
    const refused = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    await expect(persistentListenerReachable(47821, refused)).resolves.toBe(false);
  });

  it('treats a non-2xx listener as unreachable', async () => {
    const notOk = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(persistentListenerReachable(47821, notOk)).resolves.toBe(false);
  });
});
