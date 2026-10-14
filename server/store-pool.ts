export interface StorePoolOptions<T, C> {
  /** Builds and initializes a store for `agentId`. */
  create(agentId: string, context: C): Promise<T>;
  /** Releases a store's resources. */
  destroy(store: T): void;
  /** Max live stores; the least recently used is evicted past it. */
  maxLive: number;
  /** Idle time after which a store is released. */
  ttlMs: number;
  /** Injectable clock, for tests. */
  now?(): number;
}

/**
 * One live store per agent, bounded by a global LRU cap and an idle TTL.
 * Eviction is oldest-first and the store being created is never evicted, so a
 * newer store always wins; a released store is rebuilt on the next acquire.
 */
export class StorePool<T, C = void> {
  private readonly options: StorePoolOptions<T, C>;
  private readonly now: () => number;
  /** Insertion order is LRU order: least recently used first. */
  private readonly stores = new Map<string, T>();
  private readonly attaches = new Map<string, { promise: Promise<T>; token: symbol }>();
  private readonly lastUsed = new Map<string, number>();
  private disposed = false;

  constructor(options: StorePoolOptions<T, C>) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.stores.size;
  }

  has(agentId: string): boolean {
    return this.stores.has(agentId);
  }

  acquire(agentId: string, context: C): Promise<T> {
    const cached = this.stores.get(agentId);
    if (cached !== undefined) {
      this.markUsed(agentId);
      this.evictOverflow();
      return Promise.resolve(cached);
    }
    const existing = this.attaches.get(agentId);
    if (existing) return existing.promise;

    const token = Symbol(agentId);
    const attach = { promise: this.create(agentId, context, token), token };
    this.attaches.set(agentId, attach);
    const settled = () => {
      if (this.attaches.get(agentId) === attach) this.attaches.delete(agentId);
      this.evictOverflow();
    };
    void attach.promise.then(settled, settled);
    return attach.promise;
  }

  release(agentId: string): void {
    this.attaches.delete(agentId);
    this.lastUsed.delete(agentId);
    const store = this.stores.get(agentId);
    if (store === undefined) return;
    this.stores.delete(agentId);
    this.options.destroy(store);
  }

  /** Releases idle stores and enforces the cap. */
  sweep(): void {
    const cutoff = this.now() - this.options.ttlMs;
    for (const [agentId, usedAt] of [...this.lastUsed]) {
      if (usedAt < cutoff) this.release(agentId);
    }
    this.evictOverflow();
  }

  dispose(): void {
    this.disposed = true;
    for (const agentId of [...this.stores.keys()]) this.release(agentId);
  }

  private async create(agentId: string, context: C, token: symbol): Promise<T> {
    const store = await this.options.create(agentId, context);
    // A release or dispose during the create must not resurrect the store.
    if (this.disposed || this.attaches.get(agentId)?.token !== token) {
      this.options.destroy(store);
      throw new Error(`Store for ${agentId} was released while attaching`);
    }
    this.stores.set(agentId, store);
    this.lastUsed.set(agentId, this.now());
    this.evictOverflow(agentId);
    return store;
  }

  private markUsed(agentId: string): void {
    this.lastUsed.set(agentId, this.now());
    const store = this.stores.get(agentId);
    if (store === undefined) return;
    // Re-insert so the map keeps visiting least-recently-used first.
    this.stores.delete(agentId);
    this.stores.set(agentId, store);
  }

  private evictOverflow(protect?: string): void {
    if (this.stores.size <= this.options.maxLive) return;
    for (const agentId of [...this.stores.keys()]) {
      if (this.stores.size <= this.options.maxLive) return;
      if (agentId === protect || this.attaches.has(agentId)) continue;
      this.release(agentId);
    }
  }
}
