import 'reflect-metadata';
import express from 'express';
import request from 'supertest';

const mockCheck = jest.fn();
const mockNodeMetrics = jest.fn();

jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../../src/config/mongoose', () => ({ connectMongo: jest.fn() }));
jest.mock('../../../src/lib/integrations', () => ({ resolveIntegrations: jest.fn() }));
jest.mock('../../../src/lib/gitlab', () => ({ triggerPipeline: jest.fn() }));
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, _res: any, next: any) => {
    req.user = { id: 'u1', role: req.get('x-role') || 'devops' };
    next();
  },
  expressRequireRole: () => (_req: any, _res: any, next: any) => next(),
  requireAgentScopeOrRole: () => (req: any, res: any, next: any) => {
    if ((req.get('x-role') || 'devops') === 'developer') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  },
  logAudit: jest.fn(),
}));
jest.mock('../../../src/lib/k8s', () => ({
  checkK8sConnection: (...args: any[]) => mockCheck(...args),
  getK8sNodeMetrics: (...args: any[]) => mockNodeMetrics(...args),
  getK8sNodes: jest.fn(),
  getK8sNamespaces: jest.fn(),
  getK8sPods: jest.fn(),
  getPodLogs: jest.fn(),
  deletePod: jest.fn(),
}));

import bootstrap from '../../../src/routes/bootstrap';

function app() {
  const a = express();
  a.use(bootstrap);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheck.mockResolvedValue(true);
  mockNodeMetrics.mockResolvedValue({
    metricsAvailable: true,
    nodes: [
      {
        name: 'node-a',
        cpuUsedCores: 0.5,
        cpuCapacityCores: 4,
        memoryUsedBytes: 1024 ** 3,
        memoryCapacityBytes: 8 * 1024 ** 3,
      },
    ],
  });
});

describe('GET /bootstrap/node-metrics', () => {
  it('returns live node metrics when the cluster and metrics-server are available', async () => {
    const res = await request(app()).get('/bootstrap/node-metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      k8sConnected: true,
      metricsAvailable: true,
      nodes: [
        {
          name: 'node-a',
          cpuUsedCores: 0.5,
          cpuCapacityCores: 4,
          memoryUsedBytes: 1024 ** 3,
          memoryCapacityBytes: 8 * 1024 ** 3,
        },
      ],
    });
    expect(mockNodeMetrics).toHaveBeenCalled();
  });

  it('returns empty nodes when Kubernetes is disconnected', async () => {
    mockCheck.mockResolvedValue(false);
    const res = await request(app()).get('/bootstrap/node-metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ k8sConnected: false, metricsAvailable: false, nodes: [] });
    expect(mockNodeMetrics).not.toHaveBeenCalled();
  });

  it('returns metricsAvailable false when metrics-server is unavailable', async () => {
    mockNodeMetrics.mockResolvedValue({ metricsAvailable: false, nodes: [] });
    const res = await request(app()).get('/bootstrap/node-metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ k8sConnected: true, metricsAvailable: false, nodes: [] });
  });

  it('rejects developers without cluster scopes', async () => {
    const res = await request(app()).get('/bootstrap/node-metrics').set('x-role', 'developer');
    expect(res.status).toBe(403);
  });
});
