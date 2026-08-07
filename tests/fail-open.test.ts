import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFailOpenProxy,
  isPxpipeTransformFailure,
  mayTransformRequest,
  resolveHostedFeatherlessMode,
} from '../src/core/fail-open.js';

const originalProfile = process.env.PXPIPE_PROFILE;
const originalFeatherlessMode = process.env.PXPIPE_FEATHERLESS_TRANSFORM;

afterEach(() => {
  if (originalProfile === undefined) delete process.env.PXPIPE_PROFILE;
  else process.env.PXPIPE_PROFILE = originalProfile;
  if (originalFeatherlessMode === undefined) delete process.env.PXPIPE_FEATHERLESS_TRANSFORM;
  else process.env.PXPIPE_FEATHERLESS_TRANSFORM = originalFeatherlessMode;
});

describe('transform-only fail-open classifier', () => {
  it('recognizes the exact pre-upstream transform failure response', async () => {
    const response = new Response(JSON.stringify({ error: 'pxpipe transform failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
    expect(await isPxpipeTransformFailure(response)).toBe(true);
  });

  it('does not retry an upstream 502', async () => {
    const response = new Response(JSON.stringify({ error: 'upstream overloaded' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
    expect(await isPxpipeTransformFailure(response)).toBe(false);
  });

  it('does not retry transport or timeout failures with different markers', async () => {
    expect(await isPxpipeTransformFailure(new Response(
      JSON.stringify({ error: 'pxpipe upstream unreachable' }), { status: 502 },
    ))).toBe(false);
    expect(await isPxpipeTransformFailure(new Response(
      JSON.stringify({ error: 'pxpipe upstream timeout' }), { status: 504 },
    ))).toBe(false);
  });

  it('does not treat an embedded marker in an unrelated envelope as retryable', async () => {
    const response = new Response(JSON.stringify({
      error: 'upstream failed',
      detail: 'pxpipe transform failed',
    }), { status: 502 });
    expect(await isPxpipeTransformFailure(response)).toBe(false);
  });
});

describe('hosted Featherless safety mode', () => {
  it('disables implicit Featherless imaging under the default safe profile', () => {
    delete process.env.PXPIPE_PROFILE;
    delete process.env.PXPIPE_FEATHERLESS_TRANSFORM;
    expect(resolveHostedFeatherlessMode({ provider: 'featherless' })).toBe('off');
  });

  it('disables implicit Featherless imaging under balanced and passthrough', () => {
    for (const profile of ['balanced', 'passthrough']) {
      process.env.PXPIPE_PROFILE = profile;
      delete process.env.PXPIPE_FEATHERLESS_TRANSFORM;
      expect(resolveHostedFeatherlessMode({ provider: 'featherless' })).toBe('off');
    }
  });

  it('honors the legacy Featherless env mode only under explicit aggressive profile', () => {
    process.env.PXPIPE_PROFILE = 'aggressive';
    process.env.PXPIPE_FEATHERLESS_TRANSFORM = 'force';
    expect(resolveHostedFeatherlessMode({ provider: 'featherless' })).toBe('force');
  });

  it('lets an explicit ProxyConfig mode override host-profile inference', () => {
    process.env.PXPIPE_PROFILE = 'coding-safe';
    expect(resolveHostedFeatherlessMode({
      provider: 'featherless',
      featherlessTransformMode: 'force',
    })).toBe('force');
  });
});

describe('fail-open retry body cloning scope', () => {
  it.each([
    ['https://local/v1/messages'],
    ['https://local/anthropic/messages'],
    ['https://local/v1/chat/completions'],
    ['https://local/v1/responses'],
    ['https://local/v1beta/models/gemini-3.6-flash:generateContent'],
    ['https://local/v1beta/models/gemini-3.6-flash:streamGenerateContent'],
  ])('recognizes a transformable POST route: %s', (url) => {
    expect(mayTransformRequest(new Request(url, { method: 'POST' }))).toBe(true);
  });

  it.each([
    ['GET', 'https://local/v1/messages'],
    ['POST', 'https://local/v1/audio/transcriptions'],
    ['POST', 'https://local/files'],
    ['POST', 'https://local/v1/models'],
  ])('does not clone passthrough traffic: %s %s', (method, url) => {
    expect(mayTransformRequest(new Request(url, { method }))).toBe(false);
  });
});

describe('fail-open integration', () => {
  it('retries once as native text when transform setup throws before upstream', async () => {
    // The coding-safe profile intentionally skips this tiny request because it
    // has no archival history. Fault injection therefore uses explicit
    // aggressive mode so the custom transformer is actually invoked.
    process.env.PXPIPE_PROFILE = 'aggressive';
    const inferenceUrls: string[] = [];
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 10 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      inferenceUrls.push(url);
      return new Response(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const observed = vi.fn();
    const handle = createFailOpenProxy({
      customFetch: upstreamFetch as typeof fetch,
      transform: () => {
        throw new Error('renderer exploded');
      },
      onRequest: observed,
    });
    const request = new Request('http://127.0.0.1:47821/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const response = await handle(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-pxpipe-fail-open')).toBe('transform-error');
    await response.text();

    // Count-token probes are allowed, but the model inference itself must happen
    // exactly once: the primary transform failed before any upstream request.
    expect(inferenceUrls).toHaveLength(1);

    // The synthetic primary 502 is suppressed; telemetry describes the one real
    // upstream attempt that the caller actually received.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0]?.[0]?.status).toBe(200);
  });
});
