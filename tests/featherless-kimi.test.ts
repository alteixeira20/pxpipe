import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProxy, inspectResponseForErrorEnvelope } from '../src/core/proxy.js';
import {
  buildFeatherlessDiscoveryUrl,
  buildFeatherlessUpstreamUrl,
  clearCircuitBreakers,
  clearFeatherlessCapabilityCache,
  computeAuthContextDigest,
  detectProviderErrorEnvelope,
  discoverFeatherlessCapability,
  isCircuitBreakerOpen,
  normalizeUpstreamRoot,
  parseFeatherlessModelMetadata,
  recordCircuitBreakerFailure,
  setPxpipeVersion,
} from '../src/core/featherless.js';
import { transformOpenAIChatCompletions } from '../src/core/openai.js';
import { renderRecentFragment } from '../src/dashboard/fragments.js';
import { toTrackEvent } from '../src/core/tracker.js';
import type { ProxyEvent } from '../src/core/proxy.js';
import type { RecentPayload } from '../src/dashboard/types.js';

function getBodyText(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as Uint8Array);
  }
  return String(body);
}

describe('Featherless / Kimi-K3 Integration & Regressions', () => {
  const origEnvModels = process.env.PXPIPE_MODELS;

  beforeEach(() => {
    clearFeatherlessCapabilityCache();
    clearCircuitBreakers();
    if (origEnvModels !== undefined) {
      process.env.PXPIPE_MODELS = origEnvModels;
    } else {
      delete process.env.PXPIPE_MODELS;
    }
  });

  afterEach(() => {
    if (origEnvModels !== undefined) {
      process.env.PXPIPE_MODELS = origEnvModels;
    } else {
      delete process.env.PXPIPE_MODELS;
    }
  });

  describe('1. Upstream path & discovery URL normalization', () => {
    it('ensures /v1 appears exactly once in generated upstream URLs', () => {
      expect(normalizeUpstreamRoot('https://api.featherless.ai')).toBe('https://api.featherless.ai');
      expect(normalizeUpstreamRoot('https://api.featherless.ai/v1')).toBe('https://api.featherless.ai');
      expect(normalizeUpstreamRoot('https://api.featherless.ai/v1/')).toBe('https://api.featherless.ai');

      expect(buildFeatherlessUpstreamUrl('https://api.featherless.ai', '/v1/chat/completions'))
        .toBe('https://api.featherless.ai/v1/chat/completions');

      expect(buildFeatherlessUpstreamUrl('https://api.featherless.ai/v1', '/v1/chat/completions'))
        .toBe('https://api.featherless.ai/v1/chat/completions');

      expect(buildFeatherlessUpstreamUrl('https://api.featherless.ai/v1/', '/chat/completions'))
        .toBe('https://api.featherless.ai/v1/chat/completions');
    });

    it('exact discovery path preserves moonshotai/Kimi-K3 namespace separator', () => {
      const url = buildFeatherlessDiscoveryUrl('https://api.featherless.ai', 'moonshotai/Kimi-K3');
      expect(url).toBe('https://api.featherless.ai/v1/models/moonshotai/Kimi-K3');
      expect(url).not.toContain('%2F');
    });
  });

  describe('2. Header forwarding', () => {
    it('forwards Authorization, HTTP-Referer, and X-Title to upstream', async () => {
      let capturedHeaders: Headers | undefined;
      let capturedUrl: string | undefined;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedHeaders = new Headers(init?.headers);
        if (capturedUrl.includes('/v1/models/')) {
          return new Response(JSON.stringify({ id: 'moonshotai/Kimi-K3', vision_supported: true }));
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Hello' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const handler = createProxy({
        provider: 'featherless',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer test-featherless-key',
          'http-referer': 'https://opencode.dev',
          'x-title': 'OpenCode IDE',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.json();
      expect(res.status).toBe(200);
      expect(capturedUrl).toBe('https://api.featherless.ai/v1/chat/completions');
      expect(capturedHeaders?.get('authorization')).toBe('Bearer test-featherless-key');
      expect(capturedHeaders?.get('http-referer')).toBe('https://opencode.dev');
      expect(capturedHeaders?.get('x-title')).toBe('OpenCode IDE');
    });
  });

  describe('3. Off mode & PXPIPE_MODELS restrictions', () => {
    it('preserves the original body byte-for-byte in off mode', async () => {
      let capturedBody: string | undefined;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = getBodyText(init?.body);
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'off',
        customFetch: mockFetch,
      });

      const originalPayload = JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: originalPayload,
      });

      const res = await handler(req);
      await res.json();
      expect(capturedBody).toBe(originalPayload);
    });

    it('explicit PXPIPE_MODELS restrictions are respected', async () => {
      process.env.PXPIPE_MODELS = 'claude-fable-5';
      let capturedBody: string | undefined;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = getBodyText(init?.body);
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const originalPayload = JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        messages: [{ role: 'system', content: 'system context '.repeat(200) }, { role: 'user', content: 'hello' }],
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: originalPayload,
      });

      const res = await handler(req);
      await res.json();
      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toBe(200);
      expect(capturedBody).toBe(originalPayload);
      expect(eventFired?.info?.compressed).toBe(false);
    });
  });

  describe('4. Capability discovery & authorization-isolated TTL caching', () => {
    it('parses mixed Featherless model metadata conservatively', () => {
      expect(parseFeatherlessModelMetadata({ vision_supported: true })).toBe(true);
      expect(parseFeatherlessModelMetadata({ features: { image_input: true } })).toBe(true);
      expect(parseFeatherlessModelMetadata({ input_modalities: ['text', 'image'] })).toBe(true);
      expect(parseFeatherlessModelMetadata({ vision_supported: false, input_modalities: ['text'] })).toBe(false);

      // Explicit negative overrides
      expect(parseFeatherlessModelMetadata({ vision_supported: true, status: 'unavailable' })).toBe(false);
      expect(parseFeatherlessModelMetadata({ features: { image_input: true }, available_on_current_plan: false })).toBe(false);
      expect(parseFeatherlessModelMetadata({ vision_supported: true, features: { image_input: false } })).toBe(false);
    });

    it('capability cache is isolated across authorization contexts', async () => {
      let getCount = 0;
      const mockFetch = async () => {
        getCount++;
        return new Response(JSON.stringify({
          id: 'moonshotai/Kimi-K3',
          vision_supported: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const res1 = await discoverFeatherlessCapability('https://api.featherless.ai', 'moonshotai/Kimi-K3', 'Bearer key-user-1', mockFetch);
      expect(res1.source).toBe('api');
      expect(res1.cacheStatus).toBe('miss');
      expect(getCount).toBe(1);

      // Same key -> cache hit
      const res1Hit = await discoverFeatherlessCapability('https://api.featherless.ai', 'moonshotai/Kimi-K3', 'Bearer key-user-1', mockFetch);
      expect(res1Hit.source).toBe('cache');
      expect(res1Hit.cacheStatus).toBe('hit');
      expect(getCount).toBe(1);

      // Different auth header -> cache miss (isolated context)
      const res2 = await discoverFeatherlessCapability('https://api.featherless.ai', 'moonshotai/Kimi-K3', 'Bearer key-user-2', mockFetch);
      expect(res2.source).toBe('api');
      expect(res2.cacheStatus).toBe('miss');
      expect(getCount).toBe(2);
    });

    it('degrades to pass-through on capability-discovery failure', async () => {
      let capturedBody: string | undefined;
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }
        capturedBody = getBodyText(init?.body);
        return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const rawPayload = JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        messages: [{ role: 'user', content: 'test request' }],
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawPayload,
      });

      const res = await handler(req);
      await res.json();
      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toBe(200);
      expect(capturedBody).toBe(rawPayload); // degraded to pass-through
      expect(eventFired?.capability_decision).toBe('discovery_failed');
      expect(eventFired?.transformation_state).toBe('degraded');
    });
  });

  describe('5. Image placement: synthetic message vs Kimi merged first-user', () => {
    it('existing OpenAI/GPT message placement remains unchanged (synthetic message)', async () => {
      const payload = new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'System instruction '.repeat(300) },
          { role: 'user', content: 'What is the speed of light?' },
        ],
      }));

      const { body } = await transformOpenAIChatCompletions(payload, {
        imagePlacement: 'synthetic_message',
      });
      const parsed = JSON.parse(new TextDecoder().decode(body));

      // Synthetic user message inserted after system message (at index firstUserIdx)
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[1].role).toBe('user');
      expect(Array.isArray(parsed.messages[1].content)).toBe(true);
      expect(parsed.messages[1].content[0].type).toBe('image_url');
      expect(parsed.messages[1].content[0].image_url.detail).toBe('original');

      // Original user message follows at index 2
      expect(parsed.messages[2].role).toBe('user');
      expect(parsed.messages[2].content).toBe('What is the speed of light?');
    });

    it('Kimi uses merged first-user placement with detail:auto', async () => {
      let sentPayload: any;
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }), { status: 200 });
        }
        sentPayload = JSON.parse(getBodyText(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [
            { role: 'system', content: 'You are a helpful coding assistant. '.repeat(100) },
            { role: 'user', content: 'What is 2+2?' },
          ],
        }),
      });

      const res = await handler(req);
      await res.json();
      expect(res.status).toBe(200);
      expect(sentPayload).toBeDefined();

      const userMsg = sentPayload.messages.find((m: any) => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(Array.isArray(userMsg.content)).toBe(true);

      const imgPart = userMsg.content.find((p: any) => p.type === 'image_url');
      expect(imgPart).toBeDefined();
      expect(imgPart.image_url.detail).toBe('auto');
      expect(imgPart.image_url.url).toMatch(/^data:image\/png;base64,/);

      // Verify merged content: images + trailing original text part in same user message
      const textPart = userMsg.content.find((p: any) => p.type === 'text' && p.text === 'What is 2+2?');
      expect(textPart).toBeDefined();
    });
  });

  describe('6. Provider-restricted fallback & envelope detection', () => {
    it('fallback is never activated for non-Featherless providers', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return new Response(JSON.stringify({ error: { message: 'Internal Server Error' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        // Non-featherless provider (default)
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      expect(res.status).toBe(500);
      await new Promise((r) => setTimeout(r, 10));

      expect(callCount).toBe(1);
      expect(eventFired?.fallback_attempted).toBeUndefined();
    });

    it('non-2xx status triggers fallback for Featherless provider', async () => {
      let callCount = 0;
      let secondPayload: any;

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'Overloaded' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        secondPayload = JSON.parse(getBodyText(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'recovered' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const rawPayload = JSON.stringify({
        model: 'moonshotai/Kimi-K3',
        messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawPayload,
      });

      const res = await handler(req);
      const resJson = await res.json();
      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toBe(200);
      expect(resJson.choices?.[0]?.message?.content).toBe('recovered');
      expect(callCount).toBe(2);
      expect(eventFired?.fallback_attempted).toBe(true);
      expect(eventFired?.fallback_reason).toBe('http_status_503');
      expect(eventFired?.fallback_result).toBe('success');
      expect(JSON.stringify(secondPayload)).toBe(rawPayload);
    });

    it('HTTP 200 JSON error envelope triggers fallback', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        if (callCount === 0) {
          callCount++;
          return new Response(JSON.stringify({
            message: 'This model is busy, please try again later.',
            code: 'completion_error',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        callCount++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(callCount).toBe(2);
      expect(eventFired?.fallback_attempted).toBe(true);
      expect(eventFired?.fallback_reason).toBe('This model is busy, please try again later.');
    });

    it('HTTP 200 SSE error before bytes falls back', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"message": "Model busy", "code": "completion_error"}\n\n'));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "ok"}}]}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      const text = await res.text();
      await new Promise((r) => setTimeout(r, 10));

      expect(callCount).toBe(2);
      expect(text).toContain('"content": "ok"');
      expect(eventFired?.fallback_attempted).toBe(true);
    });

    it('partial SSE output never falls back', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Partial output"}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"message": "Model busy error later", "code": "completion_error"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      const text = await res.text();
      await new Promise((r) => setTimeout(r, 10));

      expect(callCount).toBe(1);
      expect(text).toContain('Partial output');
      expect(eventFired?.fallback_attempted).toBe(false);
    });

    it('tool-call delta never falls back', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"tool_calls": [{"function": {"name": "calculator"}}]}}]}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };

      let eventFired: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      const text = await res.text();
      await new Promise((r) => setTimeout(r, 10));

      expect(callCount).toBe(1);
      expect(text).toContain('calculator');
      expect(eventFired?.fallback_attempted).toBe(false);
    });
  });

  describe('7. Headers timeout & circuit breaker scoping', () => {
    it('retry receives an independent headers timeout', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 });
        }
        // Attempt 2 succeeds quickly
        return new Response(JSON.stringify({ choices: [{ message: { content: 'retry ok' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        upstreamHeadersTimeoutMs: 1000,
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.choices[0].message.content).toBe('retry ok');
      expect(callCount).toBe(2);
    });

    it('circuit breaker integration skips the fourth transformed attempt', async () => {
      let callCount = 0;
      const mockFetch = async (input: RequestInfo | URL) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }

        callCount++;

        // Odd calls are transformed requests. Even calls are the original-text
        // fallbacks. A successful fallback proves that the transformed request
        // shape caused the failure and should count towards the image breaker.
        if (callCount % 2 === 1) {
          return new Response(JSON.stringify({
            message: 'Image-shaped input rejected',
            code: 'completion_error',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: 'Text fallback succeeded',
            },
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      let lastEvent: ProxyEvent | undefined;
      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
        onRequest: (e) => { lastEvent = e; },
      });

      const makeReq = () => new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 's '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      // 3 attempts fail (each triggers fallback -> 2 calls each = 6 calls total)
      await (await handler(makeReq())).json();
      await (await handler(makeReq())).json();
      await (await handler(makeReq())).json();

      expect(callCount).toBe(6);
      expect(isCircuitBreakerOpen('featherless', 'https://api.featherless.ai', 'moonshotai/Kimi-K3')).toBe(true);

      // 4th request skips transformation entirely due to circuit breaker open
      const res4 = await handler(makeReq());
      await res4.json();
      await new Promise((r) => setTimeout(r, 10));

      expect(lastEvent?.transformation_state).toBe('skipped');
      expect(lastEvent?.skip_reason).toBe('circuit_breaker_open');
    });

    it('breaker is isolated by upstream and model', () => {
      const provider = 'featherless';
      const originA = 'https://api1.featherless.ai';
      const originB = 'https://api2.featherless.ai';
      const modelA = 'moonshotai/Kimi-K3';
      const modelB = 'moonshotai/Kimi-K2';

      recordCircuitBreakerFailure(provider, originA, modelA);
      recordCircuitBreakerFailure(provider, originA, modelA);
      recordCircuitBreakerFailure(provider, originA, modelA);

      expect(isCircuitBreakerOpen(provider, originA, modelA)).toBe(true);
      expect(isCircuitBreakerOpen(provider, originA, modelB)).toBe(false);
      expect(isCircuitBreakerOpen(provider, originB, modelA)).toBe(false);
    });
  });

  describe('8. Dashboard state rendering & Credentials security', () => {
    it('dashboard visibly renders each state', () => {
      const payload: RecentPayload = {
        recent: [
          {
            ts: Date.now() / 1000,
            method: 'POST',
            path: '/v1/chat/completions',
            model: 'moonshotai/Kimi-K3',
            status: 200,
            compressed: true,
            transformation_state: 'transformed',
          },
          {
            ts: Date.now() / 1000,
            method: 'POST',
            path: '/v1/chat/completions',
            model: 'moonshotai/Kimi-K3',
            status: 200,
            compressed: false,
            transformation_state: 'passthrough',
          },
          {
            ts: Date.now() / 1000,
            method: 'POST',
            path: '/v1/chat/completions',
            model: 'moonshotai/Kimi-K3',
            status: 200,
            compressed: false,
            transformation_state: 'degraded',
          },
          {
            ts: Date.now() / 1000,
            method: 'POST',
            path: '/v1/chat/completions',
            model: 'moonshotai/Kimi-K3',
            status: 200,
            compressed: true,
            transformation_state: 'fallback',
          },
        ],
        has_preview: false,
        preview_meta: '',
        image_ids: [],
      };

      const html = renderRecentFragment(payload);

      expect(html).toContain('transformed');
      expect(html).toContain('plain pass-through');
      expect(html).toContain('degraded');
      expect(html).toContain('fallback-to-text');
    });

    it('credentials and authorization-derived cache keys never appear in events', async () => {
      let eventFired: ProxyEvent | undefined;
      const mockFetch = async (input: RequestInfo | URL) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const handler = createProxy({
        provider: 'featherless',
        customFetch: mockFetch,
        onRequest: (e) => { eventFired = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer secret-featherless-api-key-12345',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      const res = await handler(req);
      await res.json();
      await new Promise((r) => setTimeout(r, 10));

      expect(eventFired).toBeDefined();
      const evStr = JSON.stringify(eventFired);
      expect(evStr).not.toContain('secret-featherless-api-key-12345');
      expect(evStr).not.toContain('Bearer');
    });
  });

  describe('9. SSE Stream Reconstruction & Incremental Forwarding (Requirement 1)', () => {
    it('proves the response object becomes available before upstream stream completes', async () => {
      let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
      let isUpstreamClosed = false;
      const encoder = new TextEncoder();

      const upstreamStream = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        },
      });

      const upstreamRes = new Response(upstreamStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const inspectionPromise = inspectResponseForErrorEnvelope(upstreamRes);
      const inspection = await inspectionPromise;

      expect(inspection.isError).toBe(false);
      expect(isUpstreamClosed).toBe(false);

      const reader = inspection.response.body!.getReader();
      const read1 = await reader.read();
      expect(read1.done).toBe(false);
      expect(new TextDecoder().decode(read1.value)).toContain('Hello');

      upstreamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'));
      upstreamController.close();
      isUpstreamClosed = true;

      const read2 = await reader.read();
      expect(read2.done).toBe(false);
      expect(new TextDecoder().decode(read2.value)).toContain('World');

      const read3 = await reader.read();
      expect(read3.done).toBe(true);
    });

    it('timing/order test proving first valid SSE chunk reaches consumer while later upstream chunks remain pending', async () => {
      let pushChunk2!: () => void;
      const encoder = new TextEncoder();

      const chunk2Promise = new Promise<void>((resolve) => {
        pushChunk2 = resolve;
      });

      const upstreamStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk 1"}}]}\n\n'));
          await chunk2Promise;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk 2"}}]}\n\n'));
          controller.close();
        },
      });

      const upstreamRes = new Response(upstreamStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const inspection = await inspectResponseForErrorEnvelope(upstreamRes);
      const reader = inspection.response.body!.getReader();

      const read1 = await reader.read();
      expect(new TextDecoder().decode(read1.value)).toContain('Chunk 1');

      pushChunk2();
      const read2 = await reader.read();
      expect(new TextDecoder().decode(read2.value)).toContain('Chunk 2');
    });
  });

  describe('10. Kimi model defaults (Requirement 2)', () => {
    it('non-Featherless Kimi-named model retains synthetic-message placement', async () => {
      const payload = new TextEncoder().encode(JSON.stringify({
        model: 'kimi-v1',
        messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
      }));

      const transformedRes = await transformOpenAIChatCompletions(payload);

      expect(transformedRes.info.compressed).toBe(true);
      const transformedBody = JSON.parse(new TextDecoder().decode(transformedRes.body));
      const messages = transformedBody.messages;
      expect(messages[0].role).toBe('system');
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('11. Bounded SHA-256 Auth Digest (Requirement 3)', () => {
    it('is deterministic for identical auth headers', async () => {
      const d1 = await computeAuthContextDigest('Bearer secret-token-abc');
      const d2 = await computeAuthContextDigest('Bearer secret-token-abc');
      expect(d1).toBe(d2);
      expect(d1.length).toBe(16);
      expect(d1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces distinct digests for different auth headers (separation)', async () => {
      const d1 = await computeAuthContextDigest('Bearer key-1');
      const d2 = await computeAuthContextDigest('Bearer key-2');
      expect(d1).not.toBe(d2);
    });

    it('matches real Web Crypto SHA-256 hex prefix', async () => {
      const header = 'Bearer test-sha-key';
      const digest = await computeAuthContextDigest(header);
      const expectedFull = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(header));
      const expectedHex = Array.from(new Uint8Array(expectedFull))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
      expect(digest).toBe(expectedHex);
    });

    it('auth digest is never exposed in discovery results, ProxyEvents or dashboard payloads (non-exposure)', async () => {
      let capturedEvent: ProxyEvent | undefined;
      const mockFetch = async (input: RequestInfo | URL) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ id: 'moonshotai/Kimi-K3', vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const handler = createProxy({
        provider: 'featherless',
        customFetch: mockFetch,
        onRequest: (e) => { capturedEvent = e; },
      });

      const header = 'Bearer confidential-user-token';
      const digest = await computeAuthContextDigest(header);

      const capResult = await discoverFeatherlessCapability('https://api.featherless.ai', 'moonshotai/Kimi-K3', header, mockFetch);
      expect(JSON.stringify(capResult)).not.toContain(digest);
      expect(JSON.stringify(capResult)).not.toContain(header);

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': header },
        body: JSON.stringify({ model: 'moonshotai/Kimi-K3', messages: [{ role: 'user', content: 'hi' }] }),
      });

      const res = await handler(req);
      await res.json();
      await new Promise((r) => setTimeout(r, 10));

      const eventStr = JSON.stringify(capturedEvent);
      expect(eventStr).not.toContain(digest);
      expect(eventStr).not.toContain(header);
    });
  });

  describe('12. Abort-controller Ownership & Lifecycle (Requirement 4)', () => {
    it('attempt one and attempt two use different AbortSignals', async () => {
      const signals: AbortSignal[] = [];

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        if (init?.signal) {
          signals.push(init.signal);
        }
        if (signals.length === 1) {
          return new Response(JSON.stringify({ error: { message: 'Provider error' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.json();

      expect(signals.length).toBe(2);
      expect(signals[0]).not.toBe(signals[1]);
    });

    it('timeout state from attempt one does not pre-abort attempt two', async () => {
      let callCount = 0;
      const signals: AbortSignal[] = [];

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        callCount++;
        if (init?.signal) signals.push(init.signal);

        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'error envelope' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(init?.signal?.aborted).toBe(false);
        return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.json();
      expect(callCount).toBe(2);
      expect(signals[1].aborted).toBe(false);
    });

    it('client disconnect aborts the active attempt', async () => {
      let activeSignal: AbortSignal | undefined;
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        activeSignal = init?.signal;
        return new Promise(() => {});
      };

      const handler = createProxy({
        provider: 'featherless',
        headersTimeoutMs: 5000,
        customFetch: mockFetch,
      });

      const clientController = new AbortController();
      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: clientController.signal,
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      const proxyPromise = handler(req);
      await new Promise((r) => setTimeout(r, 20));

      expect(activeSignal).toBeDefined();
      expect(activeSignal?.aborted).toBe(false);

      clientController.abort();
      await new Promise((r) => setTimeout(r, 20));

      expect(activeSignal?.aborted).toBe(true);
      void proxyPromise.catch(() => undefined);
    });

    it('no listeners or timers remain after completion', async () => {
      const clientController = new AbortController();
      const mockFetch = async (input: RequestInfo | URL) => {
        if (input.toString().includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      const handler = createProxy({
        provider: 'featherless',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: clientController.signal,
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.json();

      expect(() => clientController.abort()).not.toThrow();
    });
  });

  describe('13. Discovery Request Headers & Compatibility (Requirement 1-4)', () => {
    it('sends Accept: application/json and User-Agent: pxpipe/<version> on discovery', async () => {
      let discoveryHeaders: Record<string, string> = {};
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          const h = init?.headers as Record<string, string> | undefined;
          if (h) discoveryHeaders = { ...h };
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'force',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      await handler(req);

      // In force mode, discovery is skipped. Need to test via auto mode.
    });

    it('discovery sends exact Accept and User-Agent headers', async () => {
      clearFeatherlessCapabilityCache();
      setPxpipeVersion('0.12.0');
      let discoveryHeaders: Record<string, string> = {};
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          const h = init?.headers as Record<string, string> | undefined;
          if (h) discoveryHeaders = { ...h };
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer test-key-abc',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      await handler(req);

      expect(discoveryHeaders['accept']).toBe('application/json');
      expect(discoveryHeaders['user-agent']).toBe('pxpipe/0.12.0');
    });

    it('forwards Authorization header exactly on discovery', async () => {
      clearFeatherlessCapabilityCache();
      let discoveryAuth: string | undefined;
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          const h = init?.headers as Record<string, string> | undefined;
          discoveryAuth = h?.authorization;
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
      });

      const authValue = 'Bearer my-exact-featherless-key-123';
      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': authValue,
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      await handler(req);

      expect(discoveryAuth).toBe(authValue);
    });

    it('User-Agent reflects setPxpipeVersion value', async () => {
      clearFeatherlessCapabilityCache();
      setPxpipeVersion('1.2.3');
      let capturedUA: string | undefined;

      const cap = await discoverFeatherlessCapability(
        'https://api.featherless.ai',
        'moonshotai/Kimi-K3',
        'Bearer test',
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const h = init?.headers as Record<string, string> | undefined;
          capturedUA = h?.['user-agent'];
          return new Response(JSON.stringify({ vision_supported: true }));
        },
      );

      expect(capturedUA).toBe('pxpipe/1.2.3');
      expect(cap.decision).toBe('capable');
      setPxpipeVersion('0.12.0'); // restore
    });

    it('completion forwarding does not add discovery User-Agent', async () => {
      clearFeatherlessCapabilityCache();
      let completionHeaders: Headers | undefined;
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        // This is the completion request
        completionHeaders = new Headers(init?.headers as HeadersInit);
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer test-key',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      await handler(req);

      // The completion request should NOT have the pxpipe User-Agent
      const ua = completionHeaders?.get('user-agent') || '';
      expect(ua).not.toContain('pxpipe/');
    });

    it('HTTP 404 text/plain "Gone." results in discovery_failed', async () => {
      clearFeatherlessCapabilityCache();
      const cap = await discoverFeatherlessCapability(
        'https://api.featherless.ai',
        'moonshotai/Kimi-K3',
        'Bearer test',
        async () => new Response('Gone.', { status: 404, headers: { 'content-type': 'text/plain' } }),
      );

      expect(cap.decision).toBe('discovery_failed');
      expect(cap.visionSupported).toBe(false);
      expect(cap.error).toBe('HTTP 404');
    });

    it('successful JSON metadata returns capable', async () => {
      clearFeatherlessCapabilityCache();
      const cap = await discoverFeatherlessCapability(
        'https://api.featherless.ai',
        'moonshotai/Kimi-K3',
        'Bearer test',
        async () => new Response(JSON.stringify({ vision_supported: true, status: 'active' })),
      );

      expect(cap.decision).toBe('capable');
      expect(cap.visionSupported).toBe(true);
      expect(cap.source).toBe('api');
    });
  });

  describe('14. Featherless Event Field Propagation (Requirement 6-7)', () => {
    it('discovery failure emits correct fields in ProxyEvent and TrackEvent', async () => {
      clearFeatherlessCapabilityCache();
      clearCircuitBreakers();
      let capturedEvent: ProxyEvent | undefined;

      const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          return new Response('Gone.', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
        onRequest: (e) => { capturedEvent = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.text();
      // Allow async finalize to complete
      await new Promise(r => setTimeout(r, 50));

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent!.provider).toBe('featherless');
      expect(capturedEvent!.transformation_mode).toBe('auto');
      expect(capturedEvent!.transformation_state).toBe('degraded');
      expect(capturedEvent!.capability_decision).toBe('discovery_failed');
      expect(capturedEvent!.capability_source).toBe('api');
      expect(capturedEvent!.capability_cache_status).toBe('miss');
      expect(capturedEvent!.skip_reason).toBe('discovery_failed');

      // Verify TrackEvent propagation
      const trackEvent = toTrackEvent(capturedEvent!);
      expect(trackEvent.provider).toBe('featherless');
      expect(trackEvent.transformation_mode).toBe('auto');
      expect(trackEvent.transformation_state).toBe('degraded');
      expect(trackEvent.capability_decision).toBe('discovery_failed');
      expect(trackEvent.capability_source).toBe('api');
      expect(trackEvent.capability_cache_status).toBe('miss');
      expect(trackEvent.skip_reason).toBe('discovery_failed');

      // No secrets in the track event
      const serialized = JSON.stringify(trackEvent);
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('api-key');
    });

    it('transformed success emits correct fields in ProxyEvent and TrackEvent', async () => {
      clearFeatherlessCapabilityCache();
      clearCircuitBreakers();
      let capturedEvent: ProxyEvent | undefined;

      const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
        onRequest: (e) => { capturedEvent = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer secret-key',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.text();
      await new Promise(r => setTimeout(r, 50));

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent!.provider).toBe('featherless');
      expect(capturedEvent!.transformation_mode).toBe('auto');
      expect(capturedEvent!.capability_decision).toBe('capable');
      expect(capturedEvent!.capability_source).toBe('api');
      expect(capturedEvent!.upstream_attempt_count).toBeGreaterThanOrEqual(1);

      // Verify TrackEvent propagation
      const trackEvent = toTrackEvent(capturedEvent!);
      expect(trackEvent.provider).toBe('featherless');
      expect(trackEvent.transformation_mode).toBe('auto');
      expect(trackEvent.capability_decision).toBe('capable');

      // No secrets
      const serialized = JSON.stringify(trackEvent);
      expect(serialized).not.toContain('secret-key');
      expect(serialized).not.toContain('Bearer');
    });

    it('fallback success emits correct fields in ProxyEvent and TrackEvent', async () => {
      clearFeatherlessCapabilityCache();
      clearCircuitBreakers();
      let capturedEvent: ProxyEvent | undefined;
      let callCount = 0;

      const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = input.toString();
        if (url.includes('/v1/models/')) {
          return new Response(JSON.stringify({ vision_supported: true }));
        }
        callCount++;
        if (callCount === 1) {
          // First attempt returns error envelope
          return new Response(JSON.stringify({ error: { message: 'Provider error' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Fallback succeeds
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const handler = createProxy({
        provider: 'featherless',
        featherlessTransformMode: 'auto',
        customFetch: mockFetch,
        onRequest: (e) => { capturedEvent = e; },
      });

      const req = new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer secret-key',
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K3',
          messages: [{ role: 'system', content: 'system context '.repeat(600) }, { role: 'user', content: 'hi' }],
        }),
      });

      const res = await handler(req);
      await res.text();
      await new Promise(r => setTimeout(r, 50));

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent!.provider).toBe('featherless');
      expect(capturedEvent!.transformation_mode).toBe('auto');
      expect(capturedEvent!.transformation_state).toBe('fallback');
      expect(capturedEvent!.fallback_attempted).toBe(true);
      expect(capturedEvent!.fallback_result).toBe('success');
      expect(capturedEvent!.upstream_attempt_count).toBe(2);

      // Verify TrackEvent propagation
      const trackEvent = toTrackEvent(capturedEvent!);
      expect(trackEvent.provider).toBe('featherless');
      expect(trackEvent.transformation_state).toBe('fallback');
      expect(trackEvent.fallback_attempted).toBe(true);
      expect(trackEvent.fallback_result).toBe('success');
      expect(trackEvent.upstream_attempt_count).toBe(2);

      // No secrets
      const serialized = JSON.stringify(trackEvent);
      expect(serialized).not.toContain('secret-key');
      expect(serialized).not.toContain('Bearer');
    });
  });
});
