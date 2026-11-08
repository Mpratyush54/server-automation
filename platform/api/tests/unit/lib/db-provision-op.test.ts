/**
 * Step-logged DB provisioning: success path, compensation when storing credentials fails,
 * per-environment locking.
 */
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({ getRepository: () => ({}) }),
}));

const identity = { dbName: 'plat_x_y', username: 'plat_x_y_user', password: 'pw-secret', host: 'pg', port: 5432 };
const resolvePostgresIdentity = jest.fn();
const applyPostgresRoleAndDatabase = jest.fn();
const dropPostgresRoleAndDatabase = jest.fn();
const persistPostgresCreds = jest.fn();
jest.mock('../../../src/lib/project-db-ensure', () => ({
  resolvePostgresIdentity: (...a: any[]) => resolvePostgresIdentity(...a),
  applyPostgresRoleAndDatabase: (...a: any[]) => applyPostgresRoleAndDatabase(...a),
  dropPostgresRoleAndDatabase: (...a: any[]) => dropPostgresRoleAndDatabase(...a),
  persistPostgresCreds: (...a: any[]) => persistPostgresCreds(...a),
}));

import { provisionProjectPostgres } from '../../../src/lib/db-provision-op';
import { getOperation, setOperationStore } from '../../../src/lib/operations';
import { MemoryOperationStore } from '../../../src/lib/operation-store';
import { acquireLock, projectLockKey, resetMemoryLocksForTests, LockBusyError } from '../../../src/lib/locks';
import { setCoordinationRedisForTests } from '../../../src/lib/coord-redis';

beforeEach(() => {
  setOperationStore(new MemoryOperationStore());
  setCoordinationRedisForTests(null);
  resetMemoryLocksForTests();
  resolvePostgresIdentity.mockReset().mockResolvedValue(identity);
  applyPostgresRoleAndDatabase.mockReset().mockResolvedValue({ createdRole: true, createdDatabase: true });
  dropPostgresRoleAndDatabase.mockReset().mockResolvedValue(undefined);
  persistPostgresCreds.mockReset().mockResolvedValue(undefined);
});

it('runs resolve → apply → store and returns the credentials once', async () => {
  const out = await provisionProjectPostgres({ projectId: 'p1', environment: 'development', actorUserId: 'u1' });
  expect(out.status).toBe('succeeded');
  expect(out.creds).toEqual(identity);
  expect(persistPostgresCreds).toHaveBeenCalledWith('p1', 'development', identity);
  const op = (await getOperation(out.operationId))!;
  expect(op.steps.map((s) => [s.name, s.status])).toEqual([
    ['resolve-identity', 'succeeded'],
    ['apply-role-and-database', 'succeeded'],
    ['store-credentials', 'succeeded'],
  ]);
  expect(op.result).toEqual({ environment: 'development', dbName: 'plat_x_y', username: 'plat_x_y_user' });
  expect(JSON.stringify(op)).not.toContain('pw-secret');
});

it('drops the role and database it created when storing credentials fails', async () => {
  persistPostgresCreds.mockRejectedValue(new Error('secret store unavailable'));
  const out = await provisionProjectPostgres({ projectId: 'p1', environment: 'staging' });
  expect(out.status).toBe('compensated');
  expect(out.creds).toBeUndefined();
  expect(out.error).toContain('secret store unavailable');
  expect(dropPostgresRoleAndDatabase).toHaveBeenCalledWith(identity, { createdRole: true, createdDatabase: true });
});

it('does not drop pre-existing objects on failure', async () => {
  applyPostgresRoleAndDatabase.mockResolvedValue({ createdRole: false, createdDatabase: false });
  persistPostgresCreds.mockRejectedValue(new Error('nope'));
  await provisionProjectPostgres({ projectId: 'p1', environment: 'production' });
  expect(dropPostgresRoleAndDatabase).toHaveBeenCalledWith(identity, { createdRole: false, createdDatabase: false });
});

it('refuses a concurrent provisioning of the same environment', async () => {
  const held = await acquireLock(projectLockKey('p1', 'db-provision', 'development'), { holder: 'op-other' });
  await expect(provisionProjectPostgres({ projectId: 'p1', environment: 'development' })).rejects.toBeInstanceOf(LockBusyError);
  // another environment is independent
  await expect(provisionProjectPostgres({ projectId: 'p1', environment: 'staging' })).resolves.toMatchObject({ status: 'succeeded' });
  await held!.release();
});
