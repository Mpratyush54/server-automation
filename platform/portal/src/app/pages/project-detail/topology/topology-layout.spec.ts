import { layoutGraph, DEFAULT_LAYOUT } from './topology-layout';

describe('layoutGraph', () => {
  const nodes = [
    { id: 'Application/app', kind: 'Application' },
    { id: 'Deployment/web', kind: 'Deployment' },
    { id: 'ReplicaSet/web-1', kind: 'ReplicaSet' },
    { id: 'Pod/web-1-a', kind: 'Pod' },
    { id: 'Pod/web-1-b', kind: 'Pod' },
    { id: 'Service/web', kind: 'Service' },
    { id: 'Ingress/web', kind: 'Ingress' },
    { id: 'ConfigMap/orphan', kind: 'ConfigMap' },
  ];
  const edges = [
    { from: 'Application/app', to: 'Deployment/web' },
    { from: 'Application/app', to: 'Service/web' },
    { from: 'Application/app', to: 'Ingress/web' },
    { from: 'Deployment/web', to: 'ReplicaSet/web-1' },
    { from: 'ReplicaSet/web-1', to: 'Pod/web-1-a' },
    { from: 'ReplicaSet/web-1', to: 'Pod/web-1-b' },
    { from: 'Service/web', to: 'Pod/web-1-a' },
    { from: 'Service/web', to: 'Pod/web-1-b' },
    { from: 'Ingress/web', to: 'Service/web' },
  ];

  it('ranks nodes left-to-right along edges (longest path)', () => {
    const l = layoutGraph(nodes, edges);
    const r = (id: string) => l.nodes.get(id)!.rank;
    expect(r('Application/app')).toBe(0);
    expect(r('Deployment/web')).toBe(1);
    expect(r('Ingress/web')).toBe(1);
    expect(r('Service/web')).toBe(2);
    expect(r('ReplicaSet/web-1')).toBe(2);
    expect(r('Pod/web-1-a')).toBe(3);
    for (const e of edges) expect(l.nodes.get(e.from)!.x).toBeLessThan(l.nodes.get(e.to)!.x);
    expect(l.edges.length).toBe(edges.length);
    expect(l.edges[0].path).toMatch(/^M[\d.]+,[\d.]+ C/);
  });

  it('never overlaps nodes in a column and reports the bounding box', () => {
    const l = layoutGraph(nodes, edges);
    const all = [...l.nodes.values()];
    expect(all.length).toBe(nodes.length);
    for (const a of all) {
      for (const b of all) {
        if (a !== b && a.x === b.x) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.nodeHeight);
      }
      expect(a.x + DEFAULT_LAYOUT.nodeWidth).toBeLessThanOrEqual(l.width + 0.001);
      expect(a.y + DEFAULT_LAYOUT.nodeHeight).toBeLessThanOrEqual(l.height + 0.001);
      expect(a.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives cycles, unknown edge endpoints and an empty graph', () => {
    const l = layoutGraph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'zzz' }, { from: 'a', to: 'a' }],
    );
    expect(l.nodes.size).toBe(3);
    expect(l.edges.length).toBe(3);
    const empty = layoutGraph([], []);
    expect(empty.nodes.size).toBe(0);
    expect(empty.edges).toEqual([]);
  });

  it('is deterministic', () => {
    const a = layoutGraph(nodes, edges);
    const b = layoutGraph([...nodes].reverse(), [...edges].reverse());
    for (const n of nodes) expect(b.nodes.get(n.id)!.rank).toBe(a.nodes.get(n.id)!.rank);
  });
});
