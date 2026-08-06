import { describe, expect, it, vi } from 'vitest';

import { BoundedCapabilityCache } from '../src/core/capability-cache.js';
import {
  clearFeatherlessCapabilityCache,
  discoverFeatherlessCapability,
  inspectFeatherlessCapabilityCache,
} from '../src/core/featherless.js';

describe('bounded capability cache', () => {
  it('evicts least-recently-used entries at the configured bound', () => {
    const cache = new BoundedCapabilityCache<string>({
      maxEntries: 2,
      successTtlMs: 100,
      negativeTtlMs: 100,
      failureTtlMs: 100,
      staleWhileRevalidateMs: 100,
    });
    cache.set('a', { value: 'a', positive: true, failed: false }, 1);
    cache.set('b', { value: 'b', positive: true, failed: false }, 2);
    cache.get('a', 3);
    cache.set('c', { value: 'c', positive: true, failed: false }, 4);

    expect(cache.get('a', 4).state).toBe('fresh');
    expect(cache.get('b', 4).state).toBe('miss');
    expect(cache.get('c', 4).state).toBe('fresh');
  });

  it('distinguishes fresh, stale and expired entries', () => {
    const cache = new BoundedCapabilityCache<string>({
      maxEntries: 4,
      successTtlMs: 10,
      negativeTtlMs: 5,
      failureTtlMs: 2,
      staleWhileRevalidateMs: 20,
    });
    cache.set('positive', { value: 'yes', positive: true, failed: false }, 100);
    cache.set('negative', { value: 'no', positive: false, failed: false }, 100);
    cache.set('failure', { value: 'error', positive: false, failed: true }, 100);

    expect(cache.get('positive', 105).state).toBe('fresh');
    expect(cache.get('positive', 115).state).toBe('stale');
    expect(cache.get('positive', 131).state).toBe('miss');
    expect(cache.get('negative', 106).state).toBe('stale');
    expect(cache.get('failure', 103).state).toBe('stale');
  });

  it('coalesces concurrent cache fills', async () => {
    const cache = new BoundedCapabilityCache<string>({
      maxEntries: 4,
      successTtlMs: 10,
      negativeTtlMs: 10,
      failureTtlMs: 10,
      staleWhileRevalidateMs: 10,
    });
    let calls = 0;
    const load = async (): Promise<string> => {
      calls += 1;
      await Promise.resolve();
      return 'loaded';
    };

    const [left, right] = await Promise.all([
      cache.runSingleFlight('same', load),
      cache.runSingleFlight('same', load),
    ]);
    expect(left).toBe('loaded');
    expect(right).toBe('loaded');
    expect(calls).toBe(1);
  });
});

describe('Featherless discovery cache integration', () => {
  it('does not fetch metadata for every request', async () => {
    clearFeatherlessCapabilityCache();
    const customFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      vision_supported: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await discoverFeatherlessCapability(
      'https://api.featherless.ai',
      'moonshotai/Kimi-K3',
      'Bearer test-a',
      customFetch,
    );
    const second = await discoverFeatherlessCapability(
      'https://api.featherless.ai',
      'moonshotai/Kimi-K3',
      'Bearer test-a',
      customFetch,
    );

    expect(first.source).toBe('api');
    expect(second.source).toBe('cache');
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(inspectFeatherlessCapabilityCache().entries).toBe(1);
  });

  it('negative-caches models without grounded vision metadata', async () => {
    clearFeatherlessCapabilityCache();
    const customFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'text-only/model',
      input_modalities: ['text'],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await discoverFeatherlessCapability(
      'https://api.featherless.ai',
      'text-only/model',
      'Bearer test-b',
      customFetch,
    );
    const second = await discoverFeatherlessCapability(
      'https://api.featherless.ai',
      'text-only/model',
      'Bearer test-b',
      customFetch,
    );

    expect(first.decision).toBe('uncapable');
    expect(second.decision).toBe('uncapable');
    expect(second.source).toBe('cache');
    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
