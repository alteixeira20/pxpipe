import { describe, expect, it } from 'vitest';

import {
  buildAgyEnvironment,
  classifyAgyFailure,
  inspectAgyHelp,
  isAgyCommand,
  isAgyWarpInvocation,
  parseAgyWarpInvocation,
  safeAgyCommandLabel,
} from '../src/agy.js';

describe('AGY command detection and forwarding', () => {
  it.each(['agy', '/usr/local/bin/agy', '/home/user/.local/bin/agy'])(
    'recognizes %s as AGY',
    (command) => expect(isAgyCommand(command)).toBe(true),
  );

  it('recognizes an AGY warp invocation without touching AGY arguments', () => {
    const argv = [
      'warp',
      '--route',
      'example.test/v1/*=http://127.0.0.1:47821',
      '--',
      'agy',
      '--print',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      'Reply with OK',
    ];

    expect(isAgyWarpInvocation(argv)).toBe(true);
    expect(parseAgyWarpInvocation(argv)).toEqual({
      routes: ['example.test/v1/*=http://127.0.0.1:47821'],
      args: [
        '--print',
        '--output-format',
        'json',
        '--json-schema',
        '{"type":"object"}',
        'Reply with OK',
      ],
    });
  });

  it('supports inline route syntax and preserves continuation/sandbox flags', () => {
    const parsed = parseAgyWarpInvocation([
      'warp',
      '--route=provider.test/*=http://127.0.0.1:47821',
      '--',
      '/opt/agy',
      '--continue',
      '--conversation',
      'conv-123',
      '--sandbox',
      'workspace-write',
    ]);

    expect(parsed.routes).toEqual(['provider.test/*=http://127.0.0.1:47821']);
    expect(parsed.args).toEqual([
      '--continue',
      '--conversation',
      'conv-123',
      '--sandbox',
      'workspace-write',
    ]);
  });
});

describe('AGY child environment', () => {
  it('removes incompatible provider endpoints but preserves AGY state', () => {
    const result = buildAgyEnvironment({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'http://wrong-anthropic.test',
      ANTHROPIC_UNIX_SOCKET: '/tmp/anthropic.sock',
      OPENAI_BASE_URL: 'http://wrong-openai.test',
      GEMINI_API_BASE_URL: 'http://wrong-gemini.test',
      GOOGLE_GENERATIVE_AI_BASE_URL: 'http://wrong-google.test',
      GOOGLE_APPLICATION_CREDENTIALS: '/safe/auth.json',
      AGY_PROJECT: 'project-a',
      AGY_MODEL: 'model-a',
      AGY_PLUGIN_DIR: '/plugins',
      AGY_REMOTE_CONTROL: '1',
    });

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_UNIX_SOCKET).toBeUndefined();
    expect(result.OPENAI_BASE_URL).toBeUndefined();
    expect(result.GEMINI_API_BASE_URL).toBeUndefined();
    expect(result.GOOGLE_GENERATIVE_AI_BASE_URL).toBeUndefined();
    expect(result.GOOGLE_APPLICATION_CREDENTIALS).toBe('/safe/auth.json');
    expect(result.AGY_PROJECT).toBe('project-a');
    expect(result.AGY_MODEL).toBe('model-a');
    expect(result.AGY_PLUGIN_DIR).toBe('/plugins');
    expect(result.AGY_REMOTE_CONTROL).toBe('1');
  });

  it('adds only child-scoped proxy and CA variables when routing is active', () => {
    const result = buildAgyEnvironment(
      { PATH: '/usr/bin', HTTPS_PROXY: 'http://old-proxy.test' },
      'http://127.0.0.1:43001',
      '/home/user/.pxpipe/warp-ca.pem',
    );

    expect(result.HTTP_PROXY).toBe('http://127.0.0.1:43001');
    expect(result.http_proxy).toBe('http://127.0.0.1:43001');
    expect(result.HTTPS_PROXY).toBe('http://127.0.0.1:43001');
    expect(result.https_proxy).toBe('http://127.0.0.1:43001');
    expect(result.NODE_EXTRA_CA_CERTS).toBe('/home/user/.pxpipe/warp-ca.pem');
    expect(result.SSL_CERT_FILE).toBe('/home/user/.pxpipe/warp-ca.pem');
    expect(result.CURL_CA_BUNDLE).toBe('/home/user/.pxpipe/warp-ca.pem');
    expect(result.REQUESTS_CA_BUNDLE).toBe('/home/user/.pxpipe/warp-ca.pem');
  });
});

describe('AGY safe diagnostics', () => {
  it('never includes prompt or JSON schema values in a command label', () => {
    const label = safeAgyCommandLabel([
      '--print',
      '--json-schema',
      '{"secret":"do-not-log"}',
      'private prompt',
    ]);

    expect(label).toContain('--print');
    expect(label).toContain('--json-schema');
    expect(label).not.toContain('do-not-log');
    expect(label).not.toContain('private prompt');
  });

  it('detects the requested structured and execution controls from help text', () => {
    const capabilities = inspectAgyHelp(`
      --print
      --output-format text|json|stream-json
      --json-schema SCHEMA
      --model MODEL
      --effort LEVEL
      --continue
      --conversation ID
      --sandbox MODE
      --permission-mode MODE
    `);

    expect(capabilities).toEqual({
      print: true,
      outputJson: true,
      outputStreamJson: true,
      jsonSchema: true,
      model: true,
      effort: true,
      continuation: true,
      conversation: true,
      sandbox: true,
      permissionMode: true,
    });
  });
});

describe('AGY failure classification', () => {
  it('classifies a machine-readable quota envelope and extracts reset duration', () => {
    const failure = classifyAgyFailure({
      stdout: JSON.stringify({
        status: 'ERROR',
        error: 'Individual quota reached. Try again in 12 minutes.',
        usage: { total_tokens: 0 },
      }),
      stderr: '',
      exitCode: 1,
      structuredExpected: true,
    });

    expect(failure).toEqual({
      kind: 'quota_exhausted',
      resetAfterSeconds: 720,
      safeMessage: 'AGY quota is exhausted.',
    });
  });

  it.each([
    ['not_authenticated', 'Authentication required. Please sign in.'],
    ['rate_limited', 'HTTP 429: too many requests'],
    ['model_unavailable', 'Selected model is unavailable'],
    ['permission_denied', 'Permission denied by sandbox'],
    ['timeout', 'Deadline exceeded'],
    ['transport_failure', 'TLS certificate transport error'],
  ] as const)('classifies %s', (kind, message) => {
    const failure = classifyAgyFailure({
      stdout: JSON.stringify({ status: 'ERROR', error: message }),
      stderr: '',
      exitCode: 1,
      structuredExpected: true,
    });
    expect(failure?.kind).toBe(kind);
  });

  it('classifies malformed structured output without rewriting it', () => {
    const raw = 'not valid JSON';
    const failure = classifyAgyFailure({
      stdout: raw,
      stderr: '',
      exitCode: 1,
      structuredExpected: true,
    });
    expect(failure?.kind).toBe('malformed_structured_output');
    expect(raw).toBe('not valid JSON');
  });

  it('returns no failure for a successful invocation', () => {
    expect(classifyAgyFailure({
      stdout: '{"status":"SUCCESS"}',
      stderr: '',
      exitCode: 0,
      structuredExpected: true,
    })).toBeNull();
  });
});
