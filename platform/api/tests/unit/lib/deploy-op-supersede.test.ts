jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
jest.mock('../../../src/lib/k8s', () => ({}));
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class {}, CoreV1Api: class {}, AppsV1Api: class {}, CustomObjectsApi: class {}, BatchV1Api: class {} }));

import { FindOperator } from 'typeorm';
import { newerDeploymentWhere } from '../../../src/lib/deploy-op';

it('a resumed deployment is not superseded by itself', () => {
  const createdAt = new Date('2026-11-15T02:50:00.123Z');
  const where = newerDeploymentWhere({ id: 'd1', environmentId: 'e1', createdAt });
  expect(where.environmentId).toBe('e1');
  expect(where.createdAt).toBeInstanceOf(FindOperator);
  expect((where.createdAt as FindOperator<Date>).type).toBe('moreThan');
  // created_at has microsecond precision in PostgreSQL, so the row itself must be excluded by id.
  expect((where.id as unknown as FindOperator<string>).type).toBe('not');
  expect((where.id as unknown as FindOperator<string>).value).toBe('d1');
});
