import { describe, expect, it } from 'vitest';
import { isPxpipeTransformFailure, mayTransformRequest } from '../src/core/fail-open.js';

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
