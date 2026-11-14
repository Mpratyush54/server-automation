import { buildNodeResourceMetrics, parseResourceQuantity } from '../../../src/lib/node-metrics';

describe('parseResourceQuantity', () => {
  it('parses CPU cores and millicores', () => {
    expect(parseResourceQuantity('2')).toBe(2);
    expect(parseResourceQuantity('250m')).toBeCloseTo(0.25);
    expect(parseResourceQuantity('1000m')).toBeCloseTo(1);
  });

  it('parses memory bytes with binary suffixes', () => {
    expect(parseResourceQuantity('1024')).toBe(1024);
    expect(parseResourceQuantity('1Ki')).toBe(1024);
    expect(parseResourceQuantity('2Gi')).toBe(2 * 1024 ** 3);
  });
});

describe('buildNodeResourceMetrics', () => {
  it('merges metrics-server usage with allocatable capacity', () => {
    const nodes = buildNodeResourceMetrics(
      [
        { metadata: { name: 'node-a' }, status: { allocatable: { cpu: '4', memory: '8Gi' } } },
        { metadata: { name: 'node-b' }, status: { allocatable: { cpu: '2000m', memory: '4Gi' } } },
      ],
      [
        { metadata: { name: 'node-a' }, usage: { cpu: '500m', memory: '1Gi' } },
        { metadata: { name: 'node-b' }, usage: { cpu: '1', memory: '512Mi' } },
      ],
    );

    expect(nodes).toEqual([
      {
        name: 'node-a',
        cpuUsedCores: 0.5,
        cpuCapacityCores: 4,
        memoryUsedBytes: 1024 ** 3,
        memoryCapacityBytes: 8 * 1024 ** 3,
      },
      {
        name: 'node-b',
        cpuUsedCores: 1,
        cpuCapacityCores: 2,
        memoryUsedBytes: 512 * 1024 ** 2,
        memoryCapacityBytes: 4 * 1024 ** 3,
      },
    ]);
  });

  it('skips nodes without metrics usage instead of inventing zeros', () => {
    const nodes = buildNodeResourceMetrics(
      [
        { metadata: { name: 'ready' }, status: { allocatable: { cpu: '2', memory: '4Gi' } } },
        { metadata: { name: 'missing-metrics' }, status: { allocatable: { cpu: '2', memory: '4Gi' } } },
      ],
      [{ metadata: { name: 'ready' }, usage: { cpu: '100m', memory: '256Mi' } }],
    );

    expect(nodes.map((n) => n.name)).toEqual(['ready']);
  });
});
