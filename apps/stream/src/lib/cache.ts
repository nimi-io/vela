/** Tiny TTL cache with a size cap (oldest entries evicted first). */
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private ttlMs: number,
    private max = 5000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { v, exp: Date.now() + ttlMs });
  }

  async getOr(key: string, load: () => Promise<V>, ttlMs?: number): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const v = await load();
    this.set(key, v, ttlMs);
    return v;
  }

  delete(key: string) {
    this.map.delete(key);
  }
}

/** Limits concurrent expensive work (ffmpeg thumbnails). */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
