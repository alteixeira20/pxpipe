export type CapabilityCacheState = 'fresh' | 'stale' | 'miss';

export interface CapabilityCachePolicy {
  maxEntries: number;
  successTtlMs: number;
  negativeTtlMs: number;
  failureTtlMs: number;
  staleWhileRevalidateMs: number;
}

export interface CapabilityCacheValue<T> {
  value: T;
  positive: boolean;
  failed: boolean;
}

interface CapabilityCacheEntry<T> extends CapabilityCacheValue<T> {
  freshUntil: number;
  staleUntil: number;
  lastAccess: number;
}

export interface CapabilityCacheLookup<T> {
  state: CapabilityCacheState;
  value?: T;
}

export interface CapabilityCacheInspection {
  entries: number;
  inFlight: number;
  maxEntries: number;
  fresh: number;
  stale: number;
  expired: number;
}

export class BoundedCapabilityCache<T> {
  private readonly entries = new Map<string, CapabilityCacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly policy: CapabilityCachePolicy) {
    if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries <= 0) {
      throw new Error('capability cache maxEntries must be a positive integer');
    }
  }

  get(key: string, now = Date.now()): CapabilityCacheLookup<T> {
    const entry = this.entries.get(key);
    if (!entry) return { state: 'miss' };
    entry.lastAccess = now;
    if (now < entry.freshUntil) return { state: 'fresh', value: entry.value };
    if (now < entry.staleUntil) return { state: 'stale', value: entry.value };
    this.entries.delete(key);
    return { state: 'miss' };
  }

  set(key: string, item: CapabilityCacheValue<T>, now = Date.now()): void {
    const ttl = item.failed
      ? this.policy.failureTtlMs
      : item.positive
        ? this.policy.successTtlMs
        : this.policy.negativeTtlMs;
    this.entries.set(key, {
      ...item,
      freshUntil: now + ttl,
      staleUntil: now + ttl + this.policy.staleWhileRevalidateMs,
      lastAccess: now,
    });
    this.evict(now);
  }

  runSingleFlight(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = load().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  inspect(now = Date.now()): CapabilityCacheInspection {
    let fresh = 0;
    let stale = 0;
    let expired = 0;
    for (const entry of this.entries.values()) {
      if (now < entry.freshUntil) fresh += 1;
      else if (now < entry.staleUntil) stale += 1;
      else expired += 1;
    }
    return {
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      maxEntries: this.policy.maxEntries,
      fresh,
      stale,
      expired,
    };
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.staleUntil) this.entries.delete(key);
    }
    while (this.entries.size > this.policy.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
