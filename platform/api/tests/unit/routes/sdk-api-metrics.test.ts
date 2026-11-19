import express from 'express';
import request from 'supertest';

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(), AppsV1Api: jest.fn(), NetworkingV1Api: jest.fn(), CustomObjectsApi: jest.fn(),
}));
jest.mock('../../../src/config/database', () => ({ getDb: jest.fn(async () => ({})) }));
jest.mock('../../../src/config/mongoose', () => ({ connectMongo: jest.fn(async () => true) }));
jest.mock('../../../src/lib/project-resolve', () => ({
  resolveProjectRef: jest.fn(async () => ({ id: 'project-1' })),
  projectIdMongoFilter: jest.fn(async () => ({ projectId: 'project-1' })),
}));
jest.mock('../../../src/lib/project-access', () => ({ requireProjectAccess: jest.fn(async () => ({ ok: true })) }));
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (_req: any, _res: any, next: any) => next(),
  sdkTokenAuth: (_req: any, _res: any, next: any) => next(),
  allowBrowserSdkToken: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../../src/schemas/ApiMetric', () => ({ ApiMetricModel: { aggregate: jest.fn() } }));

import sdkRouter from '../../../src/routes/sdk';
import { ApiMetricModel } from '../../../src/schemas/ApiMetric';

// Evaluate the percentile expressions against a fixture without needing MongoDB.
function evaluate(expr: any, durations: number[]): any {
  if (expr === '$durations') return durations;
  if (typeof expr === 'number') return expr;
  if (expr.$size) return evaluate(expr.$size, durations).length;
  if (expr.$floor) return Math.floor(evaluate(expr.$floor, durations));
  if (expr.$multiply) return expr.$multiply.reduce((a: number, b: any) => a * evaluate(b, durations), 1);
  if (expr.$arrayElemAt) return evaluate(expr.$arrayElemAt[0], durations)[evaluate(expr.$arrayElemAt[1], durations)];
  throw new Error('Unexpected percentile expression');
}

it.each([
  [Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1), [51, 96, 100]],
  [[17], [17, 17, 17]],
])('sorts durations before selecting route percentiles', async (input, expected) => {
  (ApiMetricModel.aggregate as jest.Mock).mockImplementation(async (pipeline: any[]) => {
    const groupIndex = pipeline.findIndex((stage) => stage.$group);
    const sort = pipeline.slice(0, groupIndex).find((stage) => stage.$sort)?.$sort;
    expect(sort).toEqual({ durationMs: 1 });
    expect(pipeline[groupIndex].$group.durations).toEqual({ $push: '$durationMs' });
    expect(pipeline[groupIndex].$group.lastSeen).toEqual({ $max: '$timestamp' });
    const docs = input.map((durationMs, i) => ({ durationMs, timestamp: i }));
    for (const [key, order] of Object.entries(sort)) {
      docs.sort((a: any, b: any) => (a[key] - b[key]) * Number(order));
    }
    const durations = docs.map((doc) => doc.durationMs);
    const fields = pipeline.find((stage) => stage.$addFields).$addFields;
    return [{ p50: evaluate(fields.p50, durations), p95: evaluate(fields.p95, durations), p99: evaluate(fields.p99, durations) }];
  });
  const app = express();
  app.use(sdkRouter);
  const res = await request(app).get('/sdk/api-metrics?projectId=project-1');
  expect(res.status).toBe(200);
  expect(res.body.metrics).toEqual([{ p50: expected[0], p95: expected[1], p99: expected[2] }]);
});

it('answers 503 without internal host names when the telemetry store is unreachable', async () => {
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND mongodb-1.mongodb-headless.databases.svc.cluster.local'), { code: 'ENOTFOUND' });
  (ApiMetricModel.aggregate as jest.Mock).mockRejectedValueOnce(dns);
  const app = express();
  app.use(sdkRouter);
  const res = await request(app).get('/sdk/api-metrics?projectId=project-1');
  expect(res.status).toBe(503);
  expect(res.headers['retry-after']).toBe('5');
  expect(JSON.stringify(res.body)).not.toContain('mongodb-1');
});

it('keeps 400 for other errors', async () => {
  (ApiMetricModel.aggregate as jest.Mock).mockRejectedValueOnce(new Error('Invalid time value'));
  const app = express();
  app.use(sdkRouter);
  const res = await request(app).get('/sdk/api-metrics?projectId=project-1&from=x');
  expect(res.status).toBe(400);
});

describe('isStoreUnavailable', () => {
  const { isStoreUnavailable } = jest.requireActual('../../../src/routes/sdk');
  it.each([
    [{ code: 'ECONNREFUSED' }, true],
    [{ name: 'MongoServerSelectionError', message: 'x' }, true],
    [{ name: 'MongoNetworkError', message: 'x' }, true],
    [{ message: 'wrapped', cause: { code: 'EAI_AGAIN' } }, true],
    [{ message: 'Connection terminated due to connection timeout' }, true],
    [{ name: 'ValidationError', message: 'projectId required' }, false],
    [{ name: 'MongoServerError', message: 'E11000 duplicate key' }, false],
  ])('%j -> %s', (err, want) => {
    expect(isStoreUnavailable(err)).toBe(want);
  });
});
