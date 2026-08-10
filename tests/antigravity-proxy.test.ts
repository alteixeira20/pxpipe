import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { setAllowedModelBases, setCompressionSafetyScope } from '../src/core/applicability.js';
import { mergeCompressionProfileOptions, resolveCompressionProfile } from '../src/core/safety-policy.js';

const enc = new TextEncoder();

afterEach(() => {
  setAllowedModelBases(null);
  setCompressionSafetyScope(null);
  vi.restoreAllMocks();
});

function envelope(systemText = '') {
  return {
    project: 'projects/example',
    model: 'gemini-3.6-flash-high',
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: 'req-1',
    request: {
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
    },
  };
}

describe('Antigravity provider proxy', () => {
  it('preserves the outer provider envelope and transforms only the nested request', async () => {
    setCompressionSafetyScope('aggressive');
    setAllowedModelBases(['gemini-3.6-flash']);
    let outgoing = null;
    const events = [];
    const proxy = createProxy({
      googleEnvelope: 'antigravity',
      upstream: 'https://cloudcode-pa.googleapis.com',
      transform: { compress: true, compressTools: false, compressToolResults: false, collapseHistory: false, minCompressChars: 1 },
      customFetch: vi.fn(async (_input, init) => {
        const rawBody = init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? '');
        outgoing = JSON.parse(rawBody);
        return new Response(JSON.stringify({
          response: {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 20 },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      onRequest: (event) => events.push(event),
    });

    const response = await proxy(new Request('http://localhost/v1internal:generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('Static context. '.repeat(2000))),
    }));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(outgoing.project).toBe('projects/example');
    expect(outgoing.model).toBe('gemini-3.6-flash-high');
    expect(outgoing.requestId).toBe('req-1');
    expect(JSON.stringify(outgoing.request)).toContain('inlineData');
    expect(events[0].model).toBe('gemini-3.6-flash-high');
    expect(events[0].accountingProvider).toBe('google');
    expect(events[0].usage).toMatchObject({ input_tokens: 100, output_tokens: 10, cached_tokens: 20 });
  });

  it('coding-safe images only old profitable Antigravity history and keeps recent turns native', async () => {
    setCompressionSafetyScope('coding-safe');
    setAllowedModelBases(['gemini-3.6-flash']);
    let outgoing: any = null;
    const events: ProxyEvent[] = [];
    const longHistory = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'model',
      parts: [{ text: `turn-${i} ` + 'archival context '.repeat(800) }],
    }));
    const body = {
      project: 'projects/example',
      model: 'gemini-3.6-flash-high',
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: 'req-safe-history',
      request: {
        sessionId: 'safe-history-session',
        systemInstruction: { parts: [{ text: 'SYSTEM AUTHORITY MUST STAY NATIVE' }] },
        contents: longHistory,
      },
    };
    const proxy = createProxy({
      googleEnvelope: 'antigravity',
      upstream: 'https://cloudcode-pa.googleapis.com',
      transform: mergeCompressionProfileOptions(resolveCompressionProfile('coding-safe')),
      customFetch: vi.fn(async (_input, init) => {
        const rawBody = init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? '');
        outgoing = JSON.parse(rawBody);
        return new Response(JSON.stringify({ response: {
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }],
          usageMetadata: { promptTokenCount: 6000, candidatesTokenCount: 7 },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      onRequest: (event) => events.push(event),
    });

    const response = await proxy(new Request('http://localhost/v1internal:generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(outgoing.request.systemInstruction).toEqual(body.request.systemInstruction);
    expect(JSON.stringify(outgoing.request.contents)).toContain('inlineData');
    const recentText = JSON.stringify(outgoing.request.contents.slice(-8));
    for (const turn of longHistory.slice(-8)) {
      expect(recentText).toContain(turn.parts[0]!.text);
    }
    expect(events[0]!.info?.compressed).toBe(true);
    expect(events[0]!.info?.collapsedTurns).toBeGreaterThanOrEqual(4);
    expect(events[0]!.trajectory?.sessionSha8).toBeTruthy();
  });

  it('parses nested Antigravity SSE usage without changing the response stream', async () => {
    setCompressionSafetyScope('coding-safe');
    setAllowedModelBases(['gemini-3.6-flash']);
    const events = [];
    const payload = 'data: ' + JSON.stringify({ response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 40 } } }) + '\n\n';
    const proxy = createProxy({
      googleEnvelope: 'antigravity', upstream: 'https://cloudcode-pa.googleapis.com',
      transform: { compress: false },
      customFetch: vi.fn(async () => new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
      onRequest: (event) => events.push(event),
    });
    const response = await proxy(new Request('http://localhost/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope()),
    }));
    expect(await response.text()).toBe(payload);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].usage).toMatchObject({ input_tokens: 90, output_tokens: 7, cached_tokens: 40 });
    expect(events[0].stopReason).toBe('STOP');
  });
});
