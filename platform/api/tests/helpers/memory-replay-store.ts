import type { ReplayObjectStore } from '../../src/lib/replay-store';

/** In-memory store (tests only). */
export class MemoryReplayStore implements ReplayObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        n++;
      }
    }
    return n;
  }
}
