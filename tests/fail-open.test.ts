import { describe, expect, it, vi } from 'vitest';
import {
  createFailOpenProxy,
  isPxpipeTransformFailure,
  mayTransformRequest,
} from '../src/core/fail-open.js';

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
    const upstreamFetch = vi.fn(async () => new Response(
      JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
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
        model: 'unsupported-test-model',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const response = await handle(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-pxpipe-fail-open')).toBe('transform-error');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    // The synthetic primary 502 is suppressed; telemetry describes the one real
    // upstream attempt that the caller actually received.
    await Promise.resolve();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0]?.[0]?.status).toBe(200);
  });
});
