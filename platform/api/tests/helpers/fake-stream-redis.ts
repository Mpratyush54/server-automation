/**
 * Minimal in-memory Redis Streams fake (one stream, consumer groups, PEL) for the telemetry
 * queue tests. Only the commands lib/telemetry-queue.ts uses are implemented.
 */
type Fields = string[];
interface StreamEntry { id: string; fields: Fields }
interface PelEntry { consumer: string; deliveries: number; deliveredAt: number }
interface Group { lastDelivered: string; pel: Map<string, PelEntry> }

function cmp(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am - bm || as - bs;
}

export class FakeStreamRedis {
  entries: StreamEntry[] = [];
  groups = new Map<string, Group>();
  clock = 1_700_000_000_000;
  private seq = 0;
  /** Set to make the next commands reject (simulated outage). */
  failWith: Error | null = null;
  calls: string[] = [];

  private guard(name: string) {
    this.calls.push(name);
    if (this.failWith) throw this.failWith;
  }

  async xlen(_key: string) { this.guard('xlen'); return this.entries.length; }

  async xadd(_key: string, ...args: (string | number)[]) {
    this.guard('xadd');
    let i = 0;
    let maxLen = Infinity;
    if (args[0] === 'MAXLEN') {
      i = args[1] === '~' || args[1] === '=' ? 3 : 2;
      maxLen = Number(args[i - 1]);
    }
    if (args[i] !== '*') throw new Error('fake only supports * ids');
    const id = `${this.clock}-${this.seq++}`;
    this.entries.push({ id, fields: args.slice(i + 1).map(String) });
    while (this.entries.length > maxLen) this.entries.shift();
    return id;
  }

  async xgroup(sub: string, _key: string, group: string, start: string) {
    this.guard('xgroup');
    if (sub !== 'CREATE') throw new Error('unsupported');
    if (this.groups.has(group)) throw new Error('BUSYGROUP Consumer Group name already exists');
    this.groups.set(group, { lastDelivered: start === '$' ? (this.entries.at(-1)?.id ?? '0-0') : '0-0', pel: new Map() });
    return 'OK';
  }

  async xreadgroup(...args: (string | number)[]) {
    this.guard('xreadgroup');
    const group = this.groups.get(String(args[1]));
    if (!group) throw new Error('NOGROUP');
    const consumer = String(args[2]);
    const count = Number(args[args.indexOf('COUNT') + 1]);
    const key = String(args[args.indexOf('STREAMS') + 1]);
    const out = this.entries.filter((e) => cmp(e.id, group.lastDelivered) > 0).slice(0, count);
    if (out.length === 0) return null;
    for (const e of out) group.pel.set(e.id, { consumer, deliveries: 1, deliveredAt: this.clock });
    group.lastDelivered = out[out.length - 1].id;
    return [[key, out.map((e) => [e.id, [...e.fields]])]];
  }

  async xack(_key: string, groupName: string, ...ids: string[]) {
    this.guard('xack');
    const g = this.groups.get(groupName);
    let n = 0;
    for (const id of ids) if (g?.pel.delete(id)) n++;
    return n;
  }

  async xdel(_key: string, ...ids: string[]) {
    this.guard('xdel');
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !ids.includes(e.id));
    return before - this.entries.length;
  }

  async xautoclaim(_key: string, groupName: string, consumer: string, minIdle: number, start: string, _c: string, count: number) {
    this.guard('xautoclaim');
    const g = this.groups.get(groupName);
    if (!g) throw new Error('NOGROUP');
    const claimed: [string, Fields][] = [];
    const deleted: string[] = [];
    const ids = [...g.pel.keys()].filter((id) => cmp(id, start) >= 0).sort(cmp);
    for (const id of ids) {
      if (claimed.length + deleted.length >= count) break;
      const p = g.pel.get(id)!;
      if (this.clock - p.deliveredAt < minIdle) continue;
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) {
        g.pel.delete(id);
        deleted.push(id);
        continue;
      }
      p.consumer = consumer;
      p.deliveries += 1;
      p.deliveredAt = this.clock;
      claimed.push([id, [...entry.fields]]);
    }
    return ['0-0', claimed, deleted];
  }

  async xpending(_key: string, groupName: string, start?: string, end?: string, count?: number) {
    this.guard('xpending');
    const g = this.groups.get(groupName);
    if (!g) throw new Error('NOGROUP');
    const ids = [...g.pel.keys()].sort(cmp);
    if (start === undefined) {
      return [ids.length, ids[0] ?? null, ids.at(-1) ?? null, null];
    }
    return ids
      .filter((id) => cmp(id, start) >= 0 && cmp(id, end!) <= 0)
      .slice(0, count)
      .map((id) => {
        const p = g.pel.get(id)!;
        return [id, p.consumer, this.clock - p.deliveredAt, p.deliveries];
      });
  }

  async xrange(_key: string, _s: string, _e: string, _c?: string, count?: number) {
    this.guard('xrange');
    return this.entries.slice(0, count ?? this.entries.length).map((e) => [e.id, [...e.fields]]);
  }

  // Used by the express-rate-limit Redis store if a test exercises it.
  async call(...args: string[]) { this.guard(`call:${args[0]}`); throw new Error('not supported by fake'); }
}
