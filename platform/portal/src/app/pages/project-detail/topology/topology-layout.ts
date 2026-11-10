/**
 * Small layered ("dagre-style") graph layout for the topology view (#31).
 *
 * Left-to-right ranks: 1) break cycles with a DFS, 2) longest-path ranking,
 * 3) a few barycenter sweeps to reduce crossings, 4) evenly spaced coordinates.
 * Good enough for one namespace (tens to a few hundred nodes) and ~150 lines
 * instead of a graph-layout dependency.
 */

export interface LayoutInputNode { id: string; kind?: string }
export interface LayoutInputEdge { from: string; to: string }

export interface LayoutNode { id: string; x: number; y: number; rank: number; order: number }
export interface LayoutEdge { from: string; to: string; path: string }

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  rankGap: number;
  nodeGap: number;
  sweeps: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 210, nodeHeight: 58, rankGap: 70, nodeGap: 16, sweeps: 6 };

/** Tie-break order for nodes in the same rank (and for isolated nodes). */
const KIND_ORDER = ['Application', 'Ingress', 'Certificate', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod', 'PersistentVolumeClaim', 'ConfigMap', 'Secret'];
function kindRank(kind?: string): number {
  const i = KIND_ORDER.indexOf(kind || '');
  return i === -1 ? KIND_ORDER.length : i;
}

export function layoutGraph(inputNodes: LayoutInputNode[], inputEdges: LayoutInputEdge[], opts: Partial<LayoutOptions> = {}): LayoutResult {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const ids = [...inputNodes]
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id))
    .map((n) => n.id);
  const known = new Set(ids);
  const edges = inputEdges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  // 1) Acyclic orientation: DFS, reverse back edges.
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)!.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const dag: Array<[string, string]> = [];
  const visit = (start: string) => {
    // Iterative DFS (deep graphs must not overflow the stack).
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, i] = top;
      const succ = out.get(u)!;
      if (i >= succ.length) { state.set(u, 2); stack.pop(); continue; }
      top[1] = i + 1;
      const v = succ[i];
      const s = state.get(v) || 0;
      if (s === 1) dag.push([v, u]); // back edge → reverse
      else {
        dag.push([u, v]);
        if (s === 0) { state.set(v, 1); stack.push([v, 0]); }
      }
    }
  };
  for (const id of ids) if (!state.get(id)) visit(id);

  // 2) Longest-path ranking (Kahn order).
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const [u, v] of dag) {
    const k = `${u}\u0000${v}`;
    if (seen.has(k)) continue;
    seen.add(k);
    succs.get(u)!.push(v);
    preds.get(v)!.push(u);
    indeg.set(v, indeg.get(v)! + 1);
  }
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of succs.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  // Isolated nodes sit in the rank their kind usually occupies, not all at 0.
  for (const id of ids) {
    if (preds.get(id)!.length === 0 && succs.get(id)!.length === 0) {
      const kind = inputNodes.find((n) => n.id === id)?.kind;
      rank.set(id, kind === 'Application' ? 0 : kind === 'Pod' || kind === 'PersistentVolumeClaim' ? 3 : kind === 'ConfigMap' || kind === 'Secret' ? 4 : 1);
    }
  }

  // 3) Ordering within ranks: barycenter sweeps.
  const maxRank = Math.max(0, ...rank.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of ids) layers[rank.get(id)!].push(id);
  const pos = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  reindex();
  const bary = (id: string, neigh: Map<string, string[]>) => {
    const ns = neigh.get(id)!;
    if (!ns.length) return pos.get(id)!;
    return ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length;
  };
  for (let s = 0; s < o.sweeps; s++) {
    const down = s % 2 === 0;
    const order = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
    for (const r of order) {
      const neigh = down ? preds : succs;
      const keyed = layers[r].map((id) => ({ id, b: bary(id, neigh), p: pos.get(id)! }));
      keyed.sort((a, b) => a.b - b.b || a.p - b.p);
      layers[r] = keyed.map((k) => k.id);
      layers[r].forEach((id, i) => pos.set(id, i));
    }
  }

  // 4) Coordinates: columns per rank, each column vertically centred.
  const step = o.nodeHeight + o.nodeGap;
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const height = tallest * step - o.nodeGap;
  const nodes = new Map<string, LayoutNode>();
  layers.forEach((layer, r) => {
    const offset = (height - (layer.length * step - o.nodeGap)) / 2;
    layer.forEach((id, i) => {
      nodes.set(id, { id, rank: r, order: i, x: r * (o.nodeWidth + o.rankGap), y: offset + i * step });
    });
  });
  const width = layers.length * (o.nodeWidth + o.rankGap) - o.rankGap;

  const outEdges: LayoutEdge[] = edges.map((e) => {
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    const forward = a.x <= b.x;
    const x1 = forward ? a.x + o.nodeWidth : a.x;
    const y1 = a.y + o.nodeHeight / 2;
    const x2 = forward ? b.x : b.x + o.nodeWidth;
    const y2 = b.y + o.nodeHeight / 2;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
    return { from: e.from, to: e.to, path: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` };
  });

  return { nodes, edges: outEdges, width: Math.max(width, 0), height: Math.max(height, 0) };
}
