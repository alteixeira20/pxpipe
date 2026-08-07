import { describe, expect, it } from 'vitest';
import {
  buildPersistentWarpRoutes,
  parsePersistentWarpRouteEnv,
} from '../src/warp/persistent.js';
import { hostCouldMatch, matchRoute, rewriteUrl } from '../src/warp/route.js';

describe('persistent warp routes', () => {
  const routes = buildPersistentWarpRoutes(47821);

  it.each([
    ['api.anthropic.com:443', '/v1/messages', '/providers/anthropic/v1/messages'],
    ['api.openai.com:443', '/v1/chat/completions', '/providers/openai/v1/chat/completions'],
    ['api.openai.com:443', '/v1/responses', '/providers/openai/v1/responses'],
    ['api.featherless.ai:443', '/v1/chat/completions', '/providers/featherless/v1/chat/completions'],
    [
      'generativelanguage.googleapis.com:443',
      '/v1beta/models/gemini-3.6-flash-high:generateContent',
      '/providers/google/v1beta/models/gemini-3.6-flash-high:generateContent',
    ],
    [
      'generativelanguage.googleapis.com:443',
      '/v1/models/gemini-3.6-flash-high:streamGenerateContent',
      '/providers/google/v1/models/gemini-3.6-flash-high:streamGenerateContent',
    ],
    [
      'cloudcode-pa.googleapis.com:443',
      '/v1internal:generateContent',
      '/providers/antigravity-cloudcode/v1internal:generateContent',
    ],
    [
      'daily-cloudcode-pa.googleapis.com:443',
      '/v1internal:streamGenerateContent',
      '/providers/antigravity-daily/v1internal:streamGenerateContent',
    ],
    [
      'daily-cloudcode-pa.sandbox.googleapis.com:443',
      '/v1internal:generateContent',
      '/providers/antigravity-sandbox/v1internal:generateContent',
    ],
  ])('routes %s%s through the matching explicit provider', (host, path, expectedPath) => {
    const route = matchRoute(routes, host, path);
    expect(route).not.toBeNull();
    const rewritten = new URL(rewriteUrl(route!, `${path}?trace=1`));
    expect(rewritten.origin).toBe('http://127.0.0.1:47821');
    expect(rewritten.pathname).toBe(expectedPath);
    expect(rewritten.search).toBe('?trace=1');
  });

  it('does not decrypt unrelated hosts', () => {
    expect(hostCouldMatch(routes, 'example.com:443')).toBe(false);
    expect(hostCouldMatch(routes, 'github.com:443')).toBe(false);
  });

  it('lets an operator route shadow a built-in route without mutating the defaults', () => {
    const custom = buildPersistentWarpRoutes(47821, [
      'api.openai.com/v1/responses*=http://127.0.0.1:9999/custom',
    ]);
    const route = matchRoute(custom, 'api.openai.com:443', '/v1/responses');
    expect(rewriteUrl(route!, '/v1/responses')).toBe(
      'http://127.0.0.1:9999/custom/v1/responses',
    );
  });

  it('parses semicolon/newline-separated persistent route configuration', () => {
    expect(parsePersistentWarpRouteEnv(
      'one.example/v1/*=http://127.0.0.1:1;\n two.example/*=http://127.0.0.1:2\n',
    )).toEqual([
      'one.example/v1/*=http://127.0.0.1:1',
      'two.example/*=http://127.0.0.1:2',
    ]);
  });
});

// Control-plane calls on an intercepted host must still re-origin unchanged.
describe('Antigravity persistent route safety', () => {
  const routes = buildPersistentWarpRoutes(47821);
  it('does not divert Antigravity control-plane endpoints', () => {
    expect(matchRoute(routes, 'cloudcode-pa.googleapis.com:443', '/v1internal:fetchAvailableModels')).toBeNull();
    expect(matchRoute(routes, 'cloudcode-pa.googleapis.com:443', '/v1internal:loadCodeAssist')).toBeNull();
  });
});
