import 'reflect-metadata';
import express from 'express';
import request from 'supertest';

const mockRepos: Record<string, any> = {};
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: (entity: any) => mockRepos[entity.name] }) }));
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, _res: any, next: any) => { req.user = { id: 'caller', role: req.get('x-role') || 'developer' }; next(); },
}));
const mockFetch = jest.fn();
jest.mock('../../../src/lib/topology-k8s', () => ({ fetchTopologySources: (...args: any[]) => mockFetch(...args) }));

import topology from '../../../src/routes/topology';

const own = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const ownEnv = '33333333-3333-4333-8333-333333333333';
const foreignEnv = '44444444-4444-4444-8444-444444444444';

function repo(rows: any[]): any {
  return { findOne: jest.fn(async ({ where }: any) => rows.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) || null) };
}

function app() {
  const a = express();
  a.use(topology);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRepos.ProjectMember = repo([{ projectId: own, userId: 'caller', role: 'viewer' }]);
  mockRepos.Project = repo([{ id: own, name: 'shop' }, { id: foreign, name: 'other' }]);
  mockRepos.Environment = repo([
    { id: ownEnv, projectId: own, name: 'staging', namespace: 'shop-staging-ns' },
    { id: foreignEnv, projectId: foreign, name: 'staging', namespace: 'other-staging-ns' },
  ]);
  mockFetch.mockImplementation(async (namespace: string, appName: string) => ({
    sources: {
      namespace,
      appName,
      app: null,
      appError: 'not found',
      pods: [{ metadata: { name: 'web-1' }, status: { phase: 'Running' } }],
    },
    warnings: ['certificates: 403: forbidden'],
  }));
});

describe('GET /projects/:projectId/environments/:envId/topology', () => {
  it('returns the graph for the environment namespace', async () => {
    const res = await request(app()).get(`/projects/${own}/environments/${ownEnv}/topology`);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith('shop-staging-ns', 'shop-staging-ns');
    expect(res.body).toMatchObject({
      namespace: 'shop-staging-ns',
      environmentId: ownEnv,
      environment: 'staging',
      argo: { found: false, error: 'not found' },
      counts: { Pod: 1 },
      warnings: ['certificates: 403: forbidden'],
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts an environment name', async () => {
    const res = await request(app()).get(`/projects/${own}/environments/staging/topology`);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith('shop-staging-ns', 'shop-staging-ns');
  });

  it('rejects non-members of the project', async () => {
    const res = await request(app()).get(`/projects/${foreign}/environments/${foreignEnv}/topology`);
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not resolve another project\'s environment', async () => {
    const res = await request(app()).get(`/projects/${own}/environments/${foreignEnv}/topology`).set('x-role', 'admin');
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps Kubernetes outages to 503', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('Kubernetes unavailable for namespace shop-staging-ns'), { status: 503 }));
    const res = await request(app()).get(`/projects/${own}/environments/${ownEnv}/topology`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Kubernetes unavailable/);
  });

  it('hides unexpected errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('internal detail'));
    const res = await request(app()).get(`/projects/${own}/environments/${ownEnv}/topology`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build topology' });
  });
});
