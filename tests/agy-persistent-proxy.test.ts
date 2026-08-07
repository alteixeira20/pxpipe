import { describe, expect, it, vi } from 'vitest';
import { resolveAgyPersistentProxy } from '../src/agy.js';

describe('AGY persistent PXPipe resolver', () => {
  it('uses the running loopback listener and matching CA when healthy', async () => {
    const fetchFn = vi.fn(async (input) => {
      expect(String(input)).toBe('http://127.0.0.1:49001/proxy-stats');
      return new Response('{}', { status: 200 });
    });
    const proxy = await resolveAgyPersistentProxy(
      { PORT: '49001', HOME: '/tmp/agy-home' },
      fetchFn,
      (dir) => { expect(dir).toBe('/tmp/agy-home/.pxpipe'); return { certPath: '/tmp/pxpipe-ca.pem' }; },
    );
    expect(proxy).toEqual({ proxyUrl: 'http://127.0.0.1:49001', caCertPath: '/tmp/pxpipe-ca.pem' });
  });

  it('fails open to direct mode when disabled or unhealthy', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline'); });
    expect(await resolveAgyPersistentProxy({ PXPIPE_AGY_AUTO_PROXY: 'off' }, fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await resolveAgyPersistentProxy({ PORT: '47821' }, fetchFn)).toBeNull();
  });
});
