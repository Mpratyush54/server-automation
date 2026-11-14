export interface NodeResourceMetrics {
  name: string;
  cpuUsedCores: number;
  cpuCapacityCores: number;
  memoryUsedBytes: number;
  memoryCapacityBytes: number;
}

/** Parse a Kubernetes resource quantity into a JS number (cores or bytes). */
export function parseResourceQuantity(quantity: string): number {
  if (!quantity) return 0;
  const m = /^([0-9]+(?:\.[0-9]+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(String(quantity).trim());
  if (!m) throw new Error(`Unknown quantity ${quantity}`);
  const n = Number(m[1]);
  switch (m[2] || '') {
    case '': return n;
    case 'n': return n / 1e9;
    case 'u': return n / 1e6;
    case 'm': return n / 1e3;
    case 'k': return n * 1e3;
    case 'M': return n * 1e6;
    case 'G': return n * 1e9;
    case 'T': return n * 1e12;
    case 'P': return n * 1e15;
    case 'E': return n * 1e18;
    case 'Ki': return n * 1024;
    case 'Mi': return n * 1024 ** 2;
    case 'Gi': return n * 1024 ** 3;
    case 'Ti': return n * 1024 ** 4;
    case 'Pi': return n * 1024 ** 5;
    case 'Ei': return n * 1024 ** 6;
    default: throw new Error(`Unknown quantity ${quantity}`);
  }
}

/** Merge node allocatable capacity with metrics.k8s.io usage. Skips nodes missing either side. */
export function buildNodeResourceMetrics(
  nodes: Array<{ metadata?: { name?: string }; status?: { allocatable?: { cpu?: string; memory?: string } } }>,
  metricsItems: Array<{ metadata?: { name?: string }; usage?: { cpu?: string; memory?: string } }>,
): NodeResourceMetrics[] {
  const usageByName = new Map<string, { cpu: string; memory: string }>();
  for (const item of metricsItems) {
    const name = item.metadata?.name;
    if (name && item.usage?.cpu != null && item.usage?.memory != null) {
      usageByName.set(name, { cpu: String(item.usage.cpu), memory: String(item.usage.memory) });
    }
  }

  const out: NodeResourceMetrics[] = [];
  for (const node of nodes) {
    const name = node.metadata?.name;
    if (!name) continue;
    const usage = usageByName.get(name);
    const cpuCap = node.status?.allocatable?.cpu;
    const memCap = node.status?.allocatable?.memory;
    if (!usage || cpuCap == null || memCap == null) continue;
    out.push({
      name,
      cpuUsedCores: parseResourceQuantity(usage.cpu),
      cpuCapacityCores: parseResourceQuantity(String(cpuCap)),
      memoryUsedBytes: parseResourceQuantity(usage.memory),
      memoryCapacityBytes: parseResourceQuantity(String(memCap)),
    });
  }
  return out;
}
